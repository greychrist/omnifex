import { describe, it, expect } from 'vitest';
import {
  HOOK_EVENTS,
  HOOK_EVENT_INFO,
  HOOK_EVENT_GROUPS,
  eventSupportsMatcher,
  groupedHookEvents,
  type HookEvent,
} from '@/types/hooks';

// From https://code.claude.com/docs/en/hooks, checked against CLI 2.1.310, plus PreSkillShellCommand (CLI 2.1.332 changelog; not yet in the docs).
const DOCUMENTED_EVENTS = [
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion',
  'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse',
  'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop',
  'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
  'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate',
  'WorktreeRemove', 'PreCompact', 'PostCompact', 'Elicitation',
  'ElicitationResult', 'SessionEnd', 'PreModelSwitch', 'PostModelSwitch',
  'PreSkillShellCommand',
];

// Per the docs, these fire on every occurrence and ignore `matcher`.
const NO_MATCHER = [
  'UserPromptSubmit', 'PostToolBatch', 'Stop', 'TeammateIdle', 'TaskCreated',
  'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove', 'MessageDisplay',
  'CwdChanged',
];

describe('HOOK_EVENTS', () => {
  it('covers every documented event, and nothing extra', () => {
    expect([...HOOK_EVENTS].sort()).toEqual([...DOCUMENTED_EVENTS].sort());
  });

  it('still includes the five the editor originally supported', () => {
    for (const e of ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']) {
      expect(HOOK_EVENTS).toContain(e);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(HOOK_EVENTS).size).toBe(HOOK_EVENTS.length);
  });
});

describe('HOOK_EVENT_INFO', () => {
  it('describes every event', () => {
    for (const e of HOOK_EVENTS) {
      const info = HOOK_EVENT_INFO[e];
      expect(info, `missing info for ${e}`).toBeTruthy();
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(0);
      expect(HOOK_EVENT_GROUPS).toContain(info.group);
    }
  });

  it('assigns every event to a group that actually renders', () => {
    const used = new Set(HOOK_EVENTS.map((e) => HOOK_EVENT_INFO[e].group));
    for (const g of HOOK_EVENT_GROUPS) expect(used.has(g)).toBe(true);
  });
});

describe('model-switch events', () => {
  it('match on the canonical model name, per the docs', () => {
    for (const e of ['PreModelSwitch', 'PostModelSwitch'] as HookEvent[]) {
      const m = HOOK_EVENT_INFO[e].matcher;
      expect(m, e).not.toBe(false);
      if (m) expect(m.examples).toContain('claude-opus-5');
    }
  });
});

describe('PreSkillShellCommand', () => {
  it('matches on the shell tool that runs the command', () => {
    expect(HOOK_EVENT_INFO.PreSkillShellCommand.matcher).toMatchObject({
      examples: expect.arrayContaining(['Bash', 'PowerShell']),
    });
  });
});

describe('eventSupportsMatcher', () => {
  it('reports false for the documented always-fire events', () => {
    for (const e of NO_MATCHER) {
      expect(eventSupportsMatcher(e as HookEvent), e).toBe(false);
    }
  });

  it('reports true for everything else', () => {
    for (const e of HOOK_EVENTS) {
      if (NO_MATCHER.includes(e)) continue;
      expect(eventSupportsMatcher(e), e).toBe(true);
    }
  });

  it('gives matcher-bearing events example values to offer as hints', () => {
    expect(HOOK_EVENT_INFO.SessionStart.matcher).toMatchObject({
      examples: expect.arrayContaining(['startup', 'resume']),
    });
    expect(HOOK_EVENT_INFO.PreToolUse.matcher).toMatchObject({
      examples: expect.arrayContaining(['Bash']),
    });
    expect(HOOK_EVENT_INFO.PreCompact.matcher).toMatchObject({
      examples: expect.arrayContaining(['manual', 'auto']),
    });
  });

  it('carries no matcher metadata for always-fire events', () => {
    expect(HOOK_EVENT_INFO.Stop.matcher).toBe(false);
    expect(HOOK_EVENT_INFO.UserPromptSubmit.matcher).toBe(false);
  });
});

describe('groupedHookEvents', () => {
  it('returns every event exactly once, grouped', () => {
    const groups = groupedHookEvents();
    const flat = groups.flatMap(([, events]) => events);
    expect([...flat].sort()).toEqual([...HOOK_EVENTS].sort());
  });

  it('orders groups by HOOK_EVENT_GROUPS, not alphabetically', () => {
    expect(groupedHookEvents().map(([g]) => g)).toEqual([...HOOK_EVENT_GROUPS]);
  });
});
