#!/usr/bin/env node
// End-to-end smoke test for the OmniFex Remote daemon, over the real protocol.
//
// Drives: hello → (create a Claude account if the daemon has none) →
// project.add → session.create → session.subscribe → turn.send → answer the
// first permission.request with allow → wait for the CLI result → print what
// happened. With --resume <sessionId> it skips creation and resumes instead,
// which is how the "kill the daemon and come back" acceptance is checked.
//
// Spends real tokens: one tiny turn on whichever account the daemon resolves.
//
//   node scripts/remote-smoke.mjs [--url ws://127.0.0.1:47701/ws] [--project /abs/dir]
//                                 [--config-dir ~/.claude-personal] [--resume <sessionId>]
//                                 [--prompt "..."] [--timeout 120]
import WebSocket from 'ws';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const url = args.url ?? 'ws://127.0.0.1:47701/ws';
const projectPath = args.project ?? join(homedir(), 'omnifex-remote-probe');
const configDir = args['config-dir'] ?? join(homedir(), '.claude-personal');
const prompt = args.prompt ?? 'Run `ls` in the current directory using the Bash tool, then reply with exactly one word: pong';
const timeoutSec = Number(args.timeout ?? 180);

mkdirSync(projectPath, { recursive: true });

const ws = new WebSocket(url);
let n = 0;
const pending = new Map();
const pushes = [];
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const request = (type, params = {}) =>
  new Promise((resolve, reject) => {
    const requestId = `smoke-${++n}`;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ type, requestId, ...params }));
  });

const waitFor = (pred, label) =>
  new Promise((resolve, reject) => {
    const hit = pushes.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutSec * 1000);
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
const waiters = [];

ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'response') {
    const p = pending.get(m.requestId);
    pending.delete(m.requestId);
    if (!p) return;
    m.ok ? p.resolve(m.result) : p.reject(Object.assign(new Error(`${m.error.code}: ${m.error.message}`), m.error));
    return;
  }
  pushes.push(m);
  if (m.type === 'event' && m.kind === 'transcript') {
    const node = m.payload;
    const brief = node.kind === 'assistant'
      ? `assistant stop=${node.raw?.message?.stop_reason ?? '?'} ${JSON.stringify(node.raw?.message?.content?.map((c) => c.type))}`
      : node.kind;
    log(`  #${m.seq} transcript/${brief}`);
  } else if (m.type === 'event') {
    log(`  #${m.seq} event/${m.kind}${m.kind === 'stderr' ? ' ' + String(m.payload).slice(0, 120) : ''}`);
  } else if (m.type === 'permission.request') {
    log(`  #${m.seq} permission.request ${m.tool} ${JSON.stringify(m.input).slice(0, 100)} (${m.permissionId})`);
  } else if (m.type === 'session.state') {
    log(`  #${m.seq} session.state ${m.sessionStatus}`);
  } else {
    log(`  ${m.type}${m.channel ? ' ' + m.channel : ''}`);
  }
  for (const w of waiters.splice(0)) {
    if (w.pred(m)) w.resolve(m); else waiters.push(w);
  }
});

ws.on('open', async () => {
  try {
    const welcome = await request('hello', { clientId: 'smoke', clientKind: 'web', protocolVersion: 1 });
    log('welcome', welcome);

    const accounts = await request('rpc.invoke', { channel: 'list_accounts' });
    if (!accounts.some((a) => a.engine === 'claude')) {
      log(`no Claude account in this daemon; creating one for ${configDir}`);
      await request('rpc.invoke', { channel: 'create_account', params: { name: 'Smoke', configDir, engine: 'claude' } });
    }

    const project = await request('project.add', { path: projectPath, title: 'remote-probe' });
    log('project', project);
    if (!project.configDir) {
      log(`project resolves to no account; adding a path rule for ${configDir}`);
      const acct = (await request('rpc.invoke', { channel: 'list_accounts' })).find((a) => a.engine === 'claude');
      await request('rpc.invoke', { channel: 'add_path_rule', params: { accountId: acct.id, pathPrefix: projectPath, priority: 100 } });
    }

    let session;
    if (args.resume) {
      session = await request('session.resume', { sessionId: args.resume });
      log('resumed', session);
    } else {
      session = await request('session.create', { projectId: project.projectId, title: 'smoke', options: { permissionMode: 'default' } });
      log('created', session);
    }
    const sid = session.sessionId;

    const sub = await request('session.subscribe', { sessionId: sid, fromSeq: 0 });
    log('subscribed', sub);

    // Everything at or below this seq is replay of the past; the turn we care
    // about starts after it. Without the fence a resumed session's OLD result
    // satisfies the wait and the new turn is never observed.
    const fence = sub.lastSeq;
    const isResult = (m) =>
      m.type === 'event' && m.kind === 'transcript' && m.sessionId === sid && m.payload?.kind === 'cli-stream-result';
    const isPermission = (m) => m.type === 'permission.request' && m.sessionId === sid;

    // A session resumed with a prompt still blocked on a permission: answer
    // it instead of piling a second prompt on top.
    const summaryNow = (await request('session.list')).find((s) => s.sessionId === sid);
    let first;
    if (summaryNow?.pendingPermissions > 0) {
      const pendingReq = [...pushes].reverse().find(isPermission);
      log(`session has a pending permission from before; approving ${pendingReq.tool} (${pendingReq.permissionId})`);
      await request('permission.respond', { sessionId: sid, permissionId: pendingReq.permissionId, decision: 'allow' });
      first = await waitFor((m) => isResult(m) && m.seq > fence, 'the blocked turn to finish');
    } else {
      await request('turn.send', { sessionId: sid, content: prompt });
      log('sent prompt');
      first = await waitFor((m) => (isPermission(m) || isResult(m)) && m.seq > fence, 'a permission request or a result');
      if (first.type === 'permission.request') {
        log(`approving ${first.tool} (${first.permissionId})`);
        await request('permission.respond', { sessionId: sid, permissionId: first.permissionId, decision: 'allow' });
        first = await waitFor((m) => isResult(m) && m.seq > first.seq, 'the turn result');
      }
    }
    const result = first.payload.raw;
    log('RESULT', { is_error: result.is_error, num_turns: result.num_turns, cost: result.total_cost_usd, text: String(result.result ?? '').slice(0, 200) });

    const summary = (await request('session.list')).find((s) => s.sessionId === sid);
    log('summary', summary);

    console.log(`\nSMOKE OK sessionId=${sid} lastSeq=${summary?.lastSeq}`);
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('\nSMOKE FAILED:', err.message);
    ws.close();
    process.exit(1);
  }
});
ws.on('error', (e) => { console.error('socket error', e.message); process.exit(1); });
ws.on('close', (code, reason) => {
  // Reached only if the daemon dropped us before the script finished.
  console.error(`\nSMOKE FAILED: socket closed early (${code} ${reason?.toString() || ''})`);
  process.exit(1);
});
setTimeout(() => {
  console.error(`\nSMOKE FAILED: overall deadline of ${timeoutSec}s exceeded`);
  process.exit(1);
}, timeoutSec * 1000).unref?.();
