import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { parseMcpServerErrors, latestMcpServerErrors } from '../mcpServerErrors';

/**
 * A system:init node. `mcp_server_errors` shape verified against a live
 * `--output-format stream-json` run with a deliberately malformed
 * `--mcp-config`.
 */
function sysInit(errors?: unknown, sessionId = 'sess-1'): JsonlNode {
  return {
    kind: 'cli-stream-init',
    raw: {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      sessionId,
      ...(errors === undefined ? {} : { mcp_server_errors: errors }),
    } as never,
    sessionId,
    receivedAt: '2026-08-05T00:00:00Z',
  };
}

function assistant(): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    receivedAt: '2026-08-05T00:00:00Z',
    raw: { type: 'assistant', message: { content: [] } },
  } as unknown as JsonlNode;
}

const REAL = [
  {
    name: 'missing_command',
    type: 'invalid_config',
    message:
      'Skipped — invalid MCP server config for "missing_command": command: expected string, received undefined',
  },
  {
    name: 'bad_type',
    type: 'unknown_type',
    message: 'Skipped — unknown MCP server type "nonsense" for server "bad_type"',
  },
];

describe('parseMcpServerErrors', () => {
  it('passes through well-formed entries', () => {
    expect(parseMcpServerErrors(REAL)).toEqual(REAL);
  });

  it('returns null for the empty cases', () => {
    // The field ships as `null` on the overwhelming majority of inits. An
    // empty array would make callers render a "0 servers skipped" banner.
    expect(parseMcpServerErrors(null)).toBeNull();
    expect(parseMcpServerErrors(undefined)).toBeNull();
    expect(parseMcpServerErrors([])).toBeNull();
    expect(parseMcpServerErrors('nope')).toBeNull();
  });

  it('drops entries with no usable name', () => {
    // The name is what identifies the server to the user; without it the row
    // says nothing actionable.
    expect(
      parseMcpServerErrors([
        { name: 'ok', type: 'invalid_config', message: 'bad config' },
        { type: 'invalid_config', message: 'no name' },
        { name: '', type: 'invalid_config', message: 'empty name' },
        'not an object',
        null,
      ]),
    ).toEqual([{ name: 'ok', type: 'invalid_config', message: 'bad config' }]);
  });

  it('defaults a missing type and message rather than dropping the entry', () => {
    expect(parseMcpServerErrors([{ name: 'x' }])).toEqual([
      { name: 'x', type: 'unknown', message: '' },
    ]);
  });

  it('returns null when every entry is malformed', () => {
    expect(parseMcpServerErrors([{ type: 'invalid_config' }, 7])).toBeNull();
  });
});

describe('latestMcpServerErrors', () => {
  it('finds the errors on the session\'s init node', () => {
    expect(latestMcpServerErrors([sysInit(REAL), assistant()])).toEqual(REAL);
  });

  it('returns null when there is no init node at all', () => {
    // Replayed sessions have no init: the CLI never persists it to the
    // session JSONL, so it only exists on a live stream.
    expect(latestMcpServerErrors([assistant()])).toBeNull();
    expect(latestMcpServerErrors([])).toBeNull();
  });

  it('returns null when the init carries no errors', () => {
    expect(latestMcpServerErrors([sysInit()])).toBeNull();
    expect(latestMcpServerErrors([sysInit(null)])).toBeNull();
  });

  it('prefers the LAST init — a rebind may have fixed the config', () => {
    const messages = [sysInit(REAL), assistant(), sysInit(null, 'sess-2')];
    expect(latestMcpServerErrors(messages)).toBeNull();
  });

  it('reports the last init\'s errors even when an earlier init was clean', () => {
    const later = [{ name: 'newly_broken', type: 'invalid_config', message: 'nope' }];
    const messages = [sysInit(null), assistant(), sysInit(later, 'sess-2')];
    expect(latestMcpServerErrors(messages)).toEqual(later);
  });
});
