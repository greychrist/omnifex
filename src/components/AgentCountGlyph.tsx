import React from "react";
import { Bot } from "lucide-react";

/**
 * "N agents still working" glyph.
 *
 * Rendered directly rather than through TabStatusGlyph, like the spinner: this
 * says what the tab is *doing*, not which of the user-configurable state glyphs
 * it is in.
 *
 * It lives in its own module because two surfaces render it — the tab strip and
 * the session widget's status bar. As a local const in TabManager the second
 * copy would have been hand-typed, and the colour, the pulse and the
 * hide-the-numeral-at-one rule would have drifted apart inside a release.
 */
export const AgentCountGlyph: React.FC<{ count: number }> = ({ count }) => {
  const label = `${count} background agent${count === 1 ? '' : 's'} working`;
  return (
    <span className="inline-flex items-center gap-0.5 text-sky-400" aria-label={label} title={label}>
      <Bot className="size-3.5 animate-pulse" />
      {/* A single agent needs no numeral — the bot itself is the message. */}
      {count > 1 && (
        <span className="text-[10px] font-medium tabular-nums leading-none">{count}</span>
      )}
    </span>
  );
};
