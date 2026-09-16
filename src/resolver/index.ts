import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { SLM } from '../models/slm.js';
import { selfConsistency } from '../models/reasoning.js';
import { getDb, writeEvent } from '../ledger/index.js';
import { CONFIG } from '../config.js';
import { withSlmTimeout } from '../models/helpers.js';
import {
  RiskLevel,
  SourceKind,
  OpenDecision,
  ResolvedItem,
  ResolverOutput,
  EnrichedAskUserItem,
  AutoAppliedItem
} from './types.js';

export type FsReadFn = (pattern: string) => Promise<string[]>;

export interface ResolveInput {
  skillText: string;
  task: string;
  repoRoot?: string;
}

// Helper to determine if we can afford a cloud call
function checkCloudBudget(): boolean {
  if (!CONFIG.RESOLVER_CLOUD_TIER || !CONFIG.CLOUD_API_KEY || !CONFIG.CLOUD_MODEL) {
    return false;
  }
  if (CONFIG.RESOLVER_CLOUD_BUDGET_USD <= 0) {
    return false; // budget is 0
  }
  const row = getDb().prepare('SELECT SUM(cost_usd) as total FROM events').get() as { total: number | null };
  const spent = row.total || 0;
  return spent < CONFIG.RESOLVER_CLOUD_BUDGET_USD;
}

