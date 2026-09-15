import { describe, it, expect } from 'vitest';
import { parseTaskNotification } from '../taskNotification';

// Shapes below are copied from real records in this account's transcripts.
// Field frequency across 308 of them: summary 308, task-id 310, status 284,
// tool-use-id 283, output-file 281, note 134, result 133, usage 133, event 24.
const BACKGROUND_COMMAND = `<task-notification>
<task-id>bggcahqeu</task-id>
<tool-use-id>toolu_01TSt3AEq6CRZsY2X4HM8coX</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-x/9fefddba/tasks/bggcahqeu.output</output-file>
<status>completed</status>
<summary>Background command "Build WombBeats for iOS 26.5 simulator" completed (exit code 0)</summary>
</task-notification>`;

const AGENT_WITH_USAGE = `<task-notification>
<task-id>aa3a1490b90f63247</task-id>
<tool-use-id>toolu_01EYSvWRwbBMB92BhFFEriot</tool-use-id>
<output-file>/private/tmp/claude-501/-private-tmp/73fc6f98/tasks/aa3a1490b90f63247.output</output-file>
<status>completed</status>
<summary>Agent "say hello" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own.</note>
<result>hello world</result>
<usage><subagent_tokens>12213</subagent_tokens><tool_uses>5</tool_uses><duration_ms>64000</duration_ms></usage>
</task-notification>`;

const MONITOR_EVENT = `<task-notification>
<task-id>bpbb2fd1k</task-id>
<summary>Monitor event: "verify.mjs gate completion"</summary>
<event>[Monitor timed out — re-arm if needed.]</event>
</task-notification>`;

describe('parseTaskNotification', () => {
  it('returns null for text that is not a task notification', () => {
    expect(parseTaskNotification('just a prompt')).toBeNull();
    expect(parseTaskNotification('')).toBeNull();
  });

  it('parses the common background-command shape', () => {
    const p = parseTaskNotification(BACKGROUND_COMMAND);
    expect(p).toMatchObject({
      taskId: 'bggcahqeu',
      toolUseId: 'toolu_01TSt3AEq6CRZsY2X4HM8coX',
      status: 'completed',
      summary: 'Background command "Build WombBeats for iOS 26.5 simulator" completed (exit code 0)',
      outputFile: '/private/tmp/claude-501/-Users-x/9fefddba/tasks/bggcahqeu.output',
    });
    expect(p?.result).toBeUndefined();
    expect(p?.usage).toBeUndefined();
  });

  it('parses the agent shape including its nested usage block', () => {
    const p = parseTaskNotification(AGENT_WITH_USAGE);
    expect(p?.result).toBe('hello world');
    expect(p?.usage).toEqual({ tokens: 12213, toolUses: 5, durationMs: 64000 });
  });

  it('parses a monitor event with no status or tool-use id', () => {
    const p = parseTaskNotification(MONITOR_EVENT);
    expect(p).toMatchObject({
      taskId: 'bpbb2fd1k',
      summary: 'Monitor event: "verify.mjs gate completion"',
      event: '[Monitor timed out — re-arm if needed.]',
    });
    expect(p?.status).toBeUndefined();
    expect(p?.toolUseId).toBeUndefined();
  });

  // `note` is the same boilerplate paragraph on every agent notification and
  // says nothing about this run. The raw-payload viewer still has it.
  it('drops the boilerplate note', () => {
    expect(parseTaskNotification(AGENT_WITH_USAGE)).not.toHaveProperty('note');
  });

  it('reports a failed status rather than coercing it to completed', () => {
    const p = parseTaskNotification(BACKGROUND_COMMAND.replace('completed', 'failed'));
    expect(p?.status).toBe('failed');
  });

  it('parses a notification carrying only the tags it actually has', () => {
    const p = parseTaskNotification('<task-notification>\n<summary>Something happened</summary>\n</task-notification>');
    expect(p?.summary).toBe('Something happened');
    expect(p?.taskId).toBeUndefined();
  });
});
