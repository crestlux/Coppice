import { formatPercent } from "../shared/time";
import type { PressureRootCause } from "../shared/types";

export type IntelligenceVisualState = "normal" | "warning" | "danger" | "muted";

export interface RootCausePresentation {
  headline: string;
  visualState: IntelligenceVisualState;
}

function boundedConfidence(confidence: number): number {
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
}

export function presentPressureRootCause(
  cause: PressureRootCause,
  confidence: number
): RootCausePresentation {
  const confidenceLabel = formatPercent(boundedConfidence(confidence));

  switch (cause) {
    case "none":
      return { headline: "No active pressure", visualState: "normal" };
    case "chromeTabs":
      return { headline: `Chrome tabs · ${confidenceLabel}`, visualState: "warning" };
    case "mixed":
      return { headline: `Mixed load · ${confidenceLabel}`, visualState: "warning" };
    case "otherApplications":
      return { headline: `Other apps · ${confidenceLabel}`, visualState: "warning" };
    case "insufficientData":
      return { headline: "More evidence needed", visualState: "muted" };
    case "unknown":
      return { headline: "Cause unclear", visualState: "muted" };
  }
}
