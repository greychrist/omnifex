/**
 * The OmniFex daemon — the composition root.
 *
 * Every service OmniFex has is built here, once, and fronted with the
 * protocol server: the session layer, the database, the accounts, the Brain,
 * the cost ledger, the sign-in pty, the identity watchers. `sendToRenderer`
 * is the session bridge, and `rpc.invoke` reaches the handler map behind an
 * allowlist. The macOS app is a client like the iPad is; what it serves
 * itself (windows, Finder, notifications) is in `src/lib/remote/nativeChannels.ts`.
 *
 * Until 2026-10-23 Electron main built this same graph a second time, and the
 * "change both or neither" rule that came with it was a standing hazard —
 * a service added to one root and not the other worked on the desktop and
 * silently degraded over the wire. With Electron gone this is the only root.
 *
 * Runs on Node 26: the app's bundled `omnifexd`, or a checkout's `node`.
 */
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import type { Services } from '../ipc/handlers';

import { startPeriodicWork } from '../periodic-work';
import { isDevDaemon, periodicWorkGate } from './dev-instance';
import { createLoggingOptions } from '../logging-options';
import { createSessionCloseWork } from '../session-close-work';
import { createSessionJsonlPathResolver } from '../session-jsonl-path';
import { createDatabase, ensureDefaultSettings } from '../services/database';
import { createAccountsService } from '../services/accounts';
import { createClaudeBinaryService } from '../services/claude-binary';
import {
  createClaudeCliReviewService,
  execCliUpdate,
  fetchLatestCliVersion,
  probeCliVersion,
  CLI_REVIEW_REPO_DIR_SETTING_KEY,
  CLI_AUTO_UPDATE_SETTING_KEY,
  CLI_CHECKED_VERSION_SETTING_KEY,
} from '../services/claude-cli-review';
import { runFirstTimeDiscovery } from '../services/first-run-discovery';
import { createOneShotTerminalService } from '../services/one-shot-terminal';
import { createClaudeAuthService } from '../services/auth/claude-auth';
import { createCodexAuthService } from '../services/auth/codex-auth';
import { createSessionsService } from '../services/sessions';
import { createClaudeService } from '../services/claude';
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
  createAccountIdentityVerdict,
  watchOauthIdentity,
} from '../services/account-identity';
import {
  createSessionsSummaryService,
  DEFAULT_SUMMARY_PROMPT,
  PROMPT_TEMPLATE_SETTING_KEY,
  AUTO_ON_CLOSE_SETTING_KEY,
  ENABLED_SETTING_KEY,
} from '../services/sessions-summary';
import { createSummaryQueryRunner } from '../services/sessions/summary-query';
import { readSubagentMeta } from '../services/sessions/subagent-meta';
import { toElicitationAction } from '../services/sessions/elicitations';
import { createPermissionsIOService } from '../services/permissions-io';
import { createSessionGitWatcher, listWorktrees } from '../services/git-watcher';
import { createBranchColorsService } from '../services/branch-colors';
import { listBranches as listGitBranches } from '../services/git-branches';
import { listChangedFiles as listGitChangedFiles, readFileDiff as readGitFileDiff } from '../services/git-diff';
import { createLimaService } from '../services/lima';
import { createCostHistoryService } from '../services/cost/cost-history';
import { createCliProcessUsageStore } from '../services/cost/cli-process-usage';
import { readAutoRecapPolicy } from '../services/sessions/auto-recap';
import { createBundledModPluginDirs } from '../services/bundled-mod';
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
  refreshBrainRegistrations,
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

import { detectTailscaleIp, extraListenHosts, type NetworkInterfaces, type ServerConfig } from './config';
import { createTailnetWatch } from './tailnet-watch';
import { createAccountWatchers } from './account-watchers';
import { createSessionLog } from './session-log';
import { createSessionBridge } from './bridge';
import type { SessionScopedPush } from '../../src/protocol';
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
  /** Absolute path of the daemon bundle this process is running. The Electron
   *  launcher compares it before retiring a daemon: a dev build must not kill
   *  the installed app's daemon (and its live sessions). See remote-launcher.ts. */
  script?: string;
  log: RemoteServerLogger;
}

