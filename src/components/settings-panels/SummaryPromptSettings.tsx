import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { RotateCcw, Check, AlertCircle } from 'lucide-react';
import { fireAndLog } from "@/lib/fireAndLog";
import {
  api,
  PROMPT_TEMPLATE_SETTING_KEY,
  AUTO_ON_CLOSE_SETTING_KEY,
  ENABLED_SETTING_KEY,
} from '@/lib/api';

/**
 * The default prompt the backend ships with. Mirrored here so the
 * "Reset to default" button can populate the textarea without an extra
 * IPC round-trip. Keep in sync with `DEFAULT_SUMMARY_PROMPT` in
 * `electron/services/sessions-summary.ts`.
 */
const DEFAULT_SUMMARY_PROMPT = `You are summarizing a coding-assistant session for a developer's records.
Produce a one-line headline (8–14 words) and a 2–3 bullet points (< 50 words) that capture the THEMES of the session — what general area or capability was worked on, what the broader goals were, what kind of problem the user was trying to solve.

If nothing of note was done, just say so.  Nothing of note. or Testing functionality.

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

/** Debounce delay before the textarea contents are persisted. Tuned so
 *  short pauses while typing flush; rapid edits coalesce into one save. */
const PROMPT_AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * Settings → Session Summaries panel.
 *
 * Layout (top → bottom):
 *   1. Heading + master "Enable summaries" switch (controls UI visibility
 *      everywhere + auto-on-close lifecycle gate).
 *   2. Prompt textarea — auto-saves with a debounce, no Save button.
 *   3. "Reset to default" button.
 *   4. "Generate summaries automatically" switch — only gates the
 *      lifecycle hook (auto generation on session close); the manual
 *      refresh button is unaffected.
 *
 * All three switches save instantly on flip (optimistic UI with
 * rollback on error). The prompt textarea debounces saves so each
 * keystroke doesn't hit IPC.
 */
export const SummaryPromptSettings: React.FC = () => {
  const [value, setValue] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [savedFlash, setSavedFlash] = useState<'prompt' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState<boolean>(true);
  const [enabledError, setEnabledError] = useState<string | null>(null);
  const [autoOnClose, setAutoOnClose] = useState<boolean>(true);
  const [autoOnCloseError, setAutoOnCloseError] = useState<string | null>(null);

  // Debounce timer for the prompt-textarea auto-save. Refreshed on
  // every keystroke so a save fires `PROMPT_AUTOSAVE_DEBOUNCE_MS` after
  // the *last* edit rather than the first.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last value successfully persisted so we don't re-save on
  // every render — and so the auto-save can no-op when the editor is
  // showing exactly what's already on disk.
  const savedRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getSetting(PROMPT_TEMPLATE_SETTING_KEY),
      api.getSetting(ENABLED_SETTING_KEY),
      api.getSetting(AUTO_ON_CLOSE_SETTING_KEY),
    ])
      .then(([storedPrompt, storedEnabled, storedAuto]) => {
        if (cancelled) return;
        const initial = (storedPrompt && storedPrompt.length > 0) ? storedPrompt : DEFAULT_SUMMARY_PROMPT;
        setValue(initial);
        savedRef.current = initial;
        // Default-on if the row is missing (matches the backend seed in
        // `ensureDefaultSettings`). Any non-'true' string parses as off.
        setEnabled(storedEnabled === null ? true : storedEnabled === 'true');
        setAutoOnClose(storedAuto === null ? true : storedAuto === 'true');
      })
      .catch(() => {
        if (cancelled) return;
        setValue(DEFAULT_SUMMARY_PROMPT);
        savedRef.current = DEFAULT_SUMMARY_PROMPT;
        setEnabled(true);
        setAutoOnClose(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  // Auto-save on prompt edits. Each keystroke resets the timer; after
  // PROMPT_AUTOSAVE_DEBOUNCE_MS of inactivity the latest value is
  // persisted. We compare against `savedRef.current` to skip the save
  // when nothing actually changed (initial mount, undo back to saved,
  // etc.).
  const scheduleAutosave = (next: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(fireAndLog('summary-prompt-settings:autosave', async () => {
      saveTimer.current = null;
      if (next === savedRef.current) return;
      setError(null);
      try {
        await api.saveSetting(PROMPT_TEMPLATE_SETTING_KEY, next);
        savedRef.current = next;
        setSavedFlash('prompt');
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => { setSavedFlash(null); }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed.');
      }
    }), PROMPT_AUTOSAVE_DEBOUNCE_MS);
  };

  const handleEnabledChange = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setEnabledError(null);
    try {
      await api.saveSetting(ENABLED_SETTING_KEY, next ? 'true' : 'false');
    } catch (err) {
      setEnabled(previous);
      setEnabledError(err instanceof Error ? err.message : 'Save failed.');
    }
  };

  const handleAutoOnCloseChange = async (next: boolean) => {
    const previous = autoOnClose;
    setAutoOnClose(next);
    setAutoOnCloseError(null);
    try {
      await api.saveSetting(AUTO_ON_CLOSE_SETTING_KEY, next ? 'true' : 'false');
    } catch (err) {
      setAutoOnClose(previous);
      setAutoOnCloseError(err instanceof Error ? err.message : 'Save failed.');
    }
  };

  const handleResetToDefault = () => {
    if (value === DEFAULT_SUMMARY_PROMPT) return;
    setValue(DEFAULT_SUMMARY_PROMPT);
    scheduleAutosave(DEFAULT_SUMMARY_PROMPT);
  };

  const isDefault = value === DEFAULT_SUMMARY_PROMPT;

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-heading-3">Session Summaries</h2>
        <p className="mt-1 text-body-small text-muted-foreground">
          When enabled, OmniFex summarizes each session and shows the
          summary on the row instead of the first message. Turn off to
          fall back to first-message previews and hide the refresh
          button.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : (
        <>
          {/* Master switch — controls UI visibility everywhere AND the
              auto-on-close lifecycle gate. */}
          <div className="flex items-center gap-3">
            <Switch
              id="sessions-summary-enabled"
              checked={enabled}
              onCheckedChange={fireAndLog('summary-prompt-settings:checked-change', handleEnabledChange)}
              aria-label="Enable session summaries"
            />
            <label
              htmlFor="sessions-summary-enabled"
              className="text-sm cursor-pointer"
            >
              Enable session summaries
            </label>
          </div>
          {enabledError && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-none" />
              <span>Couldn't save toggle: {enabledError}</span>
            </div>
          )}

          <div className={enabled ? '' : 'opacity-50 pointer-events-none'}>
            <textarea
              value={value}
              onChange={(e) => {
                const next = e.target.value;
                setValue(next);
                setError(null);
                scheduleAutosave(next);
              }}
              spellCheck={false}
              rows={18}
              className="w-full font-mono text-xs rounded-md border border-border/60 bg-background p-3 resize-y min-h-[300px] focus:outline-none focus:ring-1 focus:ring-ring"
            />

            <div className="flex items-center gap-2 mt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handleResetToDefault}
                disabled={isDefault}
                title="Replace the editor with OmniFex's default prompt. Saves automatically."
              >
                <RotateCcw className="mr-2 h-3.5 w-3.5" /> Reset to default
              </Button>
              {savedFlash === 'prompt' && (
                <span className="inline-flex items-center text-[11px] text-emerald-400">
                  <Check className="mr-1 h-3 w-3" /> Saved
                </span>
              )}
              {error && (
                <span className="inline-flex items-center gap-1 text-[11px] text-red-400">
                  <AlertCircle className="h-3 w-3" />
                  {error}
                </span>
              )}
            </div>

            {/* Auto-on-close switch — only gates the lifecycle hook.
                Manual refresh on a row works regardless. */}
            <div className="flex items-center gap-3 pt-4">
              <Switch
                id="sessions-summary-auto-on-close"
                checked={autoOnClose}
                onCheckedChange={fireAndLog('summary-prompt-settings:checked-change', handleAutoOnCloseChange)}
                aria-label="Generate summaries automatically on session close"
              />
              <label
                htmlFor="sessions-summary-auto-on-close"
                className="text-sm cursor-pointer"
              >
                Generate summaries automatically when leaving a session
              </label>
            </div>
            {autoOnCloseError && (
              <div className="flex items-start gap-2 text-xs text-red-400 mt-1">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-none" />
                <span>Couldn't save toggle: {autoOnCloseError}</span>
              </div>
            )}
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
