import type { ModernStepKind } from "@/lib/messageRenderingConfig";

/** What each step kind is called here — and what `stepKind` files under it. */
export const STEP_LABELS: Record<ModernStepKind, { label: string; hint: string }> = {
  thought: { label: "Thought", hint: "Claude thinking" },
  command: { label: "Command", hint: "Bash" },
  commit: { label: "Commit", hint: "git commit" },
  branch: { label: "Branch", hint: "git checkout -b / switch -c" },
  read: { label: "Read", hint: "Read" },
  edit: { label: "Edit", hint: "Edit, MultiEdit, NotebookEdit" },
  create: { label: "Create", hint: "Write" },
  search: { label: "Search", hint: "Grep" },
  explore: { label: "Explore", hint: "Glob, LS" },
  web: { label: "Web", hint: "WebSearch, WebFetch" },
  agent: { label: "Agent", hint: "Agent, Task" },
  tasks: { label: "Tasks", hint: "TodoWrite, Task tools" },
  question: { label: "Question", hint: "AskUserQuestion" },
  skill: { label: "Skill", hint: "Skill" },
  design: { label: "Design", hint: "Claude Design (Artifacts)" },
  mcp: { label: "MCP tool", hint: "mcp__*" },
  tool: { label: "Other tool", hint: "anything else" },
};

