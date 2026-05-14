import React, { useState } from 'react';
import { ChevronsUpDown, Bot, CheckCircle2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { useScrollAnchor } from '@/lib/useScrollAnchor';
import { useTheme } from '@/hooks';
import { getClaudeSyntaxTheme } from '@/lib/claudeSyntaxTheme';

interface Props {
  description?: string;
  resultText: string;
  defaultExpanded?: boolean;
}

/**
 * Body content for the chronological "Subagent returned" marker. Renders
 * inside the parent user-message card (which provides the kind chrome —
 * accent border, KindHeader, footer timestamp). The trigger is the status
 * line; the body is the markdown-rendered subagent return.
 */
export const SubagentReturnedMarker: React.FC<Props> = ({
  description,
  resultText,
  defaultExpanded = false,
}) => {
  const [open, setOpen] = useState(defaultExpanded);
  const { ref: triggerRef, runWith } = useScrollAnchor<HTMLButtonElement>();
  const { theme } = useTheme();
  const syntaxTheme = getClaudeSyntaxTheme(theme);
  const trimmed = (resultText ?? '').replace(/\s+/g, ' ').trim();
  const preview = trimmed.length > 140 ? trimmed.slice(0, 140) + '…' : trimmed;

  return (
    <Collapsible open={open} onOpenChange={(next) => { runWith(() => { setOpen(next); }); }}>
      <CollapsibleTrigger
        ref={triggerRef}
        className={cn(
          'group flex w-full items-center justify-between gap-3 rounded-md',
          'border border-purple-500/30 bg-purple-500/5 px-3 py-1.5 text-left',
          'hover:bg-purple-500/10 transition-colors',
          'data-[state=open]:bg-purple-500/15 data-[state=open]:border-purple-500/60',
        )}
      >
        <span className="flex items-baseline gap-2 min-w-0 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-purple-600 dark:text-purple-400 shrink-0">
            <Bot className="h-3.5 w-3.5" />
            <CheckCircle2 className="h-3 w-3" />
            Subagent returned{description ? `: ${description}` : ''}
          </span>
          {preview && (
            <span className="text-muted-foreground truncate">{preview}</span>
          )}
        </span>
        <ChevronsUpDown
          className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 ml-1 pl-3 border-l-2 border-purple-500/70">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ node: _node, inline, className, children, ...props }: any) {
                const match = /language-(\w+)/.exec(className || '');
                return !inline && match ? (
                  <SyntaxHighlighter style={syntaxTheme} language={match[1]} PreTag="div" {...props}>
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                ) : (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {resultText}
          </ReactMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
