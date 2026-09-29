import { describe, it, expect } from 'vitest';
import { commandEnvelopeKind, isLocalCommandEnvelope, isModelCommandEcho, localCommandOutput, parseCommandEnvelope } from '../commandEnvelope';

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

describe('localCommandOutput', () => {
  it('unwraps the stdout tag, keeping the output byte for byte', () => {
    expect(localCommandOutput('<local-command-stdout>Current session: 5%\n  a · b</local-command-stdout>'))
      .toBe('Current session: 5%\n  a · b');
  });

  it('unwraps stderr too, after stdout', () => {
    expect(localCommandOutput('<local-command-stdout>out</local-command-stdout><local-command-stderr>err</local-command-stderr>'))
      .toBe('out\nerr');
  });

  it('returns untagged text as it is', () => {
    expect(localCommandOutput('plain')).toBe('plain');
  });
});

// The CLI writes an envelope as the whole record, so the tags open the text.
// A prompt that merely quotes them — a pasted JSONL line, OmniFex's own
// summary prompts — is prose, and treating it as a command hid everything
// but the quoted stdout (session 5220766b).
describe('commandEnvelopeKind', () => {
  it('recognises every shape the CLI persists', () => {
    expect(commandEnvelopeKind('<command-name>/usage</command-name><command-args></command-args>')).toBe('echo');
    expect(commandEnvelopeKind('<command-message>review</command-message>\n<command-name>/review</command-name>')).toBe('echo');
    expect(commandEnvelopeKind('<local-command-stdout>Compacted </local-command-stdout>')).toBe('output');
    expect(commandEnvelopeKind('<local-command-stderr>boom</local-command-stderr>')).toBe('output');
    expect(commandEnvelopeKind('\n  <local-command-stdout>x</local-command-stdout>')).toBe('output');
  });

  it('treats text that only quotes the tags as prose', () => {
    expect(commandEnvelopeKind('Look at this session.\n\n{"type":"system","content":"<local-command-stdout>You want every session</local-command-stdout>"}')).toBeNull();
    expect(commandEnvelopeKind('Why does this show twice? <command-name>/recap</command-name>')).toBeNull();
    expect(commandEnvelopeKind('just a prompt')).toBeNull();
  });

  it('needs a command name for an echo', () => {
    expect(commandEnvelopeKind('<command-message>orphan</command-message>')).toBeNull();
  });

  it('drives the classifier helpers the same way', () => {
    expect(isLocalCommandEnvelope('Look at this session.\n\n{"type":"system","content":"<local-command-stdout>You want every session</local-command-stdout>"}')).toBe(false);
    expect(isLocalCommandEnvelope([{ type: 'text', text: 'Why does this show twice? <command-name>/recap</command-name>' }])).toBe(false);
    expect(isModelCommandEcho('Why does this show twice? <command-name>/recap</command-name>', 'x')).toBe(false);
  });
});