export interface RunningDaemon {
  address: { host: string; port: number };
  /** What the dev instance's idle watch reads: who is attached, what is
   *  running, and whether anyone ever attached at all. */
  status(): { clients: number; inFlight: number; everConnected: boolean };
  close(): Promise<void>;
}

/**
 * launchd and Finder both start processes with a minimal PATH. Re-derive it
 * from the login shell so `claude` (nvm, homebrew, ~/.local/bin) resolves.
 */
export function fixPath(log: RemoteServerLogger): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'echo "__PATH__=$PATH"'], {
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

  fs.mkdirSync(config.sessionsDir, { recursive: true });
  fs.mkdirSync(config.userDataDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // Database + the services everything else is built on
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

  // Fail loudly before building anything on top: a daemon that came up without
  // the CLI would accept sessions and error on every one of them. Resolved
  // after the database opens so the binary picked in Settings counts — every
  // spawn below goes through the same findBestBinary().
  const claudeBinaryService = createClaudeBinaryService(db);
  const claudeBinary = claudeBinaryService.findBestBinary();
  if (!claudeBinary) {
    throw new Error(
      '`claude` was not found — not in Settings, on PATH, or in any standard install location. ' +
        'The daemon runs sessions through the Claude CLI and cannot start without it. ' +
        `PATH=${process.env.PATH ?? '(unset)'}`,
    );
  }
  log.info('claude binary', { path: claudeBinary });
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
    extraHosts: extraListenHosts(config.host),
    port: config.port,
    daemonVersion: opts.version,
    capabilities: { rpcInvoke: true, attachments: 'base64', web: webRoot !== null, push: true },
    webRoot,
    log,
    api: {
      health: () => ({
        ok: true,
        version: opts.version,
        build: opts.build,
        script: opts.script,
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

  // Closed for the dev daemon, absent for the real one: see dev-instance.ts.
  const periodicGate = periodicWorkGate(process.env);

  // Set once the logging service exists, below. Events are memory-only, so
  // state transitions go to app_logs: the trail session-trace reads.
  let traceState: ((push: Extract<SessionScopedPush, { type: 'session.state' }>) => void) | null = null;

  const bridge = createSessionBridge({
    log: sessionLog,
    classify: classifyJsonlLine,
    onState: (push) => traceState?.(push),
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
  // The rest of the graph
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

  const costHistoryService = createCostHistoryService(db);
  const summaryQueryRunner = createSummaryQueryRunner({
    recordSpend: costHistoryService.recordInternal,
    resolveClaudeBinary: () => claudeBinaryService.findBestBinary(),
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

  // `__dirname` is this bundle's build dir, beside brain-mcp.js, and the
  // server runs on the same node this daemon does.
  const brainMcpEnv: BrainMcpEnvironment = {
    execPath: process.execPath,
    serverScript: path.join(__dirname, 'brain-mcp.js'),
    userDataDir: config.userDataDir,
  };

  const claudeCliReviewService = createClaudeCliReviewService({
    cliVersionFn: () => probeCliVersion(claudeBinaryService.findBestBinary()),
    latestVersionFn: fetchLatestCliVersion,
    repoDirOverrideFn: () => db.getSetting(CLI_REVIEW_REPO_DIR_SETTING_KEY),
    checkedVersionFn: () => db.getSetting(CLI_CHECKED_VERSION_SETTING_KEY),
    repoCandidatesFn: async () => (await claudeService.listProjects()).map((p) => p.path),
    claudeAccountsFn: () =>
      accountsService.listAccounts().filter((a) => a.engine === 'claude').map((a) => ({ name: a.name, configDir: a.config_dir })),
    runUpdateFn: (configDir) => execCliUpdate(claudeBinaryService.findBestBinary(), configDir),
  });

  const loggingService = createLoggingService(db, createLoggingOptions({ db, sendToRenderer }));
  traceState = (push) => {
    loggingService.writeBatch([{
      timestamp: new Date().toISOString(),
      level: 'info',
      source: 'backend',
      category: 'session-state',
      message: `session ${push.sessionId} ${push.sessionStatus} turn=${push.turn.status}`,
      metadata: JSON.stringify({ sessionId: push.sessionId, seq: push.seq, sessionStatus: push.sessionStatus, turn: push.turn, ...(push.error !== undefined && { error: push.error }) }),
    }]);
  };

  // No display: OS notifications are the clients' job. A session's own
  // notifications ride its events; this is for the rest (a rate-limit
  // threshold), broadcast to every client as a `claude-notification` with no
  // tab — the app on the Mac raises the banner, a browser its own.
  const notifyClients = {
    show(title: string, body: string, isError: boolean) {
      sendToRenderer('claude-notification', { title, body, is_error: isError });
    },
  };

  const permissionsIOService = createPermissionsIOService();
  const rateLimitsService = createRateLimitsService({
    db,
    accounts: accountsService,
    notifications: notifyClients,
    sendToRenderer: (channel, payload) => sendToRenderer(channel, payload),
    logging: loggingService,
  });
  const usageRunnerService = createUsageRunnerService({
    accounts: accountsService,
    rateLimits: rateLimitsService,
    logging: loggingService,
    findClaudeBinary: () => claudeBinaryService.findBestBinary(),
    userDataDir: config.userDataDir,
  });

  let sessionsSummaryServiceRef: import('../services/sessions-summary').SessionsSummaryService | null = null;
  const modelsService = createModelsService(db, { resolveClaudeBinary: () => claudeBinaryService.findBestBinary() });
  const commandsCatalogService = createCommandsCatalogService(db, { resolveClaudeBinary: () => claudeBinaryService.findBestBinary() });

  const accountIdentityVerdict = createAccountIdentityVerdict({
    accounts: accountsService,
    log: loggingService,
  });

  const sessionsService = createSessionsService(
    sendToRenderer,
    loggingService,
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
    createSessionCloseWork({
      db,
      accounts: accountsService,
      brain: () => brainService,
      summary: () => sessionsSummaryServiceRef,
      warn: (message, meta) => { log.warn(message, meta); },
      // Same gate as the periodic work below: the dev daemon shares the
      // database, and a second worker on the Brain queue pays twice.
      ...(periodicGate ? { drainEnabled: periodicGate } : {}),
    }),
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
    () => claudeBinaryService.findBestBinary(),
    // The CLI's own running token totals — the spend no transcript records
    // (side questions, title generation). Same recorder as main's.
    createCliProcessUsageStore(db).record,
    () => readAutoRecapPolicy((key) => db.getSetting(key)),
    // The bundled mod (agent step progress), installed under this instance's
    // state dir. Same closure as main's.
    createBundledModPluginDirs({
      getSetting: (key) => db.getSetting(key),
      bundleDir: __dirname,
      stateDir: config.stateDir,
    }),
  );
  sessionsRef = sessionsService;

  const claudeService = createClaudeService(db, accountsService);
  const usageService = createUsageService(accountsService, loggingService);
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
    jsonlPathFor: createSessionJsonlPathResolver({
      listAccounts: () => accountsService.listAccounts(),
      resolveConfigDir: (projectPath) =>
        accountsService.resolve(projectPath).claude?.account.config_dir ?? null,
    }),
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

  // The one-shot pty behind `claude auth login` and `codex login`. Its output
  // is broadcast — `one-shot-terminal-data:<handle>` names no session — and
  // the sign-in modal that spawned it is the one listening for that handle.
  // Subscriptions last until the pty exits or the client kills it; the
  // service tears down its own subscribers on exit.
  const oneShotTerminalService = createOneShotTerminalService();
  const spawnOneShotTerminal = (
    spawnOpts: Parameters<typeof oneShotTerminalService.spawn>[0],
  ): { ptyHandle: string } => {
    const handle = oneShotTerminalService.spawn(spawnOpts);
    oneShotTerminalService.onData(handle.ptyHandle, (data) => {
      sendToRenderer(`one-shot-terminal-data:${handle.ptyHandle}`, data);
    });
    oneShotTerminalService.onExit(handle.ptyHandle, (info) => {
      sendToRenderer(`one-shot-terminal-exit:${handle.ptyHandle}`, info);
    });
    return handle;
  };
  const codexAuthService = createCodexAuthService({ oneShotTerminal: oneShotTerminalService });
  const claudeAuthService = createClaudeAuthService({
    spawnTerminal: spawnOneShotTerminal,
    resolveBinary: () => claudeBinaryService.findBestBinary(),
  });

  // Sign-in state that changes outside OmniFex (a terminal login/logout)
  // reaches every client. Re-synced after every account mutation below.
  const accountWatchers = createAccountWatchers({
    listAccounts: () => accountsService.listAccounts(),
    watchCodexAuth: (dir, onChange) => codexAuthService.watch(dir, onChange),
    watchClaudeIdentity: (dir, onChange) => watchOauthIdentity(dir, onChange),
    onCodexAuthChanged: (configDir, status) => {
      sendToRenderer('codex-auth-status-changed', { configDir, status });
    },
    onIdentityChanged: (configDir) => {
      sendToRenderer('account-identity-changed', { configDir, verdict: accountIdentityVerdict(configDir) });
    },
  });
  accountWatchers.sync();

  // First launch: create one account per `.claude*` dir in $HOME, so the
  // picker is not empty when the first project opens. Resolution still needs
  // an explicit choice; this only populates the list. One-and-done via the
  // `discovery_completed` flag; Settings has a manual rescan for later.
  void runFirstTimeDiscovery({
    accounts: accountsService,
    db,
    discover: () => accountsService.discoverAccounts(),
    readIdentity: readOauthIdentity,
  })
    .then(() => { accountWatchers.sync(); })
    .catch((err: unknown) => { log.warn('first-run discovery failed', { error: String(err) }); });

  // Persistent Brain registrations name a path in `.claude.json` that the
  // build which wrote it chose. Rewrite the ones that exist so they name this
  // one — an update that moved the server would otherwise strand them.
  refreshBrainRegistrations(
    brainMcpRegistration,
    accountsService.listAccounts().map((a) => ({
      configDir: a.config_dir,
      vaultRoot: brainService?.vaultPath(a.id) ?? null,
    })),
    (message) => { log.warn(message); },
  );

  // Opt-in: the auto-update a terminal user of the CLI gets for free lives in
  // its Ink REPL, which headless sessions never render. Unawaited — it
  // downloads ~200MB and is auxiliary work that must never delay startup —
  // and gated on an upgrade actually being available, so a start with none
  // costs one dist-tags fetch rather than a `claude update` per account.
  if (db.getSetting(CLI_AUTO_UPDATE_SETTING_KEY) === 'true') {
    void (async () => {
      const status = await claudeCliReviewService.getStatus();
      if (!status.upgrade_available) return;
      const result = await claudeCliReviewService.runUpdate();
      log.info('cli auto-update', { from: result.from, to: result.to, accounts: result.accounts });
    })().catch((err: unknown) => { log.warn('cli auto-update failed', { error: String(err) }); });
  }

  // ---------------------------------------------------------------------------
  // Periodic work
  // ---------------------------------------------------------------------------
  //
  // The real daemon owns it outright and passes no `enabled` gate. The dev
  // instance's daemon shares the database with it and so must not sweep —
  // see electron/periodic-work.ts for why two sweepers cost real money.

  const timers: NodeJS.Timeout[] = [];
  const stopPeriodicWork = startPeriodicWork({
    ...(periodicGate ? { enabled: periodicGate } : {}),
    db,
    listAccounts: () => accountsService.listAccounts(),
    costHistory: costHistoryService,
    brain: () => brainRef,
    summary: () => sessionsSummaryServiceRef,
    activeSessionIds: () => sessionsService.listActiveSessionIds(),
    log,
  });

  // ---------------------------------------------------------------------------
  // The IPC handler map, reached through rpc.invoke
  // ---------------------------------------------------------------------------

  /* eslint-disable @typescript-eslint/no-explicit-any -- the handler interface is loosely typed at the IPC edge */
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
    // The dev daemon only, and even there `rpcAllow` must name the channel:
    // the rpc allowlist denies raw SQL by default.
    allowRawSql: isDevDaemon(process.env),
    accounts: {
      list: () => accountsService.listAccounts(),
      create: (data: any) => {
        const acct = accountsService.createAccount({
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
        });
        accountWatchers.sync();
        return acct;
      },
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
        accountWatchers.sync();
      },
      updateSummarySettings: (data: any) =>
        accountsService.updateSummarySettings(
          data.id,
          !!(data.summarizeOnClose ?? data.summarize_on_close),
          (data.summaryModel ?? data.summary_model ?? null) as string | null,
        ),
      delete: (id: any) => {
        accountsService.deleteAccount(id);
        accountWatchers.sync();
      },
      listPathRules: () => accountsService.listPathRules(),
      addPathRule: (rule: any) =>
        accountsService.addPathRule(rule.accountId ?? rule.account_id, rule.pathPrefix ?? rule.path_prefix, rule.priority),
      removePathRule: (id: any) => accountsService.removePathRule(id),
      resolveForProject: (projectPath: string) => accountsService.resolve(projectPath),
      setProjectOverride: (projectPath: string, accountId: any) => accountsService.setProjectOverride(projectPath, accountId),
      listProjectOverrides: () => accountsService.listProjectOverrides(),
      discoverAccounts: () => accountsService.discoverAccounts(),
      scanForNewAccounts: async () => {
        const created = await accountsService.scanForNewAccounts();
        accountWatchers.sync();
        return created;
      },
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
      readClaudeMdFile: (filePath) => claudeService.readClaudeMdFile(filePath),
      saveClaudeMdFile: (filePath, content) => claudeService.saveClaudeMdFile(filePath, content),
      getHooksConfig: (scope, o?: any) => claudeService.getHooksConfig(scope as 'user' | 'project', o),
      updateHooksConfig: (scope, cfg: any, o?: any) => claudeService.updateHooksConfig(scope as 'user' | 'project', cfg, o),
      validateHookCommand: (command) => claudeService.validateHookCommand(command),
      getMergedHooksConfig: (projectPath, o?: any) => claudeService.getMergedHooksConfig(projectPath, o),
      getCliUsage: (configDir?: string) => claudeService.getCliUsage(configDir),
    },
    sessions: {
      respondElicitation: (id, action, content, requestId) => sessionsService.respondElicitation(id, toElicitationAction(action), content, requestId),
      getInfo: (id) => sessionsService.getInfo(id),
      getHealth: (id) => sessionsService.getHealth(id),
      setModel: (id, model) => sessionsService.setModel(id, model),
      setTitle: (id, title) => sessionsService.setTitle(id, title),
      askSideQuestion: (id, question) => sessionsService.askSideQuestion(id, question),
      closeSideChat: (id) => { sessionsService.closeSideChat(id); },
      getSideChat: (id) => sessionsService.getSideChat(id),
      suggestTitle: (id, description) => sessionsService.suggestTitle(id, description),
      setPermissionMode: (id, mode) => sessionsService.setPermissionMode(id, mode as any),
      setEffort: (id, level) => sessionsService.setEffort(id, level as any),
      applyPermissions: (id, permissions) => sessionsService.applyPermissions(id, permissions as any),
      getAccountInfo: (id) => sessionsService.getAccountInfo(id),
      getContextUsage: (id) => sessionsService.getContextUsage(id),
      getTaskOutput: (id, taskId) => sessionsService.getTaskOutput(id, taskId),
      getCliStatus: (id) => sessionsService.getCliStatus(id),
      listPermissionRules: (id) => sessionsService.listPermissionRules(id),
      getSupportedCommands: (id) => sessionsService.getSupportedCommands(id),
      getSupportedModels: (id) => sessionsService.getSupportedModels(id),
      getMcpServerStatus: (id) => sessionsService.getMcpServerStatus(id),
      mcpAuthenticate: (id, serverName) => sessionsService.mcpAuthenticate(id, serverName),
      mcpReauthenticate: (id, serverName) => sessionsService.mcpReauthenticate(id, serverName),
      mcpSetEnabled: (id, serverName, enabled) => sessionsService.mcpSetEnabled(id, serverName, enabled),
      getPlugins: (id, force) => sessionsService.getPlugins(id, force),
      getSubagentMeta: (args) => readSubagentMeta(args),
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
      rescan: () => costHistoryService.backfill(accountsService.listAccounts()),
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
      startSession: (projectPath, holder) => sessionGitWatcher.start(projectPath, holder),
      reconnectSession: (watchId, holder) => sessionGitWatcher.reconnect(watchId, holder),
      stopSession: (watchId) => sessionGitWatcher.stop(watchId),
      setSessionVisible: (watchId, visible, holder) => { sessionGitWatcher.setVisible(watchId, visible, holder); },
    },
    branchColors: branchColorsService,
    gitBranches: { list: listGitBranches },
    gitDiff: {
      listChangedFiles: listGitChangedFiles,
      readFileDiff: readGitFileDiff,
    },
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
    oneShotTerminal: {
      spawn: spawnOneShotTerminal,
      write: (ptyHandle, data) => oneShotTerminalService.write(ptyHandle, data),
      resize: (ptyHandle, cols, rows) => oneShotTerminalService.resize(ptyHandle, cols, rows),
      kill: (ptyHandle) => oneShotTerminalService.kill(ptyHandle),
    },
    codexAuth: {
      getStatus: (configDir) => codexAuthService.getStatus(configDir),
      startLoginFlow: (o) => codexAuthService.startLoginFlow(o),
      cancelLoginFlow: (ptyHandle) => codexAuthService.cancelLoginFlow(ptyHandle),
      getBinaryPath: () => codexAuthService.getBinaryPath(),
      logout: (configDir) => codexAuthService.logout(configDir),
    },
    claudeAuth: claudeAuthService,
    codexSessionWalker: { listSessions: () => codexSessionWalkerService.listSessions() },
    accountIdentity: {
      read: (configDir) => readOauthIdentity(configDir),
      probe: (configDir) => probeAuthStatus(configDir, { resolveBinary: () => claudeBinaryService.findBestBinary() }),
      verdict: (configDir) => accountIdentityVerdict(configDir),
    },
  } satisfies Required<Services>) as Record<string, RpcHandler>;
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
    capabilities: { rpcInvoke: true, attachments: 'base64' },
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

  // Started before Tailscale was up: serve the tailnet address once it is.
  if (config.hostIsFallback) {
    const tailnet = createTailnetWatch({
      detect: () => detectTailscaleIp(networkInterfaces() as NetworkInterfaces),
      listening: () => server.hosts,
      addHost: (host) => server.addHost(host),
      log,
    });
    const tailnetTimer = setInterval(() => void tailnet.check(), 30_000);
    tailnetTimer.unref();
    timers.push(tailnetTimer);
  }

  return {
    address,
    status: () => ({
      clients: server.clients.length,
      inFlight: (handlersRef?.summaries() ?? []).filter((s) => s.inFlight).length,
      everConnected: server.connectionsSeen > 0,
    }),
    async close() {
      stopPeriodicWork();
      accountWatchers.disposeAll();
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
