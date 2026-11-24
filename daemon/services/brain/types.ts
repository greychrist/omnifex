/** Mirrors config/notes.json. */
export const NOTE_TYPES = ['Project', 'Subsystem', 'Topic', 'Session', 'Note'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const NOTE_FOLDERS: Record<NoteType, string> = {
  Project: 'Projects',
  Subsystem: 'Subsystems',
  Topic: 'Topics',
  Session: 'Sessions',
  Note: 'Notes',
};

export interface NoteFrontmatter {
  type: NoteType;
  /** Wikilink form, e.g. "[[Projects/omnifex]]". */
  project?: string;
  aliases: string[];
  keywords: string[];
  /** YYYY-MM-DD. */
  created: string;
  updated: string;
  curated_at?: string;
  /** e.g. "session:abc123"; merge dedups on these. */
  sources: string[];
}

export interface ParsedNote {
  frontmatter: NoteFrontmatter;
  body: string;
}
