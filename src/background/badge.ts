import type { PressureSnapshot } from "../shared/types";
import { getSettings } from "../shared/storage";
import { isSnoozed } from "../shared/snooze";

// Coppice palette: bluebell for snoozed, apricot for high, coral for emergency.
// Chrome draws the badge text in white; each colour keeps at least 4.9:1 against it.
const BADGE_COLORS = { snoozed: "#5456B1", high: "#B85207", emergency: "#BA2B2E" } as const;

/**
 * Memory severity for the toolbar badge. Automation waits for sustained pressure before
 * acting, but the badge is information: it appears as soon as raw memory crosses a boundary.
 */
export function badgeSeverity(pressure: Pick<PressureSnapshot, "level" | "adaptive" | "memorySampleValid">): "high" | "emergency" | null {
  if (pressure.memorySampleValid === false) return null;
  const raw = pressure.adaptive?.rawMemoryLevel;
  if (pressure.level === "emergency" || raw === "emergency") return "emergency";
  if (pressure.level === "high" || raw === "high") return "high";
  return null;
}

export async function updateBadge(pressure: PressureSnapshot): Promise<void> {
  const settings = await getSettings();

  if (!settings.showBadge) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  if (isSnoozed(settings)) {
    await chrome.action.setBadgeText({ text: "Z" });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.snoozed });
    return;
  }

  const severity = badgeSeverity(pressure);
  if (!severity) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeText({ text: severity === "emergency" ? "!" : "H" });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[severity] });
}
