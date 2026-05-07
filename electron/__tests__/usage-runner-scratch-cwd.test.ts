import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTrustedScratchCwd } from '../services/usage-runner/scratch-cwd';

// The scratch-cwd helper is the fix for "/usage runner times out on Claude
// Code's first-launch safety prompt" (see usage-runner.ts comments). Each
// test uses a fresh tmp dir for the simulated userData + configDir so we
// don't touch real Claude state.

let tmpRoot: string;
let userDataDir: string;
let configDir: string;
let claudeJsonPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-scratch-cwd-'));
  userDataDir = path.join(tmpRoot, 'userData');
  configDir = path.join(tmpRoot, '.claude-personal');
  claudeJsonPath = path.join(configDir, '.claude.json');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('ensureTrustedScratchCwd', () => {
  it('creates <userData>/usage-cwd/<accountKey>/ and returns its absolute path', () => {
    const cwd = ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const expected = path.join(userDataDir, 'usage-cwd', 'personal');
    expect(cwd).toBe(expected);
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
  });

  it('sanitizes filesystem-unsafe chars in accountKey', () => {
    const cwd = ensureTrustedScratchCwd('My Work / Acct.1', configDir, { userDataDir });
    expect(cwd).toBe(path.join(userDataDir, 'usage-cwd', 'My_Work___Acct_1'));
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
  });

  it('writes hasTrustDialogAccepted + hasCompletedProjectOnboarding into <configDir>/.claude.json', () => {
    // .claude.json doesn't exist yet — helper should create it
    const cwd = ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const json = readJson(claudeJsonPath);
    expect(json.projects[cwd]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('preserves existing top-level keys and other project entries', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      anonymousId: 'abc-123',
      autoUpdates: true,
      projects: {
        '/Users/me/Repos/foo': {
          hasTrustDialogAccepted: true,
          lastSessionId: 'sess-1',
          someCustomField: { nested: 'value' },
        },
      },
    }));
    const cwd = ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const json = readJson(claudeJsonPath);
    expect(json.anonymousId).toBe('abc-123');
    expect(json.autoUpdates).toBe(true);
    // Other project preserved untouched
    expect(json.projects['/Users/me/Repos/foo']).toEqual({
      hasTrustDialogAccepted: true,
      lastSessionId: 'sess-1',
      someCustomField: { nested: 'value' },
    });
    // Our scratch project now has trust set
    expect(json.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(json.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
  });

  it('is idempotent — second call leaves file mtime unchanged when trust is already set', async () => {
    ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const mtime1 = fs.statSync(claudeJsonPath).mtimeMs;
    // wait long enough to detect a write
    await new Promise((r) => setTimeout(r, 20));
    ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const mtime2 = fs.statSync(claudeJsonPath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('does rewrite when trust state is missing or false (the bug scenario)', () => {
    // This is exactly Greg's state: prior dialog rejections wrote
    // hasTrustDialogAccepted: false. The helper must flip it to true.
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      projects: {
        [path.join(userDataDir, 'usage-cwd', 'personal')]: {
          hasTrustDialogAccepted: false,
          hasCompletedProjectOnboarding: null,
          projectOnboardingSeenCount: 4,
        },
      },
    }));
    const cwd = ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const json = readJson(claudeJsonPath);
    expect(json.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(json.projects[cwd].hasCompletedProjectOnboarding).toBe(true);
    // Existing fields preserved
    expect(json.projects[cwd].projectOnboardingSeenCount).toBe(4);
  });

  it('uses atomic write — no .tmp file remains after success', () => {
    ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const entries = fs.readdirSync(configDir);
    const stragglers = entries.filter((e) => e.startsWith('.claude.json.tmp'));
    expect(stragglers).toEqual([]);
  });

  it('throws a clear error when .claude.json exists but is malformed JSON', () => {
    fs.writeFileSync(claudeJsonPath, '{ this is not: json');
    expect(() => ensureTrustedScratchCwd('personal', configDir, { userDataDir }))
      .toThrow(/malformed/i);
  });

  it('two different accounts get separate scratch dirs and separate trust marks in their respective configDirs', () => {
    const configDir2 = path.join(tmpRoot, '.claude-work');
    fs.mkdirSync(configDir2, { recursive: true });
    const cwdA = ensureTrustedScratchCwd('personal', configDir, { userDataDir });
    const cwdB = ensureTrustedScratchCwd('work', configDir2, { userDataDir });
    expect(cwdA).not.toBe(cwdB);
    const jsonA = readJson(path.join(configDir, '.claude.json'));
    const jsonB = readJson(path.join(configDir2, '.claude.json'));
    expect(jsonA.projects[cwdA].hasTrustDialogAccepted).toBe(true);
    expect(jsonB.projects[cwdB].hasTrustDialogAccepted).toBe(true);
    // No cross-pollination
    expect(jsonA.projects[cwdB]).toBeUndefined();
    expect(jsonB.projects[cwdA]).toBeUndefined();
  });
});
