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
  firstRuleSuggestion,
  buildCommandPreview,
  commandPreviewWarning,
  type IncomingSuggestion,
} from "@/lib/permissionCardLogic";
import type { PermissionRequestPayload } from "@/lib/types/permissionRequest";
import { asToolInput, toolInputString } from "@/lib/types/toolInput";
import { CodexPatchPreview } from "@/components/codex/CodexPatchPreview";
import { CodexExecPreview } from "@/components/codex/CodexExecPreview";
import type { JSX } from 'react';

interface PermissionCardProps {
  request: PermissionRequestPayload;
  onAllow: (selectedSuggestions: IncomingSuggestion[]) => void;
  onDeny: () => void;
}

/**
 * Pick a one-line "headline" string from a tool's input for the
 * permission-prompt preview. When the tool name is one we model in
 * `ToolInputByName`, the field selection is driven by the CLI's
 * typed schema (no field-name guessing). For MCP and other tools
 * outside the map, a generic field-probe fallback preserves the
 * pre-typed behavior so unknown tools still surface a useful label.
 */
function formatToolInput(toolName: string | undefined, input: Record<string, unknown>): string {
  // Every branch runs its field through `toolInputString`. The typed map is a
  // compile-time contract only: Claude can emit a non-string `command` /
  // `file_path` / pattern (Claude Code 2.1.229 fixed its own crash on exactly
  // that), and returning one here as a declared `string` reaches
  // `buildCommandPreview`'s `raw.replace(...)` as a TypeError — which takes the
  // card down, and with it the Allow/Deny the session is waiting on. A field
  // that fails the guard falls through to the JSON dump at the bottom.
  const bash = toolInputString(asToolInput(toolName, 'Bash', input)?.command);
  if (bash) return bash;

  const read = toolInputString(asToolInput(toolName, 'Read', input)?.file_path);
  if (read) return read;
  const write = toolInputString(asToolInput(toolName, 'Write', input)?.file_path);
  if (write) return write;
  const edit = toolInputString(asToolInput(toolName, 'Edit', input)?.file_path);
  if (edit) return edit;
  const multiEdit = toolInputString(asToolInput(toolName, 'MultiEdit', input)?.file_path);
  if (multiEdit) return multiEdit;

  const grep = toolInputString(asToolInput(toolName, 'Grep', input)?.pattern);
  if (grep) return grep;
  const glob = toolInputString(asToolInput(toolName, 'Glob', input)?.pattern);
  if (glob) return glob;

  // LS uses `path`, not `file_path` — the generic field probe below
  // wouldn't pick it up, so a permission request for LS would render
  // as raw JSON without this branch.
  const ls = toolInputString(asToolInput(toolName, 'LS', input)?.path);
  if (ls) return ls;

  const webFetch = toolInputString(asToolInput(toolName, 'WebFetch', input)?.url);
  if (webFetch) return webFetch;

  // Unknown / MCP / future tools: generic field probe keeps the card
  // functional for anything not in our typed map.
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  return JSON.stringify(input, null, 2);
}

