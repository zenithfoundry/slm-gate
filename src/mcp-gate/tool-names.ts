/**
 * @fileoverview Makes any downstream toolbox's tool names resolve to slm-gate.
 *
 * A toolbox usually refers to its own tools by the name its installer registered them under.
 * Tech-Lead-Stack's slash commands, for example, say `mcp__tech-lead-stack__get_skills`.
 * Behind slm-gate those tools are served by the gate, so that name does not exist in the
 * editor. The gate learns the toolbox's tool list when it connects and uses it to
 * (1) tell the editor which tools it serves, and (2) rewrite prefixed references to those
 * tools in results. Nothing here is specific to any one toolbox.
 */

/** The name slm-gate is registered under in the editor (see README → Step 4). */
export const GATE_MCP_NAME = 'slm-gate';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrites `mcp__<any server>__<tool>` (and the single-underscore `mcp_<server>_<tool>` form)
 * to `mcp__slm-gate__<tool>`, but only for tools the connected toolbox actually serves.
 *
 * @param text Text returned to the editor
 * @param toolNames Tool names served by the connected toolbox
 * @returns The text with those tool references pointing at slm-gate
 */
export function rewriteToolReferences(text: string, toolNames: readonly string[]): string {
  if (!text || toolNames.length === 0) return text;
  // Longest first, so `get_skill` can never match inside `get_skills`.
  const tools = [...toolNames].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  // Server names are matched without underscores, so the tool name must start right after
  // the separator: `mcp__foo__bar_get_skill` is NOT read as tool `get_skill`.
  const pattern = new RegExp(`\\bmcp__?[A-Za-z0-9][A-Za-z0-9-]*__?(${tools})\\b`, 'g');
  return text.replace(pattern, (_match, tool: string) => `mcp__${GATE_MCP_NAME}__${tool}`);
}

/**
 * Builds the instructions the gate hands the editor when it connects.
 *
 * @param params.toolNames Tool names served by the connected toolbox
 * @param params.downstreamInstructions The toolbox's own instructions, passed through
 * @param params.notices Set-up problems found at start-up (src/setup/startup.ts), passed on to the user
 * @returns Instructions text, or undefined when there is nothing to say
 */
export function buildGateInstructions(params: {
  toolNames: readonly string[];
  downstreamInstructions?: string;
  notices?: readonly { message: string; fix: string }[];
}): string | undefined {
  const { toolNames, downstreamInstructions, notices = [] } = params;
  const parts: string[] = [];
  if (notices.length > 0) {
    parts.push(
      `${GATE_MCP_NAME} notice — tell the user about this at the start of your next reply, word for word:`,
      ...notices.map(notice => `- ${notice.message} Fix: ${notice.fix}`),
      '',
    );
  }
  if (toolNames.length > 0) {
    parts.push(
      `This server (${GATE_MCP_NAME}) serves the tools of the toolbox connected behind it: ${toolNames.join(', ')}.`,
      `Commands, skills or docs may refer to these tools under another server name, for example \`mcp__<toolbox>__${toolNames[0]}\`. ` +
        `They mean the tool of the same name on this server: call \`mcp__${GATE_MCP_NAME}__<tool>\` instead.`
    );
  }
  if (downstreamInstructions?.trim()) {
    parts.push('', 'Instructions from the connected toolbox:', downstreamInstructions.trim());
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}
