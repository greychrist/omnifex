import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import { encodeProjectId } from '../services/project-paths';
import { SCRATCH_DIR_NAME } from '../services/sessions/internal-spend';

/**
 * The Brain must never index OmniFex's own output.
 *
 * Brain indexing spends money to distil a transcript into a note. If its own
 * extraction transcripts were discoverable, it would distil its own
 * distillations — and pay to do it, every cycle, forever. That is a runaway
 * cost bug, not a correctness nit, which is why it gets a test rather than a
 * comment.
 *
 * OmniFex's runs are priced and deleted as they finish, but a stray the
 * runner failed to settle sits in the scratch projects dir until the hourly
 * sweep does, and the Brain's discovery must skip it in the meantime.
 */
describe('the Brain never indexes OmniFex internal transcripts', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-brain-excl-cfg-'));
    fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
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
});
