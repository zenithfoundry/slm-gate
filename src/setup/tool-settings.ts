/**
 * @fileoverview The exact setting that points each coding tool at the model gate, for `slm-gate doctor`
 * and the docs. Every address uses the configured port, so after changing LLM_GATE_PORT doctor prints the
 * lines to update. Facts checked against each tool's documentation on 2026-09-18.
 */

export interface ToolSetting {
  tool: string;
  /** Which login works through the gate. */
  login: string;
  lines: string[];
}

export function toolSettings(port: number): ToolSetting[] {
  const base = `http://localhost:${port}`;
  return [
    {
      tool: 'Claude Code (CLI and VS Code / JetBrains extension)',
      login: 'claude.ai Pro/Max login or API key',
      lines: [
        `~/.claude/settings.json:  { "env": { "ANTHROPIC_BASE_URL": "${base}" } }   (no /v1 at the end)`,
        `VS Code user settings:    "claudeCode.environmentVariables": [{ "name": "ANTHROPIC_BASE_URL", "value": "${base}" }]`,
      ],
    },
    {
      tool: 'Codex (CLI and IDE extension)',
      login: 'ChatGPT login or API key',
      lines: [
        '~/.codex/config.toml:',
        '  model_provider = "slm-gate"',
        '  [model_providers.slm-gate]',
        '  name = "slm-gate"',
        `  base_url = "${base}/v1"`,
        '  requires_openai_auth = true',
        '  (do not set supports_websockets: over WebSocket the gate cannot see the conversation)',
      ],
    },
    {
      tool: 'Gemini CLI',
      login: 'Gemini API key only',
      lines: [
        `export GOOGLE_GEMINI_BASE_URL=${base}`,
        'export GEMINI_API_KEY=<your key>',
        '~/.gemini/settings.json:  { "security": { "auth": { "selectedType": "gemini-api-key" } } }',
      ],
    },
    {
      tool: 'Antigravity CLI (agy)',
      login: 'Gemini API key only',
      lines: [
        '~/.gemini/antigravity-cli/settings.json:  { "modelProvider": "gemini" }',
        `export GOOGLE_GEMINI_BASE_URL=${base}`,
        'export GEMINI_API_KEY=<your key>',
      ],
    },
    {
      tool: 'OpenCode',
      login: 'API key',
      lines: [`opencode.json:  { "provider": { "anthropic": { "options": { "baseURL": "${base}/v1" } } } }`],
    },
    {
      tool: 'Cline / Roo Code (VS Code)',
      login: 'API key',
      lines: [`Settings > API Provider "Anthropic" > tick "Use custom base URL" > ${base}`],
    },
    {
      tool: 'Kilo Code (extension and CLI)',
      login: 'API key',
      lines: [`Custom provider, Provider API "Anthropic Messages", Base URL ${base}/v1   (CLI: kilo.jsonc provider.<id>.options.baseURL)`],
    },
    {
      tool: 'Continue (VS Code / JetBrains)',
      login: 'API key',
      lines: [`~/.continue/config.yaml model:  provider: anthropic, apiBase: ${base}/v1/   (OpenAI models: provider: openai, apiBase: ${base}/v1)`],
    },
    {
      tool: 'Zed',
      login: 'API key (entered in Agent Settings, not in settings.json)',
      lines: [`settings.json:  "language_models": { "anthropic": { "api_url": "${base}" } }`],
    },
    {
      tool: 'GitHub Copilot Chat (VS Code) Custom Endpoint',
      login: 'your own API key',
      lines: [
        `Chat > Manage Language Models > Add Models > Custom Endpoint: apiType "messages", url ${base}/v1/messages`,
        '(inline suggestions and semantic search keep using GitHub\'s own models)',
      ],
    },
    {
      tool: 'JetBrains Junie CLI',
      login: 'API key',
      lines: [`~/.junie/models/slm-gate.json:  { "id": "<model>", "baseUrl": "${base}/v1/messages", "apiType": "Anthropic", "apiKey": "<key>" }`],
    },
    {
      tool: 'Aider',
      login: 'API key',
      lines: [`ANTHROPIC_API_BASE=${base}   (OpenAI models: OPENAI_API_BASE=${base}/v1)`],
    },
  ];
}

/** Tools whose model requests cannot go through a local gate, and why. Their MCP connection still works. */
export const UNROUTABLE_TOOLS: { tool: string; reason: string }[] = [
  { tool: 'Cursor, Windsurf', reason: 'model requests go through the vendor\'s servers first, which cannot reach your machine' },
  { tool: 'Claude desktop app (chat and its Code tab), claude.ai', reason: 'no setting for the model address' },
  { tool: 'ChatGPT app/web, Gemini app/web', reason: 'no setting for the model address' },
  { tool: 'Gemini Code Assist extension, Antigravity IDE, Copilot\'s included models', reason: 'no setting for the model address' },
  { tool: 'Gemini CLI / agy with a Google-account login', reason: 'that login ignores the address setting, and Google\'s terms forbid using it through other tools' },
  { tool: 'Models bundled in a tool\'s own subscription (Cline, Kilo, Copilot, …)', reason: 'only your own API key can be pointed at the gate' },
];
