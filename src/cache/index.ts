/**
 * The semantic cache (SEMCACHE=on): a conditioning is served again for a tool result that means the same
 * thing, judged by embedding similarity, as long as the workspace files it mentioned are unchanged. Owns the
 * `semcache` table, its scan cap and its retention.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { CONFIG } from '../config.js';
import { log } from '../log.js';
import { getDb } from '../ledger/index.js';
import { cosineSimilarity, embedText } from '../utils/embedding.js';

let dbInitialized = false;

/**
 * Rows a check compares against, newest first. Every candidate costs a cosine in JS, so the scan is capped
 * instead of growing with the table; rows past the retention window are deleted when the cache is opened.
 */
const SEMCACHE_SCAN_ROWS = 2000;

/**
 * Initializes the semantic cache table in the local SQLite ledger and prunes rows older than
 * ELISION_RETENTION_DAYS. Called lazily before cache operations so the `semcache` table exists
 * without blocking the main application boot.
 */
export function initCacheDb() {
  if (dbInitialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS semcache (
      id TEXT PRIMARY KEY,
      embedding_blob BLOB,
      response TEXT,
      file_hashes TEXT,
      ts TEXT
    );
  `);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (CONFIG.ELISION_RETENTION_DAYS ?? 180));
  db.prepare('DELETE FROM semcache WHERE ts < ?').run(cutoff.toISOString());
  dbInitialized = true;
}

/**
 * Scans a prompt text for potential file paths, reads those files from disk,
 * and returns a map of their SHA-256 hashes. This acts as a stale-context guard:
 * if a referenced file is edited, its hash changes, invalidating previous cache hits.
 *
 * @param text The raw prompt or task text containing potential file paths.
 * @param rootPath The workspace a relative path is resolved against; without one only absolute paths are
 *   hashed (the install directory of slm-gate is never the right root).
 * @returns A dictionary mapping absolute file paths to their SHA-256 hashes.
 */
export async function getReferencedFilesHashes(text: string, rootPath?: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  
  // Regex to extract standard file paths or file:// URIs
  const regex = /(?:file:\/\/)?(\/?(?:[a-zA-Z0-9_\-\.]+\/)+[a-zA-Z0-9_\-\.]+)/g;
  let match;
  const potentialPaths = new Set<string>();
  
  while ((match = regex.exec(text)) !== null) {
    potentialPaths.add(match[1]);
  }
  
  // Secondary regex for isolated relative paths like "src/index.ts"
  const wordRegex = /([a-zA-Z0-9_\-\.\/]+)/g;
  while ((match = wordRegex.exec(text)) !== null) {
    if (match[1].includes('.') && match[1].includes('/')) {
      potentialPaths.add(match[1]);
    }
  }

  for (let p of potentialPaths) {
    // Strip URI protocol if present
    if (p.startsWith('file://')) p = p.substring(7);
    
    // Resolve relative paths against the workspace the tool result came from
    let fullPath = p;
    if (!path.isAbsolute(fullPath)) {
      if (!rootPath) continue;
      fullPath = path.join(rootPath, fullPath);
    }
    
    try {
      // Hash the file contents if it exists and is a valid file
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        const content = await fs.readFile(fullPath);
        hashes[fullPath] = crypto.createHash('sha256').update(content).digest('hex');
      }
    } catch {
      // Safely ignore missing files or invalid paths
    }
  }
  return hashes;
}

/**
 * Checks the semantic cache for a sufficiently similar previous request.
 * 
 * Flow:
 * 1. Generates an embedding for the current request using the local model.
 * 2. Extracts and hashes any files referenced in the current request.
 * 3. Scans stored cache entries:
 *    a. Rejects if the stored referenced file hashes do not match exactly.
 *    b. Calculates cosine similarity of the prompt embeddings.
 *    c. Accepts and returns the stored response if similarity >= threshold.
 * 
 * @param text The current task or prompt text to evaluate.
 * @param rootPath The workspace the text's relative file paths belong to.
 * @returns The cached response object/string if a match is found, otherwise null.
 */
export async function checkSemanticCache(text: string, rootPath?: string): Promise<any | null> {
  if (!CONFIG.SEMCACHE) return null;
  initCacheDb();
  
  let currentEmbedding: number[] | null;
  try {
    currentEmbedding = await embedText(text);
    if (!currentEmbedding) return null;
  } catch (e) {
    log.error('cache', 'Failed to generate embedding', { error: e });
    return null;
  }
  
  const currentHashes = await getReferencedFilesHashes(text, rootPath);

  const db = getDb();
  const rows = db.prepare('SELECT id, embedding_blob, response, file_hashes FROM semcache ORDER BY ts DESC LIMIT ?').all(SEMCACHE_SCAN_ROWS) as any[];
  
  for (const row of rows) {
    const storedHashes = JSON.parse(row.file_hashes);
    
    // Validate that the context files haven't changed (stale-context guard)
    const keys1 = Object.keys(currentHashes);
    const keys2 = Object.keys(storedHashes);
    let match = keys1.length === keys2.length;
    if (match) {
      for (const k of keys1) {
        if (currentHashes[k] !== storedHashes[k]) {
          match = false;
          break;
        }
      }
    }
    
    // Skip this cache entry if file contexts differ
    if (!match) continue;

    // Convert the stored SQLite BLOB back into a Float64Array for math operations
    const buf = row.embedding_blob as Buffer;
    const storedEmbedding = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
    
    const sim = cosineSimilarity(currentEmbedding, Array.from(storedEmbedding));
    if (sim >= CONFIG.SEMCACHE_THRESHOLD) {
      log.info('cache', 'semantic hit', { similarity: sim.toFixed(4) });
      return JSON.parse(row.response);
    }
  }
  return null;
}

/**
 * Stores a new entry in the semantic cache.
 * 
 * Generates the vector embedding for the prompt, hashes its referenced files, 
 * and stores the original response payload in the SQLite ledger.
 * 
 * @param params.text The original prompt or task text.
 * @param params.response The response payload or string to store.
 * @param params.rootPath The workspace the text's relative file paths belong to.
 */
export async function setSemanticCache(params: { text: string; response: any; rootPath?: string }) {
  const { text, response: responseObj, rootPath } = params;
  if (!CONFIG.SEMCACHE) return;
  initCacheDb();
  
  let embedding: number[] | null;
  try {
    embedding = await embedText(text);
    if (!embedding) return;
  } catch (e) {
    log.error('cache', 'Failed to generate embedding for storage', { error: e });
    return;
  }
  
  // Convert the array of floats into a binary buffer for SQLite BLOB storage
  const blob = Buffer.from(new Float64Array(embedding).buffer);
  const currentHashes = await getReferencedFilesHashes(text, rootPath);
  
  const db = getDb();
  const stmt = db.prepare('INSERT INTO semcache (id, embedding_blob, response, file_hashes, ts) VALUES (?, ?, ?, ?, ?)');
  
  // Store the request embedding alongside the serialized response and the file context state
  stmt.run(crypto.randomUUID(), blob, JSON.stringify(responseObj), JSON.stringify(currentHashes), new Date().toISOString());
}
