/**
 * The OmniFex Remote daemon — composition root.
 *
 * Builds the same service graph `electron/main.ts` builds, minus everything
 * that needs a window or a display, and fronts it with the protocol server
 * instead of `ipcMain`. The session layer, the database, the accounts, the
 * Brain, the cost ledger: all the same factories, all the same rules. What
 * differs is the edge — `sendToRenderer` is the session bridge, not a
 * BrowserWindow, and `rpc.invoke` reaches the very same handler map the
 * renderer's `invoke()` does today, behind an allowlist.
 *
 * Runs as the Electron binary with `ELECTRON_RUN_AS_NODE=1` (see
 * `scripts/omnifex-server`): `better-sqlite3` and `node-pty` are built for
 * Electron's ABI, and this keeps one ABI instead of two. Nothing here may
 * touch the `electron` module — the one `require('electron')` on the daemon's
 * import graph is inside `registerIpcHandlers`, which is never called.
 *
 * Deliberate duplication: the ~200 lines of service wiring below mirror
 * main.ts rather than share a factory with it. Extracting a common
 * composition root out of a 1,900-line main.ts unattended was the wrong risk
 * to take; it is the first follow-up in the plan.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { startPeriodicWork } from '../periodic-work';
import { createDatabase, ensureDefaultSettings } from '../services/database';
import { createAccountsService } from '../services/accounts';
import { createClaudeBinaryService } from '../services/claude-binary';
import {
  createClaudeCliReviewService,
  execCliUpdate,
  fetchLatestCliVersion,
  probeCliVersion,
  CLI_REVIEW_REPO_DIR_SETTING_KEY,
} from '../services/claude-cli-review';
import { createSessionsService } from '../services/sessions';
import { findSystemClaudeBinary } from '../services/sessions/binary';
import { createClaudeService } from '../services/claude';
import { encodeProjectId } from '../services/project-paths';
import { createUsageService } from '../services/usage';
import { createRateLimitsService } from '../services/rate-limits';
import { createUsageRunnerService } from '../services/usage-runner';
import { createLoggingService } from '../services/logging';
import { createProxyService } from '../services/proxy';
import { createMCPService } from '../services/mcp';
import { createModelsService, type ModelInfo } from '../services/models';
import { createCommandsCatalogService } from '../services/commands-catalog';
import { createSlashCommandsService } from '../services/slash-commands';
import { createFilesystemService } from '../services/filesystem';
import { createCodexSessionWalker } from '../services/codex-session-walker';
import {
  readOauthIdentity,
  probeAuthStatus,
  classifyIdentity,
  type IdentityVerdict,
} from '../services/account-identity';
import {
  createSessionsSummaryService,
  DEFAULT_SUMMARY_PROMPT,
  PROMPT_TEMPLATE_SETTING_KEY,
  AUTO_ON_CLOSE_SETTING_KEY,
  ENABLED_SETTING_KEY,
} from '../services/sessions-summary';
import { createSummaryQueryRunner } from '../services/sessions/summary-query';
import {
  internalArchiveRoot,
  internalArchiveStats,
  clearInternalArchive,
} from '../services/sessions/internal-archive';
import { readSubagentMeta } from '../services/sessions/subagent-meta';
import { createPermissionsIOService } from '../services/permissions-io';
import { createSessionGitWatcher, listWorktrees } from '../services/git-watcher';
import { createBranchColorsService } from '../services/branch-colors';
import { listBranches as listGitBranches } from '../services/git-branches';
import { createLimaService } from '../services/lima';
import { createCostHistoryService } from '../services/cost/cost-history';
import { createSessionCostService } from '../services/cost/session-cost';
import { createModelPricingService } from '../services/model-pricing';
import { createBrainService, type BrainService } from '../services/brain/registry';
import { createSessionSource } from '../services/brain/sources/session-transcripts';
import { createCaptureSource } from '../services/brain/sources/capture';
import { createAutoMemorySource } from '../services/brain/sources/auto-memory';
import { createRepoArtifactSource } from '../services/brain/sources/repo-artifacts';
import {
  brainSpawnArgs,
  createBrainMcpRegistration,
  writeBrainSpawnConfig,
  type BrainMcpEnvironment,
} from '../services/brain/mcp-registration';
import { createExtractor } from '../services/brain/extract';
import { createCurator } from '../services/brain/curation';
import {
  BRAIN_AUTO_INDEX_SETTING_KEY,
  BRAIN_CURATE_SETTING_KEY,
  BRAIN_IDLE_MINUTES_SETTING_KEY,
  BRAIN_QUEUE_PAUSED_SETTING_KEY,
  BRAIN_SWEEP_HOURS_SETTING_KEY,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_SWEEP_HOURS,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  readNumericSetting,
} from '../services/brain/queue';
import { getHandlerMap } from '../ipc/handlers';
import { INVOKE_CHANNELS } from '../ipc/channels';
import { classifyJsonlLine } from '../../src/lib/jsonlClassifier';

import type { ServerConfig } from './config';
import { appExecPath } from './daemon-exec';
import { createSessionLog } from './session-log';
import { createSessionBridge } from './bridge';
import { createProjectRegistry } from './projects';
import { buildRpcAllowlist } from './rpc-allowlist';
import { createRemoteHandlers, type RpcHandler } from './handlers';
import { createRemoteServer, type RemoteServerLogger } from './server';
import { resolveWebRoot } from './webroot';
import { createPushService, pushPayloadFor } from './push';

export interface DaemonOptions {
  config: ServerConfig;
  version: string;
  /** Bundle stamp (script mtime); lets a dev app tell a stale same-version daemon. */
  build?: string;
  log: RemoteServerLogger;
}

