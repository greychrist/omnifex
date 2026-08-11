/** Entity and record folders in a vault. Mirrors config/notes.json. */
export const NOTE_TYPES = ['Project', 'Subsystem', 'Topic', 'Session', 'Note'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** Folder each note type lives in, relative to the vault root. */
export const NOTE_FOLDERS: Record<NoteType, string> = {
  Project: 'Projects',
  Subsystem: 'Subsystems',
  Topic: 'Topics',
  Session: 'Sessions',
  Note: 'Notes',
};

export interface NoteFrontmatter {
  type: NoteType;
  /** Wikilink to the owning project, e.g. "[[Projects/omnifex]]". */
  project?: string;
  aliases: string[];
  keywords: string[];
  /** ISO date (YYYY-MM-DD). */
  created: string;
  updated: string;
  curated_at?: string;
  /** Provenance keys, e.g. "session:abc123". Drives merge dedup. */
  sources: string[];
}

export interface ParsedNote {
  frontmatter: NoteFrontmatter;
  body: string;
}
