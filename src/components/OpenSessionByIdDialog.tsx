import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Session } from "@/lib/api";
import { validateSessionId } from "@/lib/sessionId";

interface OpenSessionByIdDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project the session is being opened in. Used to scope the JSONL lookup. */
  projectId: string;
  projectPath: string;
  /** Called with a synthesized Session when the GUID resolves to a real file. */
  onSessionResolved: (session: Session) => void;
}

export const OpenSessionByIdDialog: React.FC<OpenSessionByIdDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  projectPath,
  onSessionResolved,
}) => {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
      setLoading(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    const validation = validateSessionId(value);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const history = await api.loadSessionHistory(validation.id, projectId, projectPath);
      if (!history || history.length === 0) {
        setError(
          "No session with that ID was found in this project's directory. " +
          "Check the project (or the bound account) and try again.",
        );
        setLoading(false);
        return;
      }
      const session: Session = {
        id: validation.id,
        project_id: projectId,
        project_path: projectPath,
        created_at: Math.floor(Date.now() / 1000),
      };
      onSessionResolved(session);
      onOpenChange(false);
    } catch (e) {
      console.error("[OpenSessionByIdDialog] load failed:", e);
      setError(`Failed to load session: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open session by ID</DialogTitle>
          <DialogDescription>
            Paste a session GUID to open it directly. Useful when the session
            doesn't appear in the list yet (in‑flight, recently created, or
            bound to a different account).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="session-guid">Session ID</Label>
          <Input
            id="session-guid"
            placeholder="12345678-90ab-cdef-1234-567890abcdef"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            autoFocus
            spellCheck={false}
            className="font-mono text-sm"
          />
          {error && (
            <p className="text-xs text-destructive break-words">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => { onOpenChange(false); }}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={loading || value.trim().length === 0}>
            {loading ? "Loading…" : "Open"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
