import { useState } from 'react';
import { ShieldAlert, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSessionActions } from '@/contexts/SessionActionsContext';
import {
  actionSummary,
  retryPrompt,
  ruleAddedPrompt,
  suggestDenialRule,
  type DenialDescription,
} from '@/lib/permissionDenial';

interface PermissionDeniedCardProps {
  toolName: string;
  input: Record<string, unknown>;
  denial: DenialDescription;
  /** The denial happened inside a subagent; the retry goes to the main thread. */
  fromSubagent?: boolean;
}

/**
 * A denial the CLI made without asking — see `src/lib/permissionDenial.ts`.
 * It used to render as a bare "Permission denied" line, and the only way on
 * was typing consent into the composer. The actions here do the same things
 * in one click. Outside a live session (no SessionActions) the card is
 * informational only.
 */
export function PermissionDeniedCard({ toolName, input, denial, fromSubagent }: PermissionDeniedCardProps) {
  const actions = useSessionActions();
  const [sent, setSent] = useState(false);
  const [editingRule, setEditingRule] = useState(false);
  const [rule, setRule] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const unavailable = denial.kind === 'classifier-unavailable';
  const Icon = unavailable ? ShieldAlert : ShieldX;
  const headline = unavailable
    ? 'The auto-mode safety check was unavailable, so this was not run'
    : denial.kind === 'classifier-block'
      ? 'Auto mode blocked this'
      : 'Permission denied';

  // Disabled only while the turn it fed is still going: once the session is
  // idle again (finished, or Stopped) the user may approve again.
  const busy = sent && !!actions?.turnRunning;

  const send = (text: string) => {
    if (!actions || busy) return;
    setSent(true);
    actions.sendPrompt(text);
  };

  const openRuleEditor = () => {
    if (!actions) return;
    setRule(suggestDenialRule(toolName, input, actions.projectPath, actions.homeDir) ?? toolName);
    setSaveError(null);
    setEditingRule(true);
  };

  const saveRule = async () => {
    if (!actions || !rule.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await actions.addAllowRule(rule.trim());
      setEditingRule(false);
      send(ruleAddedPrompt(toolName, input));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-start gap-2">
        <Icon className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <div>
            <span className="font-medium">{headline}</span>
            {denial.category && (
              <>
                {' · '}
                <span className="text-muted-foreground">{denial.category}</span>
              </>
            )}
          </div>
          <div className="font-mono text-xs break-all text-muted-foreground">{actionSummary(toolName, input)}</div>
          {fromSubagent && (
            <div className="text-xs text-muted-foreground">
              This happened in a subagent. A retry asks the main session to redo it.
            </div>
          )}
        </div>
      </div>

      {actions && (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          {unavailable ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => send(retryPrompt(denial.kind, toolName, input))}>
              Retry
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={() => send(retryPrompt(denial.kind, toolName, input))}>
                Approve &amp; retry
              </Button>
              <Button size="sm" variant="outline" disabled={busy || editingRule} onClick={openRuleEditor}>
                Always allow…
              </Button>
              {actions.permissionMode === 'auto' && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Switch this session to Default mode: risky actions ask you instead of being judged automatically"
                  onClick={() => actions.setPermissionMode('default')}
                >
                  Ask me instead of auto mode
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {actions && editingRule && (
        <div className="pl-6 space-y-1">
          <div className="flex items-center gap-2">
            <input
              aria-label="Allow rule"
              className="flex-1 min-w-0 rounded-md border bg-background px-2 py-1 font-mono text-xs"
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveRule(); }}
            />
            <Button size="sm" disabled={saving || !rule.trim()} onClick={() => void saveRule()}>
              Save &amp; retry
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditingRule(false)}>
              Cancel
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Saved to this project&apos;s <code>.claude/settings.local.json</code>; applies now and to later sessions.
          </div>
          {saveError && <div className="text-xs text-destructive">Could not save the rule: {saveError}</div>}
        </div>
      )}
    </div>
  );
}
