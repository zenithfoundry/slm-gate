import { jest } from '@jest/globals';
import { CallToolRequestSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

// Mock config
jest.unstable_mockModule('../../src/config.js', () => ({
  CONFIG: {
    DOWNSTREAM_MCP: { command: 'echo' },
    MCP_GATE_TRANSPORT: 'stdio'
  }
}));

// Mock pipeline
jest.unstable_mockModule('../../src/mcp-gate/pipeline.js', () => ({
  conditionPrompt: jest.fn(async (text: string, task: string, rootUri?: string, toolName?: string, args?: any) => {
    // Mock conditioning that adds Open questions and preserves MUST
    return text.replace('Long boring text', '') + '\n\n## Open questions\n- Question 1';
  })
}));

// Mock sdk client. The gate asks the toolbox for its tool list when it starts, so every
// tools/list request answers with the fake toolbox's tools; tests queue tools/call results.
const toolboxTools = [{ name: 'get_skill', inputSchema: { type: 'object' } }];
const mockRequest = jest.fn<(...args: any[]) => Promise<any>>();
const answerToolsList = () => mockRequest.mockImplementation(async (req: any) =>
  req.method === 'tools/list' ? { tools: toolboxTools } : undefined
);
jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(),
    request: mockRequest,
    getInstructions: () => 'Toolbox says hello.'
  }))
}));

const { conditionPrompt } = await import('../../src/mcp-gate/pipeline.js');
const { createServer } = await import('../../src/mcp-gate/server.js');
const { CONFIG } = await import('../../src/config.js');

describe('mcp-gate server (proxy mode)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    answerToolsList();
  });

  const callToolHandler = (server: any) => {
    const handler = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    if (!handler) throw new Error("Handler not registered");
    return handler;
  };

  it('intercepts get_skill, conditions RESULT text, and returns shorter output with MUST and Open questions', async () => {
    const { server } = await createServer();

    // Simulate fake downstream returning the original skill in RESULT
    const originalText = `Long boring text\nYou MUST do this.\nEnd of skill`;
    mockRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: originalText }]
    });

    const req = {
      method: 'tools/call',
      params: {
        name: 'get_skill',
        arguments: { task: 'test task' }
      }
    };

    // Trigger the handler directly since we mocked the server
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    if (!handler) throw new Error("Handler not registered");

    const result = await handler(req as any, {} as any);

    expect(mockRequest).toHaveBeenCalledWith({
      method: "tools/call",
      params: req.params
    }, CallToolResultSchema);

    expect(conditionPrompt).toHaveBeenCalledWith(originalText, 'test task', undefined, 'get_skill', { task: 'test task' });

    const conditionedText = result.content[0].text;
    expect(conditionedText.length).toBeLessThan(originalText.length + 30); // account for Open questions
    expect(conditionedText).toContain('You MUST do this.');
    expect(conditionedText).toContain('## Open questions');
    expect(conditionedText).not.toContain('Long boring text');
  });

  it("tells the editor which toolbox tools it serves, including the toolbox's own instructions", async () => {
    const { server } = await createServer();
    const instructions = (server as any)._instructions as string;
    expect(instructions).toContain('get_skill');
    expect(instructions).toContain('Toolbox says hello.');
  });

  it("rewrites the toolbox's own tool names in results so they resolve to slm-gate", async () => {
    const { server } = await createServer();
    mockRequest.mockResolvedValueOnce({
      content: [{ type: "text", text: 'Next, call `mcp__tech-lead-stack__get_skill`.' }]
    });
    const result = await callToolHandler(server)(
      { method: 'tools/call', params: { name: 'get_skill', arguments: { task: 't' } } } as any,
      {} as any
    );
    expect(result.content[0].text).toContain('`mcp__slm-gate__get_skill`');
    expect(result.content[0].text).not.toContain('mcp__tech-lead-stack__');
  });
});
