import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Settings persist on change through `track()`; never report success before
// the write returns. Toasts are for one-off actions, not routine saves.

export const SAVED_VISIBLE_MS = 2000;

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** Never rejects: resolves `false` on failure so callers can roll back. */
export type TrackSave = (work: Promise<unknown> | (() => unknown)) => Promise<boolean>;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";

const run = (work: Promise<unknown> | (() => unknown)): Promise<unknown> =>
  typeof work === "function" ? Promise.resolve().then(work) : work;

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
  // Overlapping writes are one batch; any failure in it wins.
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
// reset in styles.css overrides every Tailwind border-color utility.
const TONE: Record<SaveState["kind"], string> = {
  idle: "",
  saving: "bg-card text-muted-foreground ring-1 ring-border",
  saved: "bg-emerald-600 text-white",
  error: "bg-destructive text-destructive-foreground",
};

/** Stays mounted while idle, faded, so screen readers hear every change. */
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
