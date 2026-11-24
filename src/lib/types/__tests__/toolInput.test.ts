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
    const result = asToolInput('Bash', 'Bash', { unrelated: true });
    expect(result).not.toBeNull();
  });
});

describe('asToolInput — Write empty-content predicate', () => {
  // `content === ''` is a legitimate empty-file write.
  it('preserves empty-string content on Write narrowing', () => {
    const input = asToolInput('Write', 'Write', { file_path: '/tmp/empty.txt', content: '' });
    expect(input).not.toBeNull();
    expect(input!.file_path).toBe('/tmp/empty.txt');
    expect(input!.content).toBe('');
  });

  it('the WRONG predicate (truthiness) drops empty-content writes', () => {
    const input = asToolInput('Write', 'Write', { file_path: '/tmp/empty.txt', content: '' });
    expect(Boolean(input!.file_path && input!.content)).toBe(false);
  });

  it('the CORRECT predicate (definedness) keeps empty-content writes', () => {
    const input = asToolInput('Write', 'Write', { file_path: '/tmp/empty.txt', content: '' });
    expect(Boolean(input!.file_path && input!.content !== undefined)).toBe(true);
  });
});

describe('GrepInputExtended', () => {
  // GrepWidget still reads `include` / `exclude`, which the CLI no longer models,
  // for older payloads.
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

  it('is case-sensitive — lowercase variants do NOT match PascalCase expected set', () => {
    expect(asToolInputOneOf('task', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toBeNull();
    expect(asToolInputOneOf('agent', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toBeNull();
    expect(asToolInputOneOf('TASK', ['Task', 'Agent'], { description: 'd', prompt: 'p' })).toBeNull();
  });
});

describe('KNOWN_TOOL_NAMES / TOOLS_WITH_WIDGETS_LOWER', () => {
  it('TOOLS_WITH_WIDGETS_LOWER is exactly KNOWN_TOOL_NAMES lowercased', () => {
    const expected = new Set(KNOWN_TOOL_NAMES.map((n) => n.toLowerCase()));
    expect(TOOLS_WITH_WIDGETS_LOWER).toEqual(expected);
    expect(TOOLS_WITH_WIDGETS_LOWER.size).toBe(KNOWN_TOOL_NAMES.length);
  });

  it('KNOWN_TOOL_NAMES contains the expected tools', () => {
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

  // Vitest sets import.meta.env.DEV=true in test mode, so the DEV gate holds.

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
