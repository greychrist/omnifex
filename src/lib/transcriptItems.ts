/**
 * The whole path from a tab's records to the items the Modern renderer draws,
 * as one pure function, so what the chat shows can be pinned by a test
 * (standardVisibility.golden.test.ts) rather than inferred from a component.
 *
 * Order matters: repeats fold first, over the unfiltered list, so a hidden
 * record still ends a run; then the display filters; then grouping.
 */
import type { JsonlNode } from '@/types/jsonl';
import { revealNeverShown, rulesViewMode, type MessageRenderingConfig, type ViewMode } from './messageRenderingConfig';
import { collapseRepeats } from './collapseRepeats';
import { filterDisplayableMessages } from './messageFilters';
import { withoutNeverShown } from './compactGrouping';
import { buildModernItems, type ModernItem } from './modernGrouping';

/** The records that survive the display rules, and the config they ran under. */
export function displayableRecords(
  messages: JsonlNode[],
  savedConfig: MessageRenderingConfig,
  viewMode: ViewMode,
): { displayable: JsonlNode[]; config: MessageRenderingConfig } {
  const rulesMode = rulesViewMode(viewMode, savedConfig);
  const config = rulesMode === 'all' ? revealNeverShown(savedConfig) : savedConfig;
  const displayable = withoutNeverShown(filterDisplayableMessages(collapseRepeats(messages, config, rulesMode)), config);
  return { displayable, config };
}

/** What the Modern renderer draws for `messages`. */
export function transcriptItems(
  messages: JsonlNode[],
  savedConfig: MessageRenderingConfig,
  viewMode: ViewMode,
): ModernItem[] {
  const { displayable, config } = displayableRecords(messages, savedConfig, viewMode);
  return buildModernItems(displayable, config, messages, config.modern.recordRules);
}
