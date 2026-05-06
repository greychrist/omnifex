import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Save, RotateCcw, Check, AlertCircle } from 'lucide-react';
import { api, PROMPT_TEMPLATE_SETTING_KEY } from '@/lib/api';

/**
 * The default prompt the backend ships with. Mirrored here so the
 * "Reset to default" button can populate the textarea without an extra
 * IPC round-trip. Keep in sync with `DEFAULT_SUMMARY_PROMPT` in
 * `electron/services/sessions-summary.ts`.
 */
const DEFAULT_SUMMARY_PROMPT = `You are summarizing a coding-assistant session for a developer's records.
Produce a one-line headline (8–14 words) and a 2–3 sentence paragraph (~50 words) that capture the THEMES of the session — what general area or capability was worked on, what the broader goals were, what kind of problem the user was trying to solve.

Stay at a higher level of abstraction. Do NOT list specific file names, function names, library names, line numbers, or step-by-step changes. Generalize:
- "Iterating on the session list UI" — not "edited SessionList.tsx to add pagination."
- "Improving the authentication flow" — not "added refresh-token logic to auth.ts:42."
- "Debugging a multi-account routing edge case" — not "fixed the path-rule resolver in accounts.ts."

The headline answers: "what kind of work was this?"
The paragraph answers: "what was the user generally trying to accomplish, and where did it land?"

No filler. No hedging. No code snippets.

Format your response EXACTLY:
<headline>...</headline>
<paragraph>...</paragraph>

`;

/**
 * Self-contained panel for the per-session summary prompt template.
 * Owns its own load / dirty-tracking / save flow — does NOT participate
 * in the Settings page's top-of-page Save button.
 */
export const SummaryPromptSettings: React.FC = () => {
  const [value, setValue] = useState<string>('');
  const [savedValue, setSavedValue] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSetting(PROMPT_TEMPLATE_SETTING_KEY)
      .then((stored) => {
        if (cancelled) return;
        const initial = (stored && stored.length > 0) ? stored : DEFAULT_SUMMARY_PROMPT;
        setValue(initial);
        setSavedValue(initial);
      })
      .catch(() => {
        if (cancelled) return;
        setValue(DEFAULT_SUMMARY_PROMPT);
        setSavedValue(DEFAULT_SUMMARY_PROMPT);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const dirty = value !== savedValue;
  const isDefault = value === DEFAULT_SUMMARY_PROMPT;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveSetting(PROMPT_TEMPLATE_SETTING_KEY, value);
      setSavedValue(value);
      setSavedFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleResetToDefault = () => {
    setValue(DEFAULT_SUMMARY_PROMPT);
  };

  const handleRevert = () => {
    setValue(savedValue);
    setError(null);
  };

  return (
    <div className="space-y-3 max-w-3xl">
      <div>
        <h2 className="text-heading-3">Session Summary Prompt</h2>
        <p className="mt-1 text-body-small text-muted-foreground">
          Template the model uses to summarize each session for the project tab.
          Edits apply to the next refresh on each session row — existing
          summaries are automatically marked stale so you can regenerate them
          with the updated prompt.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : (
        <>
          <textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            spellCheck={false}
            rows={18}
            className="w-full font-mono text-xs rounded-md border border-border/60 bg-background p-3 resize-y min-h-[300px] focus:outline-none focus:ring-1 focus:ring-ring"
          />

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-none" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saving}
            >
              {saving ? (
                <>
                  <Spinner className="mr-2" /> Saving…
                </>
              ) : savedFlash ? (
                <>
                  <Check className="mr-2 h-4 w-4 text-emerald-400" /> Saved
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" /> Save Prompt
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRevert}
              disabled={!dirty || saving}
            >
              Revert changes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleResetToDefault}
              disabled={isDefault || saving}
              title="Replace the editor contents with OmniFex's default prompt. You still have to click Save Prompt to persist."
            >
              <RotateCcw className="mr-2 h-3.5 w-3.5" /> Reset to default
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            The transcript is appended automatically — don't include the
            <code className="mx-1 px-1 rounded bg-muted/60 font-mono">
              {'<transcript>'}
            </code>
            section in the template. The model must still respond with
            <code className="mx-1 px-1 rounded bg-muted/60 font-mono">
              {'<headline>'}
            </code>
            and
            <code className="mx-1 px-1 rounded bg-muted/60 font-mono">
              {'<paragraph>'}
            </code>
            tags or the response is treated as malformed and the cache stays
            untouched.
          </p>
        </>
      )}
    </div>
  );
};
