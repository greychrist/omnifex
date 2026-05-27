import { app, BrowserWindow, ipcMain, protocol, Notification, shell, Menu, clipboard } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Fix PATH for packaged apps
// When launched from Finder on macOS, Electron inherits a minimal environment
// (/usr/bin:/bin:/usr/sbin:/sbin). Tools installed via nvm, homebrew, etc.
// aren't found, which breaks MCP servers and the Claude CLI. Read the user's
// login shell PATH and merge it into process.env before anything else runs.
// ---------------------------------------------------------------------------
function fixPath(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    const result = execSync(`${userShell} -ilc 'echo "__PATH__=$PATH"'`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = /__PATH__=(.+)/.exec(result);
    if (match) {
      process.env.PATH = match[1];
      console.log('[main] Fixed PATH from shell:', match[1].split(':').length, 'entries');
    }
  } catch (err) {
    console.warn('[main] Failed to fix PATH from shell:', (err as Error).message);
  }
}
fixPath();

// Log errors to console and show dialog
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
import { createDatabase, ensureDefaultSettings } from './services/database';
import { createAccountsService } from './services/accounts';
import { runFirstTimeDiscovery } from './services/first-run-discovery';
import { createClaudeBinaryService } from './services/claude-binary';
import { createSessionsService } from './services/sessions';
import { createNotificationsService } from './services/notifications';
import {
  createNotificationSoundsService,
  resolveNotificationSound,
  isNotificationSoundId,
  type NotificationSoundId,
} from './services/notification-sounds';
import { createClaudeService } from './services/claude';
import { createUsageService } from './services/usage';
import { createRateLimitsService } from './services/rate-limits';
import { createUsageRunnerService } from './services/usage-runner';
import { createLoggingService } from './services/logging';
import { createProxyService } from './services/proxy';
import { createMCPService } from './services/mcp';
import { createModelsService } from './services/models';
import { createSlashCommandsService } from './services/slash-commands';
import { createFilesystemService } from './services/filesystem';
import {
  createSessionsSummaryService,
  DEFAULT_SUMMARY_PROMPT,
  PROMPT_TEMPLATE_SETTING_KEY,
  AUTO_ON_CLOSE_SETTING_KEY,
  ENABLED_SETTING_KEY,
} from './services/sessions-summary';
import { createSummaryQueryRunner } from './services/sessions/summary-query';
import { createPermissionsIOService } from './services/permissions-io';
import { createUpdaterService } from './services/updater';
import { createInstallerService } from './services/installer';
import { createTabStatusService, type TabStatusSummary } from './services/tab-status';
import { migrateUserData } from './services/userdata-migration';
import { createSessionGitWatcher, listWorktrees } from './services/git-watcher';
import { createBranchColorsService } from './services/branch-colors';
import { listBranches as listGitBranches } from './services/git-branches';
import { createLimaService } from './services/lima';
import { registerIpcHandlers } from './ipc/handlers';
import { createWindowRouter } from './window-router';
import { classifyNavigation } from './navigation-policy';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const windows = new Set<BrowserWindow>();
const router = createWindowRouter();
let _sessionsService: { stopAll(): void } | null = null;
let _notificationsService: { dismissAll(): void } | null = null;
let _gitWatcherService: { disposeAll(): void } | null = null;
let _db: { close(): void } | null = null;
let _initialized = false;

function anyWindowFocused(): boolean {
  for (const w of windows) {
    if (!w.isDestroyed() && w.isFocused()) return true;
  }
  return false;
}

function focusAnyWindow(): void {
  for (const w of windows) {
    if (w.isDestroyed()) continue;
    if (w.isMinimized()) w.restore();
    w.focus();
    return;
  }
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const target = router.resolveTarget(channel);
  if (target.kind === 'owner') {
    for (const w of windows) {
      if (!w.isDestroyed() && w.webContents.id === target.ownerId) {
        w.webContents.send(channel, ...args);
        return;
      }
    }
    // Owner window has been closed — drop the event.
    return;
  }
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

// Unread notification count for dock badge
let unreadCount = 0;
function updateDockBadge() {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(unreadCount > 0 ? String(unreadCount) : '');
  }
}
function incrementUnread() {
  unreadCount += 1;
  updateDockBadge();
}
function clearUnread() {
  unreadCount = 0;
  updateDockBadge();
}

function installAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }
  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Window',
        accelerator: 'CmdOrCtrl+N',
        click: () => createWindow(),
      },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ],
  });
  template.push({ role: 'editMenu' });
  // Custom View menu that mirrors Electron's default `viewMenu` role minus
  // Reload (Cmd+R) and Force Reload (Cmd+Shift+R). Greg lost work to an
  // accidental Cmd+R; neither accelerator has a legitimate use in this app.
  template.push({
    label: 'View',
    submenu: [
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });
  template.push({ role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: 'New Window', click: () => createWindow() },
      ]),
    );
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windows.add(win);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch((err: unknown) => { console.error('[main:load-url]', err); });
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    ).catch((err: unknown) => { console.error('[main:load-file]', err); });
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools();
  }
  win.show();

  win.on('focus', () => {
    // Clear unread badge when user focuses any window
    clearUnread();
    // Dismiss any macOS notifications we've posted — user is looking at the app.
    _notificationsService?.dismissAll();
  });

  // Route link clicks: in-app navigation away from the renderer would turn the
  // window into a browser and lose session state. Send external URLs to the OS
  // browser instead; deny unknown protocols.
  const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyNavigation(url, { devServerUrl }) === 'external') {
      shell.openExternal(url).catch((err: unknown) => { console.error('[main:window-open-external]', err); });
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const decision = classifyNavigation(url, { devServerUrl });
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') shell.openExternal(url).catch((err: unknown) => { console.error('[main:will-navigate-external]', err); });
  });

  win.webContents.on('context-menu', (_event, params) => {
    const { selectionText, editFlags, isEditable, linkURL } = params;
    const hasText = typeof selectionText === 'string' && selectionText.trim().length > 0;
    const template: MenuItemConstructorOptions[] = [];

    if (linkURL) {
      template.push({ label: 'Open Link', click: () => { shell.openExternal(linkURL).catch((err: unknown) => { console.error('[main:open-link]', err); }); } });
      template.push({ label: 'Copy Link', click: () => clipboard.writeText(linkURL) });
      template.push({ type: 'separator' });
    }

    if (isEditable) {
      template.push({ role: 'cut', enabled: !!editFlags.canCut });
      template.push({ role: 'copy', enabled: !!editFlags.canCopy });
      template.push({ role: 'paste', enabled: !!editFlags.canPaste });
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll', enabled: !!editFlags.canSelectAll });
    } else if (hasText) {
      template.push({ role: 'copy' });
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll' });
    } else {
      template.push({ role: 'selectAll' });
    }

    Menu.buildFromTemplate(template).popup({ window: win });
  });

  win.on('closed', () => {
    windows.delete(win);
  });

  return win;
}

