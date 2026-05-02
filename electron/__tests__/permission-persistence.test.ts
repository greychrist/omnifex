// End-to-end permission persistence tests.
//
// These tests stitch together two halves that are unit-tested separately:
//   1. The session canUseTool / respondPermission flow (mocked SDK).
//   2. The PermissionsIOService that reads/writes settings.json files (real fs).
//
// They run against a real temporary directory so we can assert the rule
// actually lands on disk in the right shape AND that the response we hand
// back to the SDK includes a session-destination twin (the bit that
// prevents a re-prompt later in the same session).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsyncChannel } from '../services/async-channel';
import { createSessionsService, type SessionsService } from '../services/sessions';
import { createPermissionsIOService } from '../services/permissions-io';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../services/sessions/tui', () => ({ createTuiSession: vi.fn() }));

const mockedQuery = vi.mocked(sdkQuery);

function installFakeQuery() {
  const channel = createAsyncChannel<unknown>();
  let capturedArgs: any = null;
  const fakeQuery: any = {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
    close: () => channel.close(),
    interrupt: vi.fn().mockResolvedValue(undefined),
  };
  mockedQuery.mockImplementation((args: any) => {
    capturedArgs = args ?? null;
    return fakeQuery;
  });
  return {
    getCapturedOptions: () => capturedArgs?.options ?? null,
  };
}

describe('end-to-end permission persistence', () => {
  let tmpDir: string;
  let configDir: string;
  let projectPath: string;
  let service: SessionsService;
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedQuery.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-perm-e2e-'));
    configDir = path.join(tmpDir, 'config');
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(projectPath, '.claude'), { recursive: true });

    sendToRenderer = vi.fn();
    const permsIO = createPermissionsIOService();
    service = createSessionsService(
      sendToRenderer as any,
      {},
      null,
      null,
      // persistPermissionRule: route the session's "save & remember" calls
      // straight into the real fs-backed PermissionsIOService.
      ({ scope, behavior, rule, configDir: cd, projectPath: pp }) => {
        permsIO.updatePermission({
          scope,
          action: 'add',
          behavior,
          rule,
          configDir: cd,
          projectPath: pp,
        });
      },
    );
  });

  afterEach(() => {
    service?.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Save Permission writes the rule to <project>/.claude/settings.local.json AND attaches a session twin (so the same session does not re-prompt)', async () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-save',
      projectPath,
      configDir,
      model: 'sonnet',
      permissionMode: 'default',
    });

    // SDK asks for permission to run `ls`.
    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu-save',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    );
    await new Promise((r) => setImmediate(r));

    // User clicks Save Permission with the local-settings scope.
    service.respondPermission('tab-save', 'allow', undefined, [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ]);
    const result = await decisionPromise;

    // (a) The decision sent to the SDK includes the persistent rule AND a
    //     session-destination twin. The session twin is what prevents a
    //     second matching tool_use from re-triggering canUseTool — without
    //     it the rule lands on disk but the live SDK rule cache never
    //     learns about it, and the user gets prompted again immediately.
    expect(result.behavior).toBe('allow');
    expect(result.updatedPermissions).toHaveLength(2);
    const destinations = result.updatedPermissions.map((p: any) => p.destination);
    expect(destinations).toContain('localSettings');
    expect(destinations).toContain('session');

    // (b) The rule landed on disk in the right file with the right shape.
    const localSettingsPath = path.join(projectPath, '.claude', 'settings.local.json');
    expect(fs.existsSync(localSettingsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    expect(written.permissions.allow).toContain('Bash(ls)');

    // (c) A fresh PermissionsIOService (no shared state with the one wired
    //     into the session) reads the rule back. This proves the next
    //     session boot will see the same rule.
    const fresh = createPermissionsIOService();
    const levels = fresh.getPermissions(configDir, projectPath);
    const local = levels.find((l) => l.scope === 'local');
    expect(local?.allow).toContain('Bash(ls)');
  });

  it('Allow Once (session-destination only) does NOT write to disk but still tells the SDK to apply the rule for this session', async () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-once',
      projectPath,
      configDir,
      model: 'sonnet',
      permissionMode: 'default',
    });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool(
      'Bash',
      { command: 'pwd' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu-once',
        suggestions: [],
      },
    );
    await new Promise((r) => setImmediate(r));

    // User clicks Allow Once → response carries a session-destination rule
    // with no persistent twin.
    service.respondPermission('tab-once', 'allow', undefined, [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]);
    const result = await decisionPromise;

    expect(result.behavior).toBe('allow');
    // The session destination is preserved as-is — no extra twin needed.
    expect(result.updatedPermissions).toHaveLength(1);
    expect(result.updatedPermissions[0].destination).toBe('session');

    // Nothing got written: no settings.json, no settings.local.json, no
    // user settings file. The Allow Once button should never touch disk.
    expect(fs.existsSync(path.join(projectPath, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(projectPath, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'settings.json'))).toBe(false);
  });

  it('a deny decision does not write to disk', async () => {
    const fake = installFakeQuery();
    service.start({
      tabId: 'tab-deny',
      projectPath,
      configDir,
      model: 'sonnet',
      permissionMode: 'default',
    });

    const canUseTool = fake.getCapturedOptions().canUseTool;
    const decisionPromise = canUseTool(
      'Bash',
      { command: 'rm -rf /' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu-deny',
        suggestions: [],
      },
    );
    await new Promise((r) => setImmediate(r));

    service.respondPermission('tab-deny', 'deny');
    const result = await decisionPromise;

    expect(result.behavior).toBe('deny');
    expect(fs.existsSync(path.join(projectPath, '.claude', 'settings.local.json'))).toBe(false);
  });
});
