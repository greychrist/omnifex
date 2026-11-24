// A real saved message_rendering_config (v5): the parts the migration reads.
export const GREG_RENDERING_CONFIG: unknown = {
  "version": 5,
  "defaultViewMode": "modern",
  "categories": {
    "user": {
      "label": "User",
      "description": "Your prompts, commands, tool results, injected context.",
      "presentation": "card",
      "accentColor": "#60a5fa",
      "icon": "User",
      "headerLabel": "You",
      "borderStyle": "solid",
      "alignment": "right",
      "visibility": "always"
    },
    "agent": {
      "label": "Agent",
      "description": "Claude's text, thinking, tool calls, completions.",
      "presentation": "card",
      "accentColor": "#8b8b8b",
      "icon": "Bot",
      "headerLabel": "Claude",
      "borderStyle": "solid",
      "alignment": "left",
      "visibility": "always"
    },
    "system": {
      "label": "System",
      "description": "Notifications, hooks, errors, lifecycle, prompts.",
      "presentation": "card",
      "accentColor": "#4b5563",
      "icon": "Info",
      "headerLabel": null,
      "borderStyle": "solid",
      "alignment": "left",
      "visibility": "verbose"
    },
    "live": {
      "label": "Live-only",
      "description": "Sent on the live stream and never saved \u2014 gone after a reload.",
      "presentation": "card",
      "accentColor": "#4b5563",
      "icon": "Zap",
      "headerLabel": null,
      "borderStyle": "dashed",
      "alignment": "left",
      "visibility": "verbose"
    }
  },
  "kinds": {
    "user.skillInjection": {
      "accentColor": "#d09eff",
      "headerLabel": "Skill Injection"
    },
    "user.systemContext": {
      "accentColor": "#d09eff",
      "headerLabel": "System Context"
    },
    "permission.request": {
      "accentColor": "#b366ff"
    },
    "system.away_summary": {
      "accentColor": "#ffffff",
      "headerLabel": "Recap...",
      "borderStyle": "dashed"
    },
    "permission-mode": {
      "visibility": "verbose"
    },
    "assistant.text.endTurn": {
      "accentColor": "#3dc23d",
      "showRawPayload": false
    },
    "system.thinking_tokens": {
      "accentColor": "#5182c8"
    },
    "assistant.tool-use": {
      "headerLabel": "Tool Call",
      "alignment": "left"
    },
    "system.notification.stop": {
      "icon": "AlertTriangle",
      "headerLabel": "Stop Request"
    },
    "user.tool-result": {
      "accentColor": "#6366f1"
    },
    "ai-title": {
      "accentColor": "#ece636",
      "visibility": "verbose"
    },
    "user.command": {
      "presentation": "card",
      "accentColor": "#60a5fa",
      "headerLabel": "Slash Command",
      "alignment": "right"
    },
    "last-prompt": {
      "presentation": "collapsible"
    },
    "system.unknown": {
      "accentColor": "#f97316"
    },
    "system.local_command": {
      "headerLabel": "Local command output"
    },
    "custom-title": {
      "accentColor": "#ece636",
      "visibility": "always"
    },
    "queue-operation": {
      "visibility": "never"
    },
    "assistant.text.live": {
      "accentColor": "#3dc23d",
      "icon": "Sparkles",
      "alignment": "narrow-center"
    },
    "attachment.instructions": {
      "visibility": "never"
    },
    "system.init": {
      "visibility": "never"
    },
    "system.rate_limit": {
      "visibility": "never"
    },
    "attachment.mcp_instructions_delta": {
      "visibility": "never"
    },
    "attachment.skill_listing": {
      "visibility": "never"
    },
    "attachment.agent_listing_delta": {
      "visibility": "never"
    },
    "attachment.deferred_tools_delta": {
      "visibility": "never"
    },
    "system.ui_log": {
      "presentation": "side-line",
      "visibility": "never"
    }
  },
  "modern": {
    "stepIcons": {
      "thought": "Brain",
      "command": "Terminal",
      "commit": "GitCommitHorizontal",
      "branch": "GitBranch",
      "read": "FileText",
      "edit": "FilePen",
      "create": "FilePlus",
      "search": "Search",
      "explore": "FolderSearch",
      "web": "Globe",
      "agent": "Bot",
      "tasks": "ListTodo",
      "question": "MessageCircleQuestion",
      "skill": "Sparkles",
      "design": "Palette",
      "mcp": "Plug",
      "tool": "Wrench"
    },
    "stepColors": {
      "thought": "#3a88fe",
      "command": null,
      "commit": null,
      "branch": null,
      "read": null,
      "edit": null,
      "create": null,
      "search": null,
      "explore": null,
      "web": null,
      "agent": null,
      "tasks": null,
      "question": null,
      "skill": null,
      "design": null,
      "mcp": null,
      "tool": null
    },
    "timelineOpen": "while-running",
    "showThoughts": true,
    "font": "geist",
    "answerSize": 14,
    "promptTint": null,
    "failedColor": null,
    "answerCardColor": null,
    "promptSaturation": 100,
    "answerCardSaturation": 100,
    "promptBrightness": 100,
    "answerCardBrightness": 100,
    "promptShadow": true,
    "answerCardShadow": true,
    "promptColorEnabled": true,
    "answerCardColorEnabled": true,
    "answerStyle": "line",
    "recordRules": "compact"
  }
};
