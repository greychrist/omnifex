import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createJsonRpcClient } from '../../services/agents/json-rpc-client';

function makeStreams(): { readable: PassThrough; writable: PassThrough; writes: string[] } {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const writes: string[] = [];
  writable.on('data', (chunk: Buffer | string) => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  return { readable, writable, writes };
}

describe('json-rpc-client', () => {
  it('request() writes JSON-RPC frame and resolves on matching response', async () => {
    const { readable, writable, writes } = makeStreams();
    const client = createJsonRpcClient({ readable, writable });

    const pending = client.request<{ ok: boolean }>('foo', { x: 1 });

    // Allow the microtask that performs the write to flush.
    await new Promise((r) => setImmediate(r));

    expect(writes.length).toBe(1);
    const parsed = JSON.parse(writes[0]!.replace(/\n$/, ''));
    expect(parsed).toEqual({ jsonrpc: '2.0', id: 1, method: 'foo', params: { x: 1 } });
    expect(writes[0]!.endsWith('\n')).toBe(true);

    readable.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n');

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('request() rejects on error response, message includes server message and code', async () => {
    const { readable, writable } = makeStreams();
    const client = createJsonRpcClient({ readable, writable });

    const p1 = client.request('first');
    const p2 = client.request('second');
    // Avoid unhandled rejection warning for the first promise.
    p1.catch(() => {});

    await new Promise((r) => setImmediate(r));

    readable.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32602, message: 'Invalid' },
      }) + '\n',
    );

    await expect(p2).rejects.toThrow(/Invalid/);
    await expect(p2).rejects.toThrow(/-32602/);
  });

  it('concurrent requests resolve to the right promises based on id', async () => {
    const { readable, writable } = makeStreams();
    const client = createJsonRpcClient({ readable, writable });

    const a = client.request<{ tag: string }>('a');
    const b = client.request<{ tag: string }>('b');

    await new Promise((r) => setImmediate(r));

    // Push response for B (id 2) first, then A (id 1).
    readable.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tag: 'B' } }) + '\n');
    readable.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tag: 'A' } }) + '\n');

    await expect(a).resolves.toEqual({ tag: 'A' });
    await expect(b).resolves.toEqual({ tag: 'B' });
  });

  it('notifications (no id) invoke onNotification and do not affect pending requests', async () => {
    const { readable, writable } = makeStreams();
    const onNotification = vi.fn();
    const client = createJsonRpcClient({ readable, writable, onNotification });

    const pending = client.request('foo');
    await new Promise((r) => setImmediate(r));

    readable.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'task_started',
        params: { conversationId: 'c1' },
      }) + '\n',
    );

    // Give the data event a tick to be processed.
    await new Promise((r) => setImmediate(r));

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith('task_started', { conversationId: 'c1' });

    // Pending request must still be pending — fulfil it and confirm it works.
    readable.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'done' }) + '\n');
    await expect(pending).resolves.toBe('done');
  });

  it('server-initiated requests call onServerRequest and respondToServer writes back', async () => {
    const { readable, writable, writes } = makeStreams();
    const onServerRequest = vi.fn();
    const client = createJsonRpcClient({ readable, writable, onServerRequest });

    readable.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'srv-1',
        method: 'applyPatchApproval',
        params: { foo: 'bar' },
      }) + '\n',
    );

    await new Promise((r) => setImmediate(r));

    expect(onServerRequest).toHaveBeenCalledTimes(1);
    expect(onServerRequest).toHaveBeenCalledWith('applyPatchApproval', { foo: 'bar' }, 'srv-1');

    client.respondToServer('srv-1', { result: { decision: 'allow' } });
    await new Promise((r) => setImmediate(r));

    expect(writes.length).toBe(1);
    expect(writes[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(writes[0]!.replace(/\n$/, ''))).toEqual({
      jsonrpc: '2.0',
      id: 'srv-1',
      result: { decision: 'allow' },
    });

    client.respondToServer('srv-1', { error: { code: -32601, message: 'nope' } });
    await new Promise((r) => setImmediate(r));

    expect(writes.length).toBe(2);
    expect(JSON.parse(writes[1]!.replace(/\n$/, ''))).toEqual({
      jsonrpc: '2.0',
      id: 'srv-1',
      error: { code: -32601, message: 'nope' },
    });
  });

  it('handles a JSON message split across chunk boundaries', async () => {
    const { readable, writable } = makeStreams();
    const client = createJsonRpcClient({ readable, writable });

    const pending = client.request<{ ok: boolean }>('foo');

    await new Promise((r) => setImmediate(r));

    readable.write('{"jsonrpc":"2.0","id":1,"result":');
    // Nothing should have resolved yet; deliver the rest as a second chunk.
    readable.write('{"ok":true}}\n');

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('close() rejects pending requests', async () => {
    const { readable, writable } = makeStreams();
    const client = createJsonRpcClient({ readable, writable });

    const pending = client.request('foo');
    // Avoid unhandled rejection while we set up.
    pending.catch(() => {});

    await new Promise((r) => setImmediate(r));

    client.close();

    await expect(pending).rejects.toThrow(/closed/);
  });

  it('request() after close() rejects immediately', async () => {
    const { readable, writable } = makeStreams();
    const client = createJsonRpcClient({ readable, writable });

    client.close();

    await expect(client.request('foo')).rejects.toThrow(/closed/);
  });

  it('respondToServer() after close() is a no-op', async () => {
    const { readable, writable, writes } = makeStreams();
    const client = createJsonRpcClient({ readable, writable, onServerRequest: () => {} });

    // First, get a real server request through so we know writes work before close.
    readable.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'srv-1',
        method: 'applyPatchApproval',
        params: {},
      }) + '\n',
    );
    await new Promise((r) => setImmediate(r));

    client.respondToServer('srv-1', { result: { ok: true } });
    await new Promise((r) => setImmediate(r));

    const writesBeforeClose = writes.length;
    expect(writesBeforeClose).toBe(1);

    client.close();

    client.respondToServer('srv-x', { result: { ok: true } });
    await new Promise((r) => setImmediate(r));

    // No new write should have happened after close().
    expect(writes.length).toBe(writesBeforeClose);
  });
});
