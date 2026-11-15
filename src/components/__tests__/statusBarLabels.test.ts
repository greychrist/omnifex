import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Every readout label in the status bars goes through ReadoutLabel, so each
// is followed by a colon. A bare `<span className="opacity-70">label</span>`
// would quietly drop it.
const FILES = [
  'ChatStatusBar.tsx',
  'SessionControlPickers.tsx',
  'SessionStatusItem.tsx',
  'AccountStatusItem.tsx',
  'BackgroundWorkItems.tsx',
  'CacheTimerRow.tsx',
  'claude-code-session/BranchStatusBar.tsx',
];

describe('status bar labels', () => {
  it.each(FILES)('%s labels its readouts with ReadoutLabel', (file) => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    expect(src).toContain('ReadoutLabel');
    // A bare muted label word: `<span className="opacity-70">word</span>` or
    // `{noun}` / `{label}` / `{text}` in one.
    expect(src).not.toMatch(/<span(?: data-testid="usage-label")? className="opacity-70">(?:[a-z]+|\{(?:label|noun|text|thinkingLive[^}]*)\})<\/span>/);
  });
});
