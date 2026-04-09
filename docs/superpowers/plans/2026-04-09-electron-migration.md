# Electron Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate GreyChrist from Tauri 2 (Rust + React) to Electron (Node.js + React), enabling the Claude Agent SDK to run natively in Node.js.

**Architecture:** Electron Forge with Vite plugin. Main process (Node.js) hosts all backend services, SQLite database, and the Claude Agent SDK. Renderer process (Chromium) runs the existing React frontend. IPC via contextBridge connects the two. Channel names match existing Tauri command names so the frontend API barely changes.

**Tech Stack:** Electron 36+, Electron Forge, Vite, React 18, TypeScript, better-sqlite3, @anthropic-ai/claude-agent-sdk, Vitest

**Spec:** `docs/superpowers/specs/2026-04-09-electron-migration-design.md`

---

## Task 1: Scaffold Electron Forge Project

**Files:**
- Create: `electron/main.ts`
- Create: `electron/preload.ts`
- Create: `vite.main.config.ts`
- Create: `vite.preload.config.ts`
- Create: `vite.renderer.config.ts`
- Create: `forge.config.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `index.html`

This task scaffolds the Electron app, gets a window rendering the existing React UI, and verifies the dev loop works. No backend services yet.

- [ ] **Step 1: Install Electron and Forge dependencies**

```bash
npm install --save-dev electron @electron-forge/cli @electron-forge/plugin-vite @electron-forge/maker-dmg @electron-forge/maker-squirrel @electron-forge/maker-deb @electron-forge/maker-zip
```

- [ ] **Step 2: Create `forge.config.ts`**

```typescript
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'GreyChrist',
    executableName: 'greychrist',
    icon: './icons/icon',
    asar: true,
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux'],
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'electron/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'electron/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
```

- [ ] **Step 3: Create `vite.main.config.ts`**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['better-sqlite3'],
    },
  },
});
```

- [ ] **Step 4: Create `vite.preload.config.ts`**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({});
```

- [ ] **Step 5: Create `vite.renderer.config.ts`**

This replaces the existing `vite.config.ts` for the renderer. Copy the existing config and adapt:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'ui-vendor': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-select',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-switch',
            '@radix-ui/react-popover',
          ],
          'editor-vendor': ['@uiw/react-md-editor'],
          'syntax-vendor': ['react-syntax-highlighter'],
          utils: ['date-fns', 'clsx', 'tailwind-merge'],
        },
      },
    },
  },
});
```

- [ ] **Step 6: Create `electron/main.ts`**

```typescript
import { app, BrowserWindow } from 'electron';
import path from 'node:path';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export { mainWindow };
```

- [ ] **Step 7: Create `electron/preload.ts`**

Minimal for now — just the invoke bridge:

```typescript
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, params?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke(channel, params),

  onEvent: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  showOpenDialog: (options: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('dialog:open', options),

  showSaveDialog: (options: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('dialog:save', options),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url),
});
```

- [ ] **Step 8: Add TypeScript declaration for the preload API**

Create `src/electron.d.ts`:

```typescript
interface ElectronAPI {
  invoke: (channel: string, params?: Record<string, unknown>) => Promise<unknown>;
  onEvent: (channel: string, callback: (...args: unknown[]) => void) => () => void;
  showOpenDialog: (options: Record<string, unknown>) => Promise<unknown>;
  showSaveDialog: (options: Record<string, unknown>) => Promise<unknown>;
  openExternal: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
```

- [ ] **Step 9: Update `package.json` scripts and main entry**

Add to `package.json`:

```json
{
  "main": ".vite/build/main.js",
  "scripts": {
    "start": "electron-forge start",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "dev": "electron-forge start",
    "build": "vite build --config vite.renderer.config.ts",
    "check": "tsc --noEmit"
  }
}
```

Remove the old Tauri-specific scripts (`tauri dev`, `tauri build`).

- [ ] **Step 10: Update `index.html`**

Remove any Tauri-specific script tags. The `index.html` should have a standard Vite entry:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GreyChrist</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 11: Verify the app starts**

```bash
npm run start
```

Expected: An Electron window opens showing the React app. API calls will fail (no handlers registered yet) but the UI should render. Check the developer console — no crash on startup.

- [ ] **Step 12: Commit**

```bash
git add electron/ forge.config.ts vite.main.config.ts vite.preload.config.ts vite.renderer.config.ts src/electron.d.ts package.json package-lock.json index.html
git commit -m "feat: scaffold Electron Forge app with Vite plugin"
```

---

## Task 2: Database Service

**Files:**
- Create: `electron/services/database.ts`
- Create: `electron/__tests__/database.test.ts`

- [ ] **Step 1: Install better-sqlite3 and vitest**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3 vitest @vitest/coverage-v8
```

- [ ] **Step 2: Write the failing test**

```typescript
// electron/__tests__/database.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';

