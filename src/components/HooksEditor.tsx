/**
 * HooksEditor — authoring UI for Claude Code hooks in settings.json.
 *
 * Two things worth knowing about the shape, because an earlier version got
 * both wrong:
 *
 * 1. EVERY event uses the same nesting, `Event → [{matcher?, hooks:[…]}]`,
 *    including the ten events that always fire and ignore `matcher`. There is
 *    no flat-command form. This component therefore has ONE code path; the
 *    old matcher-events/direct-events split both mis-read real configs and
 *    wrote back a shape the CLI silently never executes.
 * 2. The matcher vocabulary is per-event and not guessable — `SessionStart`
 *    takes `startup|resume|clear`, `PreToolUse` takes tool names, `PreCompact`
 *    takes `manual|auto`. `HOOK_EVENT_INFO` carries the hint and examples so
 *    the field can offer the right values instead of tool names everywhere.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  Trash2,
  AlertTriangle,
  FileText,
  ChevronRight,
  ChevronDown,
  Clock,
  Info,
  Save,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { HooksManager } from '@/lib/hooksManager';
import { api } from '@/lib/api';
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import {
  HooksConfiguration,
  HookEvent,
  HookMatcher,
  HookCommand,
  HookTemplate,
  HOOK_EVENT_INFO,
  HOOK_TEMPLATES,
  eventSupportsMatcher,
  groupedHookEvents,
} from '@/types/hooks';

interface HooksEditorProps {
  projectPath?: string;
  /**
   * Absolute path to the Claude config directory (the account's `config_dir`).
   * Required for the `user` scope so we never silently read/write ~/.claude.
   */
  configDir?: string;
  scope: 'project' | 'local' | 'user';
  readOnly?: boolean;
  className?: string;
  onChange?: (hasChanges: boolean, getHooks: () => HooksConfiguration) => void;
  hideActions?: boolean;
}

interface EditableHookCommand extends HookCommand {
  id: string;
}

interface EditableHookMatcher extends Omit<HookMatcher, 'hooks'> {
  id: string;
  hooks: EditableHookCommand[];
  expanded?: boolean;
}

type EditableHooks = Partial<Record<HookEvent, EditableHookMatcher[]>>;

/** Attach render ids to a loaded config so rows survive re-renders. */
function toEditable(config: HooksConfiguration): EditableHooks {
  const out: EditableHooks = {};
  for (const [event, matchers] of Object.entries(config) as [HookEvent, HookMatcher[]][]) {
    if (!Array.isArray(matchers)) continue;
    out[event] = matchers.map((m) => ({
      ...m,
      id: HooksManager.generateId(),
      // Expanded on load: the first question anyone opening this screen has
      // is "what is configured?", and collapsed cards answer it with a
      // chevron. Configs are a handful of entries, not hundreds.
      expanded: true,
      hooks: (m.hooks ?? []).map((h) => ({ ...h, id: HooksManager.generateId() })),
    }));
  }
  return out;
}

/** Strip render ids back out. Events with no entries are omitted entirely so
 *  saving an emptied event removes the key rather than writing `[]`. */
function toConfig(editable: EditableHooks): HooksConfiguration {
  const out: HooksConfiguration = {};
  for (const [event, matchers] of Object.entries(editable) as [HookEvent, EditableHookMatcher[]][]) {
    if (!matchers || matchers.length === 0) continue;
    out[event] = matchers.map(({ id: _id, expanded: _expanded, ...m }) => ({
      ...m,
      hooks: m.hooks.map(({ id: _cid, ...h }) => h),
    }));
  }
  return out;
}

