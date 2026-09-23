import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { api, type SessionStatusReport } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface CliStatusDialogProps {
  open: boolean;
  tabId: string;
  onOpenChange: (open: boolean) => void;
}

/**
 * `/status` — the CLI's own status screen, for a chat-mode session that has no
 * TUI to type it into.
 *
 * The rows come from the live CLI (`get_status`) already rendered as text, so
 * they are drawn verbatim: version, session, login and account, model, MCP
 * servers, setting sources. Nothing here is parsed — the CLI owns the wording.
 */
export const CliStatusDialog: React.FC<CliStatusDialogProps> = ({ open, tabId, onOpenChange }) => {
  const [report, setReport] = useState<SessionStatusReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.sessionCliStatus(tabId));
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [tabId]);

  // Fresh on every open: the rows (MCP servers, model) move while a session runs.
  useEffect(() => {
    if (!open) return;
    setReport(null);
    setFetched(false);
    void load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Status</DialogTitle>
        </DialogHeader>

        {error && <div className="text-xs text-destructive">{error}</div>}

        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {loading && !report && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {fetched && !loading && !error && !report && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Status needs a running session on Claude Code 2.1.280 or newer.
            </div>
          )}
          {report?.sections.map((section) => (
            <section key={section.title}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{section.title}</h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                {section.rows.map((row, i) =>
                  row.label ? (
                    <React.Fragment key={`${row.label}-${i}`}>
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="break-all font-mono">{row.value}</dd>
                    </React.Fragment>
                  ) : (
                    <dd key={`row-${i}`} className="col-span-2">{row.value}</dd>
                  ),
                )}
              </dl>
            </section>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
