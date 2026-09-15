// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TaskNotificationWidget } from '@/components/claude/tools/TaskNotificationWidget';

afterEach(() => { cleanup(); });

const AGENT = `<task-notification>
<task-id>aa3a149</task-id>
<tool-use-id>toolu_01EY</tool-use-id>
<output-file>/private/tmp/claude-501/x/tasks/aa3a149.output</output-file>
<status>completed</status>
<summary>Agent "say hello" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>hello world</result>
<usage><subagent_tokens>12213</subagent_tokens><tool_uses>5</tool_uses><duration_ms>64000</duration_ms></usage>
</task-notification>`;

describe('TaskNotificationWidget', () => {
  it('shows no angle-bracket markup anywhere', () => {
    render(<TaskNotificationWidget text={AGENT} />);
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('<task-notification>');
    expect(body).not.toContain('<summary>');
    expect(body).not.toContain('</status>');
  });

  it('shows the status and the returned result', () => {
    render(<TaskNotificationWidget text={AGENT} />);
    expect(screen.getByText(/completed/i)).toBeTruthy();
    expect(screen.getByText('hello world')).toBeTruthy();
  });

  it('formats the usage block as readable stats', () => {
    render(<TaskNotificationWidget text={AGENT} />);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/12,213 tokens/);
    expect(body).toMatch(/5 tool uses/);
    expect(body).toMatch(/1m 4\.00s/);
  });

  it('shows the task id and output file for tracing the run', () => {
    render(<TaskNotificationWidget text={AGENT} />);
    expect(screen.getByText('aa3a149')).toBeTruthy();
    expect(screen.getByText('/private/tmp/claude-501/x/tasks/aa3a149.output')).toBeTruthy();
  });

  it('omits the boilerplate note', () => {
    render(<TaskNotificationWidget text={AGENT} />);
    expect(document.body.textContent).not.toContain('fires each time this agent stops');
  });

  it('renders a monitor event with no status or usage', () => {
    render(<TaskNotificationWidget text={'<task-notification>\n<task-id>bp1</task-id>\n<summary>Monitor event: "gate"</summary>\n<event>[Monitor timed out]</event>\n</task-notification>'} />);
    expect(screen.getByText('[Monitor timed out]')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/tokens/);
  });

  it('singularizes a one-tool-use run', () => {
    render(<TaskNotificationWidget text={'<task-notification><summary>s</summary><usage><tool_uses>1</tool_uses></usage></task-notification>'} />);
    expect(document.body.textContent).toMatch(/1 tool use(?!s)/);
  });

  it('falls back to the raw text when the payload is not a notification', () => {
    render(<TaskNotificationWidget text="not a notification" />);
    expect(screen.getByText('not a notification')).toBeTruthy();
  });
});
