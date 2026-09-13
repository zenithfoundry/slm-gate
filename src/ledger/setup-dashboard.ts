/**
 * @fileoverview Utility script to setup a dedicated Custom Dashboard in Langfuse 
 * with tailored widgets to properly visualize SLM Gate categorical and numeric scores.
 */
import { CONFIG, requireKeys } from '../config.js';
import { setTimeout } from 'timers/promises';

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
      description: 'Total cloud tokens saved by local SLM deferral',
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'sum' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'tokens_saved' }],
    },
    {
      name: 'Cost Saved (Cents)',
      description: 'Estimated cloud API dollars avoided (in Cents)',
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'sum' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cost_saved_cents' }],
    },
    {
      name: 'SLM Accuracy Rate (%)',
      description: 'Accuracy of SLM output compared to cloud model baseline (0-100%)',
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'accuracy_rate_pct' }],
    },
    {
      name: 'Claude Cycle Extended (min)',
      description: "Average extra minutes of that provider's window per prompt, bounded [0, 300]. Extra minutes of your 5-hour Claude window that slm-gate frees up by answering prompts locally. Claude uses message-based metering, so token savings on forwarded prompts do not extend the cycle. This widget only populates when Claude receives traffic.",
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_per_window_claude' }],
    },
    {
      name: 'ChatGPT Cycle Extended (min)',
      description: "Average extra minutes of that provider's window per prompt, bounded [0, 180]. Extra minutes of your 3-hour ChatGPT window that slm-gate frees up by answering prompts locally. ChatGPT uses message-based metering, so token savings on forwarded prompts do not extend the cycle. This widget only populates when ChatGPT receives traffic.",
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_per_window_chatgpt' }],
    },
    {
      name: 'Gemini Cycle Extended (min)',
      description: "Average extra minutes of that provider's window per prompt, bounded [0, 300]. Extra minutes of your 5-hour Gemini window that slm-gate frees up by answering prompts locally. Gemini uses compute-based metering, making token savings extremely valuable. This widget only populates when Gemini receives traffic.",
      view: 'scores-numeric',
      chartType: 'NUMBER',
      metrics: [{ measure: 'value', agg: 'avg' }],
      dimensions: [],
      filters: [{ type: 'string', column: 'name', operator: '=', value: 'cycle_extended_per_window_gemini' }],
    }
  ];

  console.log('\nCreating widgets...');
  const targetWidgets = [];
  
  for (const w of widgets) {
    const existing = existingWidgets.find(ew => ew.name === w.name);
    if (existing) {
      console.log(`✓ Reusing existing widget: ${w.name}`);
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
          description: 'Comprehensive metrics tracking local SLM deferral rates, token savings, and quality.',
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
                               
          if (placementWidget && widgets.some(w => w.name === placementWidget.name)) {
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
    } catch (err) {
      console.warn(`⚠ Error removing existing placements:`, err);
      failures++;
    }

    console.log('\nPlacing widgets on dashboard...');
    
    // Explicit 12-column grid. Omitting x/y/width/height makes Langfuse auto-place each
    // widget, and colliding auto-placements overwrite each other server-side — the POST
    // still returns 200, so four of seven cards silently vanished from the definition.
    const layout = [
      { x: 0, y: 0, width: 6, height: 6 }, // Routing Decision (pie)
      { x: 6, y: 0, width: 3, height: 3 }, // Tokens Saved
      { x: 9, y: 0, width: 3, height: 3 }, // Cost Saved
      { x: 6, y: 3, width: 6, height: 3 }, // SLM Accuracy Rate
      { x: 0, y: 6, width: 4, height: 3 }, // Claude Cycle Extended
      { x: 4, y: 6, width: 4, height: 3 }, // ChatGPT Cycle Extended
      { x: 8, y: 6, width: 4, height: 3 }, // Gemini Cycle Extended
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
