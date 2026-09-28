import { describe, it, expect } from 'vitest';
import { withoutWithdrawnPermission, type PermissionRequestPayload } from '../permissionRequest';

const card = (requestId: string): PermissionRequestPayload => ({
  requestId,
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  suggestions: [],
});

// The CLI withdraws a request when the turn is interrupted. Main sends
// `permission_withdrawn` only when nothing is queued behind it, so the card
// on screen is either the withdrawn one (drop it) or already a newer one.
describe('withoutWithdrawnPermission', () => {
  it('drops the card showing the withdrawn request', () => {
    expect(withoutWithdrawnPermission(card('a'), 'a')).toBeNull();
  });

  it('keeps a different card — a withdrawal must never close a newer ask', () => {
    const current = card('b');
    expect(withoutWithdrawnPermission(current, 'a')).toBe(current);
  });

  it('stays empty when nothing is showing', () => {
    expect(withoutWithdrawnPermission(null, 'a')).toBeNull();
  });
});
