// Ephemeral standalone model lookup — spins up a short-lived ClaudeCliEngine
// purely to read the initialization-time model catalog for a given
// CLAUDE_CONFIG_DIR. Used by the renderer model picker *before* a session is
// started (the tab-scoped sessions.getSupportedModels path covers the in-
// session case).

import fs from 'node:fs';
import os from 'node:os';
import { findBundledSdkBinaryAuto } from './claude-binary';
import { createClaudeCliEngine } from './agents/claude-cli-engine';
import type { Disposable, InitData } from './agents/types';

export interface ModelInfo {
  /** Stable model identifier (e.g. "claude-sonnet-4-6"). */
  value?: string;
  /** Display name shown in the picker. */
  displayName?: string;
  /** Optional one-line description. */
  description?: string;
  [k: string]: unknown;
}

export interface ModelsService {
  listSupported(configDir: string): Promise<ModelInfo[]>;
}

export interface ModelsServiceOptions {
  /** Max ms to wait for the CLI init handshake before giving up. */
  timeoutMs?: number;
}

function findSystemClaudeBinary(): string | null {
  const candidates = [
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Legacy fallback — was the per-platform binary bundled with the SDK
  // package. After the SDK was removed in v0.5.x this returns null on
  // most installs; kept for back-compat with old install layouts.
  return findBundledSdkBinaryAuto();
}

export function createModelsService(opts: ModelsServiceOptions = {}): ModelsService {
  const timeoutMs = opts.timeoutMs ?? 8000;

  async function listSupported(configDir: string): Promise<ModelInfo[]> {
    const binaryPath = findSystemClaudeBinary();
    if (!binaryPath) {
      console.error('[models] listSupported: claude binary not found');
      return [];
    }

    const engine = createClaudeCliEngine({
      tabId: `models-${Date.now().toString(36)}`,
      claudeBinaryPath: binaryPath,
    });

    const initPromise = new Promise<InitData | null>((resolve) => {
      let messageSub: Disposable | null = null;
      let exitSub: Disposable | null = null;
      const settle = (value: InitData | null): void => {
        if (messageSub) messageSub.dispose();
        if (exitSub) exitSub.dispose();
        resolve(value);
      };
      messageSub = engine.onMessage(() => {
        const data = engine.getInitData();
        if (data) settle(data);
      });
      exitSub = engine.onExit(() => { settle(null); });
    });

    try {
      // cwd is best-effort: anything readable will do — the CLI won't read
      // the project on a never-prompted handshake. tmpdir is universal and
      // doesn't leak the user's working directory into the request.
      await engine.start({
        projectPath: os.tmpdir(),
        configDir,
      });

      const data = await Promise.race([
        initPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const models = data?.models;
      return Array.isArray(models) ? (models as ModelInfo[]) : [];
    } catch (err) {
      console.error('[models] listSupported failed:', err);
      return [];
    } finally {
      try { await engine.close(); } catch { /* best effort */ }
    }
  }

  return { listSupported };
}
