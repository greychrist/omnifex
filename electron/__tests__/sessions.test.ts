import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAsyncChannel } from '../services/async-channel';
import { createSessionsService, type SessionsService } from '../services/sessions';

// Mock the SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

describe('async channel', () => {
  it('push and pull values in order', async () => {
    const ch = createAsyncChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('waits for pushed values', async () => {
    const ch = createAsyncChannel<string>();

    const promise = (async () => {
      const values: string[] = [];
      for await (const v of ch) {
        values.push(v);
      }
      return values;
    })();

    ch.push('a');
    ch.push('b');
    ch.close();

    const values = await promise;
    expect(values).toEqual(['a', 'b']);
  });

  it('ignores pushes after close', () => {
    const ch = createAsyncChannel<number>();
    ch.close();
    ch.push(1); // should not throw
  });
});

describe('sessions service', () => {
  let service: SessionsService;
  let mockSendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSendToRenderer = vi.fn();
    service = createSessionsService(mockSendToRenderer as any);
  });

  it('isActive returns false for unknown tab', () => {
    expect(service.isActive('unknown')).toBe(false);
  });

  it('getStatus returns stopped for unknown tab', () => {
    expect(service.getStatus('unknown')).toBe('stopped');
  });

  it('getSessionId returns null for unknown tab', () => {
    expect(service.getSessionId('unknown')).toBeNull();
  });

  it('getInfo returns null for unknown tab', () => {
    expect(service.getInfo('unknown')).toBeNull();
  });

  it('respondPermission does nothing for unknown tab', () => {
    service.respondPermission('unknown', 'allow');
    // Should not throw
  });

  it('sendMessage does nothing for unknown tab', () => {
    service.sendMessage('unknown', 'hello');
    // Should not throw
  });

  it('stop does nothing for unknown tab', () => {
    service.stop('unknown');
    // Should not throw
  });

  it('stopAll does nothing when no sessions', () => {
    service.stopAll();
    // Should not throw
  });
});
