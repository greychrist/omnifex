/**
 * Every control request a host can send the Claude CLI over stream-json, and
 * what OmniFex does about each.
 *
 * The list is the SDK client's own (`this.request({subtype})` in the CLI
 * bundle, 55 as of 2.1.310) plus `initialize`, which the SDK sends separately.
 * It is data, not code: a request becomes a capability by being wired through
 * `queries.ts` / the handler map like any other, at which point it flips to
 * `wired` here. Two checks keep the catalog honest:
 *
 *  - `cli-control-catalog.test.ts` — `wired` is exactly what the daemon sends.
 *  - `npm run cli-review:diff` — a request the CLI offers and this catalog has
 *    never classified is listed on every release review, so a new capability
 *    gets a decision instead of scrolling past in a list of 38.
 *
 * `params` is the request body as the SDK sends it (2.1.310), kept for the
 * `planned` ones so wiring one later starts from the real shape.
 */

export type CliControlStatus =
  /** OmniFex sends it. */
  | 'wired'
  /** Worth having; not built yet. */
  | 'planned'
  /** Deliberately not used — the note says why. */
  | 'declined';

export interface CliControlEntry {
  status: CliControlStatus;
  /** Request body after `subtype`, as the SDK sends it. */
  params?: string;
  note: string;
}

