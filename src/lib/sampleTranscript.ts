/**
 * One transcript holding at least one record of every message kind a record
 * can produce, in a plausible order. Settings › Chats › Turn preview draws
 * it, so Expanded shows every kind and Standard what the kinds list lets
 * through. The golden test pins what Standard draws from it; Expanded must
 * draw every record in it. Changing a record here changes the goldens.
 *
 * Synthetic on purpose: real transcripts carry private text. Each record is
 * the smallest shape the classifier keys on (messageKind.ts, jsonlClassifier.ts).
 */
import type { JsonlNode } from '@/types/jsonl';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import { normalizeJsonlNode } from '@/lib/normalizeMessage';

let seq = 0;
const at = () => new Date(Date.UTC(2026, 10, 18, 10, 0, seq)).toISOString();

function rec(kindId: string, raw: Record<string, unknown>): [string, JsonlNode] {
  seq += 1;
  const node = classifyJsonlLine({ uuid: `u-${String(seq).padStart(3, '0')}-${kindId}`, timestamp: at(), sessionId: 's1', ...raw });
  if (!node) throw new Error(`fixture record for ${kindId} did not classify`);
  return [kindId, normalizeJsonlNode(node)];
}

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', message: { id: `msg_${seq + 1}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: 5 } }, ...extra });
const system = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype, ...extra });
const text = (t: string) => ({ type: 'text', text: t });

function control(control: 'effort' | 'model' | 'permission', value: string): [string, JsonlNode] {
  seq += 1;
  return [`control.${control}`, { kind: 'control-change', control, value, sessionId: 's1', receivedAt: at() } as JsonlNode];
}

