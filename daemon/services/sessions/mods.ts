// Sessions module — mods (Claude Code >= 2.1.287)
//
// A mod is a plugin whose `hooks/hooks.json` names a hooks module under
// `modules`: TypeScript the CLI runs inside its own process, unsandboxed. In
// a stream-json session nothing a mod draws reaches OmniFex, but every hook
// still runs — including ones that approve a tool call before OmniFex's
// permission decider is asked. That is why the Session context panel lists
// mods apart from plugins, led by what each one can do.
//
// What a mod can do comes from `claude plugin validate --json`: the CLI's own
// static read of the module, printed as a `hooks:` and a `calls:` note — the
// same list the docs tell a user to check before installing one. Running it
// is ~0.5 s, so the inspector caches per plugin and hooks.json mtime.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildClaudeEnv } from '../util/claude-env';

// The shapes are the renderer's too (the Session context panel reads them), so
// they live in src/ with the labels, and both sides import one definition.
import type { ModCapability, ModInspection } from '../../../src/lib/mods';
export type { ModCapability, ModInspection };

export function readModModules(
  pluginPath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf-8'),
): string[] | null {
  try {
    const parsed = JSON.parse(readFile(path.join(pluginPath, 'hooks', 'hooks.json'))) as { modules?: unknown };
    if (!Array.isArray(parsed.modules)) return null;
    const modules = parsed.modules.filter((m): m is string => typeof m === 'string');
    return modules.length > 0 ? modules : null;
  } catch {
    return null;
  }
}

/** Split on commas that are not inside a `{matcher}` or a `(via …)` note. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '{' || ch === '(') depth++;
    if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseValidateReport(stdout: string): Pick<ModInspection, 'hooks' | 'calls'> | null {
  let report: { contents?: { notes?: unknown }[] };
  try {
    report = JSON.parse(stdout) as typeof report;
  } catch {
    return null;
  }
  const hooks: string[] = [];
  const calls: string[] = [];
  let found = false;
  for (const entry of report.contents ?? []) {
    if (!Array.isArray(entry.notes)) continue;
    for (const note of entry.notes) {
      if (typeof note !== 'string') continue;
      const m = /\s(hooks|calls): (.*)$/.exec(note);
      if (!m) continue;
      found = true;
      for (const item of splitTopLevel(m[2])) {
        if (m[1] === 'hooks') {
          hooks.push(item);
        } else {
          calls.push(item.replace(/\s*\(.*\)$/, '').replace(/^\$\./, ''));
        }
      }
    }
  }
  if (!found) return null;
  return { hooks: [...new Set(hooks)], calls: [...new Set(calls)] };
}

const ORDER: ModCapability[] = ['tool-calls', 'prompts', 'submits-prompts', 'processes', 'network', 'models', 'writes-files'];

export function modCapabilities(hooks: string[], calls: string[]): ModCapability[] {
  const events = hooks.map((h) => h.replace(/\{.*$/, ''));
  const has = new Set<ModCapability>();
  if (events.some((e) => e === 'tool.call' || e === 'tool.check')) has.add('tool-calls');
  if (events.some((e) => e.startsWith('prompt.'))) has.add('prompts');
  for (const c of calls) {
    if (c === 'prompt.submit') has.add('submits-prompts');
    if (c.startsWith('process.')) has.add('processes');
    if (c.startsWith('http.') || c === 'mcp.connect') has.add('network');
    if (c.startsWith('model.')) has.add('models');
    if (c === 'fs.write') has.add('writes-files');
  }
  return ORDER.filter((c) => has.has(c));
}

/** `configDir` is the session's account: validate runs under it, as the
 *  session's own CLI does. */
export type ModInspector = (pluginPath: string, configDir: string) => Promise<ModInspection | null>;

export function createModInspector(deps: {
  /** Runs `claude plugin validate --json <pluginPath>` and resolves its stdout. */
  run: (pluginPath: string, configDir: string) => Promise<string>;
  mtimeMs?: (file: string) => number;
}): ModInspector {
  const mtimeMs = deps.mtimeMs ?? ((f: string) => fs.statSync(f).mtimeMs);
  const cache = new Map<string, { mtime: number; result: ModInspection }>();
  return async (pluginPath, configDir) => {
    let mtime: number;
    try {
      mtime = mtimeMs(path.join(pluginPath, 'hooks', 'hooks.json'));
    } catch {
      return null;
    }
    const hit = cache.get(pluginPath);
    if (hit?.mtime === mtime) return hit.result;
    try {
      const parsed = parseValidateReport(await deps.run(pluginPath, configDir));
      if (!parsed) return null;
      const result = { ...parsed, capabilities: modCapabilities(parsed.hooks, parsed.calls) };
      cache.set(pluginPath, { mtime, result });
      return result;
    } catch {
      return null;
    }
  };
}

const VALIDATE_TIMEOUT_MS = 15_000;

/**
 * `claude plugin validate --json <dir>` against the binary sessions launch.
 * A plugin with errors exits non-zero but still prints its report, so stdout
 * is kept whenever there is one.
 */
export function createValidateRunner(
  resolveBinary: () => string | null,
): (pluginPath: string, configDir: string) => Promise<string> {
  return (pluginPath, configDir) => new Promise((resolve, reject) => {
    const binary = resolveBinary();
    if (!binary) {
      reject(new Error('claude binary not found'));
      return;
    }
    execFile(
      binary,
      ['plugin', 'validate', '--json', pluginPath],
      { env: buildClaudeEnv(configDir), timeout: VALIDATE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (stdout) resolve(stdout);
        else reject(err ?? new Error('plugin validate printed nothing'));
      },
    );
  });
}
