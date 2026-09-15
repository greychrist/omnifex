import { describe, it, expect } from 'vitest';
import { parseCommandEnvelope } from '../commandEnvelope';

describe('parseCommandEnvelope', () => {
  it('returns null for text with no command envelope', () => {
    expect(parseCommandEnvelope('just a normal prompt')).toBeNull();
    expect(parseCommandEnvelope('')).toBeNull();
  });

  // The built-in shape: name, then message, then args. This is what the
  // old inline regex in StreamMessage matched, and it must keep working.
  it('parses the name-first shape with args', () => {
    const text = '<command-name>/usage</command-name>\n'
      + '            <command-message>usage</command-message>\n'
      + '            <command-args>--json</command-args>';
    expect(parseCommandEnvelope(text)).toEqual({
      name: '/usage',
      message: 'usage',
      args: '--json',
    });
  });

  // The shape the CLI actually persists for custom / skill-backed commands:
  // message FIRST, and no <command-args> at all. This fell through to the
  // raw markdown renderer and printed the pseudo-XML verbatim.
  it('parses the message-first shape with no args', () => {
    const text = '<command-message>timesheet-review</command-message>\n'
      + '<command-name>/timesheet-review</command-name>';
    expect(parseCommandEnvelope(text)).toEqual({
      name: '/timesheet-review',
      message: 'timesheet-review',
      args: undefined,
    });
  });

  it('parses a bare command-name with no siblings', () => {
    expect(parseCommandEnvelope('<command-name>/verify</command-name>')).toEqual({
      name: '/verify',
      message: '',
      args: undefined,
    });
  });

  it('treats an empty args tag as no args', () => {
    const text = '<command-name>/clear</command-name><command-message>Clear context</command-message><command-args></command-args>';
    expect(parseCommandEnvelope(text)).toEqual({
      name: '/clear',
      message: 'Clear context',
      args: undefined,
    });
  });

  it('keeps a multi-word command message and multi-line args', () => {
    const text = '<command-message>compact (no arguments)</command-message>\n'
      + '<command-name>/compact</command-name>\n'
      + '<command-args>keep the\nplan</command-args>';
    expect(parseCommandEnvelope(text)).toEqual({
      name: '/compact',
      message: 'compact (no arguments)',
      args: 'keep the\nplan',
    });
  });

  it('requires a command-name — a stray message tag alone is not a command', () => {
    expect(parseCommandEnvelope('<command-message>orphan</command-message>')).toBeNull();
  });
});
