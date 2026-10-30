# slm-gate documentation

Every page, in reading order, and the words the pages use. New here? Start with the [README](../README.md).

`slm-gate` is two small programs on your computer. The **MCP gate** sits in front of your tools and shrinks what they return. The **model gate** sits in front of your AI provider and shrinks the tool output inside each request. Both record what they saved in a local ledger.

## Installed from npm

Read these in order if you installed `slm-gate` with `npm install -g`.

1. [Install](npm/install.md): install, create your settings file, download the models, check, connect your tool, upgrade. Also: where settings come from, and how to put a toolbox behind the gate.
2. [Profiles](npm/profiles.md): the three settings profiles `slm-gate init` offers (starter, proven, toolbox), what each turns on, and how to switch.
3. [Connect your tool](npm/connect-your-tool.md): the MCP entry for each coding tool, and which tools can also send their AI requests through the gate.
4. [Daily use](npm/daily-use.md): the health check, what to do when something does not start, the commands you may need, and what the gate remembers.
5. [Measure your savings](npm/measure-savings.md): `slm-gate metrics`, the dashboard, Langfuse, and what the cycle cards mean.
6. [Set up with an AI assistant](npm/ai-assisted-setup.md): a prompt that checks your computer, asks a few questions, and sets everything up with you.
7. [Testing the AI setup prompt](npm/ai-assisted-setup-validation.md): the nine runs to do before the prompt's validation record changes.

## From source (contributors)

Read these if you cloned the repository to change `slm-gate` itself.

1. [Set up from source](source/setup.md): clone, install, build, test, run from the checkout, where settings live, contributor commands.
2. [Switch to npm](source/switch-to-npm.md): leave a git checkout behind and install from npm, with optional steps to bring back old settings and history.
3. [Diagrams](source/diagrams.md): how the repository's diagrams are authored and regenerated.

Also: [Architecture](../ARCHITECTURE.md), [house rules for coding agents](../AGENTS.md), [contributing](../.github/CONTRIBUTING.md), [security policy](../SECURITY.md), [support](../SUPPORT.md).

## Reference (both)

1. [Settings](reference/settings.md): every setting, grouped as the settings file groups them, with its default and when to change it.
2. [Hardware](reference/hardware.md): which local models fit your RAM, how Ollama uses memory, and the Ollama settings that keep both models loaded.
3. [How it works](reference/how-it-works.md): the path a tool call and a model request take through the two gates, and how the gates start.
4. [Analytics](reference/analytics.md): the ledger in detail, Langfuse, publishing the dashboard, and reading the numbers.

Tool pages: [Antigravity](../configs/antigravity/README.md), [Claude Code](../configs/claude-code/README.md), [Claude Desktop](../configs/claude-desktop/README.md), [Cline, Continue and OpenCode](../configs/cline-continue-opencode/README.md), [Cursor](../configs/cursor/README.md), [generic stdio](../configs/generic-stdio/README.md), [generic HTTP](../configs/generic-http/README.md). Also [preserved patterns](../configs/preserve/README.md): text the gate must never shrink.

Design notes that led to the current code are in [briefs](briefs/).

## Glossary

Other pages link here instead of explaining these again.

- **Token.** The unit AI providers count text in. About 4 characters, or three quarters of a word. 1,000 tokens is roughly 750 words or 100 lines of code.
- **MCP.** The Model Context Protocol: the standard a coding tool uses to call tools. An MCP server offers tools; the coding tool calls them and gets results back.
- **Toolbox.** Any MCP server you put behind the MCP gate with `DOWNSTREAM_MCP`, for example [Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack). The gate starts it and offers its tools as its own, so your coding tool only talks to `slm-gate`.
- **Brain model.** The larger of the two local models (`SLM_BRAIN_MODEL`). It folds the conversation memory, checks shortened skill text (the fidelity guard), answers `ask_elision` questions and settles open decisions.
- **Gate model.** The small, fast local model (`SLM_GATE_MODEL`). It shrinks tool output and rates the risk of an answer to an open decision.
- **Shrink.** What both gates do to large text: fixed rules first (a file keeps its outline, a log keeps its errors and last lines, a search keeps its first lines), then the gate model shortens plain prose that is still too long. Code, tables, headings, rule lines, paths and numbers are never changed.
- **Cut lines and `expand_elision`.** Lines the gate removed. The original is kept in the ledger, and the coding model can get the lines back with the `expand_elision` tool, or ask a question about them with `ask_elision` and get a few sentences from the brain model.
- **Fidelity guard.** With `DISTILL_SKILLS=on`, every shortened paragraph of a skill is checked by the brain model against the requirement sentences the code listed from the original. A paragraph that lost one goes out word for word, and that sentence is protected by code from then on.
- **Open decisions.** Questions a skill leaves open ("API-first or UI-first?"). The brain model lists them and answers each from a decision you wrote down once in `.slm-gate/decisions/`, from your code, or from common practice. Low-risk answers are added as decided; the rest are added as questions for you.
- **Ledger.** The local SQLite file both gates write to: one row per tool result and per model request, with token counts, the route taken and timings, never the text itself. `output/ledger.sqlite` in the settings folder: `~/.slm-gate` for an npm install, the checkout for git.
- **Usage window.** The rolling period a subscription plan meters (Claude: 5 hours). The savings cards turn tokens saved into minutes of that window, from the plan's estimated budget or a measured one. These minutes are estimates.
- **Profile.** A named set of lines `slm-gate init` writes on top of the template defaults: starter, proven or toolbox. Models and `NUM_CTX` never come from a profile; they come from your RAM.
