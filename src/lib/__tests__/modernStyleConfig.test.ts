import { describe, it, expect } from 'vitest';
import {
  createDefaultConfig,
  mergeConfig,
  modernCssVars,
  DEFAULT_MODERN,
  MODERN_ANSWER_SIZES,
} from '@/lib/messageRenderingConfig';

describe('Modern style config', () => {
  it('defaults to how Modern looked before it had settings', () => {
    const m = createDefaultConfig().modern;
    expect(m.timelineOpen).toBe('while-running');
    expect(m.showThoughts).toBe(true);
    expect(m.font).toBe('geist');
    expect(m.answerSize).toBe(14);
    expect(m.promptTint).toBeNull();
    expect(m.failedColor).toBeNull();
    expect(m.stepIcons.thought).toBe('Brain');
    expect(m.stepIcons.command).toBe('Terminal');
    expect(m.stepIcons.tool).toBe('Wrench');
  });

  it('returns independent copies', () => {
    const a = createDefaultConfig();
    a.modern.stepIcons.read = 'Bot';
    expect(createDefaultConfig().modern.stepIcons.read).toBe(DEFAULT_MODERN.stepIcons.read);
  });

  it('merges valid saved fields and drops junk', () => {
    const cfg = mergeConfig({
      version: 5,
      modern: {
        timelineOpen: 'always',
        showThoughts: false,
        font: 'content',
        answerSize: 16,
        promptTint: '#22c55e',
        failedColor: 'red',
        stepIcons: { read: 'Bot', edit: 'NotAnIcon', bogus: 'Bot' },
      },
    });
    expect(cfg.modern.timelineOpen).toBe('always');
    expect(cfg.modern.showThoughts).toBe(false);
    expect(cfg.modern.font).toBe('content');
    expect(cfg.modern.answerSize).toBe(16);
    expect(cfg.modern.promptTint).toBe('#22c55e');
    expect(cfg.modern.failedColor).toBeNull();
    expect(cfg.modern.stepIcons.read).toBe('Bot');
    expect(cfg.modern.stepIcons.edit).toBe(DEFAULT_MODERN.stepIcons.edit);
    expect(cfg.modern.stepIcons).not.toHaveProperty('bogus');
  });

  it('rejects an answer size off the list', () => {
    expect(mergeConfig({ version: 5, modern: { answerSize: 99 } }).modern.answerSize).toBe(14);
    expect(MODERN_ANSWER_SIZES).toContain(14);
  });

  it('keeps an older saved config intact, adding Modern defaults', () => {
    const cfg = mergeConfig({ version: 5, cardBorderRadius: 4 });
    expect(cfg.cardBorderRadius).toBe(4);
    expect(cfg.modern).toEqual(DEFAULT_MODERN);
  });

  describe('modernCssVars', () => {
    it('uses Geist and 14/20 by default, leaving the tints to the stylesheet', () => {
      const v = modernCssVars(DEFAULT_MODERN);
      expect(v['--modern-font']).toMatch(/^'Geist'/);
      expect(v['--modern-answer-size']).toBe('14px');
      expect(v['--modern-answer-leading']).toBe('20px');
      expect(v['--modern-prompt-tint']).toBeNull();
    });

    it('follows the Typography content font and a chosen tint', () => {
      const v = modernCssVars({ ...DEFAULT_MODERN, font: 'content', answerSize: 16, promptTint: '#22c55e' });
      expect(v['--modern-font']).toBe('var(--chat-content-font)');
      expect(v['--modern-answer-size']).toBe('16px');
      expect(v['--modern-answer-leading']).toBe('23px');
      expect(v['--modern-prompt-tint']).toBe('#22c55e');
    });
  });
});
