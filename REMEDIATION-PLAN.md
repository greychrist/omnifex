# Remediation Plan — assess/remediation-2026-05-30

Generated unattended overnight 2026-05-30 from the six-agent architectural assessment.
Baseline before any change: `npm run check` clean; `npm test` = 166 files, 2248 passed, 1 skipped.

**Branch is intentionally NOT merged to main.** Review + run in test mode before merging.

## Execution order (low-risk/high-confidence first)

### Wave 1 — Backend critical, isolated, TDD
- [ ] **F4** `setProjectOverride` normalize path on write (`accounts.ts:407`). Test: trailing-slash/tilde override resolves.
- [ ] **F1** Gate `storage_execute_sql` + `storage_reset_database` behind `!app.isPackaged` (dev-only). Test: packaged → throws; dev → runs.
- [ ] **F3** JSONL tail: `pendingTail` as Buffer; split on `0x0A`; decode complete lines only (`jsonl-tail.ts`). Test: multibyte codepoint split across two drains survives.
- [ ] **F5** Delete 7 dead api.ts channels; fix/remove `sessionStore.fetchSessionOutput` caller. Test: none call removed channels.

### Wave 2 — Backend structural guardrails
- [ ] **IPC tie test**: assert allow-list ⊇/= handler map ∪ main.ts extras (kills dead-channel class).
- [ ] **F6** Config-edit IPC: validate `configDir` ∈ known account config dirs (positive ownership). Test: foreign dir rejected.
- [ ] **F10** Usage scan: cache parsed file results by `(path, mtimeMs)`; drop `entries` blob from log metadata. Test: cache hit on unchanged mtime; log metadata has no entries array.
- [ ] **Schema drift**: bring `initSchema` accounts table to post-v11 shape. Test: fresh DB schema matches migrated DB schema.
- [ ] **Accounts priority ordering** unify three sites (or remove unused priority). Test: ordering parity.

### Wave 3 — Sessions lifecycle races, TDD
- [ ] **F2** Engine restart child-generation guard (`runtime.ts`/`claude-cli-engine.ts`). Test: restart does not delete current session.
- [ ] **F8** Decide onError→error path: wire it (make recovery real) + test, OR delete `ensureLiveEngine`/`restartQuery` + fix doc. Chosen: WIRE (recovery is valuable). Test: stream error → error → next send restarts.
- [ ] **F9** Unify in-flight derivation: popover path consumes same selectors as spinner path. Test: pending-todo session reads identical busy in both.
- [ ] TUI cold-start zombie handle on spawn throw (`lifecycle.ts:719`). Test.
- [ ] JSONL rotation/shrink replay guard for filter:'all'.

### Wave 4 — Engine-layer tests (the untested core)
- [ ] Tests for `agents/claude-cli-engine.ts`, `codex-cli-engine.ts`, `json-rpc-client.ts`, `codex-binary.ts`.
- [ ] Tests for `auth/codex-auth.ts`.

### Wave 5 — Renderer perf + decomposition
- [ ] **F7** StreamMessage O(N²): lift tool-result map to one useMemo in ClaudeTranscript; custom areEqual; reintroduce windowing for static region.
- [ ] **H1** Memoize TabContext + AccountsContext provider value objects.
- [ ] **H2/H3** Decompose `AgentSession.tsx`: memoize `useTabSession` setters (root cause), remove `streamCtxRef`, extract header/side-panels/prompt-bar. Delete orphaned `sessionStore.ts` if unused; delete dead `View` branches + `previousView` in App.tsx; hoist project-browser flow.
- [ ] **M1** ProxySettings → api.ts wrappers.
- [ ] **M2** SessionList summary cache by id.
- [ ] respondPermission requestId: thread through or drop param.
- [ ] Tab.sessionData / useNotifications `any` typing tightened.

### Wave 6 — Cleanup + docs
- [ ] Delete `.sdk-removed` test files (port any still-relevant cases first).
- [ ] Delete orphaned `*.original.tsx` / `*.optimized.tsx`.
- [ ] Delete `TODO.md` (SDK-era) + `SDK-Hooks.md`. Rewrite or remove.
- [ ] Update `CLAUDE.md` + `src/CLAUDE.md`: fix dead paths, add Codex/Lima/worktrees/rate-limits/one-shot.
- [ ] Stale comments (claude.ts:101/205, events.ts:18-31, runtime.ts doc).
- [ ] Migration source ordering readability.

### Wave 7 — Verify + re-assess loop
- [ ] `npm run check` + `npm test` + `npm run test:coverage` green, ≥80% lines.
- [ ] Re-run multi-agent assessment; confirm each finding cleared. Loop until clean.
- [ ] `npm run rebuild:electron` (leave app launchable for Greg).

## STATUS (end of unattended run)

All waves landed except the items below. `npm run check`, `npm run build`, `npm test` all green; coverage run at the end. Branch NOT merged.

### Deliberately deferred (need visual QA — exactly the review you reserved)
- **AgentSession.tsx full decomposition (H2/H3 extraction).** Root cause fixed
  (useTabSession setters are now memoized/stable — test-backed), but the
  `streamCtxRef` shim and the 2442-line component were NOT split. Extracting
  header/side-panel/prompt-bar subtrees and removing streamCtxRef is a
  high-visual-risk change that can't be verified without running the app and
  watching a live stream. Left for your review session.
- **F7 full lift-and-slice of StreamMessage tool-result resolution.** Did the
  safe slice (effect+state → useMemo, removes the double-render/flash). The full
  O(N²)→O(N) fix is blocked because `streamMessages` is woven through ~15 call
  sites in StreamMessage (classification, skill detection, completion band,
  inline tool-result scans) — not a clean extraction.
- **M2 SessionList per-row summary cache** — pure optimization, contained but
  unverified-visually; left as a follow-up.
- **App.tsx dead `View` switch + `previousView`, and `Tab.sessionData: any` /
  `useNotifications` typing** — low-value, cascade-risk; left for review.
- **L3 migration source ordering (v4 before v3)** — runner sorts by version, so
  it's correct; physical reorder skipped to avoid SQL-block risk for zero
  behavior change.

## Decisions made unattended
- **Codex per-account routing** (CODEX_HOME): documented Non-Goal; left as-is, documented in CLAUDE.md. Not expanding into a risky feature overnight.
- **F8**: wire onError→error (recovery path made real) rather than delete.
- **Storage SQL**: dev-gate rather than remove (it's an intentional admin tool).
- **God component**: fix root cause (memoize useTabSession setters) then extract presentational subtrees; do not rewrite stream logic.
