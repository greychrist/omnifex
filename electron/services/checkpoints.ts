import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from './database';
import type { AccountsService } from './accounts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface Checkpoint {
  id: string;
  session_id: string;
  project_id: string;
  message_index: number;
  description: string;
  created_at: string;
  file_count: number;
}

export interface CheckpointResult {
  checkpoint: Checkpoint;
  filesProcessed: number;
  warnings: string[];
}

export interface CheckpointDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface SessionTimeline {
  session_id: string;
  checkpoints: Checkpoint[];
}

export interface CheckpointSettings {
  autoCheckpointEnabled: boolean;
  checkpointStrategy: string;
}

export interface CheckpointsService {
  createCheckpoint(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
    messageIndex?: number;
    description?: string;
  }): CheckpointResult;

  restoreCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): CheckpointResult;

  listCheckpoints(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): Checkpoint[];

  forkFromCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    projectId: string;
    projectPath: string;
    newSessionId: string;
    description?: string;
  }): CheckpointResult;

  getSessionTimeline(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): SessionTimeline;

  updateCheckpointSettings(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
    autoCheckpointEnabled: boolean;
    checkpointStrategy: string;
  }): void;

  getCheckpointDiff(params: {
    fromCheckpointId: string;
    toCheckpointId: string;
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): CheckpointDiff;
}

// ---------------------------------------------------------------------------
// Internal types for persisted checkpoint data
// ---------------------------------------------------------------------------

interface CheckpointData {
  id: string;
  session_id: string;
  project_id: string;
  message_index: number;
  description: string;
  created_at: string;
  files: Record<string, string | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.checkpoints',
  'target',
  'dist',
  'build',
  'out',
  '.vite',
]);

const SETTINGS_FILE = 'settings.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the directory where checkpoints for a given session are stored.
 */
function sessionCheckpointDir(projectPath: string, sessionId: string): string {
  return path.join(projectPath, '.checkpoints', sessionId);
}

/**
 * Walk a directory tree, yielding relative file paths.
 * Skips directories listed in SKIP_DIRS.
 */
function walkDir(root: string, base: string = root): string[] {
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(root, entry.name);
    const relPath = path.relative(base, fullPath);

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results;
}

/**
 * Read checkpoint data from disk by ID.
 * Throws if the file does not exist.
 */
