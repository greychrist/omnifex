import { useState, useEffect } from "react";
import { Shield, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

interface PermissionSuggestion {
  type: string;
  rules?: Array<{ toolName: string; ruleContent?: string }>;
  behavior?: string;
  destination?: string;
}

interface PermissionDialogProps {
  open: boolean;
  toolName: string;
  toolInput: Record<string, any>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  suggestions: PermissionSuggestion[];
  onAllow: (selectedSuggestions: PermissionSuggestion[]) => void;
  onDeny: () => void;
}

function formatDestination(dest?: string): string {
  switch (dest) {
    case 'userSettings': return 'User';
    case 'projectSettings': return 'Project (shared)';
    case 'localSettings': return 'Project (local)';
    case 'session': return 'Session';
    default: return dest || '';
  }
}

function formatToolInput(input: Record<string, any>): string {
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  return JSON.stringify(input, null, 2);
}

export function PermissionDialog({
  open,
  toolName,
  toolInput,
  title,
  displayName,
  description,
  decisionReason,
  suggestions,
  onAllow,
  onDeny,
}: PermissionDialogProps) {
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<number>>(new Set());
  // Editable copies: ruleContent per suggestion, destination per suggestion
  const [editedContent, setEditedContent] = useState<Map<number, string>>(new Map());
  const [editedDests, setEditedDests] = useState<Map<number, string>>(new Map());

  // Reset edits when suggestions change (new dialog opens)
  useEffect(() => {
    setSelectedSuggestions(new Set());
    setEditedContent(new Map());
    setEditedDests(new Map());
  }, [suggestions]);

  const toggleSuggestion = (idx: number) => {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  /** Get the display string for a suggestion: ToolName(ruleContent) */
  const getDisplayRule = (idx: number): string => {
    const s = suggestions[idx];
    if (!s.rules || s.rules.length === 0) return '';
    const r = s.rules[0];
    const content = editedContent.has(idx) ? editedContent.get(idx)! : (r.ruleContent ?? '');
    return content ? `${r.toolName}(${content})` : r.toolName;
  };

  /** Get the editable ruleContent for a suggestion */
  const getRuleContent = (idx: number): string => {
    if (editedContent.has(idx)) return editedContent.get(idx)!;
    const s = suggestions[idx];
    return s.rules?.[0]?.ruleContent ?? '';
  };

  const getToolName = (idx: number): string => {
    return suggestions[idx].rules?.[0]?.toolName ?? '';
  };

  const getDest = (idx: number): string => {
    if (editedDests.has(idx)) return editedDests.get(idx)!;
    return suggestions[idx].destination || 'localSettings';
  };

  /** Build the final suggestion preserving SDK structure with user edits */
  const buildEdited = (idx: number): PermissionSuggestion => {
    const original = suggestions[idx];
    const dest = getDest(idx);
    const content = getRuleContent(idx);
    const tName = getToolName(idx);
    return {
      ...original,
      type: 'addRules',
      rules: [{ toolName: tName, ruleContent: content || undefined }],
      destination: dest,
    };
  };

  const handleAllowForSession = () => {
    // Allow this tool use, no rules saved anywhere
    onAllow([]);
  };

  const handleAlwaysAllow = () => {
    // Allow and save the checked rules to their selected destinations
    const selected = [...selectedSuggestions].map((i) => buildEdited(i));
    onAllow(selected);
  };

  const handleDeny = () => {
    onDeny();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={() => { /* Only close via buttons — ignore outside clicks and Escape */ }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-yellow-500" />
            {title || `Permission Required`}
          </DialogTitle>
          <DialogDescription>
            {description || (
              <>Claude wants to use <span className="font-mono font-semibold text-foreground">{displayName || toolName}</span></>
            )}
          </DialogDescription>
        </DialogHeader>

        {decisionReason && (
          <p className="text-xs text-muted-foreground">{decisionReason}</p>
        )}

        {/* Tool input preview */}
        <div className="max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-3">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
            {formatToolInput(toolInput)}
          </pre>
        </div>

        {/* Permission suggestions */}
        {suggestions.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-medium">
              Save permission rule:
            </p>
            {suggestions.map((suggestion, idx) => {
              const isSelected = selectedSuggestions.has(idx);
              const dest = getDest(idx);
              const tName = getToolName(idx);
              const content = getRuleContent(idx);
              const displayRule = getDisplayRule(idx);

              return (
                <div
                  key={idx}
                  className={`p-2.5 rounded-md border transition-colors ${
                    isSelected
                      ? "border-emerald-500/50 bg-emerald-500/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSuggestion(idx)}
                      className="mt-0.5 rounded"
                    />
                    <div className="flex-1 min-w-0">
                      {isSelected ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1">
                            <span className="text-xs font-mono text-muted-foreground shrink-0">{tName}(</span>
                            <Input
                              value={content}
                              onChange={(e) => setEditedContent((prev) => new Map(prev).set(idx, e.target.value))}
                              onClick={(e) => e.stopPropagation()}
                              className="h-7 text-xs font-mono flex-1"
                              placeholder="e.g. git:* or *"
                            />
                            <span className="text-xs font-mono text-muted-foreground shrink-0">)</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground">{suggestion.behavior}</span>
                            <select
                              value={dest}
                              onChange={(e) => { e.stopPropagation(); setEditedDests((prev) => new Map(prev).set(idx, e.target.value)); }}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[10px] bg-muted border border-border rounded px-1.5 py-0.5"
                            >
                              <option value="localSettings">Project (local)</option>
                              <option value="projectSettings">Project (shared)</option>
                              <option value="userSettings">User</option>
                            </select>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="text-xs font-mono truncate">{displayRule}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {suggestion.behavior} &middot; {formatDestination(dest)}
                          </div>
                        </>
                      )}
                    </div>
                  </label>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="flex-row gap-2 sm:justify-between">
          <Button
            size="sm"
            variant="destructive"
            className="text-xs"
            onClick={handleDeny}
          >
            <ShieldX className="h-3.5 w-3.5 mr-1" />
            Deny
          </Button>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={handleAllowForSession}
            >
              <ShieldCheck className="h-3.5 w-3.5 mr-1" />
              Allow for Session
            </Button>
            <Button
              size="sm"
              disabled={selectedSuggestions.size === 0}
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs disabled:opacity-40"
              onClick={handleAlwaysAllow}
            >
              Always Allow
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