export function PermissionCard({ request, onAllow, onDeny }: PermissionCardProps) {
  // Codex `patch` / `exec` approvals have a fundamentally different shape
  // than Claude's `canUseTool` payload — no tool name to format, no rules
  // to edit, no scope persistence (Codex's protocol has no per-rule store).
  // Render a kind-specific preview card with a simple Allow / Deny pair.
  if (request.kind === 'patch' || request.kind === 'exec') {
    return (
      <CodexPermissionCard
        request={request}
        onAllow={onAllow}
        onDeny={onDeny}
      />
    );
  }

  const {
    toolName,
    toolInput,
    title,
    displayName,
    description,
    decisionReason,
    suggestions,
    suppressAlwaysAllowRule,
  } = request;
  const { config } = useMessageRenderingConfig();
  const accentStyle = accentStyleFor(config, "permission.request");
  const accentSwatch = swatchFor(config, "permission.request");

  const initialRule = useMemo(
    () => getInitialRuleString(firstRuleSuggestion(suggestions), toolName),
    [suggestions, toolName],
  );
  const [rule, setRule] = useState(initialRule);
  const [scope, setScope] = useState<ScopeValue>(DEFAULT_SCOPE);

  const inputPreview = useMemo(
    () => buildCommandPreview(formatToolInput(toolName, toolInput)),
    [toolName, toolInput],
  );
  const previewWarning = useMemo(
    () => commandPreviewWarning(inputPreview),
    [inputPreview],
  );

  useEffect(() => {
    setRule(initialRule);
    setScope(DEFAULT_SCOPE);
  }, [initialRule]);

  const activeScope =
    SCOPE_OPTIONS.find((o) => o.value === scope) ?? SCOPE_OPTIONS[0];

  const handleSaveForSession = () => { onAllow([buildSessionSuggestion(rule)]); };
  const handleSavePermission = () =>
    { onAllow([buildPersistedSuggestion(rule, scope)]); };
  // No suggestions at all: allow this one use and persist nothing.
  const handleAllowOnce = () => { onAllow([]); };

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

        {/* Tool input preview. Escaped, never raw: this card is the only
            approval surface, so a command must display as what will run. */}
        <div className="rounded-md border border-border bg-muted/30">
          <div className="max-h-32 overflow-auto p-2">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all">
              {inputPreview.text}
            </pre>
          </div>
          {previewWarning && (
            <p
              data-testid="permission-preview-warning"
              className="border-t border-border px-2 py-1 text-[11px] text-amber-500"
            >
              {previewWarning}
            </p>
          )}
        </div>

        {/* The CLI vetoed any standing grant for this ask — a rule saved
            here would cover more than what is being approved. Say so rather
            than silently dropping the controls. */}
        {suppressAlwaysAllowRule && (
          <p
            data-testid="permission-no-standing-rule"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-500"
          >
            Claude Code won&apos;t let this one be saved as a rule — approving
            it would grant more than this request covers. Allow it once, or
            deny.
          </p>
        )}

        {/* Editable rule */}
        {!suppressAlwaysAllowRule && (
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Rule
          </label>
          <input
            type="text"
            value={rule}
            onChange={(e) => { setRule(e.target.value); }}
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
        )}

        {/* Scope combobox */}
        {!suppressAlwaysAllowRule && (
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Save to
          </label>
          <Select value={scope} onValueChange={(v) => { setScope(v as ScopeValue); }}>
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
        )}

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
            {suppressAlwaysAllowRule ? (
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                onClick={handleAllowOnce}
              >
                <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                Allow once
              </Button>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Codex approval card. Renders the kind-specific preview (patch diff or
 * shell-command) and a plain Allow / Deny pair. Codex's protocol has no
 * per-rule persistence — there's no "Allow for Session" vs "Save
 * Permission" distinction here. The session-suggestion shape passed to
 * `onAllow` is empty so the response routes through the engine's plain
 * `decision: 'allow'` path.
 *
 * Lives inside PermissionCard.tsx (not its own file) because the dialog
 * shell — accent style, header, Allow / Deny button row — is shared with
 * Claude's tool prompt; only the middle preview swaps out.
 */
function CodexPermissionCard({
  request,
  onAllow,
  onDeny,
}: PermissionCardProps): JSX.Element {
  const { config } = useMessageRenderingConfig();
  const accentStyle = accentStyleFor(config, "permission.request");
  const accentSwatch = swatchFor(config, "permission.request");

  const isPatch = request.kind === 'patch';
  const headerTitle = isPatch ? 'Codex patch approval' : 'Codex command approval';
  const headerDescription =
    request.summary ||
    (isPatch ? 'Codex wants to apply a patch' : 'Codex wants to run a command');

  return (
    <div
      className="mx-2 my-2 rounded-lg border shadow-sm"
      style={accentStyle}
      data-codex-permission-card={request.kind}
    >
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-2">
          <Shield className="h-4 w-4 mt-0.5 shrink-0" style={{ color: accentSwatch }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{headerTitle}</div>
            <div className="text-xs text-muted-foreground">
              {headerDescription}
            </div>
          </div>
        </div>

        {/* Kind-specific preview */}
        {isPatch ? (
          <CodexPatchPreview payload={request.payload} />
        ) : (
          <CodexExecPreview payload={request.payload} />
        )}

        {/* Allow / Deny */}
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
          <Button
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
            onClick={() => { onAllow([]); }}
          >
            <ShieldCheck className="h-3.5 w-3.5 mr-1" />
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}
