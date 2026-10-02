import * as React from "react";
import { ShieldCheck, ShieldAlert, ShieldQuestion, RefreshCw, RotateCw, LogIn, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentKind, SessionAccountInfo } from "@/lib/api";
import type { SessionVerification } from "@/lib/accountVerification";
import type { SessionAuthFailure } from "@/lib/sessionDerivedState";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { platform } from "@/lib/platform";
import { announceAccountSignedIn } from "@/lib/accountSignIn";
import { ClaudeSignInModal } from "./ClaudeSignInModal";

/**
 * The account popover: identity, sign in / out, the CLI-reported account,
 * the config dir and how it was matched. Opened from the account widget's
 * badge and from the status bar's `account` readout — one body, so the two
 * cannot disagree.
 */

export interface AccountDetailsInputs {
  accountName: string;
  agent?: AgentKind | null;
  /**
   * Resolved account identity verification. Supplied by AgentSession rather
   * than fetched here so the popover and the header banner can never make
   * contradictory claims about the same session.
   */
  verification?: SessionVerification | null;
  /**
   * Who is signed in to `configDir` right now, from its `.claude.json`.
   * `undefined` = not known yet (or the read failed), `null` = nobody. Drives
   * Sign in vs Re-authenticate / Sign out, independent of `verification`,
   * which only exists for accounts with an expected email.
   */
  signedInEmail?: string | null;
  /**
   * This session's CLI process has lost its sign-in (`sessionAuthFailure`).
   * Independent of `signedInEmail`: the config dir's login can look fine while
   * the running process, which never re-reads its credentials, cannot work.
   */
  sessionAuthFailure?: SessionAuthFailure | null;
  /** Force a fresh identity check. */
  onRecheck?: () => void;
  /**
   * Supplied only when a restart changes something: the running process holds
   * the wrong credentials, or has lost its sign-in.
   */
  onRestart?: (() => void) | null;
  restarting?: boolean;
  configDir: string;
  matchType: string;
  matchDetail: string;
  sdkAccount?: SessionAccountInfo | null;
}

// The backend emits 'override' | 'path_rule' | 'on_disk'; the renderer also
// synthesizes 'manual_override' when the user picks an account mid-session.
// The old fallback read "default", which both mislabelled a plain 'override'
// and named a concept that does not exist — there is no default account.
function matchLabelFor(matchType: string): string {
  return matchType === "path_rule"
    ? "path rule"
    : matchType === "on_disk"
    ? "existing sessions"
    : matchType === "override" || matchType === "project_override" || matchType === "manual_override"
    ? "project override"
    : matchType;
}

/**
 * Popover content. Mounted only while the popover is open, so an armed
 * Sign out and any sign-out error reset when it closes.
 */
