/**
 * The local model client: every call the gate makes to Ollama (or an OpenAI-compatible host) goes through
 * here, so structured JSON output, think-mode, context size and the per-call timeout are decided once.
 */
import { Ollama } from 'ollama';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CONFIG } from '../config.js';
import { SlmFormatError } from './helpers.js';

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * The fetch the Ollama client is built with. The client sends no AbortSignal on a plain (non-streaming)
 * chat, so a generation the gate had already given up on (withSlmTimeout) kept the GPU busy until it
 * finished on its own. Every request is cut at SLM_TIMEOUT_MS; Ollama stops generating when the
 * connection closes. A signal the client passes itself (streaming) stays in force too.
 */
function fetchWithTimeout(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(CONFIG.SLM_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

export class SLM {
  private client: Ollama;
  constructor(client?: Ollama) {
    this.client = client || new Ollama({ host: CONFIG.OLLAMA_HOST, fetch: fetchWithTimeout });
  }

  /**
   * Generates a deterministic JSON payload from the Small Language Model.
   * This is used internally for agentic logic, routing decisions, and prompt conditioning.
   * 
   * It enforces a strict JSON schema and parses the response. If the model returns malformed JSON,
   * it will catch the error and retry the generation once with a temperature of 0 (fully deterministic);
   * a call already at temperature 0 is not retried, since the identical request gets the identical answer.
   * 
   * @WARNING Do not use markdown extraction, regex parsing, or `stop` tokens to force JSON generation.
   * Native Structured Outputs (`format: jsonSchema` or `response_format: { type: "json_schema" }`) MUST be used.
   * Relying on prompt engineering and markdown parsing for JSON has caused severe rambling and timeouts 
   * (especially on Apple Silicon / llama.cpp) where the model fails to emit a closing brace or stop token.
   * 
   * @param params.model The ID of the local model to execute (e.g., 'qwen3.5:2b')
   * @param params.prompt The instruction prompt for the model
   * @param params.schema A Zod schema defining the exact JSON structure expected back
   * @param params.temperature Generation temperature (randomness). Defaults to CONFIG.TEMPERATURE
   * @returns A validated, strongly-typed JSON object matching the provided schema
   */
  async generateJSON<T>(params: {
    model: string;
    prompt: string;
    schema: z.ZodSchema<T>;
    temperature?: number;
  }): Promise<T> {
    const { model, prompt, schema, temperature = CONFIG.TEMPERATURE } = params;
    const attempt = async (temp: number) => {
      // Convert the Zod schema to a standard JSON schema so the LLM understands the expected structure
      const jsonSchema = zodToJsonSchema(schema);
      let responseText = '';

      const promptWithSchema = `${prompt}\n\nRespond with valid JSON matching the schema.`;

      if (CONFIG.SLM_PROVIDER === 'ollama') {
        const response = await this.client.chat({
          model,
          messages: [{ role: 'user', content: promptWithSchema }],
          format: jsonSchema as any,
          keep_alive: CONFIG.OLLAMA_KEEP_ALIVE,
          // `think` is a REQUEST-level field, not an `options` entry. Ollama silently drops
          // unknown keys from `options`: a thinking model
          // (qwen3 / qwen3.5, the default brain for ram-24 and above) reasoned until it hit
          // num_predict, returned done_reason:length with EMPTY content, and the parse failed.
          // That produced `resolver_error: format` on essentially every standalone call, twice
          // per call because of the retry below. Keep this out of `options`.
          think: false,
          // Every key below is a real Ollama option, so a future typo fails the build
          // instead of being silently ignored the way `think` was.
          options: {
            temperature: temp,
            num_ctx: CONFIG.NUM_CTX,
            num_predict: 2000
          }
        });
        responseText = response.message.content;
      } else if (CONFIG.SLM_PROVIDER === 'openai') {
        const response = await fetch(`${CONFIG.OLLAMA_HOST}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(CONFIG.CLOUD_API_KEY && { 'Authorization': `Bearer ${CONFIG.CLOUD_API_KEY}` })
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: promptWithSchema }],
            temperature: temp,
            max_tokens: 2000,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "slm_output",
                strict: true,
                schema: jsonSchema
              }
            }
          }),
          signal: AbortSignal.timeout(CONFIG.SLM_TIMEOUT_MS)
        });
        
        if (!response.ok) {
          throw new Error(`OpenAI API error: ${response.statusText}`);
        }
        
        const data = await response.json();
        responseText = data.choices[0].message.content;
      } else {
        throw new Error(`Unsupported SLM_PROVIDER: ${CONFIG.SLM_PROVIDER}`);
      }

      let stripped = stripThinkTags(responseText).trim();
      
      try {
        const parsed = JSON.parse(stripped);
        return schema.parse(parsed);
      } catch (err) {
        throw new SlmFormatError(`Failed to parse or validate JSON: ${(err as Error).message}\nContent: ${stripped}`);
      }
    };

    try {
      return await attempt(temperature);
    } catch (err) {
      // Malformed JSON: retry once at zero temperature (maximum determinism). At temperature 0 already,
      // the retry would resend the identical request and get the identical answer, so it is skipped.
      if (err instanceof SlmFormatError && temperature !== 0) {
        return await attempt(0);
      }
      throw err;
    }
  }

  /**
   * Generates a raw, unstructured text completion from the SLM: prose the caller uses as text (a shortened
   * run, a summary), where a JSON schema would only cost tokens. Decisions and classifications use
   * `generateJSON`.
   *
   * @param params.model The ID of the model to execute
   * @param params.messages Array of history messages
   * @param params.temperature Generation temperature, default from CONFIG
   * @param params.maxTokens Optional ceiling on generated tokens. Left unset for conversational
   *   proxying (llm-gate), where truncating the user's answer would be wrong. Summarising
   *   callers (mcp-gate distill) MUST pass one: with temperature 0 and repetitive input a 3B
   *   model can loop until the context window fills, which at local speeds runs for minutes.
   * @returns Raw text completion
   */
  async generateText(params: {
    model: string;
    messages: { role: string, content: string }[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const { model, messages, temperature = CONFIG.TEMPERATURE, maxTokens } = params;
    if (CONFIG.SLM_PROVIDER === 'ollama') {
      const response = await this.client.chat({
        model,
        messages,
        keep_alive: CONFIG.OLLAMA_KEEP_ALIVE,
        // Request-level, never inside `options` — see generateJSON for what that cost us.
        think: false,
        options: {
          temperature,
          num_ctx: CONFIG.NUM_CTX,
          ...(maxTokens !== undefined && { num_predict: maxTokens })
        }
      });
      return stripThinkTags(response.message.content);
    } else if (CONFIG.SLM_PROVIDER === 'openai') {
      const response = await fetch(`${CONFIG.OLLAMA_HOST}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(CONFIG.CLOUD_API_KEY && { 'Authorization': `Bearer ${CONFIG.CLOUD_API_KEY}` })
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          ...(maxTokens !== undefined && { max_tokens: maxTokens })
        }),
        signal: AbortSignal.timeout(CONFIG.SLM_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
      }
      const data = await response.json();
      return stripThinkTags(data.choices[0].message.content);
    }
    throw new Error(`Unsupported SLM_PROVIDER: ${CONFIG.SLM_PROVIDER}`);
  }

  /**
   * Generates a streaming text completion from the SLM.
   * 
   * Note on Syntax (`async *streamText`):
   * An asterisk (*) used with a function defines a generator function, which is a 
   * special function that can pause its work and resume it later. You usually write 
   * it as `function* myFunc()` or as a short method inside an object like `*myFunc()`.
   * By returning an AsyncGenerator, it yields content chunks iteratively as they 
   * are produced by the local model.
   * 
   * @param params.model The ID of the model to execute
   * @param params.messages Array of history messages
   * @param params.temperature Generation temperature, default from CONFIG
   * @returns AsyncGenerator yielding string chunks
   */
  async *streamText(params: {
    model: string;
    messages: { role: string, content: string }[];
    temperature?: number;
  }): AsyncGenerator<string, void, unknown> {
    const { model, messages, temperature = CONFIG.TEMPERATURE } = params;
    if (CONFIG.SLM_PROVIDER === 'ollama') {
      const response = await this.client.chat({
        model,
        messages,
        stream: true,
        keep_alive: CONFIG.OLLAMA_KEEP_ALIVE,
        // Request-level, never inside `options` — see generateJSON for what that cost us.
        think: false,
        options: {
          temperature,
          num_ctx: CONFIG.NUM_CTX
        }
      });
      for await (const chunk of response) {
        yield chunk.message.content;
      }
    } else {
      // Fallback: just yield the whole text at once for non-streaming providers
      const text = await this.generateText({ model, messages, temperature });
      yield text;
    }
  }

  /**
   * Generates embeddings for the given text using the specified local model.
   */
  async embed(model: string, text: string): Promise<number[]> {
    if (CONFIG.SLM_PROVIDER === 'ollama') {
      const response = await this.client.embeddings({
        model,
        prompt: text,
        keep_alive: CONFIG.OLLAMA_KEEP_ALIVE,
      });
      return response.embedding;
    } else {
      // For openai-compatible embeddings endpoint
      const response = await fetch(`${CONFIG.OLLAMA_HOST}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(CONFIG.CLOUD_API_KEY && { 'Authorization': `Bearer ${CONFIG.CLOUD_API_KEY}` })
        },
        body: JSON.stringify({
          model,
          input: text
        }),
        signal: AbortSignal.timeout(CONFIG.SLM_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`OpenAI API error (embeddings): ${response.statusText}`);
      }
      const data = await response.json();
      return data.data[0].embedding;
    }
  }
}
