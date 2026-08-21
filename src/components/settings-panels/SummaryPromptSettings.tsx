import React, { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { AlertCircle } from 'lucide-react';
import { fireAndLog } from "@/lib/fireAndLog";
import {
  api,
  PROMPT_TEMPLATE_SETTING_KEY,
  AUTO_ON_CLOSE_SETTING_KEY,
  ENABLED_SETTING_KEY,
} from '@/lib/api';
import { usePromptTemplate } from './usePromptTemplate';
import { PromptTemplateEditor } from './PromptTemplateEditor';

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

/**
 * Settings → System Prompts → Session summaries.
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
 * Both switches save instantly on flip (optimistic UI with rollback on
 * error). The prompt textarea's load/debounce/save cycle lives in
 * `usePromptTemplate`, shared with the Compactions panel.
 */
export const SummaryPromptSettings: React.FC = () => {
  const prompt = usePromptTemplate(PROMPT_TEMPLATE_SETTING_KEY, DEFAULT_SUMMARY_PROMPT);

  const [switchesLoading, setSwitchesLoading] = useState(true);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [enabledError, setEnabledError] = useState<string | null>(null);
  const [autoOnClose, setAutoOnClose] = useState<boolean>(true);
  const [autoOnCloseError, setAutoOnCloseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getSetting(ENABLED_SETTING_KEY),
      api.getSetting(AUTO_ON_CLOSE_SETTING_KEY),
    ])
      .then(([storedEnabled, storedAuto]) => {
        if (cancelled) return;
        // Default-on if the row is missing (matches the backend seed in
        // `ensureDefaultSettings`). Any non-'true' string parses as off.
        setEnabled(storedEnabled === null ? true : storedEnabled === 'true');
        setAutoOnClose(storedAuto === null ? true : storedAuto === 'true');
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(true);
        setAutoOnClose(true);
      })
      .finally(() => {
        if (!cancelled) setSwitchesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

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

  const loading = prompt.loading || switchesLoading;

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
            <PromptTemplateEditor
              value={prompt.value}
              onChange={prompt.edit}
              onReset={prompt.resetToDefault}
              isDefault={prompt.isDefault}
              saved={prompt.saved}
              error={prompt.error}
              aria-label="Session summary prompt"
            />

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
