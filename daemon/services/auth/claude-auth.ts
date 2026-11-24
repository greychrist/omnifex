/**
 * Credentials are never touched directly: on macOS they live in the Keychain and only the CLI knows where.
 * Logout drops `oauthAccount` from `.claude.json`, which `watchOauthIdentity` keys on, so no broadcast is needed.
 */

import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildClaudeEnv } from '../util/claude-env';

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
  beginSignIn(configDir: string): Promise<SignInFlow>;
  /** A rejected code leaves the flow open for another try. */
  submitCode(flowId: string, pasted: string): Promise<SignedInAccount>;
  waitForCompletion(flowId: string): Promise<SignedInAccount>;
  cancel(flowId: string): Promise<void>;
  logout(configDir: string): Promise<void>;
}

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
  createEngine(binary: string): SignInEngine;
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
}

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
      if (err) reject(Object.assign(err as Error, { stdout, stderr }));
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

  /** The caller sends the request so each subtype is visible at its send site; the control catalog's test reads them from source. */
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
