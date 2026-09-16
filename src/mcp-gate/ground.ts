import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export async function scan(rootUri: string): Promise<string> {
  let rootPath = rootUri;
  if (rootUri.startsWith('file://')) {
    try {
      rootPath = fileURLToPath(rootUri);
    } catch {
      rootPath = rootUri.substring(7);
    }
  }

  const detected: string[] = [];
  
  const fileExists = async (filename: string) => {
    try {
      const stats = await fs.stat(path.join(rootPath, filename));
      return stats.isFile();
    } catch {
      return false;
    }
  };

  if (await fileExists('package.json')) {
    detected.push('Node.js / npm project');
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(rootPath, 'package.json'), 'utf-8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      
      if (allDeps['react']) detected.push('React');
      if (allDeps['next']) detected.push('Next.js');
      if (allDeps['vue']) detected.push('Vue');
      if (allDeps['svelte']) detected.push('Svelte');
      
      if (allDeps['jest']) detected.push('Jest');
      if (allDeps['vitest']) detected.push('Vitest');
    } catch (e) {
      // ignore parse errors
    }
  }

  if (await fileExists('tsconfig.json')) detected.push('TypeScript');
  if (await fileExists('yarn.lock')) detected.push('Yarn package manager');
  if (await fileExists('pnpm-lock.yaml')) detected.push('pnpm package manager');
  if (await fileExists('package-lock.json')) detected.push('npm package manager');
  if (await fileExists('Cargo.toml')) detected.push('Rust (Cargo)');
  if (await fileExists('go.mod')) detected.push('Go modules');

  if (detected.length === 0) {
    return 'No specific framework or environment detected from root files.';
  }

  // Single `\n`: `\\n` emitted the two characters backslash-n, so the whole environment
  // context reached the cloud model as one run-on line.
  return 'Detected environment context:\n- ' + detected.join('\n- ');
}
