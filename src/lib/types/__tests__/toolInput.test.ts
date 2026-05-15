import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  asToolInput,
  asToolInputOneOf,
  isKnownToolName,
  warnUnhandledKnownTool,
  KNOWN_TOOL_NAMES,
  TOOLS_WITH_WIDGETS_LOWER,
} from '../toolInput';

describe('asToolInput', () => {
  it('returns the typed input when the name matches and input is an object', () => {
    const result = asToolInput('Bash', 'Bash', { command: 'ls', description: 'list' });
    expect(result).not.toBeNull();
    expect(result!.command).toBe('ls');
    expect(result!.description).toBe('list');
  });

  it('returns null when the name does not match', () => {
    expect(asToolInput('Read', 'Bash', { command: 'ls' })).toBeNull();
  });

  it('returns null when name is undefined', () => {
    expect(asToolInput(undefined, 'Bash', { command: 'ls' })).toBeNull();
  });

  it('returns null when input is not an object (string, number, null, undefined)', () => {
    expect(asToolInput('Bash', 'Bash', 'ls')).toBeNull();
    expect(asToolInput('Bash', 'Bash', 42)).toBeNull();
    expect(asToolInput('Bash', 'Bash', null)).toBeNull();
    expect(asToolInput('Bash', 'Bash', undefined)).toBeNull();
  });

  it('does NOT validate field-level shape — passes through any object payload', () => {
    // Documented behavior: SDK types are compile-time only; runtime asserts
    // the discriminator name and object-ness, no more. Each widget reads
    // with optional access so a missing field renders gracefully.
    const result = asToolInput('Bash', 'Bash', { unrelated: true });
    expect(result).not.toBeNull();
  });
});

describe('asToolInput — Write empty-content predicate', () => {
  // Regression for the empty-file write bug. `content === ''` is a
  // legitimate empty-file write — the SDK schema permits it and Claude
  // Code emits it for `touch`-style operations. The StreamMessage gate
  // historically used `writeInput?.file_path && writeInput.content`
  // which evaluates to `''` (falsy) for empty content and silently
  // dropped the widget through to the generic JSON display. The fix
  // is `writeInput?.file_path && writeInput.content !== undefined`.
  // This test pins the contract at the literal-expression level.
  it('preserves empty-string content on Write narrowing', () => {
    const input = asToolInput('Write', 'Write', { file_path: '/tmp/empty.txt', content: '' });
    expect(input).not.toBeNull();
    expect(input!.file_path).toBe('/tmp/empty.txt');
    expect(input!.content).toBe('');
  });

  it('the WRONG predicate (truthiness) drops empty-content writes', () => {
    const input = asToolInput('Write', 'Write', { file_path: '/tmp/empty.txt', content: '' });
    // Documents why the bug existed: the truthiness check sees '' as falsy.
    expect(Boolean(input!.file_path && input!.content)).toBe(false);
  });

  it('the CORRECT predicate (definedness) keeps empty-content writes', () => {
    const input = asToolInput('Write', 'Write', { file_path: '/tmp/empty.txt', content: '' });
    // The fixed predicate the StreamMessage gate must use.
    expect(Boolean(input!.file_path && input!.content !== undefined)).toBe(true);
  });
});

describe('GrepInputExtended', () => {
  // Regression: GrepInputExtended adds optional `include` / `exclude`
  // fields the SDK no longer models (replaced upstream by glob / type).
  // GrepWidget still reads them for back-compat with older session
  // payloads. If the intersection were ever removed from toolInput.ts,
  // the call site in StreamMessage.tsx would compile (because rawInput
  // is unknown until narrowed) but `grepInput.include` would silently
  // become `unknown` rather than `string | undefined`. This test
  // exercises the access pattern so the type intersection can't be
  // removed without breaking either the test or the consumer.
  it('exposes legacy include/exclude fields after narrowing', () => {
    const result = asToolInput('Grep', 'Grep', {
      pattern: 'foo',
      include: '*.ts',
      exclude: 'node_modules',
    });
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('foo');
    expect(result!.include).toBe('*.ts');
    expect(result!.exclude).toBe('node_modules');
  });
});

