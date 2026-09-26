# Support

## Getting help

- **Questions and ideas:** [GitHub Discussions](https://github.com/zenithfoundry/slm-gate/discussions).
- **Bugs and feature requests:** [open an issue](https://github.com/zenithfoundry/slm-gate/issues/new/choose) from
  one of the templates. For a bug, include the output of `node dist/cli.js doctor`; it checks Ollama, your models
  and the model gate.
- **Security problems:** do not open an issue. Report them privately, as the [security policy](SECURITY.md) describes.

Responses are best effort.

## What is supported

- **The latest [release](https://github.com/zenithfoundry/slm-gate/releases) and `main`.** Fixes, security fixes
  included, land on `main` and ship in the next release. Older releases are not patched: a release is supported
  until the next one is published.
- **Installing from npm** ([Install from npm](docs/install-from-npm.md)) **or from git** ([Quick Start](README.md#quick-start)),
  on macOS or Linux with 16 GB of RAM or more.

Problems in the tools and models you connect (Ollama, your coding tool, a downstream MCP server) belong with those
projects.
