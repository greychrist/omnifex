// v5's defaults are frozen here: the registry now carries v6 defaults, and a kind v5 never set means v5's default.
// standardVisibility.golden.test.ts checks every kind.
import { CATEGORIES, KIND_REGISTRY, categoryOf, type Category } from './messageRenderingConfig';

type V5Visibility = 'always' | 'verbose' | 'never';
type V5RecordRules = 'compact' | 'verbose' | 'all';

/** Also the kinds Settings › Chats leaves out of its kinds list. */
export const MODERN_ITEM_KINDS: ReadonlySet<string> = new Set([
  'assistant.text',
  'assistant.text.endTurn',
  'assistant.thinking',
  'assistant.tool-use',
  'assistant.askUserQuestion',
  'system.thinking_tokens',
  'user.skillInjection',
  'user.sdkSystemBracket',
  'system.api_error',
  'system.notification.info',
  'system.notification.warn',
  'system.notification.error',
  'system.notification.stop',
  'system.compact_boundary',
  'user.compactSummary',
  'user.prompt',
  'user.image',
  'user.command',
]);

const V5_KIND_VISIBILITY: Readonly<Record<string, V5Visibility>> = {
  "assistant.thinking": "verbose",
  "assistant.tool-use": "verbose",
  "assistant.askUserQuestion": "always",
  "user.commandOutput": "verbose",
  "user.systemContext": "always",
  "user.taskNotification": "verbose",
  "user.coordinatorMessage": "verbose",
  "user.tool-result": "verbose",
  "user.tool-result.image": "always",
  "user.compactSummary": "always",
  "system.notification.info": "always",
  "system.notification.warn": "always",
  "system.notification.error": "always",
  "system.notification.stop": "always",
  "system.hook_started": "never",
  "system.hook_response": "never",
  "system.hook_progress": "never",
  "system.permission_denied": "always",
  "system.api_error": "always",
  "system.away_summary": "always",
  "system.thinking_tokens": "verbose",
  "system.rate_limit": "verbose",
  "system.progress": "always",
  "system.feedback_draft_queued": "always",
  "system.local_command": "always",
  "system.stop_hook_summary": "verbose",
  "system.compact_boundary": "always",
  "system.init": "verbose",
  "system.result": "verbose",
  "system.background_tasks_changed": "never",
  "system.dev_intent": "never",
  "system.per_turn_effort_changed": "never",
  "system.elicitation_complete": "never",
  "system.session_metadata": "never",
  "system.session_title_changed": "never",
  "system.ui_status": "never",
  "system.ui_invalidate": "never",
  "system.ui_focus": "never",
  "system.ui_panes": "never",
  "system.ui_placed": "never",
  "system.ui_notify": "never",
  "system.ui_notify_cancel": "never",
  "system.ui_scroll": "never",
  "system.permission_check_status": "never",
  "system.commands_changed": "never",
  "system.ui_log": "always",
  "system.ui_toast": "always",
  "permission.request": "always",
  "permission.askUserQuestion": "always",
  "summary.compaction": "always",
  "unknown": "always",
  "permission-mode": "always",
  "last-prompt": "verbose",
  "ai-title": "verbose",
  "custom-title": "verbose",
  "queue-operation": "verbose",
  "file-history-snapshot": "verbose",
  "attachment.instructions": "always",
  "attachment.nested_memory": "verbose",
  "attachment.mcp_instructions_delta": "verbose",
  "attachment.agent_listing_delta": "verbose",
  "attachment.deferred_tools_delta": "verbose",
  "attachment.skill_listing": "verbose",
  "attachment.project_doc_reads": "always",
  "control.effort": "always",
  "control.model": "always",
  "control.permission": "always",
};

const V5_ALWAYS_SHOWN: ReadonlySet<string> = new Set(["assistant.text.endTurn", "user.prompt", "summary.compaction"]);

const V5_CATEGORY_VISIBILITY: Readonly<Record<Category, V5Visibility>> = {
  user: 'always', agent: 'always', system: 'verbose', live: 'verbose',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function visibilityOf(raw: unknown): V5Visibility | undefined {
  if (!isRecord(raw)) return undefined;
  const v = raw.visibility;
  if (v === 'always' || v === 'verbose' || v === 'never') return v;
  if (typeof raw.hiddenInCompact === 'boolean') return raw.hiddenInCompact ? 'verbose' : 'always';
  return undefined;
}

function pick(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(raw)) return out;
  for (const f of fields) if (f in raw) out[f] = raw[f];
  return out;
}

function shownInV5(visibility: V5Visibility, alwaysShown: boolean, item: boolean, rules: V5RecordRules): boolean {
  if (alwaysShown || rules === 'all') return true;
  if (visibility === 'never') return false;
  if (item || rules === 'verbose') return true;
  return visibility === 'always';
}

export function migrateV5(saved: Record<string, unknown>): Record<string, unknown> {
  const savedModern = isRecord(saved.modern) ? saved.modern : {};
  const r = savedModern.recordRules;
  const rules: V5RecordRules = r === 'verbose' || r === 'all' ? r : 'compact';
  const savedCategories = isRecord(saved.categories) ? saved.categories : {};
  const savedKinds = isRecord(saved.kinds) ? saved.kinds : {};

  const categories: Record<string, Record<string, unknown>> = {};
  const categoryVisibility = {} as Record<Category, V5Visibility>;
  for (const c of CATEGORIES) {
    const sc = savedCategories[c];
    const visibility = visibilityOf(sc) ?? V5_CATEGORY_VISIBILITY[c];
    categoryVisibility[c] = visibility;
    categories[c] = { ...pick(sc, ['label', 'description', 'accentColor', 'icon']), standard: shownInV5(visibility, false, false, rules) };
  }

  const kinds: Record<string, Record<string, unknown>> = {};
  for (const [id, patch] of Object.entries(savedKinds)) {
    const kept = pick(patch, ['accentColor', 'icon']);
    if (Object.keys(kept).length > 0) kinds[id] = kept;
  }

  for (const id of new Set([...Object.keys(KIND_REGISTRY), ...Object.keys(savedKinds)])) {
    const patch = savedKinds[id];
    const category = categoryOf(id);
    const visibility = visibilityOf(patch) ?? V5_KIND_VISIBILITY[id] ?? categoryVisibility[category];
    const savedLock = isRecord(patch) && typeof patch.compactBoundaryLocked === 'boolean' ? patch.compactBoundaryLocked : undefined;
    const alwaysShown = savedLock ?? V5_ALWAYS_SHOWN.has(id);
    // An unrecognized record had no kind in v5: Compact hid it, Verbose and All drew it.
    const target = id === 'unknown'
      ? rules !== 'compact'
      : shownInV5(visibility, alwaysShown, MODERN_ITEM_KINDS.has(id), rules);
    const v6Default = KIND_REGISTRY[id]?.default;
    const v6Shown = Boolean(v6Default?.alwaysShown) || (v6Default?.standard ?? (categories[category].standard as boolean));
    if (v6Shown !== target) kinds[id] = { ...kinds[id], standard: target };
  }

  const { recordRules: _recordRules, ...modern } = savedModern;
  const typography = isRecord(saved.typography) ? { content: saved.typography.content } : undefined;
  const { hiddenEvents: _hiddenEvents, typography: _typography, ...rest } = saved;
  return { ...rest, version: 6, categories, kinds, modern, ...(typography ? { typography } : {}) };
}
