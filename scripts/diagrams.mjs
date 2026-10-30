#!/usr/bin/env node
/**
 * `pnpm run diagrams`: renders every diagram source in diagrams/ with archify (a dev dependency, pinned to
 * a git tag; never part of the npm package) into docs/diagrams/, where the README and the docs embed it.
 *
 * For each `diagrams/<slug>.<type>.json` (type: architecture | workflow | sequence | dataflow | lifecycle):
 *   1. `archify finalize` validates the source (every `source` path and line range must exist in this repo
 *      at the commit the source pins), renders the explorable HTML and runs archify's browser check.
 *   2. The HTML is copied to docs/diagrams/<slug>.html (open it in a browser to explore the diagram).
 *   3. Headless Chrome opens it at a desktop viewport and screenshots the whole page to
 *      docs/diagrams/<slug>.png, the still image the markdown embeds (diagram, legend and note cards).
 *
 * Needs Chrome, Chromium or Edge; set ARCHIFY_CHROME to the executable when it is not found. The browser is
 * driven over its DevTools protocol with Node's built-in WebSocket, so no extra dependency is needed. Build
 * evidence goes to .archify/ (ignored by git). Pass slugs to render only those: `pnpm run diagrams request-path`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'diagrams');
const OUT = path.join(ROOT, 'docs', 'diagrams');
const BUILD = path.join(ROOT, '.archify');
const ARCHIFY = path.join(ROOT, 'node_modules', 'archify', 'bin', 'archify.mjs');
const TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'];
// The desktop viewport the page is laid out for; the still image is this wide and as tall as the page.
const VIEWPORT = { width: 1600, height: 1200 };
// The viewer settles its layout over a few animation frames after load.
const SETTLE_MS = 1500;

/** The first Chrome-family browser on this machine, or null. */
function findBrowser() {
  if (process.env.ARCHIFY_CHROME) return process.env.ARCHIFY_CHROME;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** Runs a command here and fails loudly, with its output, when it does not exit 0. */
function run(params) {
  const result = spawnSync(params.command, params.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${params.what} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** A headless browser reachable over the DevTools protocol; `close()` ends it and removes its profile. */
async function launchBrowser(executable) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-gate-diagrams-'));
  const child = spawn(executable, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`The browser did not open its DevTools endpoint:\n${stderr}`)), 15_000);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`The browser exited early (code ${code}):\n${stderr}`)); });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('Could not connect to the browser.')); });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(`${message.error.message} (${message.error.code})`)) : resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const once = (method, sessionId) => new Promise(resolve => {
    const listener = message => {
      if (message.method === method && message.sessionId === sessionId) { listeners.delete(listener); resolve(message.params); }
    };
    listeners.add(listener);
  });
  const close = async () => {
    const exited = new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 10_000).unref(); });
    try { await send('Browser.close'); } catch { child.kill(); }
    socket.close();
    await exited; // the profile can only go once the browser has stopped writing to it
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
  return { send, once, close };
}

/** Opens the page at the desktop viewport, lets the viewer settle and captures the whole page as PNG. */
async function screenshot(browser, params) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  const loaded = browser.once('Page.loadEventFired', sessionId);
  await browser.send('Page.navigate', { url: params.url }, sessionId);
  await loaded;
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  // The still shows what the page prints: the diagram, its legend and the note cards. The viewer's controls
  // (the floating toolbar, which is pinned to the viewport corner, and the node index) are marked no-print.
  const { result } = await browser.send('Runtime.evaluate', {
    expression: `document.querySelectorAll('.no-print').forEach(el => { el.style.display = 'none'; }); document.documentElement.scrollHeight`,
    returnByValue: true,
  }, sessionId);
  const height = Math.ceil(result.value);
  const { data } = await browser.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height, scale: 1 },
  }, sessionId);
  fs.writeFileSync(params.file, Buffer.from(data, 'base64'));
  await browser.send('Target.closeTarget', { targetId });
  return height;
}

async function renderOne(params) {
  const { slug, type, source, browser } = params;
  const buildDir = path.join(BUILD, slug);
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const built = path.join(buildDir, `${slug}.html`);
  run({
    what: `archify finalize ${slug}`,
    command: process.execPath,
    args: [ARCHIFY, 'finalize', type, source, built, '--quality', 'showcase', '--repo-root', ROOT, '--json'],
  });
  fs.copyFileSync(built, path.join(OUT, `${slug}.html`));
  const height = await screenshot(browser, { url: pathToFileURL(built).href, file: path.join(OUT, `${slug}.png`) });
  console.log(`  ${VIEWPORT.width}x${height} png`);
}

async function main() {
  if (!fs.existsSync(ARCHIFY)) throw new Error('archify is not installed: run `pnpm install` (it is a dev dependency).');
  const executable = findBrowser();
  if (!executable) throw new Error('No Chrome, Chromium or Edge found for the still images; set ARCHIFY_CHROME to one.');
  const only = process.argv.slice(2);
  const sources = fs.readdirSync(SOURCES).filter(file => file.endsWith('.json')).sort();
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser(executable);
  let rendered = 0;
  try {
    for (const file of sources) {
      const match = file.match(/^(.+)\.([a-z]+)\.json$/);
      if (!match || !TYPES.includes(match[2])) throw new Error(`diagrams/${file}: name it <slug>.<${TYPES.join('|')}>.json`);
      const [, slug, type] = match;
      if (only.length && !only.includes(slug)) continue;
      console.log(`${slug} (${type})`);
      await renderOne({ slug, type, source: path.join(SOURCES, file), browser });
      rendered++;
    }
  } finally {
    await browser.close();
  }
  console.log(`${rendered} diagram(s) rendered into docs/diagrams/.`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
