import { app, BrowserWindow, ipcMain, protocol, Notification, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Log errors to console and show dialog
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
import { createDatabase } from './services/database';
import { createAccountsService } from './services/accounts';
import { createClaudeBinaryService } from './services/claude-binary';
import { createSessionsService } from './services/sessions';
import { createClaudeService } from './services/claude';
import { createAgentsService } from './services/agents';
import { createAgentRunRegistry } from './services/agent-run-registry';
import { createCheckpointsService } from './services/checkpoints';
import { createUsageService } from './services/usage';
import { createLoggingService } from './services/logging';
import { createProxyService } from './services/proxy';
import { createMCPService } from './services/mcp';
import { createSlashCommandsService } from './services/slash-commands';
import { createUpdaterService } from './services/updater';
import { registerIpcHandlers } from './ipc/handlers';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let _sessionsService: { stopAll(): void } | null = null;
let _db: { close(): void } | null = null;
let _initialized = false;

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }
  mainWindow.show();

  mainWindow.on('focus', () => {
    // Clear unread badge when user focuses the window
    clearUnread();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
  const accountsService = createAccountsService(db);
  const claudeBinaryService = createClaudeBinaryService(db);
  // Logging must be constructed before sessions so the sessions service can
  // route CLI subprocess stderr into the log store.
  const loggingService = createLoggingService(db);
  const sessionsService = _sessionsService = createSessionsService(
    (channel, ...args) => {
      mainWindow?.webContents.send(channel, ...args);
    },
    {
      showNotification: (title, body, isError) => {
        // Skip native notification when the app is already in focus
        if (mainWindow?.isFocused()) return;
        if (!Notification.isSupported()) return;
        const subtitle = isError ? 'Task Failed' : 'Task Complete';
        const notif = new Notification({
          title,
          subtitle,
          body,
          silent: false,
        });
        notif.on('click', () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          }
        });
        notif.show();
      },
      incrementUnread: () => {
        // Only bump the dock badge when the app isn't in focus
        if (mainWindow?.isFocused()) return;
        incrementUnread();
      },
    },
    loggingService,
  );
  const claudeService = createClaudeService(db, accountsService);
  const agentRunRegistry = createAgentRunRegistry();
  const agentsService = createAgentsService(
    db,
    accountsService,
    claudeBinaryService,
    agentRunRegistry,
    (channel, ...args) => {
      mainWindow?.webContents.send(channel, ...args);
    },
  );
  const checkpointsService = createCheckpointsService(db, accountsService);
  const usageService = createUsageService(accountsService);
  const proxyService = createProxyService(db);
  const mcpService = createMCPService(defaultConfigDir);
  const slashCommandsService = createSlashCommandsService(defaultConfigDir);

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
        ),
      update: (_id: any, data: any) =>
        accountsService.updateAccount(data.id, data.name, data.configDir ?? data.config_dir, data.accountType ?? data.account_type, data.color),
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
      loadAgentSessionHistory: (sessionId: string) =>
        claudeService.loadAgentSessionHistory(sessionId),
      getHomeDirectory: () => claudeService.getHomeDirectory(),
      getSettings: () => claudeService.getClaudeSettings(),
      saveSettings: (settings: any) => claudeService.saveClaudeSettings(settings),
      getSystemPrompt: () => claudeService.getSystemPrompt(),
      saveSystemPrompt: (prompt: any) =>
        claudeService.saveSystemPrompt(typeof prompt === 'string' ? prompt : String(prompt ?? '')),
      checkVersion: () => claudeService.checkClaudeVersion(),
      findClaudeMdFiles: (projectPath: string) => claudeService.findClaudeMdFiles(projectPath),
      readClaudeMdFile: (filePath: string) => claudeService.readClaudeMdFile(filePath),
      saveClaudeMdFile: (filePath: string, content: string) =>
        claudeService.saveClaudeMdFile(filePath, content),
      getHooksConfig: () => claudeService.getHooksConfig('user'),
      updateHooksConfig: (config: any) => claudeService.updateHooksConfig('user', config),
      validateHookCommand: (command: string) => claudeService.validateHookCommand(command),
      getMergedHooksConfig: () => claudeService.getMergedHooksConfig(''),
    },
    // Sessions adapter
    sessions: {
      start: (data: any) => sessionsService.start(data),
      sendMessage: (sessionId: string, message: any) =>
        sessionsService.sendMessage(
          sessionId,
          typeof message === 'string' ? message : String(message ?? ''),
        ),
      sendStructuredMessage: (sessionId: string, content: any) =>
        sessionsService.sendStructuredMessage(sessionId, content),
      respondPermission: (sessionId: string, behavior: string, updatedInput?: Record<string, unknown>) =>
        sessionsService.respondPermission(sessionId, behavior as 'allow' | 'deny', updatedInput),
      stop: (sessionId: string) => sessionsService.stop(sessionId),
      getInfo: (sessionId: string) => sessionsService.getInfo(sessionId),
      // Wave 2 — Query-method passthroughs
      interrupt: (sessionId: string) => sessionsService.interrupt(sessionId),
      setModel: (sessionId: string, model?: string) => sessionsService.setModel(sessionId, model),
      setPermissionMode: (sessionId: string, mode: string) =>
        sessionsService.setPermissionMode(sessionId, mode as any),
      getAccountInfo: (sessionId: string) => sessionsService.getAccountInfo(sessionId),
      getContextUsage: (sessionId: string) => sessionsService.getContextUsage(sessionId),
      getSupportedCommands: (sessionId: string) => sessionsService.getSupportedCommands(sessionId),
      getSupportedModels: (sessionId: string) => sessionsService.getSupportedModels(sessionId),
      getSupportedAgents: (sessionId: string) => sessionsService.getSupportedAgents(sessionId),
    },
    // Agents adapter
    agents: {
      list: () => agentsService.listAgents(),
      create: (data: any) => agentsService.createAgent(data),
      update: (id: any, data: any) => agentsService.updateAgent({ id, ...data }),
      delete: (id: any) => agentsService.deleteAgent(id),
      get: (id: any) => agentsService.getAgent(id),
      export: (id: any) => agentsService.exportAgent(id),
      import: (data: any) =>
        agentsService.importAgent(typeof data === 'string' ? data : JSON.stringify(data)),
      execute: (agentId: any, data: any) =>
        agentsService.executeAgent({ agentId, ...data }),
      listRuns: () => agentsService.listAgentRuns(),
      getRun: (id: any) => agentsService.getAgentRun(id),
      getRunWithMetrics: (id: any) => agentsService.getAgentRunWithRealTimeMetrics(id),
      killSession: (runId: any) => agentsService.killAgentSession(runId),
      getSessionStatus: (runId: any) => agentsService.getSessionStatus(runId),
      cleanupFinished: () => agentsService.cleanupFinishedProcesses(),
      getSessionOutput: (runId: any) => agentsService.getSessionOutput(runId),
      getLiveSessionOutput: (runId: any) => agentsService.getLiveSessionOutput(runId),
      streamSessionOutput: (runId: any) => agentsService.streamSessionOutput(runId),
      fetchGithubAgents: () => agentsService.fetchGitHubAgents(),
      fetchGithubAgentContent: (data: any) =>
        agentsService.fetchGitHubAgentContent(data?.download_url ?? data),
      importFromGithub: (data: any) =>
        agentsService.importAgentFromGitHub(data?.download_url ?? data),
    },
    // Checkpoints adapter
    checkpoints: {
      create: (data: any) => checkpointsService.createCheckpoint(data),
      restore: (data: any) => checkpointsService.restoreCheckpoint(data),
      list: (data: any) => checkpointsService.listCheckpoints(data),
      forkFrom: (data: any) => checkpointsService.forkFromCheckpoint(data),
      getTimeline: (data: any) => checkpointsService.getSessionTimeline(data),
      updateSettings: (data: any) => checkpointsService.updateCheckpointSettings(data),
      getSettings: (data: any) => checkpointsService.getCheckpointSettings(data),
      getDiff: (data: any) => checkpointsService.getCheckpointDiff(data),
    },
    // Usage adapter
    usage: {
      getStats: (_params?: any) => usageService.getUsageStats(),
      getByDateRange: (params: any) =>
        usageService.getUsageByDateRange(params?.start_date ?? '', params?.end_date ?? ''),
      getSessionStats: (params?: any) =>
        usageService.getSessionStats(params?.since, params?.until, params?.order),
      getDetails: (params?: any) => usageService.getUsageDetails(params?.limit),
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
      list: () => mcpService.list(),
      get: (name: string) => mcpService.get(name),
      remove: (name: string) => mcpService.remove(name),
      addJson: (data: any) => mcpService.addJson(data),
      addFromClaudeDesktop: () => mcpService.addFromClaudeDesktop(),
      serve: (data: any) => mcpService.serve(),
      testConnection: (name: string) => mcpService.testConnection(name),
      resetProjectChoices: () => mcpService.resetProjectChoices(),
      getServerStatus: () => mcpService.getServerStatus(),
      readProjectConfig: (data: any) => mcpService.readProjectConfig(data?.project_path ?? ''),
      saveProjectConfig: (data: any) =>
        mcpService.saveProjectConfig(data?.project_path ?? '', data?.config),
    },
    // Slash commands adapter
    slashCommands: {
      list: () => slashCommandsService.list(),
      get: (commandId: string) => slashCommandsService.get(commandId),
      save: (data: any) => slashCommandsService.save(data),
      delete: (commandId: string) => slashCommandsService.delete(commandId),
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
  });

  ipcMain.handle('get_app_version', () => app.getVersion());

  // --- Updater IPC (registered separately because it uses ipcMain directly) ---
  const updaterService = createUpdaterService(app.getVersion(), {
    downloadsPath: app.getPath('downloads'),
    getToken: () => db.getSetting('github_token'),
  });

  ipcMain.handle('updater:check', async () => {
    return updaterService.checkForUpdate();
  });

  ipcMain.handle('updater:download', async (_event, data: any) => {
    const url: string = data?.url ?? data;
    const assetName: string | undefined = data?.assetName ?? data?.asset_name;
    return updaterService.downloadUpdate(url, (progress) => {
      mainWindow?.webContents.send('updater:progress', progress);
    }, assetName);
  });

  ipcMain.handle('updater:open', async (_event, data: any) => {
    const filePath: string = data?.filePath ?? data?.file_path ?? data;
    const errMsg = await shell.openPath(filePath);
    if (errMsg) throw new Error(errMsg);
    // Give the DMG a moment to mount, then quit so the user can drag-install
    setTimeout(() => app.quit(), 1500);
  });

  // Create the window AFTER all IPC handlers are registered so the renderer
  // cannot fire calls before the main process is ready to handle them.
  _initialized = true;
  createWindow();
});

app.on('before-quit', () => {
  _sessionsService?.stopAll();
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

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
