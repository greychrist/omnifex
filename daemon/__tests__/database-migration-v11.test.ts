import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../services/database';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Seed a v10-shaped DB and record schema_version=10 in the canonical
 * schema_version table so only migration v11 runs. The accounts columns mirror
 * the post-v7 shape (session_defaults, cli_path, summarize fields) so v11's
 * accounts transform is exercised in isolation.
 */
function seedSchemaVersion10(db: Database.Database): void {
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version (version, applied_at) VALUES (10, CURRENT_TIMESTAMP);
  `);
}

describe('migration v11 — codex account parity', () => {
  it('adds engine + has_cost; renames account_type → subscription_label; capitalizes labels; flips has_cost for max', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT, icon TEXT,
        session_defaults TEXT, cli_path TEXT,
        summarizeOnClose INTEGER NOT NULL DEFAULT 0,
        summaryModel TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO accounts (name, config_dir, account_type) VALUES
        ('A', '/A', 'max'),
        ('B', '/B', 'pro'),
        ('C', '/C', 'enterprise'),
        ('D', '/D', 'free');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    seedSchemaVersion10(db);

    runMigrations(db);

    const rows = db
      .prepare('SELECT name, engine, subscription_label, has_cost FROM accounts ORDER BY name')
      .all() as any[];
    expect(rows[0]).toMatchObject({ name: 'A', engine: 'claude', subscription_label: 'Max', has_cost: 0 });
    expect(rows[1]).toMatchObject({ name: 'B', engine: 'claude', subscription_label: 'Pro', has_cost: 1 });
    expect(rows[2]).toMatchObject({ name: 'C', engine: 'claude', subscription_label: 'Enterprise', has_cost: 1 });
    expect(rows[3]).toMatchObject({ name: 'D', engine: 'claude', subscription_label: 'Free', has_cost: 1 });

    db.close();
  });

  it('drops account_path_rules.agent; makes account_id NOT NULL; backfills orphan Codex rules to discovered ~/.codex account', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-mig-'));
    fs.mkdirSync(path.join(tmpHome, '.codex'));

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, config_dir TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'pro', color TEXT, icon TEXT, session_defaults TEXT, cli_path TEXT, summarizeOnClose INTEGER NOT NULL DEFAULT 0, summaryModel TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO accounts (name, config_dir) VALUES ('Personal', '/Users/me/.claude-personal');
      CREATE TABLE account_path_rules (id INTEGER PRIMARY KEY, account_id INTEGER, path_prefix TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, agent TEXT NOT NULL DEFAULT 'claude', FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
      INSERT INTO account_path_rules (account_id, path_prefix, agent) VALUES
        (1, '/Users/me/Repos', 'claude'),
        (NULL, '/Users/me/CodexProjects', 'codex');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    seedSchemaVersion10(db);

    runMigrations(db, { homeDir: tmpHome });

    const codexAccount = db
      .prepare("SELECT id, name, config_dir FROM accounts WHERE engine = 'codex'")
      .get() as any;
    expect(codexAccount).toMatchObject({ name: 'Codex', config_dir: path.join(tmpHome, '.codex') });

    const rules = db
      .prepare('SELECT account_id, path_prefix FROM account_path_rules ORDER BY path_prefix')
      .all() as any[];
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ path_prefix: '/Users/me/CodexProjects', account_id: codexAccount.id });
    expect(rules[1]).toMatchObject({ path_prefix: '/Users/me/Repos', account_id: 1 });

    // agent column gone
    const ruleCols = db.pragma('table_info(account_path_rules)') as { name: string }[];
    expect(ruleCols.some((c) => c.name === 'agent')).toBe(false);

    // Discovery flag set
    expect(
      (db.prepare('SELECT value FROM app_settings WHERE key = ?').get('codex_discovery_completed') as any)?.value,
    ).toBe('true');

    db.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('drops orphan Codex rules when no ~/.codex/ exists', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-mig-'));
    // No ~/.codex/ inside tmpHome

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, config_dir TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'pro', color TEXT, icon TEXT, session_defaults TEXT, cli_path TEXT, summarizeOnClose INTEGER NOT NULL DEFAULT 0, summaryModel TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE account_path_rules (id INTEGER PRIMARY KEY, account_id INTEGER, path_prefix TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, agent TEXT NOT NULL DEFAULT 'claude', FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
      INSERT INTO account_path_rules (account_id, path_prefix, agent) VALUES (NULL, '/x', 'codex');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    seedSchemaVersion10(db);

    runMigrations(db, { homeDir: tmpHome });

    expect(db.prepare('SELECT COUNT(*) AS n FROM account_path_rules').get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE engine = 'codex'").get()).toMatchObject({ n: 0 });

    db.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('migrates project_account_overrides to composite (project_path, engine) PK', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, config_dir TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'pro', color TEXT, icon TEXT, session_defaults TEXT, cli_path TEXT, summarizeOnClose INTEGER NOT NULL DEFAULT 0, summaryModel TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO accounts (name, config_dir) VALUES ('A', '/A');
      CREATE TABLE project_account_overrides (project_path TEXT PRIMARY KEY, account_id INTEGER NOT NULL, FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
      INSERT INTO project_account_overrides VALUES ('/proj', 1);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    seedSchemaVersion10(db);

    runMigrations(db);

    const row = db.prepare('SELECT project_path, engine, account_id FROM project_account_overrides').get();
    expect(row).toMatchObject({ project_path: '/proj', engine: 'claude', account_id: 1 });

    const pk = (db.pragma('table_info(project_account_overrides)') as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort();
    expect(pk).toEqual(['engine', 'project_path']);

    db.close();
  });
});
