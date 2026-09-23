/**
 * @fileoverview Utility script to setup a dedicated Custom Dashboard in Langfuse 
 * with tailored widgets to properly visualize SLM Gate categorical and numeric scores.
 */
import { CONFIG, requireKeys } from '../config.js';
import { setTimeout } from 'timers/promises';
import { RETIRED_SCORE_NAMES } from './sync-config.js';

// The cards do not filter on SLM_GATE_SOURCE_TAG. Each already filters on a score name only
// the gate writes, which keeps other writers out. A tag filter looked equivalent but was not:
// Langfuse's v2 query engine (the dashboard's) sees trace tags on scores only for data it
// received after about 2026-09-21, and re-sending older data does not add them — the cards
// matched 59 of 760 tokens_saved scores and read near zero (checked 2026-09-23).

// Langfuse keeps only the last LANGFUSE_RETENTION_DAYS of data, so a total can fall while
// the gate is busy. Said on the dashboard and on every card that sums, where it misleads most.
const DASHBOARD_DESCRIPTION = `Rolling ${CONFIG.LANGFUSE_RETENTION_DAYS}-day window (Langfuse data retention). ` +
  'Older days drop off as new ones arrive, so totals can fall even during heavy use. ' +
  `The permanent record is the local ledger at ${CONFIG.LEDGER_PATH}.`;
const RANGE_TOTAL_NOTE = `Total across the selected range only, within the rolling ${CONFIG.LANGFUSE_RETENTION_DAYS}-day window.`;

/**
 * Names cards used before they were renamed. Their placements must be removed too:
 * otherwise the old card keeps its grid slot, and the renamed card placed on the same
 * slot is silently dropped by Langfuse.
 */
const RETIRED_WIDGET_NAMES = [
  'Claude Cycle Extended (min)',
  'ChatGPT Cycle Extended (min)',
  'Gemini Cycle Extended (min)',
  // Retired because they read in decimal minutes: a typical prompt showed '0.18934',
  // which the reader had to multiply by 60 to understand. Replaced by a seconds card
  // (per prompt) and a minutes card (range total) per provider.
  'Claude Cycle: Estimated Minutes Saved',
  'ChatGPT Cycle: Estimated Minutes Saved',
  'Gemini Cycle: Estimated Minutes Saved',
];

/** A widget from an earlier build: retired by name, or counting a score name no longer written. */
function isStaleWidget(widget: { name: string; filters?: Array<{ column?: string; value?: unknown }> }): boolean {
  return RETIRED_WIDGET_NAMES.includes(widget.name)
    || (widget.filters ?? []).some(f => f.column === 'name' && typeof f.value === 'string' && RETIRED_SCORE_NAMES.includes(f.value));
}

