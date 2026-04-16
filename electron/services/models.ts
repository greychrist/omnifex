// Ephemeral standalone model lookup — spins up a short-lived SDK query() purely
// to read the initialization-time model catalog for a given CLAUDE_CONFIG_DIR.
// Used by the renderer model picker *before* a session is started (the
// tab-scoped sessions.getSupportedModels path covers the in-session case).

import fs from 'node:fs';
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

export interface ModelsService {
  listSupported(configDir: string): Promise<ModelInfo[]>;
}

export interface ModelsServiceOptions {
  /** Max ms to wait for the SDK init handshake before giving up. */
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
  return null;
}

export function createModelsService(opts: ModelsServiceOptions = {}): ModelsService {
  const timeoutMs = opts.timeoutMs ?? 8000;

  async function listSupported(configDir: string): Promise<ModelInfo[]> {
    if (!configDir) {
      throw new Error('configDir is required to list supported models');
    }

    const options: Record<string, unknown> = {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      settingSources: [] as string[],
    };
    const binaryPath = findSystemClaudeBinary();
    if (binaryPath) options.pathToClaudeCodeExecutable = binaryPath;

    const emptyPrompt: AsyncIterable<never> = {
      [Symbol.asyncIterator]: async function* () { /* no input */ },
    };

    const q = query({ prompt: emptyPrompt as any, options: options as any });

    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      return models ?? [];
    } catch (err) {
      console.error('[models] listSupported failed:', err);
      return [];
    } finally {
      try { q.close(); } catch { /* best effort */ }
    }
  }

  return { listSupported };
}
