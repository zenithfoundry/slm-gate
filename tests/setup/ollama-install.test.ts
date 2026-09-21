import { describe, expect, it } from '@jest/globals';
import { howToStartOllama } from '../../src/setup/ollama-install.js';

/** A machine with exactly these paths on it, and nothing else. */
const machine = (...present: string[]) => ({
  home: '/Users/dev',
  pathDirs: ['/opt/homebrew/bin'],
  exists: (target: string) => present.includes(target),
});

const BREW_AGENT = '/Users/dev/Library/LaunchAgents/homebrew.mxcl.ollama.plist';
const BINARY = '/opt/homebrew/bin/ollama';

describe('howToStartOllama', () => {
  it('names brew services when Homebrew holds the port, since `ollama serve` would only clash with it', () => {
    const fix = howToStartOllama({ platform: 'darwin', ...machine(BREW_AGENT, BINARY) });
    expect(fix).toContain('brew services start ollama');
    expect(fix).toContain('already in use');
  });

  it('sends a Homebrew machine to brew even though the app is also installed', () => {
    const fix = howToStartOllama({ platform: 'darwin', ...machine(BREW_AGENT, '/Applications/Ollama.app') });
    expect(fix).toContain('brew services start ollama');
  });

  it('opens the app on a Mac that has it and no Homebrew service', () => {
    const fix = howToStartOllama({ platform: 'darwin', ...machine('/Applications/Ollama.app', BINARY) });
    expect(fix).toBe('Open the Ollama app.');
  });

  it('falls back to `ollama serve` for a plain binary install', () => {
    expect(howToStartOllama({ platform: 'darwin', ...machine(BINARY) })).toBe('Run `ollama serve`.');
  });

  it('names systemctl when systemd keeps Ollama running', () => {
    const fix = howToStartOllama({ platform: 'linux', ...machine('/etc/systemd/system/ollama.service', BINARY) });
    expect(fix).toContain('sudo systemctl start ollama');
    expect(fix).toContain('already in use');
  });

  it('uses `ollama serve` on Linux without a systemd unit', () => {
    expect(howToStartOllama({ platform: 'linux', ...machine(BINARY) })).toBe('Run `ollama serve`.');
  });

  it('says how to install it when Ollama is nowhere on the machine', () => {
    const fix = howToStartOllama({ platform: 'darwin', ...machine() });
    expect(fix).toContain('https://ollama.com/download');
  });

  it('does not treat a brew service on one platform as one on another', () => {
    // The Homebrew LaunchAgent is a macOS thing; the same file on Linux means nothing.
    const fix = howToStartOllama({ platform: 'linux', ...machine(BREW_AGENT, BINARY) });
    expect(fix).toBe('Run `ollama serve`.');
  });

  it('describes this machine without being told anything about it', () => {
    // No injected filesystem: it must still produce a usable sentence rather than throw.
    expect(howToStartOllama()).toMatch(/ollama|Ollama/);
  });
});
