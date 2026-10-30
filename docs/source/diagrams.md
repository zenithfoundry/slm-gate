# Diagrams

How the repository's diagrams are authored and regenerated.

The diagrams in these docs are authored with [archify](https://github.com/tt-a1i/archify), which turns a
JSON description into an explorable standalone HTML page (nodes expand, paths can be traced) and checks it: every
node's `sources` must point at files and line ranges that exist in this repository at the commit the source pins
(`meta.repository.revision`), and the layout must pass its readability gates. It is a dev dependency only
(`archify` in `devDependencies`, pinned to the `v3.2.0` git tag) and is never shipped in the npm package.

- **Sources** live in `diagrams/`, one file per diagram, named `<slug>.<type>.json`.
- **Renders** live in `docs/diagrams/`: `<slug>.html` (the explorable page) and `<slug>.png` (the still image
  the pages embed, since GitHub cannot render the HTML inline). Both are checked in.
- **Regenerate** every render after changing a source, or one by naming its slug:

  ```bash
  pnpm run diagrams
  pnpm run diagrams request-path
  ```

  `scripts/diagrams.mjs` runs `archify finalize` for each source, copies the HTML, and screenshots it with a
  headless Chrome, Chromium or Edge (set `ARCHIFY_CHROME` when none is found). A failed check prints archify's
  receipt and stops; build evidence goes to `.archify/` (ignored by git).

| Diagram | Type | Embedded in | Shows |
| :--- | :--- | :--- | :--- |
| `request-path` | architecture | [README](../../README.md#how-it-works) | A tool call through the MCP gate and a model request through the model gate |
| `where-the-data-goes` | dataflow | [README](../../README.md#how-it-works) | Both gates write the ledger; metrics, the dashboard, the published copy and Langfuse read it |
| `tool-call` | sequence | [How it works](../reference/how-it-works.md#what-happens-to-a-tool-call-mcp-gate) | One tool call, step by step |
| `model-request` | sequence | [How it works](../reference/how-it-works.md#what-happens-to-a-model-request-model-gate) | One model request, step by step, and the memory fold |
| `startup` | workflow | [How it works](../reference/how-it-works.md#how-it-starts-and-what-the-cli-does) | The start-up checks, Ollama, the model gate, notifications and the CLI |
| `ledger-modules` | architecture | [Architecture](../../ARCHITECTURE.md) | The modules of `src/ledger/` and `src/langfuse/`, what each keeps and who reads it |

When the behaviour changes, edit the source, re-render, and look at the PNG before committing. Each source pins
the commit its evidence was checked against (`meta.repository.revision`); when the code it cites moves, update
the line ranges and the pinned revision together, and take the line numbers from `git show <revision>:<path>`,
not from the working tree.

---

Next: [How it works](../reference/how-it-works.md)
