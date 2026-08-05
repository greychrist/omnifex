/**
 * Hooks configuration manager for Claude Code hooks
 */

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
  /**
   * Merge hooks configurations with proper priority
   * Priority: local > project > user
   */
  static mergeConfigs(
    user: HooksConfiguration,
    project: HooksConfiguration,
    local: HooksConfiguration
  ): HooksConfiguration {
    const merged: HooksConfiguration = {};

    // One path for every event. Events that ignore `matcher` still store
    // their commands under the same `[{matcher?, hooks:[…]}]` nesting, so
    // there is nothing to special-case — the old direct-event branch both
    // assumed a flat shape the CLI never uses and concatenated instead of
    // overriding, so a project-scope hook would fire alongside the user one
    // rather than replacing it.
    for (const event of HOOK_EVENTS) {
      let matchers = [...(user[event] ?? [])];
      if (project[event]) matchers = this.mergeMatchers(matchers, project[event]);
      if (local[event]) matchers = this.mergeMatchers(matchers, local[event]);
      if (matchers.length > 0) merged[event] = matchers;
    }

    return merged;
  }

  /**
   * Merge matcher arrays, with later items taking precedence
   */
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
        // Replace existing matcher
        result[existingIndex] = overrideMatcher;
      } else {
        // Add new matcher
        result.push(overrideMatcher);
      }
    }
    
    return result;
  }

  /**
   * Validate hooks configuration
   */
  static async validateConfig(hooks: HooksConfiguration): Promise<HookValidationResult> {
    const errors: HookValidationError[] = [];
    const warnings: HookValidationWarning[] = [];

    // Guard against undefined or null hooks
    if (!hooks) {
      return { valid: true, errors, warnings };
    }

    for (const event of HOOK_EVENTS) {
      const matchers = hooks[event];
      if (!matchers || !Array.isArray(matchers)) continue;

      for (const matcher of matchers) {
        // A legacy flat entry — `{type:'command', command:'…'}` written
        // straight into the event array — has no `hooks` member. The CLI
        // silently never runs those, so surface it as an error rather than
        // letting a dead hook look configured.
        if (!Array.isArray(matcher.hooks)) {
          errors.push({
            event,
            message:
              'Malformed hook entry: expected { matcher?, hooks: [...] }. Commands must be nested under "hooks".',
          });
          continue;
        }

        // Validate regex pattern if provided
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

          // Check for dangerous patterns
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

  /**
   * Check for potentially dangerous command patterns
   */
  public static checkDangerousPatterns(command: string): string[] {
    const warnings: string[] = [];
    
    // Guard against undefined or null commands
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

    // Check for unescaped variables that could lead to code injection
    if (command.includes('$') && !command.includes('"$')) {
      warnings.push('Unquoted shell variable detected - potential code injection risk');
    }

    return warnings;
  }

  /**
   * Escape a command for safe shell execution
   */
  static escapeCommand(command: string): string {
    // Basic shell escaping - in production, use a proper shell escaping library
    return command
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }

  /**
   * Generate a unique ID for hooks/matchers/commands
   */
  static generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
} 
