/**
 * @fileoverview Repository symbol index: the local-model version of "is this already in the codebase?".
 *
 * A small, disk-only index of the symbols a repository defines — functions, classes, types, methods — kept in
 * the ledger's FTS5 table `repo_fts` and refreshed by file mtime, so a lookup costs a query and never a model
 * call. Identifiers are split into words (`renderDashboard` → `render dashboard`) so a plain-language query
 * matches them. No embeddings, no third model, nothing in RAM beyond the two loaded models.
 *
 * Three consumers (all behind REPO_INDEX=on):
 *   - the `find_existing` MCP tool: the cloud model asks before writing something new;
 *   - the resolver's evidence step: a question is answered from the symbols it names instead of a guessed
 *     file path;
 *   - the "Existing code that may already cover this" section appended to every conditioned skill, computed
 *     fresh on each call and never cached.
 *
 * File list: `git ls-files` when the root is a git checkout (so .gitignore is honoured), else a walk that skips
 * the usual build folders. Only source files of the four supported languages are read.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bumpRepoIndexRevision, deleteRepoFile, repoFileMtimes, repoIndexRevision, replaceRepoFileSymbols, searchRepoSymbols } from '../ledger/index.js';

/** Source files the extractor understands. */
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go']);
/** Folders a non-git walk never enters. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'output', 'coverage', '.next', '.nx', '.turbo', 'vendor', '__pycache__']);
/** A root is re-scanned at most this often; MCP calls arrive in bursts. */
const REFRESH_DEBOUNCE_MS = 5000;
/** Largest source file read; bigger ones are almost always generated. */
const MAX_FILE_BYTES = 512 * 1024;

export interface RepoSymbol {
  path: string;
  /** 1-based line of the definition. */
  line: number;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'const';
  name: string;
  /** The definition line, trimmed, at most 160 characters. */
  signature: string;
}

/** Definition patterns per language; `name` is the first capture group. */
const PATTERNS: Record<'ts' | 'py' | 'go', { kind: RepoSymbol['kind']; re: RegExp }[]> = {
  ts: [
    { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[<=]/ },
    { kind: 'enum', re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/ },
    { kind: 'method', re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/ },
  ],
  py: [
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', re: /^type\s+([A-Za-z_]\w*)/ },
  ],
};

/** Words of an identifier, lower-cased, so `renderDashboard`, `render_dashboard` and `render-dashboard` all give `render dashboard`. Pure. */
export function identifierWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-$]+/g, ' ')
    .toLowerCase()
    .trim();
}

function languageOf(file: string): keyof typeof PATTERNS | null {
  const ext = path.extname(file);
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  return SOURCE_EXT.has(ext) ? 'ts' : null;
}

/** Symbols one source file defines, by line. Pure; a file in an unsupported language yields none. */
export function extractSymbols(file: string, text: string): RepoSymbol[] {
  const lang = languageOf(file);
  if (!lang) return [];
  const out: RepoSymbol[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400 || /^\s*(?:\/\/|#|\*)/.test(line)) continue;
    for (const { kind, re } of PATTERNS[lang]) {
      const m = re.exec(line);
      if (!m) continue;
      // A TS method pattern also matches control flow like `if (x) {`; keep only real identifiers.
      if (kind === 'method' && /^(if|for|while|switch|catch|function|return|else)$/.test(m[1])) break;
      out.push({ path: file, line: i + 1, kind, name: m[1], signature: line.trim().slice(0, 160) });
      break;
    }
  }
  return out;
}

/** Relative paths of the repo's source files: git's view when it is a checkout, else a walk. */
export function listRepoFiles(root: string): string[] {
  let files: string[] | null = null;
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      // A git that hangs (a lock, a slow network mount) falls through to the walk instead of holding the tool call.
      files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 })
        .split('\0').filter(Boolean);
    } catch {
      files = null;
    }
  }
  if (files === null) {
    files = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name)); }
        else if (entry.isFile()) files!.push(path.relative(root, path.join(dir, entry.name)));
      }
    };
    walk(root);
  }
  return files.filter(f => SOURCE_EXT.has(path.extname(f)) && !f.split(path.sep).some(part => SKIP_DIRS.has(part))).sort();
}

const lastRefresh = new Map<string, number>();

/**
 * Brings one repo's index up to date by mtime: changed and new files are re-extracted, removed files dropped,
 * untouched files cost one stat each. At most once per REFRESH_DEBOUNCE_MS per root (`force` ignores that).
 * Returns the revision, which moves only when something changed — the cache dependency value.
 */
export function refreshRepoIndex(root: string, options: { force?: boolean } = {}): { revision: number; files: number; changed: number; removed: number } {
  const now = Date.now();
  const previous = lastRefresh.get(root) ?? 0;
  if (!options.force && now - previous < REFRESH_DEBOUNCE_MS) {
    return { revision: repoIndexRevision(root), files: repoFileMtimes(root).size, changed: 0, removed: 0 };
  }
  lastRefresh.set(root, now);

  const known = repoFileMtimes(root);
  const seen = new Set<string>();
  let changed = 0;
  for (const rel of listRepoFiles(root)) {
    seen.add(rel);
    const abs = path.join(root, rel);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    const mtime = Math.round(stat.mtimeMs);
    if (known.get(rel) === mtime) continue;
    let text: string;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    replaceRepoFileSymbols({ root, path: rel, mtime, symbols: extractSymbols(rel, text).map(s => ({ ...s, tokens: identifierWords(s.name) })) });
    changed++;
  }
  let removed = 0;
  for (const rel of known.keys()) {
    if (seen.has(rel)) continue;
    deleteRepoFile(root, rel);
    removed++;
  }
  const revision = changed + removed > 0 ? bumpRepoIndexRevision(root) : repoIndexRevision(root);
  return { revision, files: seen.size, changed, removed };
}

/** The symbols that best match a plain-language query, most relevant first. A query with no usable words finds nothing. */
export function findExisting(params: { root: string; query: string; limit?: number }): RepoSymbol[] {
  const { root, query, limit = 10 } = params;
  return searchRepoSymbols({ root, query: `${query} ${identifierWords(query)}`, limit });
}

/** The 30 lines around a symbol, numbered, for the resolver's evidence. Empty when the file cannot be read. */
export function linesAround(params: { root: string; symbol: RepoSymbol; radius?: number }): string {
  const { root, symbol, radius = 15 } = params;
  let text: string;
  try { text = fs.readFileSync(path.join(root, symbol.path), 'utf8'); } catch { return ''; }
  const lines = text.split('\n');
  const from = Math.max(0, symbol.line - 1 - radius);
  const to = Math.min(lines.length, symbol.line - 1 + radius);
  return lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
}

/**
 * The section appended to a conditioned skill: the symbols the task's words match, so the cloud model checks
 * what exists before writing something new. Empty when nothing matches. Deterministic for a given index.
 */
export function existingCodeSection(params: { root: string; task: string; limit?: number }): string {
  const hits = findExisting({ root: params.root, query: params.task, limit: params.limit ?? 5 });
  if (hits.length === 0) return '';
  return `\n\n# Existing code that may already cover this\n${hits.map(h => `- \`${h.name}\` (${h.kind}) — ${h.path}:${h.line}`).join('\n')}\n`;
}
