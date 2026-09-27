# Switch slm-gate to npm

You set up `slm-gate` by downloading its code into a folder. It now installs like any other program. These steps
install it fresh, then an AI assistant sets it up with you: your settings, the local models, your coding apps and
any toolbox. Nothing is copied from the old folder.

## Before you start

- You need an AI assistant that can run commands on your computer: **Claude Code**, **Codex** or **Gemini CLI**.
- Your old settings and savings history stay behind in the old folder. The new install starts its own. You can
  bring the old ones back afterwards: see [the optional steps](#optional-bring-back-your-old-settings-and-history)
  at the end.
- Used extras that need a key, such as the savings dashboard? Have the key ready: the assistant asks you to type
  keys into the new settings file yourself, never into the chat.

## Steps

### 1. Install the new slm-gate

Open **Terminal** and run:

```bash
npm install -g @zenithfoundry/slm-gate
slm-gate --version
```

The last line prints the version: 1.3.0 or higher. A "permission denied" error? Follow
[npm's guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally), then
run this step again.

### 2. Open your AI assistant

Start Claude Code, Codex or Gemini CLI the way you normally do. Leave your other coding apps as they are: the
assistant tells you when to restart them.

### 3. Give it the setup prompt

Open the [AI setup prompt](./agent-setup.md#the-prompt), copy everything in the box under "The prompt", paste it
into the assistant and press Enter.

### 4. Answer its questions

- It checks your computer first and tells you what it found, including your old `slm-gate`.
- It asks one question at a time and suggests an answer. Not sure? Take its suggestion.
- Use a toolbox such as Tech-Lead-Stack? Say so when it asks.
- Before it changes a file, it shows you the change and makes a backup copy. Say yes to go ahead.
- If something is missing, for example Ollama is not running, it tells you what to do and waits. Type `ready` when
  you have done it.
- Near the end it asks you to quit and reopen your coding apps. First it gives you a command that brings you back
  to the same conversation.

### 5. Check it worked

The assistant checks this too. This is your own check, in Terminal:

```bash
slm-gate doctor
ollama ps
```

The doctor's last line says **READY**, and `ollama ps` lists two models. Your coding apps show `slm-gate` as
connected.

### 6. Put the old folder in the Trash

Want your old settings or history back? Do [the optional steps](#optional-bring-back-your-old-settings-and-history)
below first: they copy from this folder.

The assistant tells you which folder it was. Once everything works, drag that folder to the Trash. If anything stops
working, drag it back out and [tell us what happened](https://github.com/zenithfoundry/slm-gate/issues).

**From now on,** update `slm-gate` with `npm update -g @zenithfoundry/slm-gate`, then run `slm-gate restart`.

## Optional: bring back your old settings and history

Only if you want them. Do this after step 5 and before the old folder goes in the Trash. You can bring back either
one, or both. The new install's own copies are kept, so you can switch back.

### 1. Quit your coding apps, then stop slm-gate

```bash
slm-gate stop
```

### 2. Tell Terminal where your old folder is

Use the folder the assistant named. Change the path to yours, then run both lines.

```bash
OLD=~/small-language-model-gate
ls "$OLD/.env"
```

The second line should print the path back. If it says "No such file or directory", the path is wrong: fix it and
run both lines again. Do the next steps in this same Terminal window.

### 3. Bring back your history

Skip this step to keep the new, empty history.

```bash
mv ~/.slm-gate/output ~/.slm-gate/output-from-fresh-install
cp -Rp "$OLD/output" ~/.slm-gate/output
```

The first line moves the new history aside; the second copies your old one in.

### 4. Bring back your settings

Skip this step to keep the settings the assistant made. Your old settings replace them, including your old choice
of local models.

```bash
cp -p ~/.slm-gate/.env ~/.slm-gate/.env.from-fresh-install
cp -p "$OLD/.env" ~/.slm-gate/.env
chmod 600 ~/.slm-gate/.env
grep -n "$OLD" ~/.slm-gate/.env
```

If the last line printed anything, those settings still point to the old folder. Open the file (on Linux, use
`nano` instead of `open -e`):

```bash
open -e ~/.slm-gate/.env
```

- A line starting `LEDGER_PATH=`: delete everything after the `=`, so it reads `LEDGER_PATH=`
- A line starting `DISTILL_PRESERVE_PATH=`: make it read `DISTILL_PRESERVE_PATH=configs/preserve/tls.json`

Save the file, then run the `grep` line again: it should print nothing now.

### 5. Start it and check

```bash
slm-gate restart
slm-gate doctor
```

The last line should say **READY**. If it says a model is missing, run the `ollama pull` line it shows, then
`slm-gate doctor` again. Then open your coding apps.

### 6. Changed your mind? Switch back

Run the box for what you brought back.

Put back the settings the assistant made:

```bash
slm-gate stop
cp -p ~/.slm-gate/.env.from-fresh-install ~/.slm-gate/.env
slm-gate restart
```

Put back the new history:

```bash
slm-gate stop
mv ~/.slm-gate/output ~/.slm-gate/output-from-old-folder
mv ~/.slm-gate/output-from-fresh-install ~/.slm-gate/output
slm-gate restart
```

---

The full guide, with every option: [Install from npm](./install-from-npm.md).
