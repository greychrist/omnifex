import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import {
  createCheckpointsService,
  type CheckpointsService,
} from '../services/checkpoints';

describe('checkpoints service', () => {
  let db: Database;
  let accounts: AccountsService;
  let checkpoints: CheckpointsService;
  let tmpDir: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    checkpoints = createCheckpointsService(db, accounts);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-cp-test-'));
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function writeFile(relativePath: string, content: string): string {
    const full = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
  }

  function readFile(relativePath: string): string {
    return fs.readFileSync(path.join(tmpDir, relativePath), 'utf8');
  }

  const SESSION_ID = 'session-abc-123';
  const PROJECT_ID = 'project-xyz-456';

  function baseParams() {
    return {
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectPath: tmpDir,
    };
  }

  // -------------------------------------------------------------------------
  // createCheckpoint
  // -------------------------------------------------------------------------

  describe('createCheckpoint()', () => {
    it('returns a CheckpointResult with checkpoint metadata', () => {
      writeFile('src/index.ts', 'console.log("hello");');
      writeFile('README.md', '# project');

      const result = checkpoints.createCheckpoint({
        ...baseParams(),
        messageIndex: 0,
        description: 'initial snapshot',
      });

      expect(result).toBeDefined();
      expect(result.checkpoint).toBeDefined();
      expect(typeof result.checkpoint.id).toBe('string');
      expect(result.checkpoint.id.length).toBeGreaterThan(0);
      expect(result.checkpoint.session_id).toBe(SESSION_ID);
      expect(result.checkpoint.project_id).toBe(PROJECT_ID);
      expect(result.checkpoint.message_index).toBe(0);
      expect(result.checkpoint.description).toBe('initial snapshot');
      expect(result.checkpoint.created_at).toBeDefined();
      expect(typeof result.checkpoint.file_count).toBe('number');
      expect(result.checkpoint.file_count).toBeGreaterThan(0);
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('persists a checkpoint JSON file on disk', () => {
      writeFile('hello.txt', 'world');

      const result = checkpoints.createCheckpoint(baseParams());
      const cpDir = path.join(tmpDir, '.checkpoints', SESSION_ID);
      const cpFile = path.join(cpDir, `${result.checkpoint.id}.json`);

      expect(fs.existsSync(cpFile)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
      expect(parsed.id).toBe(result.checkpoint.id);
      expect(parsed.session_id).toBe(SESSION_ID);
      expect(parsed.files).toBeDefined();
    });

    it('skips ignored directories (.git, node_modules, .checkpoints, target, dist, build, out, .vite)', () => {
      writeFile('src/app.ts', 'export {}');
      writeFile('node_modules/lib/index.js', 'module.exports = {}');
      writeFile('.git/HEAD', 'ref: refs/heads/main');
      writeFile('dist/bundle.js', 'bundled');
      writeFile('build/output.js', 'built');
      writeFile('target/release/app', 'binary');
      writeFile('out/main.js', 'output');
      writeFile('.vite/deps/react.js', 'react');

      const result = checkpoints.createCheckpoint(baseParams());
      const cpFile = path.join(
        tmpDir,
        '.checkpoints',
        SESSION_ID,
        `${result.checkpoint.id}.json`,
      );
      const parsed = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
      const fileKeys = Object.keys(parsed.files);

      // Only src/app.ts should be captured
      expect(fileKeys).toContain('src/app.ts');
      expect(fileKeys.some((k) => k.startsWith('node_modules/'))).toBe(false);
      expect(fileKeys.some((k) => k.startsWith('.git/'))).toBe(false);
      expect(fileKeys.some((k) => k.startsWith('dist/'))).toBe(false);
      expect(fileKeys.some((k) => k.startsWith('build/'))).toBe(false);
      expect(fileKeys.some((k) => k.startsWith('target/'))).toBe(false);
      expect(fileKeys.some((k) => k.startsWith('out/'))).toBe(false);
      expect(fileKeys.some((k) => k.startsWith('.vite/'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // listCheckpoints
  // -------------------------------------------------------------------------

  describe('listCheckpoints()', () => {
    it('returns empty array when no checkpoints exist', () => {
      const list = checkpoints.listCheckpoints(baseParams());
      expect(list).toEqual([]);
    });

    it('returns checkpoints after creating one', () => {
      writeFile('a.txt', 'alpha');
      checkpoints.createCheckpoint({ ...baseParams(), description: 'first' });

      const list = checkpoints.listCheckpoints(baseParams());
      expect(list).toHaveLength(1);
      expect(list[0].description).toBe('first');
      expect(list[0].session_id).toBe(SESSION_ID);
    });

    it('returns multiple checkpoints sorted by created_at', () => {
      writeFile('a.txt', 'alpha');
      checkpoints.createCheckpoint({ ...baseParams(), description: 'cp1', messageIndex: 0 });
      checkpoints.createCheckpoint({ ...baseParams(), description: 'cp2', messageIndex: 1 });
      checkpoints.createCheckpoint({ ...baseParams(), description: 'cp3', messageIndex: 2 });

      const list = checkpoints.listCheckpoints(baseParams());
      expect(list).toHaveLength(3);
      expect(list.map((c) => c.description)).toEqual(['cp1', 'cp2', 'cp3']);
    });

    it('does not include settings.json in checkpoint list', () => {
      writeFile('x.ts', 'x');
      checkpoints.createCheckpoint(baseParams());
      checkpoints.updateCheckpointSettings({
        ...baseParams(),
        autoCheckpointEnabled: true,
        checkpointStrategy: 'auto',
      });

      const list = checkpoints.listCheckpoints(baseParams());
      // All items must be parseable as Checkpoint objects (not settings)
      for (const cp of list) {
        expect(typeof cp.id).toBe('string');
        expect(typeof cp.session_id).toBe('string');
      }
    });
  });

  // -------------------------------------------------------------------------
  // restoreCheckpoint
  // -------------------------------------------------------------------------

  describe('restoreCheckpoint()', () => {
    it('restores files to their original content', () => {
      writeFile('src/main.ts', 'const x = 1;');
      writeFile('README.md', '# hello');

      const { checkpoint } = checkpoints.createCheckpoint(baseParams());

      // Modify files after checkpoint
      writeFile('src/main.ts', 'const x = 999;');
      writeFile('README.md', '# modified');
      writeFile('newfile.ts', 'added later');

      checkpoints.restoreCheckpoint({
        checkpointId: checkpoint.id,
        ...baseParams(),
      });

      expect(readFile('src/main.ts')).toBe('const x = 1;');
      expect(readFile('README.md')).toBe('# hello');
    });

    it('returns a CheckpointResult', () => {
      writeFile('f.txt', 'content');
      const { checkpoint } = checkpoints.createCheckpoint(baseParams());

      const result = checkpoints.restoreCheckpoint({
        checkpointId: checkpoint.id,
        ...baseParams(),
      });

      expect(result.checkpoint.id).toBe(checkpoint.id);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('throws or returns a result when checkpoint does not exist', () => {
      expect(() => {
        checkpoints.restoreCheckpoint({
          checkpointId: 'nonexistent-id',
          ...baseParams(),
        });
      }).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getSessionTimeline
  // -------------------------------------------------------------------------

  describe('getSessionTimeline()', () => {
    it('returns a timeline with session_id and checkpoints array', () => {
      const timeline = checkpoints.getSessionTimeline(baseParams());

      expect(timeline).toBeDefined();
      expect(timeline.session_id).toBe(SESSION_ID);
      expect(Array.isArray(timeline.checkpoints)).toBe(true);
    });

    it('includes created checkpoints in the timeline', () => {
      writeFile('t.ts', 'timeline test');
      checkpoints.createCheckpoint({ ...baseParams(), description: 'tl-cp' });

      const timeline = checkpoints.getSessionTimeline(baseParams());
      expect(timeline.checkpoints).toHaveLength(1);
      expect(timeline.checkpoints[0].description).toBe('tl-cp');
    });
  });

  // -------------------------------------------------------------------------
  // updateCheckpointSettings
  // -------------------------------------------------------------------------

  describe('updateCheckpointSettings()', () => {
    it('saves settings to disk without throwing', () => {
      expect(() => {
        checkpoints.updateCheckpointSettings({
          ...baseParams(),
          autoCheckpointEnabled: true,
          checkpointStrategy: 'per-message',
        });
      }).not.toThrow();
    });

    it('persists settings that can be read back', () => {
      checkpoints.updateCheckpointSettings({
        ...baseParams(),
        autoCheckpointEnabled: false,
        checkpointStrategy: 'manual',
      });

      const settingsPath = path.join(
        tmpDir,
        '.checkpoints',
        SESSION_ID,
        'settings.json',
      );
      expect(fs.existsSync(settingsPath)).toBe(true);
      const saved: { autoCheckpointEnabled: boolean; checkpointStrategy: string } =
        JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(saved.autoCheckpointEnabled).toBe(false);
      expect(saved.checkpointStrategy).toBe('manual');
    });

    it('overwrites existing settings', () => {
      checkpoints.updateCheckpointSettings({
        ...baseParams(),
        autoCheckpointEnabled: true,
        checkpointStrategy: 'auto',
      });
      checkpoints.updateCheckpointSettings({
        ...baseParams(),
        autoCheckpointEnabled: false,
        checkpointStrategy: 'manual',
      });

      const settingsPath = path.join(
        tmpDir,
        '.checkpoints',
        SESSION_ID,
        'settings.json',
      );
      const saved: { autoCheckpointEnabled: boolean; checkpointStrategy: string } =
        JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(saved.autoCheckpointEnabled).toBe(false);
      expect(saved.checkpointStrategy).toBe('manual');
    });
  });

  // -------------------------------------------------------------------------
  // getCheckpointDiff
  // -------------------------------------------------------------------------

  describe('getCheckpointDiff()', () => {
    it('returns a diff with added, modified, deleted arrays', () => {
      writeFile('existing.ts', 'original');

      const { checkpoint: cp1 } = checkpoints.createCheckpoint({
        ...baseParams(),
        description: 'before',
      });

      writeFile('existing.ts', 'changed');
      writeFile('added.ts', 'brand new');

      const { checkpoint: cp2 } = checkpoints.createCheckpoint({
        ...baseParams(),
        description: 'after',
      });

      const diff = checkpoints.getCheckpointDiff({
        fromCheckpointId: cp1.id,
        toCheckpointId: cp2.id,
        ...baseParams(),
      });

      expect(diff).toBeDefined();
      expect(Array.isArray(diff.added)).toBe(true);
      expect(Array.isArray(diff.modified)).toBe(true);
      expect(Array.isArray(diff.deleted)).toBe(true);
      expect(diff.added).toContain('added.ts');
      expect(diff.modified).toContain('existing.ts');
    });

    it('reports deleted files', () => {
      writeFile('will-be-deleted.ts', 'going away');
      writeFile('stays.ts', 'staying');

      const { checkpoint: cp1 } = checkpoints.createCheckpoint({
        ...baseParams(),
        description: 'with file',
      });

      // Remove file and create second checkpoint manually by re-snapshotting
      fs.rmSync(path.join(tmpDir, 'will-be-deleted.ts'));
      const { checkpoint: cp2 } = checkpoints.createCheckpoint({
        ...baseParams(),
        description: 'file removed',
      });

      const diff = checkpoints.getCheckpointDiff({
        fromCheckpointId: cp1.id,
        toCheckpointId: cp2.id,
        ...baseParams(),
      });

      expect(diff.deleted).toContain('will-be-deleted.ts');
    });

    it('throws when a checkpoint ID does not exist', () => {
      writeFile('f.ts', 'x');
      const { checkpoint: cp } = checkpoints.createCheckpoint(baseParams());

      expect(() => {
        checkpoints.getCheckpointDiff({
          fromCheckpointId: cp.id,
          toCheckpointId: 'no-such-id',
          ...baseParams(),
        });
      }).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // forkFromCheckpoint
  // -------------------------------------------------------------------------

  describe('forkFromCheckpoint()', () => {
    it('creates a new checkpoint under newSessionId', () => {
      writeFile('fork-me.ts', 'original content');
      const { checkpoint: src } = checkpoints.createCheckpoint(baseParams());

      const newSessionId = 'session-fork-999';
      const result = checkpoints.forkFromCheckpoint({
        checkpointId: src.id,
        ...baseParams(),
        newSessionId,
        description: 'forked from cp1',
      });

      expect(result.checkpoint.session_id).toBe(newSessionId);
      expect(result.checkpoint.description).toBe('forked from cp1');

      // Verify the forked checkpoint exists on disk
      const forkedFile = path.join(
        tmpDir,
        '.checkpoints',
        newSessionId,
        `${result.checkpoint.id}.json`,
      );
      expect(fs.existsSync(forkedFile)).toBe(true);
    });

    it('is listable under the new session', () => {
      writeFile('z.ts', 'z');
      const { checkpoint: src } = checkpoints.createCheckpoint(baseParams());

      const newSessionId = 'session-fork-list';
      checkpoints.forkFromCheckpoint({
        checkpointId: src.id,
        ...baseParams(),
        newSessionId,
      });

      const list = checkpoints.listCheckpoints({
        sessionId: newSessionId,
        projectId: PROJECT_ID,
        projectPath: tmpDir,
      });
      expect(list).toHaveLength(1);
    });
  });
});
