import React, { useCallback, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { api, type McpAuthResult, type SessionMcpServerStatus } from "@/lib/api";
import { platform } from "@/lib/platform";
import { mcpServerActions, type McpServerAction } from "@/lib/mcpServerActions";
import type { McpWatchUntil } from "@/hooks/useSessionMcpStatus";
import { cn } from "@/lib/utils";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONTENT_INDENT } from "@/components/sessionContext/rows";

/**
 * The `⋯` menu on an MCP server row, and the per-row state its actions need.
 *
 * Every action ends by watching the CLI's own status until it reports the
 * change: the control requests answer before the server actually reconnects,
 * and an OAuth sign-in finishes in the browser where nothing tells us. A
 * claude.ai connector finishes on claude.ai and the CLI may never notice, so
 * a watch that times out leaves a hint rather than spinning forever.
 */

const LABEL: Record<McpServerAction, string> = {
  authenticate: "Authenticate",
  reauthenticate: "Re-authenticate",
  enable: "Enable",
  disable: "Disable",
};

type Done = (s: SessionMcpServerStatus | undefined) => boolean;

/**
 * When the watch for an action is satisfied. Fresh per run: Re-authenticate's
 * is stateful, because right after mcp_clear_auth the CLI can still report
 * `connected` — it must see the server leave `connected` and come back.
 */
function doneFor(action: McpServerAction): Done {
  switch (action) {
    case "authenticate":
      return (s) => s?.status === "connected";
    case "reauthenticate": {
      let left = false;
      return (s) => {
        if (s === undefined) return false;
        if (s.status !== "connected") { left = true; return false; }
        return left;
      };
    }
    case "disable":
      return (s) => s?.status === "disabled";
    case "enable":
      return (s) => s !== undefined && s.status !== "disabled";
  }
}

const AUTH_WAITING = "Still waiting — reopen the panel after signing in";
const TOGGLE_WAITING = "Still waiting for the CLI to apply this — reopen the panel to check";

export interface McpRowState {
  busy: boolean;
  error: string | null;
  waiting: string | null;
}

const IDLE: McpRowState = { busy: false, error: null, waiting: null };

/** Per-row action state for the whole list, keyed by server name. */
export function useMcpRowActions(tabId: string, watchUntil: McpWatchUntil): {
  stateFor: (serverName: string) => McpRowState;
  run: (serverName: string, action: McpServerAction) => Promise<void>;
} {
  const [rows, setRows] = useState<Record<string, McpRowState>>({});

  const set = useCallback((name: string, next: McpRowState) => {
    setRows((prev) => ({ ...prev, [name]: next }));
  }, []);

  const run = useCallback(async (serverName: string, action: McpServerAction) => {
    set(serverName, { busy: true, error: null, waiting: null });
    try {
      if (action === "authenticate" || action === "reauthenticate") {
        const result: McpAuthResult = action === "authenticate"
          ? await api.sessionMcpAuthenticate(tabId, serverName)
          : await api.sessionMcpReauthenticate(tabId, serverName);
        if (result.authUrl) await platform.openExternal(result.authUrl);
      } else {
        await api.sessionMcpSetEnabled(tabId, serverName, action === "enable");
      }
      const ok = await watchUntil(serverName, doneFor(action));
      const isAuth = action === "authenticate" || action === "reauthenticate";
      set(serverName, { busy: false, error: null, waiting: ok ? null : isAuth ? AUTH_WAITING : TOGGLE_WAITING });
    } catch (err) {
      set(serverName, { busy: false, error: err instanceof Error ? err.message : String(err), waiting: null });
    }
  }, [tabId, watchUntil, set]);

  const stateFor = useCallback((serverName: string) => rows[serverName] ?? IDLE, [rows]);

  return { stateFor, run };
}

export function McpServerActionsMenu({
  server, busy, onAction,
}: {
  server: SessionMcpServerStatus;
  busy: boolean;
  onAction: (action: McpServerAction) => void;
}): React.JSX.Element | null {
  const actions = mcpServerActions(server, { canOpenBrowserCallback: platform.isDesktop });
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${server.name}`}
        disabled={busy}
        className={cn(
          "flex-none rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          "disabled:cursor-default disabled:opacity-50",
          busy && "animate-pulse",
        )}
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem] text-[11px]">
        {actions.map((action) => (
          <DropdownMenuItem key={action} className="py-1 text-[11px]" onSelect={() => { onAction(action); }}>
            {LABEL[action]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The row's error or still-waiting hint, shown without expanding the row. */
export function McpRowNotice({ state }: { state: McpRowState }): React.JSX.Element | null {
  if (state.error) {
    return (
      <div role="alert" className={cn("mb-1 mr-1.5 rounded bg-destructive/5 p-1.5 text-[11px] text-destructive", CONTENT_INDENT)}>
        {state.error}
      </div>
    );
  }
  if (state.waiting) {
    return (
      <div className={cn("mb-1 mr-1.5 px-1.5 text-[10px] text-muted-foreground", CONTENT_INDENT)}>
        {state.waiting}
      </div>
    );
  }
  return null;
}
