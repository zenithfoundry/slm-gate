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
import { CONFIG } from '../config.js';
import { conditionPrompt } from './pipeline.js';

export async function createServer() {
  const server = new Server(
    {
      name: "small-language-model-gate",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  let rootUri: string | undefined;
  let downstreamClient: Client | undefined;

  // We intercept initialize via transport.onmessage below to capture rootUri without breaking SDK logic.
  
  if (CONFIG.DOWNSTREAM_MCP) {
    // Proxy mode
    downstreamClient = new Client(
      { name: "mcp-gate-proxy", version: "1.0.0" },
      { capabilities: {} }
    );
    
    let transport;
    if (CONFIG.DOWNSTREAM_MCP.command) {
      transport = new StdioClientTransport({
        command: CONFIG.DOWNSTREAM_MCP.command,
        args: CONFIG.DOWNSTREAM_MCP.args || [],
        env: { ...process.env, ...(CONFIG.DOWNSTREAM_MCP.env || {}) }
      });
    } else if (CONFIG.DOWNSTREAM_MCP.url) {
      transport = new StreamableHTTPClientTransport(new URL(CONFIG.DOWNSTREAM_MCP.url));
    }

    if (transport) {
      await downstreamClient.connect(transport);
    }

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      let tools: any[] = [];
      if (downstreamClient) {
        const res = await downstreamClient.request({ method: "tools/list" }, ListToolsResultSchema);
        tools = res.tools || [];
      }
      
      // Advertise expand_elision
      tools.push({
        name: "expand_elision",
        description: "Expand a previously elided block of text using its elisionId",
        inputSchema: {
          type: "object",
          properties: {
            elisionId: { type: "string" },
            range: { 
              type: "object", 
              properties: {
                startLine: { type: "number" },
                endLine: { type: "number" }
              }
            }
          },
          required: ["elisionId"]
        }
      });
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments;
      const task = typeof args?.task === 'string' ? args.task : 'Unknown task';

      if (name === "expand_elision") {
        const elisionId = args?.elisionId as string;
        const range = args?.range as any;
        
        if (!elisionId) throw new Error("elisionId is required");
        
        // Dynamic imports to prevent circular dependencies at boot
        const { getElision, writeElision, writeDistillFeedback, writeEvent } = await import('../ledger/index.js');
        const { estimateTokens, formatElisionMarker, computeElisionId } = await import('../utils/elision.js');
        const { embedText, float64ArrayToBuffer } = await import('../utils/embedding.js');
        const crypto = await import('node:crypto');
        const record = getElision(elisionId);
        
        if (record) {
          // Fire-and-forget: Embed the text the user explicitly wanted expanded.
          // This populates the Adaptive Feedback DB, teaching the engine to preserve 
          // semantically similar lines in future compressions.
          embedText(record.original_text).then(emb => {
            if (emb) {
              writeDistillFeedback({
                id: `fd_${Date.now()}_${Math.random().toString(36).substring(2,7)}`,
                tool_name: record.tool_name,
                skill: '',
                content_hash: record.content_hash,
                region_text: record.original_text,
                embedding_blob: float64ArrayToBuffer(emb),
                signal: 1
              });
            }
          });
          
          // Log the manual expansion for analytics/billing
          writeEvent({
            ts: new Date().toISOString(),
            layer: 'mcp',
            request_id: `fb_${crypto.randomUUID()}`,
            // Its own route: this is a user feedback signal, not a conditioning event.
            // As 'condition' it polluted route counts and collected a free accuracy score.
            route: 'feedback',
            is_local_call: 0,
            api_model: args?.model ? String(args.model) : undefined,
            agent: args?.agent ? String(args.agent) : undefined,
            api_in_tok: 0,
            api_out_tok: 0,
            in_tok: 0,
            out_tok: 0,
            cost_usd: 0,
            slm_latency_s: 0,
            api_latency_s: 0,
            slm_gate: 'on',
            meta: JSON.stringify({ type: 'distill_feedback', elision_id: elisionId, action: 'expand' })
          } as any);

          // If it's a file read, we should theoretically re-read if hash changed, but we can't easily read here without downstreamClient calling the exact same tool.
          // Let's check if downstreamClient is available to re-run
          let textToReturn = record.original_text;
          
          if (downstreamClient && ['read_file', 'view_file'].some(t => record.tool_name.includes(t))) {
             try {
                const result = await downstreamClient.request({
                  method: "tools/call",
                  params: { name: record.tool_name, arguments: JSON.parse(record.args) }
                }, CallToolResultSchema);
                
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
          let startLine = 0;
          let endLine = lines.length - 1;

          if (range && typeof range.startLine === 'number' && typeof range.endLine === 'number') {
             startLine = Math.max(0, range.startLine);
             endLine = Math.min(lines.length - 1, range.endLine);
          } else {
             // Try to extract first elided region if possible, else return all
             const parsedRanges = JSON.parse(record.ranges || '{}');
             if (parsedRanges.startLine !== undefined) {
               startLine = parsedRanges.startLine;
               endLine = parsedRanges.endLine;
             }
          }
          
          let expandedText = lines.slice(startLine, endLine + 1).join('\n');
          const maxTokens = CONFIG.DISTILL_MAX_TOKENS || 2000;
          
          if (estimateTokens(expandedText) > maxTokens) {
            const keepHead = Math.floor((maxTokens * 3.5) / 100);
            const expLines = expandedText.split('\n');
            const headLines = expLines.slice(0, keepHead);
            const tailLines = expLines.slice(-keepHead);
            const elidedCount = expLines.length - (keepHead * 2);
            
            const newId = computeElisionId(record.tool_name, JSON.parse(record.args), textToReturn); // Keep original text to allow further expansion
            writeElision({
              id: newId,
              tool_name: record.tool_name,
              args: record.args,
              original_text: textToReturn,
              ranges: JSON.stringify({startLine: 0, endLine: lines.length - 1}),
              content_hash: crypto.createHash('sha256').update(textToReturn).digest('hex'),
              size_bytes: Buffer.byteLength(textToReturn)
            });
            
            expandedText = headLines.join('\n') + 
                           formatElisionMarker(newId, elidedCount, startLine + keepHead, endLine - keepHead) + 
                           tailLines.join('\n');
          }

          return { content: [{ type: "text", text: expandedText }] };
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
      }, CallToolResultSchema);
      
      // Extract text from result content
      let toolText = '';
      if (result.content && Array.isArray(result.content)) {
        const textBlock = result.content.find((c: any) => c.type === 'text');
        if (textBlock && typeof (textBlock as any).text === 'string') {
          toolText = (textBlock as any).text;
        }
      }
      if (!toolText) {
        toolText = JSON.stringify(result.content);
      }
      
      // Intercept and distill ALL tool calls
      const conditioned = await conditionPrompt(toolText, task, rootUri, name, args);
      
      return {
        content: [{ type: "text", text: conditioned }]
      };
    });

  } else {
    // Standalone mode
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "condition_prompt",
            description: "Condense and condition a prompt using a local SLM",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
                task: { type: "string" }
              },
              required: ["text", "task"]
            }
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "condition_prompt") {
        const text = String(request.params.arguments?.text || '');
        const task = String(request.params.arguments?.task || '');
        const conditioned = await conditionPrompt(text, task, rootUri);
        return {
          content: [{ type: "text", text: conditioned }]
        };
      }
      throw new Error(`Tool not found: ${request.params.name}`);
    });
  }

  const start = async () => {
    const sinks = ['sqlite'];
    if (CONFIG.LANGFUSE_PUBLIC_KEY && CONFIG.LANGFUSE_SECRET_KEY && CONFIG.LANGFUSE_HOST) {
      sinks.push('langfuse');
    }
    const sinksStr = `sinks: [${sinks.join(', ')}]`;

    if (CONFIG.MCP_GATE_TRANSPORT === 'stdio') {
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = process.stderr.write.bind(process.stderr) as any;
      
      console.error(`[mcp-gate] Stdio server starting. ${sinksStr}`);
      
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
              console.error(`[mcp-gate] rootUri: ${rootUri || 'none'}`);
            }
            origOnmessage(message);
          };
        }
        await origStart();
      };
      
      await server.connect(transport);
      
      process.stdout.write = originalStdoutWrite;
    } else {
      const http = await import('node:http');
      const { randomUUID } = await import('node:crypto');
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
      });
      await server.connect(transport);
      
      const httpServer = http.createServer((req, res) => {
        transport.handleRequest(req, res);
      });
      
      httpServer.listen(CONFIG.MCP_GATE_PORT, () => {
        console.error(`[mcp-gate] HTTP Streamable server running on port ${CONFIG.MCP_GATE_PORT}. ${sinksStr}`);
      });
    }
  };

  return { server, start };
}
