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
const ollama = http.createServer((req, res) => {
  res.writeHead(req.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ models: pulled.map(name => ({ name })) }));
});

beforeAll(async () => {
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});
afterAll(() => new Promise(resolve => ollama.close(resolve)));

beforeEach(() => {
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

  it('says how to start Ollama when it is not running, and never starts it itself', async () => {
    config.OLLAMA_HOST = 'http://127.0.0.1:1';
    const { problems } = await checkLocalModels({ timeoutMs: 500 });
    expect(problems).toHaveLength(1);
    expect(problems[0].fix).toContain('ollama serve');
  });

  it('checks nothing when the local model is not served by Ollama', async () => {
    config.SLM_PROVIDER = 'openai';
    config.OLLAMA_HOST = 'http://127.0.0.1:1';
    expect((await checkLocalModels()).problems).toEqual([]);
  });
});
