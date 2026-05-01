import { describe, it, expect } from 'vitest';
import { todoBarReducer, type TodoBarState } from '../todoBarState';

const collapsed: TodoBarState = { kind: 'collapsed_idle' };
const auto: TodoBarState = { kind: 'expanded_auto' };
const pinned: TodoBarState = { kind: 'expanded_pinned' };

describe('todoBarReducer', () => {
  describe('from collapsed_idle', () => {
    it('TODOS_CHANGED → expanded_auto', () => {
      expect(todoBarReducer(collapsed, { type: 'TODOS_CHANGED' })).toEqual(auto);
    });

    it('CLICK → expanded_pinned', () => {
      expect(todoBarReducer(collapsed, { type: 'CLICK' })).toEqual(pinned);
    });

    it('TIMER_EXPIRED → collapsed_idle (no-op)', () => {
      expect(todoBarReducer(collapsed, { type: 'TIMER_EXPIRED' })).toEqual(collapsed);
    });
  });

  describe('from expanded_auto', () => {
    it('TIMER_EXPIRED → collapsed_idle', () => {
      expect(todoBarReducer(auto, { type: 'TIMER_EXPIRED' })).toEqual(collapsed);
    });

    it('CLICK → collapsed_idle (cancels auto)', () => {
      expect(todoBarReducer(auto, { type: 'CLICK' })).toEqual(collapsed);
    });

    it('TODOS_CHANGED → expanded_auto (extends visible window)', () => {
      expect(todoBarReducer(auto, { type: 'TODOS_CHANGED' })).toEqual(auto);
    });
  });

  describe('from expanded_pinned', () => {
    it('CLICK → collapsed_idle', () => {
      expect(todoBarReducer(pinned, { type: 'CLICK' })).toEqual(collapsed);
    });

    it('TODOS_CHANGED → expanded_pinned (no auto-collapse, no timer reset)', () => {
      expect(todoBarReducer(pinned, { type: 'TODOS_CHANGED' })).toEqual(pinned);
    });

    it('TIMER_EXPIRED → expanded_pinned (no-op; pin defeats timer)', () => {
      expect(todoBarReducer(pinned, { type: 'TIMER_EXPIRED' })).toEqual(pinned);
    });
  });
});
