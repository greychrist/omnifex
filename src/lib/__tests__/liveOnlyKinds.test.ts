import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import {
  CATEGORIES,
  KIND_REGISTRY,
  createDefaultConfig,
  mergeConfig,
  resolveKind,
} from '../messageRenderingConfig';
import { classifyStandaloneKind } from '../messageKind';
import { withoutNeverShown } from '../compactGrouping';
import { filterDisplayableMessages } from '../messageFilters';
import { JSONL_CARRIED_SYSTEM_SUBTYPES } from '../../../electron/services/sessions/stream-forward';

// The Live-only section groups the kinds a reload loses: records the CLI sends
// on stream-json stdout and never writes to the session file. Which subtypes
// those are is decided once, main-side, by stream-forward's
// JSONL_CARRIED_SYSTEM_SUBTYPES; this pins the settings tree to that list so
// the two cannot drift.

const system = (subtype: string, extra: Record<string, unknown> = {}): JsonlNode =>
  ({
    kind: 'system', subtype, sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype, ...extra },
  }) as unknown as JsonlNode;

// Every system subtype with a registry kind of its own.
const SUBTYPES = [
  'notification',
  'hook_started',
  'hook_response',
  'permission_denied',
  'thinking_tokens',
  'user_prompt_submit',
  'feedback_draft_queued',
  'background_tasks_changed',
  'dev_intent',
  'per_turn_effort_changed',
  'elicitation_complete',
  'session_metadata',
  'session_title_changed',
  'ui_log',
  'ui_toast',
  'ui_invalidate',
  'ui_focus',
  'ui_panes',
  'ui_scroll',
  'ui_status',
  'commands_changed',
  'permission_check_status',
  'away_summary',
  'local_command',
  'stop_hook_summary',
];

// Stream-only CLI bookkeeping: nothing to say in the transcript unless asked.
const BOOKKEEPING = [
  'background_tasks_changed',
  'dev_intent',
  'per_turn_effort_changed',
  'elicitation_complete',
  'session_metadata',
  'session_title_changed',
  // Mod plumbing from a headless session (CLI >= 2.1.287). ui_status is read
  // by the Session context panel's Mods section instead.
  'ui_invalidate',
  'ui_focus',
  'ui_panes',
  'ui_scroll',
  'ui_status',
  'commands_changed',
  // CLI 2.1.292: a slow automatic permission check, `checking` then `done`.
  'permission_check_status',
];

describe('Live-only section', () => {
  it('is a category of its own', () => {
    expect(CATEGORIES).toContain('live');
  });

  it.each(SUBTYPES)('files system:%s by whether the CLI writes it to disk', (subtype) => {
    const id = classifyStandaloneKind(system(subtype), []);
    expect(id).not.toBeNull();
    expect(id).not.toBe('system.unknown');
    const expected = JSONL_CARRIED_SYSTEM_SUBTYPES.has(subtype) ? 'system' : 'live';
    expect(KIND_REGISTRY[id!]?.category).toBe(expected);
  });

  it('holds rate_limit_event, which is forwarded from the stream, not the tail', () => {
    expect(KIND_REGISTRY['system.rate_limit'].category).toBe('live');
  });

  it('holds the synthetic control-change markers, which exist only in the live session', () => {
    for (const id of ['control.effort', 'control.model', 'control.permission']) {
      expect(KIND_REGISTRY[id].category).toBe('live');
    }
  });

  it('keeps kind ids unchanged, so saved per-kind overrides still apply', () => {
    const cfg = mergeConfig({
      ...createDefaultConfig(),
      kinds: { 'system.thinking_tokens': { visibility: 'always' } },
    });
    expect(resolveKind(cfg, 'system.thinking_tokens').visibility).toBe('always');
  });

  it('gives a config saved before the section existed the default Live-only style', () => {
    const saved = createDefaultConfig() as unknown as { categories: Record<string, unknown> };
    delete saved.categories.live;
    const cfg = mergeConfig(saved);
    expect(cfg.categories.live).toEqual(createDefaultConfig().categories.live);
  });
});

describe('stream-only bookkeeping kinds', () => {
  it.each(BOOKKEEPING)('system:%s defaults to Never', (subtype) => {
    const id = classifyStandaloneKind(system(subtype), [])!;
    expect(id).toBe(`system.${subtype}`);
    expect(resolveKind(createDefaultConfig(), id).visibility).toBe('never');
  });

  it.each(BOOKKEEPING)('system:%s is hidden by the Never setting, not by a hard-coded filter', (subtype) => {
    const node = system(subtype);
    expect(filterDisplayableMessages([node])).toHaveLength(1);
    expect(withoutNeverShown([node], createDefaultConfig())).toHaveLength(0);
  });

  it.each(BOOKKEEPING)('system:%s is drawn once switched on', (subtype) => {
    const cfg = createDefaultConfig();
    cfg.kinds[`system.${subtype}`] = { visibility: 'always' };
    expect(withoutNeverShown([system(subtype)], cfg)).toHaveLength(1);
  });
});
