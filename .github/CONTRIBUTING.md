# Contributing to small-language-model-gate

Thank you for your interest in contributing! This project provides a local-SLM pre-processing and routing layer designed to cut token costs and protect cloud quotas.

## Core Invariants & Architectural Rules

Before opening a pull request, please review these essential guidelines:

1. **Native Structured Outputs**: Always use deterministic JSON Schemas (`zod` + `zod-to-json-schema` or native structured outputs) for model routing, verification, and classification decisions. Never use markdown regex parsing.
2. **stdio Invariant**: In any stdio MCP path, never write to `process.stdout` (it corrupts the JSON-RPC wire). Route all logging to `stderr`.
3. **Decoupling**: Tech-Lead-Stack (TLS) adapter logic lives strictly behind `src/adapters/tech-lead-stack.ts` and dynamic imports. `pnpm run test:decoupling` must always pass.
4. **Provider-Agnostic**: Never hardcode model tags or endpoint URLs; read them from configuration via `src/config.ts`.
5. **Pure & Mockable**: Inject dependencies (e.g. SLM client, filesystem readers) so unit tests run cleanly without live model calls or network access.
6. **Tests with every change**: New functionality and bug fixes come with tests under `tests/`, which `pnpm test` and CI run.

## Development Workflow

1. **Install dependencies**:
   ```bash
   pnpm install
   ```

2. **Build and Typecheck**:
   ```bash
   pnpm run build
   ```

3. **Run Unit Tests**:
   ```bash
   pnpm test
   ```

4. **Verify Decoupling**:
   ```bash
   pnpm run test:decoupling
   ```

5. **Commit Message Format**:
   Follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat(distill): ...`, `fix(router): ...`, `docs: ...`).
