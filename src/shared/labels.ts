import type { DiscardReason } from "./types";

/** Who started an unload, in the words people use for it. */
export function discardReasonLabel(reason: DiscardReason | undefined): string {
  return reason === "manualRelease" ? "You asked" : reason === "memoryPressure" ? "Low memory" : "Automatic cleanup";
}
