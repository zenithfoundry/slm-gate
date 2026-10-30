# Profiles

The three settings profiles `slm-gate init` offers, what each turns on, and how to switch.

A [profile](../README.md#glossary) is a few lines `init` sets on top of the template defaults. The local models
and `NUM_CTX` never come from a profile: they always come from your RAM
([Hardware](../reference/hardware.md#ram-by-machine-model-table)). Every other setting is explained in
[Settings](../reference/settings.md) and can be changed in any profile.

```bash
slm-gate init --profile starter    # the default
slm-gate init --profile proven
slm-gate init --profile toolbox
```

| | **starter** | **proven** | **toolbox** |
| :--- | :--- | :--- | :--- |
| What it is | the template as shipped | the maintainer's daily settings | proven, with Tech-Lead-Stack behind the gate |
| Tool results shrunk in both gates | yes | yes | yes |
| Conversation memory | on | on | on |
| Both local models kept loaded | yes | yes | yes |
| Skill text shortened under the fidelity guard (`DISTILL_SKILLS`) | off | on | on |
| Repository index and the `find_existing` tool (`REPO_INDEX`) | off | on | on |
| Brain runs per common-practice answer (`SELF_CONSISTENCY_K`) | 3 | 1 | 1 |
| Toolbox (`DOWNSTREAM_MCP`) | none | none | `tech-lead-stack@1` from npx, `TLS_ADAPTER=on`, `DISTILL_PRESERVE_PATH=configs/preserve/tls.json` |
| Third local model needed | no | no | no |

**starter** shrinks tool results in both gates and remembers each conversation. Skills (your toolbox's
instructions) go out word for word, cut at the ends with a marker when too long. Choose it when you want the
smallest setup, or your toolbox's skills must never be reworded.

**proven** adds the local work that earns the most: skill text is shortened too, under the
[fidelity guard](../README.md#glossary) (a few seconds more the first time a skill is used, cached after); the
gate keeps a small index of your code so the AI can check what exists before writing something new; and
[open decisions](../README.md#glossary) answered from common practice ask the brain model once instead of three
times. The dashboard's fidelity card tells you what shortening skills cost.

**toolbox** is proven with [Tech-Lead-Stack](https://github.com/bronz3beard/ai.tech-lead-stack) behind the
MCP gate, run from npm. If your toolbox runs from a checkout instead, edit `DOWNSTREAM_MCP` afterwards
([Connect a toolbox](install.md#connect-a-toolbox)).

## See the lines before writing

```bash
slm-gate init --show --profile proven
slm-gate init --show --profile toolbox --ram 64 --provider claude
```

`--show` prints every line `init` would set (the RAM lines, the profile's, and `PROVIDER`) and writes nothing.

## Switch profiles

`init` never replaces a settings file that exists, so switching means editing the lines above in
`~/.slm-gate/.env`. The quickest way is to print them with `--show` and copy them in. Then:

```bash
slm-gate restart
```

Nothing else changes, and nothing in the ledger is lost. With `DISTILL_SKILLS=off`, the fidelity settings,
`MAX_CONCURRENT_SEGMENT_CALLS` and `RESOLVER_PROMPT_TOKENS` are read but have nothing to do.

Optional with proven or toolbox: write decisions down once per repository in `.slm-gate/decisions/`
([Daily use](daily-use.md#decision-memory-answer-a-question-once-per-repository)).

---

Next: [Connect your tool](connect-your-tool.md)
