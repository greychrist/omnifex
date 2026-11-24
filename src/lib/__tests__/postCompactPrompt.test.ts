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
    expect(DEFAULT_POST_COMPACT_PROMPT.toLowerCase()).toContain('summary');
    expect(DEFAULT_POST_COMPACT_PROMPT.toLowerCase()).toContain('re-read');
  });

  it('default neither resumes work on its own nor forces quoting', () => {
    const text = DEFAULT_POST_COMPACT_PROMPT.toLowerCase();
    expect(text).not.toContain('carry on');
    expect(text).not.toContain('quote');
    expect(text).toContain("don't re-read anything you aren't about to use");
  });
});

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
