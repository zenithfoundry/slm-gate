/**
 * @fileoverview Programmatic setup utility to initialize Langfuse Score Configs,
 * Model Definitions, and Monitors via the Langfuse Management API.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { PRICING } from '../pricing/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Automatically creates Score Configs in Langfuse:
 * - 'verified' (Categorical: 1='Passed', 0='Escalated') -> replaces '0' and '1' in Langfuse UI with informative labels!
 * - 'cost_saved_usd' (Numeric)
 * - 'tokens_saved' (Numeric)
 * - 'quality_score' (Numeric)
 */
/**
 * Score names an earlier build wrote and this one no longer does. Their rows stay in Langfuse
 * until deleted; no card reads them. setup-dashboard removes widgets that still filter on them,
 * and ledger:verify labels them instead of reporting them as an unexplained surplus.
 */
export const RETIRED_SCORE_NAMES: readonly string[] = [
  'cycle_extended_per_window_claude',
  'cycle_extended_per_window_chatgpt',
  'cycle_extended_per_window_gemini',
];

/** The score configs the gate registers. Also the list langfuse:wipe archives, and nothing else. */
export const SCORE_CONFIGS = [
    {
      name: 'verified',
      dataType: 'CATEGORICAL',
      categories: [
        { label: 'Passed (Local SLM)', value: 'Passed (Local SLM)' },
        { label: 'Distilled (Forwarded)', value: 'Distilled (Forwarded)' },
        { label: 'Escalated (Cloud)', value: 'Escalated (Cloud)' }
      ],
      description: 'Routing outcome: resolved locally, distilled then forwarded, or escalated to cloud'
    },
    {
      name: 'cost_saved_cents',
      dataType: 'NUMERIC',
      description: 'Estimated cloud API dollars avoided (converted to Cents) by the local SLM'
    },
    {
      name: 'tokens_saved',
      dataType: 'NUMERIC',
      description: 'Number of cloud LLM tokens avoided via local SLM routing'
    },
    {
      name: 'accuracy_rate_pct',
      dataType: 'NUMERIC',
      maxValue: 100,
      minValue: 0,
      description: 'Accuracy of the SLM gate output against the expected cloud model standard (%)'
    },
    // Each provider is registered twice: the same quantity in minutes and in seconds.
    // A score row carries a number and no unit, and a dashboard widget cannot convert
    // between units, so a card that reads in seconds needs a score already in seconds.
    {
      name: 'cycle_extended_minutes_chatgpt',
      dataType: 'NUMERIC',
      description: 'Extra MINUTES of a 3h ChatGPT window freed by this single request (summed for the range total)'
    },
    {
      name: 'cycle_extended_seconds_chatgpt',
      dataType: 'NUMERIC',
      description: 'Extra SECONDS of a 3h ChatGPT window freed by this single request (averaged for the per-prompt figure)'
    },
    {
      name: 'cycle_extended_minutes_claude',
      dataType: 'NUMERIC',
      description: 'Extra MINUTES of a 5h Claude window freed by this single request (summed for the range total)'
    },
    {
      name: 'cycle_extended_seconds_claude',
      dataType: 'NUMERIC',
      description: 'Extra SECONDS of a 5h Claude window freed by this single request (averaged for the per-prompt figure)'
    },
    {
      name: 'cycle_extended_minutes_gemini',
      dataType: 'NUMERIC',
      description: 'Extra MINUTES of a 5h Gemini window freed by this single request (summed for the range total)'
    },
    {
      name: 'cycle_extended_seconds_gemini',
      dataType: 'NUMERIC',
      description: 'Extra SECONDS of a 5h Gemini window freed by this single request (averaged for the per-prompt figure)'
    }
  ];

export async function syncScoreConfigs(): Promise<void> {
  if (!CONFIG.LANGFUSE_PUBLIC_KEY || !CONFIG.LANGFUSE_SECRET_KEY || !CONFIG.LANGFUSE_HOST) {
    return;
  }

  const authHeader = 'Basic ' + Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64');
  const baseUrl = CONFIG.LANGFUSE_HOST.replace(/\/$/, '');

  console.log('Initializing Langfuse Score Configurations...');
  for (const config of SCORE_CONFIGS) {
    try {
      const res = await fetch(`${baseUrl}/api/public/score-configs`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        console.log(`  ✓ Score config registered: ${config.name}`);
      } else if (res.status === 409 || res.status === 400) {
        // Already exists or duplicate name
        console.log(`  • Score config already active: ${config.name}`);
      } else {
        console.warn(`  ! Score config ${config.name} response: ${res.statusText}`);
      }
    } catch (err: any) {
      console.warn(`  ! Could not sync score config ${config.name}: ${err.message}`);
    }
  }
}

/**
 * Automatically creates Model Definitions and Pricing in Langfuse
 */
export async function syncModelDefinitions(): Promise<void> {
  if (!CONFIG.LANGFUSE_PUBLIC_KEY || !CONFIG.LANGFUSE_SECRET_KEY || !CONFIG.LANGFUSE_HOST) {
    return;
  }

  const authHeader = 'Basic ' + Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64');
  const baseUrl = CONFIG.LANGFUSE_HOST.replace(/\/$/, '');

  console.log('Initializing Langfuse Model Definitions...');
  for (const [modelName, rates] of Object.entries(PRICING)) {
    try {
      const modelPayload = {
        modelName,
        matchPattern: `(?i)^${modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`,
        unit: 'TOKENS',
        inputPrice: rates.in / 1e6,
        outputPrice: rates.out / 1e6,
      };

      const res = await fetch(`${baseUrl}/api/public/models`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(modelPayload)
      });
      if (res.ok) {
        console.log(`  ✓ Model definition registered: ${modelName}`);
      } else if (res.status === 409 || res.status === 400) {
        console.log(`  • Model definition already active: ${modelName}`);
      }
    } catch (err: any) {
      console.warn(`  ! Could not sync model ${modelName}: ${err.message}`);
    }
  }
}

export async function initLangfuseConfigs(): Promise<void> {
  await syncScoreConfigs();
  await syncModelDefinitions();
}

// Direct execution
if (process.argv[1] && (process.argv[1].endsWith('sync-config.ts') || process.argv[1].endsWith('sync-config.js'))) {
  initLangfuseConfigs()
    .then(() => {
      console.log('Langfuse configurations successfully initialized.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to initialize Langfuse configs:', err);
      process.exit(1);
    });
}
