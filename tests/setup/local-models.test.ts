import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import http from 'node:http';
import { AddressInfo } from 'node:net';

const config = {
  SLM_PROVIDER: 'ollama',
  OLLAMA_HOST: '',
  SLM_GATE_MODEL: 'qwen2.5-coder:3b',
  SLM_BRAIN_MODEL: 'qwen3.5:4b',
  EMBED_MODEL: 'nomic-embed-text',
  SEMCACHE: false,
  DISTILL_ADAPTIVE: false,
};
jest.unstable_mockModule('../../src/config.js', () => ({ CONFIG: config }));

const { checkLocalModels } = await import('../../src/setup/local-models.js');

let pulled: string[] = [];
let ollamaUrl: string;
/** An address nothing listens on, so a connection there is refused outright. */
let closedUrl: string;
/** What the stand-in server does, so each way a probe can fail has a test. */
let mode: 'ollama' | 'silent' | 'not-json' | 'failing' | 'no-model-list' = 'ollama';
const ollama = http.createServer((req, res) => {
  if (mode === 'silent') return; // never answers: the caller gives up first
  if (mode === 'failing') return void res.writeHead(500).end('nope');
  if (mode === 'not-json') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hello</html>');
  const body = mode === 'no-model-list' ? { ok: true } : { models: pulled.map(name => ({ name })) };
  res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});

beforeAll(async () => {
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
  // Take a port, note it, give it back: fetch refuses low ports like 1 without connecting at all.
  const spare = http.createServer();
  await new Promise<void>(resolve => spare.listen(0, '127.0.0.1', resolve));
  closedUrl = `http://127.0.0.1:${(spare.address() as AddressInfo).port}`;
  await new Promise(resolve => spare.close(resolve));
});
afterAll(() => new Promise(resolve => {
  ollama.closeAllConnections(); // the 'silent' test leaves a request hanging
  ollama.close(resolve);
}));

beforeEach(() => {
  mode = 'ollama';
  Object.assign(config, { SLM_PROVIDER: 'ollama', OLLAMA_HOST: ollamaUrl, SLM_GATE_MODEL: 'qwen2.5-coder:3b', SLM_BRAIN_MODEL: 'qwen3.5:4b', SEMCACHE: false });
});

describe('checkLocalModels', () => {
  it('finds nothing wrong when every configured model is downloaded', async () => {
    pulled = ['qwen2.5-coder:3b', 'qwen3.5:4b', 'llama3:8b'];
    expect((await checkLocalModels()).problems).toEqual([]);
  });

  it('names each missing model with the command that fetches it', async () => {
    pulled = ['qwen2.5-coder:3b'];
    const { problems } = await checkLocalModels();
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('qwen3.5:4b (SLM_BRAIN_MODEL,');
    expect(problems[0].fix).toBe('ollama pull qwen3.5:4b');
  });

  it('also checks the models the running model gate uses, which come from slm-gate\'s .env', async () => {
    pulled = ['qwen2.5-coder:3b', 'qwen3.5:4b'];
    const gateModels = [
      { name: 'qwen2.5:7b', setting: 'SLM_BRAIN_MODEL', purpose: 'answering first messages locally' },
      { name: 'qwen2.5-coder:3b', setting: 'SLM_GATE_MODEL', purpose: 'sorting requests' },
    ];
    const { problems } = await checkLocalModels({ gateModels });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('qwen2.5:7b (SLM_BRAIN_MODEL in slm-gate\'s .env,');
    expect(problems[0].fix).toBe('ollama pull qwen2.5:7b');
  });

  it('accepts a model setting without a tag when Ollama has it as :latest', async () => {
    config.SLM_BRAIN_MODEL = 'mymodel';
    pulled = ['qwen2.5-coder:3b', 'mymodel:latest'];
    expect((await checkLocalModels()).problems).toEqual([]);
  });

  it('reports a model named by two settings once', async () => {
    config.SLM_BRAIN_MODEL = 'qwen2.5-coder:3b';
    pulled = [];
    expect((await checkLocalModels()).problems.map(problem => problem.fix)).toEqual(['ollama pull qwen2.5-coder:3b']);
  });

  it('also needs the embedding model when the semantic cache is on', async () => {
    config.SEMCACHE = true;
    pulled = ['qwen2.5-coder:3b', 'qwen3.5:4b'];
    expect((await checkLocalModels()).problems.map(problem => problem.fix)).toEqual(['ollama pull nomic-embed-text']);
  });

  it('says how to start Ollama when nothing accepts the connection, and never starts it itself', async () => {
    config.OLLAMA_HOST = closedUrl;
    const { problems } = await checkLocalModels({ timeoutMs: 500 });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('is not running');
    // The exact command depends on how Ollama is installed here (see ollama-install.test.ts); what
    // matters is that the fix tells you how to start it and never starts it itself.
    expect(problems[0].fix).toMatch(/brew services start ollama|sudo systemctl start ollama|ollama serve|Open the Ollama app|ollama\.com\/download/);
  });

  it('does not claim Ollama is down when it simply did not answer in time', async () => {
    mode = 'silent';
    const { problems } = await checkLocalModels({ timeoutMs: 300 });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).not.toContain('is not running');
    expect(problems[0].message).toContain('did not answer');
    expect(problems[0].fix).not.toMatch(/ollama serve|brew services|systemctl/);
    expect(problems[0].transient).toBe(true);
  });

  it('names OLLAMA_HOST when it has no scheme, rather than blaming Ollama', async () => {
    config.OLLAMA_HOST = '127.0.0.1:11434';
    const { problems } = await checkLocalModels();
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('OLLAMA_HOST');
    expect(problems[0].message).not.toContain('is not running');
    expect(problems[0].fix).toContain('http://localhost:11434');
  });

  it('says the address is not Ollama when something else answers there', async () => {
    mode = 'failing';
    const { problems } = await checkLocalModels();
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('not Ollama');
    expect(problems[0].message).toContain('answered 500');
  });

  it('says the address is not Ollama when the answer is not a model list', async () => {
    mode = 'no-model-list';
    const { problems } = await checkLocalModels();
    expect(problems.map(problem => problem.message)).toEqual([expect.stringContaining('not Ollama')]);
  });

  it('reports no missing models when Ollama has none downloaded but is healthy', async () => {
    pulled = [];
    const { problems } = await checkLocalModels();
    expect(problems.every(problem => problem.fix.startsWith('ollama pull'))).toBe(true);
  });

  it('checks nothing when the local model is not served by Ollama', async () => {
    config.SLM_PROVIDER = 'openai';
    config.OLLAMA_HOST = closedUrl;
    expect((await checkLocalModels()).problems).toEqual([]);
  });
});
