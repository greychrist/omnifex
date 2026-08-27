import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import { encodeProjectId } from '../services/project-paths';
import { SCRATCH_DIR_NAME } from '../services/sessions/summary-query';

/**
 * The Brain must never index OmniFex's own output.
 *
 * Brain indexing spends money to distil a transcript into a note. If its own
 * extraction transcripts were discoverable, it would distil its own
 * distillations — and pay to do it, every cycle, forever. That is a runaway
 * cost bug, not a correctness nit, which is why it gets a test rather than a
 * comment.
 *
 * Two things have to hold:
 *   1. The scratch directory stays excluded, for transcripts written before
 *      retention shipped and for any that fail to move.
 *   2. The archive under userData is never reached at all — it lives outside
 *      `<configDir>/projects`, and this pins that it stays that way.
 */
describe('the Brain never indexes OmniFex internal transcripts', () => {
  let configDir: string;
  let userData: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-brain-excl-cfg-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-brain-excl-ud-'));
    fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  function writeTranscript(dir: string, name: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, name),
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-08-26T12:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      })}\n`,
      'utf-8',
    );
  }

  async function discover(): Promise<string[]> {
    const source = createSessionSource({
      accounts: {
        listAccounts: () => [{ id: 1, name: 'Work', config_dir: configDir }],
      } as never,
    });
    return (await source.discover()).map((i) => i.itemKey);
  }

  it('finds an ordinary project transcript', async () => {
    writeTranscript(
      path.join(configDir, 'projects', encodeProjectId('/Users/me/repo')),
      'real-session.jsonl',
    );
    expect((await discover()).some((k) => k.includes('real-session'))).toBe(true);
  });

  it('skips a transcript left in the scratch projects directory', async () => {
    writeTranscript(
      path.join(configDir, 'projects', encodeProjectId(`/tmp/${SCRATCH_DIR_NAME}`)),
      'internal-session.jsonl',
    );
    expect((await discover()).some((k) => k.includes('internal-session'))).toBe(false);
  });

  // The archive is deliberately outside the config dir. If someone ever moves
  // it under `<configDir>/projects` for convenience, this fails.
  it('never reaches the internal archive under userData', async () => {
    writeTranscript(
      path.join(userData, 'internal-sessions', 'Work', 'brain-index', '2026-08-26'),
      'archived-session.jsonl',
    );
    expect((await discover()).some((k) => k.includes('archived-session'))).toBe(false);
  });
});
