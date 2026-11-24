import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import { encodeProjectId } from '../services/project-paths';
import { SCRATCH_DIR_NAME } from '../services/sessions/internal-spend';

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
