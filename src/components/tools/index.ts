/**
 * Tool widget components — one file per tool type.
 *
 * This barrel re-exports every widget so the rest of the app
 * can keep importing from "@/components/tools" (or from the
 * thin ToolWidgets.tsx dispatcher that re-exports us).
 */

export { TodoWidget } from "./TodoWidget";
export { LSWidget, LSResultWidget } from "./LSWidget";
export { ReadWidget, ReadResultWidget } from "./ReadWidget";
export { GlobWidget } from "./GlobWidget";
export { BashWidget } from "./BashWidget";
export { WriteWidget } from "./WriteWidget";
export { GrepWidget } from "./GrepWidget";
export { EditWidget, EditResultWidget } from "./EditWidget";
export { MCPWidget } from "./MCPWidget";
export { CommandWidget, CommandOutputWidget } from "./CommandWidget";
export { SummaryWidget } from "./SummaryWidget";
export { MultiEditWidget, MultiEditResultWidget } from "./MultiEditWidget";
export { SystemReminderWidget, SystemContextWidget, SystemInitializedWidget } from "./SystemWidget";
export { TaskWidget } from "./TaskWidget";
export { WebSearchWidget } from "./WebSearchWidget";
export { ThinkingWidget } from "./ThinkingWidget";
export { WebFetchWidget } from "./WebFetchWidget";
export { TodoReadWidget } from "./TodoReadWidget";
export { getLanguage, extractResultContent } from "./shared";
