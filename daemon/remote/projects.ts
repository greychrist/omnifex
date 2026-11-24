// Sessions start against a registered `projectId`, never a path the client sends.
// Account ownership is resolved on every read, never persisted: no silent default account.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

import type { Project } from '../../src/protocol';
import { encodeProjectId } from '../services/project-paths';

interface StoredProject {
  projectId: string;
  path: string;
  title: string;
  engine?: 'claude' | 'codex';
  addedAt: string;
}

export interface ProjectRegistryDeps {
  file: string;
  resolveAccount: (path: string) => { accountId: number; configDir: string } | null;
}

export interface ProjectRegistry {
  list(): Project[];
  get(projectId: string): Project | null;
  add(path: string, title?: string): Project;
  remove(projectId: string): boolean;
  onChange(listener: (projects: Project[]) => void): () => void;
}

export function createProjectRegistry(deps: ProjectRegistryDeps): ProjectRegistry {
  let stored: StoredProject[] = load();
  const listeners = new Set<(projects: Project[]) => void>();

  function load(): StoredProject[] {
    try {
      const parsed = JSON.parse(readFileSync(deps.file, 'utf8')) as { projects?: unknown };
      return Array.isArray(parsed.projects) ? (parsed.projects as StoredProject[]) : [];
    } catch {
      return [];
    }
  }

  function save(): void {
    mkdirSync(dirname(deps.file), { recursive: true });
    writeFileSync(deps.file, `${JSON.stringify({ projects: stored }, null, 2)}\n`, 'utf8');
  }

  function toProject(p: StoredProject): Project {
    const account = deps.resolveAccount(p.path);
    return {
      projectId: p.projectId,
      path: p.path,
      title: p.title,
      accountId: account?.accountId ?? null,
      configDir: account?.configDir ?? null,
      ...(p.engine && { engine: p.engine }),
    };
  }

  function notify(): void {
    const snapshot = stored.map(toProject);
    for (const l of listeners) {
      try {
        l(snapshot);
      } catch (err) {
        console.error('[remote/projects] listener failed:', err);
      }
    }
  }

  return {
    list: () => stored.map(toProject),
    get: (id) => {
      const p = stored.find((s) => s.projectId === id);
      return p ? toProject(p) : null;
    },

    add(path, title) {
      if (!isAbsolute(path)) throw new Error(`project path must be absolute: ${path}`);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new Error(`project path is not a directory: ${path}`);

      // Canonical, because the CLI realpaths its cwd: a symlinked spelling sends resume to the wrong transcript dir.
      path = realpathSync(path);
      const projectId = encodeProjectId(path);
      const existing = stored.find((s) => s.projectId === projectId);
      if (existing) return toProject(existing);

      const entry: StoredProject = {
        projectId,
        path,
        title: title?.trim() || basename(path),
        addedAt: new Date().toISOString(),
      };
      stored = [...stored, entry];
      save();
      notify();
      return toProject(entry);
    },

    remove(projectId) {
      const before = stored.length;
      stored = stored.filter((s) => s.projectId !== projectId);
      if (stored.length === before) return false;
      save();
      notify();
      return true;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function ensureRegistryDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
