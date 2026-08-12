import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCaptureSource } from '../services/brain/sources/capture';

function writeCapture(root: string, id: string, over: Record<string, unknown> = {}) {
  const dir = join(root, '.omnifex', 'capture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      text: `fact ${id}`,
      project: 'omnifex',
      cwd: '/repo',
      capturedAt: '2026-08-12T18:00:00.000Z',
      ...over,
    }),
    'utf8',
  );
}

describe('capture source', () => {
  let tmp: string;
  let a: string;
  let b: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'brain-capture-'));
    a = join(tmp, 'A');
    b = join(tmp, 'B');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const source = () =>
    createCaptureSource({
      vaults: () => [
        { accountId: 1, root: a },
        { accountId: 2, root: b },
      ],
    });

  it('derives the owning account from which vault the file sits in', async () => {
    writeCapture(a, 'cap-1');
    writeCapture(b, 'cap-2');

    const items = await source().discover();
    expect(items.map((i) => [i.accountId, i.itemKey]).sort()).toEqual([
      [1, 'cap-1'],
      [2, 'cap-2'],
    ]);
    expect(items.every((i) => i.sourceId === 'capture')).toBe(true);
  });

  it('reports nothing when no vault has captures', async () => {
    expect(await source().discover()).toEqual([]);
  });

  it('ignores files that are not captures', async () => {
    mkdirSync(join(a, '.omnifex', 'capture'), { recursive: true });
    writeFileSync(join(a, '.omnifex', 'capture', 'notes.txt'), 'ignore me', 'utf8');
    expect(await source().discover()).toEqual([]);
  });

  it('carries the size and mtime the change store needs', async () => {
    writeCapture(a, 'cap-1');
    const [item] = await source().discover();
    expect(item.size).toBeGreaterThan(0);
    expect(item.mtimeMs).toBeGreaterThan(0);
    expect(item.path).toBe(join(a, '.omnifex', 'capture', 'cap-1.json'));
  });

  it('labels an item with its project', async () => {
    writeCapture(a, 'cap-1', { project: 'omnifex' });
    writeCapture(a, 'cap-2', { project: null });
    const items = await source().discover();
    expect(items.map((i) => i.label).sort()).toEqual(['capture', 'omnifex']);
  });

  it('admits a capture with text', async () => {
    writeCapture(a, 'cap-1');
    const src = source();
    const [item] = await src.discover();
    expect(src.admit(item)).toEqual({ admitted: true, reason: expect.any(String) });
  });

  it('skips an empty capture with a reason', async () => {
    writeCapture(a, 'cap-1', { text: '   ' });
    const src = source();
    const [item] = await src.discover();
    expect(src.admit(item)).toEqual({ admitted: false, reason: expect.stringContaining('empty') });
  });

  it('skips an unparseable capture rather than throwing', async () => {
    mkdirSync(join(a, '.omnifex', 'capture'), { recursive: true });
    writeFileSync(join(a, '.omnifex', 'capture', 'bad.json'), '{not json', 'utf8');
    const src = source();
    const [item] = await src.discover();
    expect(src.admit(item).admitted).toBe(false);
  });

  it('distils the captured text verbatim with capture metadata', async () => {
    writeCapture(a, 'cap-1', { text: '  node-pty must stay on 1.2.0-beta.13  ' });
    const src = source();
    const [item] = await src.discover();

    const distilled = await src.distill(item);
    expect(distilled.truncated).toBe(false);
    expect(distilled.prose).toBe('node-pty must stay on 1.2.0-beta.13');
    expect(distilled.metadata).toEqual({
      kind: 'capture',
      capturedAt: '2026-08-12T18:00:00.000Z',
      project: 'omnifex',
      cwd: '/repo',
    });
  });

  it('never attributes one vault\'s capture to another account', async () => {
    writeCapture(b, 'cap-only-b');
    const items = await source().discover();
    expect(items).toHaveLength(1);
    expect(items[0].accountId).toBe(2);
  });
});
