import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `moduleUrl` is the script Node was started with (`node file.js`, `tsx file.ts`,
 * or a symlinked launcher), false when it was only imported.
 *
 * Why not `import.meta.url === \`file://${process.argv[1]}\``: the URL is percent-encoded and argv is not,
 * so an install folder with a space (`My Projects`) never matched, and the model gate ran without ever
 * listening. Comparing real paths also makes a symlinked bin match.
 *
 * @param moduleUrl The caller's `import.meta.url`
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(script);
  } catch {
    return false;
  }
}
