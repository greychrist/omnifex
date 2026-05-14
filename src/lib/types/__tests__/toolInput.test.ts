import { describe, it, expect } from 'vitest';
import { asToolInput, asToolInputOneOf } from '../toolInput';

describe('asToolInput', () => {
  it('returns the typed input when the name matches and input is an object', () => {
    const result = asToolInput('Bash', 'Bash', { command: 'ls', description: 'list' });
    expect(result).not.toBeNull();
    expect(result!.command).toBe('ls');
    expect(result!.description).toBe('list');
  });

  it('returns null when the name does not match', () => {
    expect(asToolInput('Read', 'Bash', { command: 'ls' })).toBeNull();
  });

  it('returns null when name is undefined', () => {
    expect(asToolInput(undefined, 'Bash', { command: 'ls' })).toBeNull();
  });

  it('returns null when input is not an object (string, number, null, undefined)', () => {
    expect(asToolInput('Bash', 'Bash', 'ls')).toBeNull();
    expect(asToolInput('Bash', 'Bash', 42)).toBeNull();
    expect(asToolInput('Bash', 'Bash', null)).toBeNull();
    expect(asToolInput('Bash', 'Bash', undefined)).toBeNull();
  });

  it('does NOT validate field-level shape — passes through any object payload', () => {
    // Documented behavior: SDK types are compile-time only; runtime asserts
    // the discriminator name and object-ness, no more. Each widget reads
    // with optional access so a missing field renders gracefully.
    const result = asToolInput('Bash', 'Bash', { unrelated: true });
    expect(result).not.toBeNull();
  });
});

describe('GrepInputExtended', () => {
  // Regression: GrepInputExtended adds optional `include` / `exclude`
  // fields the SDK no longer models (replaced upstream by glob / type).
  // GrepWidget still reads them for back-compat with older session
  // payloads. If the intersection were ever removed from toolInput.ts,
  // the call site in StreamMessage.tsx would compile (because rawInput
  // is unknown until narrowed) but `grepInput.include` would silently
  // become `unknown` rather than `string | undefined`. This test
  // exercises the access pattern so the type intersection can't be
  // removed without breaking either the test or the consumer.
  it('exposes legacy include/exclude fields after narrowing', () => {
    const result = asToolInput('Grep', 'Grep', {
      pattern: 'foo',
      include: '*.ts',
      exclude: 'node_modules',
    });
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('foo');
    expect(result!.include).toBe('*.ts');
    expect(result!.exclude).toBe('node_modules');
  });
});

describe('asToolInputOneOf', () => {
  it('matches any name in the expected set', () => {
    expect(asToolInputOneOf('Task', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toEqual({
      name: 'Task',
      input: { description: 'd', prompt: 'p' },
    });
    expect(asToolInputOneOf('Agent', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toEqual({
      name: 'Agent',
      input: { description: 'd', prompt: 'p' },
    });
  });

  it('returns null when the name is outside the expected set', () => {
    expect(asToolInputOneOf('Bash', ['Task', 'Agent'], { command: 'x' })).toBeNull();
  });

  it('returns null when name is undefined or input is not an object', () => {
    expect(asToolInputOneOf(undefined, ['Task'], { prompt: 'p', description: 'd' })).toBeNull();
    expect(asToolInputOneOf('Task', ['Task'], null)).toBeNull();
    expect(asToolInputOneOf('Task', ['Task'], 'string')).toBeNull();
  });
});
