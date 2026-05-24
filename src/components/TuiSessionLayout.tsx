import type { ReactNode } from 'react';
import { TerminalView } from './TerminalView';

interface TuiSessionLayoutProps {
  tabId: string;
  messagesView: ReactNode;
}

/**
 * 50/50 horizontal split for TUI-mode sessions. Terminal is primary
 * (left) and handles all interactive CLI state — permission prompts,
 * slash commands, typing. The messagesView (right) is the SDK-mode
 * messagesList; same renderer, same styling.
 */
export function TuiSessionLayout({ tabId, messagesView }: TuiSessionLayoutProps) {
  // Parent in ClaudeCodeSession is `h-full flex flex-col` — match the
  // SDK-mode messagesList wrapper by using `flex-1 min-h-0` so we claim
  // remaining vertical space (h-full alone behaves indeterminately inside
  // a flex-col parent). The right pane then needs its own flex-col so
  // messagesList's `flex-1 min-h-0` resolves; without it, the inner
  // overflow-y-auto container has 0 height and scrolling breaks.
  return (
    <div className="flex-1 min-h-0 flex w-full">
      <div className="w-1/2 min-h-0 border-r border-border">
        <TerminalView tabId={tabId} />
      </div>
      <div className="w-1/2 min-h-0 flex flex-col">
        {messagesView}
      </div>
    </div>
  );
}
