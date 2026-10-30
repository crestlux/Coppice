import type { Settings } from "./types";

export function activeSnoozeUntil(settings: Pick<Settings, "snoozeUntil"> | undefined, now = Date.now()): number | null {
  const until = settings?.snoozeUntil ?? 0;
  return until > now ? until : null;
}

export function isSnoozed(settings: Pick<Settings, "snoozeIndefinitely" | "snoozeUntil"> | undefined, now = Date.now()): boolean {
  return Boolean(settings?.snoozeIndefinitely) || activeSnoozeUntil(settings, now) != null;
}
