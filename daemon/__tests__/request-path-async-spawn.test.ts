import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('execFileSync on a daemon request path');
    }),
  };
});

import { execFileSync } from 'node:child_process';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService } from '../services/accounts';
import { createClaudeService } from '../services/claude';
import { createClaudeBinaryService } from '../services/claude-binary';
import { createCodexBinaryService } from '../services/agents/codex-binary';
import { getHandlerMap } from '../ipc/handlers';

const execFileSyncMock = vi.mocked(execFileSync);

describe('request-path spawns are async', () => {
  let tmp: string;
  let db: Database;
  let realPath: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-async-spawn-'));
    db = createDatabase(':memory:');
    realPath = process.env.PATH;
    execFileSyncMock.mockClear();
  });

  afterEach(() => {
    process.env.PATH = realPath;
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A stand-in CLI. `-p` drains stdin before answering, as the real CLI does
   * when stdin is a pipe — so a caller that leaves stdin open hangs here.
   */
  function fakeBinary(name: string): string {
    const bin = path.join(tmp, 'bin', name);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'if [ "$1" = "-p" ]; then cat > /dev/null; echo \'{"result":"usage ok"}\'; exit 0; fi',
        'echo "9.9.9 (Fake)"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return bin;
  }

  it('checkClaudeVersion reads --version without a sync spawn', async () => {
    const bin = fakeBinary('claude');
    process.env.PATH = `${path.dirname(bin)}${path.delimiter}/bin`;
    const service = createClaudeService(db, createAccountsService(db));
    const result = await service.checkClaudeVersion();
    expect(result).toEqual({ installed: true, version: '9.9.9 (Fake)', path: bin });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('getCliUsage runs `claude -p /usage` async, with stdin closed', async () => {
    const bin = fakeBinary('claude');
    process.env.PATH = `${path.dirname(bin)}${path.delimiter}/bin`;
    const service = createClaudeService(db, createAccountsService(db));
    expect(await service.getCliUsage(path.join(tmp, '.claude-x'))).toBe('usage ok');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('claude listInstallations probes versions async', async () => {
    const bin = fakeBinary('claude');
    process.env.PATH = path.join(tmp, 'empty');
    const service = createClaudeBinaryService(db);
    service.setPath(bin);
    const installations = await service.listInstallations();
    expect(installations.find((i) => i.path === bin)?.version).toBe('9.9.9 (Fake)');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('codex listInstallations probes versions async', async () => {
    const bin = fakeBinary('codex');
    process.env.PATH = path.join(tmp, 'empty');
    const service = createCodexBinaryService(db);
    service.setPath(bin);
    const installations = await service.listInstallations();
    expect(installations.find((i) => i.path === bin)?.version).toBe('9.9.9 (Fake)');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('get_git_branch asks git async', async () => {
    const handlers = getHandlerMap({});
    // A sync spawn settles the handler in microtasks alone, before the loop
    // gets a turn; an async one lets this immediate run first.
    const order: string[] = [];
    setImmediate(() => order.push('loop'));
    const branch = await handlers.get_git_branch(null, { projectPath: process.cwd() });
    order.push('handler');
    expect(order).toEqual(['loop', 'handler']);
    expect(typeof branch).toBe('string');
    expect((branch as string).length).toBeGreaterThan(0);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
