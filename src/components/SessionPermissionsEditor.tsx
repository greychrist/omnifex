import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, RefreshCw, ChevronDown, ChevronUp, Shield, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";
import { unmatchedFileRuleWarning } from "@/lib/permissionCardLogic";
import { diffLiveRules, describeRule } from "@/lib/livePermissionRules";
import type { CliPermissionRulesState } from "@/lib/api";
interface PermissionLevel {
  label: string;
  scope: "user" | "project" | "local";
  path: string;
  allow: string[];
  deny: string[];
}

interface SessionPermissionsEditorProps {
  tabId: string;
  projectPath: string;
  configDir: string;
}

export function SessionPermissionsEditor({
  tabId,
  projectPath,
  configDir,
}: SessionPermissionsEditorProps) {
  const [levels, setLevels] = useState<PermissionLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLevels, setExpandedLevels] = useState<Set<string>>(new Set(["user", "project", "local"]));
  const [newRule, setNewRule] = useState<{ scope: string; behavior: "allow" | "deny"; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // The CLI's own view of the live session. `null` means it gave no answer —
  // a TUI tab (no control channel) or a CLI older than 2.1.269 — in which case
  // the file-derived view above stands alone, exactly as it always did.
  const [liveRules, setLiveRules] = useState<CliPermissionRulesState | null>(null);

  const loadPermissions = useCallback(async () => {
    try {
      const result = await api.sessionGetPermissions(tabId, projectPath, configDir);
      setLevels(result ?? []);
      // Best-effort and deliberately not awaited into the failure path above:
      // the file view is the contract, this only annotates it.
      try {
        setLiveRules(await api.sessionListPermissionRules(tabId));
      } catch {
        setLiveRules(null);
      }
    } catch (err) {
      console.error("Failed to load permissions:", err);
    } finally {
      setLoading(false);
    }
  }, [tabId, projectPath, configDir]);

  useEffect(() => {
    logAndForget('session-permissions-editor:load-permissions', loadPermissions());
  }, [loadPermissions]);

  const toggleLevel = (scope: string) => {
    setExpandedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const handleRemoveRule = async (scope: string, behavior: "allow" | "deny", rule: string) => {
    setSaving(true);
    try {
      await api.sessionUpdatePermission(tabId, projectPath, configDir, {
        action: "remove",
        scope,
        behavior,
        rule,
      });
      await loadPermissions();
    } catch (err) {
      console.error("Failed to remove permission:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleAddRule = async () => {
    if (!newRule?.value.trim()) return;
    setSaving(true);
    try {
      await api.sessionUpdatePermission(tabId, projectPath, configDir, {
        action: "add",
        scope: newRule.scope,
        behavior: newRule.behavior,
        rule: newRule.value.trim(),
      });
      setNewRule(null);
      await loadPermissions();
    } catch (err) {
      console.error("Failed to add permission:", err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const totalRules = levels.reduce((sum, l) => sum + l.allow.length + l.deny.length, 0);
  const live = diffLiveRules(liveRules);
  const hasLiveDelta = live.hidden.length > 0 || live.ignored.length > 0 || live.managedOnly;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">
          {totalRules} rule{totalRules !== 1 ? "s" : ""} across {levels.length} level{levels.length !== 1 ? "s" : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setLoading(true); logAndForget('session-permissions-editor:load-permissions', loadPermissions()); }}
          className="h-7 px-2"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {/*
        What the settings files cannot tell us. The panel above is built by
        reading user/project/local settings, which sees only `allow` and `deny`
        from three of the CLI's eleven rule sources. This block is the live
        session's answer, and only ever shows the difference — rendering the
        whole rule set again would bury it.
      */}
      {hasLiveDelta && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Eye className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span className="text-xs font-medium">Active in this session, not shown above</span>
          </div>

          {live.managedOnly && (
            <p className="text-[11px] text-muted-foreground">
              Managed settings restrict this session to policy rules only. Rules from
              settings files are loaded but ignored.
            </p>
          )}

          {live.hidden.map((rule) => (
            <div key={`hidden-${rule.source}-${rule.behavior}-${rule.rule}`} className="flex items-start gap-2">
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 shrink-0 font-mono"
              >
                {rule.behavior}
              </Badge>
              <div className="min-w-0 flex-1">
                <code className="text-[11px] font-mono break-all block">{rule.rule}</code>
                <span className="text-[10px] text-muted-foreground">
                  {describeRule(rule)} &middot; {rule.source}
                  {rule.editability !== "persistent" && ` \u00b7 ${rule.editability}`}
                </span>
              </div>
            </div>
          ))}

          {live.ignored.length > 0 && (
            <div className="pt-1 space-y-1 border-t border-amber-500/20">
              <div className="flex items-center gap-2 pt-1">
                <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  Listed above but ignored by this session
                </span>
              </div>
              {live.ignored.map((rule) => (
                <code
                  key={`ignored-${rule.source}-${rule.behavior}-${rule.rule}`}
                  className="text-[11px] font-mono break-all block line-through text-muted-foreground pl-5"
                >
                  {rule.rule}
                </code>
              ))}
            </div>
          )}
        </div>
      )}

      {levels.map((level) => {
        const isExpanded = expandedLevels.has(level.scope);
        const ruleCount = level.allow.length + level.deny.length;

        return (
          <div key={level.scope} className="rounded-lg border border-border bg-card">
            <button
              onClick={() => { toggleLevel(level.scope); }}
              className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/50 transition-colors rounded-t-lg"
            >
              <Shield className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{level.label}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {level.scope}
                  </Badge>
                </div>
                <span className="text-[10px] text-muted-foreground truncate block">{level.path}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{ruleCount}</span>
                {isExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
            </button>

            {isExpanded && (
              <div className="border-t border-border px-3 pb-3 pt-2 space-y-1">
                {/* Allow rules */}
                {level.allow.map((rule) => (
                  <div
                    key={`allow-${rule}`}
                    className="flex items-center gap-2 group py-1"
                  >
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 bg-emerald-500/10 text-emerald-500 border-emerald-500/20 shrink-0"
                    >
                      allow
                    </Badge>
                    <span className="text-xs font-mono truncate flex-1" title={rule}>
                      {rule}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={fireAndLog('session-permissions-editor:click', () => handleRemoveRule(level.scope, "allow", rule))}
                      disabled={saving}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                ))}

                {/* Deny rules */}
                {level.deny.map((rule) => (
                  <div
                    key={`deny-${rule}`}
                    className="flex items-center gap-2 group py-1"
                  >
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 bg-destructive/10 text-destructive border-destructive/20 shrink-0"
                    >
                      deny
                    </Badge>
                    <span className="text-xs font-mono truncate flex-1" title={rule}>
                      {rule}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={fireAndLog('session-permissions-editor:click', () => handleRemoveRule(level.scope, "deny", rule))}
                      disabled={saving}
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  </div>
                ))}

                {ruleCount === 0 && (
                  <p className="text-xs text-muted-foreground py-1">No rules</p>
                )}

                {/* Add rule inline */}
                {newRule?.scope === level.scope ? (
                  <>
                  <div className="flex items-center gap-1.5 pt-1">
                    <Select
                      value={newRule.behavior}
                      onValueChange={(v) => { setNewRule({ ...newRule, behavior: v as "allow" | "deny" }); }}
                    >
                      <SelectTrigger className="h-7 text-[10px] w-auto">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="allow">allow</SelectItem>
                        <SelectItem value="deny">deny</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={newRule.value}
                      onChange={(e) => { setNewRule({ ...newRule, value: e.target.value }); }}
                      onKeyDown={(e) => { if (e.key === "Enter") logAndForget('session-permissions-editor:handle-add-rule', handleAddRule()); if (e.key === "Escape") setNewRule(null); }}
                      placeholder='e.g. Bash(git:*) or WebFetch(domain:example.com)'
                      className="h-7 text-xs font-mono flex-1"
                      autoFocus
                    />
                    <Button size="sm" className="h-7 px-2 text-xs" onClick={fireAndLog('session-permissions-editor:add-rule', handleAddRule)} disabled={saving || !newRule.value.trim()}>
                      Add
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setNewRule(null); }}>
                      Cancel
                    </Button>
                  </div>
                  {/* CLI ≥2.1.210 warns at startup for Write/NotebookEdit/Glob
                      path rules (never matched by file permission checks);
                      surface the same warning at authoring time. */}
                  {unmatchedFileRuleWarning(newRule.value) && (
                    <p className="text-[10px] text-amber-500 pt-1 font-mono">
                      {unmatchedFileRuleWarning(newRule.value)}
                    </p>
                  )}
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground mt-1"
                    onClick={() => { setNewRule({ scope: level.scope, behavior: "allow", value: "" }); }}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add Rule
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
