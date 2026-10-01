import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { deriveBackgroundShells, plainTaskOutput } from '@/lib/backgroundShells';

const snapshot = (tasks: { task_id: string; task_type: string; description?: string }[]): JsonlNode =>
  ({
    kind: 'system', subtype: 'background_tasks_changed', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'background_tasks_changed', tasks },
  }) as unknown as JsonlNode;

const other: JsonlNode = {
  kind: 'system', subtype: 'status', sessionId: '', receivedAt: '',
  raw: { type: 'system', subtype: 'status', status: 'requesting' },
} as unknown as JsonlNode;

describe('deriveBackgroundShells', () => {
  it('is empty when the stream carries no snapshot', () => {
    expect(deriveBackgroundShells([other])).toEqual([]);
  });

  it('lists shells in the latest snapshot as running, and ignores agents', () => {
    const shells = deriveBackgroundShells([
      snapshot([
        { task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' },
        { task_id: 'a1', task_type: 'local_agent', description: 'Explore' },
      ]),
    ]);
    expect(shells).toEqual([{ taskId: 'b1', description: 'npm run dev', status: 'running' }]);
  });

  it('keeps a shell that left the set as ended, in first-seen order', () => {
    const shells = deriveBackgroundShells([
      snapshot([{ task_id: 'b1', task_type: 'local_bash', description: 'tests' }]),
      other,
      snapshot([
        { task_id: 'b1', task_type: 'local_bash', description: 'tests' },
        { task_id: 'b2', task_type: 'local_bash', description: 'server' },
      ]),
      snapshot([{ task_id: 'b2', task_type: 'local_bash', description: 'server' }]),
    ]);
    expect(shells).toEqual([
      { taskId: 'b1', description: 'tests', status: 'ended' },
      { taskId: 'b2', description: 'server', status: 'running' },
    ]);
  });

  it('marks every shell ended when the set empties', () => {
    const shells = deriveBackgroundShells([
      snapshot([{ task_id: 'b1', task_type: 'local_bash', description: 'tests' }]),
      snapshot([]),
    ]);
    expect(shells).toEqual([{ taskId: 'b1', description: 'tests', status: 'ended' }]);
  });

  it('leaves a missing description empty rather than inventing one', () => {
    const shells = deriveBackgroundShells([snapshot([{ task_id: 'b1', task_type: 'local_bash' }])]);
    expect(shells[0].description).toBe('');
  });
});

describe('plainTaskOutput', () => {
  it('strips colour and cursor escape sequences', () => {
    expect(plainTaskOutput('\u001b[32mok\u001b[0m done\u001b[2K\u001b[1G')).toBe('ok done');
  });

  it('keeps the last carriage-return frame of a progress line', () => {
    expect(plainTaskOutput('10%\r50%\r100%\nnext')).toBe('100%\nnext');
  });

  it('leaves CRLF line endings as line breaks', () => {
    expect(plainTaskOutput('a\r\nb\r\n')).toBe('a\nb\n');
  });
});
