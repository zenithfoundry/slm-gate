import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Probe = { kind: 'slm-gate'; health: { ledger?: string }; stale: boolean } | { kind: 'nothing' } | { kind: 'other' };

const config = { LEDGER_PATH: '/repo/output/ledger.sqlite', MODEL_GATE_PORT: 8787 };
const probeGate = jest.fn(async (): Promise<Probe> => ({ kind: 'nothing' }));

jest.unstable_mockModule('../../src/config.js', () => ({ CONFIG: config }));
jest.unstable_mockModule('../../src/setup/model-gate.js', () => ({ probeGate }));

const { otherGateLedger, otherLedgerMessage } = await import('../../src/dashboard/gate-ledger.js');

const gateWriting = (ledger?: string): Probe => ({ kind: 'slm-gate', health: { ledger }, stale: false });

beforeEach(() => {
  probeGate.mockResolvedValue({ kind: 'nothing' });
});

describe('otherGateLedger', () => {
  it('names the gate’s ledger when the gate writes to another install’s ledger', async () => {
    probeGate.mockResolvedValue(gateWriting('/home/you/.slm-gate/output/ledger.sqlite'));
    expect(await otherGateLedger()).toBe('/home/you/.slm-gate/output/ledger.sqlite');
  });

  it('is null when the gate writes to the ledger the dashboard reads, however the path is spelled', async () => {
    probeGate.mockResolvedValue(gateWriting('/repo/output/../output/ledger.sqlite'));
    expect(await otherGateLedger()).toBeNull();
  });

  it('is null when no gate runs, something else holds the port, or the gate is too old to name its ledger', async () => {
    for (const probe of [{ kind: 'nothing' } as const, { kind: 'other' } as const, gateWriting(undefined)]) {
      probeGate.mockResolvedValue(probe);
      expect(await otherGateLedger()).toBeNull();
    }
  });
});

describe('otherLedgerMessage', () => {
  it('names both ledgers and the setting that points the dashboard at the gate’s one', () => {
    const message = otherLedgerMessage('/home/you/.slm-gate/output/ledger.sqlite');
    expect(message).toContain('/repo/output/ledger.sqlite');
    expect(message).toContain('LEDGER_PATH=/home/you/.slm-gate/output/ledger.sqlite');
    expect(message).toContain('launchd');
  });
});