describe('database', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain('accounts');
    expect(names).toContain('account_path_rules');
    expect(names).toContain('project_account_overrides');
    expect(names).toContain('agents');
    expect(names).toContain('agent_runs');
    expect(names).toContain('app_settings');
    expect(names).toContain('app_logs');
  });

  it('agents table has correct columns', () => {
    const info = db.raw.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'name', 'icon', 'system_prompt', 'default_task',
        'model', 'hooks', 'created_at', 'updated_at',
      ])
    );
  });

  it('accounts table has claude_binary column', () => {
    const info = db.raw.prepare('PRAGMA table_info(accounts)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain('claude_binary');
  });

  it('getSetting and saveSetting work', () => {
    db.saveSetting('theme', 'dark');
    expect(db.getSetting('theme')).toBe('dark');

    db.saveSetting('theme', 'light');
    expect(db.getSetting('theme')).toBe('light');
  });

  it('getSetting returns null for missing key', () => {
    expect(db.getSetting('nonexistent')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run electron/__tests__/database.test.ts
```

Expected: FAIL — `Cannot find module '../services/database'`

- [ ] **Step 4: Implement the database service**

```typescript
// electron/services/database.ts
import BetterSqlite3 from 'better-sqlite3';

export interface Database {
  raw: BetterSqlite3.Database;
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
  close(): void;
}

export function createDatabase(dbPath: string): Database {
  const raw = new BetterSqlite3(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  initSchema(raw);

  return {
    raw,

    getSetting(key: string): string | null {
      const row = raw
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },

    saveSetting(key: string, value: string): void {
      raw
        .prepare(
          `INSERT INTO app_settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
        )
        .run(key, value);
    },

    close(): void {
      raw.close();
    },
  };
}

function initSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      default_task TEXT,
      model TEXT NOT NULL DEFAULT 'sonnet',
      enable_file_read BOOLEAN NOT NULL DEFAULT 1,
      enable_file_write BOOLEAN NOT NULL DEFAULT 1,
      enable_network BOOLEAN NOT NULL DEFAULT 0,
      hooks TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      agent_name TEXT NOT NULL,
      agent_icon TEXT NOT NULL,
      task TEXT NOT NULL,
      model TEXT NOT NULL,
      project_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      pid INTEGER,
      process_started_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      config_dir TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT 0,
      account_type TEXT NOT NULL DEFAULT 'pro',
      claude_binary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS account_path_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      path_prefix TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_account_overrides (
      project_path TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT,
      message TEXT NOT NULL,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_app_logs_timestamp ON app_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
    CREATE INDEX IF NOT EXISTS idx_app_logs_source ON app_logs(source);
  `);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run electron/__tests__/database.test.ts
```

Expected: All 5 tests PASS

- [ ] **Step 6: Commit**

```bash
git add electron/services/database.ts electron/__tests__/database.test.ts package.json package-lock.json
git commit -m "feat: add database service with better-sqlite3 and schema init"
```

---

## Task 3: IPC Handlers and API Swap

**Files:**
- Create: `electron/ipc/handlers.ts`
- Modify: `electron/main.ts`
- Modify: `src/lib/apiAdapter.ts`
- Create: `electron/__tests__/ipc-handlers.test.ts`

This task wires up IPC so the renderer can call the main process. We register stub handlers first — they'll be connected to real services in later tasks.

- [ ] **Step 1: Write the failing test**

```typescript
// electron/__tests__/ipc-handlers.test.ts
import { describe, it, expect } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';

describe('ipc handlers', () => {
  it('returns a map of channel names to handler functions', () => {
    const handlers = getHandlerMap();
    expect(handlers).toBeDefined();
    expect(typeof handlers).toBe('object');
  });

  it('has handlers for core channels', () => {
    const handlers = getHandlerMap();
    const channels = Object.keys(handlers);
    expect(channels).toContain('list_accounts');
    expect(channels).toContain('resolve_account_for_project');
    expect(channels).toContain('list_projects');
    expect(channels).toContain('get_project_sessions');
  });

  it('all handler values are functions', () => {
    const handlers = getHandlerMap();
    for (const [channel, handler] of Object.entries(handlers)) {
      expect(typeof handler).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run electron/__tests__/ipc-handlers.test.ts
```

Expected: FAIL — `Cannot find module '../ipc/handlers'`

- [ ] **Step 3: Create the handler map**

```typescript
// electron/ipc/handlers.ts
import { ipcMain, dialog, shell } from 'electron';

type HandlerFn = (params?: any) => Promise<unknown> | unknown;

let handlerMap: Record<string, HandlerFn> = {};

export function getHandlerMap(): Record<string, HandlerFn> {
  return handlerMap;
}

export function setHandlerMap(map: Record<string, HandlerFn>): void {
  handlerMap = map;
}

export function registerIpcHandlers(services: {
  accounts?: any;
  claude?: any;
  sessions?: any;
  agents?: any;
  usage?: any;
  checkpoints?: any;
  claudeBinary?: any;
  mcp?: any;
  slashCommands?: any;
  logging?: any;
  storage?: any;
  proxy?: any;
  database?: any;
}): void {
  // Build handler map from available services
  const map: Record<string, HandlerFn> = {};

  // Account Management
  if (services.accounts) {
    map['list_accounts'] = () => services.accounts.listAccounts();
    map['create_account'] = (p: any) => services.accounts.createAccount(p.name, p.configDir, p.isDefault, p.accountType);
    map['update_account'] = (p: any) => services.accounts.updateAccount(p.id, p.name, p.configDir, p.accountType);
    map['delete_account'] = (p: any) => services.accounts.deleteAccount(p.id);
    map['set_default_account'] = (p: any) => services.accounts.setDefaultAccount(p.id);
    map['list_path_rules'] = () => services.accounts.listPathRules();
    map['add_path_rule'] = (p: any) => services.accounts.addPathRule(p.accountId, p.pathPrefix, p.priority);
    map['remove_path_rule'] = (p: any) => services.accounts.removePathRule(p.ruleId);
    map['resolve_account_for_project'] = (p: any) => services.accounts.resolve(p.projectPath);
    map['set_project_account_override'] = (p: any) => services.accounts.setProjectOverride(p.projectPath, p.accountId);
    map['list_project_overrides'] = () => services.accounts.listProjectOverrides();
    map['discover_accounts'] = () => services.accounts.discoverAccounts();
    map['explain_account_resolution'] = (p: any) => services.accounts.explainResolution(p.projectPath);
  }

  // Project & Session Management
  if (services.claude) {
    map['list_projects'] = () => services.claude.listProjects();
    map['create_project'] = (p: any) => services.claude.createProject(p.path);
    map['get_project_sessions'] = (p: any) => services.claude.getProjectSessions(p.projectId, p.projectPath);
    map['load_session_history'] = (p: any) => services.claude.loadSessionHistory(p.sessionId, p.projectId, p.projectPath);
    map['load_agent_session_history'] = (p: any) => services.claude.loadAgentSessionHistory(p.sessionId);
    map['get_home_directory'] = () => services.claude.getHomeDirectory();
    map['get_claude_settings'] = (p: any) => services.claude.getClaudeSettings(p);
    map['save_claude_settings'] = (p: any) => services.claude.saveClaudeSettings(p.settings, p);
    map['get_system_prompt'] = () => services.claude.getSystemPrompt();
    map['save_system_prompt'] = (p: any) => services.claude.saveSystemPrompt(p.content);
    map['check_claude_version'] = () => services.claude.checkClaudeVersion();
    map['find_claude_md_files'] = (p: any) => services.claude.findClaudeMdFiles(p.projectPath);
    map['read_claude_md_file'] = (p: any) => services.claude.readClaudeMdFile(p.filePath);
    map['save_claude_md_file'] = (p: any) => services.claude.saveClaudeMdFile(p.filePath, p.content);
  }

  // Sessions (SDK)
  if (services.sessions) {
    map['session_start'] = (p: any) => services.sessions.start(p);
    map['session_send_message'] = (p: any) => services.sessions.sendMessage(p.tabId, p.prompt);
    map['session_respond_permission'] = (p: any) => services.sessions.respondPermission(p.tabId, p.behavior, p.updatedInput);
    map['session_stop'] = (p: any) => services.sessions.stop(p.tabId);
    map['session_get_info'] = (p: any) => services.sessions.getInfo(p.tabId);
  }

  // Agents
  if (services.agents) {
    map['list_agents'] = () => services.agents.listAgents();
    map['create_agent'] = (p: any) => services.agents.createAgent(p);
    map['update_agent'] = (p: any) => services.agents.updateAgent(p);
    map['delete_agent'] = (p: any) => services.agents.deleteAgent(p.id);
    map['get_agent'] = (p: any) => services.agents.getAgent(p.id);
    map['export_agent'] = (p: any) => services.agents.exportAgent(p.id);
    map['import_agent'] = (p: any) => services.agents.importAgent(p.jsonData);
    map['execute_agent'] = (p: any) => services.agents.executeAgent(p);
    map['list_agent_runs'] = (p: any) => services.agents.listAgentRuns(p?.agentId);
    map['get_agent_run'] = (p: any) => services.agents.getAgentRun(p.id);
    map['get_agent_run_with_real_time_metrics'] = (p: any) => services.agents.getAgentRunWithRealTimeMetrics(p.id);
    map['kill_agent_session'] = (p: any) => services.agents.killAgentSession(p.runId);
    map['get_session_status'] = (p: any) => services.agents.getSessionStatus(p.runId);
    map['cleanup_finished_processes'] = () => services.agents.cleanupFinishedProcesses();
    map['get_session_output'] = (p: any) => services.agents.getSessionOutput(p.runId);
    map['get_live_session_output'] = (p: any) => services.agents.getLiveSessionOutput(p.runId);
    map['stream_session_output'] = (p: any) => services.agents.streamSessionOutput(p.runId);
    map['fetch_github_agents'] = () => services.agents.fetchGitHubAgents();
    map['fetch_github_agent_content'] = (p: any) => services.agents.fetchGitHubAgentContent(p.downloadUrl);
    map['import_agent_from_github'] = (p: any) => services.agents.importAgentFromGitHub(p.downloadUrl);
  }

  // Usage
  if (services.usage) {
    map['get_usage_stats'] = () => services.usage.getUsageStats();
    map['get_usage_by_date_range'] = (p: any) => services.usage.getUsageByDateRange(p.startDate, p.endDate);
    map['get_session_stats'] = (p: any) => services.usage.getSessionStats(p?.since, p?.until, p?.order);
    map['get_usage_details'] = (p: any) => services.usage.getUsageDetails(p?.limit);
  }

  // Checkpoints
  if (services.checkpoints) {
    map['create_checkpoint'] = (p: any) => services.checkpoints.createCheckpoint(p);
    map['restore_checkpoint'] = (p: any) => services.checkpoints.restoreCheckpoint(p);
    map['list_checkpoints'] = (p: any) => services.checkpoints.listCheckpoints(p);
    map['fork_from_checkpoint'] = (p: any) => services.checkpoints.forkFromCheckpoint(p);
    map['get_session_timeline'] = (p: any) => services.checkpoints.getSessionTimeline(p);
    map['update_checkpoint_settings'] = (p: any) => services.checkpoints.updateCheckpointSettings(p);
    map['get_checkpoint_diff'] = (p: any) => services.checkpoints.getCheckpointDiff(p);
  }

  // Claude Binary
  if (services.claudeBinary) {
    map['get_claude_binary_path'] = () => services.claudeBinary.getPath();
    map['set_claude_binary_path'] = (p: any) => services.claudeBinary.setPath(p.path);
    map['list_claude_installations'] = () => services.claudeBinary.listInstallations();
  }

  // MCP
  if (services.mcp) {
    map['mcp_add'] = (p: any) => services.mcp.add(p);
    map['mcp_list'] = () => services.mcp.list();
    map['mcp_get'] = (p: any) => services.mcp.get(p.name);
    map['mcp_remove'] = (p: any) => services.mcp.remove(p.name);
    map['mcp_add_json'] = (p: any) => services.mcp.addJson(p);
    map['mcp_add_from_claude_desktop'] = (p: any) => services.mcp.addFromClaudeDesktop(p?.scope);
    map['mcp_serve'] = () => services.mcp.serve();
    map['mcp_test_connection'] = (p: any) => services.mcp.testConnection(p.name);
    map['mcp_reset_project_choices'] = () => services.mcp.resetProjectChoices();
    map['mcp_get_server_status'] = () => services.mcp.getServerStatus();
    map['mcp_read_project_config'] = (p: any) => services.mcp.readProjectConfig(p.projectPath);
    map['mcp_save_project_config'] = (p: any) => services.mcp.saveProjectConfig(p.projectPath, p.config);
  }

  // Slash Commands
  if (services.slashCommands) {
    map['slash_commands_list'] = (p: any) => services.slashCommands.list(p?.projectPath);
    map['slash_command_get'] = (p: any) => services.slashCommands.get(p.commandId);
    map['slash_command_save'] = (p: any) => services.slashCommands.save(p);
    map['slash_command_delete'] = (p: any) => services.slashCommands.delete(p.commandId, p?.projectPath);
  }

  // Logging
  if (services.logging) {
    map['log_write_batch'] = (p: any) => services.logging.writeBatch(p.entries);
    map['log_query'] = (p: any) => services.logging.query(p);
  }

  // Storage Inspector
  if (services.storage) {
    map['storage_list_tables'] = () => services.storage.listTables();
    map['storage_read_table'] = (p: any) => services.storage.readTable(p.tableName, p.page, p.pageSize, p?.searchQuery);
    map['storage_update_row'] = (p: any) => services.storage.updateRow(p.tableName, p.primaryKeyValues, p.updates);
    map['storage_delete_row'] = (p: any) => services.storage.deleteRow(p.tableName, p.primaryKeyValues);
    map['storage_insert_row'] = (p: any) => services.storage.insertRow(p.tableName, p.values);
    map['storage_execute_sql'] = (p: any) => services.storage.executeSql(p.query);
    map['storage_reset_database'] = () => services.storage.resetDatabase();
    map['get_setting'] = (p: any) => services.database?.getSetting(p.key) ?? null;
    map['save_setting'] = (p: any) => { services.database?.saveSetting(p.key, p.value); };
  }

  // Proxy
  if (services.proxy) {
    map['get_proxy_settings'] = () => services.proxy.getSettings();
    map['save_proxy_settings'] = (p: any) => services.proxy.saveSettings(p);
  }

  // Hooks
  if (services.claude) {
    map['get_hooks_config'] = (p: any) => services.claude.getHooksConfig(p.scope, p?.projectPath);
    map['update_hooks_config'] = (p: any) => services.claude.updateHooksConfig(p.scope, p.hooks, p?.projectPath);
    map['validate_hook_command'] = (p: any) => services.claude.validateHookCommand(p.command);
    map['get_merged_hooks_config'] = (p: any) => services.claude.getMergedHooksConfig(p.projectPath);
  }

  // Electron-specific: dialogs and shell
  map['dialog:open'] = async (options: any) => {
    const result = await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths;
  };
  map['dialog:save'] = async (options: any) => {
    const result = await dialog.showSaveDialog(options);
    return result.canceled ? null : result.filePath;
  };
  map['shell:openExternal'] = (url: string) => shell.openExternal(url);

  setHandlerMap(map);

  // Register all with ipcMain
  for (const [channel, handler] of Object.entries(map)) {
    ipcMain.handle(channel, async (_event, params) => {
      try {
        return await handler(params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
      }
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run electron/__tests__/ipc-handlers.test.ts
```

Expected: All 3 tests PASS

- [ ] **Step 5: Update `electron/main.ts` to register handlers and initialize database**

```typescript
// Add to electron/main.ts, after imports:
import { createDatabase } from './services/database';
import { registerIpcHandlers } from './ipc/handlers';
import { app } from 'electron';
import path from 'node:path';

// Add inside app.whenReady().then():
const userDataPath = app.getPath('userData');
const db = createDatabase(path.join(userDataPath, 'greychrist.db'));

registerIpcHandlers({ database: db });

// Add app.on('before-quit'):
app.on('before-quit', () => {
  db.close();
});
```

- [ ] **Step 6: Swap the frontend API adapter**

Replace the implementation of `apiCall` in `src/lib/apiAdapter.ts`:

```typescript
// src/lib/apiAdapter.ts

export async function apiCall<T>(command: string, params?: Record<string, unknown>): Promise<T> {
  return window.electronAPI.invoke(command, params) as Promise<T>;
}
```

Remove all Tauri-specific code: `detectEnvironment()`, `handleStreamingCommand()`, `mapCommandToEndpoint()`, `restApiCall()`, the WebSocket code, and the `invoke` import from `@tauri-apps/api/core`. Remove the `window.__TAURI__` polyfill.

- [ ] **Step 7: Verify the app starts with the new IPC layer**

```bash
npm run start
```

Expected: App renders. API calls return errors (services not yet connected) but no crashes. Check console for `ipcMain.handle` registration.

- [ ] **Step 8: Commit**

```bash
git add electron/ipc/ electron/__tests__/ipc-handlers.test.ts electron/main.ts src/lib/apiAdapter.ts
git commit -m "feat: wire IPC handlers and swap frontend API to Electron"
```

---

## Task 4: Accounts Service

**Files:**
- Create: `electron/services/accounts.ts`
- Create: `electron/__tests__/accounts.test.ts`
- Modify: `electron/main.ts` (register accounts service)

This is the most critical service — multi-account routing is the core product value. Full TDD with comprehensive tests.

- [ ] **Step 1: Write the failing tests**

```typescript
// electron/__tests__/accounts.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';

describe('accounts service', () => {
  let db: Database;
  let accounts: AccountsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('CRUD', () => {
    it('creates and lists accounts', () => {
      accounts.createAccount('Work', '/home/user/.claude-work', false, 'pro');
      accounts.createAccount('Personal', '/home/user/.claude', true, 'pro');

      const list = accounts.listAccounts();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('Work');
      expect(list[1].name).toBe('Personal');
      expect(list[1].is_default).toBe(true);
    });

    it('updates an account', () => {
      accounts.createAccount('Work', '/old/path', false, 'pro');
      const list = accounts.listAccounts();
      accounts.updateAccount(list[0].id, 'Work Updated', '/new/path', 'max');

      const updated = accounts.listAccounts();
      expect(updated[0].name).toBe('Work Updated');
      expect(updated[0].config_dir).toBe('/new/path');
      expect(updated[0].account_type).toBe('max');
    });

    it('deletes an account', () => {
      accounts.createAccount('Temp', '/tmp/.claude', false, 'pro');
      const list = accounts.listAccounts();
      accounts.deleteAccount(list[0].id);
      expect(accounts.listAccounts()).toHaveLength(0);
    });

    it('sets default account (clears previous default)', () => {
      accounts.createAccount('A', '/a', true, 'pro');
      accounts.createAccount('B', '/b', false, 'pro');
      const list = accounts.listAccounts();

      accounts.setDefaultAccount(list[1].id);
      const updated = accounts.listAccounts();
      expect(updated.find((a) => a.name === 'A')!.is_default).toBe(false);
      expect(updated.find((a) => a.name === 'B')!.is_default).toBe(true);
    });
  });

  describe('path rules', () => {
    it('adds and lists path rules', () => {
      accounts.createAccount('Work', '/work/.claude', false, 'pro');
      const acct = accounts.listAccounts()[0];

      accounts.addPathRule(acct.id, '/home/user/work', 0);
      accounts.addPathRule(acct.id, '/home/user/work/special', 10);

      const rules = accounts.listPathRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].path_prefix).toBe('/home/user/work');
    });

    it('removes a path rule', () => {
      accounts.createAccount('Work', '/work/.claude', false, 'pro');
      const acct = accounts.listAccounts()[0];
      accounts.addPathRule(acct.id, '/home/user/work', 0);

      const rules = accounts.listPathRules();
      accounts.removePathRule(rules[0].id);
      expect(accounts.listPathRules()).toHaveLength(0);
    });
  });

  describe('resolution', () => {
    it('resolves via explicit project override', () => {
      accounts.createAccount('Override', '/override/.claude', false, 'pro');
      const acct = accounts.listAccounts()[0];
      accounts.setProjectOverride('/my/project', acct.id);

      const resolved = accounts.resolve('/my/project');
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('Override');
    });

    it('resolves via longest matching path rule', () => {
      accounts.createAccount('General', '/general/.claude', false, 'pro');
      accounts.createAccount('Specific', '/specific/.claude', false, 'pro');
      const list = accounts.listAccounts();

      accounts.addPathRule(list[0].id, '/home/user', 0);
      accounts.addPathRule(list[1].id, '/home/user/repos/special', 0);

      const resolved = accounts.resolve('/home/user/repos/special/project');
      expect(resolved!.name).toBe('Specific');
    });

    it('resolves via default account when no rule matches', () => {
      accounts.createAccount('Default', '/default/.claude', true, 'pro');

      const resolved = accounts.resolve('/random/path');
      expect(resolved!.name).toBe('Default');
    });

    it('returns null when nothing matches', () => {
      accounts.createAccount('NotDefault', '/nd/.claude', false, 'pro');
      const resolved = accounts.resolve('/random/path');
      expect(resolved).toBeNull();
    });

    it('path rule beats default account', () => {
      accounts.createAccount('Default', '/default/.claude', true, 'pro');
      accounts.createAccount('RuleBased', '/rule/.claude', false, 'pro');
      const list = accounts.listAccounts();

      accounts.addPathRule(list[1].id, '/matched/path', 0);

      const resolved = accounts.resolve('/matched/path/subdir');
      expect(resolved!.name).toBe('RuleBased');
    });

    it('explicit override beats path rule', () => {
      accounts.createAccount('Rule', '/rule/.claude', false, 'pro');
      accounts.createAccount('Override', '/override/.claude', false, 'pro');
      const list = accounts.listAccounts();

      accounts.addPathRule(list[0].id, '/project', 0);
      accounts.setProjectOverride('/project/dir', list[1].id);

      const resolved = accounts.resolve('/project/dir');
      expect(resolved!.name).toBe('Override');
    });
  });

  describe('explain resolution', () => {
    it('explains override match', () => {
      accounts.createAccount('A', '/a/.claude', false, 'pro');
      const acct = accounts.listAccounts()[0];
      accounts.setProjectOverride('/my/project', acct.id);

      const explanation = accounts.explainResolution('/my/project');
      expect(explanation).not.toBeNull();
      expect(explanation!.match_type).toBe('override');
    });

    it('explains path rule match', () => {
      accounts.createAccount('A', '/a/.claude', false, 'pro');
      const acct = accounts.listAccounts()[0];
      accounts.addPathRule(acct.id, '/repos', 0);

      const explanation = accounts.explainResolution('/repos/myproject');
      expect(explanation!.match_type).toBe('path_rule');
    });
  });

  describe('discover accounts', () => {
    it('returns an array', () => {
      const discovered = accounts.discoverAccounts();
      expect(Array.isArray(discovered)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run electron/__tests__/accounts.test.ts
```

Expected: FAIL — `Cannot find module '../services/accounts'`

- [ ] **Step 3: Implement the accounts service**

```typescript
// electron/services/accounts.ts
import type { Database } from './database';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  is_default: boolean;
  account_type: string;
  claude_binary: string | null;
  created_at: string;
  updated_at: string;
}

export interface PathRule {
  id: number;
  account_id: number;
  account_name: string;
  path_prefix: string;
  priority: number;
}

export interface ProjectOverride {
  project_path: string;
  account_id: number;
  account_name: string;
}

export interface ResolutionExplanation {
  account: Account;
  match_type: 'override' | 'path_rule' | 'default';
  match_detail: string;
}

export interface AccountsService {
  listAccounts(): Account[];
  createAccount(name: string, configDir: string, isDefault: boolean, accountType?: string): Account;
  updateAccount(id: number, name: string, configDir: string, accountType?: string): void;
  deleteAccount(id: number): void;
  setDefaultAccount(id: number): void;
  listPathRules(): PathRule[];
  addPathRule(accountId: number, pathPrefix: string, priority?: number): void;
  removePathRule(ruleId: number): void;
  resolve(projectPath: string): Account | null;
  setProjectOverride(projectPath: string, accountId: number): void;
  listProjectOverrides(): ProjectOverride[];
  explainResolution(projectPath: string): ResolutionExplanation | null;
  discoverAccounts(): [string, string][];
}

export function createAccountsService(db: Database): AccountsService {
  const raw = db.raw;

  return {
    listAccounts(): Account[] {
      return raw
        .prepare('SELECT id, name, config_dir, is_default, account_type, claude_binary, created_at, updated_at FROM accounts ORDER BY name')
        .all() as Account[];
    },

    createAccount(name: string, configDir: string, isDefault: boolean, accountType = 'pro'): Account {
      if (isDefault) {
        raw.prepare('UPDATE accounts SET is_default = 0').run();
      }
      const result = raw
        .prepare('INSERT INTO accounts (name, config_dir, is_default, account_type) VALUES (?, ?, ?, ?)')
        .run(name, configDir, isDefault ? 1 : 0, accountType);
      return raw.prepare('SELECT * FROM accounts WHERE id = ?').get(result.lastInsertRowid) as Account;
    },

    updateAccount(id: number, name: string, configDir: string, accountType?: string): void {
      if (accountType) {
        raw.prepare('UPDATE accounts SET name = ?, config_dir = ?, account_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(name, configDir, accountType, id);
      } else {
        raw.prepare('UPDATE accounts SET name = ?, config_dir = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(name, configDir, id);
      }
    },

    deleteAccount(id: number): void {
      raw.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    },

    setDefaultAccount(id: number): void {
      raw.prepare('UPDATE accounts SET is_default = 0').run();
      raw.prepare('UPDATE accounts SET is_default = 1 WHERE id = ?').run(id);
    },

    listPathRules(): PathRule[] {
      return raw
        .prepare(`
          SELECT r.id, r.account_id, a.name as account_name, r.path_prefix, r.priority
          FROM account_path_rules r
          JOIN accounts a ON a.id = r.account_id
          ORDER BY r.path_prefix
        `)
        .all() as PathRule[];
    },

    addPathRule(accountId: number, pathPrefix: string, priority = 0): void {
      raw.prepare('INSERT INTO account_path_rules (account_id, path_prefix, priority) VALUES (?, ?, ?)')
        .run(accountId, pathPrefix, priority);
    },

    removePathRule(ruleId: number): void {
      raw.prepare('DELETE FROM account_path_rules WHERE id = ?').run(ruleId);
    },

    resolve(projectPath: string): Account | null {
      // 1. Explicit project override
      const override = raw
        .prepare(`
          SELECT a.* FROM accounts a
          JOIN project_account_overrides o ON o.account_id = a.id
          WHERE o.project_path = ?
        `)
        .get(projectPath) as Account | undefined;
      if (override) return override;

      // 2. Longest matching path rule
      const rules = raw
        .prepare(`
          SELECT a.*, r.path_prefix FROM accounts a
          JOIN account_path_rules r ON r.account_id = a.id
          ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC
        `)
        .all() as (Account & { path_prefix: string })[];

      for (const rule of rules) {
        if (projectPath.startsWith(rule.path_prefix)) {
          const { path_prefix: _, ...account } = rule;
          return account;
        }
      }

      // 3. Default account
      const defaultAcct = raw
        .prepare('SELECT * FROM accounts WHERE is_default = 1')
        .get() as Account | undefined;
      if (defaultAcct) return defaultAcct;

      // 4. No match
      return null;
    },

    setProjectOverride(projectPath: string, accountId: number): void {
      raw
        .prepare('INSERT OR REPLACE INTO project_account_overrides (project_path, account_id) VALUES (?, ?)')
        .run(projectPath, accountId);
    },

    listProjectOverrides(): ProjectOverride[] {
      return raw
        .prepare(`
          SELECT o.project_path, o.account_id, a.name as account_name
          FROM project_account_overrides o
          JOIN accounts a ON a.id = o.account_id
          ORDER BY o.project_path
        `)
        .all() as ProjectOverride[];
    },

    explainResolution(projectPath: string): ResolutionExplanation | null {
      // 1. Check override
      const override = raw
        .prepare(`
          SELECT a.* FROM accounts a
          JOIN project_account_overrides o ON o.account_id = a.id
          WHERE o.project_path = ?
        `)
        .get(projectPath) as Account | undefined;
      if (override) {
        return { account: override, match_type: 'override', match_detail: `Explicit override for ${projectPath}` };
      }

      // 2. Check path rules
      const rules = raw
        .prepare(`
          SELECT a.*, r.path_prefix FROM accounts a
          JOIN account_path_rules r ON r.account_id = a.id
          ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC
        `)
        .all() as (Account & { path_prefix: string })[];

      for (const rule of rules) {
        if (projectPath.startsWith(rule.path_prefix)) {
          const { path_prefix, ...account } = rule;
          return { account, match_type: 'path_rule', match_detail: `Matched path rule: ${path_prefix}` };
        }
      }

      // 3. Default
      const defaultAcct = raw
        .prepare('SELECT * FROM accounts WHERE is_default = 1')
        .get() as Account | undefined;
      if (defaultAcct) {
        return { account: defaultAcct, match_type: 'default', match_detail: 'Default account' };
      }

      return null;
    },

    discoverAccounts(): [string, string][] {
      const home = os.homedir();
      const candidates: [string, string][] = [];

      // Check default ~/.claude
      const defaultDir = path.join(home, '.claude');
      if (fs.existsSync(defaultDir)) {
        candidates.push(['Default', defaultDir]);
      }

      // Check for other .claude-* directories
      try {
        const entries = fs.readdirSync(home, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
            const configDir = path.join(home, entry.name);
            const label = entry.name.replace('.claude-', '');
            candidates.push([label, configDir]);
          }
        }
      } catch {
        // Permission denied or similar — skip
      }

      return candidates;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run electron/__tests__/accounts.test.ts
```

Expected: All 13 tests PASS

- [ ] **Step 5: Register accounts service in main.ts**

Add to `electron/main.ts` inside `app.whenReady().then()`, after database creation:

```typescript
import { createAccountsService } from './services/accounts';

// After db creation:
const accountsService = createAccountsService(db);
registerIpcHandlers({ database: db, accounts: accountsService });
```

- [ ] **Step 6: Verify the app starts with accounts wired**

```bash
npm run start
```

Expected: App renders. Account-related API calls now work (list_accounts, resolve_account_for_project, etc.).

- [ ] **Step 7: Commit**

```bash
git add electron/services/accounts.ts electron/__tests__/accounts.test.ts electron/main.ts
git commit -m "feat: add accounts service with CRUD, path rules, and resolution"
```

---

## Task 5: Claude Binary Discovery

**Files:**
- Create: `electron/services/claude-binary.ts`
- Create: `electron/__tests__/claude-binary.test.ts`
- Modify: `electron/main.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// electron/__tests__/claude-binary.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createClaudeBinaryService, type ClaudeBinaryService } from '../services/claude-binary';

describe('claude binary service', () => {
  let db: Database;
  let service: ClaudeBinaryService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    service = createClaudeBinaryService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('getPath returns null when no custom path configured', () => {
    expect(service.getPath()).toBeNull();
  });

  it('setPath stores and getPath retrieves', () => {
    service.setPath('/usr/local/bin/claude');
    expect(service.getPath()).toBe('/usr/local/bin/claude');
  });

  it('listInstallations returns an array', () => {
    const installations = service.listInstallations();
    expect(Array.isArray(installations)).toBe(true);
  });

  it('listInstallations includes standard paths that exist', () => {
    const installations = service.listInstallations();
    // Each installation should have path and version fields
    for (const inst of installations) {
      expect(inst).toHaveProperty('path');
      expect(typeof inst.path).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run electron/__tests__/claude-binary.test.ts
```

Expected: FAIL — `Cannot find module '../services/claude-binary'`

- [ ] **Step 3: Implement the claude binary service**

```typescript
// electron/services/claude-binary.ts
import type { Database } from './database';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

export interface ClaudeInstallation {
  path: string;
  version: string | null;
  source: string;
}

export interface ClaudeBinaryService {
  getPath(): string | null;
  setPath(binaryPath: string): void;
  listInstallations(): ClaudeInstallation[];
  findBestBinary(): string | null;
}

export function createClaudeBinaryService(db: Database): ClaudeBinaryService {
  const SETTING_KEY = 'claude_binary_path';

  function getVersion(binaryPath: string): string | null {
    try {
      const output = execSync(`"${binaryPath}" --version`, {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return output || null;
    } catch {
      return null;
    }
  }

  function tryWhich(): string | null {
    try {
      const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (result && fs.existsSync(result.split('\n')[0])) {
        return result.split('\n')[0];
      }
    } catch {
      // not found
    }
    return null;
  }

  function findNvmInstallations(): string[] {
    const paths: string[] = [];
    const home = os.homedir();

    // Check NVM_BIN env var
    const nvmBin = process.env.NVM_BIN;
    if (nvmBin) {
      const p = path.join(nvmBin, 'claude');
      if (fs.existsSync(p)) paths.push(p);
    }

    // Check all NVM node versions
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    try {
      if (fs.existsSync(nvmDir)) {
        const versions = fs.readdirSync(nvmDir);
        for (const v of versions) {
          const p = path.join(nvmDir, v, 'bin', 'claude');
          if (fs.existsSync(p)) paths.push(p);
        }
      }
    } catch {
      // permission denied
    }

    return paths;
  }

  function findStandardInstallations(): string[] {
    const home = os.homedir();
    const candidates = [
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
      '/bin/claude',
      path.join(home, '.claude', 'local', 'claude'),
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, '.yarn', 'bin', 'claude'),
      path.join(home, '.bun', 'bin', 'claude'),
      path.join(home, 'bin', 'claude'),
      path.join(home, 'node_modules', '.bin', 'claude'),
      path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'claude'),
    ];

    // VS Code extension paths
    const vscodeDir = path.join(home, '.vscode', 'extensions');
    try {
      if (fs.existsSync(vscodeDir)) {
        const exts = fs.readdirSync(vscodeDir);
        for (const ext of exts) {
          if (ext.startsWith('anthropic.claude-code-')) {
            const p = path.join(vscodeDir, ext, 'resources', 'native-binary', 'claude');
            candidates.push(p);
          }
        }
      }
    } catch {
      // permission denied
    }

    return candidates.filter((p) => fs.existsSync(p));
  }

  return {
    getPath(): string | null {
      return db.getSetting(SETTING_KEY);
    },

    setPath(binaryPath: string): void {
      db.saveSetting(SETTING_KEY, binaryPath);
    },

    listInstallations(): ClaudeInstallation[] {
      const found = new Map<string, ClaudeInstallation>();

      // 1. which/where
      const whichPath = tryWhich();
      if (whichPath) {
        found.set(whichPath, { path: whichPath, version: getVersion(whichPath), source: 'PATH' });
      }

      // 2. NVM
      for (const p of findNvmInstallations()) {
        if (!found.has(p)) {
          found.set(p, { path: p, version: getVersion(p), source: 'nvm' });
        }
      }

      // 3. Standard paths
      for (const p of findStandardInstallations()) {
        if (!found.has(p)) {
          found.set(p, { path: p, version: getVersion(p), source: 'system' });
        }
      }

      return Array.from(found.values());
    },

    findBestBinary(): string | null {
      // Custom configured path takes priority
      const custom = db.getSetting(SETTING_KEY);
      if (custom && fs.existsSync(custom)) return custom;

      // Then which
      const whichPath = tryWhich();
      if (whichPath) return whichPath;

      // Then NVM
      const nvmPaths = findNvmInstallations();
      if (nvmPaths.length > 0) return nvmPaths[0];

      // Then standard
      const stdPaths = findStandardInstallations();
      if (stdPaths.length > 0) return stdPaths[0];

      return null;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run electron/__tests__/claude-binary.test.ts
```

Expected: All 4 tests PASS

- [ ] **Step 5: Register in main.ts**

Add to `electron/main.ts`:

```typescript
import { createClaudeBinaryService } from './services/claude-binary';

// After accounts service creation:
const claudeBinaryService = createClaudeBinaryService(db);
registerIpcHandlers({ database: db, accounts: accountsService, claudeBinary: claudeBinaryService });
```

- [ ] **Step 6: Commit**

```bash
git add electron/services/claude-binary.ts electron/__tests__/claude-binary.test.ts electron/main.ts
git commit -m "feat: add Claude binary discovery service"
```

---

## Task 6: Sessions Service (Claude Agent SDK)

**Files:**
- Create: `electron/services/sessions.ts`
- Create: `electron/services/async-channel.ts`
- Create: `electron/__tests__/sessions.test.ts`
- Modify: `electron/main.ts`

This is the high-value target — the entire reason for the migration.

- [ ] **Step 1: Install the Claude Agent SDK**

```bash
npm install @anthropic-ai/claude-agent-sdk@0.2.97
```

- [ ] **Step 2: Create the async channel utility**

```typescript
// electron/services/async-channel.ts
export interface AsyncChannel<T> {
  push(value: T): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export function createAsyncChannel<T>(): AsyncChannel<T> {
  const queue: T[] = [];
  let resolve: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;

  return {
    push(value: T) {
      if (closed) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value, done: false });
      } else {
        queue.push(value);
      }
    },

    close() {
      closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as any, done: true });
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise<IteratorResult<T>>((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}
```

- [ ] **Step 3: Write the failing tests**

```typescript
// electron/__tests__/sessions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAsyncChannel } from '../services/async-channel';
import { createSessionsService, type SessionsService } from '../services/sessions';

// Mock the SDK — we don't want to actually spawn Claude in tests
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

describe('async channel', () => {
  it('push and pull values in order', async () => {
    const ch = createAsyncChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('waits for pushed values', async () => {
    const ch = createAsyncChannel<string>();

    const promise = (async () => {
      const values: string[] = [];
      for await (const v of ch) {
        values.push(v);
      }
      return values;
    })();

    ch.push('a');
    ch.push('b');
    ch.close();

    const values = await promise;
    expect(values).toEqual(['a', 'b']);
  });

  it('ignores pushes after close', () => {
    const ch = createAsyncChannel<number>();
    ch.close();
    ch.push(1); // should not throw
  });
});

describe('sessions service', () => {
  let service: SessionsService;
  let mockSendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSendToRenderer = vi.fn();
    service = createSessionsService(mockSendToRenderer);
  });

  it('isActive returns false for unknown tab', () => {
    expect(service.isActive('unknown')).toBe(false);
  });

  it('getStatus returns stopped for unknown tab', () => {
    expect(service.getStatus('unknown')).toBe('stopped');
  });

  it('getSessionId returns null for unknown tab', () => {
    expect(service.getSessionId('unknown')).toBeNull();
  });

  it('respondPermission does nothing for unknown tab', () => {
    // Should not throw
    service.respondPermission('unknown', 'allow');
  });

  it('sendMessage does nothing for unknown tab', () => {
    // Should not throw
    service.sendMessage('unknown', 'hello');
  });

  it('stop does nothing for unknown tab', () => {
    // Should not throw
    service.stop('unknown');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
npx vitest run electron/__tests__/sessions.test.ts
```

Expected: FAIL — `Cannot find module '../services/sessions'`

- [ ] **Step 5: Implement the sessions service**

```typescript
// electron/services/sessions.ts
import { query, type SDKMessage, type SDKUserMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, HookEvent, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { createAsyncChannel, type AsyncChannel } from './async-channel';

export type SessionStatus = 'starting' | 'running' | 'waiting_permission' | 'stopped' | 'error';

type SendToRenderer = (channel: string, ...args: unknown[]) => void;

interface SessionHandle {
  query: Query;
  inputChannel: AsyncChannel<SDKUserMessage>;
  sessionId: string | null;
  status: SessionStatus;
  permissionResolver: ((decision: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }) => void) | null;
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
}

export interface SessionStartParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  model: string;
  permissionMode: string;
  claudeBinaryPath?: string;
  resumeSessionId?: string;
}

export interface SessionsService {
  start(params: SessionStartParams): void;
  sendMessage(tabId: string, prompt: string): void;
  respondPermission(tabId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>): void;
  setAutoAllow(tabId: string, enabled: boolean): void;
  addAutoAllowTool(tabId: string, toolName: string): void;
  stop(tabId: string): void;
  stopAll(): void;
  getSessionId(tabId: string): string | null;
  getStatus(tabId: string): SessionStatus;
  getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null;
  isActive(tabId: string): boolean;
}

export function createSessionsService(sendToRenderer: SendToRenderer): SessionsService {
  const sessions = new Map<string, SessionHandle>();

  function listenToMessages(tabId: string, handle: SessionHandle): void {
    (async () => {
      try {
        handle.status = 'running';
        sendToRenderer(`session-status:${tabId}`, 'running');

        for await (const message of handle.query) {
          // Extract session ID from init message
          if (message.type === 'system' && 'subtype' in message && (message as any).subtype === 'init') {
            handle.sessionId = (message as any).session_id || null;
          }

          sendToRenderer(`session-message:${tabId}`, message);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        sendToRenderer(`session-error:${tabId}`, errorMsg);
      } finally {
        handle.status = 'stopped';
        sendToRenderer(`session-status:${tabId}`, 'stopped');
        sessions.delete(tabId);
      }
    })();
  }

  return {
    start(params: SessionStartParams): void {
      const { tabId, projectPath, configDir, model, permissionMode, claudeBinaryPath, resumeSessionId } = params;

      // Stop existing session for this tab
      const existing = sessions.get(tabId);
      if (existing) {
        existing.inputChannel.close();
        try { existing.query.close(); } catch {}
        sessions.delete(tabId);
      }

      const inputChannel = createAsyncChannel<SDKUserMessage>();

      const handle: SessionHandle = {
        query: null as any, // set below
        inputChannel,
        sessionId: null,
        status: 'starting',
        permissionResolver: null,
        autoAllowEnabled: false,
        autoAllowedTools: new Set(),
      };

      sessions.set(tabId, handle);

      const permissionHook = async (input: any): Promise<any> => {
        const toolName = input.tool_name || 'Unknown';
        const toolInput = input.tool_input || {};

        // Auto-allow check
        if (handle.autoAllowEnabled && handle.autoAllowedTools.has(toolName)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: { behavior: 'allow' },
            },
          };
        }

        handle.status = 'waiting_permission';
        sendToRenderer(`session-status:${tabId}`, 'waiting_permission');
        sendToRenderer(`session-permission:${tabId}`, { toolName, toolInput });

        return new Promise((resolve) => {
          handle.permissionResolver = (decision) => {
            handle.permissionResolver = null;
            handle.status = 'running';
            sendToRenderer(`session-status:${tabId}`, 'running');
            resolve({
              hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision,
              },
            });
          };
        });
      };

      const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
        PermissionRequest: [{ hooks: [permissionHook] }],
      };

      const options: any = {
        cwd: projectPath,
        model,
        permissionMode: permissionMode as PermissionMode,
        env: { CLAUDE_CONFIG_DIR: configDir },
        hooks,
        settingSources: ['user', 'project'],
      };

      if (claudeBinaryPath) {
        options.pathToClaudeCodeExecutable = claudeBinaryPath;
      }

      if (resumeSessionId) {
        options.resume = resumeSessionId;
      }

      const q = query({
        prompt: inputChannel,
        options,
      });

      handle.query = q;
      listenToMessages(tabId, handle);
    },

    sendMessage(tabId: string, prompt: string): void {
      const handle = sessions.get(tabId);
      if (!handle) return;

      const userMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      };

      handle.inputChannel.push(userMessage);
    },

    respondPermission(tabId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>): void {
      const handle = sessions.get(tabId);
      if (!handle?.permissionResolver) return;
      handle.permissionResolver({ behavior, updatedInput });
    },

    setAutoAllow(tabId: string, enabled: boolean): void {
      const handle = sessions.get(tabId);
      if (!handle) return;
      handle.autoAllowEnabled = enabled;
      if (!enabled) handle.autoAllowedTools.clear();
    },

    addAutoAllowTool(tabId: string, toolName: string): void {
      const handle = sessions.get(tabId);
      if (!handle) return;
      handle.autoAllowedTools.add(toolName);
    },

    stop(tabId: string): void {
      const handle = sessions.get(tabId);
      if (!handle) return;
      handle.inputChannel.close();
      try { handle.query.close(); } catch {}
      sessions.delete(tabId);
    },

    stopAll(): void {
      for (const tabId of sessions.keys()) {
        const handle = sessions.get(tabId);
        if (handle) {
          handle.inputChannel.close();
          try { handle.query.close(); } catch {}
        }
      }
      sessions.clear();
    },

    getSessionId(tabId: string): string | null {
      return sessions.get(tabId)?.sessionId ?? null;
    },

    getStatus(tabId: string): SessionStatus {
      return sessions.get(tabId)?.status ?? 'stopped';
    },

    getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null {
      const handle = sessions.get(tabId);
      if (!handle) return null;
      return { sessionId: handle.sessionId, status: handle.status };
    },

    isActive(tabId: string): boolean {
      return sessions.has(tabId);
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run electron/__tests__/sessions.test.ts
```

Expected: All 9 tests PASS (3 async channel + 6 sessions)

- [ ] **Step 7: Register in main.ts**

Add to `electron/main.ts`:

```typescript
import { createSessionsService } from './services/sessions';

// After claudeBinaryService creation:
const sessionsService = createSessionsService((channel, ...args) => {
  mainWindow?.webContents.send(channel, ...args);
});

registerIpcHandlers({
  database: db,
  accounts: accountsService,
  claudeBinary: claudeBinaryService,
  sessions: sessionsService,
});

// Update before-quit handler:
app.on('before-quit', () => {
  sessionsService.stopAll();
  db.close();
});
```

- [ ] **Step 8: Commit**

```bash
git add electron/services/sessions.ts electron/services/async-channel.ts electron/__tests__/sessions.test.ts electron/main.ts package.json package-lock.json
git commit -m "feat: add sessions service with Claude Agent SDK integration"
```

---

## Task 7: Claude Service (Projects, Sessions, Settings)

**Files:**
- Create: `electron/services/claude.ts`
- Create: `electron/__tests__/claude.test.ts`
- Modify: `electron/main.ts`

This is the largest service — project listing, session history, settings management, CLAUDE.md operations. It reads JSONL files from Claude config directories.

- [ ] **Step 1: Write the failing tests**

```typescript
// electron/__tests__/claude.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService } from '../services/accounts';
import { createClaudeService, type ClaudeService } from '../services/claude';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('claude service', () => {
  let db: Database;
  let service: ClaudeService;
  let tmpDir: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const accounts = createAccountsService(db);
    service = createClaudeService(db, accounts);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getHomeDirectory returns a string', () => {
    const home = service.getHomeDirectory();
    expect(typeof home).toBe('string');
    expect(home.length).toBeGreaterThan(0);
  });

  it('listProjects returns an array', () => {
    const projects = service.listProjects();
    expect(Array.isArray(projects)).toBe(true);
  });

  it('loadSessionHistory returns empty for non-existent session', () => {
    const history = service.loadSessionHistory('nonexistent', 'proj', undefined);
    expect(history).toEqual([]);
  });

  it('findClaudeMdFiles returns array for any path', () => {
    const files = service.findClaudeMdFiles(tmpDir);
    expect(Array.isArray(files)).toBe(true);
  });

  it('readClaudeMdFile returns empty string for missing file', () => {
    const content = service.readClaudeMdFile(path.join(tmpDir, 'CLAUDE.md'));
    expect(content).toBe('');
  });

  it('saveClaudeMdFile creates and reads back content', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    service.saveClaudeMdFile(filePath, '# Test');
    expect(service.readClaudeMdFile(filePath)).toBe('# Test');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run electron/__tests__/claude.test.ts
```

Expected: FAIL — `Cannot find module '../services/claude'`

- [ ] **Step 3: Implement the claude service**

```typescript
// electron/services/claude.ts
import type { Database } from './database';
import type { AccountsService, Account } from './accounts';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

export interface Project {
  id: string;
  path: string;
  sessions: string[];
  created_at: number;
  most_recent_session?: number;
  account_id?: number;
  account_name?: string;
}

export interface Session {
  id: string;
  project_id: string;
  project_path: string;
  todo_data?: any;
  created_at: number;
  first_message?: string;
  message_timestamp?: string;
}

export interface ClaudeMdFile {
  path: string;
  scope: string;
  exists: boolean;
}

export interface ClaudeVersionStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export interface ClaudeService {
  getHomeDirectory(): string;
  listProjects(): Project[];
  createProject(projectPath: string): Project;
  getProjectSessions(projectId: string, projectPath?: string): Session[];
  loadSessionHistory(sessionId: string, projectId: string, projectPath?: string): any[];
  loadAgentSessionHistory(sessionId: string): any[];
  getClaudeSettings(opts?: { configDir?: string; projectPath?: string }): any;
  saveClaudeSettings(settings: any, opts?: { configDir?: string; projectPath?: string }): string;
  getSystemPrompt(): string;
  saveSystemPrompt(content: string): string;
  checkClaudeVersion(): ClaudeVersionStatus;
  findClaudeMdFiles(projectPath: string): ClaudeMdFile[];
  readClaudeMdFile(filePath: string): string;
  saveClaudeMdFile(filePath: string, content: string): string;
  getHooksConfig(scope: string, projectPath?: string): any;
  updateHooksConfig(scope: string, hooks: any, projectPath?: string): string;
  validateHookCommand(command: string): { valid: boolean; message: string };
  getMergedHooksConfig(projectPath: string): any;
}

export function createClaudeService(db: Database, accounts: AccountsService): ClaudeService {
  function getConfigDirs(): string[] {
    const dirs: string[] = [];
    for (const acct of accounts.listAccounts()) {
      if (fs.existsSync(acct.config_dir)) {
        dirs.push(acct.config_dir);
      }
    }
    // Fallback: default ~/.claude
    const defaultDir = path.join(os.homedir(), '.claude');
    if (!dirs.includes(defaultDir) && fs.existsSync(defaultDir)) {
      dirs.push(defaultDir);
    }
    return dirs;
  }

  function findProjectConfigDir(projectId: string, projectPath?: string): string | null {
    for (const configDir of getConfigDirs()) {
      const projectDir = path.join(configDir, 'projects', projectId);
      if (fs.existsSync(projectDir)) return configDir;
    }
    // Try resolving from project path
    if (projectPath) {
      const acct = accounts.resolve(projectPath);
      if (acct && fs.existsSync(acct.config_dir)) return acct.config_dir;
    }
    return null;
  }

  function readJsonlFile(filePath: string): any[] {
    if (!fs.existsSync(filePath)) return [];
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line); }
          catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function encodeProjectId(projectPath: string): string {
    // Claude encodes project paths as directory names by replacing / with -
    return projectPath.replace(/^\//, '').replace(/\//g, '-');
  }

  return {
    getHomeDirectory(): string {
      return os.homedir();
    },

    listProjects(): Project[] {
      const projects: Map<string, Project> = new Map();
      const allAccounts = accounts.listAccounts();

      for (const acct of allAccounts) {
        const projectsDir = path.join(acct.config_dir, 'projects');
        if (!fs.existsSync(projectsDir)) continue;

        try {
          const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const projectId = entry.name;
            if (projects.has(projectId)) continue;

            const projectDir = path.join(projectsDir, projectId);
            const sessions: string[] = [];
            let mostRecent = 0;

            try {
              const files = fs.readdirSync(projectDir);
              for (const f of files) {
                if (f.endsWith('.jsonl')) {
                  sessions.push(f.replace('.jsonl', ''));
                  const stat = fs.statSync(path.join(projectDir, f));
                  if (stat.mtimeMs > mostRecent) mostRecent = stat.mtimeMs;
                }
              }
            } catch { /* skip */ }

            // Decode project path from ID
            const projectPath = '/' + projectId.replace(/-/g, '/');

            projects.set(projectId, {
              id: projectId,
              path: projectPath,
              sessions,
              created_at: mostRecent || Date.now(),
              most_recent_session: mostRecent || undefined,
              account_id: acct.id,
              account_name: acct.name,
            });
          }
        } catch { /* skip */ }
      }

      return Array.from(projects.values()).sort((a, b) =>
        (b.most_recent_session || b.created_at) - (a.most_recent_session || a.created_at)
      );
    },

    createProject(projectPath: string): Project {
      const projectId = encodeProjectId(projectPath);
      return {
        id: projectId,
        path: projectPath,
        sessions: [],
        created_at: Date.now(),
      };
    },

    getProjectSessions(projectId: string, projectPath?: string): Session[] {
      const configDir = findProjectConfigDir(projectId, projectPath);
      if (!configDir) return [];

      const projectDir = path.join(configDir, 'projects', projectId);
      if (!fs.existsSync(projectDir)) return [];

      const sessions: Session[] = [];
      const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));

      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const filePath = path.join(projectDir, file);
        const stat = fs.statSync(filePath);

        // Extract first user message
        let firstMessage: string | undefined;
        const messages = readJsonlFile(filePath);
        for (const msg of messages) {
          if (msg.type === 'human' || msg.type === 'user') {
            const content = msg.message?.content;
            if (typeof content === 'string') {
              firstMessage = content.slice(0, 200);
              break;
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b: any) => b.type === 'text');
              if (textBlock) {
                firstMessage = textBlock.text?.slice(0, 200);
                break;
              }
            }
          }
        }

        sessions.push({
          id: sessionId,
          project_id: projectId,
          project_path: projectPath || '',
          created_at: stat.mtimeMs,
          first_message: firstMessage,
          message_timestamp: stat.mtime.toISOString(),
        });
      }

      return sessions.sort((a, b) => b.created_at - a.created_at);
    },

    loadSessionHistory(sessionId: string, projectId: string, projectPath?: string): any[] {
      const configDir = findProjectConfigDir(projectId, projectPath);
      if (!configDir) return [];
      const filePath = path.join(configDir, 'projects', projectId, `${sessionId}.jsonl`);
      return readJsonlFile(filePath);
    },

    loadAgentSessionHistory(sessionId: string): any[] {
      // Agent sessions use a different path — check all config dirs
      for (const configDir of getConfigDirs()) {
        const agentDir = path.join(configDir, 'projects');
        if (!fs.existsSync(agentDir)) continue;

        // Search all project dirs for this session
        try {
          const projects = fs.readdirSync(agentDir, { withFileTypes: true });
          for (const proj of projects) {
            if (!proj.isDirectory()) continue;
            const filePath = path.join(agentDir, proj.name, `${sessionId}.jsonl`);
            if (fs.existsSync(filePath)) {
              return readJsonlFile(filePath);
            }
          }
        } catch { /* skip */ }
      }
      return [];
    },

    getClaudeSettings(opts?: { configDir?: string; projectPath?: string }): any {
      const configDir = opts?.configDir || path.join(os.homedir(), '.claude');
      const settingsPath = path.join(configDir, 'settings.json');
      try {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        return {};
      }
    },

    saveClaudeSettings(settings: any, opts?: { configDir?: string; projectPath?: string }): string {
      const configDir = opts?.configDir || path.join(os.homedir(), '.claude');
      const settingsPath = path.join(configDir, 'settings.json');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return settingsPath;
    },

    getSystemPrompt(): string {
      const promptPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
      try {
        return fs.readFileSync(promptPath, 'utf-8');
      } catch {
        return '';
      }
    },

    saveSystemPrompt(content: string): string {
      const promptPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });
      fs.writeFileSync(promptPath, content);
      return promptPath;
    },

    checkClaudeVersion(): ClaudeVersionStatus {
      try {
        const result = execSync('claude --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        return { installed: true, version: result, path: null };
      } catch {
        return { installed: false, version: null, path: null };
      }
    },

    findClaudeMdFiles(projectPath: string): ClaudeMdFile[] {
      const files: ClaudeMdFile[] = [];
      const candidates = [
        { path: path.join(projectPath, 'CLAUDE.md'), scope: 'project' },
        { path: path.join(projectPath, '.claude', 'CLAUDE.md'), scope: 'project-local' },
        { path: path.join(os.homedir(), '.claude', 'CLAUDE.md'), scope: 'user' },
      ];
      for (const c of candidates) {
        files.push({ ...c, exists: fs.existsSync(c.path) });
      }
      return files;
    },

    readClaudeMdFile(filePath: string): string {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return '';
      }
    },

    saveClaudeMdFile(filePath: string, content: string): string {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return filePath;
    },

    getHooksConfig(scope: string, projectPath?: string): any {
      const configPath = scope === 'user'
        ? path.join(os.homedir(), '.claude', 'settings.json')
        : path.join(projectPath || '.', '.claude', 'settings.json');
      try {
        const settings = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return settings.hooks || {};
      } catch {
        return {};
      }
    },

    updateHooksConfig(scope: string, hooks: any, projectPath?: string): string {
      const configPath = scope === 'user'
        ? path.join(os.homedir(), '.claude', 'settings.json')
        : path.join(projectPath || '.', '.claude', 'settings.json');
      let settings: any = {};
      try { settings = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
      settings.hooks = hooks;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
      return configPath;
    },

    validateHookCommand(command: string): { valid: boolean; message: string } {
      if (!command || !command.trim()) {
        return { valid: false, message: 'Command cannot be empty' };
      }
      return { valid: true, message: 'OK' };
    },

    getMergedHooksConfig(projectPath: string): any {
      const userHooks = this.getHooksConfig('user');
      const projectHooks = this.getHooksConfig('project', projectPath);
      return { ...userHooks, ...projectHooks };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run electron/__tests__/claude.test.ts
```

Expected: All 6 tests PASS

- [ ] **Step 5: Register in main.ts**

Add to `electron/main.ts`:

```typescript
import { createClaudeService } from './services/claude';

// After accounts:
const claudeService = createClaudeService(db, accountsService);
registerIpcHandlers({
  database: db,
  accounts: accountsService,
  claudeBinary: claudeBinaryService,
  sessions: sessionsService,
  claude: claudeService,
});
```

- [ ] **Step 6: Commit**

```bash
git add electron/services/claude.ts electron/__tests__/claude.test.ts electron/main.ts
git commit -m "feat: add claude service for projects, sessions, and settings"
```

---

## Task 8: Agents Service

**Files:**
- Create: `electron/services/agents.ts`
- Create: `electron/services/process-registry.ts`
- Create: `electron/__tests__/agents.test.ts`
- Modify: `electron/main.ts`

Agent CRUD (SQLite), execution via `child_process.spawn()`, output streaming, run history. This is the second-largest service.

- [ ] **Step 1: Write the failing tests**

Tests should cover: agent CRUD, run creation, status tracking. Mock `child_process.spawn()` for execution tests.

The test file should include at minimum: `createAgent`, `listAgents`, `getAgent`, `updateAgent`, `deleteAgent`, `exportAgent`, `importAgent`, `listAgentRuns`, `getAgentRun`. Target: 12+ tests.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run electron/__tests__/agents.test.ts
```

Expected: FAIL

- [ ] **Step 3: Create `electron/services/process-registry.ts`**

Port of `process/registry.rs`. Tracks active `ChildProcess` instances by run ID. Methods: `register(runId, process)`, `get(runId)`, `kill(runId)`, `cleanup()`, `getAll()`. Use a `Map<number, ChildProcess>`.

- [ ] **Step 4: Implement `electron/services/agents.ts`**

Port of `commands/agents.rs` (2193 lines). The service receives `Database`, `AccountsService`, `ProcessRegistry`, and a `sendToRenderer` function. Key methods:

- `listAgents()` — `SELECT * FROM agents ORDER BY name`
- `createAgent(params)` — `INSERT INTO agents`
- `updateAgent(params)` — `UPDATE agents`
- `deleteAgent(id)` — `DELETE FROM agents WHERE id = ?`
- `getAgent(id)` — `SELECT * FROM agents WHERE id = ?`
- `exportAgent(id)` — serialize agent to JSON
- `importAgent(jsonData)` — parse JSON, insert into agents table
- `executeAgent(params)` — resolve account, spawn `claude` CLI with `--system-prompt`, `--model`, register in process registry, stream output via `webContents.send()`
- `listAgentRuns(agentId?)` — `SELECT * FROM agent_runs`
- `getAgentRun(id)` — `SELECT * FROM agent_runs WHERE id = ?`
- `killAgentSession(runId)` — kill process via registry
- `getSessionOutput(runId)` — read JSONL output file
- `getLiveSessionOutput(runId)` — read output from running process

For GitHub import: use `fetch()` (native in Node 18+) instead of `reqwest`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run electron/__tests__/agents.test.ts
```

Expected: All tests PASS

- [ ] **Step 6: Register in main.ts and commit**

```bash
git add electron/services/agents.ts electron/services/process-registry.ts electron/__tests__/agents.test.ts electron/main.ts
git commit -m "feat: add agents service with CRUD, execution, and process registry"
```

---

## Task 9: Checkpoints Service

**Files:**
- Create: `electron/services/checkpoints.ts`
- Create: `electron/__tests__/checkpoints.test.ts`
- Modify: `electron/main.ts`

Port of `checkpoint/` (~1683 lines). File diff tracking, timeline reconstruction, create/restore/fork/list operations.

- [ ] **Step 1: Install zstd compression**

```bash
npm install fzstd
```

- [ ] **Step 2: Write failing tests**

Tests should cover: checkpoint creation (create temp files, take checkpoint, verify diff), listing, timeline reconstruction. Use `fs.mkdtempSync()` for isolated test directories. Target: 8+ tests.

- [ ] **Step 3: Implement the checkpoints service**

Key operations:
- `createCheckpoint(params)` — snapshot file state, compute diffs, store as JSONL with zstd compression
- `restoreCheckpoint(params)` — decompress, apply file diffs in reverse
- `listCheckpoints(params)` — read checkpoint metadata from storage
- `forkFromCheckpoint(params)` — create new session branch from checkpoint state
- `getSessionTimeline(params)` — reconstruct timeline from JSONL events
- `updateCheckpointSettings(params)` — save auto-checkpoint config
- `getCheckpointDiff(params)` — compute diff between two checkpoints

Storage format: JSONL files in `$configDir/projects/$projectId/.checkpoints/`

- [ ] **Step 4: Run tests, verify pass, register in main.ts, commit**

```bash
git add electron/services/checkpoints.ts electron/__tests__/checkpoints.test.ts electron/main.ts package.json package-lock.json
git commit -m "feat: add checkpoints service with file diff tracking and timeline"
```

---

## Task 10: Usage Service

**Files:**
- Create: `electron/services/usage.ts`
- Create: `electron/__tests__/usage.test.ts`
- Modify: `electron/main.ts`

Port of `commands/usage.rs` (804 lines). Reads JSONL metadata from Claude config dirs, aggregates token counts and costs.

- [ ] **Step 1: Write failing tests**

Tests should create temp JSONL files with mock usage data and verify aggregation. Target: 6+ tests covering: total aggregation, date range filtering, by-model breakdown, by-project breakdown.

- [ ] **Step 2: Implement the usage service**

Key operations:
- `getUsageStats()` — scan all account config dirs, read JSONL session files, extract `usage` fields from assistant messages, aggregate totals
- `getUsageByDateRange(startDate, endDate)` — filter by timestamp
- `getSessionStats(since?, until?, order?)` — per-session token/cost breakdown
- `getUsageDetails(limit?)` — detailed per-message usage entries

Cost calculation: input_tokens * rate + output_tokens * rate, where rates depend on model (from the Rust `get_cost_per_token` logic).

- [ ] **Step 3: Run tests, verify pass, register in main.ts, commit**

```bash
git add electron/services/usage.ts electron/__tests__/usage.test.ts electron/main.ts
git commit -m "feat: add usage aggregation service"
```

---

## Task 11: Remaining Services

**Files:**
- Create: `electron/services/mcp.ts`
- Create: `electron/services/slash-commands.ts`
- Create: `electron/services/logging.ts`
- Create: `electron/services/storage.ts`
- Create: `electron/services/proxy.ts`
- Create: `electron/__tests__/logging.test.ts`
- Create: `electron/__tests__/storage.test.ts`
- Create: `electron/__tests__/proxy.test.ts`
- Modify: `electron/main.ts`

Six smaller services, each straightforward. Implement with TDD, one service at a time.

- [ ] **Step 1: Logging service**

Port of `commands/logging.rs` (410 lines). Two methods: `writeBatch(entries)` — bulk INSERT into `app_logs`, `query(filters)` — SELECT with level/source/timestamp filtering and pagination. Tests: write batch, query by level, query by date range. Target: 5+ tests.

- [ ] **Step 2: Storage inspector service**

Port of `commands/storage.rs` (530 lines). SQLite introspection: `listTables()` — PRAGMA table_list, `readTable(name, page, pageSize)` — paginated SELECT, `updateRow()`, `deleteRow()`, `insertRow()`, `executeSql()`, `resetDatabase()`. Tests: CRUD operations on test table. Target: 5+ tests.

- [ ] **Step 3: Proxy service**

Port of `commands/proxy.rs` (162 lines). Read/write proxy settings in `app_settings` table, apply to `process.env`. Tests: save and retrieve, apply to environment. Target: 3+ tests.

- [ ] **Step 4: MCP service**

Port of `commands/mcp.rs` (726 lines). MCP server config management: add/remove/list servers in Claude settings JSON files, test connections. Read/write `$configDir/settings.json` and project-level `.mcp.json`.

- [ ] **Step 5: Slash commands service**

Port of `commands/slash_commands.rs` (690 lines). Read markdown files with YAML frontmatter from `$configDir/commands/` directories. List, get, save, delete operations.

- [ ] **Step 6: Register all services in main.ts**

Wire all five services into `registerIpcHandlers()`.

- [ ] **Step 7: Run all tests**

```bash
npx vitest run electron/__tests__/
```

Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add electron/services/ electron/__tests__/ electron/main.ts
git commit -m "feat: add logging, storage, proxy, MCP, and slash commands services"
```

---

## Task 12: Frontend Cleanup (Tauri Import Replacement)

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`
- Modify: `src/components/AgentRunOutputViewer.tsx`
- Modify: `src/components/SessionOutputViewer.tsx`
- Modify: `src/components/claude-code-session/useClaudeMessages.ts`
- Modify: `src/components/Agents.tsx`
- Modify: `src/components/AgentsModal.tsx`
- Modify: `src/components/ProxySettings.tsx`
- Modify: `src/components/CustomTitlebar.tsx`
- Modify: `src/lib/apiAdapter.ts`
- Remove: Tauri dependencies from `package.json`

Replace all `@tauri-apps/*` imports with Electron equivalents.

- [ ] **Step 1: Replace `listen()` calls (event listeners)**

In `ClaudeCodeSession.tsx`, `AgentRunOutputViewer.tsx`, `SessionOutputViewer.tsx`, `useClaudeMessages.ts`:

Replace:
```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
const unlisten = await listen('event-name', (event) => { ... });
```

With:
```typescript
const unlisten = window.electronAPI.onEvent('event-name', (payload) => { ... });
```

The `onEvent` helper returns an unlisten function directly (no await needed).

- [ ] **Step 2: Replace `invoke()` calls**

In `Agents.tsx`, `AgentsModal.tsx`, `ProxySettings.tsx`: remove direct `invoke()` imports. These should already go through `api.ts` — if any direct `invoke()` calls remain, replace with `window.electronAPI.invoke()` or route through `api.ts`.

- [ ] **Step 3: Replace dialog imports**

In `Agents.tsx`, `AgentsModal.tsx`: replace:
```typescript
import { open as openDialog, save } from '@tauri-apps/plugin-dialog';
const file = await openDialog({ filters: [...] });
```

With:
```typescript
const files = await window.electronAPI.showOpenDialog({ filters: [...] });
const file = files?.[0] ?? null;
```

And for save:
```typescript
const savePath = await window.electronAPI.showSaveDialog({ defaultPath: 'file.json' });
```

- [ ] **Step 4: Replace shell/opener imports**

Replace:
```typescript
import { open } from '@tauri-apps/plugin-shell';
await open(url);
```

With:
```typescript
await window.electronAPI.openExternal(url);
```

- [ ] **Step 5: Replace window API in CustomTitlebar.tsx**

Replace:
```typescript
import { getCurrentWindow } from '@tauri-apps/api/window';
const win = getCurrentWindow();
await win.minimize();
await win.toggleMaximize();
await win.close();
```

With:
```typescript
await window.electronAPI.invoke('window:minimize');
await window.electronAPI.invoke('window:maximize');
await window.electronAPI.invoke('window:close');
```

And add handlers in `electron/ipc/handlers.ts`:
```typescript
map['window:minimize'] = () => BrowserWindow.getFocusedWindow()?.minimize();
map['window:maximize'] = () => {
  const win = BrowserWindow.getFocusedWindow();
  win?.isMaximized() ? win.unmaximize() : win?.maximize();
};
map['window:close'] = () => BrowserWindow.getFocusedWindow()?.close();
```

- [ ] **Step 6: Remove Tauri packages from package.json**

```bash
npm uninstall @tauri-apps/api @tauri-apps/plugin-dialog @tauri-apps/plugin-global-shortcut @tauri-apps/plugin-notification @tauri-apps/plugin-opener @tauri-apps/plugin-shell @tauri-apps/cli
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS — no remaining `@tauri-apps` imports

- [ ] **Step 8: Verify the app starts and basic flows work**

```bash
npm run start
```

Expected: App renders, navigation works, no console errors from missing Tauri APIs.

- [ ] **Step 9: Commit**

```bash
git add src/ electron/ipc/handlers.ts package.json package-lock.json
git commit -m "feat: replace all Tauri imports with Electron IPC equivalents"
```

---

## Task 13: Packaging

**Files:**
- Modify: `forge.config.ts`
- Modify: `electron/main.ts`

- [ ] **Step 1: Configure app icons**

Copy existing icons to a location Forge expects:

```bash
mkdir -p build
cp icons/icon.icns build/icon.icns
cp icons/icon.ico build/icon.ico
cp icons/icon.png build/icon.png
```

Update `forge.config.ts` `packagerConfig`:

```typescript
packagerConfig: {
  name: 'GreyChrist',
  executableName: 'greychrist',
  icon: './build/icon',
  appBundleId: 'com.greychrist.app',
  asar: true,
},
```

- [ ] **Step 2: Add macOS vibrancy**

In `electron/main.ts`, add to BrowserWindow options:

```typescript
vibrancy: 'under-window',
visualEffectState: 'active',
backgroundColor: '#00000000',
```

- [ ] **Step 3: Add dock badge support**

In `electron/main.ts`:

```typescript
// When permission request fires:
if (process.platform === 'darwin') {
  app.dock.setBadge('1');
}

// Clear on focus:
mainWindow.on('focus', () => {
  if (process.platform === 'darwin') {
    app.dock.setBadge('');
  }
});
```

- [ ] **Step 4: Build the package**

```bash
npm run make
```

Expected: Creates a `.app` bundle (macOS) or installer (Windows/Linux) in `out/`.

- [ ] **Step 5: Verify the packaged app launches**

Open `out/GreyChrist-darwin-arm64/GreyChrist.app` (or equivalent) and confirm it works outside the dev server.

- [ ] **Step 6: Commit**

```bash
git add forge.config.ts electron/main.ts build/
git commit -m "feat: configure packaging with icons, vibrancy, and dock badges"
```

---

## Task 14: Delete Tauri

**Files:**
- Delete: `src-tauri/` (entire directory)
- Modify: `package.json` (remove Tauri scripts and deps)
- Delete: `vite.config.ts` (replaced by `vite.renderer.config.ts`)
- Modify: `.gitignore`
- Delete: old Tauri-related config files

- [ ] **Step 1: Run all tests one final time**

```bash
npx vitest run electron/__tests__/
```

Expected: All tests PASS

- [ ] **Step 2: Verify the Electron app builds**

```bash
npm run make
```

Expected: PASS

- [ ] **Step 3: Delete Tauri backend**

```bash
rm -rf src-tauri/
```

- [ ] **Step 4: Remove old vite.config.ts**

```bash
rm vite.config.ts
```

The renderer now uses `vite.renderer.config.ts` (configured in `forge.config.ts`).

- [ ] **Step 5: Clean up package.json**

Remove any remaining Tauri-related entries:
- `tauri` section
- Any `tauri` scripts
- Remaining `@tauri-apps/*` dependencies (should already be gone from Task 12)

- [ ] **Step 6: Update .gitignore**

Add Electron build outputs:
```
out/
.vite/
```

Remove Tauri-specific entries:
```
src-tauri/target/
```

- [ ] **Step 7: Final verification**

```bash
npx tsc --noEmit && npx vitest run electron/__tests__/ && npm run make
```

Expected: All three PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove Tauri backend, migration to Electron complete"
```
