import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A stand-in for Ollama's /api/chat, so Step A runs through the real ollama client, the real classifier
 * and verifier, and the real cancellation path. Classification calls (they send a JSON `format`) get
 * `state.category`; answer calls get `state.answer` after `state.delayMs`. Every call records whether the
 * client went away before the reply.
 */
export interface FakeOllama {
  url: string;
  /** `embedDelayMs` delays /api/embeddings (used by the semantic cache). */
  state: { category: string; answer: string; delayMs: number; status: number; embedDelayMs: number };
  calls: { kind: 'classify' | 'answer'; aborted: boolean }[];
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeOllama(): Promise<FakeOllama> {
  const defaults = { category: 'short_factual', answer: 'Hi! How can I help you today?', delayMs: 0, status: 200, embedDelayMs: 0 };
  const state = { ...defaults };
  const calls: FakeOllama['calls'] = [];

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
      const call = { kind: body.format ? 'classify' as const : 'answer' as const, aborted: false };
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
        const content = call.kind === 'classify' ? JSON.stringify({ category: state.category }) : state.answer;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content }, done: true }));
      };
      if (call.kind === 'answer' && state.delayMs > 0) setTimeout(reply, state.delayMs).unref();
      else reply();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    calls,
    reset: () => {
      Object.assign(state, defaults);
      calls.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
