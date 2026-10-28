/**
 * Modern chat format — the AI Elements visual language (shadcn / vercel
 * ai-elements), ported onto what OmniFex already uses: Radix collapsible,
 * Tailwind tokens and our markdown components. No new dependencies.
 *
 * The originals' class strings are kept where they apply: the borderless
 * assistant message, the `bg-secondary` user bubble, muted collapsible
 * triggers with an icon and a turning chevron.
 */
import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { cardRadiusStyle } from '@/lib/accentStyle';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { useTheme } from '@/hooks';
import { getClaudeSyntaxTheme } from '@/lib/claudeSyntaxTheme';
import { buildMarkdownComponents } from '@/lib/markdownComponents';

// A stable reference: ReactMarkdown re-parses when `remarkPlugins` is new.
const REMARK_PLUGINS = [remarkGfm];

/** AI Elements' Shimmer: the band's width follows the text's length. */
export function Shimmer({ children }: { children: string }) {
  return (
    <span className="modern-shimmer" style={{ '--modern-shimmer-spread': `${children.length * 2}px` } as React.CSSProperties}>
      {children}
    </span>
  );
}

export function Message({ from, children }: { from: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div className={cn('group flex w-full flex-col gap-1.5', from === 'user' ? 'items-end' : 'items-start')}>
      {children}
    </div>
  );
}

export function UserBubble({ children }: { children: React.ReactNode }) {
  const { config } = useMessageRenderingConfig();
  return (
    // Cornered like every card (All cards › Corner radius). Tint, border and
    // shadow are `.modern-prompt` in styles.css — the unlayered
    // `* { border-color }` reset there beats any Tailwind border-color utility.
    <div
      className="modern-prompt max-w-[80%] px-3 py-2.5 text-sm leading-relaxed break-words text-foreground"
      style={cardRadiusStyle(config)}
    >
      {children}
    </div>
  );
}

export const MessageResponse = React.memo(function MessageResponse({ children }: { children: string }) {
  const { theme } = useTheme();
  const components = React.useMemo(() => buildMarkdownComponents(getClaudeSyntaxTheme(theme)), [theme]);
  return (
    // Sized by `.modern-format .modern-answer` in styles.css: the .prose
    // rules are unlayered, so utilities here could not override them.
    <div className="modern-answer prose prose-sm dark:prose-invert w-full max-w-none text-foreground">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>{children}</ReactMarkdown>
    </div>
  );
});

/** Hover row under a message: actions on the left, quiet metadata on the right. */
export function MessageActions({ from, children }: { from: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex h-6 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
        from === 'user' && 'justify-end',
      )}
    >
      {children}
    </div>
  );
}
