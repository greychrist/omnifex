import { describe, it, expect } from 'vitest';
import { HooksManager } from '../hooksManager';
import type { HooksConfiguration } from '@/types/hooks';

/**
 * Every hook event uses the SAME nesting in settings.json:
 *
 *   "Event": [ { "matcher"?: string, "hooks": [ {type, command} ] } ]
 *
 * This holds for events that ignore the matcher too — verified against the
 * docs and against a real user config, where a working Stop hook is stored as
 * `[{"matcher": "", "hooks": [...]}]`. The editor used to model
 * Notification/Stop/SubagentStop as a FLAT array of command objects, which
 * both mis-read that config and wrote back a shape the CLI does not execute.
 */
const REAL_STOP_HOOK: HooksConfiguration = {
  Stop: [
    {
      matcher: '',
      hooks: [
        { type: 'command', command: '/Users/me/.claude/hooks/check-unfinished-todos.py' },
      ],
    },
  ],
};

describe('hooks config shape — always nested', () => {
  it('validates a real nested Stop hook', async () => {
    const result = await HooksManager.validateConfig(REAL_STOP_HOOK);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects the legacy FLAT shape the editor used to write', async () => {
    // `Stop: [{type:'command', command:'…'}]` has no `hooks` array, so the
    // CLI never runs it. Silently accepting it is how the bug survived.
    const flat = {
      Stop: [{ type: 'command', command: 'echo hi' }],
    } as unknown as HooksConfiguration;
    const result = await HooksManager.validateConfig(flat);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.event)).toContain('Stop');
  });

  it('merges non-matcher events by matcher identity, like every other event', async () => {
    const user: HooksConfiguration = {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'user.sh' }] }],
    };
    const project: HooksConfiguration = {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'project.sh' }] }],
    };
    const merged = HooksManager.mergeConfigs(user, project, {});
    // Same matcher key → project overrides user, one entry out. The old
    // direct-event path concatenated instead, so both would have fired.
    expect(merged.Stop).toHaveLength(1);
    expect(merged.Stop?.[0].hooks[0].command).toBe('project.sh');
  });

  it('merges events the editor never used to know about', async () => {
    const user: HooksConfiguration = {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'a.sh' }] }],
    };
    const local: HooksConfiguration = {
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'b.sh' }] }],
    };
    const merged = HooksManager.mergeConfigs(user, {}, local);
    expect(merged.SessionStart).toHaveLength(2);
  });

  it('round-trips a real config unchanged through merge', () => {
    // Opening the editor and saving without edits must not rewrite the file.
    const merged = HooksManager.mergeConfigs(REAL_STOP_HOOK, {}, {});
    expect(merged).toEqual(REAL_STOP_HOOK);
  });

  it('validates a regex matcher on any event, not just tool events', async () => {
    const bad: HooksConfiguration = {
      SubagentStop: [{ matcher: '[unclosed', hooks: [{ type: 'command', command: 'x' }] }],
    };
    const result = await HooksManager.validateConfig(bad);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/regex/i);
  });
});
