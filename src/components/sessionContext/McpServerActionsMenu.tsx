import React, { useCallback, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { api, type McpAuthResult, type SessionMcpServerStatus } from "@/lib/api";
import { platform } from "@/lib/platform";
import { openSignInLink } from "@/lib/signInBrowser";
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
  reconnect: "Reconnect",
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
    case "reconnect":
      return (s) => s?.status === "connected" || s?.status === "needs-auth";
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
  /** Sign-in started on a client the OAuth redirect cannot reach: the row
   *  asks for the URL the browser ended on. */
  awaitingCallback: boolean;
}

const IDLE: McpRowState = { busy: false, error: null, waiting: null, awaitingCallback: false };

/** Per-row action state for the whole list, keyed by server name.
 *  `configDir` is the session's account: sign-in links open in the browser
 *  chosen for it (`signInBrowser.ts`). */
export function useMcpRowActions(tabId: string, watchUntil: McpWatchUntil, configDir?: string | null): {
  stateFor: (serverName: string) => McpRowState;
  run: (serverName: string, action: McpServerAction) => Promise<void>;
  submitCallback: (serverName: string, callbackUrl: string) => Promise<void>;
} {
  const [rows, setRows] = useState<Record<string, McpRowState>>({});

  const set = useCallback((name: string, next: McpRowState) => {
    setRows((prev) => ({ ...prev, [name]: next }));
  }, []);

  const watch = useCallback(async (serverName: string, action: McpServerAction) => {
    const ok = await watchUntil(serverName, doneFor(action));
    const isAuth = action === "authenticate" || action === "reauthenticate";
    set(serverName, { ...IDLE, waiting: ok ? null : isAuth ? AUTH_WAITING : TOGGLE_WAITING });
  }, [watchUntil, set]);

  const run = useCallback(async (serverName: string, action: McpServerAction) => {
    set(serverName, { ...IDLE, busy: true });
    try {
      if (action === "authenticate" || action === "reauthenticate") {
        const result: McpAuthResult = action === "authenticate"
          ? await api.sessionMcpAuthenticate(tabId, serverName)
          : await api.sessionMcpReauthenticate(tabId, serverName);
        if (result.authUrl) await openSignInLink(result.authUrl, configDir);
        // The redirect goes to the CLI's localhost listener, on the daemon's
        // machine. A browser anywhere else lands on a dead page; its address
        // carries the code, so ask for it.
        if (!platform.isDesktop && result.callbackExpected) {
          set(serverName, { ...IDLE, awaitingCallback: true });
          return;
        }
      } else if (action === "reconnect") {
        await api.sessionMcpReconnect(tabId, serverName);
      } else {
        await api.sessionMcpSetEnabled(tabId, serverName, action === "enable");
      }
      await watch(serverName, action);
    } catch (err) {
      set(serverName, { ...IDLE, error: err instanceof Error ? err.message : String(err) });
    }
  }, [tabId, watch, set, configDir]);

  const submitCallback = useCallback(async (serverName: string, callbackUrl: string) => {
    set(serverName, { ...IDLE, busy: true, awaitingCallback: true });
    try {
      await api.sessionMcpSubmitCallbackUrl(tabId, serverName, callbackUrl);
      await watch(serverName, "authenticate");
    } catch (err) {
      // Keep the box: a mistyped or stale URL is fixed by pasting again.
      set(serverName, { ...IDLE, awaitingCallback: true, error: err instanceof Error ? err.message : String(err) });
    }
  }, [tabId, watch, set]);

  const stateFor = useCallback((serverName: string) => rows[serverName] ?? IDLE, [rows]);

  return { stateFor, run, submitCallback };
}

export function McpServerActionsMenu({
  server, busy, onAction,
}: {
  server: SessionMcpServerStatus;
  busy: boolean;
  onAction: (action: McpServerAction) => void;
}): React.JSX.Element | null {
  const actions = mcpServerActions(server);
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

/** Where a client away from the daemon finishes an MCP sign-in. */
function CallbackPaste({ busy, onSubmit }: { busy: boolean; onSubmit: (url: string) => void }): React.JSX.Element {
  const [url, setUrl] = useState("");
  return (
    <form
      className={cn("mb-1 mr-1.5 space-y-1 text-[11px]", CONTENT_INDENT)}
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim()) onSubmit(url.trim());
      }}
    >
      <div className="text-muted-foreground">
        After signing in, the browser lands on a page that will not load. Copy its address and paste it here.
      </div>
      <div className="flex gap-1">
        <input
          aria-label="Redirect URL"
          value={url}
          onChange={(e) => { setUrl(e.target.value); }}
          placeholder="http://localhost:…/callback?code=…"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-white/30"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="flex-none rounded border border-border px-1.5 py-0.5 hover:bg-muted/60 disabled:opacity-50"
        >
          Finish sign-in
        </button>
      </div>
    </form>
  );
}

/** The row's error or still-waiting hint, shown without expanding the row —
 *  and, mid sign-in on a remote client, the box for the redirect URL. */
export function McpRowNotice({
  state, onSubmitCallback,
}: {
  state: McpRowState;
  onSubmitCallback?: (callbackUrl: string) => void;
}): React.JSX.Element | null {
  const error = state.error ? (
    <div role="alert" className={cn("mb-1 mr-1.5 rounded bg-destructive/5 p-1.5 text-[11px] text-destructive", CONTENT_INDENT)}>
      {state.error}
    </div>
  ) : null;
  if (state.awaitingCallback && onSubmitCallback) {
    return (
      <>
        {error}
        <CallbackPaste busy={state.busy} onSubmit={onSubmitCallback} />
      </>
    );
  }
  if (error) return error;
  if (state.waiting) {
    return (
      <div className={cn("mb-1 mr-1.5 px-1.5 text-[10px] text-muted-foreground", CONTENT_INDENT)}>
        {state.waiting}
      </div>
    );
  }
  return null;
}
