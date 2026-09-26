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

6. **Open a Pull Request**:
   Work on a branch and open a pull request against `main`; `main` accepts changes through pull requests. CI and CodeQL run on every pull request.

## Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please) (`.github/workflows/release.yml`). It reads the commit messages on `main` and keeps a release pull request open with the next version and its `CHANGELOG.md` entry. Versions follow [Semantic Versioning](https://semver.org/), decided by the commit types:

- `fix:` releases a patch (`1.0.0` → `1.0.1`).
- `feat:` releases a minor version (`1.0.0` → `1.1.0`).
- `!` after the type (`feat!:`), or a `BREAKING CHANGE:` footer, releases a major version (`1.0.0` → `2.0.0`).
- `docs:`, `test:`, `chore:` and similar types alone do not make a release.

Merging the release pull request tags `vX.Y.Z`, publishes the GitHub Release with those notes, and attaches the package tarball, an SPDX SBOM and a signed provenance bundle. Release tags cannot be moved or deleted.

A security fix names its advisory in the commit message, e.g. `fix(router): reject absolute-form targets (GHSA-xxxx-xxxx-xxxx)`, so the release notes list it.
