import React from "react";

/**
 * One label | control | hint row — the compact layout the Message kinds tab's
 * editors share. `name` labels the group for assistive tech; `label` is what
 * shows when it should read shorter.
 */
export const EditorRow: React.FC<{
  name: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}> = ({ name, label, hint, children }) => (
  <div
    role="group"
    aria-label={name}
    className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-3"
  >
    <span className="text-xs font-medium text-foreground/90">{label ?? name}</span>
    <div className="flex min-w-0 items-center gap-2">{children}</div>
    <div className="justify-self-end">{hint}</div>
  </div>
);
