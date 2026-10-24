/**
 * ClaudeAuthService — sign a Claude account in or out from inside OmniFex.
 *
 * Sign-in drives the CLI's own OAuth through stream-json control requests
 * (`claude_authenticate`, then `claude_oauth_callback` or
 * `claude_oauth_wait_for_completion`) in a short-lived CLI process started for
 * that account's config dir — the same requests the Agent SDK exposes as
 * `claudeAuthenticate()` & co. It replaced `claude auth login` in a one-shot
 * pty (2026-10-24): the terminal opened the default browser itself, so the
 * link could not go to the browser the account is signed in with, and on the
 * iPad there was no browser to open. Verified against 2.1.310 with an empty
 * config dir: one process, no `initialize` needed first, both URLs returned.
 *
 *   automaticUrl  redirects to the CLI's localhost listener — finishes by
 *                 itself when the browser is on the daemon's machine.
 *   manualUrl     shows a `CODE#STATE` string to paste — works anywhere.
 *
 * Logout still drives `claude auth logout`. Credentials are never touched
 * directly: on macOS the tokens live in the Keychain, and the CLI is the only
 * thing that knows where. Logout also drops `oauthAccount` from
 * `.claude.json` (verified on 2.1.280), which is what `watchOauthIdentity`
 * keys on — so the verification badges update through the existing watcher,
 * with no broadcast from here. Sign-in writes it the same way.
 *
 * Every config dir goes through `buildClaudeEnv`, which refuses an empty one
 * rather than letting the CLI fall back to `~/.claude`.
 */

import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildClaudeEnv } from '../util/claude-env';

/** What the CLI reports once a sign-in completes. */
export interface SignedInAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

export interface SignInFlow {
  flowId: string;
  /** Shows a code to paste back — works from any device. */
  manualUrl: string;
  /** Redirects to the CLI on this machine and finishes by itself. */
  automaticUrl: string;
}

export interface ClaudeAuthService {
  /** Start a sign-in for this account. Replaces one already in progress for it. */
  beginSignIn(configDir: string): Promise<SignInFlow>;
  /** Finish with the code the manual page showed (`CODE#STATE`, or the bare code).
   *  A rejected code leaves the flow open for another try. */
  submitCode(flowId: string, pasted: string): Promise<SignedInAccount>;
  /** Resolve when the browser finishes on the localhost callback. */
  waitForCompletion(flowId: string): Promise<SignedInAccount>;
  /** Abandon a sign-in; a pending wait rejects. */
  cancel(flowId: string): Promise<void>;
  /** Run `claude auth logout` for this account. Rejects with the CLI's stderr. */
  logout(configDir: string): Promise<void>;
}

