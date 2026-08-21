import React from 'react';
import { Spinner } from '@/components/ui/spinner';
import {
  DEFAULT_POST_COMPACT_PROMPT,
  POST_COMPACT_PROMPT_SETTING_KEY,
} from '@/lib/postCompactPrompt';
import { usePromptTemplate } from './usePromptTemplate';
import { PromptTemplateEditor } from './PromptTemplateEditor';

/**
 * Settings → System Prompts → Compactions.
 *
 * Edits the directive OmniFex sends as a fresh turn immediately after a
 * compaction — the one that tells the model its view of the earlier turns is
 * now a lossy summary. See `src/lib/postCompactPrompt.ts` for why it exists and
 * `queuePostCompactDirective` in `sessionStreamEffects.ts` for when it fires.
 *
 * No enable switch, unlike the summaries panel: the queueing effect already
 * treats an empty template as "off", so a switch would be a second way to say
 * the same thing, with the two able to disagree.
 */
export const CompactionPromptSettings: React.FC = () => {
  const { value, loading, saved, error, isDefault, edit, resetToDefault } =
    usePromptTemplate(POST_COMPACT_PROMPT_SETTING_KEY, DEFAULT_POST_COMPACT_PROMPT, {
      // An empty stored value is a deliberate "off" here, not "unset".
      treatEmptyAsDefault: false,
    });

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

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : (
        <>
          <PromptTemplateEditor
            value={value}
            onChange={edit}
            onReset={resetToDefault}
            isDefault={isDefault}
            saved={saved}
            error={error}
            aria-label="Post-compaction directive"
          />

          <p className="text-[11px] text-muted-foreground">
            Nothing is appended to this template — it is sent exactly as written,
            with no session details interpolated. <strong>Clear the box to turn
            the directive off</strong> and send nothing after a compaction.
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
