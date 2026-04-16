import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ExternalLink } from "lucide-react";

interface ElicitationDialogProps {
  open: boolean;
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  onAccept: () => void;
  onDecline: () => void;
}

export function ElicitationDialog({
  open,
  serverName,
  message,
  mode,
  url,
  onAccept,
  onDecline,
}: ElicitationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onDecline(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'url' && <ExternalLink className="h-4 w-4" />}
            {serverName} is requesting access
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-sm">
            {message}
          </DialogDescription>
        </DialogHeader>

        {mode === 'url' && url && (
          <div className="text-xs text-muted-foreground font-mono break-all bg-muted rounded px-3 py-2">
            {url}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onDecline}>
            Decline
          </Button>
          <Button onClick={onAccept}>
            {mode === 'url' ? 'Allow' : 'Accept'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
