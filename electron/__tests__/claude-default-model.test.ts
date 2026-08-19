import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService } from '../services/accounts';
import { createClaudeService, type ClaudeService } from '../services/claude';

/**
 * `getDefaultModel` exists because OmniFex omits `--model` for the "Account
 * Default" pick and lets the CLI resolve it. Claude Code 2.1.236 added
 * `ANTHROPIC_DEFAULT_MODEL`, which outranks the settings.json `model` key —
 * and OmniFex spawns inherit `process.env`, so the variable reaches the CLI
 * whether or not anything in the UI knows about it.
 */
describe('ClaudeService.getDefaultModel', () => {
  let dir: string;
  let db: Database;
  let service: ClaudeService;
  const saved = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_MODEL: process.env.ANTHROPIC_DEFAULT_MODEL,
  };

  beforeEach(() => {
    db = createDatabase(':memory:');
    service = createClaudeService(db, createAccountsService(db));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-default-model-'));
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_MODEL;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const svc = () => service;
  const writeSettings = (model: unknown): void => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model }));
  };

  it('falls back to the settings.json pin when no env override is set', () => {
    writeSettings('opus[1m]');
    expect(svc().getDefaultModel({ configDir: dir })).toEqual({
      model: 'opus[1m]',
      source: 'settings',
    });
  });

  it('lets ANTHROPIC_DEFAULT_MODEL outrank the settings.json pin', () => {
    writeSettings('opus[1m]');
    process.env.ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';
    expect(svc().getDefaultModel({ configDir: dir })).toEqual({
      model: 'claude-sonnet-5',
      source: 'ANTHROPIC_DEFAULT_MODEL',
    });
  });

  it('lets ANTHROPIC_MODEL outrank ANTHROPIC_DEFAULT_MODEL, matching CLI startup order', () => {
    writeSettings('opus[1m]');
    process.env.ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
    expect(svc().getDefaultModel({ configDir: dir })).toEqual({
      model: 'claude-haiku-4-5-20251001',
      source: 'ANTHROPIC_MODEL',
    });
  });

  it('ignores an empty or whitespace-only env value rather than pinning to ""', () => {
    writeSettings('opus[1m]');
    process.env.ANTHROPIC_DEFAULT_MODEL = '   ';
    expect(svc().getDefaultModel({ configDir: dir })).toEqual({
      model: 'opus[1m]',
      source: 'settings',
    });
  });

  it('reports "none" when neither the env nor settings.json pins a model', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({}));
    expect(svc().getDefaultModel({ configDir: dir })).toEqual({ model: null, source: 'none' });
  });

  it('treats an unreadable settings.json as "no pin", not an error', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
    expect(() => svc().getDefaultModel({ configDir: dir })).not.toThrow();
    expect(svc().getDefaultModel({ configDir: dir }).model).toBeNull();
  });
});
