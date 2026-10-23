# Changelog

## [1.4.1](https://github.com/zenithfoundry/slm-gate/compare/v1.4.0...v1.4.1) (2026-10-23)


### Bug Fixes

* **deps:** bump @grpc/grpc-js from 1.14.4 to 1.14.6 ([714c0c5](https://github.com/zenithfoundry/slm-gate/commit/714c0c55becf757f9e0812bb91ef6dfd4a333689))
* **deps:** bump @grpc/grpc-js from 1.14.4 to 1.14.6 ([da20b86](https://github.com/zenithfoundry/slm-gate/commit/da20b8631217c32d746205c55c791c069288e919))
* **deps:** bump actions/configure-pages from 5.0.0 to 6.0.0 ([e3f0284](https://github.com/zenithfoundry/slm-gate/commit/e3f0284ef59778d29a28c9c44fc40742458e3189))
* **deps:** bump actions/setup-node from 7.0.0 to 7.1.0 ([3f0ec41](https://github.com/zenithfoundry/slm-gate/commit/3f0ec41fb273305adb4cfcb920a56480341a8bb7))
* **deps:** bump brace-expansion from 1.1.18 to 1.1.21 ([0b8c09e](https://github.com/zenithfoundry/slm-gate/commit/0b8c09eee18de4c457181a67065773840d7cd0c8))
* **deps:** bump hono from 4.13.9 to 4.13.13 ([a3f95ee](https://github.com/zenithfoundry/slm-gate/commit/a3f95ee0c6c0f973314107d2c114a121a11bf3ce))
* **deps:** bump ip-address from 10.5.0 to 10.7.4 ([09c9722](https://github.com/zenithfoundry/slm-gate/commit/09c97223e049ea3546b77bd2027c4f2023f797c2))
* **deps:** bump ip-address from 10.5.0 to 10.7.4 ([7f57b5a](https://github.com/zenithfoundry/slm-gate/commit/7f57b5aeac83ef3f3a625f710e084d7518ac14c0))
* **deps:** bump ossf/scorecard-action from 2.4.4 to 2.5.0 ([0e5c6e4](https://github.com/zenithfoundry/slm-gate/commit/0e5c6e45cde658ebbacb2ff70f52a90a02d59bf4))
* **deps:** bump proxy-addr from 2.0.7 to 2.0.8 ([42b0de1](https://github.com/zenithfoundry/slm-gate/commit/42b0de19a1a55849e2483643a55aa1633396965c))
* **deps:** bump the minor-and-patch group across 1 directory with 7 updates ([a38d591](https://github.com/zenithfoundry/slm-gate/commit/a38d59199f175051005feb1679dd1a2574737d95))
* **deps:** bump the minor-and-patch group across 1 directory with 7 updates ([8d3fa6b](https://github.com/zenithfoundry/slm-gate/commit/8d3fa6bbc97f622db4a4eb9595a7f8faaeacdcda))
* **deps:** bump undici from 8.10.0 to 8.11.2 ([a911669](https://github.com/zenithfoundry/slm-gate/commit/a911669eb9413f27aaf586a5c74df1f5d8111078))

## [1.4.0](https://github.com/zenithfoundry/slm-gate/compare/v1.3.0...v1.4.0) (2026-10-23)


### Features

* add backup file patterns to .gitignore to prevent accidental commits ([643e15f](https://github.com/zenithfoundry/slm-gate/commit/643e15ff8aa894d8dc7ea23b06137d37b9a9176e))
* enhance hedging lexicon and add tests for no-context replies ([8d4c53d](https://github.com/zenithfoundry/slm-gate/commit/8d4c53d6c9c6115896ae2b16ba6311cec33e42c0))
* enhance output logging and add 'unchanged' state to fidelity checks ([ebb32cf](https://github.com/zenithfoundry/slm-gate/commit/ebb32cf5aedb6e0b0ea3197774b86455a61f319e))
* **export:** handle absence of ledger by exporting zeros or computed data ([3c58ba2](https://github.com/zenithfoundry/slm-gate/commit/3c58ba224a623c5d3513e2d6eaa73aef378e2108))
* **gate:** remove first-message local answering (Step A) and the router bench ([4a3a9e6](https://github.com/zenithfoundry/slm-gate/commit/4a3a9e6398f2a5e74fd0aee5c37f5d4a34e7400d))
* local models do more — fidelity guard with learned protections, decision memory, repository index, ask_elision, per-turn routing data, model pinning ([8e4ed9e](https://github.com/zenithfoundry/slm-gate/commit/8e4ed9ee615802f733e2eb368e5eddc5d267eff1))
* local models do more — fidelity guard, decision memory, repo index, model pinning ([5d55ba2](https://github.com/zenithfoundry/slm-gate/commit/5d55ba22fd8f36a7e08f39e40029af5fba442706))
* **memory:** rolling conversation memory for the local steps ([7a905d1](https://github.com/zenithfoundry/slm-gate/commit/7a905d1b93c9817d5c19ea9300838a734f8227d9))
* **models:** update purposes for local models to clarify functionality ([0f9be31](https://github.com/zenithfoundry/slm-gate/commit/0f9be3106550d40b26dab62443934f42a7b09cdc))
* **resolver:** integrate decision memory and repo index evidence for enhanced resolution ([4b09089](https://github.com/zenithfoundry/slm-gate/commit/4b090896df087ec8f0a7864fb1a878f7095fce85))
* update local model configurations and introduce model pinning ([f289522](https://github.com/zenithfoundry/slm-gate/commit/f289522507ee56066a04590781dbeae49a5d5843))

## [1.3.0](https://github.com/zenithfoundry/slm-gate/compare/v1.2.2...v1.3.0) (2026-09-27)


### Features

* **setup:** AI setup prompt, slm-gate --version, and switching from a git checkout ([429c362](https://github.com/zenithfoundry/slm-gate/commit/429c3625e19a888342bc9a2cad610d5eac71a6ae))
* **setup:** connect-first tool pages, init points to the AI setup prompt, npm badges; fix setup errors in tool docs ([1095495](https://github.com/zenithfoundry/slm-gate/commit/1095495bf3d05c28a5cf33f5fbddaaff74b53e44))


### Bug Fixes

* **doctor:** skip the file check for a toolbox started by a command such as npx ([e9b548e](https://github.com/zenithfoundry/slm-gate/commit/e9b548ed9f07f48c7286283b3b9405e53c217cae))

## [1.2.2](https://github.com/zenithfoundry/slm-gate/compare/v1.2.1...v1.2.2) (2026-09-26)


### Bug Fixes

* **deps:** bump actions/setup-node from 4.4.0 to 7.0.0 ([2d473b9](https://github.com/zenithfoundry/slm-gate/commit/2d473b9266cd6e49184960ed1a39fbf9f3137cee))
* **deps:** bump actions/setup-node from 4.4.0 to 7.0.0 ([d54083a](https://github.com/zenithfoundry/slm-gate/commit/d54083a0b0360417f80d063f4a8990cf9f9eb578))
* **deps:** bump actions/upload-pages-artifact from 3.0.1 to 5.0.0 ([e891e1b](https://github.com/zenithfoundry/slm-gate/commit/e891e1b18fea748acc470121d68ce9a916dbdf26))
* **deps:** bump actions/upload-pages-artifact from 3.0.1 to 5.0.0 ([cec57e1](https://github.com/zenithfoundry/slm-gate/commit/cec57e18ed496cfe8a13822a72eb3e539b279d8c))
* **deps:** bump dotenv from 16.6.1 to 18.0.3 ([9217084](https://github.com/zenithfoundry/slm-gate/commit/92170849dcf09573fa17ed85da879bf8b1143f27))
* **deps:** bump pnpm/action-setup from 3.0.0 to 6.1.0 ([ecd63c5](https://github.com/zenithfoundry/slm-gate/commit/ecd63c5611a92d8ff5a0c67c2ff4ec74cb6cb1bf))
* **deps:** bump pnpm/action-setup from 3.0.0 to 6.1.0 ([1e8d7d3](https://github.com/zenithfoundry/slm-gate/commit/1e8d7d3dd8af654ea204f14ac89edd81fe3fe35f))

## [1.2.1](https://github.com/zenithfoundry/slm-gate/compare/v1.2.0...v1.2.1) (2026-09-26)


### Bug Fixes

* **deps:** bump the minor-and-patch group across 1 directory with 9 updates ([8e3ff27](https://github.com/zenithfoundry/slm-gate/commit/8e3ff27a5de16206a1cbbf797cf28dd477add478))
* **deps:** bump the minor-and-patch group across 1 directory with 9 updates ([df0e0fa](https://github.com/zenithfoundry/slm-gate/commit/df0e0fa334e3d12c4337ab22ef21136e5ef2f3b8))

## [1.2.0](https://github.com/zenithfoundry/slm-gate/compare/v1.1.0...v1.2.0) (2026-09-26)


### Features

* **cli:** add init and mcp commands for npm installs; accept the 64 and 128 GB RAM presets ([f85f958](https://github.com/zenithfoundry/slm-gate/commit/f85f958b8dab84835fa44a7e47e8e2bb98a9b4e1))
* **config:** RAM presets from 16 to 128 GB (new 48 GB), custom above 128 GB; drop under-16 GB; align docs, point to llmfit ([aceed2a](https://github.com/zenithfoundry/slm-gate/commit/aceed2a1e45133a4d056defd9a12fb3b0cf3ef27))

## [1.1.0](https://github.com/zenithfoundry/slm-gate/compare/v1.0.0...v1.1.0) (2026-09-26)


### Features

* **config:** keep settings and data in ~/.slm-gate for npm installs; give real-gate tests their own ports ([236f8f5](https://github.com/zenithfoundry/slm-gate/commit/236f8f57f5e76b4d17f03730feac6ce3df41b7f3))
* **config:** keep settings and data in ~/.slm-gate for npm installs; give real-gate tests their own ports ([32c0465](https://github.com/zenithfoundry/slm-gate/commit/32c04659f90ce7fff07277a6e17c87b147bc0824))

## 1.0.0 (2026-09-26)


### Features

* add agent column to events table and update cycle rate calculation to use provider-specific token metrics ([a117e5a](https://github.com/zenithfoundry/slm-gate/commit/a117e5a213e0d50d5f88ecd89195788de840dd5f))
* add cycle window extension metrics to report, sync, and dashboard configuration ([6f5d3b6](https://github.com/zenithfoundry/slm-gate/commit/6f5d3b64cdd40f38020a07c38546c43abb52d8e0))
* add cycle_minutes_saved metrics for ChatGPT, Claude, and Gemini to sync configuration ([ae5756e](https://github.com/zenithfoundry/slm-gate/commit/ae5756edc9c650fdb2f19390877ac33996e4f6bf))
* add desktop notifications for slm-gate issues and implement startup checks ([c936a93](https://github.com/zenithfoundry/slm-gate/commit/c936a937df624615ddae2c5ba5a734f88aeef8fe))
* add Google Gemini support and improve dynamic API URL path construction ([70d3b3d](https://github.com/zenithfoundry/slm-gate/commit/70d3b3d9f21137d973d05373555d65cbd0b1bc95))
* add Langfuse synchronization and local ledger reset utilities to CLI ([74d4c4b](https://github.com/zenithfoundry/slm-gate/commit/74d4c4bcfb5f58f52f07fa4630632c5a185c7d65))
* add OLLAMA_KEEP_ALIVE configuration to control model memory duration ([c9b2afe](https://github.com/zenithfoundry/slm-gate/commit/c9b2afe20a9e8c09ba39090df0df30f6d90537eb))
* add prompt caching support to Anthropic system, tool, and message formats ([a143e50](https://github.com/zenithfoundry/slm-gate/commit/a143e5006a25b77666811b6817cd9d138efa05e1))
* add PROVIDER configuration and improve ledger sync logging, error handling, and provider attribution logic. ([0f34436](https://github.com/zenithfoundry/slm-gate/commit/0f3443616f775501fe545384f1cb214cdc3eb30c))
* add provider tracking to ledger events with schema migration and utility functions for analytics ([de740ac](https://github.com/zenithfoundry/slm-gate/commit/de740ac5be368537dfd27e77cc7c903e670c178d))
* add RAM-preset configuration templates and expand documentation for LLM-gate deployment. add cli and docs ([8b7ad06](https://github.com/zenithfoundry/slm-gate/commit/8b7ad067b841638dfb9359d5aef138f1255e2450))
* add reporting and verification for local ledger against Langfuse ([e8c4ccc](https://github.com/zenithfoundry/slm-gate/commit/e8c4ccc659f68c9c16807bed8d12eb51c9ef94e8))
* add SLM_GATE_TESTING_MODEL config to support specialized benchmarking models ([ced6b05](https://github.com/zenithfoundry/slm-gate/commit/ced6b0527046fea5f9b48356759243dcd3213669))
* add spike passthrough proxy and llm-gate forwarding logic ([61ced9f](https://github.com/zenithfoundry/slm-gate/commit/61ced9f3ba5185455d91798ae63d92bfeec1ad36))
* add test:summary script to package.json for concise test output fix tests ([0a934d6](https://github.com/zenithfoundry/slm-gate/commit/0a934d61293af3953bc71fac0838b87d8e76a22f))
* add TLS downstream E2E test and refactor Langfuse integration to use direct SDK client ([6bb566f](https://github.com/zenithfoundry/slm-gate/commit/6bb566f7b3eeb0c678c0fbbffe46ac649b0f3e6d))
* add transient problem handling to startup checks and model gate notifications ([6b5c46b](https://github.com/zenithfoundry/slm-gate/commit/6b5c46b57979a48c1cc40dc132ff1564c6063326))
* **dashboard:** add static site export and local server for metrics dashboard ([c6cab0b](https://github.com/zenithfoundry/slm-gate/commit/c6cab0bb74c7feec328b3ce2340b7746d943091e))
* **dashboard:** enhance widget placement logic and add verification for persisted placements ([cc9e4dd](https://github.com/zenithfoundry/slm-gate/commit/cc9e4ddd301247feb4a04acf3f5b3b3785714468))
* **dashboard:** update README and add dashboard publish script ([df6a176](https://github.com/zenithfoundry/slm-gate/commit/df6a176bbc3f84d2f394088ff4264f0a27e78435))
* **docs:** enhance README with detailed visual explanations and diagrams ([4428427](https://github.com/zenithfoundry/slm-gate/commit/44284271775cdb344aacc8b21d5c45ad05c0a265))
* **docs:** update README to clarify MCP and model gate functionalities ([5bad707](https://github.com/zenithfoundry/slm-gate/commit/5bad707b1ed941468ffca4a2c486ac84f7de4822))
* **doctor:** apple-silicon-aware hardware checks + fallback config ([b58489f](https://github.com/zenithfoundry/slm-gate/commit/b58489f8cb2d0ca402fd9975379dbc115ebd27f5))
* enforce local-only access for slm-gate and mcp-gate servers ([998dee7](https://github.com/zenithfoundry/slm-gate/commit/998dee77085c206800cc5e77866e89dc3629e7fa))
* enforce Native Structured Outputs across all model interactions to improve stability and reliability ([005e4ab](https://github.com/zenithfoundry/slm-gate/commit/005e4ab501d9bcb0a0d3dd1692bd770589106b21))
* enhance CI workflow with better-sqlite3 verification and update package engines ([61ab38b](https://github.com/zenithfoundry/slm-gate/commit/61ab38b00c97e3c49ccca518de15fe39b09e553d))
* enhance Ollama probing with detailed error handling and testing scenarios ([353bf5e](https://github.com/zenithfoundry/slm-gate/commit/353bf5ed10366351555721a6b005f4002347e9c1))
* enhance telemetry transport with environment tagging and implement shared exponential backoff for retries ([6efdae8](https://github.com/zenithfoundry/slm-gate/commit/6efdae879b676d28dd5bbdc0abc3159c4c4b51b0))
* enhance toolbox result handling to preserve all content while conditioning only text ([07d9f5a](https://github.com/zenithfoundry/slm-gate/commit/07d9f5a5d78e93e09a77fe82d5650fd084d13c02))
* implement adaptive distillation feedback loop with semantic embedding support and user-configurable preservation patterns ([b5cd027](https://github.com/zenithfoundry/slm-gate/commit/b5cd02710279bed1080534ee973e92ee57534b1e))
* implement ambiguity resolution pipeline with decision extraction, evidence-based reasoning, and risk-aware gating ([7ccde4c](https://github.com/zenithfoundry/slm-gate/commit/7ccde4c7de3c1bc00f582c85d18908e37f948b60))
* implement dynamic ledger path creation for E2E tests and improve environment variable handling ([61ab38b](https://github.com/zenithfoundry/slm-gate/commit/61ab38b00c97e3c49ccca518de15fe39b09e553d))
* implement exponential backoff with jitter for network/rate-limit errors and update classification prompt and test harness logging ([c72ad01](https://github.com/zenithfoundry/slm-gate/commit/c72ad01f447afdbce600b16c75298d37272f9df6))
* implement MCP gateway server with proxy capabilities and prompt conditioning pipeline ([1c8f74b](https://github.com/zenithfoundry/slm-gate/commit/1c8f74b664cc5d83645809ce68c98d48824f4109))
* implement monotonic SLM response verification logic and add unit tests ([8f3678f](https://github.com/zenithfoundry/slm-gate/commit/8f3678f3463a394c1dd0084e2a2072174060dea7))
* implement native LLM gateway server with request routing, multi-format proxying, and SLM integration. ([52cea7e](https://github.com/zenithfoundry/slm-gate/commit/52cea7e49b4aaaead64d82d130ad151ea0abb1d4))
* implement persistent Langfuse queue with sync utility and telemetry metrics support ([7bc4c49](https://github.com/zenithfoundry/slm-gate/commit/7bc4c497106182d460d5d47f36bb0ed1360402d8))
* implement semantic caching for LLM responses using vector embeddings and file context verification ([25e62a1](https://github.com/zenithfoundry/slm-gate/commit/25e62a1657bc5f23a08e0cc86c7df6bbd620e39e))
* implement SLM integration with Ollama/OpenAI support, self-consistency reasoning, and classification utilities. ([64c7720](https://github.com/zenithfoundry/slm-gate/commit/64c7720db2dbf032dfddad4483cb6fec1fe599a3))
* implement sqlite-based event ledger with langfuse mirroring and cost calculation logic ([ffe2186](https://github.com/zenithfoundry/slm-gate/commit/ffe2186deef94965880dc1e5fb9796407ccc837a))
* implement stranded server detection and cleanup for MCP servers ([7505c0f](https://github.com/zenithfoundry/slm-gate/commit/7505c0fde5c4a4607d0d398475f11abdeb2c6c6f))
* implement subscription-based plan management for token rate limiting and update configuration examples. ([bab2d4b](https://github.com/zenithfoundry/slm-gate/commit/bab2d4ba7d5d4b08be22e11367f9e6f912ba6f16))
* implement text distillation module with configurable pattern preservation for model optimization ([4cb170d](https://github.com/zenithfoundry/slm-gate/commit/4cb170dd63d78a09fb9244d91265cde4329a8ea0))
* implement TLS analytics mapping and downstream configuration in tech-lead-stack adapter ([d2293dc](https://github.com/zenithfoundry/slm-gate/commit/d2293dc9906bdccdc7b138111cf60f7e03e7b4ad))
* initialize project structure with core gate middleware, configuration management, and architecture documentation ([093d1c1](https://github.com/zenithfoundry/slm-gate/commit/093d1c1c79acb834c5eab5e000b6347381bc4fdb))
* introduce E2E test suite for ambiguity resolution and standalone MCP, and add logging to SLM client initialization and request pipelines. ([de0b762](https://github.com/zenithfoundry/slm-gate/commit/de0b7628a770ca569efeb4552b22eee21fe31f71))
* introduce preservation patterns for SLM contextual compression ([fdb584a](https://github.com/zenithfoundry/slm-gate/commit/fdb584a7d4d56c7fa0c41305e2e570148f67bc5f))
* **llm-gate:** implement local-first request handling and response logging ([ea05b74](https://github.com/zenithfoundry/slm-gate/commit/ea05b741fbdd09bd5db1e3f1563014a535ba0a9b))
* **pricing:** update model pricing and introduce provider registry ([7251b92](https://github.com/zenithfoundry/slm-gate/commit/7251b925303749802d7b0d45ea5feb52bfbaba54))
* support Anthropic-style API authentication and URL formatting in doctor check ([a474cda](https://github.com/zenithfoundry/slm-gate/commit/a474cda6a39da3a9384f3edc07b18ce01350d1ae))
* **tests:** reorganize imports and enhance cycle metrics tests with additional utility functions ([98d8927](https://github.com/zenithfoundry/slm-gate/commit/98d8927d4f32dd460d8455695ac88a38c622858a))
* update preserve token format to brackets and add robust fallback restoration logic ([62611fb](https://github.com/zenithfoundry/slm-gate/commit/62611fbd1be02d57ac2d691d4d81a0771aab662c))


### Bug Fixes

* ensure ledger directory exists and explicitly handle nulls for optional sqlite parameters ([df9b746](https://github.com/zenithfoundry/slm-gate/commit/df9b74676908a33e4ff6026de57a1d649ed92f45))
* ensure narrative runs are processed through a bounded pool in distillation ([61ab38b](https://github.com/zenithfoundry/slm-gate/commit/61ab38b00c97e3c49ccca518de15fe39b09e553d))
* installation, ledger path and conditioning-quality fixes, with Node 22 floor and dependency updates ([27bdfb0](https://github.com/zenithfoundry/slm-gate/commit/27bdfb00addd159743915e485e15f5ccef1a9a72))
* **security:** restrict spike proxy to gate routes and this computer ([b773fcd](https://github.com/zenithfoundry/slm-gate/commit/b773fcd98e7212ee85a8d4b6027e453bf8b8bc21))
* treat all pipeline errors as soft failures and update E2E assertions to handle resolver timeouts ([554ace5](https://github.com/zenithfoundry/slm-gate/commit/554ace5e1cd1fc328d6ba0abdb893b88e6588ce6))
