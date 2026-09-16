import fs from 'node:fs';
import { getProviderRegistry, minutesFreed } from '../src/pricing/providers.js';
import { ArmStats } from './arms.js';

const CYCLE_PROVIDERS = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
] as const;

/**
 * One report line per provider, computed exactly as the dashboard computes it.
 *
 * @param params.id Provider id in the registry
 * @param params.label Display name
 * @param params.tokensSaved Tokens Arm B saved versus Arm A
 * @param params.localPrompts Prompts Arm B answered without the cloud
 */
function cycleImpactLine(params: { id: string; label: string; tokensSaved: number; localPrompts: number }): string {
  const { id, label, tokensSaved, localPrompts } = params;
  const profile = getProviderRegistry()[id];
  const window = `${profile.windowMinutes / 60}-hour window`;
  const unitsSaved = profile.metering === 'message' ? localPrompts : tokensSaved;
  const minutes = minutesFreed(profile, unitsSaved);
  if (minutes === null) {
    return `**${label}** (${window}): not measured. Set \`${id.toUpperCase()}_WINDOW_BUDGET\` to see this.`;
  }
  return `**${label}** (${window}): estimated minutes saved **~${minutes.toFixed(1)}** over this dataset.`;
}

/**
 * Generates and writes a Markdown-formatted leaderboard report summarizing the results 
 * of the offline router evaluation.
 * 
 * The report includes:
 * - A formatted table comparing Accuracy (with 95% Confidence Intervals), Routing Rate, 
 *   and Cost across the three primary arms: All SLM, Arm A (All Cloud), and Arm B (Router).
 * - A "Cost @ Equal Quality" section that evaluates if the router achieved performance 
 *   greater than or equal to the cloud baseline, and if so, calculates the total savings.
 * 
 * If the cloud API is not configured (e.g., missing API keys), the report gracefully degrades 
 * to only display stats for the SLM and notes that the other arms are unavailable.
 * 
 * @param outPath The absolute or relative file path where the markdown report will be written
 * @param arms An object containing the performance statistics and Confidence Intervals for the three primary arms
 * @param apiConfigured A boolean indicating whether the cloud API was successfully called during the benchmark
 */
export function writeReport(
  outPath: string, 
  arms: { allSlm: ArmStats, armA: ArmStats, armB: ArmStats, CIs: Record<string, [number, number]> },
  apiConfigured: boolean,
  totalTasks: number,
  errorCount: number
) {
  const { allSlm, armA, armB, CIs } = arms;

  let report = `# Router Offline Evaluation Leaderboard\n\n`;
  
  report += `**Dataset Size:** ${totalTasks} tasks\n`;
  if (errorCount > 0) {
    report += `**Errors:** ${errorCount} tasks failed (graded as incorrect)\n`;
  }
  report += `\n`;

  if (!apiConfigured) {
    report += `**NOTE:** Cloud API was not configured (\`CLOUD_*\` missing). Only \`all_slm\` could be computed.\n\n`;
  }

  const formatStats = (name: string, stats: ArmStats, ci: [number, number]) => {
    if (!apiConfigured && name !== 'All SLM') {
      return `| ${name} | N/A (no API model configured) | - | - | - |`;
    }
    const acc = (stats.accuracy * 100).toFixed(1) + '%';
    const conf = `[${(ci[0] * 100).toFixed(1)}% - ${(ci[1] * 100).toFixed(1)}%]`;
    const rate = (stats.routingRate * 100).toFixed(1) + '%';
    const costStr = '$' + stats.cost.toFixed(4);
    return `| ${name} | ${acc} ${conf} | ${rate} | ${costStr} | ${stats.inTokens} / ${stats.outTokens} |`;
  };

  report += `| Arm | Accuracy (95% CI) | Routing Rate | Cost | Tokens (In / Out) |\n`;
  report += `|---|---|---|---|---|\n`;
  report += formatStats('All SLM', allSlm, CIs.allSlm) + '\n';
  report += formatStats('Arm A (All Cloud)', armA, CIs.armA) + '\n';
  report += formatStats('Arm B (Router)', armB, CIs.armB) + '\n';

  if (apiConfigured) {
    report += `\n### Cost @ Equal Quality\n`;
    if (armB.accuracy >= armA.accuracy) {
      const savings = armA.cost - armB.cost;
      const savingsPct = armA.cost > 0 ? (savings / armA.cost) * 100 : 0;
      
      report += `At an accuracy $\\ge$ Arm A, Arm B saves **$${savings.toFixed(4)}** (**${savingsPct.toFixed(1)}% reduction**) over the evaluated dataset.\n`;
      report += `*Note: On a subscription tier, cost is tokens/turns (dollars are 0).*`;
    } else {
      report += `Arm B did not achieve quality $\\ge$ Arm A on this dataset.\n`;
    }

    report += `\n### Tokens @ Equal Quality\n`;
    if (armB.accuracy >= armA.accuracy) {
      const armATotal = armA.inTokens + armA.outTokens;
      const armBTotal = armB.inTokens + armB.outTokens;
      const tokenSavings = armATotal - armBTotal;
      const tokenSavingsPct = armATotal > 0 ? (tokenSavings / armATotal) * 100 : 0;
      
      const inSavings = armA.inTokens - armB.inTokens;
      const outSavings = armA.outTokens - armB.outTokens;
      report += `At an accuracy $\\ge$ Arm A, Arm B saves **${tokenSavings.toLocaleString()} tokens** (${inSavings.toLocaleString()} in / ${outSavings.toLocaleString()} out) (**${tokenSavingsPct.toFixed(1)}% reduction**) over the evaluated dataset.\n`;
      
      // Arm B's routing rate is the share of prompts it sent to the cloud.
      const localPrompts = Math.round(totalTasks * (1 - armB.routingRate));

      report += `\n> **Real-World Impact (Subscription Windows):**\n`;
      report += `> *(Estimates within a margin of error: providers do not publish their window limits, so the window budgets are best guesses. Same formula as the dashboard: units saved × window minutes ÷ window budget. Units are tokens for Claude and Gemini, prompts answered locally for ChatGPT.)*\n`;
      for (const { id, label } of CYCLE_PROVIDERS) {
        report += `> - ${cycleImpactLine({ id, label, tokensSaved: tokenSavings, localPrompts })}\n`;
      }
    } else {
      report += `Arm B did not achieve quality $\\ge$ Arm A on this dataset.\n`;
    }
  }

  fs.writeFileSync(outPath, report);
}