// Bounded cloud API call
async function batchCloudResolve(
  unresolved: ResolvedItem[],
  skillText: string,
  task: string
): Promise<void> {
  if (unresolved.length === 0) return;

  const prompt = `You are an expert developer resolving ambiguities for a local agent.
Task: ${task}
Skill/Context: ${skillText}

For the following open decisions, provide the best answer. If uncertain, leave it null.
Decisions:
${unresolved.map(u => `- [${u.id}] ${u.question}`).join('\n')}

Respond in JSON matching this schema:
{
  "answers": [
    { "id": "decision_id", "answer": "best answer or null", "confidence": 0.0 to 1.0, "options": ["opt1", "opt2"] }
  ]
}`;

  const schema = z.object({
    answers: z.array(z.object({
      id: z.string(),
      answer: z.string().nullable(),
      confidence: z.number(),
      options: z.array(z.string()).optional()
    }))
  });

  const startTime = Date.now();
  let inTok = prompt.length / 4; // rough estimate
  let outTok = 0;
  let cost = 0;

  try {
    const url = CONFIG.CLOUD_BASE_URL || (CONFIG.CLOUD_API_STYLE === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions');
    
    // Using standard OpenAI compatible payload for routing purposes since it natively supports json_schema
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.CLOUD_API_KEY}`
      },
      body: JSON.stringify({
        model: CONFIG.CLOUD_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "resolver_output",
            strict: true,
            schema: zodToJsonSchema(schema)
          }
        },
        temperature: 0
      })
    });

    if (res.ok) {
      const data = await res.json();
      const content = data.choices[0].message.content;
      outTok = content.length / 4;
      
      try {
        const parsed = schema.parse(JSON.parse(content));
        for (const item of parsed.answers) {
          const target = unresolved.find(u => u.id === item.id);
          if (target && item.answer !== null) {
            target.answer = item.answer;
            target.confidence = item.confidence;
            target.source = 'api';
            if (item.options) target.options = item.options;
          }
        }
      } catch (err) {
        // failed to parse
      }
    }
  } catch (err) {
    // network or other error
  } finally {
    const { calculateCostUsd } = await import('../pricing/index.js');
    try {
      cost = calculateCostUsd(CONFIG.CLOUD_MODEL || 'unknown', inTok, outTok);
    } catch {
      cost = 0;
    }
    writeEvent({
      ts: new Date().toISOString(),
      layer: 'mcp',
      request_id: `resolver_cloud_${Date.now()}`,
      route: 'escalate',
      is_local_call: 0,
      api_model: CONFIG.CLOUD_MODEL || 'unknown',
      in_tok: 0,
      out_tok: 0,
      api_in_tok: Math.round(inTok),
      api_out_tok: Math.round(outTok),
      cost_usd: cost,
      slm_latency_s: 0,
      api_latency_s: (Date.now() - startTime) / 1000,
      slm_gate: 'on'
    });
  }
}

export async function extractAmbiguities(
  slm: SLM,
  skillText: string,
  task: string
): Promise<OpenDecision[]> {
  const schema = z.object({
    decisions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      kind: z.string()
    }))
  });

  const prompt = `Extract concrete open decisions or ambiguities from the following task and skill context.
Task: ${task}
Context: ${skillText}

Output a list of decisions that need to be made before work can begin. If none, return an empty array. Limit to AT MOST 3 critical decisions. Be very concise.`;

  const res = await withSlmTimeout(slm.generateJSON(CONFIG.SLM_BRAIN_MODEL, prompt, schema, 0), 'resolver', CONFIG.SLM_TIMEOUT_MS);
  return res.decisions;
}

export async function resolveEach(
  slm: SLM,
  fsRead: FsReadFn,
  decisions: OpenDecision[],
  repoRoot?: string
): Promise<ResolvedItem[]> {
  const results: ResolvedItem[] = [];

  for (const dec of decisions) {
    let resolved: ResolvedItem = {
      id: dec.id,
      question: dec.question,
      answer: null,
      confidence: 0,
      source: 'unresolved'
    };

    // (a) EVIDENCE
    if (repoRoot) {
      const patternSchema = z.object({ patterns: z.array(z.string()) });
      try {
        const patternPrompt = `What file paths or contents should we grep to answer this question: "${dec.question}"?
Return 1 or 2 simple patterns like "package.json" or "yarn.lock" or "docker-compose.yml".`;
        const patternRes = await withSlmTimeout(slm.generateJSON(CONFIG.SLM_BRAIN_MODEL, patternPrompt, patternSchema, 0), 'resolver', CONFIG.SLM_TIMEOUT_MS);
        
        let evidenceFound = '';
        for (const p of patternRes.patterns) {
          const contents = await fsRead(p);
          if (contents.length > 0) {
            // Single `\n`: the evidence block was previously joined with the literal characters
            // backslash-n, so the brain model saw one unbroken line of file contents.
            evidenceFound += contents.join('\n') + '\n';
            break;
          }
        }

        if (evidenceFound) {
          const ansSchema = z.object({ answer: z.string(), options: z.array(z.string()) });
          const ansPrompt = `Given this evidence from the repository:\n${evidenceFound.slice(0, 1000)}\nAnswer the question: ${dec.question}`;
          const ansRes = await withSlmTimeout(slm.generateJSON(CONFIG.SLM_BRAIN_MODEL, ansPrompt, ansSchema, 0), 'resolver', CONFIG.SLM_TIMEOUT_MS);
          
          resolved = {
            id: dec.id,
            question: dec.question,
            answer: ansRes.answer,
            confidence: 0.95,
            source: 'evidence',
            evidence: `Found evidence matching pattern.`,
            options: ansRes.options
          };
          results.push(resolved);
          continue;
        }
      } catch (err) {
        // ignore and fall through
      }
    }

    // (b) & (c) CONVENTION & SELF-CONSISTENCY
    const scSchema = z.object({
      answer: z.string(),
      options: z.array(z.string())
    });
    const scPrompt = `Based on standard software conventions, answer this open decision:
Question: ${dec.question}
Provide the most standard choice as 'answer' and 2-3 alternatives as 'options'.`;

    try {
      const scRes = await selfConsistency(
        slm,
        CONFIG.SLM_BRAIN_MODEL,
        scPrompt,
        scSchema,
        CONFIG.SELF_CONSISTENCY_K,
        CONFIG.SELF_CONSISTENCY_TEMP
      );
      
      resolved = {
        id: dec.id,
        question: dec.question,
        answer: scRes.answer,
        confidence: 0.6,
        source: 'convention',
        options: scRes.options
      };
      
      if (CONFIG.SELF_CONSISTENCY_K > 1) {
        resolved.source = 'self_consistency';
        resolved.confidence = 0.75;
      }
    } catch (err) {
      // ignore
    }

    results.push(resolved);
  }

  return results;
}

export async function gateDecisions(
  slm: SLM,
  items: ResolvedItem[]
): Promise<ResolverOutput> {
  const output: ResolverOutput = {
    autoApplied: [],
    askUser: []
  };

  const schema = z.object({
    risk: z.enum(['reversible', 'low', 'security', 'destructive'])
  });

  for (const item of items) {
    let risk: RiskLevel = 'low';
    try {
      const prompt = `Classify the risk of deciding this question automatically:
Question: ${item.question}
Answer: ${item.answer}

Categories:
- reversible: trivial formatting, naming conventions, minor tools
- low: standard library choices, standard config
- security: auth, tokens, crypto, permissions, network exposure
- destructive: dropping databases, deleting files, overwriting critical data`;

      const res = await withSlmTimeout(slm.generateJSON(CONFIG.SLM_GATE_MODEL, prompt, schema, 0), 'resolver', CONFIG.SLM_TIMEOUT_MS);
      risk = res.risk;
    } catch (err) {
      risk = 'security';
    }

    item.risk = risk;

    if (item.confidence >= 0.8 && (risk === 'reversible' || risk === 'low')) {
      output.autoApplied.push({
        id: item.id,
        question: item.question,
        answer: item.answer || 'Unknown',
        note: `Auto-resolved based on ${item.source}`
      });
    } else {
      output.askUser.push({
        id: item.id,
        question: item.question,
        recommendedAnswer: item.answer,
        confidence: item.confidence,
        options: item.options || [],
        evidence: item.evidence
      });
    }
  }

  return output;
}

export async function resolveAmbiguities(
  slm: SLM,
  fsRead: FsReadFn,
  input: ResolveInput
): Promise<ResolverOutput> {
  const decisions = await extractAmbiguities(slm, input.skillText, input.task);
  if (decisions.length === 0) {
    return { autoApplied: [], askUser: [] };
  }

  const resolved = await resolveEach(slm, fsRead, decisions, input.repoRoot);

  // Cloud API Tier
  const unresolved = resolved.filter(r => r.confidence < 0.8);
  if (unresolved.length > 0 && checkCloudBudget()) {
    await batchCloudResolve(unresolved, input.skillText, input.task);
  }

  return gateDecisions(slm, resolved);
}
