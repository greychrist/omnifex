import React from "react";
import { makeLinksClickable } from "@/lib/linkDetector";

/**
 * Body for a slash command you ran (e.g. /model, /clear). Bare on purpose: it
 * renders inside a MessageFrame, which already draws the border, header and
 * icon, and sizes like every other system card body (text-xs).
 */
export const CommandWidget: React.FC<{
  commandName: string;
  commandMessage: string;
  commandArgs?: string;
}> = ({ commandName, commandMessage, commandArgs }) => {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">$</span>
        <code className="text-xs font-mono text-foreground">{commandName}</code>
        {commandArgs && (
          <code className="text-xs font-mono text-muted-foreground">{commandArgs}</code>
        )}
      </div>
      {commandMessage && commandMessage !== commandName && (
        <div className="text-xs text-muted-foreground ml-4">{commandMessage}</div>
      )}
    </div>
  );
};

/**
 * Body for a local command's stdout (/usage, /cost, …). Bare for the same
 * reason as CommandWidget.
 */
export const CommandOutputWidget: React.FC<{
  output: string;
}> = ({ output }) => {
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

      // Make links clickable within this part. These used to feed an
      // in-app preview pane; that pane was unreachable dead code and is
      // gone, so a click now opens the system browser — `window.open` is
      // caught by setWindowOpenHandler in main.ts, which routes http/https
      // through shell.openExternal.
      const linkElements = makeLinksClickable(part, (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
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
    <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words">
      {output ? parseAnsiToReact(output) : <span className="text-muted-foreground italic">No output</span>}
    </pre>
  );
};
