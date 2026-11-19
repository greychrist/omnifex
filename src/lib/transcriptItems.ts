/**
 * The whole path from a tab's records to the items the Modern renderer draws,
 * as one pure function, so what the chat shows can be pinned by a test
 * (standardVisibility.golden.test.ts) rather than inferred from a component.
 *
 * Standard: repeats fold first, over the unfiltered list, so a hidden record
 * still ends a run; then the display filters; then grouping.
 *
 * Expanded: no filter at all. It exists to check that every record type is
 * accounted for, so every record reaches grouping and is drawn.
 */
import type { JsonlNode } from '@/types/jsonl';
import { revealNeverShown, type MessageRenderingConfig, type ViewMode } from './messageRenderingConfig';
import { collapseRepeats } from './collapseRepeats';
import { filterDisplayableMessages } from './messageFilters';
import { withoutNeverShown } from './compactGrouping';
import { buildModernItems, type ModernItem } from './modernGrouping';

/** The records that survive the view's rules, and the config they ran under. */
export function displayableRecords(
  messages: JsonlNode[],
  savedConfig: MessageRenderingConfig,
  viewMode: ViewMode,
): { displayable: JsonlNode[]; config: MessageRenderingConfig } {
  if (viewMode === 'expanded') return { displayable: messages, config: revealNeverShown(savedConfig) };
  const rules = savedConfig.modern.recordRules;
  const config = rules === 'all' ? revealNeverShown(savedConfig) : savedConfig;
  // The repeat tidying ran only under Compact's rules; Verbose and All were
  // the raw stream.
  const collapseIn: ViewMode = rules === 'compact' ? 'standard' : 'expanded';
  const displayable = withoutNeverShown(filterDisplayableMessages(collapseRepeats(messages, config, collapseIn)), config);
  return { displayable, config };
}

/** `displayable` grouped into items, under the view's rules. */
export function groupRecords(
  displayable: JsonlNode[],
  config: MessageRenderingConfig,
  messages: JsonlNode[],
  viewMode: ViewMode,
): ModernItem[] {
  return buildModernItems(displayable, config, messages, viewMode === 'expanded' ? 'all' : config.modern.recordRules);
}

/** What the Modern renderer draws for `messages` in `viewMode`. */
export function transcriptItems(
  messages: JsonlNode[],
  savedConfig: MessageRenderingConfig,
  viewMode: ViewMode,
): ModernItem[] {
  const { displayable, config } = displayableRecords(messages, savedConfig, viewMode);
  return groupRecords(displayable, config, messages, viewMode);
}
