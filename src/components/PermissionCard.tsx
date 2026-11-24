import { useEffect, useMemo, useState } from "react";
import { useLayoutMode } from '@/hooks/useLayoutMode';
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
import { accentStyleFor, cardRadiusStyle, swatchFor } from "@/lib/accentStyle";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import {
  DEFAULT_SCOPE,
  SCOPE_OPTIONS,
  type ScopeValue,
  buildPersistedSuggestion,
  buildSessionSuggestion,
  buildDirectoryGrant,
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

export function formatToolInput(toolName: string | undefined, input: Record<string, unknown>): string {
  // Every field goes through toolInputString: the CLI can emit non-strings here, and one reaching
  // buildCommandPreview's `raw.replace` crashes the card and its Allow/Deny.
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

  // LS uses `path`, which the generic probe below misses.
  const ls = toolInputString(asToolInput(toolName, 'LS', input)?.path);
  if (ls) return ls;

  const webFetch = toolInputString(asToolInput(toolName, 'WebFetch', input)?.url);
  if (webFetch) return webFetch;

  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  return JSON.stringify(input, null, 2);
}

export function PermissionCard({ request, onAllow, onDeny }: PermissionCardProps) {
  if (request.kind === 'patch' || request.kind === 'exec') {
    return (
      <CodexPermissionCard
        request={request}
        onAllow={onAllow}
        onDeny={onDeny}
      />
    );
  }

  return <ClaudePermissionCard request={request} onAllow={onAllow} onDeny={onDeny} />;
}

// Separate component so its hooks never sit after PermissionCard's Codex early return.
function ClaudePermissionCard({ request, onAllow, onDeny }: PermissionCardProps) {
  const layout = useLayoutMode();
  const {
    toolName,
    toolInput,
    title,
    displayName,
    description,
    decisionReason,
    suggestions,
    suppressAlwaysAllowRule,
    directoryGrant,
  } = request;
  // A symlink escape needs a folder grant: no Edit(...) rule stops the CLI re-asking.
  const grantsFolders = !suppressAlwaysAllowRule && !!directoryGrant && directoryGrant.length > 0;
  const { config } = useMessageRenderingConfig();
  const accentStyle = { ...accentStyleFor(config, "permission.request"), ...cardRadiusStyle(config) };
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

  const handleSaveForSession = () => {
    onAllow([grantsFolders ? buildDirectoryGrant(directoryGrant, 'session') : buildSessionSuggestion(rule)]);
  };
  const handleSavePermission = () => {
    onAllow([grantsFolders ? buildDirectoryGrant(directoryGrant, scope) : buildPersistedSuggestion(rule, scope)]);
  };
  const handleAllowOnce = () => { onAllow([]); };

  return (
    <div
      className="mx-2 my-2 rounded-lg border shadow-sm"
      style={accentStyle}
    >
      <div className="p-3 space-y-3">
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

        {/* Escaped, never raw: this card is the only approval surface. */}
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

        {suppressAlwaysAllowRule && (
          <p
            data-testid="permission-no-standing-rule"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-500"
          >
            Claude Code offers no rule for this one — a saved rule would
            grant more than this request covers, or wouldn&apos;t allow it
            again. Allow it once, or deny.
          </p>
        )}

        {grantsFolders && (
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Allow writes in
          </label>
          <ul className="rounded-md border border-border bg-muted/30 p-2 space-y-0.5">
            {directoryGrant.map((d) => (
              <li key={d} className="text-xs font-mono break-all">{d}</li>
            ))}
          </ul>
        </div>
        )}

        {!suppressAlwaysAllowRule && !grantsFolders && (
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

        <div
          className={cn(
            'flex items-center justify-between gap-2 pt-1',
            // Deny last on touch, so the destructive choice isn't under a resting thumb.
            layout.touch && 'flex-col-reverse items-stretch gap-2 pt-2 [&_button]:min-h-12 [&_button]:text-sm [&_button]:justify-center',
          )}
        >
          <Button
            size="sm"
            variant="destructive"
            className="text-xs"
            onClick={onDeny}
          >
            <ShieldX className="h-3.5 w-3.5 mr-1" />
            Deny
          </Button>
          <div className={cn('flex gap-2', layout.touch && 'flex-col items-stretch')}>
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
                  disabled={!grantsFolders && !rule.trim()}
                >
                  <Clock className="h-3.5 w-3.5 mr-1" />
                  Allow for Session
                </Button>
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                  onClick={handleSavePermission}
                  disabled={!grantsFolders && !rule.trim()}
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

/** Codex has no per-rule persistence: Allow sends no suggestions, the engine's plain allow path. */
function CodexPermissionCard({
  request,
  onAllow,
  onDeny,
}: PermissionCardProps): JSX.Element {
  const { config } = useMessageRenderingConfig();
  const accentStyle = { ...accentStyleFor(config, "permission.request"), ...cardRadiusStyle(config) };
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
        <div className="flex items-start gap-2">
          <Shield className="h-4 w-4 mt-0.5 shrink-0" style={{ color: accentSwatch }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{headerTitle}</div>
            <div className="text-xs text-muted-foreground">
              {headerDescription}
            </div>
          </div>
        </div>

        {isPatch ? (
          <CodexPatchPreview payload={request.payload} />
        ) : (
          <CodexExecPreview payload={request.payload} />
        )}

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
