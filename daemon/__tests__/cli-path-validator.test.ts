import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateCliPath } from '../services/cli-path-validator';

describe('validateCliPath', () => {
  it('returns ok for null/empty input', () => {
    expect(validateCliPath(null)).toEqual({ ok: true });
    expect(validateCliPath('')).toEqual({ ok: true });
    expect(validateCliPath(undefined)).toEqual({ ok: true });
  });

  it('rejects a non-existent path', () => {
    const r = validateCliPath('/definitely/does/not/exist/claude');
    expect(r.ok).toBe(false);
  });

  it('rejects a directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
    const r = validateCliPath(dir);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-executable regular file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
    const p = path.join(dir, 'notexec');
    writeFileSync(p, '#!/bin/sh\necho hi\n');
    chmodSync(p, 0o644);
    const r = validateCliPath(p);
    expect(r.ok).toBe(false);
  });

  it('accepts an executable file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
    const p = path.join(dir, 'iscool');
    writeFileSync(p, '#!/bin/sh\necho hi\n');
    chmodSync(p, 0o755);
    const r = validateCliPath(p);
    expect(r.ok).toBe(true);
  });
});
