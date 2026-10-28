import React from 'react';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { resolveKind } from '@/lib/messageRenderingConfig';
import { ThinkingWidget } from '@/components/claude/tools/ThinkingWidget';

/**
 * The thought being had, typed in as it streams — the Compact, Verbose and
 * All formats' counterpart to Modern's live Reasoning line. Drawn as the
 * thinking card those formats already use for a finished thought, open.
 *
 * Reads its slot itself, as InflightAssistantBubble does, so a thinking
 * flush (every 100ms) re-renders this row and never the transcript. Mounts
 * when a thought starts and unmounts when its record lands, which is when the
 * transcript's own thinking row takes over.
 */
export const InflightThinking: React.FC<{ tabId: string }> = ({ tabId }) => {
  const text = useClaudeSessionStore((s) => s.tabs[tabId]?.inflightThinking ?? null);
  const { config } = useMessageRenderingConfig();
  if (!text?.trim()) return null;
  if (resolveKind(config, 'assistant.thinking').visibility === 'never') return null;
  return (
    <div className="my-1">
      <ThinkingWidget thinking={text} defaultExpanded />
    </div>
  );
};
