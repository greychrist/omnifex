import type { NoteType, ParsedNote } from './types';

export interface NoteMeta {
  relPath: string;
  title: string;
  type: NoteType;
  project: string | null;
  created: string;
  updated: string;
  curatedAt: string | null;
}

const stripMd = (s: string): string => (s.endsWith('.md') ? s.slice(0, -3) : s);

export function projectName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const inner = raw.trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
  const piped = inner.split('|');
  const chosen = piped.length > 1 ? piped[1] : piped[0];
  const name = stripMd(chosen.trim()).split('/').pop()?.trim() ?? '';
  return name === '' ? null : name;
}

export function toNoteMeta(relPath: string, note: ParsedNote): NoteMeta {
  const { frontmatter: fm } = note;
  return {
    relPath,
    title: stripMd(relPath.split('/').pop() ?? relPath),
    type: fm.type,
    project: projectName(fm.project),
    created: fm.created,
    updated: fm.updated,
    curatedAt: fm.curated_at ?? null,
  };
}
