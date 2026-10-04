import React, { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { fireAndLog } from '@/lib/fireAndLog';
import {
  DEFAULT_POST_COMPACT_PROMPT,
  POST_COMPACT_ENABLED_SETTING_KEY,
  POST_COMPACT_PROMPT_SETTING_KEY,
} from '@/lib/postCompactPrompt';
import { usePromptTemplate } from './usePromptTemplate';
import { PromptTemplateEditor } from './PromptTemplateEditor';
import { useSaveStatus } from './saveStatus';

/**
 * Settings → System Prompts → Compactions.
 *
 * Edits the directive OmniFex sends as a fresh turn immediately after a
 * compaction — the one that tells the model its view of the earlier turns is
 * now a lossy summary. See `src/lib/postCompactPrompt.ts` for why it exists and
 * `queuePostCompactDirective` in `sessionStreamEffects.ts` for when it fires.
 *
 * An enable switch, like the summaries panel, is the one way to turn it off
 * (`postCompact.enabled`), and it leaves the edited text in place for when it
 * is turned back on. It replaced "clear the box to turn it off", which never
 * worked: a blank template resolves to the shipped default.
 */
export const CompactionPromptSettings: React.FC = () => {
  const { track } = useSaveStatus();
  const { value, loading, isDefault, edit, resetToDefault } =
    usePromptTemplate(POST_COMPACT_PROMPT_SETTING_KEY, DEFAULT_POST_COMPACT_PROMPT);

  const [enabledLoading, setEnabledLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let cancelled = false;
    api.getSetting(POST_COMPACT_ENABLED_SETTING_KEY)
      .then((stored) => { if (!cancelled) setEnabled(stored !== 'false'); })
      .catch(() => { if (!cancelled) setEnabled(true); })
      .finally(() => { if (!cancelled) setEnabledLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Optimistic: flips at once, flips back if the write fails.
  const handleEnabledChange = async (next: boolean) => {
    setEnabled(next);
    if (!(await track(api.saveSetting(POST_COMPACT_ENABLED_SETTING_KEY, next ? 'true' : 'false')))) {
      setEnabled(!next);
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-heading-3">Compactions</h2>
        <p className="mt-1 text-body-small text-muted-foreground">
          Sent as a fresh turn right after a conversation is compacted — by
          OmniFex's banner, by a hand-typed <code className="px-1 rounded bg-muted/60 font-mono">/compact</code>,
          or by the CLI auto-compacting. Compaction replaces the earlier turns
          with a summary, and a model working from that summary will still
          answer confidently about specifics it no longer has.
        </p>
      </div>

      {loading || enabledLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Switch
              id="post-compact-enabled"
              checked={enabled}
              onCheckedChange={fireAndLog('compaction-prompt-settings:checked-change', handleEnabledChange)}
              aria-label="Send a prompt after compaction"
            />
            <label htmlFor="post-compact-enabled" className="text-sm cursor-pointer">
              Send a prompt after compaction
            </label>
          </div>

          <div className={enabled ? '' : 'opacity-50 pointer-events-none'}>
            <PromptTemplateEditor
              value={value}
              onChange={edit}
              onReset={resetToDefault}
              isDefault={isDefault}
              aria-label="Post-compaction directive"
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Nothing is appended to this template — it is sent exactly as written,
            with no session details interpolated. Turn the switch off to send
            nothing after a compaction; your edits are kept.
          </p>

          <p className="text-[11px] text-muted-foreground">
            The shipped default ends by telling the model to carry on if it was
            mid-task. That is usually what you want, but it will also resume work
            you deliberately interrupted before compacting — edit that line out if
            you would rather always re-prompt by hand.
          </p>
        </>
      )}
    </div>
  );
};
