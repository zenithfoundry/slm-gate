/**
 * @fileoverview How Ollama is installed on this machine, so that "start Ollama" can name the command
 * that actually works here. Telling somebody to run `ollama serve` when Homebrew or systemd already
 * keeps Ollama running gets them "address already in use", which reads like a second fault and sends
 * them looking for one. This only looks at the filesystem: it never runs Ollama and never starts it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Homebrew starts Ollama through this LaunchAgent, and then owns the port. */
const BREW_AGENT = 'Library/LaunchAgents/homebrew.mxcl.ollama.plist';
const MACOS_APP = '/Applications/Ollama.app';
const SYSTEMD_UNITS = [
  '/etc/systemd/system/ollama.service',
  '/usr/lib/systemd/system/ollama.service',
  '/lib/systemd/system/ollama.service',
];
const INSTALL = 'Install Ollama from https://ollama.com/download, then start it.';

/**
 * The sentence telling somebody how to start Ollama on this machine.
 *
 * Every input is injectable so this stays a pure function of the machine's state, which is also how
 * the tests cover installs the test machine does not have.
 *
 * @param params.platform Defaults to the running platform
 * @param params.home Defaults to the current user's home directory
 * @param params.pathDirs Directories to look for the `ollama` binary in; defaults to PATH
 * @param params.exists Defaults to checking the real filesystem
 * @returns A sentence naming the command to run, ready to use as a problem's fix
 */
export function howToStartOllama(params: {
  platform?: NodeJS.Platform;
  home?: string;
  pathDirs?: readonly string[];
  exists?: (target: string) => boolean;
} = {}): string {
  const platform = params.platform ?? process.platform;
  const exists = params.exists ?? fs.existsSync;
  const home = params.home ?? os.homedir();
  const pathDirs = params.pathDirs ?? (process.env.PATH ?? '').split(path.delimiter);
  const onPath = pathDirs.some(dir => dir !== '' && exists(path.join(dir, 'ollama')));
  const serve = 'Run `ollama serve`.';

  if (platform === 'darwin') {
    if (exists(path.join(home, BREW_AGENT))) {
      return 'Run `brew services start ollama` (Homebrew keeps Ollama running on this machine, so `ollama serve` would only report that the address is already in use).';
    }
    if (exists(MACOS_APP)) return 'Open the Ollama app.';
    return onPath ? serve : INSTALL;
  }

  if (platform === 'linux') {
    if (SYSTEMD_UNITS.some(exists)) {
      return 'Run `sudo systemctl start ollama` (systemd keeps Ollama running on this machine, so `ollama serve` would only report that the address is already in use).';
    }
    return onPath ? serve : INSTALL;
  }

  return onPath ? serve : INSTALL;
}
