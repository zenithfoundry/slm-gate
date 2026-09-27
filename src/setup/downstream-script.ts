/**
 * @fileoverview Which argument of a DOWNSTREAM_MCP command is a file on this computer, for doctor to check.
 *
 * A toolbox started from a file (`node /path/to/server.mjs`) names it in its arguments. One started by a
 * command (`npx -y tech-lead-stack@1`, `uvx some-server`) names no file: its first argument is a flag or a
 * package, and checking that as a path reports a false failure. Scoped package names (`@scope/pkg@1`)
 * contain a slash, so a slash alone does not make a path.
 */

const SCRIPT_EXTENSION = /\.(m?js|cjs|ts)$/;
const PATH_START = /^(\/|\.{1,2}\/|~\/)/;

/**
 * @param args The DOWNSTREAM_MCP command's arguments
 * @returns The first argument that is a file path (starts with /, ./, ../ or ~/, or ends in .js, .mjs,
 *   .cjs or .ts), or null when the command names no file
 */
export function downstreamScript(args: readonly string[]): string | null {
  return args.find(arg => PATH_START.test(arg) || SCRIPT_EXTENSION.test(arg)) ?? null;
}
