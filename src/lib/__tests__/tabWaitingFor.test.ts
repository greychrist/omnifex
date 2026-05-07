import { describe, it, expect } from 'vitest';
import { deriveWaitingFor } from '../tabWaitingFor';

describe('deriveWaitingFor', () => {
  it('returns null when there is no pending permission', () => {
    expect(deriveWaitingFor(null)).toBeNull();
  });

  it("returns 'question' when the pending permission is the AskUserQuestion built-in tool", () => {
    expect(deriveWaitingFor({ toolName: 'AskUserQuestion' })).toBe('question');
  });

  it("returns 'permission' for any other pending tool", () => {
    expect(deriveWaitingFor({ toolName: 'Bash' })).toBe('permission');
    expect(deriveWaitingFor({ toolName: 'Read' })).toBe('permission');
    expect(deriveWaitingFor({ toolName: 'Write' })).toBe('permission');
  });

  it("returns 'permission' when toolName is missing (treat unknown as a generic permission prompt)", () => {
    expect(deriveWaitingFor({})).toBe('permission');
  });
});