function AccountDetails({
  verification,
  signedInEmail,
  sessionAuthFailure = null,
  onRecheck,
  onRestart,
  restarting = false,
  configDir,
  matchType,
  matchDetail,
  sdkAccount,
  canManageAuth,
  onSignIn,
}: AccountDetailsInputs & { canManageAuth: boolean; onSignIn: () => void }): React.JSX.Element {
  // Sign out is two clicks: it cuts off every session on this account, not
  // just this one.
  const [signOutArmed, setSignOutArmed] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);

  const handleSignOut = async (): Promise<void> => {
    if (!signOutArmed) {
      setSignOutArmed(true);
      return;
    }
    setSigningOut(true);
    setAuthError(null);
    try {
      await api.claudeLogout(configDir);
      setSignOutArmed(false);
      onRecheck?.();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningOut(false);
    }
  };

  const sdkMismatch =
    sdkAccount?.apiProvider !== undefined &&
    sdkAccount.apiProvider !== 'firstParty';
  const matchLabel = matchLabelFor(matchType);

  return (
    <div className="flex flex-col gap-3 text-left">
      {sessionAuthFailure && (
        <div className="flex flex-col gap-1.5 rounded-md bg-red-500/10 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-red-500 flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" />
            This session&apos;s sign-in expired
          </div>
          <div className="text-[11px] text-foreground/70 break-words">{sessionAuthFailure.text}</div>
          <div className="text-[11px] text-foreground/60">
            Sign in again and this session restarts on its own. A running
            CLI never picks up a new sign-in.
          </div>
          {onRestart && (
            <div>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={onRestart}
                disabled={restarting}
                title="Stop this session's CLI process and start a fresh one, resuming the conversation."
              >
                <RotateCw className={cn("w-3 h-3 mr-1", restarting && "animate-spin")} />
                {restarting ? "Restarting…" : "Restart session"}
              </Button>
            </div>
          )}
        </div>
      )}
      {/* Account identity. Lives in the popover rather than on the
          shield itself: the badge is already a popover trigger, and a
          button inside a button is invalid markup. */}
      {verification && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            {verification.status === "verified" && (
              <ShieldCheck className="w-3 h-3 text-emerald-500" />
            )}
            {(verification.status === "mismatch" ||
              verification.status === "signed-out") && (
              <ShieldAlert className="w-3 h-3 text-red-500" />
            )}
            {verification.status === "unknown-account" && (
              <ShieldQuestion className="w-3 h-3 opacity-70" />
            )}
            account identity
          </div>

          {verification.status === "unknown-account" ? (
            <div className="text-xs text-muted-foreground">
              Couldn&apos;t verify — no account owns this config directory.
            </div>
          ) : (
            <div className="flex flex-col gap-1 text-xs">
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">Expected</span>
                <span className="font-mono text-foreground/90 truncate">
                  {verification.expected}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">Detected</span>
                <span
                  className={cn(
                    "font-mono truncate",
                    verification.status === "verified"
                      ? "text-emerald-500"
                      : "text-red-500",
                  )}
                >
                  {verification.detected ?? "not signed in"}
                </span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={onRecheck}
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Re-check
            </Button>
            {/* Absent unless the running process genuinely holds the
                wrong credentials — a corrected expectation needs no
                restart. */}
            {onRestart && !sessionAuthFailure && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={onRestart}
                disabled={restarting}
                title="Stop this session's CLI process and start a fresh one, resuming the conversation."
              >
                <RotateCw className={cn("w-3 h-3 mr-1", restarting && "animate-spin")} />
                {restarting ? "Restarting…" : "Restart session"}
              </Button>
            )}
          </div>
        </div>
      )}
      {/* Outside the identity block on purpose: an account with no
          expected email has no verification to show, and signing
          in or out does not depend on that check. */}
      {canManageAuth && !verification && signedInEmail !== undefined && (
        // The identity block above already shows Detected when there
        // is a verification; this covers accounts with no expected email.
        <div className="flex justify-between gap-2 text-xs">
          <span className="text-foreground/50">Signed in as</span>
          {signedInEmail === null ? (
            <span className="text-foreground/60">Not signed in</span>
          ) : (
            <span className="font-mono text-foreground/90 truncate">{signedInEmail}</span>
          )}
        </div>
      )}
      {canManageAuth && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onSignIn}
            title="Run `claude auth login` for this account's config directory."
          >
            <LogIn className="w-3 h-3 mr-1" />
            {signedInEmail === null || sessionAuthFailure ? "Sign in" : "Re-authenticate"}
          </Button>
          {signedInEmail !== null && (
            <Button
              variant={signOutArmed ? "destructive" : "outline"}
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => { void handleSignOut(); }}
              disabled={signingOut}
              title="Run `claude auth logout` for this account. Every session on this account loses its credentials."
            >
              <LogOut className="w-3 h-3 mr-1" />
              {signingOut ? "Signing out…" : signOutArmed ? "Confirm sign out" : "Sign out"}
            </Button>
          )}
        </div>
      )}
      {authError && (
        <div className="text-[11px] text-red-500 break-words">{authError}</div>
      )}
      {sdkAccount && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
            {sdkMismatch ? (
              <ShieldAlert className="w-3 h-3 text-yellow-400" />
            ) : (
              <ShieldCheck className="w-3 h-3 text-green-400" />
            )}
            CLI-reported account
          </div>
          <div className="flex flex-col gap-1 text-xs">
            {sdkAccount.email && (
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">Email</span>
                <span className="font-mono text-foreground/90 truncate">{sdkAccount.email}</span>
              </div>
            )}
            {sdkAccount.organization && (
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">Organization</span>
                <span className="font-mono text-foreground/90 truncate">{sdkAccount.organization}</span>
              </div>
            )}
            {sdkAccount.subscriptionType && (
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">Subscription</span>
                <span className="font-mono text-foreground/90 uppercase">{sdkAccount.subscriptionType}</span>
              </div>
            )}
            {sdkAccount.apiProvider && (
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">API provider</span>
                <span className={cn("font-mono", sdkMismatch ? "text-yellow-400" : "text-foreground/90")}>
                  {sdkAccount.apiProvider}
                </span>
              </div>
            )}
            {sdkAccount.tokenSource && (
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">Token source</span>
                <span className="font-mono text-foreground/90">{sdkAccount.tokenSource}</span>
              </div>
            )}
            {sdkAccount.apiKeySource && (
              <div className="flex justify-between gap-2">
                <span className="text-foreground/50">API key source</span>
                <span className="font-mono text-foreground/90">{sdkAccount.apiKeySource}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Config directory</div>
        <div className="font-mono text-xs break-all text-foreground/90">{configDir}</div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Matched by</div>
        <div className="text-xs text-foreground/90 flex flex-col gap-0.5">
          <span className="font-medium">{matchLabel}</span>
          <span className="text-foreground/60 font-mono break-all">{matchDetail}</span>
        </div>
      </div>
    </div>
  );
}

export interface AccountDetailsPopover {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: React.ReactNode;
  /** The sign-in terminal. Rendered beside the popover, not inside it: the
   *  popover closes as the dialog opens. */
  signInModal: React.ReactNode;
}

/** State and parts for one account popover and its sign-in dialog. */
export function useAccountDetailsPopover(inputs: AccountDetailsInputs): AccountDetailsPopover {
  const [open, setOpen] = React.useState(false);
  const [signInOpen, setSignInOpen] = React.useState(false);
  const { accountName, agent, configDir, onRecheck } = inputs;

  // Claude only — Codex signs in from Account Settings. And desktop only: the
  // login runs in a pty on this machine, which the web client does not have.
  const canManageAuth = platform.isElectron && agent !== "codex";

  return {
    open,
    onOpenChange: setOpen,
    content: (
      <AccountDetails
        {...inputs}
        canManageAuth={canManageAuth}
        onSignIn={() => {
          // Close the popover first: the dialog would otherwise count a
          // click in it as outside the popover.
          setOpen(false);
          setSignInOpen(true);
        }}
      />
    ),
    signInModal: canManageAuth ? (
      <ClaudeSignInModal
        open={signInOpen}
        onClose={() => { setSignInOpen(false); }}
        configDir={configDir}
        accountName={accountName}
        onAuthenticated={() => {
          onRecheck?.();
          announceAccountSignedIn(configDir);
        }}
      />
    ) : null,
  };
}
