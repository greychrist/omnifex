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
