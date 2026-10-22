import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A stand-in for Ollama's /api/chat, so the gate's local steps (the memory fold, ask_elision, shrinking)
 * run through the real ollama client and the real cancellation path. Structured calls (they send a JSON
 * `format`) get `state.structured`; plain calls get `state.answer` after `state.delayMs`. Every call
 * records whether the client went away before the reply.
 */
export interface FakeOllama {
  url: string;
  /** `embedDelayMs` delays /api/embeddings (used by the semantic cache); `status` other than 200 makes every chat call fail. */
  state: { answer: string; delayMs: number; status: number; embedDelayMs: number; structured: string | null };
  calls: { kind: 'structured' | 'answer'; aborted: boolean }[];
  /** Every /api/chat request body, in order, so a test can see what the models were asked. */
  bodies: any[];
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeOllama(): Promise<FakeOllama> {
  // `structured` answers any structured (JSON-format) call, such as a memory fold or an ask_elision answer.
  const defaults = { answer: 'Hi! How can I help you today?', delayMs: 0, status: 200, embedDelayMs: 0, structured: null as string | null };
  const state = { ...defaults };
  const calls: FakeOllama['calls'] = [];
  const bodies: any[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/api/embeddings') {
        const embed = () => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"embedding":[0.1,0.2,0.3]}');
        };
        if (state.embedDelayMs > 0) setTimeout(embed, state.embedDelayMs).unref();
        else embed();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      bodies.push(body);
      const call = { kind: body.format ? 'structured' as const : 'answer' as const, aborted: false };
      calls.push(call);
      res.on('close', () => {
        if (!res.writableFinished) call.aborted = true;
      });
      const reply = () => {
        if (res.destroyed) return;
        if (state.status !== 200) {
          res.writeHead(state.status, { 'content-type': 'application/json' });
          res.end('{"error":"model unavailable"}');
          return;
        }
        const content = call.kind === 'structured' ? (state.structured ?? '{}') : state.answer;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done: true }));
      };
      if (state.delayMs > 0) setTimeout(reply, state.delayMs).unref();
      else reply();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    calls,
    bodies,
    reset: () => {
      Object.assign(state, defaults);
      calls.length = 0;
      bodies.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
