import { app, BrowserWindow, dialog } from 'electron';
import os from 'node:os';
import path from 'node:path';

// Suppress error dialogs in dev — log to console instead
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
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
import { createProcessRegistry } from './services/process-registry';
import { createCheckpointsService } from './services/checkpoints';
import { createUsageService } from './services/usage';
import { createLoggingService } from './services/logging';
import { createProxyService } from './services/proxy';
import { createMCPService } from './services/mcp';
import { createSlashCommandsService } from './services/slash-commands';
import { registerIpcHandlers } from './ipc/handlers';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let _sessionsService: { stopAll(): void } | null = null;
let _db: { close(): void } | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
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

  mainWindow.on('focus', () => {
    if (process.platform === 'darwin') {
      app.dock.setBadge('');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  const defaultConfigDir = path.join(os.homedir(), '.claude');

  const db = createDatabase(path.join(userDataPath, 'greychrist.db'));
  _db = db;
  const accountsService = createAccountsService(db);
  const claudeBinaryService = createClaudeBinaryService(db);
  const sessionsService = _sessionsService = createSessionsService((channel, ...args) => {
    mainWindow?.webContents.send(channel, ...args);
  });
  const claudeService = createClaudeService(db, accountsService);
  const processRegistry = createProcessRegistry();
  const agentsService = createAgentsService(
    db,
    accountsService,
    claudeBinaryService,
    processRegistry,
    (channel, ...args) => {
      mainWindow?.webContents.send(channel, ...args);
    },
  );
  const checkpointsService = createCheckpointsService(db, accountsService);
  const usageService = createUsageService(accountsService);
  const loggingService = createLoggingService(db);
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
          data.config_dir,
          data.is_default ?? false,
          data.account_type,
        ),
      update: (_id: any, data: any) =>
        accountsService.updateAccount(data.id, data.name, data.config_dir, data.account_type),
      delete: (id: any) => accountsService.deleteAccount(id),
      setDefault: (id: any) => accountsService.setDefaultAccount(id),
      listPathRules: () => accountsService.listPathRules(),
      addPathRule: (rule: any) =>
        accountsService.addPathRule(rule.account_id, rule.path_prefix, rule.priority),
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
      createProject: (_data: any) => null,
      getProjectSessions: (projectId: string) => claudeService.getProjectSessions(projectId),
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
      respondPermission: (sessionId: string, response: any) =>
        sessionsService.respondPermission(sessionId, response?.behavior, response?.updatedInput),
      stop: (sessionId: string) => sessionsService.stop(sessionId),
      getInfo: (sessionId: string) => sessionsService.getInfo(sessionId),
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
    },
    // Proxy adapter
    proxy: {
      getSettings: () => proxyService.getSettings(),
      saveSettings: (data: any) => proxyService.saveSettings(data),
    },
  });

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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
