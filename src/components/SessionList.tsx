import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Check, RefreshCw, Hash } from "lucide-react";
import { Pagination } from "@/components/ui/pagination";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { truncateText, getFirstLine } from "@/lib/date-utils";
import type { Session } from "@/lib/api";

interface SessionListProps {
  /**
   * Array of sessions to display
   */
  sessions: Session[];
  /**
   * The current project path being viewed
   */
  projectPath: string;
  /**
   * Optional callback to go back to project list (deprecated - use tabs instead)
   */
  onBack?: () => void;
  /**
   * Callback when a session is clicked
   */
  onSessionClick?: (session: Session) => void;
  /**
   * Callback to re-fetch the session list (refresh button). When provided,
   * the component renders a small refresh icon in the header row. The
   * component manages its own pending/spinner state while the promise is
   * in flight; callers don't need to pass any loading flag.
   */
  onRefresh?: () => Promise<void> | void;
  /**
   * Callback to open the "Open session by GUID" dialog. When provided,
   * a small `Open by ID…` button is rendered in the header row next to
   * the session count. The dialog itself is owned by the caller.
   */
  onOpenById?: () => void;
  /**
   * Optional className for styling
   */
  className?: string;
}

const ITEMS_PER_PAGE = 12;

/**
 * SessionList component - Displays paginated sessions for a specific project
 * 
 * @example
 * <SessionList
 *   sessions={sessions}
 *   projectPath="/Users/example/project"
 *   onBack={() => setSelectedProject(null)}
 *   onSessionClick={(session) => console.log('Selected session:', session)}
 * />
 */
export const SessionList: React.FC<SessionListProps> = ({
  sessions,
  projectPath,
  onSessionClick,
  onRefresh,
  onOpenById,
  className,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshClick = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  /** Most recently copied session ID — drives the "Copied" affordance on the
   *  copy button. Cleared after a short delay so the icon flips back. */
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopySessionId = (id: string) => {
    void navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1500);
  };
  
  // Calculate pagination
  const totalPages = Math.ceil(sessions.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const currentSessions = sessions.slice(startIndex, endIndex);
  
  // Reset to page 1 if sessions change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [sessions.length]);
  
  return (
    <TooltipProvider>
      <div className={cn("space-y-4", className)}>
      {/* Header row: session count + Open-by-ID + refresh. Renders only
          when at least one of those affordances is present so empty
          states stay clean. */}
      {(onRefresh || onOpenById || sessions.length > 0) && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {sessions.length} session{sessions.length !== 1 ? 's' : ''}
          </span>
          {onOpenById && (
            <button
              type="button"
              onClick={onOpenById}
              className={cn(
                "inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border/60 text-xs",
                "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
              )}
              title="Open a session by pasting its GUID"
            >
              <Hash className="h-3 w-3" />
              Open by ID…
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={() => void handleRefreshClick()}
              disabled={refreshing}
              className={cn(
                "ml-auto inline-flex items-center justify-center h-8 w-8 rounded-md border border-border/60",
                "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
              title={refreshing ? 'Refreshing…' : 'Refresh session list'}
              aria-label="Refresh session list"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </button>
          )}
        </div>
      )}


      <AnimatePresence mode="popLayout">
        <div className="rounded-md border border-border/40 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-2 px-3 w-36">Date</th>
                <th className="text-left font-medium py-2 px-3">First message</th>
                <th className="text-left font-medium py-2 px-3 w-28">Session ID</th>
              </tr>
            </thead>
            <tbody>
              {currentSessions.map((session, index) => {
                const fmt = (d: Date) =>
                  `${d.toLocaleDateString('en-US', {
                    month: 'numeric',
                    day: 'numeric',
                    year: 'numeric',
                  })} ${d.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}`;
                const firstDate = session.first_timestamp
                  ? new Date(session.first_timestamp)
                  : null;
                const lastDate = session.last_timestamp
                  ? new Date(session.last_timestamp)
                  : new Date(session.created_at * 1000);
                return (
                  <motion.tr
                    key={session.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{
                      duration: 0.2,
                      delay: index * 0.02,
                      ease: [0.4, 0, 0.2, 1],
                    }}
                    className={cn(
                      "border-t border-border/30 hover:bg-accent/40 cursor-pointer transition-colors",
                      session.todo_data && "bg-primary/5",
                    )}
                    onClick={() => {
                      const event = new CustomEvent('claude-session-selected', {
                        detail: { session, projectPath },
                      });
                      window.dispatchEvent(event);
                      onSessionClick?.(session);
                    }}
                  >
                    <td className="py-2 px-3 text-[11px] text-muted-foreground whitespace-nowrap leading-tight">
                      {firstDate && (
                        <div>{fmt(firstDate)}</div>
                      )}
                      <div className={firstDate ? 'text-muted-foreground/70' : ''}>
                        {fmt(lastDate)}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs text-foreground/90 max-w-0">
                      {session.first_message ? (
                        <span className="block truncate">
                          {truncateText(getFirstLine(session.first_message), 200)}
                        </span>
                      ) : (
                        <span className="italic text-muted-foreground/60">
                          No messages yet
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopySessionId(session.id);
                        }}
                        className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                        title={`Copy full session ID: ${session.id}`}
                      >
                        <span>{session.id.slice(0, 8)}</span>
                        {copiedId === session.id ? (
                          <Check className="h-3 w-3 text-green-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AnimatePresence>
      
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
        />
      </div>
    </TooltipProvider>
  );
}; 