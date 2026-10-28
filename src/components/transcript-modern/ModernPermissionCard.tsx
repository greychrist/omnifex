/**
 * A permission request in the Modern format — AI Elements' Confirmation.
 *
 * Same decisions as the classic PermissionCard, on the same logic
 * (`permissionCardLogic`): deny, allow once, allow for the session, or save a
 * rule. The rule and where it is saved sit behind "Change" rather than on the
 * card's face. Codex approvals and symlink folder grants keep the classic
 * card, which has the previews they need.
 */
import * as React from 'react';
import { ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { PermissionCard, formatToolInput } from '@/components/PermissionCard';
import {
  DEFAULT_SCOPE,
  SCOPE_OPTIONS,
  buildCommandPreview,
  buildPersistedSuggestion,
  buildSessionSuggestion,
  commandPreviewWarning,
  firstRuleSuggestion,
  getInitialRuleString,
  type IncomingSuggestion,
  type ScopeValue,
} from '@/lib/permissionCardLogic';
import type { PermissionRequestPayload } from '@/lib/types/permissionRequest';

interface Props {
  request: PermissionRequestPayload;
  onAllow: (selectedSuggestions: IncomingSuggestion[]) => void;
  onDeny: () => void;
}

export function ModernPermissionCard(props: Props) {
  const { request } = props;
  const grantsFolders = !request.suppressAlwaysAllowRule && (request.directoryGrant?.length ?? 0) > 0;
  if (request.kind === 'patch' || request.kind === 'exec' || grantsFolders) return <PermissionCard {...props} />;
  return <ClaudeToolConfirmation {...props} />;
}

function ClaudeToolConfirmation({ request, onAllow, onDeny }: Props) {
  const layout = useLayoutMode();
  const { toolName, toolInput, title, displayName, description, decisionReason, suggestions, suppressAlwaysAllowRule } = request;
  const initialRule = React.useMemo(
    () => getInitialRuleString(firstRuleSuggestion(suggestions), toolName),
    [suggestions, toolName],
  );
  const [rule, setRule] = React.useState(initialRule);
  const [scope, setScope] = React.useState<ScopeValue>(DEFAULT_SCOPE);
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    setRule(initialRule);
    setScope(DEFAULT_SCOPE);
    setEditing(false);
  }, [initialRule]);

  // Escaped, never raw: this card is the approval surface, so a command must
  // display as what will run.
  const preview = React.useMemo(() => buildCommandPreview(formatToolInput(toolName, toolInput)), [toolName, toolInput]);
  const warning = React.useMemo(() => commandPreviewWarning(preview), [preview]);
  const scopeLabel = (SCOPE_OPTIONS.find((o) => o.value === scope) ?? SCOPE_OPTIONS[0]).label;

  return (
    <div className="modern-format mx-2 my-2 flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-sm font-medium">{title || `Allow ${displayName || toolName}?`}</div>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
          {decisionReason && <p className="text-xs text-muted-foreground">{decisionReason}</p>}
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-xs">
            {preview.text}
          </pre>
          {warning && <p data-testid="permission-preview-warning" className="text-[11px] text-amber-500">{warning}</p>}
        </div>
      </div>

      {suppressAlwaysAllowRule ? (
        <p data-testid="permission-no-standing-rule" className="rounded-lg bg-amber-500/5 px-3 py-2 text-xs text-amber-500">
          Claude Code won&apos;t let this one be saved as a rule — approving it would grant more than this request covers.
        </p>
      ) : (
        <div className="space-y-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              Always allow saves <code className="font-mono text-foreground">{rule || '—'}</code> · {scopeLabel}
            </span>
            <button
              type="button"
              aria-expanded={editing}
              onClick={() => { setEditing((e) => !e); }}
              className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
            >
              {editing ? 'Done' : 'Change'}
            </button>
          </div>
          {editing && (
            <div className="space-y-2 pt-1">
              <input
                type="text"
                value={rule}
                aria-label="Rule"
                spellCheck={false}
                onChange={(e) => { setRule(e.target.value); }}
                placeholder="e.g. Bash(git:*) or Read"
                className="h-8 w-full rounded-md border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Save to">
                {SCOPE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={scope === o.value}
                    title={o.description}
                    onClick={() => { setScope(o.value); }}
                    className={cn(
                      'rounded-full border px-3 py-1 transition-colors',
                      scope === o.value ? 'border-primary/60 bg-primary/10 text-foreground' : 'hover:bg-accent/50',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className={cn(
          'flex flex-wrap items-center justify-end gap-2',
          // A sheet on a touch screen: finger-sized, Deny last, away from a resting thumb.
          layout.touch && 'flex-col-reverse items-stretch [&_button]:mr-0 [&_button]:min-h-12',
        )}
      >
        <Button variant="ghost" className="mr-auto h-8 px-3 text-sm text-muted-foreground" onClick={onDeny}>Deny</Button>
        {!suppressAlwaysAllowRule && (
          <>
            <Button
              variant="outline"
              className="h-8 px-3 text-sm"
              disabled={!rule.trim()}
              onClick={() => { onAllow([buildSessionSuggestion(rule)]); }}
            >
              Allow for session
            </Button>
            <Button
              variant="outline"
              className="h-8 px-3 text-sm"
              disabled={!rule.trim()}
              onClick={() => { onAllow([buildPersistedSuggestion(rule, scope)]); }}
            >
              Always allow
            </Button>
          </>
        )}
        <Button className="h-8 px-3 text-sm" onClick={() => { onAllow([]); }}>Allow once</Button>
      </div>
    </div>
  );
}
