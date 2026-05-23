// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverNewSessionFile } from '../services/sessions/tui-coldstart';

describe('discoverNewSessionFile', () => {
  let configDir: string;
  let projectsDir: string;
  const projectPath = '/Users/test/myproj';
  const encoded = '-Users-test-myproj';

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-coldstart-'));
    projectsDir = path.join(configDir, 'projects', encoded);
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolves with the new JSONL file when one appears after the snapshot', async () => {
    fs.writeFileSync(path.join(projectsDir, 'old-session.jsonl'), '');
    const discoveryP = discoverNewSessionFile({ configDir, projectPath, timeoutMs: 2000 });
    // Simulate the CLI creating a new file after spawn
    setTimeout(() => {
      fs.writeFileSync(path.join(projectsDir, 'new-session-uuid.jsonl'), '');
    }, 100);
    const result = await discoveryP;
    expect(result.sessionId).toBe('new-session-uuid');
    expect(result.jsonlPath).toBe(path.join(projectsDir, 'new-session-uuid.jsonl'));
  });

  it('creates the projects directory if missing', async () => {
    fs.rmSync(projectsDir, { recursive: true });
    const discoveryP = discoverNewSessionFile({ configDir, projectPath, timeoutMs: 2000 });
    setTimeout(() => {
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(path.join(projectsDir, 'first.jsonl'), '');
    }, 100);
    const result = await discoveryP;
    expect(result.sessionId).toBe('first');
  });

  it('rejects when no new file appears within the timeout', async () => {
    fs.writeFileSync(path.join(projectsDir, 'only.jsonl'), '');
    await expect(
      discoverNewSessionFile({ configDir, projectPath, timeoutMs: 300 })
    ).rejects.toThrow(/timed out/i);
  });
});
