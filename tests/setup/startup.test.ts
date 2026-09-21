import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Probe = { kind: 'slm-gate'; health: object; stale: boolean } | { kind: 'nothing' } | { kind: 'other' };
type Problem = { message: string; fix: string; transient?: boolean };

const config = { LLM_GATE_AUTOSTART: true, MODEL_GATE_PORT: 8787, ROOT_DIR: '/slm-gate' };
const probeGate = jest.fn(async (): Promise<Probe> => ({ kind: 'nothing' }));
const isStoppedByUser = jest.fn(() => false);
const launchModelGate = jest.fn(() => ({ launched: true }));
const waitForModelGate = jest.fn(async (): Promise<object | null> => ({ service: 'slm-gate' }));
const checkLocalModels = jest.fn(async (_params?: object): Promise<{ problems: Problem[]; pulled: string[] }> => ({ problems: [], pulled: [] }));
const notifyUser = jest.fn();

jest.unstable_mockModule('../../src/config.js', () => ({ CONFIG: config }));
jest.unstable_mockModule('../../src/setup/model-gate.js', () => ({
  GATE_LOG_FILE: '/slm-gate/output/llm-gate.log',
  cliCommand: (action: string) => `node /slm-gate/dist/cli.js ${action}`,
  probeGate, isStoppedByUser, launchModelGate, waitForModelGate,
}));
jest.unstable_mockModule('../../src/setup/local-models.js', () => ({ checkLocalModels }));
jest.unstable_mockModule('../../src/setup/notify.js', () => ({ notifyUser }));

const { runStartupChecks, watchModelGate } = await import('../../src/setup/startup.js');

const missingModel = { message: 'The local model SLM_GATE_MODEL=m (sorting) is not downloaded.', fix: 'ollama pull m' };
/** What a probe that merely ran out of time looks like: possibly nothing wrong at all. */
const noAnswer = { message: 'Ollama did not answer at http://localhost:11434.', fix: 'Usually nothing.', transient: true };

