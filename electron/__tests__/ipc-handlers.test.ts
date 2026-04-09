import { describe, it, expect } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';

describe('ipc handlers', () => {
  it('returns a map of channel names to handler functions', () => {
    const handlers = getHandlerMap();
    expect(handlers).toBeDefined();
    expect(typeof handlers).toBe('object');
  });

  it('has handlers for core channels', () => {
    const handlers = getHandlerMap();
    const channels = Object.keys(handlers);
    expect(channels).toContain('list_accounts');
    expect(channels).toContain('resolve_account_for_project');
    expect(channels).toContain('list_projects');
    expect(channels).toContain('get_project_sessions');
  });

  it('all handler values are functions', () => {
    const handlers = getHandlerMap();
    for (const [, handler] of Object.entries(handlers)) {
      expect(typeof handler).toBe('function');
    }
  });
});
