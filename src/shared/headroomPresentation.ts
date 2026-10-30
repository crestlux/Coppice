import { memoryBoundaries } from "../background/pressureModel";
import { formatBytes, formatPercent } from "./time";
import type { AdaptivePressure, PressureSnapshot, Settings } from "./types";

export type HeadroomState = Exclude<AdaptivePressure["stage"], "steady"> | "normal" | "paused";

export interface HeadroomPresentation {
  value: string;
  caption: string;
  usedLabel: string;
  usedRatio: number;
  highRatio: number;
  emergencyRatio: number;
  state: HeadroomState;
}

function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
}

/** Free memory leads; thresholds are expressed as used ratios so the gauge fills toward them. */
export function presentHeadroom(
  pressure: Pick<PressureSnapshot, "memorySampleValid" | "memoryCapacityBytes" | "memoryAvailableBytes" | "memoryAvailableRatio" | "level"> &
    { adaptive?: Partial<AdaptivePressure> },
  settings: Settings,
  snoozed: boolean
): HeadroomPresentation {
  const capacity = pressure.memoryCapacityBytes;
  if (pressure.memorySampleValid === false || !(capacity > 0)) {
    return {
      value: "No reading",
      caption: "Waiting for a memory reading",
      usedLabel: "Memory reading unavailable",
      usedRatio: 0,
      highRatio: clampRatio(1 - settings.memoryHighAvailableRatio),
      emergencyRatio: clampRatio(1 - settings.memoryEmergencyAvailableRatio),
      state: snoozed ? "paused" : "unknown"
    };
  }
  // Boundaries are capped in bytes on large machines, so the notches follow the
  // scanner's own boundaries rather than the raw percentage settings.
  const fallback = memoryBoundaries(capacity, settings);
  const highBytes = pressure.adaptive?.highBoundaryBytes ?? fallback.high;
  const emergencyBytes = pressure.adaptive?.emergencyBoundaryBytes ?? fallback.emergency;
  const usedRatio = clampRatio(1 - pressure.memoryAvailableRatio);
  // The toolbar badge names the current reading at once, while the adaptive stage waits for it to
  // last; the gauge follows whichever is more severe so the two never disagree.
  const stage = pressure.adaptive?.stage;
  const raw = pressure.adaptive?.rawMemoryLevel;
  const stageState: HeadroomState = stage ? (stage === "steady" ? "normal" : stage) : pressure.level;
  const state: HeadroomState = snoozed ? "paused"
    : raw === "emergency" ? "emergency"
    : raw === "high" && stageState !== "emergency" ? "high"
    : stageState;
  return {
    value: formatBytes(pressure.memoryAvailableBytes),
    caption: `free of ${formatBytes(capacity)}`,
    usedLabel: `${formatBytes(capacity - pressure.memoryAvailableBytes)} used (${formatPercent(usedRatio)})`,
    usedRatio,
    highRatio: clampRatio(1 - highBytes / capacity),
    emergencyRatio: clampRatio(1 - emergencyBytes / capacity),
    state
  };
}

const STATE_LABELS: Record<HeadroomState, string> = {
  normal: "Steady", watch: "Watch", high: "High", emergency: "Emergency",
  recovering: "Recovering", paused: "Paused", unknown: "Unknown"
};

/** Badge wording for a gauge state, matching the adaptive stage names shown in the popup. */
export function headroomLabel(state: HeadroomState): string {
  return STATE_LABELS[state];
}

export interface HeadroomParts {
  card: HTMLElement;
  gauge: HTMLElement;
  value: HTMLElement;
  caption: HTMLElement;
  used: HTMLElement;
}

/** Writes a presentation into gauge markup; the first reading lands without motion, later ones slide. */
export function paintHeadroom(parts: HeadroomParts, headroom: HeadroomPresentation): void {
  parts.value.textContent = headroom.value;
  parts.caption.textContent = headroom.caption;
  parts.used.textContent = headroom.usedLabel;
  parts.card.dataset.pressure = headroom.state;
  const gauge = parts.gauge.style;
  gauge.setProperty("--used", String(headroom.usedRatio));
  gauge.setProperty("--high", String(headroom.highRatio));
  gauge.setProperty("--emergency", String(headroom.emergencyRatio));
  requestAnimationFrame(() => parts.gauge.classList.add("is-live"));
}