beforeEach(() => {
  jest.clearAllMocks();
  config.LLM_GATE_AUTOSTART = true;
  probeGate.mockResolvedValue({ kind: 'nothing' });
  launchModelGate.mockReturnValue({ launched: true });
  isStoppedByUser.mockReturnValue(false);
  waitForModelGate.mockResolvedValue({ service: 'slm-gate' });
  checkLocalModels.mockResolvedValue({ problems: [], pulled: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('runStartupChecks (when a coding tool starts the MCP server)', () => {
  it('launches the model gate when nothing is running, and says nothing when all is well', async () => {
    expect(await runStartupChecks()).toEqual([]);
    expect(launchModelGate).toHaveBeenCalledTimes(1);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('does not launch the gate after `slm-gate stop`', async () => {
    isStoppedByUser.mockReturnValue(true);
    expect(await runStartupChecks()).toEqual([]);
    expect(launchModelGate).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('does not touch the gate when LLM_GATE_AUTOSTART is off', async () => {
    config.LLM_GATE_AUTOSTART = false;
    await runStartupChecks();
    expect(probeGate).not.toHaveBeenCalled();
    expect(launchModelGate).not.toHaveBeenCalled();
  });

  it('warns once, with how to change the port, when another program holds the port', async () => {
    probeGate.mockResolvedValue({ kind: 'other' });
    const notices = await runStartupChecks();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ key: 'port-taken' });
    expect(notices[0].fix).toContain('LLM_GATE_PORT');
    expect(notices[0].fix).toContain('/slm-gate/.env');
    expect(notices[0].fix).toContain('node /slm-gate/dist/cli.js restart');
    expect(launchModelGate).not.toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({ key: 'port-taken' }));
  });

  it('asks for a restart when the running gate is an older build', async () => {
    probeGate.mockResolvedValue({ kind: 'slm-gate', health: {}, stale: true });
    const notices = await runStartupChecks();
    expect(notices.map(notice => notice.key)).toEqual(['gate-stale']);
    expect(notices[0].fix).toContain('node /slm-gate/dist/cli.js restart');
  });

  it('checks the running gate\'s models too, since the gate reads slm-gate\'s .env and not this MCP env block', async () => {
    const models = [{ name: 'qwen2.5:7b', setting: 'SLM_BRAIN_MODEL', purpose: 'answers' }];
    probeGate.mockResolvedValue({ kind: 'slm-gate', health: { models }, stale: false });
    await runStartupChecks();
    expect(checkLocalModels).toHaveBeenCalledWith(expect.objectContaining({ gateModels: models }));
  });

  it('reports a missing local model with the exact command to fetch it', async () => {
    checkLocalModels.mockResolvedValue({ problems: [missingModel], pulled: [] });
    const notices = await runStartupChecks();
    expect(notices).toEqual([{ key: 'models:ollama pull m', ...missingModel }]);
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({ key: 'models:ollama pull m' }));
  });

  it('says nothing about a check that only ran out of time, since the session cannot take it back', async () => {
    checkLocalModels.mockResolvedValue({ problems: [noAnswer], pulled: [] });
    expect(await runStartupChecks()).toEqual([]);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('still reports a real problem found alongside one that only ran out of time', async () => {
    checkLocalModels.mockResolvedValue({ problems: [noAnswer, missingModel], pulled: [] });
    const notices = await runStartupChecks();
    expect(notices.map(notice => notice.key)).toEqual(['models:ollama pull m']);
  });

  it('never holds the coding tool for more than about 1.5 s', async () => {
    checkLocalModels.mockImplementation(() => new Promise(() => {}));
    probeGate.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    expect(await runStartupChecks()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('watchModelGate (every minute while the MCP server runs)', () => {
  /** Runs the watch until `until` has been called, then stops it. */
  async function watchUntil(until: { mock: { calls: unknown[] } }): Promise<void> {
    const stop = watchModelGate({ firstMs: 1, everyMs: 20 });
    const deadline = Date.now() + 2000;
    while (until.mock.calls.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    stop();
    await new Promise(resolve => setTimeout(resolve, 50)); // let a check already under way finish before the next test
  }

  /** Waits until the watch has run `count` checks, rather than for a number of milliseconds. */
  async function afterChecks(count: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (checkLocalModels.mock.calls.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20)); // let the last check finish reporting
  }

  it('checks the models of a gate it just brought back', async () => {
    const models = [{ name: 'qwen2.5:7b', setting: 'SLM_BRAIN_MODEL', purpose: 'answers' }];
    waitForModelGate.mockResolvedValue({ service: 'slm-gate', models });
    await watchUntil(checkLocalModels);
    expect(launchModelGate).toHaveBeenCalled();
    expect(checkLocalModels).toHaveBeenCalledWith({ gateModels: models });
  });

  it('brings a stopped gate back, and warns when it does not come up', async () => {
    waitForModelGate.mockResolvedValue(null);
    await watchUntil(notifyUser);
    expect(launchModelGate).toHaveBeenCalled();
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({ key: 'gate-not-running' }));
  });

  it('does not warn when another session launched the gate this minute and it is not up yet', async () => {
    launchModelGate.mockReturnValue({ launched: false });
    waitForModelGate.mockResolvedValue(null);
    await watchUntil(checkLocalModels);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('leaves the gate alone after `slm-gate stop`', async () => {
    isStoppedByUser.mockReturnValue(true);
    await watchUntil(checkLocalModels);
    expect(launchModelGate).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('stays quiet the first time it sees a problem that may just be a busy moment', async () => {
    probeGate.mockResolvedValue({ kind: 'slm-gate', health: {}, stale: false });
    checkLocalModels.mockResolvedValue({ problems: [noAnswer], pulled: [] });
    const stop = watchModelGate({ firstMs: 1, everyMs: 10_000 }); // only one check can run
    await afterChecks(1);
    stop();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('reports it once the next check finds it still there', async () => {
    probeGate.mockResolvedValue({ kind: 'slm-gate', health: {}, stale: false });
    checkLocalModels.mockResolvedValue({ problems: [noAnswer], pulled: [] });
    const stop = watchModelGate({ firstMs: 1, everyMs: 20 });
    await afterChecks(2);
    stop();
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(noAnswer.message) }));
  });

  it('never mentions a busy moment that has passed by the next check', async () => {
    probeGate.mockResolvedValue({ kind: 'slm-gate', health: {}, stale: false });
    checkLocalModels
      .mockResolvedValueOnce({ problems: [noAnswer], pulled: [] })
      .mockResolvedValue({ problems: [], pulled: [] });
    const stop = watchModelGate({ firstMs: 1, everyMs: 20 });
    await afterChecks(3);
    stop();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('notices a model that went missing after start-up', async () => {
    probeGate.mockResolvedValue({ kind: 'slm-gate', health: {}, stale: false });
    checkLocalModels.mockResolvedValue({ problems: [missingModel], pulled: [] });
    await watchUntil(notifyUser);
    expect(notifyUser).toHaveBeenCalledWith(expect.objectContaining({ key: 'models:ollama pull m' }));
  });
});
