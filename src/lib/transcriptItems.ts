/** Standard folds repeats over the unfiltered list (a hidden record still ends a run), then filters. Expanded filters nothing. */
import type { JsonlNode } from '@/types/jsonl';
import type { MessageRenderingConfig, ViewMode } from './messageRenderingConfig';
import { collapseRepeats } from './collapseRepeats';
import { filterDisplayableMessages } from './messageFilters';
import { withoutHiddenInStandard } from './recordVisibility';
import { buildModernItems, type ModernItem } from './modernGrouping';

export function displayableRecords(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
  viewMode: ViewMode,
): JsonlNode[] {
  if (viewMode === 'expanded') return messages;
  return withoutHiddenInStandard(filterDisplayableMessages(collapseRepeats(messages, 'standard')), config);
}

export function groupRecords(
  displayable: JsonlNode[],
  config: MessageRenderingConfig,
  messages: JsonlNode[],
  viewMode: ViewMode,
): ModernItem[] {
  return buildModernItems(displayable, config, messages, viewMode === 'standard');
}

export function transcriptItems(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
  viewMode: ViewMode,
): ModernItem[] {
  return groupRecords(displayableRecords(messages, config, viewMode), config, messages, viewMode);
}
