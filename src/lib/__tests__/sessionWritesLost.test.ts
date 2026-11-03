import { describe, it, expect } from 'vitest';
import { sessionWritesLostText } from '../sessionWritesLost';

// CLI >= 2.1.317 sends `system/session_writes_lost` once, as it exits, when a
// full disk or quota lost transcript lines or ~/.claude.json changes.
describe('sessionWritesLostText', () => {
  it('names what was lost, why, the resume risk and the fix', () => {
    expect(sessionWritesLostText({ error_code: 'ENOSPC', lost: ['transcript', 'global_config'] })).toBe(
      "Claude Code couldn't save part of this session's transcript and its changes to ~/.claude.json: the disk is full. "
      + 'Resuming this session may miss part of the conversation. Free up space on that disk before the next run.',
    );
  });

  it('says quota, not full disk, for EDQUOT, and leaves out the resume warning when only the config was lost', () => {
    expect(sessionWritesLostText({ error_code: 'EDQUOT', lost: ['global_config'] })).toBe(
      "Claude Code couldn't save its changes to ~/.claude.json: the disk quota is used up. "
      + 'Free up space, or ask for a larger quota, before the next run.',
    );
  });

  it('does not invent a cause it was not given', () => {
    expect(sessionWritesLostText({ lost: ['transcript'] })).toBe(
      "Claude Code couldn't save part of this session's transcript. Resuming this session may miss part of the conversation.",
    );
  });
});
