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
    const match = result.match(/__PATH__=(.+)/);
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
import { createClaudeBinaryService } from './services/claude-binary';
import { createSessionsService } from './services/sessions';
import { createNotificationsService } from './services/notifications';
import { createClaudeService } from './services/claude';
import { createUsageService } from './services/usage';
import { createRateLimitsService } from './services/rate-limits';
import { createLoggingService } from './services/logging';
import { createProxyService } from './services/proxy';
import { createMCPService } from './services/mcp';
import { createModelsService } from './services/models';
import { createSlashCommandsService } from './services/slash-commands';
import { createPermissionsIOService } from './services/permissions-io';
import { createUpdaterService } from './services/updater';
import { createInstallerService } from './services/installer';
import { createSdkVersionService } from './services/sdk-version';
import { createGitWatcherService, listWorktrees } from './services/git-watcher';
import { createLimaService } from './services/lima';
import { registerIpcHandlers } from './ipc/handlers';
import { createWindowRouter } from './window-router';
import { classifyNavigation } from './navigation-policy';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
// Baked in at build time by vite.main.config.ts — see resolveReferencedSdkVersion.
declare const __GREYCHRIST_REFERENCED_SDK_VERSION__: string;

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
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
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
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const decision = classifyNavigation(url, { devServerUrl });
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') shell.openExternal(url);
  });

  win.webContents.on('context-menu', (_event, params) => {
    const { selectionText, editFlags, isEditable, linkURL } = params;
    const hasText = typeof selectionText === 'string' && selectionText.trim().length > 0;
    const template: MenuItemConstructorOptions[] = [];

    if (linkURL) {
      template.push({ label: 'Open Link', click: () => shell.openExternal(linkURL) });
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

app.whenReady().then(() => {
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
  const defaultConfigDir = path.join(os.homedir(), '.claude');

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
  });
  const accountsService = createAccountsService(db);
  const claudeBinaryService = createClaudeBinaryService(db);
  // Logging must be constructed before sessions so the sessions service can
  // route CLI subprocess stderr into the log store.
  const loggingService = createLoggingService(db);
  const successSound = 'greychrist_success';
  const notificationsService = _notificationsService = createNotificationsService({
    isSupported: () => Notification.isSupported(),
    isWindowFocused: () => anyWindowFocused(),
    focusWindow: () => focusAnyWindow(),
    onNotificationClick: ({ tabId }) => {
      if (tabId) sendToRenderer('notification-clicked', { tabId });
    },
    getSoundPath: (isError) =>
      isError
        ? '/System/Library/Sounds/Basso.aiff'
        : app.isPackaged
          ? path.join(process.resourcesPath, 'assets', `${successSound}.aiff`)
          : path.join(app.getAppPath(), 'assets', `${successSound}.aiff`),
    playSound: (soundPath) => {
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
  const sessionsService = _sessionsService = createSessionsService(
    sendToRenderer,
    {
      showNotification: (title, body, isError, payload) => {
        notificationsService.show(title, body, isError, payload);
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
  );
  const claudeService = createClaudeService(db, accountsService);
  const usageService = createUsageService(accountsService, loggingService);
  const proxyService = createProxyService(db);
  const mcpService = createMCPService(defaultConfigDir);
  const slashCommandsService = createSlashCommandsService(defaultConfigDir);
  const modelsService = createModelsService();
  const sdkVersionService = createSdkVersionService({
    readSdkPackageJson: async () => {
      // Prefer the value baked in at build time — it's the exact version
      // Vite resolved when bundling main.js, and it's the only source that
      // works in the packaged app (where node_modules is tree-shaken away).
      if (typeof __GREYCHRIST_REFERENCED_SDK_VERSION__ === 'string'
          && __GREYCHRIST_REFERENCED_SDK_VERSION__.length > 0) {
        return { version: __GREYCHRIST_REFERENCED_SDK_VERSION__ };
      }
      // Dev fallback: read the installed package.json directly if the
      // build-time constant wasn't defined for some reason (e.g. running
      // main.ts outside of Vite).
      try {
        const sdkPkgPath = path.join(
          app.getAppPath(),
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk',
          'package.json',
        );
        const raw = await fs.promises.readFile(sdkPkgPath, 'utf8');
        return JSON.parse(raw) as { version?: string };
      } catch {
        return null;
      }
    },
    fetchLatestVersion: async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest',
          { signal: ctrl.signal },
        );
        if (!res.ok) return '';
        const body = (await res.json()) as { version?: string };
        return body?.version ?? '';
      } finally {
        clearTimeout(timer);
      }
    },
  });
  const gitWatcherService = _gitWatcherService = createGitWatcherService({
    sendToRenderer,
  });
  const limaService = createLimaService();

  registerIpcHandlers({
    database: db,
    // Accounts adapter — maps handler interface to service methods
    accounts: {
      list: () => accountsService.listAccounts(),
      create: (data: any) =>
        accountsService.createAccount(
          data.name,
          data.configDir ?? data.config_dir,
          data.isDefault ?? data.is_default ?? false,
          data.accountType ?? data.account_type,
          data.color,
          data.icon,
          data.sessionDefaults ?? data.session_defaults,
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
        ),
      delete: (id: any) => accountsService.deleteAccount(id),
      listPathRules: () => accountsService.listPathRules(),
      addPathRule: (rule: any) =>
        accountsService.addPathRule(rule.accountId ?? rule.account_id, rule.pathPrefix ?? rule.path_prefix, rule.priority),
      removePathRule: (id: any) => accountsService.removePathRule(id),
      resolveForProject: (projectPath: string) => accountsService.resolve(projectPath),
      setProjectOverride: (projectPath: string, accountId: any) =>
        accountsService.setProjectOverride(projectPath, accountId),
      listProjectOverrides: () => accountsService.listProjectOverrides(),
      discoverAccounts: () => accountsService.discoverAccounts(),
      explainResolution: (projectPath: string) =>
        accountsService.explainResolution(projectPath),
    },
    // Claude adapter
    claude: {
      listProjects: (_configDir?: string) => claudeService.listProjects(),
      createProject: (data: any) => claudeService.createProject(data?.path ?? data),
      getProjectSessions: (projectId: string, projectPath?: string) => claudeService.getProjectSessions(projectId, projectPath),
      loadSessionHistory: (sessionId: string, projectId: string) =>
        claudeService.loadSessionHistory(sessionId, projectId),
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
      setMode: (tabId: string, mode: 'sdk' | 'tui') => sessionsService.setMode(tabId, mode),
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
      refresh: (accountName: string) => rateLimitsService.refresh(accountName),
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
    sdkVersion: {
      getReferenced: () => sdkVersionService.getReferenced(),
      getLatest: () => sdkVersionService.getLatest(),
    },
    gitWatcher: {
      start: (projectPath: string) => gitWatcherService.start(projectPath),
      stop: (watchId: string) => gitWatcherService.stop(watchId),
      listWorktrees: (projectPath: string) => listWorktrees(projectPath),
      startWorktreeListWatch: (projectPath: string) =>
        gitWatcherService.startWorktreeListWatch(projectPath),
      stopWorktreeListWatch: (watchId: string) =>
        gitWatcherService.stopWorktreeListWatch(watchId),
    },
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
  });

  ipcMain.handle('get_app_version', () => app.getVersion());

  // --- Updater IPC (registered separately because it uses ipcMain directly) ---
  // Reads the user-configured local update folder from app_settings on every
  // check so that changes in the Settings UI take effect without restarting.
  const updaterService = createUpdaterService(app.getVersion(), {
    getLocalUpdateDir: () => db.getSetting('local_update_dir'),
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

  const installerService = createInstallerService({
    sessionsService: {
      listInFlightTabIds: () => sessionsService.listInFlightTabIds(),
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
    // eslint-disable-next-line no-console
    console.log('[installer] updater:install IPC fired', { data });
    const zipPath: string = data?.zipPath ?? data?.zip_path ?? data?.url ?? data;
    const expectedVersion: string = data?.version ?? data?.expectedVersion ?? data?.expected_version;
    const force: boolean = data?.force === true;
    // eslint-disable-next-line no-console
    console.log('[installer] resolved params', { zipPath, expectedVersion, force });

    let stagedAppPath: string | null = null;
    try {
      // eslint-disable-next-line no-console
      console.log('[installer] step 1: stage()');
      const staged = await installerService.stage(zipPath, expectedVersion);
      stagedAppPath = staged.stagedAppPath;
      // eslint-disable-next-line no-console
      console.log('[installer] step 2: resolveTargetApp()');
      const { targetAppPath } = installerService.resolveTargetApp();
      // eslint-disable-next-line no-console
      console.log('[installer] step 3: ensureTargetWritable()', { targetAppPath });
      await installerService.ensureTargetWritable(targetAppPath);
      // eslint-disable-next-line no-console
      console.log('[installer] step 4: waitForIdle()', { force });
      await installerService.waitForIdle({ force });
      // eslint-disable-next-line no-console
      console.log('[installer] step 5: executeInstall()');
      await installerService.executeInstall(stagedAppPath, targetAppPath);
      // executeInstall calls app.quit() — we never reach this line in practice.
      return { success: true };
    } catch (err: any) {
      // eslint-disable-next-line no-console
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
    const count = sessionsService.listInFlightTabIds().length;
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
});

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
