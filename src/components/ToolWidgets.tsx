/**
 * ToolWidgets — thin dispatcher that re-exports per-tool components.
 *
 * All rendering logic lives in src/components/tools/*.tsx.
 * This file exists solely to preserve the public import surface
 * (`import { FooWidget } from "./ToolWidgets"`) used by
 * StreamMessage.tsx and the components barrel.
 */

export {
  LSWidget,
  LSResultWidget,
  ReadWidget,
  ReadResultWidget,
  GlobWidget,
  BashWidget,
  WriteWidget,
  GrepWidget,
  EditWidget,
  EditResultWidget,
  MCPWidget,
  CommandWidget,
  CommandOutputWidget,
  SummaryWidget,
  MultiEditWidget,
  MultiEditResultWidget,
  SystemReminderWidget,
  SystemContextWidget,
  SystemInitializedWidget,
  TaskWidget,
  WebSearchWidget,
  ThinkingWidget,
  WebFetchWidget,
  TodoReadWidget,
} from "./tools";
