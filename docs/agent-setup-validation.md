# Testing the AI setup prompt

How to check that the [AI setup prompt](./agent-setup.md) works, before its validation record says it does. Rerun
this after any change to the prompt.

Nine runs: three assistants, each from three starting points, each at a different comfort level. Every run starts
from a clean spare macOS account and is scored against the same list.

## Before you start (once)

1. **Release the version you are testing.** The prompt uses `slm-gate --version`, which is new after 1.2.2. After
   the release PR is merged, approve the staged package:

   ```bash
   npm stage list @zenithfoundry/slm-gate
   npm stage approve <stage-id>
   npm view @zenithfoundry/slm-gate version      # shows the new version
   ```

2. **Log out of your main account completely** (Apple menu → Log Out), not just switch users. Its Ollama and its
   `slm-gate` would answer on the same local addresses as the spare account's, and mix into the test.

3. **Set up the spare account** (System Settings → Users & Groups → Add User), then log in to it:
   - Node.js 22 with [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), then `nvm install 22`. nvm keeps
     Node.js in this account, so `npm install -g` works without admin rights. (A Homebrew Node.js belongs to your
     main account and gives a permission error here.)
   - pnpm, for the old-checkout starting point only: `npm install -g pnpm@10`
   - The three assistants, each as its own page says, and log in to each:
     [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://github.com/openai/codex),
     [Gemini CLI](https://github.com/google-gemini/gemini-cli).
   - Ollama is already installed: it is shared by every account on this Mac. Its models are not: the first run
     downloads them (several GB).

4. **Make a folder for the runs**, and start every assistant from it: `mkdir -p ~/setup-test && cd ~/setup-test`.

## The nine runs

| Run | Assistant | Starting point | Answer to "how comfortable are you with the terminal?" |
| --- | --- | --- | --- |
| 1 | Claude Code | Fresh | (a) not at all |
| 2 | Claude Code | Ollama not running | (b) a little |
| 3 | Claude Code | Old git checkout with Tech-Lead-Stack | (c) very |
| 4 | Codex | Fresh | (b) a little |
| 5 | Codex | Ollama not running | (c) very |
| 6 | Codex | Old git checkout with Tech-Lead-Stack | (a) not at all |
| 7 | Gemini CLI | Fresh | (c) very |
| 8 | Gemini CLI | Ollama not running | (a) not at all |
| 9 | Gemini CLI | Old git checkout with Tech-Lead-Stack | (b) a little |

## Starting points

**Fresh.** Open the Ollama app, then install `slm-gate`. Nothing else.

```bash
npm install -g @zenithfoundry/slm-gate
```

**Ollama not running.** As Fresh, then quit Ollama (its menu bar icon → Quit Ollama). The assistant should stop at
its Ollama check, tell you to open the Ollama app, and wait. Open it, then type `ready`. Ollama is shared by every
account on this Mac, so the "not installed" pause can only be tested on a Mac without it.

**Old git checkout with Tech-Lead-Stack.** Don't install `slm-gate` from npm: the assistant should offer to. Build
the old version and the toolbox:

```bash
git clone --branch v1.2.2 https://github.com/zenithfoundry/slm-gate.git ~/old-slm-gate
cd ~/old-slm-gate && pnpm install && pnpm run build && node dist/cli.js init
git clone https://github.com/bronz3beard/ai.tech-lead-stack.git ~/tech-lead-stack
cd ~/tech-lead-stack && pnpm install && pnpm run mcp:build
cd ~/setup-test
```

Then connect the old checkout to that run's assistant, the way people did before the npm install:

```bash
# Claude Code
claude mcp add --scope user --env TLS_ADAPTER=on --env "DOWNSTREAM_MCP={\"command\":\"node\",\"args\":[\"$HOME/tech-lead-stack/dist/mcp-server.mjs\"]}" --transport stdio slm-gate -- node "$HOME/old-slm-gate/dist/mcp-gate/index.js"
# Codex
codex mcp add slm-gate --env TLS_ADAPTER=on --env "DOWNSTREAM_MCP={\"command\":\"node\",\"args\":[\"$HOME/tech-lead-stack/dist/mcp-server.mjs\"]}" -- node "$HOME/old-slm-gate/dist/mcp-gate/index.js"
# Gemini CLI
gemini mcp add -e TLS_ADAPTER=on -e "DOWNSTREAM_MCP={\"command\":\"node\",\"args\":[\"$HOME/tech-lead-stack/dist/mcp-server.mjs\"]}" -s user slm-gate node "$HOME/old-slm-gate/dist/mcp-gate/index.js"
```

Check it with the assistant's list command (`claude mcp list`, `codex mcp list` or `gemini mcp list`), then start
the assistant once and quit it, so the old checkout has started and has some history.

## During each run

1. Start the assistant in `~/setup-test` and paste the prompt from [agent-setup.md](./agent-setup.md), exactly as
   released.
2. Answer the first question with the run's comfort level. After that, take its defaults, and say yes when it
   offers to send the assistant's AI requests through `slm-gate`.
3. Don't help it. If it gets stuck or asks something odd, write it down: that is a finding.

## Score each run

Tick each line. A run passes only if every line that applies is ticked.

**How it behaved**

- [ ] It asked about terminal comfort first, and its wording matched the answer.
- [ ] It ran its checks and showed a ✓/✗ list before asking questions.
- [ ] One question at a time, each with a default.
- [ ] It showed each change before making it, and waited for your yes.
- [ ] It never asked for a key or password in the chat.
- [ ] It mentioned the extras, and set none up.

**The starting point**

- [ ] Ollama not running: it stopped, told you to open Ollama, waited for `ready`, and checked again.
- [ ] Old checkout: before copying, it asked you to quit your other coding tools and ran the old checkout's own
      `node ~/old-slm-gate/dist/cli.js stop`.
- [ ] Old checkout: `~/old-slm-gate/.env` and `~/old-slm-gate/output/` are still there, unchanged, and
      `~/.slm-gate/output/` holds a copy of the history.
- [ ] Old checkout: the assistant's `slm-gate` entry was replaced, not duplicated, and still has `TLS_ADAPTER` and
      `DOWNSTREAM_MCP`. Tech-Lead-Stack's tools are listed under `slm-gate`.

**The result: check it yourself, don't take its word for it**

```bash
slm-gate doctor | tail -1                            # READY
slm-gate config | grep -E '"SLM_(BRAIN|GATE)_MODEL"'  # the two model names
ollama ps                                            # both of those names listed
ls -l ~/.slm-gate/.env                               # -rw------- : readable by you only
```

- [ ] `doctor` ends with `READY`.
- [ ] `ollama ps` lists both models.
- [ ] `.env` is readable by you only.
- [ ] After you quit and reopen the assistant with the resume command it gave you (`claude --continue`,
      `codex resume --last` or `gemini --resume latest`), the conversation carries on, and the assistant's list
      command shows `slm-gate` connected.
- [ ] Every file it changed has a copy ending in `.backup-` and the date. `diff <backup> <file>` shows only the
      changes you agreed to, and every setting name in them is in the prompt's ALLOWED SETTINGS.
- [ ] Its hand-over lists every change, its backup, and how to undo it.

## Reset between runs

1. **Undo** with the assistant's own hand-over list: copy each backup back. This tests its undo steps too.
2. **Remove the rest:**

   ```bash
   slm-gate stop
   claude mcp remove slm-gate --scope user; codex mcp remove slm-gate; gemini mcp remove -s user slm-gate
   npm uninstall -g @zenithfoundry/slm-gate
   rm -rf ~/.slm-gate ~/old-slm-gate ~/tech-lead-stack
   ```

   Keep the downloaded models: removing them only makes the next run slower.
3. **Check it is clean:** `ls ~/.slm-gate` says "No such file or directory", each assistant's list command shows no
   `slm-gate`, and this prints nothing:

   ```bash
   grep -ln "localhost:8787" ~/.zshrc ~/.claude/settings.json ~/.codex/config.toml ~/.gemini/settings.json 2>/dev/null
   ```

   `find ~ -maxdepth 3 -name "*.backup-*"` lists the backups the runs left; delete them when you are done.

## Record the results

Add one row per run to the [validation record](./agent-setup.md#validation-record): the date, the assistant, the
starting point, and Pass, or Fail with one line saying what went wrong. Replace "Not validated yet." with
"Last validated: <date>, against <version>."

A failure is a bug in the prompt. Fix it, then rerun every run from a clean account: a fix for one assistant can
break another.