function readCheckpointData(
  projectPath: string,
  sessionId: string,
  checkpointId: string,
): CheckpointData {
  const dir = sessionCheckpointDir(projectPath, sessionId);
  const filePath = path.join(dir, `${checkpointId}.json`);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Checkpoint '${checkpointId}' not found in session '${sessionId}': ${String(err)}`,
    );
  }

  return JSON.parse(raw) as CheckpointData;
}

/**
 * Write checkpoint data to disk.
 */
function writeCheckpointData(
  projectPath: string,
  sessionId: string,
  data: CheckpointData,
): void {
  const dir = sessionCheckpointDir(projectPath, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${data.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Convert CheckpointData to the public Checkpoint shape (strips file contents).
 */
function dataToCheckpoint(data: CheckpointData): Checkpoint {
  return {
    id: data.id,
    session_id: data.session_id,
    project_id: data.project_id,
    message_index: data.message_index,
    description: data.description,
    created_at: data.created_at,
    file_count: Object.keys(data.files).length,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCheckpointsService(
  _db: Database,
  _accounts: AccountsService,
): CheckpointsService {
  // -------------------------------------------------------------------------
  // createCheckpoint
  // -------------------------------------------------------------------------

  function createCheckpoint(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
    messageIndex?: number;
    description?: string;
  }): CheckpointResult {
    const { sessionId, projectId, projectPath, messageIndex = 0, description = '' } = params;
    const warnings: string[] = [];
    const files: Record<string, string | null> = {};

    const filePaths = walkDir(projectPath);

    for (const relPath of filePaths) {
      const fullPath = path.join(projectPath, relPath);
      try {
        const content = fs.readFileSync(fullPath);
        files[relPath] = content.toString('base64');
      } catch (err) {
        warnings.push(`Could not read file '${relPath}': ${String(err)}`);
      }
    }

    const id = crypto.randomUUID();
    const created_at = new Date().toISOString();

    const data: CheckpointData = {
      id,
      session_id: sessionId,
      project_id: projectId,
      message_index: messageIndex,
      description,
      created_at,
      files,
    };

    writeCheckpointData(projectPath, sessionId, data);

    return {
      checkpoint: dataToCheckpoint(data),
      filesProcessed: filePaths.length,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // restoreCheckpoint
  // -------------------------------------------------------------------------

  function restoreCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): CheckpointResult {
    const { checkpointId, sessionId, projectPath } = params;
    const warnings: string[] = [];

    // Throws if not found
    const data = readCheckpointData(projectPath, sessionId, checkpointId);

    for (const [relPath, encoded] of Object.entries(data.files)) {
      const fullPath = path.join(projectPath, relPath);
      try {
        if (encoded === null) {
          // Deletion marker — remove the file if it exists
          try {
            fs.rmSync(fullPath);
          } catch {
            // File may already not exist
          }
        } else {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, Buffer.from(encoded, 'base64'));
        }
      } catch (err) {
        warnings.push(`Could not restore file '${relPath}': ${String(err)}`);
      }
    }

    return {
      checkpoint: dataToCheckpoint(data),
      filesProcessed: Object.keys(data.files).length,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // listCheckpoints
  // -------------------------------------------------------------------------

  function listCheckpoints(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): Checkpoint[] {
    const { sessionId, projectPath } = params;
    const dir = sessionCheckpointDir(projectPath, sessionId);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist yet — no checkpoints
      return [];
    }

    const checkpointList: Checkpoint[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      if (entry.name === SETTINGS_FILE) continue;

      const filePath = path.join(dir, entry.name);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw) as CheckpointData;
        checkpointList.push(dataToCheckpoint(data));
      } catch {
        // Skip malformed checkpoint files
      }
    }

    // Sort by created_at ascending, with message_index as tiebreaker
    checkpointList.sort((a, b) => {
      const timeDiff = a.created_at.localeCompare(b.created_at);
      if (timeDiff !== 0) return timeDiff;
      return a.message_index - b.message_index;
    });

    return checkpointList;
  }

  // -------------------------------------------------------------------------
  // forkFromCheckpoint
  // -------------------------------------------------------------------------

  function forkFromCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    projectId: string;
    projectPath: string;
    newSessionId: string;
    description?: string;
  }): CheckpointResult {
    const { checkpointId, sessionId, projectPath, newSessionId, description } = params;

    // Load source checkpoint data
    const sourceData = readCheckpointData(projectPath, sessionId, checkpointId);

    const newId = crypto.randomUUID();
    const created_at = new Date().toISOString();

    const forkedData: CheckpointData = {
      id: newId,
      session_id: newSessionId,
      project_id: sourceData.project_id,
      message_index: sourceData.message_index,
      description: description ?? sourceData.description,
      created_at,
      files: { ...sourceData.files },
    };

    writeCheckpointData(projectPath, newSessionId, forkedData);

    return {
      checkpoint: dataToCheckpoint(forkedData),
      filesProcessed: Object.keys(forkedData.files).length,
      warnings: [],
    };
  }

  // -------------------------------------------------------------------------
  // getSessionTimeline
  // -------------------------------------------------------------------------

  function getSessionTimeline(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): SessionTimeline {
    const cps = listCheckpoints(params);
    return {
      session_id: params.sessionId,
      checkpoints: cps,
    };
  }

  // -------------------------------------------------------------------------
  // updateCheckpointSettings
  // -------------------------------------------------------------------------

  function updateCheckpointSettings(params: {
    sessionId: string;
    projectId: string;
    projectPath: string;
    autoCheckpointEnabled: boolean;
    checkpointStrategy: string;
  }): void {
    const { sessionId, projectPath, autoCheckpointEnabled, checkpointStrategy } = params;
    const dir = sessionCheckpointDir(projectPath, sessionId);
    fs.mkdirSync(dir, { recursive: true });

    const settings: CheckpointSettings = {
      autoCheckpointEnabled,
      checkpointStrategy,
    };

    const settingsPath = path.join(dir, SETTINGS_FILE);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  // -------------------------------------------------------------------------
  // getCheckpointDiff
  // -------------------------------------------------------------------------

  function getCheckpointDiff(params: {
    fromCheckpointId: string;
    toCheckpointId: string;
    sessionId: string;
    projectId: string;
    projectPath: string;
  }): CheckpointDiff {
    const { fromCheckpointId, toCheckpointId, sessionId, projectPath } = params;

    // Both read calls throw if not found
    const fromData = readCheckpointData(projectPath, sessionId, fromCheckpointId);
    const toData = readCheckpointData(projectPath, sessionId, toCheckpointId);

    const fromFiles = fromData.files;
    const toFiles = toData.files;

    const fromKeys = new Set(Object.keys(fromFiles));
    const toKeys = new Set(Object.keys(toFiles));

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const key of toKeys) {
      if (!fromKeys.has(key)) {
        added.push(key);
      } else if (fromFiles[key] !== toFiles[key]) {
        modified.push(key);
      }
    }

    for (const key of fromKeys) {
      if (!toKeys.has(key)) {
        deleted.push(key);
      }
    }

    return { added, modified, deleted };
  }

  // -------------------------------------------------------------------------
  // Return service object
  // -------------------------------------------------------------------------

  return {
    createCheckpoint,
    restoreCheckpoint,
    listCheckpoints,
    forkFromCheckpoint,
    getSessionTimeline,
    updateCheckpointSettings,
    getCheckpointDiff,
  };
}