/** The slice of the CLI engine a sign-in needs. */
export interface SignInEngine {
  start(params: { projectPath: string; configDir: string; sessionId: string; resume: boolean }): Promise<void>;
  sendControlRequest<T = unknown>(
    subtype: string,
    payload?: Record<string, unknown>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  close(): Promise<void>;
}

export interface CreateClaudeAuthServiceDeps {
  resolveBinary(): string | null;
  /** A stream-json CLI engine on this binary (createClaudeCliEngine in the daemon). */
  createEngine(binary: string): SignInEngine;
  /** Injectable for tests. Defaults to execFile with a 30s timeout. */
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
}

/** How long a sign-in may sit unfinished before its CLI is closed. */
const FLOW_TTL_MS = 15 * 60_000;
const BEGIN_TIMEOUT_MS = 30_000;
const CODE_TIMEOUT_MS = 60_000;

interface Flow {
  id: string;
  configDir: string;
  engine: SignInEngine;
  state: string | null;
  abort: AbortController;
  expiry: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

function defaultExec(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function stateOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get('state');
  } catch {
    return null;
  }
}

function accountOf(res: unknown): SignedInAccount {
  const a = (res as { account?: Record<string, unknown> } | undefined)?.account ?? {};
  const out: SignedInAccount = {};
  if (typeof a.email === 'string') out.email = a.email;
  if (typeof a.organization === 'string') out.organization = a.organization;
  if (typeof a.subscriptionType === 'string') out.subscriptionType = a.subscriptionType;
  return out;
}

export function createClaudeAuthService(deps: CreateClaudeAuthServiceDeps): ClaudeAuthService {
  const exec = deps.exec ?? defaultExec;
  const flows = new Map<string, Flow>();
  const byConfigDir = new Map<string, string>();

  function requireBinary(): string {
    const bin = deps.resolveBinary();
    if (!bin) throw new Error('claude binary not found. Install Claude Code or set its path in OmniFex settings.');
    return bin;
  }

  function requireFlow(flowId: string): Flow {
    const flow = flows.get(flowId);
    if (!flow) throw new Error('No sign-in in progress — start again.');
    return flow;
  }

  async function end(flow: Flow, cancelled: boolean): Promise<void> {
    if (!flows.has(flow.id)) return;
    flows.delete(flow.id);
    if (byConfigDir.get(flow.configDir) === flow.id) byConfigDir.delete(flow.configDir);
    clearTimeout(flow.expiry);
    flow.cancelled = cancelled;
    if (cancelled) flow.abort.abort();
    try { await flow.engine.close(); } catch { /* best effort */ }
  }

  /** Await a request that ends the flow when it succeeds. The request is
   *  sent by the caller, so each subtype stays visible where it is sent —
   *  the control catalog's test reads them from the source. */
  async function finishWith(flow: Flow, request: Promise<unknown>): Promise<SignedInAccount> {
    try {
      const res = await request;
      const account = accountOf(res);
      await end(flow, false);
      return account;
    } catch (err) {
      if (flow.cancelled) throw new Error('Sign-in cancelled');
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    async beginSignIn(configDir) {
      buildClaudeEnv(configDir); // throws on an empty config dir
      const engine = deps.createEngine(requireBinary());
      const previous = byConfigDir.get(configDir);
      if (previous) await end(flows.get(previous) as Flow, true);
      try {
        await engine.start({ projectPath: os.tmpdir(), configDir, sessionId: randomUUID(), resume: false });
        const res = await engine.sendControlRequest<{ manualUrl?: unknown; automaticUrl?: unknown }>(
          'claude_authenticate', { loginWithClaudeAi: true }, { timeoutMs: BEGIN_TIMEOUT_MS },
        );
        if (typeof res?.manualUrl !== 'string' || typeof res.automaticUrl !== 'string') {
          throw new Error('The CLI did not return sign-in links');
        }
        const flow: Flow = {
          id: randomUUID(),
          configDir,
          engine,
          state: stateOf(res.manualUrl),
          abort: new AbortController(),
          expiry: setTimeout(() => { void end(flow, true); }, FLOW_TTL_MS),
          cancelled: false,
        };
        flow.expiry.unref?.();
        flows.set(flow.id, flow);
        byConfigDir.set(configDir, flow.id);
        return { flowId: flow.id, manualUrl: res.manualUrl, automaticUrl: res.automaticUrl };
      } catch (err) {
        try { await engine.close(); } catch { /* best effort */ }
        throw err;
      }
    },

    async submitCode(flowId, pasted) {
      const flow = requireFlow(flowId);
      const text = pasted.trim();
      const hash = text.indexOf('#');
      const authorizationCode = hash >= 0 ? text.slice(0, hash) : text;
      const state = hash >= 0 ? text.slice(hash + 1) : flow.state;
      if (!authorizationCode) throw new Error('Paste the code the sign-in page showed.');
      return finishWith(flow, flow.engine.sendControlRequest(
        'claude_oauth_callback',
        { authorizationCode, state },
        { timeoutMs: CODE_TIMEOUT_MS, signal: flow.abort.signal },
      ));
    },

    async waitForCompletion(flowId) {
      const flow = requireFlow(flowId);
      return finishWith(flow, flow.engine.sendControlRequest(
        'claude_oauth_wait_for_completion',
        {},
        { timeoutMs: FLOW_TTL_MS, signal: flow.abort.signal },
      ));
    },

    async cancel(flowId) {
      const flow = flows.get(flowId);
      if (flow) await end(flow, true);
    },

    async logout(configDir) {
      const env = buildClaudeEnv(configDir);
      const bin = requireBinary();
      try {
        await exec(bin, ['auth', 'logout'], env);
      } catch (err) {
        const stderr = (err as { stderr?: unknown }).stderr;
        const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : (err as Error).message;
        throw new Error(`claude auth logout failed: ${detail}`);
      }
    },
  };
}