export const HooksEditor: React.FC<HooksEditorProps> = ({
  projectPath,
  configDir,
  scope,
  readOnly = false,
  className,
  onChange,
  hideActions = false
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<HookEvent>('PreToolUse');
  const [editableHooks, setEditableHooks] = useState<EditableHooks>({});

  const entries = editableHooks[selectedEvent] ?? [];
  const eventInfo = HOOK_EVENT_INFO[selectedEvent];
  const supportsMatcher = eventSupportsMatcher(selectedEvent);

  /** Mutate one event's entries and mark the form dirty. */
  const updateEntries = useCallback(
    (event: HookEvent, fn: (prev: EditableHookMatcher[]) => EditableHookMatcher[]) => {
      setEditableHooks((prev) => ({ ...prev, [event]: fn(prev[event] ?? []) }));
      setHasUnsavedChanges(true);
    },
    [],
  );

  // Load hooks when scope/project/config dir changes.
  useEffect(() => {
    if (scope !== 'user' && !projectPath) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setLoadError(null);
    let cancelled = false;
    api.getHooksConfig(scope, projectPath, configDir)
      .then((config) => {
        if (cancelled) return;
        setEditableHooks(toEditable(config ?? {}));
        setHasUnsavedChanges(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Failed to load hooks configuration:", err);
        setLoadError(err instanceof Error ? err.message : "Failed to load hooks configuration");
        setEditableHooks({});
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [scope, projectPath, configDir]);

  const currentConfig = useMemo(() => toConfig(editableHooks), [editableHooks]);

  // Notify the parent so it can drive its own save button.
  useEffect(() => {
    onChange?.(hasUnsavedChanges, () => toConfig(editableHooks));
  }, [hasUnsavedChanges, editableHooks, onChange]);

  const validateHooks = useCallback(async () => {
    const result = await HooksManager.validateConfig(currentConfig);
    setValidationErrors(result.errors.map(e => `${e.event}: ${e.message}`));
    setValidationWarnings(
      result.warnings.map(w => `${w.message} in command: ${(w.command || '').substring(0, 50)}…`),
    );
  }, [currentConfig]);

  useEffect(() => {
    logAndForget('hooks-editor:validate-hooks', validateHooks());
  }, [validateHooks]);

  const handleSave = async () => {
    if (scope !== 'user' && !projectPath) return;
    setIsSaving(true);
    try {
      await api.updateHooksConfig(scope, currentConfig, projectPath, configDir);
      setHasUnsavedChanges(false);
    } catch (error) {
      console.error('Failed to save hooks:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to save hooks');
    } finally {
      setIsSaving(false);
    }
  };

  const addMatcher = (event: HookEvent) => {
    updateEntries(event, (prev) => [
      ...prev,
      { id: HooksManager.generateId(), matcher: '', hooks: [], expanded: true },
    ]);
  };

  const updateMatcher = (event: HookEvent, matcherId: string, updates: Partial<EditableHookMatcher>) => {
    updateEntries(event, (prev) =>
      prev.map((m) => (m.id === matcherId ? { ...m, ...updates } : m)),
    );
  };

  const removeMatcher = (event: HookEvent, matcherId: string) => {
    updateEntries(event, (prev) => prev.filter((m) => m.id !== matcherId));
  };

  const addCommand = (event: HookEvent, matcherId: string) => {
    updateEntries(event, (prev) =>
      prev.map((m) =>
        m.id === matcherId
          ? {
              ...m,
              hooks: [...m.hooks, { id: HooksManager.generateId(), type: 'command' as const, command: '' }],
            }
          : m,
      ),
    );
  };

  const updateCommand = (
    event: HookEvent,
    matcherId: string,
    commandId: string,
    updates: Partial<EditableHookCommand>,
  ) => {
    updateEntries(event, (prev) =>
      prev.map((m) =>
        m.id === matcherId
          ? { ...m, hooks: m.hooks.map((c) => (c.id === commandId ? { ...c, ...updates } : c)) }
          : m,
      ),
    );
  };

  const removeCommand = (event: HookEvent, matcherId: string, commandId: string) => {
    updateEntries(event, (prev) =>
      prev.map((m) =>
        m.id === matcherId ? { ...m, hooks: m.hooks.filter((c) => c.id !== commandId) } : m,
      ),
    );
  };

  const applyTemplate = (template: HookTemplate) => {
    updateEntries(template.event, (prev) => [
      ...prev,
      {
        id: HooksManager.generateId(),
        matcher: template.matcher,
        hooks: template.commands.map((cmd) => ({
          id: HooksManager.generateId(),
          type: 'command' as const,
          command: cmd,
        })),
        expanded: true,
      },
    ]);
    setSelectedEvent(template.event);
    setShowTemplateDialog(false);
  };

  const renderMatcher = (event: HookEvent, matcher: EditableHookMatcher) => {
    const info = HOOK_EVENT_INFO[event];
    const matcherInfo = info.matcher;
    return (
    <Card key={matcher.id} className="p-4 space-y-4">
      <div className="flex items-start gap-4">
        <Button
          variant="ghost"
          size="sm"
          className="p-0 h-6 w-6"
          aria-label={matcher.expanded ? 'Collapse hook' : 'Expand hook'}
          onClick={() => { updateMatcher(event, matcher.id, { expanded: !matcher.expanded }); }}
        >
          {matcher.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>

        <div className="flex-1 space-y-2">
          {matcherInfo ? (
            <>
              <div className="flex items-center gap-2">
                <Label htmlFor={`matcher-${matcher.id}`}>{matcherInfo.hint}</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Leave empty to match everything this event fires on.</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              <div className="flex items-center gap-2">
                <Input
                  id={`matcher-${matcher.id}`}
                  placeholder={`e.g. ${matcherInfo.examples.slice(0, 3).join(', ')}`}
                  value={matcher.matcher || ''}
                  onChange={(e) => { updateMatcher(event, matcher.id, { matcher: e.target.value }); }}
                  disabled={readOnly}
                  className="flex-1"
                />

                <Select
                  value={matcher.matcher || 'custom'}
                  onValueChange={(value) => {
                    if (value !== 'custom') updateMatcher(event, matcher.id, { matcher: value });
                  }}
                  disabled={readOnly}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Common values" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">Custom</SelectItem>
                    {matcherInfo.examples.map(pattern => (
                      <SelectItem key={pattern} value={pattern}>{pattern}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {!readOnly && (
                  <Button variant="ghost" size="sm" onClick={() => { removeMatcher(event, matcher.id); }}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </>
          ) : (
            // The CLI ignores `matcher` on this event, so offering the field
            // would invite a filter that silently does nothing.
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {info.label} always fires — no matcher.
              </p>
              {!readOnly && (
                <Button variant="ghost" size="sm" onClick={() => { removeMatcher(event, matcher.id); }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {matcher.expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-4 pl-10"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Commands</Label>
                {!readOnly && (
                  <Button variant="outline" size="sm" onClick={() => { addCommand(event, matcher.id); }}>
                    <Plus className="h-3 w-3 mr-1" />
                    Add Command
                  </Button>
                )}
              </div>

              {matcher.hooks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No commands added yet</p>
              ) : (
                <div className="space-y-2">
                  {matcher.hooks.map((hook) => (
                    <div key={hook.id} className="space-y-2">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 space-y-2">
                          <Textarea
                            placeholder="Enter shell command..."
                            value={hook.command || ''}
                            onChange={(e) => { updateCommand(event, matcher.id, hook.id, { command: e.target.value }); }}
                            disabled={readOnly}
                            className="font-mono text-sm min-h-[80px]"
                          />

                          <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                              <Clock className="h-3 w-3 text-muted-foreground" />
                              <Input
                                type="number"
                                placeholder="60"
                                value={hook.timeout || ''}
                                onChange={(e) => { updateCommand(event, matcher.id, hook.id, {
                                  timeout: e.target.value ? parseInt(e.target.value) : undefined
                                }); }}
                                disabled={readOnly}
                                className="w-20 h-8"
                              />
                              <span className="text-sm text-muted-foreground">seconds</span>
                            </div>

                            {!readOnly && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { removeCommand(event, matcher.id, hook.id); }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>

                      {(() => {
                        const warnings = HooksManager.checkDangerousPatterns(hook.command || '');
                        return warnings.length > 0 && (
                          <div className="flex items-start gap-2 p-2 bg-yellow-500/10 rounded-md">
                            <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5" />
                            <div className="space-y-1">
                              {warnings.map((warning, i) => (
                                <p key={i} className="text-xs text-yellow-600">{warning}</p>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
    );
  };

  return (
    <div className={cn("space-y-6", className)}>
      {isLoading && (
        <div className="flex items-center justify-center p-8">
          <Spinner className="size-6 mr-2" />
          <span className="text-sm text-muted-foreground">Loading hooks configuration...</span>
        </div>
      )}

      {loadError && !isLoading && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {loadError}
        </div>
      )}

      {!isLoading && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Hooks Configuration</h3>
              <div className="flex items-center gap-2">
                <Badge variant={scope === 'project' ? 'secondary' : scope === 'local' ? 'outline' : 'default'}>
                  {scope === 'project' ? 'Project' : scope === 'local' ? 'Local' : 'User'} Scope
                </Badge>
                {!readOnly && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => { setShowTemplateDialog(true); }}>
                      <FileText className="h-4 w-4 mr-2" />
                      Templates
                    </Button>
                    {!hideActions && (
                      <Button
                        variant={hasUnsavedChanges ? "default" : "outline"}
                        size="sm"
                        onClick={fireAndLog('hooks-editor:click', handleSave)}
                        disabled={!hasUnsavedChanges || isSaving || (scope !== 'user' && !projectPath)}
                      >
                        {isSaving ? <Spinner className="mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                        {isSaving ? "Saving..." : "Save"}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Configure shell commands to execute at various points in Claude Code's lifecycle.
              {scope === 'local' && ' These settings are not committed to version control.'}
            </p>
            {hasUnsavedChanges && !readOnly && (
              <p className="text-sm text-amber-600">
                You have unsaved changes. Click Save to persist them.
              </p>
            )}
          </div>

          {validationErrors.length > 0 && (
            <div className="p-3 bg-red-500/10 rounded-md space-y-1">
              <p className="text-sm font-medium text-red-600">Validation Errors:</p>
              {validationErrors.map((error, i) => (
                <p key={i} className="text-xs text-red-600">• {error}</p>
              ))}
            </div>
          )}

          {validationWarnings.length > 0 && (
            <div className="p-3 bg-yellow-500/10 rounded-md space-y-1">
              <p className="text-sm font-medium text-yellow-600">Security Warnings:</p>
              {validationWarnings.map((warning, i) => (
                <p key={i} className="text-xs text-yellow-600">• {warning}</p>
              ))}
            </div>
          )}

          {/* Event picker. A tab strip held five events; there are 31, so the
              selector is a grouped dropdown. Counts ride on each item —
              otherwise there is no way to find which of 31 events you have
              hooks on without opening each one. */}
          <div className="space-y-2">
            <Label htmlFor="hook-event">Event</Label>
            <div className="flex items-center gap-3">
              <Select
                value={selectedEvent}
                onValueChange={(v) => { setSelectedEvent(v as HookEvent); }}
              >
                <SelectTrigger id="hook-event" className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[60vh]">
                  {groupedHookEvents().map(([group, events]) => (
                    <React.Fragment key={group}>
                      <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {group}
                      </div>
                      {events.map((event) => {
                        const count = editableHooks[event]?.length ?? 0;
                        return (
                          <SelectItem key={event} value={event}>
                            <span className="flex items-center gap-2">
                              {HOOK_EVENT_INFO[event].label}
                              {count > 0 && (
                                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                                  {count}
                                </Badge>
                              )}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">{eventInfo.description}</p>
            </div>
          </div>

          <div className="space-y-4">
            {entries.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="text-muted-foreground mb-4">No hooks configured for this event</p>
                {!readOnly && (
                  <Button onClick={() => { addMatcher(selectedEvent); }}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Hook
                  </Button>
                )}
              </Card>
            ) : (
              <div className="space-y-4">
                {entries.map(matcher => renderMatcher(selectedEvent, matcher))}

                {!readOnly && (
                  <Button
                    variant="outline"
                    onClick={() => { addMatcher(selectedEvent); }}
                    className="w-full"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Another {supportsMatcher ? 'Matcher' : 'Hook'}
                  </Button>
                )}
              </div>
            )}
          </div>

          <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
            <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Hook Templates</DialogTitle>
                <DialogDescription>
                  Choose a pre-configured hook template to get started quickly
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                {HOOK_TEMPLATES.map(template => (
                  <Card
                    key={template.id}
                    className="p-4 cursor-pointer hover:bg-accent"
                    onClick={() => { applyTemplate(template); }}
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="font-medium">{template.name}</h4>
                        <Badge>{HOOK_EVENT_INFO[template.event].label}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{template.description}</p>
                      {template.matcher && (
                        <p className="text-xs font-mono bg-muted px-2 py-1 rounded inline-block">
                          Matcher: {template.matcher}
                        </p>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
};