export const CLI_CONTROL_REQUESTS: Readonly<Record<string, CliControlEntry>> = {
  // ── wired ──
  initialize: { status: 'wired', note: 'Model and command catalogs (models.ts, commands-catalog.ts).' },
  interrupt: { status: 'wired', note: 'Stop button.' },
  set_model: { status: 'wired', note: 'Model picker. A PreModelSwitch hook can refuse it.' },
  set_permission_mode: { status: 'wired', note: 'Permission-mode picker.' },
  apply_flag_settings: { status: 'wired', note: 'Effort and fast mode.' },
  rename_session: { status: 'wired', note: 'Session rename.' },
  generate_session_title: { status: 'wired', note: 'Suggested titles.' },
  side_question: { status: 'wired', note: 'Side chat.' },
  get_context_usage: { status: 'wired', note: 'Context meter.' },
  get_status: { status: 'wired', note: '/status rows.' },
  get_usage: { status: 'wired', note: 'Live usage.' },
  get_task_output: { status: 'wired', note: 'Background shell output.' },
  list_permission_rules: { status: 'wired', note: 'Permission rules the CLI actually loaded.' },
  mcp_status: { status: 'wired', note: 'MCP panel.' },
  mcp_toggle: { status: 'wired', note: 'MCP row ⋯ Enable / Disable.' },
  mcp_authenticate: { status: 'wired', note: 'MCP row ⋯ Authenticate.' },
  mcp_clear_auth: { status: 'wired', note: 'MCP row ⋯ Re-authenticate.' },
  reload_plugins: { status: 'wired', note: 'Plugin list refresh.' },

  // ── tasks ──
  stop_task: { status: 'wired', params: '{task_id}', note: 'Stop one background shell or agent from its status-bar row.' },
  background_tasks: {
    status: 'wired',
    params: '{tool_use_id?}',
    note: 'Ctrl+B: move a running foreground Bash or subagent to the background; without tool_use_id, all of them.',
  },
  cancel_async_message: { status: 'planned', params: '{message_uuid}', note: 'Withdraw a queued prompt before the CLI takes it.' },

  // ── MCP ──
  mcp_reconnect: { status: 'wired', params: '{serverName}', note: 'MCP row ⋯ Reconnect for a failed or stuck server.' },
  mcp_oauth_callback_url: {
    status: 'wired',
    params: '{serverName, callbackUrl}',
    note: 'Finish MCP OAuth by pasting the redirect URL — sign-in from the iPad, where the localhost callback cannot land.',
  },
  mcp_read_resource: {
    status: 'planned',
    params: '{serverName, uri}',
    note: 'Read an MCP Apps ui:// resource to render a tool\'s UI (untrusted HTML; render sandboxed).',
  },
  set_mcp_permission_mode_override: {
    status: 'planned',
    params: '{serverName, mode}',
    note: 'Per-server permission mode from the MCP row.',
  },
  mcp_set_servers: { status: 'declined', params: '{servers}', note: 'Replaces SDK-hosted MCP servers; OmniFex hosts none.' },
  channel_enable: { status: 'declined', params: '{serverName}', note: 'Channels (pushed MCP messages) are not surfaced in OmniFex.' },

  // ── sign-in ──
  claude_authenticate: {
    status: 'wired',
    params: '{loginWithClaudeAi}',
    note: 'Account sign-in (auth/claude-auth.ts): replies {manualUrl, automaticUrl}. Replaced the `claude auth login` pty.',
  },
  claude_oauth_callback: { status: 'wired', params: '{authorizationCode, state}', note: 'Sign-in by pasted code.' },
  claude_oauth_wait_for_completion: { status: 'wired', params: '{}', note: 'Sign-in finished in the browser.' },

  // ── settings and reloads ──
  get_settings: { status: 'planned', params: '{}', note: 'The CLI\'s merged settings, instead of re-deriving them from files.' },
  update_settings: { status: 'planned', params: '{source, settings}', note: 'Write a settings layer through the CLI.' },
  reload_skills: { status: 'planned', params: '{}', note: 'Pick up new or edited skills without restarting the session.' },
  reload_output_styles: { status: 'planned', params: '{}', note: 'Same, for output styles.' },
  set_max_thinking_tokens: {
    status: 'wired',
    params: '{max_thinking_tokens, thinking_display}',
    note: 'Sent at every start with thinking_display "summarized" only (no budget), so thinking streams as text.',
  },
  set_cwd: { status: 'planned', params: '{path, trust_accepted?}', note: 'Move a live session to another folder.' },
  set_prompt_suggestions_paused: { status: 'planned', params: '{paused}', note: 'Pause the CLI\'s prompt suggestions.' },

  // ── the CLI's own dialogs, as data ──
  get_hooks_listing: { status: 'planned', params: '{}', note: 'The hooks the CLI actually loaded, beside the hooks editor.' },
  get_memory_dialog: { status: 'planned', params: '{}', note: 'The /memory view.' },
  get_skills_dialog: { status: 'planned', params: '{}', note: 'The /skills view.' },
  get_sandbox_dialog: { status: 'planned', params: '{}', note: 'The /sandbox view.' },
  get_plan: { status: 'planned', params: '{}', note: 'The current plan-mode plan.' },
  export_conversation: { status: 'planned', params: '{}', note: 'The CLI\'s own conversation export.' },

  // ── declined ──
  rewind_files: { status: 'declined', params: '{user_message_id, dry_run?}', note: 'Rewind is parked (2026-10-14); not pursued.' },
  read_file: { status: 'declined', params: '{path, max_bytes?, encoding?}', note: 'The daemon reads files itself.' },
  seed_read_state: { status: 'declined', params: '{path, mtime}', note: 'Read-before-edit bookkeeping for hosts that edit files themselves.' },
  claim_session: { status: 'declined', params: '{include_initialize?}', note: 'Hand-off between SDK hosts; OmniFex owns its sessions.' },
  remote_control: { status: 'declined', params: '{enabled, name?}', note: 'claude.ai Remote Control; OmniFex Remote is its own.' },
  ultrareview_launch: { status: 'declined', params: '{args, confirm?}', note: 'Billed cloud review; user-triggered from the CLI only.' },
  submit_feedback: { status: 'declined', params: '{description, …}', note: 'Product feedback to Anthropic; not OmniFex\'s to send.' },
  submit_survey_feedback: { status: 'declined', params: '{…}', note: 'Survey events; the host must not send them without logs_followup.' },
  message_rated: { status: 'declined', params: '{messageUuid, sentiment, surface, cleared?}', note: 'Thumbs ratings to Anthropic.' },
  get_chrome_browsers: { status: 'declined', note: 'Claude in Chrome pairing.' },
  get_chrome_dialog: { status: 'declined', note: 'Claude in Chrome pairing.' },
  select_chrome_browser: { status: 'declined', params: '{device_id}', note: 'Claude in Chrome pairing.' },
  set_chrome_browser_hints: { status: 'declined', note: 'Claude in Chrome pairing.' },
};
