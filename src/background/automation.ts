import type { AppState, AutomationPlan, DiscardDecision, PressureSnapshot } from "../shared/types";
import { isSnoozed } from "../shared/snooze";
import { getEffectiveThresholdMinutes, getSettingsForWindow } from "./policy";
import { adaptivePolicyParameters, memoryBoundaries } from "./pressureModel";
import { adjustPolicyForPowerState } from "./resourceIntelligence";

const MiB = 1024 ** 2;
const MINUTE = 60_000;
export function automaticScanInterval(state: Pick<AppState, "settings" | "windowPolicies">, pressure: PressureSnapshot, idleState: chrome.idle.IdleState): number {
  const modes = new Set([state.settings.policyMode, ...state.windowPolicies.filter(item => item.policyMode !== "inherit").map(item => item.policyMode)]);
  return Math.min(...[...modes].map(mode => mode === "pressureAdaptive"
    ? adaptivePolicyParameters({ ...state.settings, policyMode: mode }, pressure, idleState).scanMinutes
    : state.settings.scanIntervalMinutes));
}

/** Same planner for scans and Policy Lab: no writes, no actions, no debugger attachment. */
export function buildAutomationPlan(input: {
  state: AppState; pressure: PressureSnapshot; idleState?: chrome.idle.IdleState; decisions: DiscardDecision[];
}): AutomationPlan {
  const { state, pressure, decisions } = input;
  const { settings } = state;
  const now = pressure.sampledAt;
  const idleState = input.idleState ?? "active";
  const stage = pressure.adaptive?.stage ?? (pressure.level === "normal" ? "steady" : pressure.level);
  const eligible = decisions.filter(item => item.action === "discard").sort((a, b) => b.score - a.score || a.tab.tabId - b.tab.tabId);
  const plan: AutomationPlan = {
    evaluatedAt: now, mode: "routine", pressureStage: stage,
    inactiveThresholdMinutes: getEffectiveThresholdMinutes(settings, pressure, idleState, state.powerState),
    maxDiscards: settings.maxAutoDiscardsPerScan, eligibleCount: eligible.length, selectedTabIds: [],
    nextScanMinutes: automaticScanInterval(state, pressure, idleState),
    measuredCandidateCount: eligible.filter(item => item.measuredHeapBytes != null || item.cpuEvidence).length,
    recentOutcomeCount: 0, ineffectiveOutcomeCount: 0, reasons: [...(pressure.adaptive?.evidence ?? [])]
  };
  const hold = (mode: AutomationPlan["mode"], reason: string, until?: number) => {
    plan.mode = mode; plan.maxDiscards = 0; plan.cooldownUntil = until; plan.reasons.push(reason); return plan;
  };
  if (isSnoozed(settings, now)) return hold("paused", "Automatic cleanup is snoozed.");
  if (settings.policyMode === "manual" && !eligible.length) return hold("manual", "Manual policy; no explicit site or window rule requests cleanup.");

  const windowLimits = new Map<number, number>();
  for (const decision of eligible) {
    const windowSettings = getSettingsForWindow(state, decision.tab.windowId);
    windowLimits.set(decision.tab.windowId, windowSettings.policyMode === "pressureAdaptive"
      ? adaptivePolicyParameters(windowSettings, pressure, idleState).batchLimit : settings.maxAutoDiscardsPerScan);
  }
  if (windowLimits.size) plan.maxDiscards = Math.min(plan.maxDiscards, [...windowLimits.values()].reduce((a, b) => a + b, 0));
  else if (settings.policyMode === "pressureAdaptive") plan.maxDiscards = adaptivePolicyParameters(settings, pressure, idleState).batchLimit;

  const power = state.powerState;
  if (settings.powerPolicyMode !== "off" && power && now >= power.sampledAt && now - power.sampledAt <= 5 * MINUTE) {
    const adjustment = adjustPolicyForPowerState({
      powerState: { available: power.supported, charging: power.charging, level: power.level },
      inactiveMinutes: plan.inactiveThresholdMinutes ?? 15, settings,
      options: { lowBatteryLevel: settings.lowBatteryThreshold, criticalBatteryLevel: Math.max(0.05, settings.lowBatteryThreshold / 2) }
    });
    plan.maxDiscards = Math.min(plan.maxDiscards, adjustment.maxAutoDiscardsPerScan);
    if (adjustment.maxAutoDiscardsPerScan < settings.maxAutoDiscardsPerScan) plan.reasons.push("Battery policy limits batch size to avoid a reload burst.");
  }

  const outcomes = (state.effectHistory ?? []).filter(item =>
    item.sampledAt <= now && now - item.sampledAt <= 30 * MINUTE && item.discardedCount > 0 &&
    (item.discardReason === "autoInactive" || item.discardReason === "memoryPressure"))
    .sort((a, b) => b.sampledAt - a.sampledAt);
  const measured = outcomes.filter(item => Number.isFinite(item.estimatedFreedBytes) &&
    (item.releaseStatus == null || item.releaseStatus === "measured"));
  const meaningfulRelease = Math.max(32 * MiB, Math.min(128 * MiB, pressure.memoryCapacityBytes * 0.001));
  let ineffective = 0;
  for (const outcome of measured) {
    if (outcome.estimatedFreedBytes! >= meaningfulRelease) break;
    ineffective++;
  }
  plan.recentOutcomeCount = measured.length;
  plan.ineffectiveOutcomeCount = ineffective;
  const latest = outcomes[0];
  const summary = state.lastDiscardSummary;
  const lastAutoAt = Math.max(latest?.sampledAt ?? 0,
    summary && summary.reason !== "manualRelease" && summary.discardedCount > 0 && summary.completedAt <= now ? summary.completedAt : 0);
  const memoryElevated = pressure.level !== "normal" && pressure.memorySampleValid !== false;
  const emergency = stage === "emergency";
  if (lastAutoAt) {
    // Allow delayed OS reclamation; a single noisy system delta cannot justify
    // another large batch. Repeated ineffective attempts increase backoff.
    const waitMs = ineffective >= 2 ? Math.min(20, 5 * 2 ** (ineffective - 2)) * MINUTE
      : latest?.releaseStatus === "measurementFailed" ? 3 * MINUTE
      : emergency ? 30_000 : 90_000;
    if (now < lastAutoAt + waitMs) return hold("cooldown",
      ineffective >= 2 ? "Recent cleanup batches did not improve system headroom; backing off before another small probe."
        : "Waiting for memory reclamation and observing the previous cleanup outcome.", lastAutoAt + waitMs);
  }
  const latestExternalAt = Math.max(0, ...(state.externalDiscardObservations ?? [])
    .filter(item => item.observedAt <= now).map(item => item.observedAt));
  if (memoryElevated && latestExternalAt && now - latestExternalAt < 90_000 && !emergency) {
    return hold("cooldown", "Chrome or another extension just unloaded tabs; waiting to see the effect first.", latestExternalAt + 90_000);
  }
  if (stage === "recovering") return hold("observe", "Headroom is recovering; additional cleanup is paused.");
  if (memoryElevated) {
    const assessment = state.rootCauseAssessment;
    const cause = assessment && now >= assessment.assessedAt && now - assessment.assessedAt <= 2 * MINUTE ? assessment : undefined;
    const positive = measured.filter(item => now - item.sampledAt <= 10 * MINUTE && item.estimatedFreedBytes! >= meaningfulRelease);
    if (positive.length && ineffective === 0) {
      plan.mode = "pressureRelief";
      // System deltas only guide a conservative batch budget; they are never
      // presented as precise per-tab reclaimed memory.
      const perTab = positive.map(item => item.estimatedFreedBytes! / item.discardedCount).sort((a, b) => a - b);
      const estimate = perTab[Math.floor(perTab.length / 2)];
      const { high, margin } = memoryBoundaries(pressure.memoryCapacityBytes, settings);
      const deficit = Math.max(0, high + margin - pressure.memoryAvailableBytes);
      plan.maxDiscards = Math.min(plan.maxDiscards, positive.length < 2 ? 2 : settings.maxAutoDiscardsPerScan, Math.max(1, Math.ceil(deficit / Math.max(1, estimate))));
      plan.reasons.push("Recent cleanup was followed by more available memory; the remaining headroom deficit bounds this batch.");
    } else {
      plan.mode = "probe";
      plan.maxDiscards = Math.min(plan.maxDiscards, cause?.recommendation === "allowBoundedTabCleanup" && ineffective === 0 ? 2 : 1);
      plan.reasons.push(ineffective ? "Retrying at most one eligible tab after backoff to reassess benefit."
        : "Attribution is incomplete; try a small eligible batch and measure the result.");
    }
  } else if (pressure.cpuLevel === "high") {
    plan.mode = "cpuRelief";
    plan.reasons.push("Only tabs with fresh renderer task measurements receive an earlier CPU threshold; other tabs keep their normal inactivity rule.");
  }
  if (plan.maxDiscards === 0) return hold("observe", "Waiting before the next cleanup.");
  const usedByWindow = new Map<number, number>();
  for (const candidate of eligible) {
    if (plan.selectedTabIds.length >= plan.maxDiscards) break;
    const used = usedByWindow.get(candidate.tab.windowId) ?? 0;
    if (used >= (windowLimits.get(candidate.tab.windowId) ?? 0)) continue;
    plan.selectedTabIds.push(candidate.tab.tabId);
    usedByWindow.set(candidate.tab.windowId, used + 1);
  }
  if (!plan.selectedTabIds.length) plan.reasons.push("No tab currently meets the inactivity and protection rules.");
  else plan.reasons.push(`Selected ${plan.selectedTabIds.length} of ${eligible.length} eligible tabs using inactivity, fresh measurements and reuse feedback.`);
  return plan;
}
