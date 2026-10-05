import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POST_COMPACT_PROMPT,
  POST_COMPACT_ENABLED_SETTING_KEY,
  POST_COMPACT_PROMPT_SETTING_KEY,
  resolvePostCompactDirective,
  resolvePostCompactPrompt,
} from '../postCompactPrompt';

describe('resolvePostCompactPrompt', () => {
  it('falls back to the shipped default when no override is stored', () => {
    expect(resolvePostCompactPrompt(null)).toBe(DEFAULT_POST_COMPACT_PROMPT);
    expect(resolvePostCompactPrompt(undefined)).toBe(DEFAULT_POST_COMPACT_PROMPT);
  });

  it('falls back to the default when the user blanks the box', () => {
    // Same semantics as renderCliReviewPrompt: a whitespace-only override is a
    // cleared field, not an instruction to send an empty turn.
    expect(resolvePostCompactPrompt('   \n  ')).toBe(DEFAULT_POST_COMPACT_PROMPT);
  });

  it('uses a stored override verbatim', () => {
    expect(resolvePostCompactPrompt('re-read the files first')).toBe(
      're-read the files first',
    );
  });

  it('pins the app_settings key the main process seeds', () => {
    expect(POST_COMPACT_PROMPT_SETTING_KEY).toBe('postCompact.promptTemplate');
  });

  it('default tells the model to re-read rather than trust the summary', () => {
    // The whole point of the directive. If this text stops saying so, the
    // feature is a wasted turn.
    expect(DEFAULT_POST_COMPACT_PROMPT.toLowerCase()).toContain('summary');
    expect(DEFAULT_POST_COMPACT_PROMPT.toLowerCase()).toContain('re-read');
  });

  // Measured over 52 compactions (2026-10-04): sent as its own turn, "then
  // carry on" set off unprompted work (129 and 97 Bash calls in two cases),
  // and "quote it" padded replies. Re-reads were rare and stay scoped.
  it('default neither resumes work on its own nor forces quoting', () => {
    const text = DEFAULT_POST_COMPACT_PROMPT.toLowerCase();
    expect(text).not.toContain('carry on');
    expect(text).not.toContain('quote');
    expect(text).toContain("don't re-read anything you aren't about to use");
  });
});

// The switch is the one way to turn the directive off, and keeps the edited
// text for when it is turned back on.
describe('resolvePostCompactDirective', () => {
  it('is on by default, with the shipped prompt', () => {
    expect(resolvePostCompactDirective(null, null)).toBe(DEFAULT_POST_COMPACT_PROMPT);
  });

  it('sends the stored override when on', () => {
    expect(resolvePostCompactDirective('true', 'mine')).toBe('mine');
  });

  it('sends nothing when switched off, whatever the template holds', () => {
    expect(resolvePostCompactDirective('false', 'mine')).toBe('');
    expect(resolvePostCompactDirective('false', null)).toBe('');
  });

  it('pins the enable key', () => {
    expect(POST_COMPACT_ENABLED_SETTING_KEY).toBe('postCompact.enabled');
  });
});
