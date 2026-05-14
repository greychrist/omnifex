import React, { useState } from "react";
import {
  FolderOpen,
  FileText,
  Search,
  ChevronRight,
  Info,
  AlertCircle,
  Settings,
  Fingerprint,
  Cpu,
  FolderSearch,
  List,
  LogOut,
  Edit3,
  FilePlus,
  Book,
  BookOpen,
  Globe,
  ListChecks,
  ListPlus,
  Globe2,
  Package,
  ChevronDown,
  Package2,
  Wrench,
  CheckSquare,
  type LucideIcon,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { useMessageRenderingConfig } from "@/contexts/MessageRenderingContext";
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { headerLabelFor, iconNameFor } from "@/lib/kindPresentation";
import { IconRenderer } from "@/components/settings-panels/appearance/iconMap";
import { KindHeader } from "@/components/KindHeader";

/**
 * Widget for displaying system reminders (instead of raw XML)
 */
export const SystemReminderWidget: React.FC<{ message: string }> = ({ message }) => {
  const { config } = useMessageRenderingConfig();

  // Map content severity to a kind whose palette the widget should borrow.
  // Warnings/errors escalate to the matching notification kind so the color
  // scheme drives both the base system-reminder look and severity variants.
  const kindId = message.toLowerCase().includes("warning")
    ? "system.notification.warn"
    : message.toLowerCase().includes("error")
      ? "system.notification.error"
      : "tool.result.systemReminder";

  const icon = kindId === "tool.result.systemReminder"
    ? <Info className="h-4 w-4" />
    : <AlertCircle className="h-4 w-4" />;

  const style = accentStyleFor(config, kindId);
  const swatch = swatchFor(config, kindId);

  return (
    <div
      className="flex items-start gap-2 p-3 rounded-md border"
      style={style}
    >
      <div className="mt-0.5" style={swatch ? { color: swatch } : undefined}>{icon}</div>
      <div className="flex-1 text-sm" style={swatch ? { color: swatch } : undefined}>{message}</div>
    </div>
  );
};

/**
 * Collapsible widget for system-injected context (skills, CLAUDE.md, system-reminders)
 * Styled like ThinkingWidget — collapsed by default
 */
export const SystemContextWidget: React.FC<{ content: string }> = ({ content }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { config } = useMessageRenderingConfig();

  const configuredHeader = headerLabelFor(config, "user.systemContext");
  // Fall back to a content-derived label when the config header is the default
  // "System Context" — so skill loads and CLAUDE.md injections stay legible
  // rather than all showing the same generic name. If the user has customized
  // the header to something else, honor their choice verbatim.
  let label = configuredHeader ?? "System Context";
  if (configuredHeader === null || configuredHeader === "System Context") {
    if (content.includes("Base directory for this skill:")) {
      const skillMatch = /# (.+)/.exec(content);
      label = skillMatch ? `Skill: ${skillMatch[1]}` : "Skill Loaded";
    } else if (content.includes("CLAUDE.md")) {
      label = "CLAUDE.md Context";
    } else if (content.includes("<system-reminder>")) {
      label = "System Reminder";
    }
  }

  const iconName = iconNameFor(config, "user.systemContext");
  const style = accentStyleFor(config, "user.systemContext");
  const swatch = swatchFor(config, "user.systemContext");
  const swatchStyle = swatch ? { color: swatch } : undefined;

  return (
    <div className="rounded-lg border overflow-hidden" style={style}>
      <button
        onClick={() => { setIsExpanded(!isExpanded); }}
        className="w-full px-4 py-2 flex items-center justify-between transition-colors"
      >
        <div className="flex items-center gap-2">
          <div style={swatchStyle}>
            {iconName && iconName !== "none" ? (
              <IconRenderer name={iconName} className="h-4 w-4" />
            ) : (
              <Info className="h-4 w-4" />
            )}
          </div>
          <span className="text-xs font-medium" style={swatchStyle}>
            {label}
          </span>
        </div>
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")}
          style={swatchStyle}
        />
      </button>

      {isExpanded && (
        <div className="px-4 pb-3 pt-1 border-t" style={style}>
          <pre
            className="text-xs font-mono whitespace-pre-wrap p-3 rounded-lg max-h-60 overflow-y-auto"
            style={{ ...style, ...swatchStyle }}
          >
            {content.trim()}
          </pre>
        </div>
      )}
    </div>
  );
};

/**
 * Widget for displaying system initialization information in a visually appealing way
 * Separates regular tools from MCP tools and provides icons for each tool type
 */
export const SystemInitializedWidget: React.FC<{
  sessionId?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
}> = ({ sessionId, model, cwd, tools = [] }) => {
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const { config } = useMessageRenderingConfig();
  const style = accentStyleFor(config, "system.init");
  const swatch = swatchFor(config, "system.init");
  const iconName = iconNameFor(config, "system.init");

  // Separate regular tools from MCP tools
  const regularTools = tools.filter(tool => !tool.startsWith('mcp__'));
  const mcpTools = tools.filter(tool => tool.startsWith('mcp__'));

  // Tool icon mapping for regular tools
  const toolIcons: Record<string, LucideIcon> = {
    'task': CheckSquare,
    'bash': Terminal,
    'glob': FolderSearch,
    'grep': Search,
    'ls': List,
    'exit_plan_mode': LogOut,
    'read': FileText,
    'edit': Edit3,
    'multiedit': Edit3,
    'write': FilePlus,
    'notebookread': Book,
    'notebookedit': BookOpen,
    'webfetch': Globe,
    'todoread': ListChecks,
    'todowrite': ListPlus,
    'websearch': Globe2,
  };

  // Get icon for a tool, fallback to Wrench
  const getToolIcon = (toolName: string) => {
    const normalizedName = toolName.toLowerCase();
    return toolIcons[normalizedName] || Wrench;
  };

  // Format MCP tool name (remove mcp__ prefix and format underscores)
  const formatMcpToolName = (toolName: string) => {
    // Remove mcp__ prefix
    const withoutPrefix = toolName.replace(/^mcp__/, '');
    // Split by double underscores first (provider separator)
    const parts = withoutPrefix.split('__');
    if (parts.length >= 2) {
      // Format provider name and method name separately
      const provider = parts[0].replace(/_/g, ' ').replace(/-/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      const method = parts.slice(1).join('__').replace(/_/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      return { provider, method };
    }
    // Fallback formatting
    return {
      provider: 'MCP',
      method: withoutPrefix.replace(/_/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    };
  };

  // Group MCP tools by provider
  const mcpToolsByProvider = mcpTools.reduce<Record<string, string[]>>((acc, tool) => {
    const { provider } = formatMcpToolName(tool);
    if (!acc[provider]) {
      acc[provider] = [];
    }
    acc[provider].push(tool);
    return acc;
  }, {});

  return (
    <Card className="border" style={style}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div style={swatch ? { color: swatch } : undefined}>
            {iconName && iconName !== "none" ? (
              <IconRenderer name={iconName} className="h-5 w-5 mt-0.5" />
            ) : (
              <Settings className="h-5 w-5 mt-0.5" />
            )}
          </div>
          <div className="flex-1 space-y-4">
            <KindHeader kindId="system.init" fallbackLabel="System Initialized" />

            {/* Session Info */}
            <div className="space-y-2">
              {sessionId && (
                <div className="flex items-center gap-2 text-xs">
                  <Fingerprint className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Session ID:</span>
                  <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                    {sessionId}
                  </code>
                </div>
              )}

              {model && (
                <div className="flex items-center gap-2 text-xs">
                  <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Model:</span>
                  <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                    {model}
                  </code>
                </div>
              )}

              {cwd && (
                <div className="flex items-center gap-2 text-xs">
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Working Directory:</span>
                  <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                    {cwd}
                  </code>
                </div>
              )}
            </div>

            {/* Regular Tools */}
            {regularTools.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">
                    Available Tools ({regularTools.length})
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {regularTools.map((tool, idx) => {
                    const Icon = getToolIcon(tool);
                    return (
                      <Badge
                        key={idx}
                        variant="secondary"
                        className="text-xs py-0.5 px-2 flex items-center gap-1"
                      >
                        <Icon className="h-3 w-3" />
                        {tool}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}

            {/* MCP Tools */}
            {mcpTools.length > 0 && (
              <div className="space-y-2">
                <button
                  onClick={() => { setMcpExpanded(!mcpExpanded); }}
                  className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Package className="h-3.5 w-3.5" />
                  <span>MCP Services ({mcpTools.length})</span>
                  <ChevronDown className={cn(
                    "h-3 w-3 transition-transform",
                    mcpExpanded && "rotate-180"
                  )} />
                </button>

                {mcpExpanded && (
                  <div className="ml-5 space-y-3">
                    {Object.entries(mcpToolsByProvider).map(([provider, providerTools]) => (
                      <div key={provider} className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Package2 className="h-3 w-3" />
                          <span className="font-medium">{provider}</span>
                          <span className="text-muted-foreground/60">({providerTools.length})</span>
                        </div>
                        <div className="ml-4 flex flex-wrap gap-1">
                          {providerTools.map((tool, idx) => {
                            const { method } = formatMcpToolName(tool);
                            return (
                              <Badge
                                key={idx}
                                variant="outline"
                                className="text-xs py-0 px-1.5 font-normal"
                              >
                                {method}
                              </Badge>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Show message if no tools */}
            {tools.length === 0 && (
              <div className="text-xs text-muted-foreground italic">
                No tools available
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
