import { describe, it, expect } from 'vitest';
import { phaseLabel } from '../phaseLabel';

describe('phaseLabel', () => {
  it('maps the documented "compacting" status to "Compacting context"', () => {
    expect(phaseLabel('compacting')).toBe('Compacting context');
  });

  it('maps the observed "requesting" status to "Requesting"', () => {
    expect(phaseLabel('requesting')).toBe('Requesting');
  });

  it('title-cases an unknown open-string value, turning separators into spaces', () => {
    // The CLI may emit status values the docs do not list (the field is an
    // open string). They should degrade gracefully, not vanish.
    expect(phaseLabel('tool_use')).toBe('Tool use');
  });

  it('returns null for null, undefined, and blank input (no label emitted)', () => {
    expect(phaseLabel(null)).toBeNull();
    expect(phaseLabel(undefined)).toBeNull();
    expect(phaseLabel('')).toBeNull();
    expect(phaseLabel('   ')).toBeNull();
  });
});
