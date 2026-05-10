import { describe, it, expect } from 'vitest';
import { Folder, List, MessageSquare } from 'lucide-react';
import { getTabIcon } from '../TabManager';

describe('getTabIcon', () => {
  it('returns the type default when no per-tab icon override is set', () => {
    expect(getTabIcon({ type: 'projects' })).toBe(Folder);
    expect(getTabIcon({ type: 'chat' })).toBe(MessageSquare);
  });

  it('honors a "list" icon override on a projects-type tab (sessions drill-down)', () => {
    expect(getTabIcon({ type: 'projects', icon: 'list' })).toBe(List);
  });

  it('falls through to the type default when icon override id is unknown (stale-state safe)', () => {
    expect(getTabIcon({ type: 'projects', icon: 'totally-not-a-real-icon-id' })).toBe(Folder);
    expect(getTabIcon({ type: 'chat', icon: 'whatever' })).toBe(MessageSquare);
  });

  it('treats undefined icon and missing icon identically', () => {
    expect(getTabIcon({ type: 'projects', icon: undefined })).toBe(Folder);
    expect(getTabIcon({ type: 'projects' })).toBe(Folder);
  });
});
