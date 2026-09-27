import { describe, expect, it } from '@jest/globals';
import { downstreamScript } from '../../src/setup/downstream-script.js';

describe('downstreamScript', () => {
  it.each([
    [['-y', 'tech-lead-stack@1']],
    [['-y', '@zenithfoundry/some-toolbox@1']],
    [['some-mcp-server']],
    [[]],
  ])('finds no file for a toolbox started by a command (%j), so doctor does not report a false failure', args => {
    expect(downstreamScript(args)).toBeNull();
  });

  it.each([
    [['/Users/me/tech-lead-stack/dist/mcp-server.mjs'], '/Users/me/tech-lead-stack/dist/mcp-server.mjs'],
    [['./server.js'], './server.js'],
    [['../toolbox/server.cjs'], '../toolbox/server.cjs'],
    [['~/toolbox/server.ts'], '~/toolbox/server.ts'],
    [['server.mjs'], 'server.mjs'],
    [['--import', 'tsx', '/Users/me/toolbox/server.ts'], '/Users/me/toolbox/server.ts'],
  ])('finds the file of a toolbox started from one (%j)', (args, file) => {
    expect(downstreamScript(args)).toBe(file);
  });
});
