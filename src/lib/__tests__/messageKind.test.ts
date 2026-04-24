import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '@/components/AgentExecution';
import { classifyStandaloneKind, filterCompactHidden } from '../messageKind';
import { createDefaultConfig } from '../messageRenderingConfig';

const sysInit = (): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude', cwd: '/x', tools: [] } as unknown as ClaudeStreamMessage);

const notif = (kind: string): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'notification', notification_type: kind, message: 'm' } as unknown as ClaudeStreamMessage);

const userText = (text: string): ClaudeStreamMessage =>
  ({ type: 'user', message: { content: [{ type: 'text', text }] } } as unknown as ClaudeStreamMessage);

const permReq = (): ClaudeStreamMessage =>
  ({ type: 'permission_request' } as unknown as ClaudeStreamMessage);

const resultOk = (): ClaudeStreamMessage =>
  ({ type: 'result', subtype: 'success', result: 'hi' } as unknown as ClaudeStreamMessage);

const summary = (): ClaudeStreamMessage =>
  ({ type: 'summary', leafUuid: 'leaf-1', summary: 'sum' } as unknown as ClaudeStreamMessage);

describe('classifyStandaloneKind', () => {
  it('tags system init', () => {
    expect(classifyStandaloneKind(sysInit(), [])).toBe('system.init');
  });

  it('tags notification subtypes by notification_type', () => {
    expect(classifyStandaloneKind(notif('error'), [])).toBe('system.notification.error');
    expect(classifyStandaloneKind(notif('stop'), [])).toBe('system.notification.stop');
    expect(classifyStandaloneKind(notif('warn'), [])).toBe('system.notification.warn');
    expect(classifyStandaloneKind(notif('info'), [])).toBe('system.notification.info');
    // Unknown → info fallback, matching StreamMessage rendering
    expect(classifyStandaloneKind(notif('whatever'), [])).toBe('system.notification.info');
  });

  it('tags permission requests, results, summaries', () => {
    expect(classifyStandaloneKind(permReq(), [])).toBe('permission.request');
    expect(classifyStandaloneKind(resultOk(), [])).toBe('result.success');
    expect(classifyStandaloneKind(summary(), [])).toBe('summary.compaction');
  });

  it('returns null for messages whose rendering is per-content-block', () => {
    // Assistant / user messages can contain mixed blocks; filtering them as a
    // whole would hide text along with tool_use. Leave to existing renderer.
    const asst: ClaudeStreamMessage = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read', input: {} }] },
    } as unknown as ClaudeStreamMessage;
    expect(classifyStandaloneKind(asst, [])).toBeNull();
    expect(classifyStandaloneKind(userText('hello'), [])).toBeNull();
  });
});

describe('filterCompactHidden', () => {
  it('drops system.init when hiddenInCompact=true (default)', () => {
    const cfg = createDefaultConfig();
    expect(cfg.kinds['system.init'].hiddenInCompact).toBe(true);
    const msgs = [userText('hi'), sysInit(), userText('bye')];
    const filtered = filterCompactHidden(msgs, cfg);
    expect(filtered).toHaveLength(2);
    expect(filtered.every(m => !(m.type === 'system' && m.subtype === 'init'))).toBe(true);
  });

  it('keeps system.init when hiddenInCompact=false', () => {
    const cfg = createDefaultConfig();
    cfg.kinds['system.init'] = { ...cfg.kinds['system.init'], hiddenInCompact: false };
    const msgs = [sysInit()];
    expect(filterCompactHidden(msgs, cfg)).toHaveLength(1);
  });

  it('never drops compact-boundary-locked kinds regardless of hiddenInCompact', () => {
    const cfg = createDefaultConfig();
    // Force the flag on; mergeConfig normally prevents this, but defense-in-depth.
    cfg.kinds['permission.request'] = { ...cfg.kinds['permission.request'], hiddenInCompact: true };
    cfg.kinds['result.success'] = { ...cfg.kinds['result.success'], hiddenInCompact: true };
    const msgs = [permReq(), resultOk(), summary()];
    expect(filterCompactHidden(msgs, cfg)).toHaveLength(3);
  });

  it('drops info notifications by default, keeps error/warn/stop', () => {
    const cfg = createDefaultConfig();
    const msgs = [notif('info'), notif('error'), notif('warn'), notif('stop')];
    const filtered = filterCompactHidden(msgs, cfg);
    expect(filtered).toHaveLength(3);
    expect(filtered.every((m) => (m as { notification_type?: string }).notification_type !== 'info')).toBe(true);
  });

  it('leaves unclassifiable messages alone', () => {
    const cfg = createDefaultConfig();
    const msgs = [userText('hi'), sysInit()];
    const filtered = filterCompactHidden(msgs, cfg);
    expect(filtered).toContainEqual(msgs[0]);
  });
});