const entries: [string, JsonlNode][] = [
  rec('system.init', { type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: [], cwd: '/repo' }),
  rec('permission-mode', { type: 'permission-mode', permissionMode: 'acceptEdits' }),
  rec('file-history-snapshot', { type: 'file-history-snapshot', messageId: 'm0', snapshot: {} }),
  rec('attachment.instructions', { type: 'attachment', attachment: { type: 'instructions', content: 'Be terse.' } }),
  rec('attachment.nested_memory', { type: 'attachment', attachment: { type: 'nested_memory', path: '/repo/src/CLAUDE.md', content: 'x' } }),
  rec('attachment.mcp_instructions_delta', { type: 'attachment', attachment: { type: 'mcp_instructions_delta', added: [] } }),
  rec('attachment.agent_listing_delta', { type: 'attachment', attachment: { type: 'agent_listing_delta', added: [] } }),
  rec('attachment.deferred_tools_delta', { type: 'attachment', attachment: { type: 'deferred_tools_delta', added: [] } }),
  rec('attachment.skill_listing', { type: 'attachment', attachment: { type: 'skill_listing', content: '- a skill' } }),
  rec('attachment.project_doc_reads', { type: 'attachment', attachment: { type: 'project_doc_reads', paths: ['/repo/README.md'] } }),
  rec('user.prompt', user([text('Fix the login bug.')], { origin: { kind: 'human' } })),
  rec('user.systemContext', user([text('<system-reminder>Remember the rules.</system-reminder>')], { isMeta: true })),
  rec('assistant.thinking', assistant([{ type: 'thinking', thinking: 'Look at auth.ts first.', signature: 's' }])),
  rec('system.thinking_tokens', system('thinking_tokens', { tokens: 120 })),
  rec('assistant.tool-use', assistant([{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/repo/auth.ts' } }])),
  rec('system.hook_started', system('hook_started', { hook_name: 'PreToolUse' })),
  rec('system.hook_progress', system('hook_progress', { hook_name: 'PreToolUse', content: '…' })),
  rec('system.hook_response', system('hook_response', { hook_name: 'PreToolUse', content: 'ok' })),
  rec('user.tool-result', user([{ type: 'tool_result', tool_use_id: 'tu-read', content: 'export function login() {}' }])),
  rec('assistant.text', assistant([text('Found it; checking the caller.')])),
  rec('assistant.tool-use', assistant([{ type: 'tool_use', id: 'tu-shot', name: 'Screenshot', input: {} }])),
  rec('user.tool-result.image', user([{ type: 'tool_result', tool_use_id: 'tu-shot', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] }])),
  rec('assistant.tool-use', assistant([{ type: 'tool_use', id: 'tu-skill', name: 'Skill', input: { skill: 'commit' } }])),
  rec('user.tool-result', user([{ type: 'tool_result', tool_use_id: 'tu-skill', content: 'Launching skill: commit' }])),
  rec('user.skillInjection', user([text('# Commit\nStage and commit.')], { sourceToolUseID: 'tu-skill', isMeta: true })),
  rec('assistant.tool-use', assistant([{ type: 'tool_use', id: 'tu-agent', name: 'Agent', input: { prompt: 'Search the repo.' } }])),
  rec('user.subagentPrompt', user([text('Search the repo.')], { parent_tool_use_id: 'tu-agent' })),
  rec('user.tool-result', user([{ type: 'tool_result', tool_use_id: 'tu-agent', content: 'Found 3 files.' }])),
  rec('system.permission_denied', system('permission_denied', { tool_name: 'Bash', content: 'Denied' })),
  rec('system.progress', { type: 'progress', data: { type: 'bash_progress', output: 'running' }, toolUseID: 'tu-x' }),
  rec('system.unknown', system('api_error', { error: { message: 'Overloaded' }, retryAttempt: 1 })),
  rec('system.api_error', system('session_writes_lost', { content: 'Disk full: 3 writes lost.' })),
  rec('system.notification.info', system('notification', { notification_type: 'info', content: 'Saved.' })),
  rec('system.notification.warn', system('notification', { notification_type: 'warning', content: 'Slow.' })),
  rec('system.notification.error', system('notification', { notification_type: 'error', content: 'Failed.' })),
  rec('system.notification.stop', system('notification', { notification_type: 'stop', content: 'Stopped.' })),
  rec('system.feedback_draft_queued', system('feedback_draft_queued', { content: 'queued' })),
  rec('assistant.text.endTurn', assistant([text('Fixed: the token check was inverted.')])),
  rec('system.stop_hook_summary', system('stop_hook_summary', { hookCount: 1, hookInfos: [{ command: 'lint' }], hookErrors: [] })),
  rec('system.result', { type: 'result', subtype: 'success', result: 'done', duration_ms: 1000, total_cost_usd: 0.01, num_turns: 1, usage: {} }),
  rec('system.rate_limit', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  rec('last-prompt', { type: 'last-prompt', lastPrompt: 'Fix the login bug.' }),
  rec('ai-title', { type: 'ai-title', aiTitle: 'Fix login' }),
  rec('custom-title', { type: 'custom-title', customTitle: 'Login fix' }),
  rec('queue-operation', { type: 'queue-operation', operation: 'enqueue', content: 'next' }),
  control('effort', 'high'),
  control('model', 'claude-opus-5-5'),
  control('permission', 'plan'),
  rec('user.command', user([text('<command-name>/usage</command-name><command-message>usage</command-message><command-args></command-args>')])),
  rec('user.commandOutput', user([text('<local-command-stdout>5h: 12%</local-command-stdout>')])),
  rec('system.local_command', system('local_command', { content: '<local-command-stdout>Cost: $1</local-command-stdout>', commandRun: { command: 'cost' } })),
  rec('user.image', user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }, text('This screen.')])),
  rec('user.sdkSystemBracket', user([text('[Request interrupted by user]')])),
  rec('user.taskNotification', user([text('<task-notification>Build finished.</task-notification>')], { origin: { kind: 'task-notification' } })),
  rec('user.coordinatorMessage', user([text('Also check the tests.')], { origin: { kind: 'coordinator' } })),
  rec('assistant.askUserQuestion', assistant([{ type: 'tool_use', id: 'tu-ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] } }])),
  rec('user.tool-result', user([{ type: 'tool_result', tool_use_id: 'tu-ask', content: 'User has answered your questions: "Which branch?"="main".' }])),
  rec('permission.request', { type: 'permission_request', tool_name: 'Bash', input: { command: 'ls' }, request_id: 'r1' }),
  rec('permission.askUserQuestion', { type: 'permission_request', tool_name: 'AskUserQuestion', input: {}, request_id: 'r2' }),
  rec('system.away_summary', system('away_summary', { content: 'You fixed login.' })),
  rec('system.compact_boundary', system('compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 420000, postTokens: 20000, durationMs: 50000 } })),
  rec('user.compactSummary', user([text('This session is being continued from a previous conversation.')], { isCompactSummary: true, isVisibleInTranscriptOnly: true })),
  rec('summary.compaction', { type: 'summary', summary: 'Login fix', leafUuid: 'u-001' }),
  rec('system.background_tasks_changed', system('background_tasks_changed', { tasks: [] })),
  rec('system.dev_intent', system('dev_intent', { content: 'x' })),
  rec('system.per_turn_effort_changed', system('per_turn_effort_changed', { effort: 'high' })),
  rec('system.elicitation_complete', system('elicitation_complete', {})),
  rec('system.session_metadata', system('session_metadata', {})),
  rec('system.session_title_changed', system('session_title_changed', { title: 'Login fix' })),
  rec('system.ui_status', system('ui_status', {})),
  rec('system.ui_invalidate', system('ui_invalidate', {})),
  rec('system.ui_focus', system('ui_focus', {})),
  rec('system.ui_panes', system('ui_panes', {})),
  rec('system.ui_placed', system('ui_placed', {})),
  rec('system.ui_notify', system('ui_notify', { message: 'hi' })),
  rec('system.ui_notify_cancel', system('ui_notify_cancel', {})),
  rec('system.ui_scroll', system('ui_scroll', {})),
  rec('system.permission_check_status', system('permission_check_status', {})),
  rec('system.commands_changed', system('commands_changed', {})),
  rec('system.ui_log', system('ui_log', { message: 'mod says hi' })),
  rec('system.ui_toast', system('ui_toast', { message: 'toast' })),
  rec('system.unknown', system('turn_duration', { durationMs: 4000 })),
  rec('unknown', system('brand_new_subtype', { content: '?' })),
  rec('unknown', { type: 'brand_new_record', payload: 1 }),
  rec('user.prompt', user([text('Thanks, ship it.')], { origin: { kind: 'human' } })),
  rec('assistant.text.endTurn', assistant([text('Shipped.')])),
  // CLI state rides at the end so adding it shifted no earlier record's id.
  rec('cli-state', { type: 'session-owner', accountUuid: 'acct', organizationUuid: 'org' }),
  rec('task-lifecycle', { type: 'system', subtype: 'task_progress', task_id: 'tk', description: 'Check the appended CSS' }),
];

/** Every record, in transcript order. */
export const ALL_KIND_RECORDS: JsonlNode[] = entries.map(([, n]) => n);

/** The kind each record was written to produce (several records share one). */
export const KIND_OF_RECORD = new Map<JsonlNode, string>(entries.map(([k, n]) => [n, k]));

/** Registry kinds no transcript record produces, with why. */
export const NOT_A_RECORD: ReadonlyMap<string, string> = new Map([
  ['assistant.text.live', 'the streaming reply; replaced by its record when it lands'],
  // user_prompt_submit is not in jsonlClassifier's SYSTEM_SUBTYPES, so such a
  // record classifies as `unknown`; messageKind's branch for it is unreachable.
  ['system.userPromptSubmit', 'no record classifies to it (see above)'],
]);
