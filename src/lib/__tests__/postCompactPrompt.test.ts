import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POST_COMPACT_PROMPT,
  POST_COMPACT_PROMPT_SETTING_KEY,
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
});
