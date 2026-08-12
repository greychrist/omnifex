/**
 * Shared vocabulary for Brain source adapters.
 *
 * A "source" is anything that can produce indexable material: session
 * transcripts, repo artifacts, auto-memory notes, explicit captures. All of
 * them implement `BrainSource`, so adding one changes nothing upstream
 * (spec §5).
 */

/**
 * One candidate for indexing, with a key that is stable across restarts.
 *
 * `accountId` is derived from WHERE the item lives — never from `resolve()`,
 * never from a caller-supplied default (spec §4). An adapter that cannot
 * determine ownership must omit the item rather than guess; guessing writes
 * one account's material into another account's vault, which is the
 * confidentiality failure this whole design exists to prevent.
 */
export interface SourceItem {
  /** The adapter that produced this. Matches `BrainSource.id`. */
  sourceId: string;
  /** Unique within (accountId, sourceId). For sessions: the session id. */
  itemKey: string;
  /** The owning account. */
  accountId: number;
  /** Absolute path to the backing file. */
  path: string;
  /** Modification time in epoch ms, from `fs.stat`. */
  mtimeMs: number;
  /** Size in bytes. Half of the cheap change check. */
  size: number;
  /** Short human label for the Sources pane, e.g. the project directory. */
  label: string;
}

/**
 * Why an item was admitted or skipped.
 *
 * Spec §5 types `admit()` as returning a bare boolean. It returns this
 * instead: the reason is what the Sources pane displays, and inspecting the
 * gate's decisions before spending tokens is the stated purpose of this build
 * step. The gate itself is unchanged — still deterministic, still no model.
 */
export interface AdmitVerdict {
  admitted: boolean;
  /** Populated in both directions. Never empty. */
  reason: string;
}

/**
 * Deterministic facts about a session, extracted with NO model (spec §6).
 * The model's job is prose and aliases; everything here is read straight off
 * the transcript rows.
 */
export interface SessionMetadata {
  sessionId: string;
  /** The `cwd` the session ran in. Null when no row carries one. */
  projectPath: string | null;
  gitBranch: string | null;
  /** Distinct models, in first-seen order. A session can switch mid-run. */
  models: string[];
  cliVersion: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** User prompts — the turn anchor, per spec §6. */
  promptCount: number;
  /** Assistant messages carrying prose (not tool_use, not thinking). */
  proseCount: number;
  /**
   * Absolute paths named by file-touching tool calls, deduped, in first-seen
   * order. Paths only — file CONTENTS never appear anywhere in a distillation.
   */
  filesTouched: string[];
  terminalStatus: 'completed' | 'error' | 'unknown';
}

/**
 * Deterministic facts about an explicitly captured note (`brain_remember`).
 * There is no session behind one, so it shares none of `SessionMetadata`.
 */
export interface CaptureMetadata {
  /** ISO 8601, from the moment the tool was called. */
  capturedAt: string;
  /** Project the capture named, when it named one. */
  project: string | null;
  /** Working directory of the session that captured it. */
  cwd: string | null;
}

/**
 * What a distillation knows about its item.
 *
 * A discriminated union rather than one shape with optional fields: the
 * extraction prompt STATES these as facts, and a capture reporting
 * `promptCount: 1` would be feeding the model a fabricated fact about the very
 * material it is summarising — the failure mode Plan 4a recorded when Haiku
 * invented internals it could not see.
 */
export type ItemMetadata =
  | ({ kind: 'session' } & SessionMetadata)
  | ({ kind: 'capture' } & CaptureMetadata);

/** The bounded prose plus structured metadata handed to the extractor. */
export interface DistilledItem {
  /** Bounded prose. Never contains tool results, file contents or diffs. */
  prose: string;
  metadata: ItemMetadata;
  /** True when the ceiling forced oldest-first truncation. */
  truncated: boolean;
}

/**
 * A source of indexable material. All three methods are independently
 * testable, and GitHub/Jira adapters later implement this same interface with
 * nothing upstream changing (spec §5).
 */
export interface BrainSource {
  readonly id: string;
  /**
   * Every candidate across every account, each stamped with its owning
   * account. There is deliberately no `accountId` parameter: ownership is a
   * property of where an item lives, so a caller that could pass one would be
   * asserting ownership rather than deriving it.
   */
  discover(): Promise<SourceItem[]>;
  admit(item: SourceItem): AdmitVerdict;
  distill(item: SourceItem): Promise<DistilledItem>;
}
