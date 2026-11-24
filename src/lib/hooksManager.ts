import {
  HOOK_EVENTS,
  HooksConfiguration,
  HookMatcher,
  HookValidationResult,
  HookValidationError,
  HookValidationWarning,
} from '@/types/hooks';

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- utility-class pattern intentional; namespace-style functions less idiomatic in this codebase.
export class HooksManager {
  static mergeConfigs(
    user: HooksConfiguration,
    project: HooksConfiguration,
    local: HooksConfiguration
  ): HooksConfiguration {
    const merged: HooksConfiguration = {};

    // Every event nests commands under `[{matcher?, hooks:[…]}]`; a later scope replaces, never concatenates.
    for (const event of HOOK_EVENTS) {
      let matchers = [...(user[event] ?? [])];
      if (project[event]) matchers = this.mergeMatchers(matchers, project[event]);
      if (local[event]) matchers = this.mergeMatchers(matchers, local[event]);
      if (matchers.length > 0) merged[event] = matchers;
    }

    return merged;
  }

  private static mergeMatchers(
    base: HookMatcher[],
    override: HookMatcher[]
  ): HookMatcher[] {
    const result = [...base];
    
    for (const overrideMatcher of override) {
      const existingIndex = result.findIndex(
        m => m.matcher === overrideMatcher.matcher
      );
      
      if (existingIndex >= 0) {
        result[existingIndex] = overrideMatcher;
      } else {
        result.push(overrideMatcher);
      }
    }
    
    return result;
  }

  static async validateConfig(hooks: HooksConfiguration): Promise<HookValidationResult> {
    const errors: HookValidationError[] = [];
    const warnings: HookValidationWarning[] = [];

    if (!hooks) {
      return { valid: true, errors, warnings };
    }

    for (const event of HOOK_EVENTS) {
      const matchers = hooks[event];
      if (!matchers || !Array.isArray(matchers)) continue;

      for (const matcher of matchers) {
        // A flat entry with no `hooks` member never runs in the CLI: surface it rather than let a dead hook look configured.
        if (!Array.isArray(matcher.hooks)) {
          errors.push({
            event,
            message:
              'Malformed hook entry: expected { matcher?, hooks: [...] }. Commands must be nested under "hooks".',
          });
          continue;
        }

        if (matcher.matcher) {
          try {
            new RegExp(matcher.matcher);
          } catch (e) {
            errors.push({
              event,
              matcher: matcher.matcher,
              message: `Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`
            });
          }
        }

        for (const hook of matcher.hooks) {
          if (!hook.command?.trim()) {
            errors.push({
              event,
              matcher: matcher.matcher,
              message: 'Empty command'
            });
          }

          const dangers = this.checkDangerousPatterns(hook.command || '');
          warnings.push(...dangers.map(d => ({
            event,
            matcher: matcher.matcher,
            command: hook.command || '',
            message: d
          })));
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  public static checkDangerousPatterns(command: string): string[] {
    const warnings: string[] = [];
    
    if (!command || typeof command !== 'string') {
      return warnings;
    }
    
    const patterns = [
      { pattern: /rm\s+-rf\s+\/(?:\s|$)/, message: 'Destructive command on root directory' },
      { pattern: /rm\s+-rf\s+~/, message: 'Destructive command on home directory' },
      { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;/, message: 'Fork bomb pattern detected' },
      { pattern: /curl.*\|\s*(?:bash|sh)/, message: 'Downloading and executing remote code' },
      { pattern: /wget.*\|\s*(?:bash|sh)/, message: 'Downloading and executing remote code' },
      { pattern: />\/dev\/sda/, message: 'Direct disk write operation' },
      { pattern: /sudo\s+/, message: 'Elevated privileges required' },
      { pattern: /dd\s+.*of=\/dev\//, message: 'Dangerous disk operation' },
      { pattern: /mkfs\./, message: 'Filesystem formatting command' },
      { pattern: /:(){ :|:& };:/, message: 'Fork bomb detected' },
    ];

    for (const { pattern, message } of patterns) {
      if (pattern.test(command)) {
        warnings.push(message);
      }
    }

    if (command.includes('$') && !command.includes('"$')) {
      warnings.push('Unquoted shell variable detected - potential code injection risk');
    }

    return warnings;
  }

  static escapeCommand(command: string): string {
    return command
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }

  static generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
} 