export interface RunningDaemon {
  address: { host: string; port: number };
  close(): Promise<void>;
}

/**
 * launchd and Finder both start processes with a minimal PATH. Re-derive it
 * from the login shell so `claude` (nvm, homebrew, ~/.local/bin) resolves —
 * the same fix `main.ts` applies for the same reason.
 */
export function fixPath(log: RemoteServerLogger): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execSync(`${shell} -ilc 'echo "__PATH__=$PATH"'`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const m = /__PATH__=(.+)/.exec(out);
    if (m) {
      process.env.PATH = m[1];
      log.debug('PATH from login shell', { entries: m[1].split(':').length });
    }
  } catch (err) {
    log.warn('could not read PATH from login shell', { error: (err as Error).message });
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const { config, log } = opts;
  const startedAt = Date.now();

  fixPath(log);

  // Fail loudly before touching anything else: a daemon that came up without
  // the CLI would accept sessions and error on every one of them.
  const claudeBinary = findSystemClaudeBinary();
  if (!claudeBinary) {
    throw new Error(
      '`claude` was not found on PATH. The daemon runs sessions through the Claude CLI and cannot start without it. ' +
        `PATH=${process.env.PATH ?? '(unset)'}`,
    );
  }
  log.info('claude binary', { path: claudeBinary });

  fs.mkdirSync(config.sessionsDir, { recursive: true });
  fs.mkdirSync(config.userDataDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // Database + the services main.ts builds first
  // ---------------------------------------------------------------------------

  const db = createDatabase(path.join(config.userDataDir, 'greychrist.db'));
  ensureDefaultSettings(db, {
    [PROMPT_TEMPLATE_SETTING_KEY]: DEFAULT_SUMMARY_PROMPT,
    [ENABLED_SETTING_KEY]: 'true',
    [AUTO_ON_CLOSE_SETTING_KEY]: 'true',
    [BRAIN_AUTO_INDEX_SETTING_KEY]: 'false',
    [BRAIN_QUEUE_PAUSED_SETTING_KEY]: 'false',
    [BRAIN_IDLE_MINUTES_SETTING_KEY]: String(DEFAULT_IDLE_MINUTES),
    [BRAIN_SWEEP_HOURS_SETTING_KEY]: String(DEFAULT_SWEEP_HOURS),
  });
  const accountsService = createAccountsService(db);

  // ---------------------------------------------------------------------------
  // Protocol-side state: log, bridge, registry, server
  // ---------------------------------------------------------------------------

  const sessionLog = createSessionLog({ root: config.sessionsDir, ringSize: config.ringSize });
  const projects = createProjectRegistry({
    file: config.projectsFile,
    resolveAccount: (p) => {
      const claude = accountsService.resolve(p).claude;
      return claude ? { accountId: claude.account.id, configDir: claude.account.config_dir } : null;
    },
  });

  // Server is declared before the bridge so the bridge can publish into it;
  // handlers are registered after every service exists.
  let handlersRef: ReturnType<typeof createRemoteHandlers> | null = null;
  let pushServiceRef: ReturnType<typeof createPushService> | null = null;
  const webRoot = resolveWebRoot(config.webRoot, __dirname);
  log.info('web root', { webRoot: webRoot ?? '(none — no web client served)' });
  const server = createRemoteServer({
    host: config.host,
    port: config.port,
    daemonVersion: opts.version,
    capabilities: { tui: true, rpcInvoke: true, attachments: 'base64', web: webRoot !== null, push: true },
    webRoot,
    log,
    api: {
      health: () => ({
        ok: true,
        version: opts.version,
        build: opts.build,
        protocolVersion: 1,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        host: config.host,
        port: config.port,
        clients: server.clients.length,
        sessions: {
          live: sessionsRef?.listActiveTabIds().length ?? 0,
          known: sessionLog.list().length,
          // Turns running right now. The Electron launcher reads this before
          // replacing an outdated daemon: idle → replace at once, busy →
          // attach and check back.
          inFlight: (handlersRef?.summaries() ?? []).filter((s) => s.inFlight).length,
        },
      }),
      sessions: () => handlersRef?.summaries() ?? [],
      projects: () => projects.list(),
      push: {
        publicKey: () => pushServiceRef?.publicKey() ?? '',
        subscribe: (body) => {
          const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; label?: unknown };
          if (typeof b.endpoint !== 'string' || typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string') {
            throw new Error('subscription needs endpoint and keys.p256dh/auth');
          }
          if (!pushServiceRef) throw new Error('push not enabled');
          return pushServiceRef.subscribe({
            endpoint: b.endpoint,
            keys: { p256dh: b.keys.p256dh, auth: b.keys.auth },
            ...(typeof b.label === 'string' && { label: b.label.slice(0, 120) }),
          });
        },
        unsubscribe: (body) => {
          const b = body as { endpoint?: unknown };
          if (typeof b.endpoint !== 'string') throw new Error('endpoint required');
          return { removed: pushServiceRef?.unsubscribe(b.endpoint) ?? false };
        },
      },
    },
  });

  // Web Push (Phase 6). `web-push` is loaded lazily and the whole feature is
  // optional: a missing module or a bad key file costs push, never sessions.
  const pushService = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency, resolved at runtime
      const webpush = require('web-push') as typeof import('web-push');
      return createPushService({
        file: path.join(config.stateDir, 'push.json'),
        generateVapidKeys: () => webpush.generateVAPIDKeys(),
        subject: 'mailto:omnifex@localhost',
        send: async (sub, payload) => {
          const vapid = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'push.json'), 'utf8')).vapid as {
            publicKey: string; privateKey: string; subject: string;
          };
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: sub.keys },
              JSON.stringify(payload),
              { vapidDetails: vapid, TTL: 600 },
            );
            return { ok: true };
          } catch (err) {
            return { ok: false, statusCode: (err as { statusCode?: number }).statusCode };
          }
        },
        log: (m, meta) => log.info(`push: ${m}`, meta),
      });
    } catch (err) {
      log.warn('web push unavailable', { error: String(err) });
      return null;
    }
  })();

  pushServiceRef = pushService;

  const bridge = createSessionBridge({
    log: sessionLog,
    classify: classifyJsonlLine,
    publish: (push) => {
      server.pushToSession(push.sessionId, push);
      if (!pushService) return;
      const payload = pushPayloadFor(push, {
        watched: (id) => server.subscriberCount(id) > 0,
        sessionTitle: (id) => {
          const meta = sessionLog.meta(id);
          return meta?.title ?? path.basename(meta?.projectPath ?? '') ?? 'OmniFex';
        },
      });
      if (payload) {
        pushService.notify(payload).catch((err: unknown) => log.warn('push notify failed', { error: String(err) }));
      }
    },
    broadcast: (m) => server.broadcast(m),
  });
  const sendToRenderer = bridge.sendToRenderer;

  projects.onChange((list) => server.broadcast({ type: 'project.changed', projects: list }));

  // ---------------------------------------------------------------------------
  // The rest of the graph, in main.ts order
  // ---------------------------------------------------------------------------

  let brainRef: BrainService | undefined;
  let sessionsRef: ReturnType<typeof createSessionsService> | null = null;

  const captureSource = createCaptureSource({
    vaults: () =>
      accountsService
        .listAccounts()
        .map((a) => ({ accountId: a.id, root: brainRef?.vaultPath(a.id) ?? '' }))
        .filter((v) => v.root !== ''),
  });

  const internalArchive = internalArchiveRoot(config.userDataDir);
  const costBackfillOpts = { archiveRoot: internalArchive };
  const summaryQueryRunner = createSummaryQueryRunner({
    archiveRoot: internalArchive,
    resolveAccountName: (configDir) => accountsService.getAccountByConfigDir(configDir)?.name ?? null,
  });

  const brainService: BrainService | undefined = createBrainService(db, {
    accounts: accountsService,
    extractor: createExtractor({ runQuery: (o) => summaryQueryRunner({ ...o, kind: 'brain-index' }) }),
    curator: createCurator({ runQuery: (o) => summaryQueryRunner({ ...o, kind: 'brain-curation' }) }),
    sources: [
      createSessionSource({ accounts: accountsService }),
      captureSource,
      createAutoMemorySource({ accounts: accountsService }),
      createRepoArtifactSource({ accounts: accountsService }),
    ],
    liveSessionIds: () => sessionsRef?.listActiveSessionIds() ?? [],
    idleMs: () =>
      readNumericSetting(db.getSetting(BRAIN_IDLE_MINUTES_SETTING_KEY), DEFAULT_IDLE_MINUTES, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES) * 60_000,
    isQueuePaused: () => db.getSetting(BRAIN_QUEUE_PAUSED_SETTING_KEY) === 'true',
    onRunProgress: (run) => { sendToRenderer('brain-run-progress', run); },
  });
  brainRef = brainService;

  // `__dirname` is `.vite/build` for this bundle, beside brain-mcp.js. The
  // command is the app's executable, not this process's `omnifexd` stub: the
  // app registers the same server, and the two must agree on the path.
  const brainMcpEnv: BrainMcpEnvironment = {
    execPath: appExecPath(process.execPath),
    serverScript: path.join(__dirname, 'brain-mcp.js'),
    userDataDir: config.userDataDir,
  };

  const claudeBinaryService = createClaudeBinaryService(db);
  const claudeCliReviewService = createClaudeCliReviewService({
    cliVersionFn: () => probeCliVersion(claudeBinaryService.getPath() ?? claudeBinaryService.findBestBinary()),
    latestVersionFn: fetchLatestCliVersion,
    repoDirOverrideFn: () => db.getSetting(CLI_REVIEW_REPO_DIR_SETTING_KEY),
    repoCandidatesFn: async () => (await claudeService.listProjects()).map((p) => p.path),
    claudeAccountsFn: () =>
      accountsService.listAccounts().filter((a) => a.engine === 'claude').map((a) => ({ name: a.name, configDir: a.config_dir })),
    runUpdateFn: (configDir) => execCliUpdate(claudeBinaryService.getPath() ?? claudeBinaryService.findBestBinary(), configDir),
  });

  const loggingService = createLoggingService(db, {
    shouldAccept: (entry) => {
      if (entry.level !== 'info' && entry.level !== 'debug') return true;
      if (entry.source === 'claude-hooks') return db.getSetting('log_verbose_claude_hooks') === 'true';
      if (entry.source === 'usage-runner') return db.getSetting('log_verbose_usage_runner') === 'true';
      return true;
    },
    onError: (entry) => {
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

  // No display: OS notifications are the client's job. The bridge already
  // carries `claude-notification` events, which is what a client renders.
  const notificationsStub = { show() {}, dismissAll() {} };

  const permissionsIOService = createPermissionsIOService();
  const rateLimitsService = createRateLimitsService({
    db,
    accounts: accountsService,
    notifications: notificationsStub,
    sendToRenderer: (channel, payload) => sendToRenderer(channel, payload),
    logging: loggingService,
  });
  const usageRunnerService = createUsageRunnerService({
    accounts: accountsService,
    rateLimits: rateLimitsService,
    logging: loggingService,
    userDataDir: config.userDataDir,
  });

  let sessionsSummaryServiceRef: import('../services/sessions-summary').SessionsSummaryService | null = null;
  const modelsService = createModelsService(db);
  const commandsCatalogService = createCommandsCatalogService(db);

  const accountIdentityVerdict = (configDir: string): IdentityVerdict => {
    const account = accountsService.getAccountByConfigDir(configDir);
    const expected = account?.expected_email ?? null;
    const detected = account && expected ? (readOauthIdentity(configDir)?.email ?? null) : null;
    const status = classifyIdentity({ accountExists: !!account, expected, detected });
    if (status === 'unknown-account') {
      loggingService.writeBatch([{
        timestamp: new Date().toISOString(),
        level: 'warn',
        source: 'backend',
        category: 'account-identity',
        message: `identity check skipped: no account owns configDir=${configDir}`,
      }]);
    }
    return { status, expected, detected, configDir };
  };

  const sessionsService = createSessionsService(
    sendToRenderer,
    { showNotification: () => {}, incrementUnread: () => {} },
    loggingService,
    null,
    (params) =>
      permissionsIOService.updatePermission({
        scope: params.scope,
        action: 'add',
        behavior: params.behavior,
        rule: params.rule,
        configDir: params.configDir,
        projectPath: params.projectPath,
      }),
    (configDir, info) => rateLimitsService.recordEvent(configDir, info),
    (sessionId, projectPath, configDir) => {
      const enabled = db.getSetting(ENABLED_SETTING_KEY) === 'true';
      const autoOn = db.getSetting(AUTO_ON_CLOSE_SETTING_KEY) === 'true';
      if (enabled && autoOn) {
        sessionsSummaryServiceRef
          ?.generateSummary(sessionId, projectPath, configDir)
          .catch((err: unknown) => log.warn('auto-summarize on close failed', { error: String(err) }));
      }
      const autoIndexOn = db.getSetting(BRAIN_AUTO_INDEX_SETTING_KEY) === 'true';
      const curateOn = db.getSetting(BRAIN_CURATE_SETTING_KEY) === 'true';
      if (autoIndexOn || curateOn) {
        const account = accountsService.getAccountByConfigDir(configDir);
        if (account) {
          Promise.resolve()
            .then(() => (autoIndexOn ? brainService?.enqueueSource(account.id, sessionId) : undefined))
            .then(() => (autoIndexOn ? brainService?.enqueueProjectSources(account.id, projectPath) : undefined))
            .then(() => { if (curateOn) brainService?.enqueueCuration(account.id); })
            .then(() => brainService?.drainQueue())
            .catch((err: unknown) => log.warn('brain work on close failed', { error: String(err) }));
        }
      }
    },
    (projectPath: string) => accountsService.resolve(projectPath).claude?.account.config_dir ?? null,
    (configDir, models) => modelsService.upsertCatalog(configDir, models as ModelInfo[]),
    (configDir: string) => {
      const verdict = accountIdentityVerdict(configDir);
      if (verdict.status !== 'mismatch' && verdict.status !== 'signed-out') return null;
      return { expected: verdict.expected!, detected: verdict.detected, configDir, source: 'oauth-file' as const };
    },
    (configDir: string, observedEmail: string | null) => {
      if (observedEmail === null) return null;
      const account = accountsService.getAccountByConfigDir(configDir);
      const expected = account?.expected_email;
      const status = classifyIdentity({ accountExists: !!account, expected, detected: observedEmail });
      if (status !== 'mismatch') return null;
      return { expected: expected!, detected: observedEmail, configDir, source: 'session-init' as const };
    },
    (configDir: string) => {
      try {
        const account = accountsService.getAccountByConfigDir(configDir);
        if (!account) return [];
        const vaultRoot = brainService?.vaultPath(account.id);
        if (!vaultRoot) return [];
        return brainSpawnArgs(writeBrainSpawnConfig(account.id, vaultRoot, brainMcpEnv));
      } catch (err) {
        log.warn('brain MCP spawn args unavailable', { error: String(err) });
        return [];
      }
    },
  );
  sessionsRef = sessionsService;

  const claudeService = createClaudeService(db, accountsService);
  const usageService = createUsageService(accountsService, loggingService);
  const costHistoryService = createCostHistoryService(db);
  const modelPricingService = createModelPricingService(db);
  const sessionCostService = createSessionCostService({
    sendToRenderer,
    costHistory: costHistoryService,
    getOverrides: () => modelPricingService.toOverrides(),
  });

  const proxyService = createProxyService(db);
  const mcpService = createMCPService();
  const brainMcpRegistration = createBrainMcpRegistration(mcpService, brainMcpEnv);
  const slashCommandsService = createSlashCommandsService();

  const sessionsSummaryService = createSessionsSummaryService({
    jsonlPathFor: (sessionUuid, projectPath, configDir) => {
      const projectId = encodeProjectId(projectPath);
      const tryAt = (cfgDir: string): string | null => {
        const encoded = path.join(cfgDir, 'projects', projectId, `${sessionUuid}.jsonl`);
        if (fs.existsSync(encoded)) return encoded;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(path.join(cfgDir, 'projects'), { withFileTypes: true });
        } catch {
          return null;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = path.join(cfgDir, 'projects', entry.name, `${sessionUuid}.jsonl`);
          if (fs.existsSync(candidate)) return candidate;
        }
        return null;
      };
      if (configDir) {
        const found = tryAt(configDir);
        if (found) return found;
      }
      const seen = new Set<string>(configDir ? [configDir] : []);
      for (const acct of accountsService.listAccounts()) {
        if (seen.has(acct.config_dir)) continue;
        seen.add(acct.config_dir);
        const found = tryAt(acct.config_dir);
        if (found) return found;
      }
      const resolvedRoot = configDir ?? accountsService.resolve(projectPath).claude?.account.config_dir;
      if (!resolvedRoot) return null;
      return path.join(resolvedRoot, 'projects', projectId, `${sessionUuid}.jsonl`);
    },
    resolveAccount: (projectPath) => {
      const acct = accountsService.resolve(projectPath).claude?.account ?? null;
      return acct ? { name: acct.name, configDir: acct.config_dir, summaryModel: acct.summaryModel ?? null } : null;
    },
    runQuery: async (o) => (await summaryQueryRunner({ ...o, kind: 'session-summarization' })).result,
    onSummaryUpdated: (sessionUuid) => { sendToRenderer('session-summary:updated', { sessionUuid }); },
    onGenerationStateChanged: (sessionUuid, generating) => {
      sendToRenderer('session-summary:generating', { sessionUuid, generating });
    },
    getPromptTemplate: () => {
      const stored = db.getSetting(PROMPT_TEMPLATE_SETTING_KEY);
      return stored?.trim() || DEFAULT_SUMMARY_PROMPT;
    },
  });
  sessionsSummaryServiceRef = sessionsSummaryService;

  const sessionGitWatcher = createSessionGitWatcher({ sendToRenderer });
  const branchColorsService = createBranchColorsService(db);
  const limaService = createLimaService();
  const filesystemService = createFilesystemService();
  const codexSessionWalkerService = createCodexSessionWalker({
    listCodexAccounts: () => accountsService.listAccounts().filter((a) => a.engine === 'codex'),
  });

  // ---------------------------------------------------------------------------
  // Periodic work, shared verbatim with electron/main.ts
  // ---------------------------------------------------------------------------
  //
  // The daemon owns it outright and passes no `enabled` gate; main.ts closes
  // its own gate whenever a renderer is on this process. See
  // electron/periodic-work.ts for why running both at once costs real money.

  const timers: NodeJS.Timeout[] = [];
  const stopPeriodicWork = startPeriodicWork({
    db,
    listAccounts: () => accountsService.listAccounts(),
    costHistory: costHistoryService,
    costBackfillOpts,
    internalArchive,
    brain: () => brainRef,
    log,
  });

  // ---------------------------------------------------------------------------
  // The IPC handler map, reached through rpc.invoke
  // ---------------------------------------------------------------------------

  /* eslint-disable @typescript-eslint/no-explicit-any -- mirrors the adapter bag in main.ts */
  const handlerMap = getHandlerMap({
    database: db,
    modelPricing: {
      list: () => modelPricingService.list(),
      upsert: (input: any) => modelPricingService.upsert(input),
      remove: (id: number) => modelPricingService.remove(id),
      shipped: () => modelPricingService.shipped(),
    },
    brain: brainService,
    brainMcp: {
      isRegistered: (configDir) => brainMcpRegistration.isRegistered(configDir),
      register: (configDir, vaultRoot) => { brainMcpRegistration.register(configDir, vaultRoot); },
      unregister: (configDir) => { brainMcpRegistration.unregister(configDir); },
      configDirFor: (accountId) => accountsService.listAccounts().find((a) => a.id === accountId)?.config_dir ?? null,
    },
    allowRawSql: false,
    accounts: {
      list: () => accountsService.listAccounts(),
      create: (data: any) =>
        accountsService.createAccount({
          name: data.name,
          configDir: data.configDir ?? data.config_dir,
          engine: data.engine,
          subscriptionLabel: data.subscriptionLabel ?? data.subscription_label,
          hasCost: data.hasCost ?? data.has_cost,
          color: data.color,
          icon: data.icon,
          sessionDefaults: data.sessionDefaults ?? data.session_defaults,
          cliPath: data.cliPath ?? data.cli_path ?? null,
          expectedEmail: data.expectedEmail ?? data.expected_email ?? null,
        }),
      update: (_id: any, data: any) => {
        accountsService.updateAccount(data.id, {
          name: data.name,
          configDir: data.configDir ?? data.config_dir,
          subscriptionLabel: data.subscriptionLabel ?? data.subscription_label,
          hasCost: data.hasCost ?? data.has_cost,
          color: data.color,
          icon: data.icon,
          sessionDefaults:
            'sessionDefaults' in data || 'session_defaults' in data ? (data.sessionDefaults ?? data.session_defaults) : undefined,
          cliPath: data.cliPath ?? data.cli_path ?? null,
          expectedEmail:
            'expectedEmail' in data || 'expected_email' in data
              ? ((data.expectedEmail ?? data.expected_email ?? null) as string | null)
              : undefined,
        });
      },
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
      resolveForProject: (projectPath: string) => accountsService.resolve(projectPath),
      setProjectOverride: (projectPath: string, accountId: any) => accountsService.setProjectOverride(projectPath, accountId),
      listProjectOverrides: () => accountsService.listProjectOverrides(),
      discoverAccounts: () => accountsService.discoverAccounts(),
      scanForNewAccounts: () => accountsService.scanForNewAccounts(),
      explainResolution: (projectPath: string, engine?: string) => accountsService.explainResolution(projectPath, engine as never),
      knownConfigDirs: () => accountsService.listAccounts().map((a) => a.config_dir).filter(Boolean),
    },
    claude: {
      listProjects: () => claudeService.listProjects(),
      createProject: (data: any) => claudeService.createProject(data?.path ?? data),
      getProjectSessions: (projectId, projectPath) => claudeService.getProjectSessions(projectId, projectPath),
      loadSessionHistory: (sessionId, projectId, projectPath) => claudeService.loadSessionHistory(sessionId, projectId, projectPath),
      deleteSession: (sessionId, projectId, projectPath) => claudeService.deleteSession(sessionId, projectId, projectPath),
      deleteProject: (args) => claudeService.deleteProject(args),
      setProjectPinned: (args) => claudeService.setProjectPinned(args),
      getHomeDirectory: () => claudeService.getHomeDirectory(),
      getSettings: (o?: any) => claudeService.getClaudeSettings(o),
      getDefaultModel: (o?: any) => claudeService.getDefaultModel(o),
      saveSettings: (settings: any, o?: any) => claudeService.saveClaudeSettings(settings, o),
      getSystemPrompt: (o?: any) => claudeService.getSystemPrompt(o),
      saveSystemPrompt: (prompt: any, o?: any) => claudeService.saveSystemPrompt(typeof prompt === 'string' ? prompt : String(prompt ?? ''), o),
      checkVersion: () => claudeService.checkClaudeVersion(),
      findClaudeMdFiles: (projectPath) => claudeService.findClaudeMdFiles(projectPath),
      readClaudeMdFile: (filePath) => claudeService.readClaudeMdFile(filePath),
      saveClaudeMdFile: (filePath, content) => claudeService.saveClaudeMdFile(filePath, content),
      getHooksConfig: (scope, o?: any) => claudeService.getHooksConfig(scope as 'user' | 'project', o),
      updateHooksConfig: (scope, cfg: any, o?: any) => claudeService.updateHooksConfig(scope as 'user' | 'project', cfg, o),
      validateHookCommand: (command) => claudeService.validateHookCommand(command),
      getMergedHooksConfig: (projectPath, o?: any) => claudeService.getMergedHooksConfig(projectPath, o),
      getCliUsage: (configDir?: string) => claudeService.getCliUsage(configDir),
    },
    sessions: {
      start: (data: any) => sessionsService.start(data),
      rebind: () => true,
      sendMessage: (id, message: any) => sessionsService.sendMessage(id, typeof message === 'string' ? message : String(message ?? '')),
      sendStructuredMessage: (id, content: any) => sessionsService.sendStructuredMessage(id, content),
      respondPermission: (id, behavior, updatedInput, updatedPermissions?: any[]) =>
        sessionsService.respondPermission(id, behavior as 'allow' | 'deny', updatedInput, updatedPermissions),
      respondElicitation: (id, action, content) => sessionsService.respondElicitation(id, action as 'accept' | 'decline' | 'cancel', content),
      stop: (id) => sessionsService.stop(id),
      getInfo: (id) => sessionsService.getInfo(id),
      getHealth: (id) => sessionsService.getHealth(id),
      interrupt: (id) => sessionsService.interrupt(id),
      setModel: (id, model) => sessionsService.setModel(id, model),
      setPermissionMode: (id, mode) => sessionsService.setPermissionMode(id, mode as any),
      setEffort: (id, level) => sessionsService.setEffort(id, level as any),
      applyPermissions: (id, permissions) => sessionsService.applyPermissions(id, permissions as any),
      setThinking: (id, cfg) => sessionsService.setThinking(id, cfg as any),
      getAccountInfo: (id) => sessionsService.getAccountInfo(id),
      getContextUsage: (id) => sessionsService.getContextUsage(id),
      getSupportedCommands: (id) => sessionsService.getSupportedCommands(id),
      getSupportedModels: (id) => sessionsService.getSupportedModels(id),
      getMcpServerStatus: (id) => sessionsService.getMcpServerStatus(id),
      getPlugins: (id, force) => sessionsService.getPlugins(id, force),
      getSubagentMeta: (args) => readSubagentMeta(args),
      setMode: (id, mode) => sessionsService.setMode(id, mode),
      tuiWrite: (id, data) => sessionsService.tuiWrite(id, data),
      tuiResize: (id, cols, rows) => sessionsService.tuiResize(id, cols, rows),
      getMode: (id) => sessionsService.getMode(id),
    },
    cost: {
      get: (a) => sessionCostService.get(a),
      watch: (a) => sessionCostService.watch(a),
      unwatch: (id) => sessionCostService.unwatch(id),
      history: (f) => costHistoryService.aggregate(f as never, ((f.groupBy as string) ?? 'day') as 'day' | 'week' | 'month'),
      historyByModel: (f) => costHistoryService.aggregateByModel(f as never, ((f.groupBy as string) ?? 'day') as 'day' | 'week' | 'month'),
      sessions: (f) => costHistoryService.sessions(f as never),
      byProject: (f) => costHistoryService.byProject(f as never),
      byModel: (f) => costHistoryService.byModel(f as never),
      byProjectModel: (f) => costHistoryService.byProjectModel(f as never),
      components: (f) => costHistoryService.components(f as never),
      totals: (f) => costHistoryService.totals(f as never),
      cachingRoi: (f) => costHistoryService.cachingRoi(f as never),
      subagentSplit: (f) => costHistoryService.subagentSplit(f as never),
      unpriced: (f) => costHistoryService.unpriced(f as never),
      facets: (f) => costHistoryService.facets(f as never),
      rescan: () => costHistoryService.backfill(accountsService.listAccounts(), costBackfillOpts),
    },
    internalArchive: {
      stats: () => internalArchiveStats(internalArchive),
      clear: () => {
        clearInternalArchive(internalArchive);
        return internalArchiveStats(internalArchive);
      },
    },
    usage: {
      getStats: () => usageService.getUsageStats(),
      getByDateRange: (p: any) => usageService.getUsageByDateRange(p?.start_date ?? '', p?.end_date ?? ''),
      getSessionStats: (p?: any) => usageService.getSessionStats(p?.since, p?.until, p?.order),
      getDetails: (p?: any) => usageService.getUsageDetails(p?.limit),
      getStatsByAccount: (p?: any) => usageService.getStatsByAccount(p?.start_date, p?.end_date),
    },
    rateLimits: {
      getSnapshots: () => rateLimitsService.getSnapshots(),
      getSnapshotsByAccount: (name) => rateLimitsService.getSnapshotsByAccount(name),
      getSettings: () => rateLimitsService.getSettings(),
      updateSettings: (partial: any) => rateLimitsService.updateSettings(partial ?? {}),
    },
    usageRunner: {
      run: (name) => usageRunnerService.run(name),
      getLast: (name) => usageRunnerService.getLast(name),
    },
    claudeBinary: {
      getPath: () => claudeBinaryService.getPath(),
      setPath: (p) => claudeBinaryService.setPath(p),
      listInstallations: () => claudeBinaryService.listInstallations(),
      reviewStatus: () => claudeCliReviewService.getStatus(),
      runUpdate: () => claudeCliReviewService.runUpdate(),
    },
    mcp: {
      add: (data: any) => mcpService.add(data),
      list: (configDir) => mcpService.list(configDir),
      get: (name, configDir) => mcpService.get(name, configDir),
      remove: (name, configDir) => mcpService.remove(name, configDir),
      addJson: (data: any) => mcpService.addJson(data),
      addFromClaudeDesktop: (scope, configDir) => mcpService.addFromClaudeDesktop(scope, configDir),
      serve: () => mcpService.serve(),
      testConnection: (name, configDir) => mcpService.testConnection(name, configDir),
      resetProjectChoices: () => mcpService.resetProjectChoices(),
      getServerStatus: (configDir) => mcpService.getServerStatus(configDir),
      readProjectConfig: (projectPath) => mcpService.readProjectConfig(projectPath),
      saveProjectConfig: (projectPath, cfg: any) => mcpService.saveProjectConfig(projectPath, cfg),
    },
    slashCommands: {
      list: (projectPath, configDir) => slashCommandsService.list(projectPath, configDir),
      get: (commandId, configDir) => slashCommandsService.get(commandId, configDir),
      save: (data: any) => slashCommandsService.save(data),
      delete: (commandId, projectPath, configDir) => slashCommandsService.delete(commandId, projectPath, configDir),
    },
    sessionsSummary: sessionsSummaryService,
    logging: {
      writeBatch: (entries: any) => loggingService.writeBatch(entries),
      query: (p: any) => loggingService.query(p),
      count: (p: any) => loggingService.count(p ?? {}),
      prune: (olderThan) => loggingService.prune(olderThan),
    },
    proxy: {
      getSettings: () => proxyService.getSettings(),
      saveSettings: (data: any) => proxyService.saveSettings(data),
    },
    permissionsIO: permissionsIOService,
    models: { listSupported: (configDir) => modelsService.getCatalog(configDir) },
    commands: { listSupported: (configDir) => commandsCatalogService.getCatalog(configDir) },
    gitWatcher: {
      listWorktrees: (projectPath) => listWorktrees(projectPath),
      startSession: (projectPath) => sessionGitWatcher.start(projectPath),
      reconnectSession: (watchId) => sessionGitWatcher.reconnect(watchId),
      stopSession: (watchId) => sessionGitWatcher.stop(watchId),
    },
    branchColors: branchColorsService,
    gitBranches: { list: listGitBranches },
    lima: {
      isInstalled: () => limaService.isInstalled(),
      listVms: () => limaService.listVms(),
      listContainers: (vm) => limaService.listContainers(vm),
      startVm: (vm) => limaService.startVm(vm),
      stopVm: (vm) => limaService.stopVm(vm),
      startContainer: (vm, id) => limaService.startContainer(vm, id),
      stopContainer: (vm, id) => limaService.stopContainer(vm, id),
    },
    filesystem: filesystemService,
    codexSessionWalker: { listSessions: () => codexSessionWalkerService.listSessions() },
    accountIdentity: {
      read: (configDir) => readOauthIdentity(configDir),
      probe: (configDir) => probeAuthStatus(configDir, { resolveBinary: () => claudeBinaryService.getPath() }),
      verdict: (configDir) => accountIdentityVerdict(configDir),
    },
  }) as Record<string, RpcHandler>;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // ---------------------------------------------------------------------------
  // Handlers, permission timeout, listen
  // ---------------------------------------------------------------------------

  const handlers = createRemoteHandlers({
    sessions: sessionsService,
    log: sessionLog,
    bridge,
    projects,
    rpc: {
      handlers: handlerMap,
      allow: buildRpcAllowlist(INVOKE_CHANNELS, { allow: config.rpcAllow, deny: config.rpcDeny }),
    },
    daemonVersion: opts.version,
    capabilities: { tui: true, rpcInvoke: true, attachments: 'base64' },
  });
  handlersRef = handlers;
  server.register(handlers);

  // Default is NEVER: an unanswered permission waits for the user, however
  // long that takes. A timeout is opt-in and always a deny.
  const permissionTimers = new Map<string, NodeJS.Timeout>();
  if (config.permissionTimeoutMs !== null) {
    const timeoutMs = config.permissionTimeoutMs;
    const origPublish = bridge.sendToRenderer;
    void origPublish;
    // Watch pushes as they leave the log: a permission.request starts a
    // clock; the handler clearing it (permissionAnswered) stops it.
    const pollPending = setInterval(() => {
      for (const meta of sessionLog.list()) {
        for (const permissionId of bridge.pendingPermissions(meta.sessionId)) {
          const key = `${meta.sessionId}:${permissionId}`;
          if (permissionTimers.has(key)) continue;
          permissionTimers.set(
            key,
            setTimeout(() => {
              permissionTimers.delete(key);
              if (!bridge.pendingPermissions(meta.sessionId).includes(permissionId)) return;
              log.warn('permission timed out → deny', { sessionId: meta.sessionId, permissionId, timeoutMs });
              if (sessionsService.respondPermission(meta.sessionId, 'deny', undefined, undefined, permissionId)) {
                bridge.permissionAnswered(meta.sessionId, permissionId);
              }
            }, timeoutMs),
          );
        }
      }
    }, 1000);
    timers.push(pollPending);
  }

  const address = await server.listen();
  log.info('omnifex-server ready', { version: opts.version, ...address, stateDir: config.stateDir, userDataDir: config.userDataDir });

  return {
    address,
    async close() {
      stopPeriodicWork();
      for (const t of timers) clearInterval(t);
      for (const t of permissionTimers.values()) clearTimeout(t);
      await server.close();
      try {
        sessionsService.stopAll();
      } catch (err) {
        log.warn('stopAll failed', { error: String(err) });
      }
      try {
        db.close();
      } catch (err) {
        log.warn('db close failed', { error: String(err) });
      }
    },
  };
}
