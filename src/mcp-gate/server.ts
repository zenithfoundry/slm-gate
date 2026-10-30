/**
 * The MCP gate server: sits between a coding tool and its toolbox, passes every tools/call downstream
 * unchanged and conditions the text that comes back (pipeline.ts). Owns the gate's own tools
 * (expand_elision, ask_elision, find_existing), the stdio/HTTP transports and the workspace root capture.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  CallToolResultSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CONFIG } from '../config.js';
import { log } from '../log.js';
import { asRequest } from '../models/busy.js';
import { isLocalRequest, listenOnThisComputer } from '../utils/local-only.js';
import { conditionPrompt } from './pipeline.js';
import { buildGateInstructions, rewriteToolReferences } from './tool-names.js';

// The gate's own tools' arguments: one definition each, advertised as the tool's JSON schema and parsed at
// the edge, so a bad call gets an MCP error result instead of failing somewhere inside. Passthrough: callers
// may add fields the ledger reads (model, agent).
const EXPAND_ELISION_ARGS = z.object({
  elisionId: z.string().min(1),
  range: z.object({ startLine: z.number(), endLine: z.number() }).optional(),
}).passthrough();
const ASK_ELISION_ARGS = z.object({ elisionId: z.string().min(1), question: z.string().trim().min(1) }).passthrough();
const FIND_EXISTING_ARGS = z.object({ query: z.string().trim().min(1) }).passthrough();
const CONDITION_PROMPT_ARGS = z.object({ text: z.string(), task: z.string() }).passthrough();

/** The JSON schema a tool advertises, from its zod definition. */
function inputSchemaOf(schema: z.ZodObject<z.ZodRawShape, 'passthrough'>): { type: 'object'; properties?: Record<string, unknown>; required?: string[] } {
  const { $schema: _draft, ...json } = zodToJsonSchema(schema, { $refStrategy: 'none' });
  return json as { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

/** The MCP error result for arguments that do not fit a tool's schema. */
function invalidArguments(tool: string, error: z.ZodError) {
  const detail = error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
  return { isError: true as const, content: [{ type: 'text' as const, text: `${tool}: invalid arguments (${detail})` }] };
}

// ask_elision: each part of the original must fit the local context with room for the answer;
// at most this many parts are searched per question; an answer is a few sentences, never a page.
const ASK_CHUNK_TOKENS = 5000;
const ASK_MAX_CHUNKS = 4;
const ASK_MAX_ANSWER_CHARS = 1200;
// When this MCP session started: a conversation memory can only belong to it if that conversation began
// at or after this moment (conversation memory, the MCP gate's match rule).
const MCP_SESSION_STARTED_AT = new Date().toISOString();
// Every downstream request: the SDK's default 60 s timeout failed any toolbox tool that runs longer, and only
// when called through the gate. A tool that reports progress keeps its timer alive.
const DOWNSTREAM_REQUEST_OPTIONS = { timeout: CONFIG.SLM_TIMEOUT_MS, resetTimeoutOnProgress: true };

/**
 * @param options.notices Set-up problems from the start-up checks, passed to the AI in the instructions
 */
export async function createServer(options: { notices?: readonly { message: string; fix: string }[]; rootUri?: string } = {}) {
  // The workspace root normally arrives in the client's initialize message (intercepted below); tests and
  // embedders may pass it directly.
  let rootUri: string | undefined = options.rootUri;
  let downstreamClient: Client | undefined;
  // Tools the connected toolbox serves. Learned at connect time and refreshed on every
  // tools/list, so any toolbox works without toolbox-specific configuration.
  let downstreamToolNames: string[] = [];
  // Standalone mode has no toolbox to describe, but still passes on set-up notices.
  let instructions = buildGateInstructions({ toolNames: [], notices: options.notices });

  // We intercept initialize via transport.onmessage below to capture rootUri without breaking SDK logic.

  if (CONFIG.DOWNSTREAM_MCP) {
    // Proxy mode. Connect to the toolbox BEFORE creating our server: the instructions we
    // hand the editor are fixed at construction and are built from what the toolbox reports.
    downstreamClient = new Client(
      { name: "mcp-gate-proxy", version: "1.0.0" },
      { capabilities: {} }
    );
    
    let transport;
    if ('command' in CONFIG.DOWNSTREAM_MCP) {
      transport = new StdioClientTransport({
        command: CONFIG.DOWNSTREAM_MCP.command,
        args: CONFIG.DOWNSTREAM_MCP.args || [],
        // process.env's values are typed `string | undefined`; what is set is a string.
        env: { ...process.env, ...(CONFIG.DOWNSTREAM_MCP.env || {}) } as Record<string, string>,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(CONFIG.DOWNSTREAM_MCP.url));
    }

    if (transport) {
      await downstreamClient.connect(transport);
      const { tools } = await downstreamClient.request({ method: "tools/list" }, ListToolsResultSchema, DOWNSTREAM_REQUEST_OPTIONS);
      downstreamToolNames = (tools || []).map(t => t.name);
      instructions = buildGateInstructions({
        toolNames: downstreamToolNames,
        downstreamInstructions: downstreamClient.getInstructions(),
        notices: options.notices,
      });
    }
  }

  const server = new Server(
    {
      name: "small-language-model-gate",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions,
    }
  );

  if (CONFIG.DOWNSTREAM_MCP) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      let tools: any[] = [];
      if (downstreamClient) {
        const res = await downstreamClient.request({ method: "tools/list" }, ListToolsResultSchema, DOWNSTREAM_REQUEST_OPTIONS);
        tools = res.tools || [];
        downstreamToolNames = tools.map(t => t.name);
      }

      // Advertise expand_elision
      tools.push({
        name: "expand_elision",
        description: "Expand a previously elided block of text using its elisionId",
        inputSchema: inputSchemaOf(EXPAND_ELISION_ARGS),
      });
      // Advertise find_existing (the repository index, REPO_INDEX=on): symbols the repository already defines, no model.
      if (CONFIG.REPO_INDEX) {
        tools.push({
          name: "find_existing",
          description: "Before writing something new: the functions, classes and types this repository already defines that match a few words (a symbol index, no model call). Returns path:line per hit.",
          inputSchema: inputSchemaOf(FIND_EXISTING_ARGS),
        });
      }
      // Advertise ask_elision: a local model answers from the stored original.
      tools.push({
        name: "ask_elision",
        description: "Ask a question about elided text; a local model answers from the full original in a few sentences instead of a 2,000-token page. If it is not found, use expand_elision.",
        inputSchema: inputSchemaOf(ASK_ELISION_ARGS),
      });
      return { tools };
    });

    // Every call is counted as in flight (src/models/busy.ts), so a shutdown lets it finish first.
    server.setRequestHandler(CallToolRequestSchema, request => asRequest(async () => {
      const name = request.params.name;
      const args = request.params.arguments;
      const task = typeof args?.task === 'string' ? args.task : 'Unknown task';

      if (name === "find_existing") {
        const parsedArgs = FIND_EXISTING_ARGS.safeParse(args ?? {});
        if (!parsedArgs.success) return invalidArguments('find_existing', parsedArgs.error);
        const { query } = parsedArgs.data;
        if (!CONFIG.REPO_INDEX) throw new Error("find_existing is off (set REPO_INDEX=on)");
        if (!rootUri) throw new Error("find_existing needs a workspace root; the editor sent none");
        const { fileURLToPath } = await import('node:url');
        const { findExisting, refreshRepoIndex } = await import('../index/repo-index.js');
        const root = rootUri.startsWith('file://') ? fileURLToPath(rootUri) : rootUri;
        refreshRepoIndex(root);
        const hits = findExisting({ root, query, limit: 10 });
        const text = hits.length === 0
          ? `No existing symbol matches "${query}".`
          : hits.map(h => `${h.path}:${h.line}  ${h.kind} ${h.name}  —  ${h.signature}`).join('\n');
        return { content: [{ type: "text", text }] };
      }

      if (name === "ask_elision") {
        const parsedArgs = ASK_ELISION_ARGS.safeParse(args ?? {});
        if (!parsedArgs.success) return invalidArguments('ask_elision', parsedArgs.error);
        const { elisionId, question } = parsedArgs.data;

        const { getElision, writeEvent, cacheGet, cacheSet, matchMemory } = await import('../ledger/index.js');
        const { estimateTokens, splitByHeadings } = await import('../utils/elision.js');
        const { answerFromText } = await import('../models/reasoning.js');
        const { parseSummary, renderSummary } = await import('../llm-gate/memory.js');
        const { SLM } = await import('../models/slm.js');
        const crypto = await import('node:crypto');
        const record = getElision(elisionId);
        if (!record) throw new Error(`Elision ${elisionId} not found in cache. Cannot answer without the original.`);

        const started = Date.now();
        const lineCount = record.original_text.split('\n').length;
        // What an expand_elision page would have cost the cloud model: the baseline this answer saves against.
        const pageTokens = Math.min(estimateTokens(record.original_text), CONFIG.DISTILL_MAX_TOKENS || 2000);
        // Conversation memory: the newest usable summary for this workspace, from a conversation that began
        // after this session did (the MCP gate has no conversation key; see matchMemory). The cache key
        // carries the memory's fold time, or `nomem`, so an answer made with memory is never served without
        // it, and a newer fold gives a fresh answer.
        const root = rootUri ? (rootUri.startsWith('file://') ? fileURLToPath(rootUri) : rootUri) : null;
        const memory = matchMemory({ root, startedAfter: MCP_SESSION_STARTED_AT });
        const memoryText = memory.row ? (() => { const parsed = parseSummary(memory.row.summary); return parsed ? renderSummary(parsed) : null; })() : null;
        const memoryPart = memory.row && memoryText ? `m${memory.row.folded_at}` : 'nomem';
        const cacheKey = `ask_${elisionId}_${crypto.createHash('sha256').update(question).digest('hex').slice(0, 16)}_${CONFIG.PROMPT_VERSION}_${memoryPart}`;
        let text = cacheGet(cacheKey);
        let meta: Record<string, unknown> = { type: 'ask_elision', elision_id: elisionId, cache_hit: 'exact', memory: { match: memoryText ? memory.match : 'none' } };
        if (text === null) {
          // Chunks fit the local context; the first ASK_MAX_CHUNKS are searched in order, stopping at a hit.
          const chunks = splitByHeadings(record.original_text, ASK_CHUNK_TOKENS).slice(0, ASK_MAX_CHUNKS);
          const slm = new SLM();
          let hit: { answer: string; lines: [number, number] | null; startLine: number } | null = null;
          let checked = 0;
          for (const chunk of chunks) {
            checked++;
            const res = await answerFromText({ slm, question, text: chunk.text, context: memoryText });
            if (res.found && res.answer.trim()) { hit = { answer: res.answer, lines: res.lines, startLine: chunk.startLine }; break; }
          }
          text = hit
            ? hit.answer.trim().slice(0, ASK_MAX_ANSWER_CHARS) + (hit.lines ? ` (original lines ${hit.startLine + hit.lines[0]}-${hit.startLine + hit.lines[1]})` : '')
            : `Not found in the elided text (${checked} of ${chunks.length} parts checked). Use expand_elision with this id and range {"startLine": 0, "endLine": ${lineCount - 1}} to read it.`;
          meta = { type: 'ask_elision', elision_id: elisionId, found: hit ? 1 : 0, chunks_checked: checked, chunks: chunks.length, memory: { match: memoryText ? memory.match : 'none' } };
          cacheSet(cacheKey, text);
        }

        // A conditioning row: the page the cloud model would have read is the baseline, the answer the output.
        writeEvent({
          ts: new Date().toISOString(),
          layer: 'mcp',
          request_id: `ask_${crypto.randomUUID()}`,
          route: 'condition',
          is_local_call: 1,
          slm_model: CONFIG.SLM_BRAIN_MODEL,
          api_model: args?.model ? String(args.model) : undefined,
          agent: args?.agent ? String(args.agent) : undefined,
          in_tok: pageTokens,
          out_tok: estimateTokens(text),
          api_in_tok: 0,
          api_out_tok: 0,
          cost_usd: 0,
          slm_latency_s: (Date.now() - started) / 1000,
          api_latency_s: 0,
          slm_gate: 'on',
          meta: JSON.stringify(meta)
        } as any);

        return { content: [{ type: "text", text: rewriteToolReferences(text, downstreamToolNames) }] };
      }

      if (name === "expand_elision") {
        const parsedArgs = EXPAND_ELISION_ARGS.safeParse(args ?? {});
        if (!parsedArgs.success) return invalidArguments('expand_elision', parsedArgs.error);
        const { elisionId, range } = parsedArgs.data;

        // Dynamic imports to prevent circular dependencies at boot
        const { getElision, writeElision, writeEvent } = await import('../ledger/index.js');
        const { estimateTokens, formatElisionMarker, pageLines } = await import('../utils/elision.js');
        const crypto = await import('node:crypto');
        const record = getElision(elisionId);

        if (record) {
          // An expansion used to embed the original text here (adaptive feedback), which asked Ollama for
          // EMBED_MODEL — a third model that evicts one of the pair slm-gate works with and
          // that this gate never requires. Removed: the adaptive feedback table keeps its readers and
          // gains no rows from expansions.

          // A file read is re-run through the toolbox so an edited file is expanded from its current text,
          // not the copy stored at distillation time; the stored copy is used when that fails.
          let textToReturn = record.original_text;

          if (downstreamClient && ['read_file', 'view_file'].some(t => record.tool_name.includes(t))) {
             try {
                const result = await downstreamClient.request({
                  method: "tools/call",
                  params: { name: record.tool_name, arguments: JSON.parse(record.args) }
                }, CallToolResultSchema, DOWNSTREAM_REQUEST_OPTIONS);
                
                let newerText = '';
                if (result.content && Array.isArray(result.content)) {
                  const textBlock = result.content.find((c: any) => c.type === 'text');
                  if (textBlock && typeof (textBlock as any).text === 'string') {
                    newerText = (textBlock as any).text;
                  }
                }
                const newHash = crypto.createHash('sha256').update(newerText).digest('hex');
                if (newHash !== record.content_hash) {
                   textToReturn = newerText;
                   // Update cache with new text
                   writeElision({ ...record, original_text: newerText, content_hash: newHash, size_bytes: Buffer.byteLength(newerText) });
                }
             } catch(e) {
                // ignore
             }
          }

          const lines = textToReturn.split('\n');
          const hasRange = range !== undefined;
          // No range means the whole original, from the top.
          const startLine = hasRange ? Math.max(0, range.startLine) : 0;
          const endLine = hasRange ? Math.min(lines.length - 1, range.endLine) : lines.length - 1;

          // The caller asked for these exact lines, so never cut out the middle of them again:
          // that made a large region impossible to retrieve. Return them in order, one
          // budget-sized page at a time, and say exactly which range to ask for next.
          const page = pageLines({ lines, startLine, endLine, maxTokens: CONFIG.DISTILL_MAX_TOKENS || 2000 });
          const expandedText = page.nextStart === undefined
            ? page.text
            : page.text + formatElisionMarker({ elisionId: elisionId, elidedLinesCount: endLine - page.nextStart + 1, startLine: page.nextStart, endLine: endLine });
          const returned = rewriteToolReferences(expandedText, downstreamToolNames);

          // The expansion row, written once the page is final: the cloud model re-reads `returned`
          // (marker and rewrites included), so its size is charged against the savings
          // (perEventTokensSaved). Its own route: a user feedback signal, not a conditioning event.
          writeEvent({
            ts: new Date().toISOString(),
            layer: 'mcp',
            request_id: `fb_${crypto.randomUUID()}`,
            route: 'feedback',
            is_local_call: 0,
            api_model: args?.model ? String(args.model) : undefined,
            agent: args?.agent ? String(args.agent) : undefined,
            api_in_tok: 0,
            api_out_tok: 0,
            in_tok: 0,
            out_tok: estimateTokens(returned),
            cost_usd: 0,
            slm_latency_s: 0,
            api_latency_s: 0,
            slm_gate: 'on',
            meta: JSON.stringify({
              type: 'distill_feedback', elision_id: elisionId, action: 'expand',
              page: { start: startLine, end: endLine, next: page.nextStart ?? null },
            })
          } as any);

          return { content: [{ type: "text", text: returned }] };
        } else {
          // Missing or expired, try to re-run if we have args
          if (!downstreamClient) throw new Error("Elision not found and no downstream client to re-run.");
          // We don't have tool_name/args if it's missing from cache and user only provided elisionId.
          throw new Error(`Elision ${elisionId} not found in cache. Cannot recover without original tool arguments.`);
        }
      }

      if (!downstreamClient) throw new Error("No downstream client");
      
      // Pass request unchanged downstream
      const result = await downstreamClient.request({
        method: "tools/call",
        params: request.params
      }, CallToolResultSchema, DOWNSTREAM_REQUEST_OPTIONS);
      
      // Only the text is conditioned, and once per call: conditionPrompt also grounds, resolves and records.
      // Everything else — pictures and other blocks, the error flag, structured data — goes back as the
      // toolbox sent it, so any toolbox works unchanged.
      type Block = (typeof result.content)[number];
      const textBlocks = result.content.filter((block): block is Extract<Block, { type: 'text' }> => block.type === 'text');
      if (textBlocks.length === 0) return result;

      const conditioned = await conditionPrompt({ text: textBlocks.map(block => block.text).join('\n\n'), task, rootUri, toolName: name, args });
      // The conditioned text takes the first text block's place; later text blocks are part of it.
      const content = result.content.flatMap((block): Block[] => {
        if (block === textBlocks[0]) return [{ ...block, text: rewriteToolReferences(conditioned, downstreamToolNames) }];
        return block.type === 'text' ? [] : [block];
      });
      return { ...result, content };
    }));

  } else {
    // Standalone mode
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "condition_prompt",
            description: "Condense and condition a prompt using a local SLM",
            inputSchema: inputSchemaOf(CONDITION_PROMPT_ARGS),
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, request => asRequest(async () => {
      if (request.params.name === "condition_prompt") {
        const parsedArgs = CONDITION_PROMPT_ARGS.safeParse(request.params.arguments ?? {});
        if (!parsedArgs.success) return invalidArguments('condition_prompt', parsedArgs.error);
        const { text, task } = parsedArgs.data;
        const conditioned = await conditionPrompt({ text, task, rootUri });
        return {
          content: [{ type: "text", text: conditioned }]
        };
      }
      throw new Error(`Tool not found: ${request.params.name}`);
    }));
  }

  /** Resolves once serving; in HTTP mode with the listening servers (tests close them), else with none. */
  const start = async (): Promise<HttpServer[]> => {
    const sinks = ['sqlite'];
    if (CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST) {
      sinks.push('langfuse');
    }
    const sinksStr = `sinks: [${sinks.join(', ')}]`;

    if (CONFIG.MCP_GATE_TRANSPORT === 'stdio') {
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = process.stderr.write.bind(process.stderr) as any;
      
      log.info('mcp-gate', `Stdio server starting. ${sinksStr}`);
      
      const transport = new StdioServerTransport();
      
      const origStart = transport.start.bind(transport);
      transport.start = async () => {
        const origOnmessage = transport.onmessage;
        if (origOnmessage) {
          transport.onmessage = (message: any) => {
            if (message?.method === 'initialize') {
              const rootsCap = message.params?.capabilities?.roots;
              // Check if roots is passed directly in capabilities (older clients)
              if (Array.isArray(rootsCap) && rootsCap.length > 0 && rootsCap[0]?.uri) {
                rootUri = rootsCap[0].uri;
              } else if (message.params?.rootUri) {
                // Fallback for non-compliant clients passing top-level rootUri
                rootUri = message.params.rootUri;
              }
              log.info('mcp-gate', 'workspace root received', { rootUri: rootUri || 'none' });
            }
            origOnmessage(message);
          };
        }
        await origStart();
      };
      
      await server.connect(transport);

      process.stdout.write = originalStdoutWrite;
      return [];
    } else {
      const { randomUUID } = await import('node:crypto');
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
      });
      await server.connect(transport);

      // This server's tools can read and patch files: only programs on this computer may call them.
      return listenOnThisComputer({
        handler: (req, res) => {
          if (!isLocalRequest(req.headers)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'slm-gate only accepts requests from programs on this computer' }, id: null }));
            return;
          }
          transport.handleRequest(req, res);
        },
        port: CONFIG.MCP_GATE_PORT,
        onListening: () => log.info('mcp-gate', `HTTP Streamable server running on port ${CONFIG.MCP_GATE_PORT}, for programs on this computer only. ${sinksStr}`),
      });
    }
  };

  return { server, start };
}
