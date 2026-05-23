import { TerminalView } from './TerminalView';
import { MessagePanel } from './MessagePanel';

interface TuiSessionLayoutProps {
  tabId: string;
}

/**
 * 50/50 horizontal split for TUI-mode sessions. Terminal is primary
 * (left) and handles all interactive CLI state — permission prompts,
 * slash commands, typing. MessagePanel (right) renders rich cards
 * driven by the session's JSONL stream.
 */
export function TuiSessionLayout({ tabId }: TuiSessionLayoutProps) {
  return (
    <div className="flex h-full w-full">
      <div className="w-1/2 h-full border-r border-border">
        <TerminalView tabId={tabId} />
      </div>
      <div className="w-1/2 h-full">
        <MessagePanel tabId={tabId} />
      </div>
    </div>
  );
}
