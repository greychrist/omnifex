/** The CLI starts its own `claude -p` stderr warning 10 days out. */
export const LOGIN_EXPIRY_WARN_DAYS = 10;
const CRITICAL_DAYS = 2;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type LoginExpiryLevel = "ok" | "warning" | "critical" | "expired";

export interface LoginExpiryState {
  level: LoginExpiryLevel;
  relative: string;
  alert: boolean;
  expiresAt: Date;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function loginExpiryState(
  expiresAt: string | null | undefined,
  now: number,
): LoginExpiryState | null {
  if (!expiresAt) return null;
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return null;
  const left = end - now;

  const level: LoginExpiryLevel =
    left <= 0 ? "expired"
    : left <= CRITICAL_DAYS * DAY ? "critical"
    : left <= LOGIN_EXPIRY_WARN_DAYS * DAY ? "warning"
    : "ok";

  const relative =
    left <= 0 ? "expired"
    : left < HOUR ? "in under an hour"
    : left < DAY ? `in ${plural(Math.floor(left / HOUR), "hour")}`
    : `in ${plural(Math.floor(left / DAY), "day")}`;

  return { level, relative, alert: level !== "ok", expiresAt: new Date(end) };
}

export function loginExpiryColor(level: LoginExpiryLevel): string {
  return level === "ok" ? "text-foreground/90"
    : level === "warning" ? "text-amber-500"
    : "text-red-500";
}

export function formatLoginExpiryDate(d: Date): string {
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
