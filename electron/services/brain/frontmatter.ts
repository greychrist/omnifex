import { load, dump } from 'js-yaml';
import { z } from 'zod';
import { NOTE_TYPES, type NoteFrontmatter, type ParsedNote } from './types';

/**
 * Thrown when a note cannot be read. Callers isolate the failure to the single
 * note rather than failing a whole scan — a hand-edited file must never take
 * the vault down.
 */
export class NoteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteParseError';
  }
}

const FrontmatterSchema = z.object({
  type: z.enum(NOTE_TYPES),
  project: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  created: z.union([z.string(), z.date()]).transform(d => typeof d === 'string' ? d : d.toISOString().split('T')[0]),
  updated: z.union([z.string(), z.date()]).transform(d => typeof d === 'string' ? d : d.toISOString().split('T')[0]),
  curated_at: z.union([z.string(), z.date()]).optional().transform(d => !d ? undefined : typeof d === 'string' ? d : d.toISOString().split('T')[0]),
  sources: z.array(z.string()).default([]),
});

/** Matches a leading `---` fence and captures the YAML plus the remaining body. */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseNote(raw: string): ParsedNote {
  const match = FENCE.exec(raw);
  if (!match) {
    throw new NoteParseError('note has no YAML frontmatter fence');
  }

  let loaded: unknown;
  try {
    loaded = load(match[1]) ?? {};
  } catch (err) {
    throw new NoteParseError(`invalid YAML frontmatter: ${(err as Error).message}`);
  }

  // `project:` with no value parses as null; treat that as absent rather than
  // letting a null reach the schema.
  if (loaded && typeof loaded === 'object') {
    for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
      if (v === null) delete (loaded as Record<string, unknown>)[k];
    }
  }

  const result = FrontmatterSchema.safeParse(loaded);
  if (!result.success) {
    throw new NoteParseError(`invalid frontmatter: ${result.error.issues[0]?.message ?? 'unknown'}`);
  }

  return { frontmatter: result.data, body: match[2] };
}

export function serializeNote(note: ParsedNote): string {
  const fm: Record<string, unknown> = {
    type: note.frontmatter.type,
  };
  if (note.frontmatter.project !== undefined) fm.project = note.frontmatter.project;
  fm.aliases = note.frontmatter.aliases;
  fm.keywords = note.frontmatter.keywords;
  fm.created = note.frontmatter.created;
  fm.updated = note.frontmatter.updated;
  if (note.frontmatter.curated_at !== undefined) fm.curated_at = note.frontmatter.curated_at;
  fm.sources = note.frontmatter.sources;

  // flowLevel: 1 keeps arrays on one line ([a, b]) so notes stay readable in
  // Obsidian. lineWidth: -1 disables wrapping, which would otherwise reflow
  // long alias lists differently on each write and break byte-identical
  // idempotency.
  const yaml = dump(fm, { flowLevel: 1, lineWidth: -1, quotingType: '"' });
  return `---\n${yaml}---\n${note.body}`;
}