// Register custom protocol as privileged so it can load images in the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'greychrist-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// app.whenReady() returns a Promise; catch any thrown init error so it
// surfaces in the main-process log instead of becoming an unhandled
// rejection on the global process.
app.whenReady().then(() => {
  // One-time userdata migration from the legacy "GreyChrist" Application
  // Support directory. Must run before any service touches userData. Old
  // installs that ran v0.4.1 or earlier wrote to ~/Library/Application
  // Support/GreyChrist; the renamed app reads from ~/Library/Application
  // Support/OmniFex. This copies the old directory once and marks done.
  try {
    const newUserDataPath = app.getPath('userData');
    const legacyUserDataPath = path.join(path.dirname(newUserDataPath), 'GreyChrist');
    const result = migrateUserData({
      legacyPath: legacyUserDataPath,
      newPath: newUserDataPath,
    });
    if (result.migrated) {
      console.log('[migration] copied userdata from', legacyUserDataPath, '->', newUserDataPath);
    } else if (result.reason && result.reason !== 'already-migrated') {
      console.log('[migration] skipped:', result.reason);
    }
  } catch (err) {
    console.error('[migration] failed:', err);
  }

  // Serve local files via greychrist-file:// protocol (bypasses file:// security)
  protocol.handle('greychrist-file', async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname);
      const data = fs.readFileSync(filePath);
      // Guess content type from extension
      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === '.png' ? 'image/png' :
        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
        ext === '.gif' ? 'image/gif' :
        ext === '.webp' ? 'image/webp' :
        ext === '.svg' ? 'image/svg+xml' :
        'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': contentType } });
    } catch (err) {
      console.error('[protocol] greychrist-file error:', err);
      return new Response('Not found', { status: 404 });
    }
  });

  // Clean up pasted images older than 1 hour
  try {
    const pasteDir = path.join(os.tmpdir(), 'greychrist-pastes');
    if (fs.existsSync(pasteDir)) {
      const maxAge = 60 * 60 * 1000; // 1 hour
      const cutoff = Date.now() - maxAge;
      for (const entry of fs.readdirSync(pasteDir)) {
        const filePath = path.join(pasteDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // ignore individual file errors
        }
      }
    }
  } catch (err) {
    console.error('Failed to clean paste dir:', err);
  }

  const userDataPath = app.getPath('userData');

  let db: ReturnType<typeof createDatabase>;
  try {
    db = createDatabase(path.join(userDataPath, 'greychrist.db'));
  } catch (err) {
    console.error('Failed to create database:', err);
    return;
  }
  _db = db;

  // Seed first-run defaults. Empty-string values (user deliberately cleared)
  // are preserved; only truly-missing keys get the default.
  //
  // `local_update_dir` defaults to `<cwd>/out/make` only in dev mode. That path
  // is where `npm run make` drops .dmg builds, so `npm start` picks up local
  // builds for update checks without configuration. In packaged installs
  // `app.isPackaged` is true and `process.cwd()` is meaningless, so we leave
  // the setting empty — the user configures it in Settings → General if they
  // want to check a specific folder for updates.
  ensureDefaultSettings(db, {
    local_update_dir: app.isPackaged ? '' : path.join(process.cwd(), 'out', 'make'),
    [PROMPT_TEMPLATE_SETTING_KEY]: DEFAULT_SUMMARY_PROMPT,
    // Both summary toggles default-on. ensureDefaultSettings only fills
    // truly-missing keys, so existing installs keep whatever they set.
    // Settings → Session Summaries owns both switches.
    [ENABLED_SETTING_KEY]: 'true',
    [AUTO_ON_CLOSE_SETTING_KEY]: 'true',
  });
  const accountsService = createAccountsService(db);

  // First-launch account discovery: if this is a fresh install with no
  // accounts yet, scan $HOME for `.claude*` dirs and create one account per
  // match. Resolution still requires explicit choice — this just populates
  // the picker so it isn't empty when the user opens their first project.
  // One-and-done via the `discovery_completed` flag; the Settings panel has
  // a manual "Scan for Claude config directories" button for later additions.
  void runFirstTimeDiscovery({
    accounts: accountsService,
    db,
    discover: () => accountsService.discoverAccounts(),
  }).catch((err: unknown) => {
    console.error('[first-run-discovery] failed:', err);
  });

  const claudeBinaryService = createClaudeBinaryService(db);
  // Logging must be constructed before sessions so the sessions service can
  // route CLI subprocess stderr into the log store. The predicate reads
  // app_settings live on every batch, so toggling the LogTab switches takes
  // effect immediately without a restart. Defaults are "off" — info/debug
  // entries from these two noisy sources are dropped unless the user opts
  // in. Warn/error always pass through.
  const loggingService = createLoggingService(db, {
    shouldAccept: (entry) => {
      if (entry.level !== 'info' && entry.level !== 'debug') return true;
      if (entry.source === 'claude-hooks') {
        return db.getSetting('log_verbose_claude_hooks') === 'true';
      }
      if (entry.source === 'usage-runner') {
        return db.getSetting('log_verbose_usage_runner') === 'true';
      }
      return true;
    },
    onError: (entry) => {
      // Default is ON. Only suppress when the user has explicitly set the
      // toggle to 'false' — a missing setting (fresh install) still toasts.
      if (db.getSetting('log_error_toast_enabled') === 'false') return;
      sendToRenderer('log-error', {
        source: entry.source,
        message: entry.message,
        category: entry.category ?? null,
        level: entry.level,
        timestamp: entry.timestamp,
      });
    },
  });
  // Resolves the user's currently-configured sound from app_settings on every
  // call so picker changes take effect without restarting the service. Falls
  // back to the historical defaults (OmniFex chime / Basso) when the keys are
  // missing or hold a value not in the catalog.
  const readConfiguredSound = (isError: boolean): NotificationSoundId => {
    const key = isError ? 'notification_sound_error' : 'notification_sound_success';
    const raw = db.getSetting(key);
    if (isNotificationSoundId(raw)) return raw;
    return isError ? 'Basso' : 'greychrist_success';
  };
  const notificationsService = _notificationsService = createNotificationsService({
    isSupported: () => Notification.isSupported(),
    isWindowFocused: () => anyWindowFocused(),
    focusWindow: () => focusAnyWindow(),
    onNotificationClick: ({ tabId }) => {
      if (tabId) sendToRenderer('notification-clicked', { tabId });
    },
    resolveSound: (isError) =>
      resolveNotificationSound(readConfiguredSound(isError), {
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
      }),
    playSound: (soundPath) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy load; only needed when a notification actually plays a sound.
      const { execFile } = require('node:child_process') as typeof import('node:child_process');
      execFile('afplay', [soundPath], (err: Error | null) => {
        if (err) console.error('[notification] afplay failed:', err.message);
      });
    },
    createNotification: (opts) => new Notification(opts),
  });
  const permissionsIOService = createPermissionsIOService();
  const rateLimitsService = createRateLimitsService({
    db,
    accounts: accountsService,
    notifications: notificationsService,
    sendToRenderer,
    logging: loggingService,
  });
  const usageRunnerService = createUsageRunnerService({
    accounts: accountsService,
    rateLimits: rateLimitsService,
    logging: loggingService,
    // Used by the default `ensureCwd` to create per-account trusted scratch
    // dirs under `<userData>/usage-cwd/<key>/`. See usage-runner/scratch-cwd.ts
    // for why this exists (works around Claude Code's first-launch safety
    // dialog by pre-trusting an empty folder we control).
    userDataDir: app.getPath('userData'),
  });
  // Forward reference: sessionsSummaryService is constructed below (after
  // sessionsService) but the auto-on-close hook needs to call it. The
  // closure is invoked only at session-stop time, so the reference is
  // safely populated by then.
  let sessionsSummaryServiceRef:
    | import('./services/sessions-summary').SessionsSummaryService
    | null = null;

  const sessionsService = _sessionsService = createSessionsService(
    sendToRenderer,
    {
      showNotification: (title, body, isError, payload, options) => {
        notificationsService.show(title, body, isError, payload, options);
      },
      incrementUnread: () => {
        // Only bump the dock badge when no window is focused
        if (anyWindowFocused()) return;
        incrementUnread();
      },
    },
    loggingService,
    {
      register: (tabId, ownerId) => router.registerTabOwner(tabId, ownerId),
      unregister: (tabId) => router.unregisterTabOwner(tabId),
    },
    (params) => permissionsIOService.updatePermission({
      scope: params.scope,
      action: 'add',
      behavior: params.behavior,
      rule: params.rule,
      configDir: params.configDir,
      projectPath: params.projectPath,
    }),
    (configDir, info) => rateLimitsService.recordEvent(configDir, info),
    (sessionId, projectPath, configDir) => {
      // Auto-on-close summarization. Two global toggles gate this path:
      //   - sessionsSummary.enabled (master) — off means summaries are
      //     not used at all, so no point generating one.
      //   - sessionsSummary.autoOnClose — off means the user wants to
      //     hit the manual refresh button themselves.
      // Both must be 'true' for the lifecycle hook to fire. The manual
      // refresh path doesn't go through here — it hits the
      // `summary_generate` IPC directly, so the autoOnClose flag has
      // no effect on it. Read fresh on every close so flips in
      // Settings take effect without restart.
      //
      // Fire-and-forget so session teardown isn't blocked by Haiku
      // latency; the size-change gate inside the service makes "close
      // without changes" a no-op (no API spend). configDir comes from
      // the live SessionHandle so the JSONL lookup is anchored to the
      // exact account that ran the session.
      const enabled = db.getSetting(ENABLED_SETTING_KEY) === 'true';
      const autoOn = db.getSetting(AUTO_ON_CLOSE_SETTING_KEY) === 'true';
      if (!enabled || !autoOn) return;
      sessionsSummaryServiceRef
        ?.generateSummary(sessionId, projectPath, configDir)
        .catch((err: unknown) =>
          console.warn('[main] auto-summarize on close failed:', err),
        );
    },
    // Account re-resolver: main re-resolves the account at session_start so
    // a path-rule change between the renderer's form-mount and the user's
    // Start-click doesn't spawn the SDK under a stale account. Skipped for
    // resumes (they're anchored to the configDir that owns the JSONL) and
    // when manualAccountOverride is set (user explicitly picked an account
    // on the form). Returns null when the project doesn't resolve.
    (projectPath: string) => accountsService.resolve(projectPath)?.account?.config_dir ?? null,
  );
  const claudeService = createClaudeService(db, accountsService);
  const usageService = createUsageService(accountsService, loggingService);
  const proxyService = createProxyService(db);
  const mcpService = createMCPService();
  const slashCommandsService = createSlashCommandsService();
  const sessionsSummaryService = createSessionsSummaryService({
    jsonlPathFor: (sessionUuid, projectPath, configDir) => {
      // We never assume ~/.claude. The "root" is always an account's
      // config_dir. The renderer holds it at tab level (chat tab via
      // accountResolution; SessionList via resolveAccountForProject)
      // and passes it explicitly. lifecycle.ts also passes the
      // SessionHandle's configDir on the close path.
      //
      // Only fall back to scanning every account's projects/ when the
      // caller passes null — handles the rare case where we don't yet
      // know which account owns the session.

      // Claude Code encodes project paths to directory names by
      // replacing each '/' with '-'.
      const projectId = projectPath.replace(/\//g, '-');

      const tryAt = (cfgDir: string): string | null => {
        // 1) Encoded path under this account's projects/
        const encoded = path.join(cfgDir, 'projects', projectId, `${sessionUuid}.jsonl`);
        if (fs.existsSync(encoded)) return encoded;
        // 2) Same account's projects/<any-dir>/<uuid>.jsonl — handles
        //    project renames within an account.
        const projectsDir = path.join(cfgDir, 'projects');
        let entries: import('fs').Dirent[];
        try {
          entries = fs.readdirSync(projectsDir, { withFileTypes: true });
        } catch {
          return null;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(projectsDir, entry.name, `${sessionUuid}.jsonl`);
          if (fs.existsSync(candidate)) return candidate;
        }
        return null;
      };

      if (configDir) {
        const found = tryAt(configDir);
        if (found) return found;
      }

      // Caller didn't provide configDir, or the session truly isn't in
      // that account. Search every known account.
      const seen = new Set<string>();
      if (configDir) seen.add(configDir);
      for (const acct of accountsService.listAccounts()) {
        if (seen.has(acct.config_dir)) continue;
        seen.add(acct.config_dir);
        const found = tryAt(acct.config_dir);
        if (found) return found;
      }

      // Nothing found. Return a path under the resolved account when one
      // exists, otherwise null so the caller's skipped:no-account branch
      // fires. There is no synthetic ~/.claude fallback — see CLAUDE.md
      // "Multi-Account Rules" and NoAccountError in claude.ts.
      const resolvedRoot = configDir ?? accountsService.resolve(projectPath)?.account?.config_dir;
      if (!resolvedRoot) return null;
      return path.join(resolvedRoot, 'projects', projectId, `${sessionUuid}.jsonl`);
    },
    resolveAccount: (projectPath) => {
      const acct = accountsService.resolve(projectPath)?.account ?? null;
      if (!acct) return null;
      return {
        name: acct.name,
        configDir: acct.config_dir,
        summaryModel: acct.summaryModel ?? null,
      };
    },
    // One-shot summarization call. The runner uses a stable scratch cwd
    // so the JSONL the subprocess always writes lands in a throwaway dir
    // under `<configDir>/projects/<scratch>/` and gets swept after the
    // call, instead of mixing throwaway summary sessions into the user's
    // real project session list. bypassPermissions + disallowedTools:['*']
    // keep this strictly text-in / text-out.
    runQuery: createSummaryQueryRunner(),
    onSummaryUpdated: (sessionUuid) => {
      // Broadcast to every renderer; SessionList rows subscribe and refetch
      // the matching uuid. Channel matches the existing `session-` prefix
      // in preload's event allow-list (no preload change needed).
      sendToRenderer('session-summary:updated', { sessionUuid });
    },
    onGenerationStateChanged: (sessionUuid, generating) => {
      // Broadcast generation start/finish so the SessionList row can spin
      // its refresh icon for background auto-on-close runs that the user
      // is still watching from the project page. Same `session-` prefix
      // → no preload allow-list change.
      sendToRenderer('session-summary:generating', { sessionUuid, generating });
    },
    getPromptTemplate: () => {
      // Read fresh on every call so prompt edits in the Settings UI
      // land without restart. Empty string falls back to the default,
      // and ensureDefaultSettings seeds the row on first launch.
      const stored = db.getSetting(PROMPT_TEMPLATE_SETTING_KEY);
      const trimmed = stored?.trim() ?? '';
      return trimmed || DEFAULT_SUMMARY_PROMPT;
    },
  });
  sessionsSummaryServiceRef = sessionsSummaryService;
  const modelsService = createModelsService();
  const sessionGitWatcher = _gitWatcherService = createSessionGitWatcher({
    sendToRenderer,
  });
  const branchColorsService = createBranchColorsService(db);
  const gitBranchesService = { list: listGitBranches };
  const limaService = createLimaService();
  const filesystemService = createFilesystemService();

  const notificationSoundsService = createNotificationSoundsService({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    play: (soundPath) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy load; only needed when the renderer requests a preview.
      const { execFile } = require('node:child_process') as typeof import('node:child_process');
      execFile('afplay', [soundPath], (err: Error | null) => {
        if (err) console.error('[notification-preview] afplay failed:', err.message);
      });
    },
  });

  registerIpcHandlers({
    database: db,
    // Accounts adapter — maps handler interface to service methods
    accounts: {
      list: () => accountsService.listAccounts(),
      create: (data: any) =>
        accountsService.createAccount(
          data.name,
          data.configDir ?? data.config_dir,
          data.accountType ?? data.account_type,
          data.color,
          data.icon,
          data.sessionDefaults ?? data.session_defaults,
          data.cliPath ?? data.cli_path ?? null,
        ),
      update: (_id: any, data: any) =>
        accountsService.updateAccount(
          data.id,
          data.name,
          data.configDir ?? data.config_dir,
          data.accountType ?? data.account_type,
          data.color,
          data.icon,
          'sessionDefaults' in data || 'session_defaults' in data
            ? (data.sessionDefaults ?? data.session_defaults)
            : undefined,
          data.cliPath ?? data.cli_path ?? null,
        ),
      updateSummarySettings: (data: any) =>
        accountsService.updateSummarySettings(
          data.id,
          !!(data.summarizeOnClose ?? data.summarize_on_close),
          (data.summaryModel ?? data.summary_model ?? null) as string | null,
        ),
      delete: (id: any) => accountsService.deleteAccount(id),
      listPathRules: () => accountsService.listPathRules(),
      addPathRule: (rule: any) =>
        accountsService.addPathRule(rule.accountId ?? rule.account_id, rule.pathPrefix ?? rule.path_prefix, rule.priority),
      removePathRule: (id: any) => accountsService.removePathRule(id),
      // Returns the full `{ agent, account }` resolution so the renderer can
      // prefill the agent picker from the same path-rule decision that
      // picks the Claude account. Pre-Task-12 callers consumed
      // `Account | null` directly; they now read `.account`.
      // `null` at the top level means "no override and no matching path
      // rule" — callers MUST surface that as an error rather than falling
      // back to a silent default account.
      resolveForProject: (projectPath: string) =>
        accountsService.resolve(projectPath),
      setProjectOverride: (projectPath: string, accountId: any) =>
        accountsService.setProjectOverride(projectPath, accountId),
      listProjectOverrides: () => accountsService.listProjectOverrides(),
      discoverAccounts: () => accountsService.discoverAccounts(),
      scanForNewAccounts: () => accountsService.scanForNewAccounts(),
      explainResolution: (projectPath: string) =>
        accountsService.explainResolution(projectPath),
    },
    // Claude adapter
    claude: {
      listProjects: (_configDir?: string) => claudeService.listProjects(),
      createProject: (data: any) => claudeService.createProject(data?.path ?? data),
      getProjectSessions: (projectId: string, projectPath?: string) => claudeService.getProjectSessions(projectId, projectPath),
      loadSessionHistory: (sessionId: string, projectId: string, projectPath?: string) =>
        claudeService.loadSessionHistory(sessionId, projectId, projectPath),
      deleteSession: (sessionId: string, projectId: string, projectPath?: string) =>
        claudeService.deleteSession(sessionId, projectId, projectPath),
      deleteProject: (args: { accountId: number; projectId: string }) =>
        claudeService.deleteProject(args),
      getHomeDirectory: () => claudeService.getHomeDirectory(),
      getSettings: (opts?: any) => claudeService.getClaudeSettings(opts),
      saveSettings: (settings: any, opts?: any) => claudeService.saveClaudeSettings(settings, opts),
      getSystemPrompt: (opts?: any) => claudeService.getSystemPrompt(opts),
      saveSystemPrompt: (prompt: any, opts?: any) =>
        claudeService.saveSystemPrompt(typeof prompt === 'string' ? prompt : String(prompt ?? ''), opts),
      checkVersion: () => claudeService.checkClaudeVersion(),
      findClaudeMdFiles: (projectPath: string) => claudeService.findClaudeMdFiles(projectPath),
      readClaudeMdFile: (filePath: string) => claudeService.readClaudeMdFile(filePath),
      saveClaudeMdFile: (filePath: string, content: string) =>
        claudeService.saveClaudeMdFile(filePath, content),
      getHooksConfig: (scope: string, opts?: any) => claudeService.getHooksConfig(scope as 'user' | 'project', opts),
      updateHooksConfig: (scope: string, config: any, opts?: any) => claudeService.updateHooksConfig(scope as 'user' | 'project', config, opts),
      validateHookCommand: (command: string) => claudeService.validateHookCommand(command),
      getMergedHooksConfig: (projectPath: string, opts?: any) => claudeService.getMergedHooksConfig(projectPath, opts),
      getCliUsage: (configDir?: string) => claudeService.getCliUsage(configDir),
    },
    // Sessions adapter
    sessions: {
      start: (data: any) => sessionsService.start(data),
      rebind: (tabId: string, ownerWebContentsId: number) =>
        sessionsService.rebind(tabId, ownerWebContentsId),
      sendMessage: (sessionId: string, message: any) =>
        sessionsService.sendMessage(
          sessionId,
          typeof message === 'string' ? message : String(message ?? ''),
        ),
      sendStructuredMessage: (sessionId: string, content: any) =>
        sessionsService.sendStructuredMessage(sessionId, content),
      respondPermission: (sessionId: string, behavior: string, updatedInput?: Record<string, unknown>, updatedPermissions?: any[]) =>
        sessionsService.respondPermission(sessionId, behavior as 'allow' | 'deny', updatedInput, updatedPermissions),
      respondElicitation: (tabId: string, action: string, content?: Record<string, unknown>) =>
        sessionsService.respondElicitation(tabId, action as 'accept' | 'decline' | 'cancel', content),
      stop: (sessionId: string) => sessionsService.stop(sessionId),
      getInfo: (sessionId: string) => sessionsService.getInfo(sessionId),
      getHealth: (sessionId: string) => sessionsService.getHealth(sessionId),
      // Wave 2 — Query-method passthroughs
      interrupt: (sessionId: string) => sessionsService.interrupt(sessionId),
      setModel: (sessionId: string, model?: string) => sessionsService.setModel(sessionId, model),
      setPermissionMode: (sessionId: string, mode: string) =>
        sessionsService.setPermissionMode(sessionId, mode as any),
      setEffort: (sessionId: string, level: unknown) => sessionsService.setEffort(sessionId, level as any),
      applyPermissions: (sessionId: string, permissions: unknown) =>
        sessionsService.applyPermissions(sessionId, permissions as any),
      setThinking: (sessionId: string, config: unknown) => sessionsService.setThinking(sessionId, config as any),
      getAccountInfo: (sessionId: string) => sessionsService.getAccountInfo(sessionId),
      getContextUsage: (sessionId: string) => sessionsService.getContextUsage(sessionId),
      getSupportedCommands: (sessionId: string) => sessionsService.getSupportedCommands(sessionId),
      getSupportedModels: (sessionId: string) => sessionsService.getSupportedModels(sessionId),
      getMcpServerStatus: (sessionId: string) => sessionsService.getMcpServerStatus(sessionId),
      getPlugins: (sessionId: string, force?: boolean) => sessionsService.getPlugins(sessionId, force),
      setMode: (tabId: string, mode: 'rich' | 'tui') => sessionsService.setMode(tabId, mode),
      tuiWrite: (tabId: string, data: string) => sessionsService.tuiWrite(tabId, data),
      tuiResize: (tabId: string, cols: number, rows: number) =>
        sessionsService.tuiResize(tabId, cols, rows),
      getMode: (tabId: string) => sessionsService.getMode(tabId),
    },
    // Usage adapter
    usage: {
      getStats: (_params?: any) => usageService.getUsageStats(),
      getByDateRange: (params: any) =>
        usageService.getUsageByDateRange(params?.start_date ?? '', params?.end_date ?? ''),
      getSessionStats: (params?: any) =>
        usageService.getSessionStats(params?.since, params?.until, params?.order),
      getDetails: (params?: any) => usageService.getUsageDetails(params?.limit),
      getStatsByAccount: (params?: any) =>
        usageService.getStatsByAccount(params?.start_date, params?.end_date),
    },
    // Rate Limits adapter
    rateLimits: {
      getSnapshots: () => rateLimitsService.getSnapshots(),
      getSnapshotsByAccount: (accountName: string) =>
        rateLimitsService.getSnapshotsByAccount(accountName),
      getSettings: () => rateLimitsService.getSettings(),
      updateSettings: (partial: any) => rateLimitsService.updateSettings(partial ?? {}),
    },
    usageRunner: {
      run: (accountName: string) => usageRunnerService.run(accountName),
      getLast: (accountName: string) => usageRunnerService.getLast(accountName),
    },
    // Claude binary adapter
    claudeBinary: {
      getPath: () => claudeBinaryService.getPath(),
      setPath: (p: string) => claudeBinaryService.setPath(p),
      listInstallations: () => claudeBinaryService.listInstallations(),
    },
    // MCP adapter — service methods match handler interface names exactly
    mcp: {
      add: (data: any) => mcpService.add(data),
      list: (configDir?: string) => mcpService.list(configDir),
      get: (name: string, configDir?: string) => mcpService.get(name, configDir),
      remove: (name: string, configDir?: string) => mcpService.remove(name, configDir),
      addJson: (data: any) => mcpService.addJson(data),
      addFromClaudeDesktop: (scope?: string, configDir?: string) => mcpService.addFromClaudeDesktop(scope, configDir),
      serve: () => mcpService.serve(),
      testConnection: (name: string, configDir?: string) => mcpService.testConnection(name, configDir),
      resetProjectChoices: () => mcpService.resetProjectChoices(),
      getServerStatus: (configDir?: string) => mcpService.getServerStatus(configDir),
      readProjectConfig: (projectPath: string) => mcpService.readProjectConfig(projectPath),
      saveProjectConfig: (projectPath: string, config: any) =>
        mcpService.saveProjectConfig(projectPath, config),
    },
    // Slash commands adapter
    slashCommands: {
      list: (projectPath?: string, configDir?: string) => slashCommandsService.list(projectPath, configDir),
      get: (commandId: string, configDir?: string) => slashCommandsService.get(commandId, configDir),
      save: (data: any) => slashCommandsService.save(data),
      delete: (commandId: string, projectPath?: string, configDir?: string) => slashCommandsService.delete(commandId, projectPath, configDir),
    },
    // Sessions-summary adapter
    sessionsSummary: sessionsSummaryService,
    // Logging adapter
    logging: {
      writeBatch: (entries: any) => loggingService.writeBatch(entries),
      query: (params: any) => loggingService.query(params),
      count: (params: any) => loggingService.count(params ?? {}),
      prune: (olderThan?: string) => loggingService.prune(olderThan),
    },
    // Proxy adapter
    proxy: {
      getSettings: () => proxyService.getSettings(),
      saveSettings: (data: any) => proxyService.saveSettings(data),
    },
    // Permissions I/O adapter
    permissionsIO: permissionsIOService,
    // Models adapter — standalone model catalog lookup (no active session)
    models: {
      listSupported: (configDir: string) => modelsService.listSupported(configDir),
    },
    gitWatcher: {
      listWorktrees: (projectPath: string) => listWorktrees(projectPath),
      startSession: (projectPath: string) => sessionGitWatcher.start(projectPath),
      reconnectSession: (watchId: string) => sessionGitWatcher.reconnect(watchId),
      stopSession: (watchId: string) => sessionGitWatcher.stop(watchId),
    },
    branchColors: branchColorsService,
    gitBranches: gitBranchesService,
    lima: {
      isInstalled: () => limaService.isInstalled(),
      listVms: () => limaService.listVms(),
      listContainers: (vmName: string) => limaService.listContainers(vmName),
      startVm: (vmName: string) => limaService.startVm(vmName),
      stopVm: (vmName: string) => limaService.stopVm(vmName),
      startContainer: (vmName: string, containerId: string) =>
        limaService.startContainer(vmName, containerId),
      stopContainer: (vmName: string, containerId: string) =>
        limaService.stopContainer(vmName, containerId),
    },
    filesystem: filesystemService,
    notificationSounds: notificationSoundsService,
  });

  ipcMain.handle('get_app_version', () => app.getVersion());

  // --- Updater IPC (registered separately because it uses ipcMain directly) ---
  // Anonymous GitHub API (60/hr/IP) is plenty for a desktop client that
  // checks on launch + on demand. See updater.ts header for history.
  const updaterService = createUpdaterService(app.getVersion(), {
    getGitHubRepo: () => 'greychrist/omnifex',
    logging: loggingService,
  });

  ipcMain.handle('updater:check', async () => {
    return updaterService.checkForUpdate();
  });

  ipcMain.handle('updater:download', async (event, data: any) => {
    const url: string = data?.url ?? data;
    const assetName: string | undefined = data?.assetName ?? data?.asset_name;
    return updaterService.downloadUpdate(url, (progress) => {
      // Send progress only to the window that initiated the download.
      if (!event.sender.isDestroyed()) {
        event.sender.send('updater:progress', progress);
      }
    }, assetName);
  });

  ipcMain.handle('updater:open', async (_event, data: any) => {
    const filePath: string = data?.filePath ?? data?.file_path ?? data;
    const errMsg = await shell.openPath(filePath);
    if (errMsg) throw new Error(errMsg);
    // Give the DMG a moment to mount, then quit so the user can drag-install
    setTimeout(() => app.quit(), 1500);
  });

  // Tab Status — renderer-published per-tab summaries (busy/idle, agent
  // counts, tasks, git, context usage). Each chat tab pushes its own state
  // up; the popover and the install gate both read from this aggregator.
  const tabStatusService = createTabStatusService({
    broadcast: (summaries) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('tab-status:changed', summaries);
      }
    },
  });

  ipcMain.handle('tab_status_publish', async (_event, data: any) => {
    const summary = data?.summary as TabStatusSummary | undefined;
    if (!summary || typeof summary.tabId !== 'string') {
      throw new Error('tab_status_publish requires summary.tabId');
    }
    tabStatusService.publish(summary);
    return { success: true };
  });

  ipcMain.handle('tab_status_remove', async (_event, data: any) => {
    const tabId: string | undefined = data?.tabId ?? data?.tab_id;
    if (!tabId) throw new Error('tab_status_remove requires tabId');
    tabStatusService.remove(tabId);
    return { success: true };
  });

  ipcMain.handle('tab_status_list', async () => tabStatusService.list());

  const installerService = createInstallerService({
    sessionsService: {
      // Renderer-derived busy state is the source of truth for the install
      // gate. Falls back to the lifecycle status only if no tab has reported
      // yet (cold-start race), so a fresh app launch can still gate correctly
      // before any summary publishes.
      listInFlightTabIds: () => {
        const fromRenderer = tabStatusService.busyTabIds();
        if (fromRenderer.length > 0 || tabStatusService.list().length > 0) {
          return fromRenderer;
        }
        return sessionsService.listInFlightTabIds();
      },
      listSessionStatuses: () => sessionsService.listSessionStatuses(),
      stopAll: () => sessionsService.stopAll(),
    },
    appQuit: () => app.quit(),
    spawn: (cmd, args, opts) => spawn(cmd, args, opts),
    sendToRenderer: (channel, payload) => {
      // Send to all renderers — the install flow is global.
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload));
    },
    execPath: process.execPath,
  });

  ipcMain.handle('updater:install', async (_event, data: any) => {
     
    console.log('[installer] updater:install IPC fired', { data });
    const zipPath: string = data?.zipPath ?? data?.zip_path ?? data?.url ?? data;
    const expectedVersion: string = data?.version ?? data?.expectedVersion ?? data?.expected_version;
    const force: boolean = data?.force === true;
     
    console.log('[installer] resolved params', { zipPath, expectedVersion, force });

    let stagedAppPath: string | null = null;
    try {
       
      console.log('[installer] step 1: stage()');
      const staged = await installerService.stage(zipPath, expectedVersion);
      stagedAppPath = staged.stagedAppPath;
       
      console.log('[installer] step 2: resolveTargetApp()');
      const { targetAppPath } = installerService.resolveTargetApp();
       
      console.log('[installer] step 3: ensureTargetWritable()', { targetAppPath });
      await installerService.ensureTargetWritable(targetAppPath);
       
      console.log('[installer] step 4: waitForIdle()', { force });
      await installerService.waitForIdle({ force });
       
      console.log('[installer] step 5: executeInstall()');
      await installerService.executeInstall(stagedAppPath, targetAppPath);
      // executeInstall calls app.quit() — we never reach this line in practice.
      return { success: true };
    } catch (err: any) {
       
      console.log('[installer] caught error', { name: err?.name, message: err?.message });
      // Clean up the staged temp dir if extraction succeeded but a later step failed.
      if (stagedAppPath) {
        const stageRoot = path.dirname(stagedAppPath);
        await fs.promises.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      }
      // Surface the error name + message so the renderer can show a specific
      // message ("Cannot write to /Applications", etc.).
      throw new Error(`${err.name ?? 'InstallError'}: ${err.message ?? String(err)}`);
    }
  });

  ipcMain.handle('updater:install-cancel', async () => {
    installerService.cancelWait();
    return { success: true };
  });

  // Broadcast in-flight session count so the titlebar can decide, before the
  // user clicks install, whether to show the plain "Update Available" button
  // or the active-sessions warning. 1 s poll is plenty — the count only
  // changes when a session enters/leaves a turn, not per stream message.
  let lastInFlightCount = -1;
  const broadcastInFlight = (): void => {
    // Drives the upgrade-button "active sessions" warning. Use
    // `workingTabIds` (promptStatus === 'working') so the warning fires
    // only when the agent is genuinely doing work — not when a session
    // is just paused on a permission prompt. The install-gate itself
    // keeps using `busyTabIds` for its broader "wait for everything to
    // settle" semantics.
    const fromRenderer = tabStatusService.list().length > 0
      ? tabStatusService.workingTabIds().length
      : null;
    const count = fromRenderer ?? sessionsService.listInFlightTabIds().length;
    if (count === lastInFlightCount) return;
    lastInFlightCount = count;
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('session-inflight-count', { count });
    }
  };
  const inFlightTimer = setInterval(broadcastInFlight, 1000);
  if (typeof inFlightTimer.unref === 'function') inFlightTimer.unref();
  app.on('before-quit', () => clearInterval(inFlightTimer));
  // Fire one immediately so any newly-created window starts with the right count.
  broadcastInFlight();

  installAppMenu();

  // Create the window AFTER all IPC handlers are registered so the renderer
  // cannot fire calls before the main process is ready to handle them.
  _initialized = true;
  createWindow();
}).catch((err: unknown) => { console.error('[main:whenReady-init]', err); });

app.on('before-quit', () => {
  _sessionsService?.stopAll();
  _gitWatcherService?.disposeAll();
  _db?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // Only create a window if initialization completed (handlers registered).
  // On macOS, activate can fire on first launch before whenReady().then() finishes.
  if (_initialized && BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export function getAllWindows(): BrowserWindow[] {
  return Array.from(windows);
}