describe('asToolInputOneOf', () => {
  it('matches any name in the expected set', () => {
    expect(asToolInputOneOf('Task', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toEqual({
      name: 'Task',
      input: { description: 'd', prompt: 'p' },
    });
    expect(asToolInputOneOf('Agent', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toEqual({
      name: 'Agent',
      input: { description: 'd', prompt: 'p' },
    });
  });

  it('returns null when the name is outside the expected set', () => {
    expect(asToolInputOneOf('Bash', ['Task', 'Agent'], { command: 'x' })).toBeNull();
  });

  it('returns null when name is undefined or input is not an object', () => {
    expect(asToolInputOneOf(undefined, ['Task'], { prompt: 'p', description: 'd' })).toBeNull();
    expect(asToolInputOneOf('Task', ['Task'], null)).toBeNull();
    expect(asToolInputOneOf('Task', ['Task'], 'string')).toBeNull();
  });

  // Regression: the renderer used to PascalCase-normalize the name before
  // calling asToolInputOneOf because isSubagentDispatch was case-insensitive
  // and this helper was case-sensitive — the asymmetry forced a shim at
  // the call site. Both layers are now case-sensitive against the SDK's
  // PascalCase contract; this test pins the case-sensitive behavior so any
  // future regression to lenient matching breaks loudly.
  it('is case-sensitive — lowercase variants do NOT match PascalCase expected set', () => {
    expect(asToolInputOneOf('task', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toBeNull();
    expect(asToolInputOneOf('agent', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toBeNull();
    expect(asToolInputOneOf('TASK', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toBeNull();
  });
});

describe('KNOWN_TOOL_NAMES / TOOLS_WITH_WIDGETS_LOWER', () => {
  // Single-source-of-truth invariant: TOOLS_WITH_WIDGETS_LOWER must be the
  // KNOWN_TOOL_NAMES tuple lowercased, with no drift in either direction.
  // The Set is what StreamMessage.tsx uses for the tool-result suppression
  // path; it must stay in lockstep with the typed widget switch keys.
  it('TOOLS_WITH_WIDGETS_LOWER is exactly KNOWN_TOOL_NAMES lowercased', () => {
    const expected = new Set(KNOWN_TOOL_NAMES.map((n) => n.toLowerCase()));
    expect(TOOLS_WITH_WIDGETS_LOWER).toEqual(expected);
    expect(TOOLS_WITH_WIDGETS_LOWER.size).toBe(KNOWN_TOOL_NAMES.length);
  });

  it('KNOWN_TOOL_NAMES contains the expected tools', () => {
    // Fence-post check so adding a tool requires updating this assertion
    // (and forces deliberate consideration of whether it needs a widget).
    expect(new Set(KNOWN_TOOL_NAMES)).toEqual(
      new Set([
        'Bash', 'Edit', 'MultiEdit', 'Read', 'Write', 'Glob', 'Grep',
        'TodoRead', 'LS', 'WebFetch', 'WebSearch',
        'Task', 'Agent',
      ]),
    );
  });
});

describe('isKnownToolName', () => {
  it('returns true for every PascalCase name in KNOWN_TOOL_NAMES', () => {
    for (const name of KNOWN_TOOL_NAMES) {
      expect(isKnownToolName(name)).toBe(true);
    }
  });

  it('returns false for unknown names, MCP names, lowercase variants, and non-strings', () => {
    expect(isKnownToolName('Unknown')).toBe(false);
    expect(isKnownToolName('mcp__filesystem__read')).toBe(false);
    expect(isKnownToolName('bash')).toBe(false); // case-sensitive
    expect(isKnownToolName('')).toBe(false);
    expect(isKnownToolName(undefined)).toBe(false);
    expect(isKnownToolName(null)).toBe(false);
    expect(isKnownToolName(42)).toBe(false);
    expect(isKnownToolName({ name: 'Bash' })).toBe(false);
  });
});

describe('warnUnhandledKnownTool', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Vitest sets import.meta.env.DEV=true by default in test mode, so the
  // helper's DEV gate is satisfied during these tests. We intentionally
  // do NOT mock the gate — the test reflects how the helper behaves in
  // a dev session of the renderer.

  it('warns when toolName is in KNOWN_TOOL_NAMES (a known name fell through with no rendering branch matching)', () => {
    warnUnhandledKnownTool('Bash', { unexpected: true });
    expect(warnSpy).toHaveBeenCalledOnce();
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain('Bash');
    expect(message).toContain('unexpected');
  });

  it('does NOT warn for unknown tool names (MCP, custom, future)', () => {
    warnUnhandledKnownTool('mcp__filesystem__read', { uri: 'x' });
    warnUnhandledKnownTool('SomeFutureTool', {});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when toolName is undefined or empty', () => {
    warnUnhandledKnownTool(undefined, {});
    warnUnhandledKnownTool('', {});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('handles non-object rawInput gracefully (reports keys: none)', () => {
    warnUnhandledKnownTool('Read', null);
    warnUnhandledKnownTool('Read', 'string');
    expect(warnSpy).toHaveBeenCalledTimes(2);
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).toContain('none');
    }
  });
});
