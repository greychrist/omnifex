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

export function Shimmer({ children }: { children: string }) {
  return (
    <span className="modern-shimmer" style={{ '--modern-shimmer-spread': `${children.length * 2}px` } as React.CSSProperties}>
      {children}
    </span>
  );
}

export function Message({ from, children, ...props }: Omit<React.ComponentProps<'div'>, 'className'> & { from: 'user' | 'assistant' }) {
  return (
    <div className={cn('modern-hover-row group flex w-full flex-col gap-1.5', from === 'user' ? 'items-end' : 'items-start')} {...props}>
      {children}
    </div>
  );
}

export function UserBubble({ children }: { children: React.ReactNode }) {
  const { config } = useMessageRenderingConfig();
  if (config.modern.promptStyle === 'line') {
    return (
      <div className={cn('modern-prompt-line max-w-[80%] py-1 pr-4 text-right text-sm leading-relaxed break-words text-foreground', !config.modern.promptColorEnabled && 'modern-card-plain')}>
        {children}
      </div>
    );
  }
  return (
    // Tint and border live in `.modern-prompt` (styles.css): the unlayered `* { border-color }` reset beats border-color utilities.
    <div
      className={cn(
        'modern-prompt max-w-[80%] px-3 py-2.5 text-sm leading-relaxed break-words text-foreground',
        config.modern.promptColorEnabled
          ? config.modern.promptShadow && 'modern-card-shadow'
          : 'modern-card-plain',
      )}
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
    // Sized in styles.css: the unlayered .prose rules beat utilities here.
    <div className="modern-answer prose prose-sm dark:prose-invert w-full max-w-none text-foreground">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>{children}</ReactMarkdown>
    </div>
  );
});

export function MessageActions({ from, children }: { from: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div
      data-message-actions
      className={cn(
        'flex h-6 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
        from === 'user' && 'justify-end',
      )}
    >
      {children}
    </div>
  );
}
