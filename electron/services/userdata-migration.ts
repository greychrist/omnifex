// One-time userdata migration from the legacy "GreyChrist" Application
// Support directory to the new "OmniFex" directory. Runs on app startup
// before the database opens. Idempotent: a marker file in the new dir
// signals that migration has already happened, so subsequent launches
// (or the user reopening an old GreyChrist install) won't re-copy.
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATION_MARKER_FILENAME = '.migrated-from-greychrist';

export interface MigrateUserDataInput {
  legacyPath: string;
  newPath: string;
}

export type MigrateUserDataReason =
  | 'already-migrated'
  | 'no-legacy'
  | 'new-dir-not-empty';

export interface MigrateUserDataResult {
  migrated: boolean;
  reason?: MigrateUserDataReason;
}

function listEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function migrateUserData(input: MigrateUserDataInput): MigrateUserDataResult {
  const { legacyPath, newPath } = input;

  // Marker present → migration already complete.
  if (fs.existsSync(path.join(newPath, MIGRATION_MARKER_FILENAME))) {
    return { migrated: false, reason: 'already-migrated' };
  }

  if (!fs.existsSync(legacyPath)) {
    return { migrated: false, reason: 'no-legacy' };
  }

  // Don't overwrite an existing populated new dir. The only thing we'll
  // tolerate is the marker itself (handled above) — anything else means
  // OmniFex has already been writing here and we shouldn't merge.
  const entries = listEntries(newPath).filter((e) => e !== MIGRATION_MARKER_FILENAME);
  if (entries.length > 0) {
    return { migrated: false, reason: 'new-dir-not-empty' };
  }

  fs.mkdirSync(newPath, { recursive: true });
  fs.cpSync(legacyPath, newPath, { recursive: true });
  fs.writeFileSync(
    path.join(newPath, MIGRATION_MARKER_FILENAME),
    new Date().toISOString(),
  );

  return { migrated: true };
}
