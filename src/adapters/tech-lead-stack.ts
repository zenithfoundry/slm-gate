/**
 * Adapter for the tech-lead-stack toolbox: the skill lines that must survive distillation verbatim, and
 * the shape of a ledger event for its analytics.
 */
import { LedgerEvent } from '../ledger/index.js';

export const tlsPreservePatterns: RegExp[] = [
  /cost: ~\d+ tokens/i,
  /^modes:/i,
  /^## MinimumCD/i,
  /^## Quality Verification/i,
  /^Phase \d/i
];

export function mapLedgerEventToTlsAnalytics(event: LedgerEvent) {
  return {
    eventId: event.request_id,
    timestamp: event.ts,
    sessionId: event.session_id,
    toolName: event.skill || 'unknown',
    routingMode: event.route,
    localModel: event.slm_model,
    cloudModel: event.api_model,
    tokens: {
      input: event.api_in_tok,
      output: event.api_out_tok,
      localInput: event.in_tok,
      localOutput: event.out_tok
    },
    latency: {
      local: event.slm_latency_s,
      cloud: event.api_latency_s
    },
    tags: [
      `slm_gate=${event.slm_gate}`
    ]
  };
}

export function buildTlsDownstreamConfig(tlsRepoPath: string) {
  return {
    command: 'node',
    args: [`${tlsRepoPath}/dist/mcp-server.mjs`],
    env: {}
  };
}
