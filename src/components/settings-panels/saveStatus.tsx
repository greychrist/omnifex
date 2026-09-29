import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Save feedback for the Settings screen — the one rule every panel follows.
 *
 * Every setting persists the moment it changes (typed fields on blur or after
 * a typing pause); nothing waits for a Save button. Each write goes through
 * `track()`, and the <SaveStatusBanner> under the tab strip reports its real outcome:
 * "Saved" once every write in flight has landed, or the error, which stays
 * until a later save succeeds. Never report success before the write returns.
 *
 * Toasts are for one-off actions (import, reset, restore), not routine saves.
 * Forms that create or edit a record (an account, a path rule, a pricing row)
 * keep their submit button and report through `track()` as well.
 */

/** How long "Saved" stays up after the last write lands. */
export const SAVED_VISIBLE_MS = 2000;

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * Report one write. Takes the write's promise, or a function for a
 * synchronous write (localStorage). Resolves `true` when it landed and
 * `false` when it failed — it never rejects, so callers can fire and forget
 * or roll their optimistic state back on `false`.
 */
export type TrackSave = (work: Promise<unknown> | (() => unknown)) => Promise<boolean>;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";

const run = (work: Promise<unknown> | (() => unknown)): Promise<unknown> =>
  typeof work === "function" ? Promise.resolve().then(work) : work;

/** Outside a provider (a panel rendered on its own, in a test) nothing is shown. */
const standaloneTrack: TrackSave = (work) =>
  run(work).then(
    () => true,
    (err: unknown) => {
      console.error("[settings] save failed:", err);
      return false;
    },
  );

const SaveStatusContext = createContext<{ track: TrackSave; state: SaveState; dismiss: () => void }>({
  track: standaloneTrack,
  state: { kind: "idle" },
  dismiss: () => {},
});

export const SaveStatusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // Overlapping writes are one batch: the outcome is reported when the last
  // one lands, and any failure in the batch wins over the successes.
  const inFlight = useRef(0);
  const batchError = useRef<string | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
  }, []);

  const track = useCallback<TrackSave>((work) => {
    if (fadeTimer.current) {
      clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
    }
    if (inFlight.current === 0) batchError.current = null;
    inFlight.current += 1;
    setState({ kind: "saving" });

    const settle = (ok: boolean) => {
      inFlight.current -= 1;
      if (inFlight.current > 0) return ok;
      if (batchError.current !== null) {
        setState({ kind: "error", message: batchError.current });
      } else {
        setState({ kind: "saved" });
        fadeTimer.current = setTimeout(() => {
          fadeTimer.current = null;
          setState({ kind: "idle" });
        }, SAVED_VISIBLE_MS);
      }
      return ok;
    };

    return run(work).then(
      () => settle(true),
      (err: unknown) => {
        console.error("[settings] save failed:", err);
        batchError.current ??= errorMessage(err);
        return settle(false);
      },
    );
  }, []);

  const dismiss = useCallback(() => {
    if (fadeTimer.current) {
      clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
    }
    setState({ kind: "idle" });
  }, []);

  const value = useMemo(() => ({ track, state, dismiss }), [track, state, dismiss]);
  return <SaveStatusContext.Provider value={value}>{children}</SaveStatusContext.Provider>;
};

export function useSaveStatus(): { track: TrackSave } {
  return { track: useContext(SaveStatusContext).track };
}

// Solid fills rather than tinted borders: the unlayered `* { border-color }`
// reset in styles.css overrides every Tailwind border-colour utility.
const TONE: Record<SaveState["kind"], string> = {
  idle: "",
  saving: "bg-card text-muted-foreground ring-1 ring-border",
  saved: "bg-emerald-600 text-white",
  error: "bg-destructive text-destructive-foreground",
};

/**
 * The Settings save banner. Floats (absolutely positioned) so it never pushes
 * the panel down; place it inside a `relative` container. It stays mounted
 * while idle — only faded out — so screen readers hear every change.
 * `data-state` carries the outcome for styling and tests.
 */
export const SaveStatusBanner: React.FC<{ className?: string }> = ({ className }) => {
  const { state, dismiss } = useContext(SaveStatusContext);
  const idle = state.kind === "idle";
  return (
    <div
      role="status"
      aria-live="polite"
      data-state={state.kind}
      className={cn(
        "z-30 flex max-w-xl items-center gap-2 rounded-md px-4 py-2 text-body-small font-medium shadow-lg",
        "transition-all duration-200",
        idle ? "pointer-events-none -translate-y-1 opacity-0" : "translate-y-0 opacity-100",
        TONE[state.kind],
        className,
      )}
    >
      {state.kind === "saving" && (
        <>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> Saving…
        </>
      )}
      {state.kind === "saved" && (
        <>
          <Check className="h-4 w-4 shrink-0" /> Saved
        </>
      )}
      {state.kind === "error" && (
        <>
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">Couldn&apos;t save: {state.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            className="ml-2 shrink-0 rounded p-0.5 hover:bg-black/20"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
};
