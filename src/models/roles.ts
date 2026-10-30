/**
 * The two local model roles, read live from CONFIG: `brain` (reasoning, the resolver) and `gate`
 * (distillation).
 */
import { CONFIG } from '../config.js';

export const roles = {
  get brain() {
    return CONFIG.SLM_BRAIN_MODEL;
  },
  get gate() {
    return CONFIG.SLM_GATE_MODEL;
  }
};
