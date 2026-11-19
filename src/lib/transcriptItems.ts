/**
 * The whole path from a tab's records to the items the Modern renderer draws,
 * as one pure function, so what the chat shows can be pinned by a test
 * (standardVisibility.golden.test.ts) rather than inferred from a component.
 *
 * Standard: repeats fold first, over the unfiltered list, so a hidden record
 * still ends a run; then the display filters and the kinds hidden in
 * Standard (Settings › Chats); then grouping.
 *
 * Expanded: no filter at all. It exists to check that every record type is
 * accounted for, so every record reaches grouping and is drawn.
 */
import type { JsonlNode } from '@/types/jsonl';
import type { MessageRenderingConfig, ViewMode } from './messageRenderingConfig';
import { collapseRepeats } from './collapseRepeats';
import { filterDisplayableMessages } from './messageFilters';
import { withoutHiddenInStandard } from './recordVisibility';
import { buildModernItems, type ModernItem } from './modernGrouping';

/** The records that survive the view's rules. */
export function displayableRecords(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
  viewMode: ViewMode,
): JsonlNode[] {
  if (viewMode === 'expanded') return messages;
  return withoutHiddenInStandard(filterDisplayableMessages(collapseRepeats(messages, 'standard')), config);
}

/** `displayable` grouped into items, under the view's rules. */
export function groupRecords(
  displayable: JsonlNode[],
  config: MessageRenderingConfig,
  messages: JsonlNode[],
  viewMode: ViewMode,
): ModernItem[] {
  return buildModernItems(displayable, config, messages, viewMode === 'standard');
}

/** What the Modern renderer draws for `messages` in `viewMode`. */
export function transcriptItems(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
  viewMode: ViewMode,
): ModernItem[] {
  return groupRecords(displayableRecords(messages, config, viewMode), config, messages, viewMode);
}
