import type { ParsedNote } from '../types';

/** `accountId` comes from where the item lives, never resolve() or a default; an adapter that cannot tell must omit the item. */
export interface SourceItem {
  sourceId: string;
  itemKey: string;
  accountId: number;
  /** The newest file when `paths` has several: the item is grouped and excluded under its project. */
  path: string;
  /** A session resumed in another cwd spans several files that must stay one item. Read through `pathsOf`, never directly. */
  paths?: string[];
  mtimeMs: number;
  size: number;
  /** Every adapter must produce the same identity for a folder; recover it (`recoverProjectPath`), never decode the lossy encoding. */
  label: string;
}

export interface AdmitVerdict {
  admitted: boolean;
  /** Never empty. */
  reason: string;
}

/** Read straight off transcript rows, with no model. */
export interface SessionMetadata {
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  models: string[];
  cliVersion: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  promptCount: number;
  proseCount: number;
  /** Paths only: file contents never appear in a distillation. */
  filesTouched: string[];
  terminalStatus: 'completed' | 'error' | 'unknown';
}

export interface CaptureMetadata {
  capturedAt: string;
  project: string | null;
  cwd: string | null;
}

export interface ArtifactMetadata {
  repoPath: string;
  file: string;
}

/** A union, not optional fields: the prompt states these as facts, so a kind must never carry another's. */
export type ItemMetadata =
  | ({ kind: 'session' } & SessionMetadata)
  | ({ kind: 'capture' } & CaptureMetadata)
  | ({ kind: 'artifact' } & ArtifactMetadata);

export interface DistilledItem {
  /** Never contains tool results, file contents or diffs. */
  prose: string;
  metadata: ItemMetadata;
  truncated: boolean;
}

/** The adapter picks the path, never resolveEntityPath: a translated note must not blend into a same-named entity note. */
export interface TranslatedNote {
  relPath: string;
  note: ParsedNote;
}

/** Implements exactly one of `distill()` or `translate()`. */
export interface BrainSource {
  readonly id: string;
  /** Deliberately no `accountId` parameter: ownership is derived from where an item lives, never asserted. */
  discover(): Promise<SourceItem[]>;
  /** A gate that reads a large file must answer async, off the event loop. */
  admit(item: SourceItem): AdmitVerdict | Promise<AdmitVerdict>;
  distill?(item: SourceItem): Promise<DistilledItem>;
  translate?(item: SourceItem): Promise<TranslatedNote[]>;
}

export function pathsOf(item: Pick<SourceItem, 'path' | 'paths'>): string[] {
  return item.paths ?? [item.path];
}
