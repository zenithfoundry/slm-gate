# Security Policy

## Supported versions

Security fixes land on `main`. There are no older release lines to patch.

## Reporting a vulnerability

Please report security problems privately, not in a public issue:
**[Report a vulnerability](https://github.com/zenithfoundry/slm-gate/security/advisories/new)**.

Include what you found, the steps to reproduce it, and what an attacker could do with it. The report and
the fix are handled in that private advisory, and the advisory is published once a fix is on `main`.

## What counts

`slm-gate` makes these promises. A way to break one is a vulnerability:

- **Only programs on this computer can reach the gate.** The model gate, and the MCP server in HTTP
  mode, accept connections from this machine only, and refuse web pages from other sites. See
  [Only Programs on This Computer](ARCHITECTURE.md#only-programs-on-this-computer).
- **Your login goes only where your tool would have sent it.** The model gate passes your coding tool's
  own subscription login or API key to that tool's provider unchanged, and holds no cloud credential of
  its own. See
  [Credentials and Billing](ARCHITECTURE.md#credentials-and-billing).
- **The published dashboard holds numbers only.** `pnpm run dashboard:export` writes counts, token sums,
  minutes and dates, never prompts, tool names or skill names.

Problems in the tools and models you connect (Ollama, your coding tool, a downstream MCP server) belong
with those projects.
