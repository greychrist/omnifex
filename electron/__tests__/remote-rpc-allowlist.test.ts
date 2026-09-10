import { describe, it, expect } from 'vitest';

import { INVOKE_CHANNELS } from '../ipc/channels';
import {
  buildRpcAllowlist,
  ELECTRON_ONLY_CHANNELS,
  TYPED_SESSION_CHANNELS,
  RAW_DATABASE_CHANNELS,
} from '../remote/rpc-allowlist';

describe('rpc allowlist', () => {
  const allow = buildRpcAllowlist(INVOKE_CHANNELS);

  it('starts from the renderer allow-list minus the three denied groups', () => {
    for (const ch of [...ELECTRON_ONLY_CHANNELS, ...TYPED_SESSION_CHANNELS, ...RAW_DATABASE_CHANNELS]) {
      expect(allow.has(ch), ch).toBe(false);
    }
    // A representative of each family that must still work remotely.
    for (const ch of ['list_accounts', 'list_projects', 'session_set_model', 'session_get_health', 'brain_search', 'session_cost_totals', 'storage_read_table']) {
      expect(allow.has(ch), ch).toBe(true);
    }
  });

  it('never invents a channel: everything allowed is a real invoke channel', () => {
    for (const ch of allow) expect(INVOKE_CHANNELS).toContain(ch);
  });

  it('every denied channel names something that actually exists — the lists cannot rot silently', () => {
    for (const ch of [...ELECTRON_ONLY_CHANNELS, ...TYPED_SESSION_CHANNELS, ...RAW_DATABASE_CHANNELS]) {
      expect(INVOKE_CHANNELS, ch).toContain(ch);
    }
  });

  it('applies user overrides, with an explicit deny beating an explicit allow', () => {
    const custom = buildRpcAllowlist(INVOKE_CHANNELS, {
      allow: ['storage_execute_sql', 'brain_search'],
      deny: ['brain_search', 'list_accounts'],
    });
    expect(custom.has('storage_execute_sql')).toBe(true);
    expect(custom.has('brain_search')).toBe(false);
    expect(custom.has('list_accounts')).toBe(false);
  });
});
