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
import { api, type Account, type AccountEngine } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { cn } from "@/lib/utils";
import { fireAndLog } from "@/lib/fireAndLog";

interface AccountPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  onAccountSelected: (account: Account) => void;
  title?: string;
  /**
   * When set, only show accounts whose `engine` matches. When unset, all
   * accounts are shown (the historical behavior).
   */
  engineFilter?: AccountEngine;
}

export const AccountPickerDialog: React.FC<AccountPickerDialogProps> = ({
  open,
  onOpenChange,
  projectPath,
  onAccountSelected,
  title,
  engineFilter,
}) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      api.listAccounts().then(setAccounts).catch(console.error);
      setSelectedId(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (selectedId === null) return;
    setLoading(true);
    try {
      if (remember) {
        await api.setProjectAccountOverride(projectPath, selectedId);
      }
      const account = accounts.find((a) => a.id === selectedId);
      if (account) {
        onAccountSelected(account);
      }
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to set account:", error);
    } finally {
      setLoading(false);
    }
  };

  const projectName = projectPath.split("/").filter(Boolean).pop() || projectPath;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title ?? "Which account for this project?"}</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {projectName}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 my-2">
          {accounts
            .filter((account) => engineFilter === undefined || account.engine === engineFilter)
            .map((account) => (
            <button
              key={account.id}
              onClick={() => { setSelectedId(account.id); }}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-colors",
                selectedId === account.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/50 hover:bg-muted/50"
              )}
            >
              <AccountBadge name={account.name} color={account.color} />
              <span className="text-xs text-muted-foreground truncate">
                {account.config_dir}
              </span>
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => { setRemember(e.target.checked); }}
            className="rounded"
          />
          Remember for this project
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); }}>
            Cancel
          </Button>
          <Button onClick={fireAndLog('account-picker-dialog:confirm', handleConfirm)} disabled={selectedId === null || loading}>
            {loading ? "Saving..." : "Select"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
