// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Same fake-child pattern as claude-cli-engine-origin.test.ts, with stdout
// kept so the test can play the CLI's side.
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void; pid: number };
function fakeChild() {
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {}, pid: 4242,
  });
  setImmediate(() => child.emit('spawn'));
  return child;
}

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => fakeChild()) }));

import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';

// sessions/queries.ts getPlugins lists plugins from this instead of sending
// reload_plugins, which re-runs every mod's session.start.
describe('ClaudeCliEngine — init data', () => {
  it('keeps system:init plugins, built-ins included', async () => {
    const engine = createClaudeCliEngine({ tabId: 't1', claudeBinaryPath: '/bin/claude' });
    await engine.start({ projectPath: '/tmp/p', configDir: '/tmp/cfg', sessionId: '11111111-2222-4333-8444-555555555555', resume: false });
    const plugins = [
      { name: 'superpowers', path: '/c/plugins/superpowers', source: 'superpowers@official' },
      { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
    ];
    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', plugins })}\n`);
    await vi.waitFor(() => { expect(engine.getInitData()?.plugins).toEqual(plugins); });
  });
});
