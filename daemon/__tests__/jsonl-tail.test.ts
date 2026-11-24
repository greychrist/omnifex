// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createJsonlTail, type JsonlTailHandle } from '../services/sessions/jsonl-tail';

// The tail polls every 100ms; 300ms covers a full cycle plus margin.
function wait(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// fs.watchFile's polling degrades under parallel load, so poll rather than
// sleep a fixed time.
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(30);
  }
  return predicate();
}

describe('createJsonlTail', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let tail: JsonlTailHandle | null = null;
  let received: unknown[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-jsonl-tail-'));
    jsonlPath = path.join(tmpDir, 'session.jsonl');
    received = [];
  });

  afterEach(() => {
    tail?.stop();
    tail = null;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function start(): void {
    tail = createJsonlTail({
      jsonlPath,
      onMessage: (m) => received.push(m),
    });
  }

  it('forwards a queue-operation enqueue with task-notification XML', async () => {
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<tool-use-id>toolu_TEST</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>',
      }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe('queue-operation');
  });

  it('forwards an attachment with queued_command containing task-notification XML', async () => {
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt:
            '<task-notification>\n<tool-use-id>toolu_TEST2</tool-use-id>\n<status>completed</status>\n</task-notification>',
        },
      }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe('attachment');
  });

  it('never forwards request-replay records, even with filter all', async () => {
    fs.writeFileSync(jsonlPath, '');
    tail = createJsonlTail({
      jsonlPath,
      filter: 'all',
      onMessage: (m) => received.push(m),
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'api-request', params: {} }) + '\n' +
        JSON.stringify({ type: 'api-request-blob', message: { role: 'user' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    await wait();
    expect((received as { type: string }[]).map((r) => r.type)).toEqual(['assistant']);
  });

  it('does not corrupt a multibyte UTF-8 codepoint split across two drains', async () => {
    // The CLI flushes JSONL incrementally, so a drain boundary can split a
    // codepoint.
    fs.writeFileSync(jsonlPath, '');
    tail = createJsonlTail({
      jsonlPath,
      filter: 'all',
      onMessage: (m) => received.push(m),
    });

    const marker = '日本語🚀'; // 3- and 4-byte codepoints
    const obj = { type: 'assistant', summary: `pre${marker}post` };
    const json = JSON.stringify(obj);
    const buf = Buffer.from(json + '\n', 'utf8');

    const splitAt = Buffer.from(json.slice(0, json.indexOf(marker)), 'utf8').length + 1;
    fs.appendFileSync(jsonlPath, buf.subarray(0, splitAt));
    await wait(); // let a poll cycle drain the partial bytes
    fs.appendFileSync(jsonlPath, buf.subarray(splitAt));

    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);
    expect((received[0] as { summary: string }).summary).toBe(`pre${marker}post`);
  });

  it('ignores envelope types that the CLI iterator already yields (assistant/user/result/system)', async () => {
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n' +
        JSON.stringify({ type: 'user', message: { content: [] } }) + '\n' +
        JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' +
        JSON.stringify({ type: 'result', subtype: 'success' }) + '\n',
    );
    await wait();
    expect(received).toHaveLength(0);
  });

  it('ignores queue-operation lines that do not carry task-notification XML', async () => {
    // The CLI queues many things; only enqueues carrying <task-notification> are
    // carriers.
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'just a user prompt' }) + '\n' +
        JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }) + '\n' +
        JSON.stringify({ type: 'queue-operation', operation: 'remove' }) + '\n',
    );
    await wait();
    expect(received).toHaveLength(0);
  });

  it('starts tailing from current end-of-file (does not re-emit pre-existing lines)', async () => {
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<tool-use-id>toolu_OLD</tool-use-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n',
    );
    start();
    await wait();
    expect(received).toHaveLength(0);

    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<tool-use-id>toolu_NEW</tool-use-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);
  });

  it('handles file that does not exist yet (waits, then forwards once it appears)', async () => {
    // Session start fires before the CLI writes its first line.
    start();
    await wait();
    expect(received).toHaveLength(0);

    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt:
            '<task-notification>\n<tool-use-id>toolu_LATE</tool-use-id>\n<status>completed</status>\n</task-notification>',
        },
      }) + '\n',
    );
    // The ENOENT path polls every 200ms.
    await waitUntil(() => received.length >= 1, 2500);
    expect(received).toHaveLength(1);
  });

  it('stop() releases the watcher (no further events after stop)', async () => {
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<tool-use-id>toolu_X</tool-use-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);

    tail!.stop();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<tool-use-id>toolu_Y</tool-use-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);
  });

  it('skips malformed JSON lines without throwing', async () => {
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(jsonlPath, '{not json}\n');
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<tool-use-id>toolu_OK</tool-use-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);
  });

  it('handles file truncation by resuming from offset 0', async () => {
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<tool-use-id>toolu_PRE</tool-use-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n',
    );
    await waitUntil(() => received.length >= 1);
    expect(received).toHaveLength(1);

    fs.writeFileSync(jsonlPath, '');
    await wait();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<tool-use-id>toolu_POST</tool-use-id>\n<status>completed</status>\n</task-notification>',
      }) + '\n',
    );
    await waitUntil(() => received.length >= 2);
    expect(received).toHaveLength(2);
  });

  it('forwards every parsed line when filter is "all"', async () => {
    fs.writeFileSync(jsonlPath, '');
    tail = createJsonlTail({
      jsonlPath,
      filter: 'all',
      onMessage: (m) => received.push(m),
    });
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }) + '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n' +
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n',
    );
    await waitUntil(() => received.length >= 3);
    expect(received).toHaveLength(3);
    expect((received[0] as { type: string }).type).toBe('system');
    expect((received[1] as { type: string }).type).toBe('user');
    expect((received[2] as { type: string }).type).toBe('result');
  });

  it('ignores non-carrier lines when filter defaults to "closure-carriers"', async () => {
    fs.writeFileSync(jsonlPath, '');
    start();
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }) + '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    await wait(400);
    expect(received).toHaveLength(0);
  });

  // EnterWorktree moves the transcript: projects/<repo>/<id>.jsonl becomes
  // projects/<repo>--claude-worktrees-<name>/<id>.jsonl, records appended.
  describe('when the CLI moves the file', () => {
    let movedPath: string;

    beforeEach(() => {
      fs.mkdirSync(path.join(tmpDir, 'moved'));
      movedPath = path.join(tmpDir, 'moved', 'session.jsonl');
    });

    function startLocating(): void {
      tail = createJsonlTail({
        jsonlPath,
        filter: 'all',
        onMessage: (m) => received.push(m),
        locate: () => (fs.existsSync(movedPath) ? movedPath : null),
      });
    }

    it('follows the file to its new path and forwards only what is new', async () => {
      fs.writeFileSync(jsonlPath, JSON.stringify({ n: 1 }) + '\n');
      startLocating();
      fs.appendFileSync(jsonlPath, JSON.stringify({ n: 2 }) + '\n');
      await waitUntil(() => received.length >= 1);

      fs.renameSync(jsonlPath, movedPath);
      fs.appendFileSync(movedPath, JSON.stringify({ n: 3 }) + '\n');
      await waitUntil(() => received.length >= 2);

      expect(received).toEqual([{ n: 2 }, { n: 3 }]);
    });

    it('starts at the moved file when it has already moved before the tail starts', async () => {
      fs.writeFileSync(movedPath, JSON.stringify({ n: 1 }) + '\n');
      startLocating();
      await wait();
      fs.appendFileSync(movedPath, JSON.stringify({ n: 2 }) + '\n');
      await waitUntil(() => received.length >= 1);

      expect(received).toEqual([{ n: 2 }]);
    });
  });
});
