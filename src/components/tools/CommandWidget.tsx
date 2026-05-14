import React from "react";
import {
  Terminal,
  ChevronRight,
} from "lucide-react";
import { detectLinks, makeLinksClickable } from "@/lib/linkDetector";

/**
 * Widget for user commands (e.g., model, clear)
 */
export const CommandWidget: React.FC<{
  commandName: string;
  commandMessage: string;
  commandArgs?: string;
}> = ({ commandName, commandMessage, commandArgs }) => {
  return (
    <div className="rounded-lg border bg-background/50 overflow-hidden">
      <div className="px-4 py-2 border-b bg-muted/50 flex items-center gap-2">
        <Terminal className="h-3.5 w-3.5 text-blue-500" />
        <span className="text-xs font-mono text-blue-400">Command</span>
      </div>
      <div className="p-3 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">$</span>
          <code className="text-sm font-mono text-foreground">{commandName}</code>
          {commandArgs && (
            <code className="text-sm font-mono text-muted-foreground">{commandArgs}</code>
          )}
        </div>
        {commandMessage && commandMessage !== commandName && (
          <div className="text-xs text-muted-foreground ml-4">{commandMessage}</div>
        )}
      </div>
    </div>
  );
};

/**
 * Widget for command output/stdout
 */
export const CommandOutputWidget: React.FC<{
  output: string;
  onLinkDetected?: (url: string) => void;
}> = ({ output, onLinkDetected }) => {
  // Check for links on mount and when output changes
  React.useEffect(() => {
    if (output && onLinkDetected) {
      const links = detectLinks(output);
      if (links.length > 0) {
        // Notify about the first detected link
        onLinkDetected(links[0].fullUrl);
      }
    }
  }, [output, onLinkDetected]);

  // ANSI sequences are inherently regex over control characters;
  // the no-control-regex lint warning is correct in the abstract but
  // inapplicable to terminal-output parsing.
  /* eslint-disable no-control-regex */
  // Parse ANSI codes for basic styling
  const parseAnsiToReact = (text: string) => {
    // Simple ANSI parsing - handles bold (\u001b[1m) and reset (\u001b[22m)
    const parts = text.split(/(\u001b\[\d+m)/);
    let isBold = false;
    const elements: React.ReactNode[] = [];

    parts.forEach((part, idx) => {
      if (part === '\u001b[1m') {
        isBold = true;
        return;
      } else if (part === '\u001b[22m') {
        isBold = false;
        return;
      } else if (/\u001b\[\d+m/.exec(part)) {
        // Ignore other ANSI codes for now
        return;
      }

      if (!part) return;

      // Make links clickable within this part
      const linkElements = makeLinksClickable(part, (url) => {
        onLinkDetected?.(url);
      });

      if (isBold) {
        elements.push(
          <span key={idx} className="font-bold">
            {linkElements}
        </span>
      );
      } else {
        elements.push(...linkElements);
      }
    });

    return elements;
  };
  /* eslint-enable no-control-regex */

  return (
    <div className="rounded-lg border bg-background/50 overflow-hidden">
      <div className="px-4 py-2 bg-muted/50 flex items-center gap-2">
        <ChevronRight className="h-3 w-3 text-green-500" />
        <span className="text-xs font-mono text-green-400">Output</span>
      </div>
      <div className="p-3">
        <pre className="text-sm font-mono text-zinc-300 whitespace-pre-wrap">
          {output ? parseAnsiToReact(output) : <span className="text-zinc-500 italic">No output</span>}
        </pre>
      </div>
    </div>
  );
};