async function apiFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  let attempt = 0;
  const maxRetries = 5;
  
  while (attempt <= maxRetries) {
    // Pace all mutating/read requests to ensure we stay under 30/min (~2000ms/req)
    await setTimeout(2100);
    
    const res = await fetch(url, init);
    if (res.status === 429) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Rate limit exceeded on ${label} after ${maxRetries} retries.`);
      }
      let retryAfter = 60;
      try {
        const body = await res.json();
        if (body.details && typeof body.details.retryAfterSeconds === 'number') {
          retryAfter = body.details.retryAfterSeconds;
        }
      } catch (e) {
        // body might not be JSON or might be empty
      }
      console.log(`⏳ Rate limited on ${label}; waiting ${retryAfter}s...`);
      await setTimeout((retryAfter + 1) * 1000);
      continue;
    }
    return res;
  }
  throw new Error(`Failed to fetch ${label}`);
}

async function setupDashboard(): Promise<void> {
  requireKeys(['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_HOST']);

  if (process.argv.includes('--wait')) {
    console.log('Sleeping for 60s to ensure Langfuse rate limits are reset...');
    await setTimeout(60000);
  }

  const baseUrl = CONFIG.LANGFUSE_HOST!.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${CONFIG.LANGFUSE_PUBLIC_KEY}:${CONFIG.LANGFUSE_SECRET_KEY}`).toString('base64')}`;
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  console.log('=== SLM Gate: Langfuse Dashboard Setup ===\n');
  console.log('If you just ran ledger:sync, wait ~60s — Langfuse limits 30 req/min.\n');
  console.log('IMPORTANT: setup-dashboard.ts dedupes widgets and the dashboard by name.');
  
  // Track failures
  let failures = 0;
  let placedCount = 0;

  // 1. Create/Retrieve Widgets
  console.log('\nFetching existing widgets...');
  let existingWidgets: any[] = [];
  try {
    const wRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboard-widgets`, { headers }, 'fetch widgets');
    if (wRes.ok) {
      const data = await wRes.json();
      existingWidgets = data.data || data;
    } else {
      console.warn(`⚠ Failed to fetch existing widgets: ${await wRes.text()}`);
      failures++;
    }
  } catch (err) {
    console.warn(`⚠ Error fetching existing widgets:`, err);
    failures++;
  }

  const widgets = [
    {
      name: 'Routing Decision',
      description: 'Whether the SLM resolved the prompt ($0) or escalated it',
      view: 'scores-categorical',
      chartType: 'PIE',
      metrics: [{ measure: 'count', agg: 'count' }],
      dimensions: [{ field: 'stringValue' }],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'verified' }],
    },
    {
      name: 'Tokens Saved',
      description: `Total cloud tokens saved by local SLM deferral. ${RANGE_TOTAL_NOTE}`,
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'sum' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'tokens_saved' }],
    },
    {
      name: 'Cost Saved (Cents)',
      description: `Estimated cloud API dollars avoided (in Cents). ${RANGE_TOTAL_NOTE}`,
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'sum' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cost_saved_cents' }],
    },
    {
      name: 'SLM Accuracy Rate (%)',
      description: 'Only measured for prompts that pass through the model gate. Shows 0 when the model gate is not in the request path — that means not measured, not 0% accurate. MCP tool calls never answer prompts, so they never score accuracy. Share of local-model answers the verifier accepted (0-100%); benchmark runs land under Env = bench.',
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'accuracy_rate_pct' }],
    },
    {
      name: 'Claude Cycle: Est. Seconds Saved (per prompt)',
      description: "Only measured when Claude traffic passes through the gate and CLAUDE_WINDOW_BUDGET is set; shows 0 otherwise, which means not measured. SECONDS of your 5-hour Claude window freed per prompt, averaged — bounded [0, 18000]. Read it as-is: 11.4 means eleven and a half seconds of window time given back by the average prompt. An estimate within a margin of error: providers do not publish their window limits, so CLAUDE_WINDOW_BUDGET is a measured best guess. Claude's limits scale with tokens sent, so shrunk tool results and prompts extend the cycle.",
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_seconds_claude' }],
    },
    {
      name: 'ChatGPT Cycle: Est. Seconds Saved (per prompt)',
      description: "Only measured when ChatGPT traffic passes through the gate and CHATGPT_WINDOW_BUDGET is set; shows 0 otherwise, which means not measured. SECONDS of your 3-hour ChatGPT window freed per prompt, averaged — bounded [0, 10800]. Read it as-is. An estimate within a margin of error: providers do not publish their window limits, so CHATGPT_WINDOW_BUDGET is a best guess. ChatGPT uses message-based metering, so only a prompt answered entirely locally frees anything; a distilled-but-forwarded prompt still costs a message and scores 0.",
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_seconds_chatgpt' }],
    },
    {
      name: 'Gemini Cycle: Est. Seconds Saved (per prompt)',
      description: "Only measured when Gemini traffic passes through the gate and GEMINI_WINDOW_BUDGET is set; shows 0 otherwise, which means not measured. SECONDS of your 5-hour Gemini window freed per prompt, averaged — bounded [0, 18000]. Read it as-is. An estimate within a margin of error: providers do not publish their window limits, so GEMINI_WINDOW_BUDGET is a best guess. Gemini's limits scale with tokens sent, so shrunk tool results and prompts extend the cycle.",
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_seconds_gemini' }],
    },
    {
      name: 'Claude Cycle: Est. Minutes Saved (total)',
      description: "Only measured when Claude traffic passes through the gate and CLAUDE_WINDOW_BUDGET is set; shows 0 otherwise, which means not measured. Total MINUTES of your 5-hour Claude window freed across every prompt in the selected date range. This is the companion to the per-prompt seconds card above it: same quantity, summed instead of averaged, so it grows as you use the gate. An estimate within a margin of error — CLAUDE_WINDOW_BUDGET is a measured best guess. " + RANGE_TOTAL_NOTE,
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'sum' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_minutes_claude' }],
    },
    {
      name: 'ChatGPT Cycle: Est. Minutes Saved (total)',
      description: "Only measured when ChatGPT traffic passes through the gate and CHATGPT_WINDOW_BUDGET is set; shows 0 otherwise, which means not measured. Total MINUTES of your 3-hour ChatGPT window freed across every prompt in the selected date range. The companion to the per-prompt seconds card above it: same quantity, summed instead of averaged. An estimate within a margin of error — CHATGPT_WINDOW_BUDGET is a best guess. " + RANGE_TOTAL_NOTE,
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'sum' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_minutes_chatgpt' }],
    },
    {
      name: 'Gemini Cycle: Est. Minutes Saved (total)',
      description: "Only measured when Gemini traffic passes through the gate and GEMINI_WINDOW_BUDGET is set; shows 0 otherwise, which means not measured. Total MINUTES of your 5-hour Gemini window freed across every prompt in the selected date range. The companion to the per-prompt seconds card above it: same quantity, summed instead of averaged. An estimate within a margin of error — GEMINI_WINDOW_BUDGET is a best guess. " + RANGE_TOTAL_NOTE,
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'sum' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_minutes_gemini' }],
    }
  ];

  console.log('\nCreating widgets...');
  const targetWidgets = [];
  
  for (const w of widgets) {
    const existing = existingWidgets.find(ew => ew.name === w.name);
    if (existing) {
      // Reused by name, so a changed description or filter would otherwise never reach
      // Langfuse. Patched in place: the widget keeps its id and its placement.
      // Compared field by field: Langfuse returns filter keys in its own order.
      const filterKey = (filters: any[]) => JSON.stringify(filters.map(f => [f.column, f.operator, f.type, f.value, f.key ?? null]));
      const upToDate = existing.description === w.description
        && filterKey(existing.filters ?? []) === filterKey(w.filters);
      if (upToDate) {
        console.log(`✓ Reusing existing widget: ${w.name}`);
        targetWidgets.push(existing);
        continue;
      }
      try {
        const res = await apiFetch(`${baseUrl}/api/public/unstable/dashboard-widgets/${existing.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ description: w.description, filters: w.filters }),
        }, `update widget '${w.name}'`);
        if (res.ok) {
          console.log(`✓ Updated existing widget: ${w.name}`);
        } else {
          console.warn(`⚠ Failed to update widget '${w.name}': ${await res.text()}`);
          failures++;
        }
      } catch (err) {
        console.warn(`⚠ Error updating widget '${w.name}':`, err);
        failures++;
      }
      targetWidgets.push(existing);
      continue;
    }

    try {
      const res = await apiFetch(`${baseUrl}/api/public/unstable/dashboard-widgets`, {
        method: 'POST',
        headers,
        body: JSON.stringify(w),
      }, `create widget '${w.name}'`);

      if (!res.ok) {
        console.warn(`⚠ Failed to create widget '${w.name}': ${await res.text()}`);
        failures++;
      } else {
        const data = await res.json();
        console.log(`✓ Created widget: ${w.name}`);
        targetWidgets.push(data);
      }
    } catch (err) {
      console.warn(`⚠ Error creating widget '${w.name}':`, err);
      failures++;
    }
  }

  // 2. Create Dashboard
  console.log('\nCreating/Fetching SLM Gate Dashboard...');
  let dashboard;
  try {
    const listRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboards`, { headers }, 'fetch dashboards');
    if (listRes.ok) {
      const listData = await listRes.json();
      const existing = (listData.data || listData).find((d: any) => d.name === 'SLM Gate Performance');
      if (existing) {
        dashboard = existing;
        console.log(`✓ Found existing dashboard: ${dashboard.name} (ID: ${dashboard.id})`);
        if (existing.description !== DASHBOARD_DESCRIPTION) {
          const patchRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboards/${existing.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ description: DASHBOARD_DESCRIPTION }),
          }, 'update dashboard description');
          if (patchRes.ok) {
            console.log('✓ Updated dashboard description');
          } else {
            console.warn(`⚠ Failed to update dashboard description: ${await patchRes.text()}`);
            failures++;
          }
        }
      }
    } else {
      console.warn(`⚠ Failed to list dashboards: ${await listRes.text()}`);
      failures++;
    }
  } catch (err) {
    console.warn(`⚠ Error fetching dashboards:`, err);
    failures++;
  }

  if (!dashboard && failures === 0) {
    try {
      const dashboardRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboards`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'SLM Gate Performance',
          description: DASHBOARD_DESCRIPTION,
        }),
      }, 'create dashboard');

      if (!dashboardRes.ok) {
        console.error(`Failed to create dashboard: ${await dashboardRes.text()}`);
        failures++;
      } else {
        dashboard = await dashboardRes.json();
        console.log(`✓ Created NEW dashboard: ${dashboard.name} (ID: ${dashboard.id})`);
      }
    } catch (err) {
      console.warn(`⚠ Error creating dashboard:`, err);
      failures++;
    }
  }

  // 3. Attach Widgets to Dashboard
  if (dashboard && targetWidgets.length === widgets.length) {
    console.log('\nChecking existing placements...');
    
    try {
      const dashRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboards/${dashboard.id}`, { headers }, 'fetch specific dashboard');
      if (dashRes.ok) {
        const dashData = await dashRes.json();
        const existingPlacements = dashData.definition?.widgets || [];
        
        // Remove placements whose widget name matches one we are about to place
        for (const placement of existingPlacements) {
          const placementWidget = existingWidgets.find(ew => ew.id === placement.widgetId) 
                               || targetWidgets.find(tw => tw.id === placement.widgetId);
                               
          if (placementWidget && (widgets.some(w => w.name === placementWidget.name) || isStaleWidget(placementWidget))) {
            console.log(`Removing existing placement for '${placementWidget.name}'...`);
            const delRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboards/${dashboard.id}/placements/${placement.id}`, {
              method: 'DELETE',
              headers,
            }, `delete placement for '${placementWidget.name}'`);
            
            if (!delRes.ok) {
              console.warn(`⚠ Failed to delete placement: ${await delRes.text()}`);
              failures++;
            }
          }
        }
      }

      // With their placements gone, stale widgets can be deleted. Langfuse answers 409 while
      // a widget is still placed on some other dashboard; that one is left and reported.
      for (const stale of existingWidgets.filter(isStaleWidget)) {
        const delRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboard-widgets/${stale.id}`, {
          method: 'DELETE',
          headers,
        }, `delete stale widget '${stale.name}'`);
        if (delRes.ok) {
          console.log(`✓ Deleted stale widget: ${stale.name}`);
        } else if (delRes.status === 409) {
          console.warn(`⚠ Kept stale widget '${stale.name}': it is still placed on another dashboard.`);
        } else {
          console.warn(`⚠ Failed to delete stale widget '${stale.name}': ${await delRes.text()}`);
          failures++;
        }
      }
    } catch (err) {
      console.warn(`⚠ Error removing existing placements:`, err);
      failures++;
    }

    console.log('\nPlacing widgets on dashboard...');
    
    // Explicit 12-column grid. Omitting x/y/width/height makes Langfuse auto-place each
    // widget, and colliding auto-placements overwrite each other server-side — the POST
    // still returns 200, so four of seven cards silently vanished from the definition.
    // Rows 6 and 9 are column-aligned by provider, so each provider's per-prompt seconds
    // card sits directly above its range-total minutes card.
    const layout = [
      { x: 0, y: 0, width: 6, height: 6 }, // Routing Decision (pie)
      { x: 6, y: 0, width: 3, height: 3 }, // Tokens Saved
      { x: 9, y: 0, width: 3, height: 3 }, // Cost Saved
      { x: 6, y: 3, width: 6, height: 3 }, // SLM Accuracy Rate
      { x: 0, y: 6, width: 4, height: 3 }, // Claude  — seconds per prompt
      { x: 4, y: 6, width: 4, height: 3 }, // ChatGPT — seconds per prompt
      { x: 8, y: 6, width: 4, height: 3 }, // Gemini  — seconds per prompt
      { x: 0, y: 9, width: 4, height: 3 }, // Claude  — minutes total
      { x: 4, y: 9, width: 4, height: 3 }, // ChatGPT — minutes total
      { x: 8, y: 9, width: 4, height: 3 }, // Gemini  — minutes total
    ];

    const placements = targetWidgets.map((w, i) => ({
      type: 'widget',
      widgetId: w.id,
      ...layout[i],
    }));

    for (const [i, p] of placements.entries()) {
      if (!p.widgetId) continue;
      try {
        const res = await apiFetch(`${baseUrl}/api/public/unstable/dashboards/${dashboard.id}/placements`, {
          method: 'POST',
          headers,
          body: JSON.stringify(p),
        }, `place widget '${widgets[i].name}'`);
        
        if (res.ok) {
          console.log(`✓ Placed widget: ${widgets[i].name}`);
          placedCount++;
        } else {
          console.warn(`⚠ Failed to place widget '${widgets[i].name}': ${await res.text()}`);
          failures++;
        }
      } catch (err) {
        console.warn(`⚠ Error placing widget '${widgets[i].name}':`, err);
        failures++;
      }
    }

    // A 200 on POST /placements does not mean the placement survived: colliding positions
    // are dropped server-side. Re-read the definition and confirm every widget is present.
    console.log('\nVerifying persisted placements...');
    try {
      const vRes = await apiFetch(`${baseUrl}/api/public/unstable/dashboards/${dashboard.id}`, { headers }, 'verify placements');
      if (!vRes.ok) {
        console.warn(`⚠ Could not verify placements: ${await vRes.text()}`);
        failures++;
      } else {
        const vData = await vRes.json();
        const persisted: any[] = vData.definition?.widgets || [];
        const persistedIds = new Set(persisted.map(p => p.widgetId));
        for (const [i, w] of targetWidgets.entries()) {
          if (!persistedIds.has(w.id)) {
            console.error(`✗ Widget '${widgets[i].name}' did NOT persist on the dashboard.`);
            failures++;
          }
        }
        placedCount = targetWidgets.filter(w => persistedIds.has(w.id)).length;
        console.log(`✓ ${persisted.length} placement(s) present in the dashboard definition.`);
      }
    } catch (err) {
      console.warn(`⚠ Error verifying placements:`, err);
      failures++;
    }
  }

  console.log(`\n================================`);
  if (failures > 0) {
    console.error(`❌ Setup failed! Encountered ${failures} error(s) during dashboard configuration.`);
    console.error(`Please review the warnings above.`);
    process.exit(1);
  }

  console.log(`🎉 Dashboard setup successful!`);
  console.log(`✓ ${placedCount}/${widgets.length} widgets placed on SLM Gate Performance.`);
  
  if (dashboard) {
    const projectId = dashboard.projectId;
    if (projectId) {
      console.log(`👉 View it at: ${baseUrl}/project/${projectId}/dashboards/${dashboard.id}`);
    } else {
      console.log(`👉 To view it, open Langfuse and click "Dashboards" in the left sidebar.`);
    }
  }
}

setupDashboard().catch((err) => {
  console.error('Fatal error setting up dashboard:', err);
  process.exit(1);
});
