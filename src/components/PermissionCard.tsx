import { useEffect, useMemo, useState } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, Clock, Shield, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import {
  DEFAULT_SCOPE,
  SCOPE_OPTIONS,
  type ScopeValue,
  buildPersistedSuggestion,
  buildSessionSuggestion,
  getInitialRuleString,
  type IncomingSuggestion,
} from "@/lib/permissionCardLogic";
import type { PermissionRequestPayload } from "@/lib/types/permissionRequest";
import { asToolInput } from "@/lib/types/toolInput";

interface PermissionCardProps {
  request: PermissionRequestPayload;
  onAllow: (selectedSuggestions: IncomingSuggestion[]) => void;
  onDeny: () => void;
}

/**
 * Pick a one-line "headline" string from a tool's input for the
 * permission-prompt preview. When the tool name is one we model in
 * `ToolInputByName`, the field selection is driven by the SDK's
 * typed schema (no field-name guessing). For MCP and other tools
 * outside the map, a generic field-probe fallback preserves the
 * pre-typed behavior so unknown tools still surface a useful label.
 */
function formatToolInput(toolName: string | undefined, input: Record<string, unknown>): string {
  const bash = asToolInput(toolName, 'Bash', input);
  if (bash?.command) return bash.command;

  const read = asToolInput(toolName, 'Read', input);
  if (read?.file_path) return read.file_path;
  const write = asToolInput(toolName, 'Write', input);
  if (write?.file_path) return write.file_path;
  const edit = asToolInput(toolName, 'Edit', input);
  if (edit?.file_path) return edit.file_path;
  const multiEdit = asToolInput(toolName, 'MultiEdit', input);
  if (multiEdit?.file_path) return multiEdit.file_path;

  const grep = asToolInput(toolName, 'Grep', input);
  if (grep?.pattern) return grep.pattern;
  const glob = asToolInput(toolName, 'Glob', input);
  if (glob?.pattern) return glob.pattern;

  const webFetch = asToolInput(toolName, 'WebFetch', input);
  if (webFetch?.url) return webFetch.url;

  // Unknown / MCP / future tools: generic field probe keeps the card
  // functional for anything not in our typed map.
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  return JSON.stringify(input, null, 2);
}

export function PermissionCard({ request, onAllow, onDeny }: PermissionCardProps) {
  const {
    toolName,
    toolInput,
    title,
    displayName,
    description,
    decisionReason,
    suggestions,
  } = request;
  const { config } = useMessageRenderingConfig();
  const accentStyle = accentStyleFor(config, "permission.request");
  const accentSwatch = swatchFor(config, "permission.request");

  const initialRule = useMemo(
    () => getInitialRuleString(suggestions[0], toolName),
    [suggestions, toolName],
  );
  const [rule, setRule] = useState(initialRule);
  const [scope, setScope] = useState<ScopeValue>(DEFAULT_SCOPE);

  useEffect(() => {
    setRule(initialRule);
    setScope(DEFAULT_SCOPE);
  }, [initialRule]);

  const activeScope =
    SCOPE_OPTIONS.find((o) => o.value === scope) ?? SCOPE_OPTIONS[0];

  const handleSaveForSession = () => onAllow([buildSessionSuggestion(rule)]);
  const handleSavePermission = () =>
    onAllow([buildPersistedSuggestion(rule, scope)]);

  return (
    <div
      className="mx-2 my-2 rounded-lg border shadow-sm"
      style={accentStyle}
    >
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-2">
          <Shield className="h-4 w-4 mt-0.5 shrink-0" style={{ color: accentSwatch }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">
              {title || "Permission required"}
            </div>
            <div className="text-xs text-muted-foreground">
              {description || (
                <>
                  Claude wants to use{" "}
                  <span className="font-mono text-foreground">
                    {displayName || toolName}
                  </span>
                </>
              )}
            </div>
            {decisionReason && (
              <p className="text-xs text-muted-foreground mt-1">{decisionReason}</p>
            )}
          </div>
        </div>

        {/* Tool input preview */}
        <div className="max-h-32 overflow-auto rounded-md border border-border bg-muted/30 p-2">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
            {formatToolInput(toolName, toolInput)}
          </pre>
        </div>

        {/* Editable rule */}
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Rule
          </label>
          <input
            type="text"
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            placeholder="e.g. Bash(git:*) or Read"
            spellCheck={false}
            className={cn(
              "w-full h-8 px-2.5 rounded-md",
              "bg-black text-white placeholder:text-white/40",
              "border border-white/10",
              "text-xs font-mono",
              "outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20",
            )}
          />
        </div>

        {/* Scope combobox */}
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Save to
          </label>
          <Select value={scope} onValueChange={(v) => setScope(v as ScopeValue)}>
            <SelectTrigger className="h-auto py-2">
              <SelectValue>
                <div className="flex flex-col items-start text-left">
                  <span className="text-xs font-medium">{activeScope.label}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {activeScope.description}
                  </span>
                </div>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SCOPE_OPTIONS.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className={cn(
                    "relative flex w-full cursor-default select-none flex-col items-start gap-0.5 rounded-sm py-2 pl-2 pr-8 outline-none",
                    "focus:bg-accent focus:text-accent-foreground",
                    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                  )}
                >
                  <span className="absolute right-2 top-2 flex h-3.5 w-3.5 items-center justify-center">
                    <SelectPrimitive.ItemIndicator>
                      <Check className="h-4 w-4" />
                    </SelectPrimitive.ItemIndicator>
                  </span>
                  <SelectPrimitive.ItemText>
                    <span className="text-xs font-medium">{option.label}</span>
                  </SelectPrimitive.ItemText>
                  <span className="text-[11px] text-muted-foreground">
                    {option.description}
                  </span>
                </SelectPrimitive.Item>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            size="sm"
            variant="destructive"
            className="text-xs"
            onClick={onDeny}
          >
            <ShieldX className="h-3.5 w-3.5 mr-1" />
            Deny
          </Button>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="text-xs"
              onClick={handleSaveForSession}
              disabled={!rule.trim()}
            >
              <Clock className="h-3.5 w-3.5 mr-1" />
              Allow for Session
            </Button>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
              onClick={handleSavePermission}
              disabled={!rule.trim()}
            >
              <ShieldCheck className="h-3.5 w-3.5 mr-1" />
              Save Permission
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
