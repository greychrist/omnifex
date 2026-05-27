import { describe, it, expect } from 'vitest';
import { createWindowRouter } from '../window-router';

describe('window-router', () => {
  describe('tab-scoped channels', () => {
    it('routes agent-output:<tabId> to the tab owner when registered', () => {
      const r = createWindowRouter();
      r.registerTabOwner('tab-1', 42);
      expect(r.resolveTarget('agent-output:tab-1')).toEqual({ kind: 'owner', ownerId: 42 });
    });

    it('routes the full set of tab-scoped channels (output/error/complete/subagent/compact/elicitation) to the owner', () => {
      const r = createWindowRouter();
      r.registerTabOwner('tab-1', 7);
      for (const ch of [
        'agent-output:tab-1',
        'agent-error:tab-1',
        'agent-complete:tab-1',
        'claude-subagent:tab-1',
        'claude-compact:tab-1',
        'elicitation-request:tab-1',
      ]) {
        expect(r.resolveTarget(ch)).toEqual({ kind: 'owner', ownerId: 7 });
      }
    });

    it('still routes legacy claude-output/error/complete channels to the tab owner during the compat-shim release', () => {
      const r = createWindowRouter();
      r.registerTabOwner('tab-1', 7);
      for (const ch of [
        'claude-output:tab-1',
        'claude-error:tab-1',
        'claude-complete:tab-1',
      ]) {
        expect(r.resolveTarget(ch)).toEqual({ kind: 'owner', ownerId: 7 });
      }
    });

    it('supports tab IDs that contain colons', () => {
      const r = createWindowRouter();
      r.registerTabOwner('project:foo:bar', 5);
      expect(r.resolveTarget('agent-output:project:foo:bar')).toEqual({
        kind: 'owner',
        ownerId: 5,
      });
    });

    it('broadcasts tab-scoped channels when the tab is unknown', () => {
      const r = createWindowRouter();
      expect(r.resolveTarget('agent-output:unknown-tab')).toEqual({ kind: 'broadcast' });
    });

    it('unregisterTabOwner removes the mapping', () => {
      const r = createWindowRouter();
      r.registerTabOwner('tab-1', 3);
      r.unregisterTabOwner('tab-1');
      expect(r.resolveTarget('agent-output:tab-1')).toEqual({ kind: 'broadcast' });
    });
  });

  describe('run-scoped channels', () => {
    it('routes agent-output:<runId>, agent-error:<runId>, agent-complete:<runId>, agent-cancelled:<runId> to the owner', () => {
      const r = createWindowRouter();
      r.registerRunOwner('99', 12);
      for (const ch of [
        'agent-output:99',
        'agent-error:99',
        'agent-complete:99',
        'agent-cancelled:99',
      ]) {
        expect(r.resolveTarget(ch)).toEqual({ kind: 'owner', ownerId: 12 });
      }
    });

    it('unregisterRunOwner removes the mapping', () => {
      const r = createWindowRouter();
      r.registerRunOwner('99', 12);
      r.unregisterRunOwner('99');
      expect(r.resolveTarget('agent-output:99')).toEqual({ kind: 'broadcast' });
    });
  });

  describe('broadcast fallback', () => {
    it('returns broadcast for app-wide channels', () => {
      const r = createWindowRouter();
      expect(r.resolveTarget('claude-notification')).toEqual({ kind: 'broadcast' });
      expect(r.resolveTarget('updater:progress')).toEqual({ kind: 'broadcast' });
    });

    it('returns broadcast for channels without a known scoped prefix', () => {
      const r = createWindowRouter();
      expect(r.resolveTarget('some-random-channel:x')).toEqual({ kind: 'broadcast' });
    });
  });
});
