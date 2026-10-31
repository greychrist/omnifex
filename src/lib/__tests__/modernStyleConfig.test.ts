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
    expect(m.answerCardColor).toBeNull();
    expect(m.promptSaturation).toBe(100);
    expect(m.answerCardSaturation).toBe(100);
    expect(m.promptBrightness).toBe(100);
    expect(m.answerCardBrightness).toBe(100);
    // The failed step is not a card: its colour has no saturation of its own.
    expect(m).not.toHaveProperty('failedSaturation');
    expect(m.promptShadow).toBe(true);
    expect(m.answerCardShadow).toBe(true);
    expect(m.promptColorEnabled).toBe(true);
    expect(m.answerCardColorEnabled).toBe(true);
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
        answerCardColor: '#0ea5e9',
        stepIcons: { read: 'Bot', edit: 'NotAnIcon', bogus: 'Bot' },
      },
    });
    expect(cfg.modern.timelineOpen).toBe('always');
    expect(cfg.modern.showThoughts).toBe(false);
    expect(cfg.modern.font).toBe('content');
    expect(cfg.modern.answerSize).toBe(16);
    expect(cfg.modern.promptTint).toBe('#22c55e');
    expect(cfg.modern.failedColor).toBeNull();
    expect(cfg.modern.answerCardColor).toBe('#0ea5e9');
    expect(mergeConfig({ version: 5, modern: { answerCardColor: 'teal' } }).modern.answerCardColor).toBeNull();
    expect(cfg.modern.stepIcons.read).toBe('Bot');
    expect(cfg.modern.stepIcons.edit).toBe(DEFAULT_MODERN.stepIcons.edit);
    expect(cfg.modern.stepIcons).not.toHaveProperty('bogus');
  });

  it('keeps a saturation or brightness from 0 to 200 percent and drops anything else', () => {
    const ok = mergeConfig({ version: 5, modern: { promptSaturation: 0, answerCardSaturation: 65, promptBrightness: 200, answerCardBrightness: 40 } }).modern;
    expect([ok.promptSaturation, ok.answerCardSaturation, ok.promptBrightness, ok.answerCardBrightness]).toEqual([0, 65, 200, 40]);
    const bad = mergeConfig({ version: 5, modern: { promptSaturation: -5, answerCardSaturation: '50', promptBrightness: 201, answerCardBrightness: null, failedSaturation: 50 } }).modern;
    expect([bad.promptSaturation, bad.answerCardSaturation, bad.promptBrightness, bad.answerCardBrightness]).toEqual([100, 100, 100, 100]);
    expect(bad).not.toHaveProperty('failedSaturation');
  });

  it('keeps a saved drop shadow choice and drops anything that is not a boolean', () => {
    const ok = mergeConfig({ version: 5, modern: { promptShadow: false, answerCardShadow: false } }).modern;
    expect([ok.promptShadow, ok.answerCardShadow]).toEqual([false, false]);
    const bad = mergeConfig({ version: 5, modern: { promptShadow: 'no', answerCardShadow: 0 } }).modern;
    expect([bad.promptShadow, bad.answerCardShadow]).toEqual([true, true]);
  });

  it('keeps a saved color on/off choice and drops anything that is not a boolean', () => {
    const ok = mergeConfig({ version: 5, modern: { promptColorEnabled: false, answerCardColorEnabled: false } }).modern;
    expect([ok.promptColorEnabled, ok.answerCardColorEnabled]).toEqual([false, false]);
    const bad = mergeConfig({ version: 5, modern: { promptColorEnabled: 'off', answerCardColorEnabled: null } }).modern;
    expect([bad.promptColorEnabled, bad.answerCardColorEnabled]).toEqual([true, true]);
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
      // Unset: the stylesheet's own emerald and blue, at full strength.
      expect(v['--modern-final-hue']).toBeNull();
      expect(v['--modern-final-tint']).toBeNull();
      expect(v['--modern-prompt-hue']).toBeNull();
      expect(v['--modern-final-saturation']).toBeNull();
      expect(v['--modern-prompt-saturation']).toBeNull();
      expect(v['--modern-final-brightness']).toBeNull();
      expect(v['--modern-prompt-brightness']).toBeNull();
    });

    it('hands the prompt bubble the hue of its chosen tint', () => {
      const v = modernCssVars({ ...DEFAULT_MODERN, promptTint: '#0000ff' });
      expect(Number(v['--modern-prompt-hue'])).toBeCloseTo(264.1, 0);
      // The tint itself still colours the bubble's shadow.
      expect(v['--modern-prompt-tint']).toBe('#0000ff');
    });

    // White, grey or black has no hue — reading one off it gave a brown card.
    // A neutral pick is a card with no tint, whatever the slider says.
    it('draws a white, grey or black pick as an untinted card', () => {
      const v = modernCssVars({ ...DEFAULT_MODERN, promptTint: '#ffffff', answerCardColor: '#808080', answerCardSaturation: 150 });
      expect(v['--modern-prompt-saturation']).toBe('0');
      expect(v['--modern-final-saturation']).toBe('0');
    });

    it('keeps the slider for a pale but real colour', () => {
      const v = modernCssVars({ ...DEFAULT_MODERN, answerCardColor: '#e0e7ff', answerCardSaturation: 150 });
      expect(v['--modern-final-saturation']).toBe('1.5');
    });

    it('turns each card brightness into a multiplier of the built-in lift', () => {
      const v = modernCssVars({ ...DEFAULT_MODERN, promptBrightness: 50, answerCardBrightness: 200 });
      expect(v['--modern-prompt-brightness']).toBe('0.5');
      expect(v['--modern-final-brightness']).toBe('2');
    });

    it('turns each card saturation into a multiplier of the built-in strength', () => {
      const v = modernCssVars({ ...DEFAULT_MODERN, promptSaturation: 50, answerCardSaturation: 150 });
      expect(v['--modern-prompt-saturation']).toBe('0.5');
      expect(v['--modern-final-saturation']).toBe('1.5');
    });

    it('hands the answer card the hue of its chosen colour', () => {
      const v = modernCssVars({ ...DEFAULT_MODERN, answerCardColor: '#ff0000' });
      expect(Number(v['--modern-final-hue'])).toBeCloseTo(29.2, 0);
      // The colour itself tints its drop shadow, as the prompt's does.
      expect(v['--modern-final-tint']).toBe('#ff0000');
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
