import type { PressureRootCause } from "../shared/types";

export type IntelligenceVisualState = "normal" | "warning" | "danger" | "muted";

export interface RootCausePresentation {
  headline: string;
  visualState: IntelligenceVisualState;
}

export function presentPressureRootCause(
  cause: PressureRootCause
): RootCausePresentation {
  switch (cause) {
    case "none":
      return { headline: "No active pressure", visualState: "normal" };
    case "chromeTabs":
      return { headline: "Mostly Chrome tabs", visualState: "warning" };
    case "mixed":
      return { headline: "Tabs and other apps", visualState: "warning" };
    case "otherApplications":
      return { headline: "Mostly other apps", visualState: "warning" };
    case "insufficientData":
    case "unknown":
      return { headline: "Cause unclear", visualState: "muted" };
  }
}
