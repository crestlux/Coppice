import type { AppState, DiscardDecision, PowerStateSnapshot, PressureSnapshot, ProtectionRule, Settings, SkipReason, TabRuntimeState } from "../shared/types";
import { isFocusProtection } from "../shared/storage";
import { getHostname, isDomainMatch, isHttpUrl, matchesProtectedDomain, matchesProtectedUrlPattern } from "../shared/url";
import { getThresholdForPolicyMode } from "../shared/policyPresets";
import { adjustPolicyForPowerState, computeDiscardLearningAdjustment, freshMetricsForTabs } from "./resourceIntelligence";
import { adaptivePolicyParameters } from "./pressureModel";

export function getBaseThresholdMinutes(settings: Settings): number | null {
  return getThresholdForPolicyMode(settings);
}

export function getEffectiveThresholdMinutes(
  settings: Settings,
  pressure: PressureSnapshot,
  idleState: chrome.idle.IdleState,
  powerState?: PowerStateSnapshot
): number | null {
  const base = getBaseThresholdMinutes(settings);
  if (base == null) return null;

  let threshold = base;

  if (settings.policyMode === "pressureAdaptive") {
    threshold = adaptivePolicyParameters(settings, pressure, idleState).inactiveMinutes;
  }

  if (settings.powerPolicyMode !== "off" && (!powerState || (pressure.sampledAt >= powerState.sampledAt && pressure.sampledAt - powerState.sampledAt <= 5 * 60_000))) {
    const lowBatteryLevel = settings.lowBatteryThreshold;
    const adjustment = adjustPolicyForPowerState({
      powerState: powerState
        ? { available: powerState.supported, charging: powerState.charging, level: powerState.level }
        : undefined,
      inactiveMinutes: threshold,
      settings,
      options: {
        lowBatteryLevel,
        criticalBatteryLevel: Math.max(0.05, lowBatteryLevel / 2),
        batteryInactiveMultiplier: settings.powerPolicyMode === "lowBatteryAggressive" ? 0.85 : 0.9,
        lowBatteryInactiveMultiplier: settings.powerPolicyMode === "lowBatteryAggressive" ? 0.65 : 0.8,
        criticalBatteryInactiveMultiplier: settings.powerPolicyMode === "lowBatteryAggressive" ? 0.5 : 0.7
      }
    });
    threshold = adjustment.inactiveMinutes;
    if (
      settings.powerPolicyMode === "lowBatteryAggressive" &&
      powerState?.supported &&
      powerState.charging === false &&
      powerState.level != null &&
      powerState.level <= settings.lowBatteryThreshold
    ) {
      threshold = Math.min(threshold, settings.aggressiveMinutes);
    }
  }

  return threshold;
}

export function getSettingsForWindow(state: AppState, windowId: number): Settings {
  const windowPolicy = state.windowPolicies.find(policy => policy.windowId === windowId);
  if (!windowPolicy || windowPolicy.policyMode === "inherit") {
    return state.settings;
  }
  return {
    ...state.settings,
    policyMode: windowPolicy.policyMode
  };
}

// A page still loading a minute after it was last used is usually held open by ads or
// streaming requests, not by a load the person is waiting for, so it can be unloaded.
export const LOADING_GRACE_MINUTES = 1;

export function isSettlingLoad(tab: chrome.tabs.Tab, now = Date.now()): boolean {
  if (tab.status !== "loading") return false;
  const lastAccessed = typeof tab.lastAccessed === "number" ? tab.lastAccessed : now;
  return now - lastAccessed < LOADING_GRACE_MINUTES * 60_000;
}

export function getSkipReason(
  tab: chrome.tabs.Tab,
  settings: Settings,
  rules: ProtectionRule[],
  temporaryProtectedTabIds: Set<number>,
  inactiveMinutes: number,
  thresholdMinutes: number
): SkipReason | null {
  if (tab.id == null) return "noTabId";
  // Chrome cannot discard the active tab. Automatically activating a fallback
  // would unexpectedly steal focus, so this invariant is not configurable.
  if (tab.active) return "active";
  if (settings.protectPinned && tab.pinned) return "pinned";
  if (settings.protectAudible && tab.audible) return "audible";
  if (tab.discarded) return "discarded";
  if (tab.status === "loading" && inactiveMinutes < LOADING_GRACE_MINUTES) return "loading";
  if (settings.protectIncognito && tab.incognito) return "incognito";
  if (!tab.url) return "noUrl";
  if (!isHttpUrl(tab.url)) return "specialScheme";
  if (settings.respectAutoDiscardableFalse && tab.autoDiscardable === false) return "autoDiscardableFalse";

  const hostname = getHostname(tab.url);
  if (hostname && matchesProtectedDomain(hostname, rules)) return "protectedDomain";
  if (matchesProtectedUrlPattern(tab.url, rules)) return "protectedUrlPattern";
  if (temporaryProtectedTabIds.has(tab.id)) return "protectedTemporary";
  if (inactiveMinutes < thresholdMinutes) return "recentlyActive";

  return null;
}

export function toRuntimeTab(tab: chrome.tabs.Tab, now: number): TabRuntimeState {
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    groupId: tab.groupId,
    url: tab.url,
    title: tab.title,
    domain: getHostname(tab.url) ?? undefined,
    active: tab.active,
    pinned: tab.pinned,
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    frozen: tab.frozen,
    incognito: tab.incognito,
    autoDiscardable: tab.autoDiscardable,
    lastAccessedAt: typeof tab.lastAccessed === "number" ? tab.lastAccessed : now,
    lastObservedAt: now
  };
}

export function computeCandidateScore(tab: TabRuntimeState, inactiveMinutes: number, _pressure: PressureSnapshot): number {
  // Diminishing age returns leave room for measured benefit and reload cost.
  return Math.min(60, 12 * Math.log2(1 + Math.max(0, inactiveMinutes) / 5)) + (tab.frozen ? 2 : 0);
}

export function evaluateTabs(input: {
  tabs: chrome.tabs.Tab[];
  state: AppState;
  pressure: PressureSnapshot;
  idleState: chrome.idle.IdleState;
  reason: "startup" | "periodic" | "manual";
}): DiscardDecision[] {
  const now = input.pressure.sampledAt;
  const manual = input.reason === "manual";
  const temporaryProtectedTabIds = new Set(input.state.temporaryTabProtections.map(protection => protection.tabId));
  const focusedTabIds = new Set(input.state.temporaryTabProtections.filter(isFocusProtection).map(protection => protection.tabId));
  const focusModeActive = input.state.focusModeEnabled && focusedTabIds.size > 0;
  const freshMetrics = new Map(freshMetricsForTabs(input.state.tabAccurateMetrics, input.tabs, now).map(metric => [metric.tabId, metric]));

  return input.tabs.map(tab => {
    const settings = getSettingsForWindow(input.state, tab.windowId);
    const runtimeTab = toRuntimeTab(tab, now);
    const hostname = runtimeTab.domain;
    const metric = freshMetrics.get(runtimeTab.tabId);
    // TaskDuration is renderer work per wall second, not percent of the machine.
    const cpuEvidence = input.pressure.cpuLevel === "high" && metric?.cpuTaskRatio != null &&
      Number.isFinite(metric.cpuTaskRatio) && metric.cpuTaskRatio >= 0.2 &&
      now - metric.sampledAt <= 2 * 60_000;
    let threshold = manual ? 0 : getEffectiveThresholdMinutes(settings, input.pressure, input.idleState, input.state.powerState);
    const rationale: string[] = [];
    if (!manual && cpuEvidence && settings.policyMode === "pressureAdaptive" && threshold != null) {
      threshold = Math.min(threshold, 5);
      rationale.push("Sustained system CPU pressure and fresh renderer task work justify an earlier threshold for this tab.");
    }
    if (!manual) {
      const domainThresholds = hostname ? settings.domainDiscardRules.filter(rule => isDomainMatch(hostname, rule.domain)).map(rule => rule.inactiveMinutes) : [];
      if (domainThresholds.length) {
        const domainThreshold = Math.min(...domainThresholds);
        threshold = threshold == null ? domainThreshold : Math.min(threshold, domainThreshold);
        rationale.push("An explicit site inactivity rule applies.");
      }
      if (focusModeActive && !focusedTabIds.has(tab.id ?? -1)) {
        threshold = threshold == null ? settings.aggressiveMinutes : Math.min(threshold, settings.aggressiveMinutes);
        rationale.push("Focus Mode advances cleanup of surrounding tabs.");
      }
    }
    let learningMultiplier = 1;
    let reuseGrace = false;
    if (!manual && threshold != null && settings.discardLearningEnabled && hostname) {
      const history = input.state.discardLog.filter(event => event.domain === hostname);
      const adjustment = computeDiscardLearningAdjustment({
        events: history, now, baseScore: 1, baseInactiveMinutes: threshold,
        options: { quickReactivationWindowMs: settings.quickReactivateMinutes * 60_000 }
      });
      if (history.length) {
        threshold = adjustment.adjustedInactiveMinutes;
        learningMultiplier = adjustment.scoreMultiplier;
        if (adjustment.risk !== "none") rationale.push(adjustment.reason);
      } else {
        // Migrate old summaries gently when their detailed log has expired.
        const legacyPenalty = Math.max(0, ...(input.state.discardLearning ?? [])
          .filter(record => isDomainMatch(hostname, record.domain) && now >= record.lastFeedbackAt &&
            now - record.lastFeedbackAt <= 30 * 24 * 60 * 60_000)
          .map(record => (record.baselinePenaltyMinutes ?? record.thresholdPenaltyMinutes) * 2 ** (-(now - record.lastFeedbackAt) / (7 * 24 * 60 * 60_000))));
        threshold += Math.round(legacyPenalty);
        if (legacyPenalty >= 1) rationale.push("Older feedback adds a delay that decays with time.");
      }
      const latestReturn = Math.max(0, ...input.state.discardLog
        .filter(event => event.tabId === tab.id && event.url === tab.url)
        .flatMap(event => [event.reactivatedAt, event.undoneAt])
        .filter((time): time is number => typeof time === "number" && Number.isFinite(time) && time <= now));
      const returnGrace = Math.min(30, settings.quickReactivateMinutes * 2);
      if (latestReturn && now - latestReturn < returnGrace * 60_000) {
        reuseGrace = true;
        threshold = Math.max(threshold, returnGrace);
        rationale.push("A recent reopen or Undo grants a reuse grace period.");
      }
    }
    const lastAccessedAt = typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : now;
    const inactiveMinutes = Math.max(0, (now - lastAccessedAt) / 60_000);
    const protectionSettings = input.pressure.level === "emergency"
      ? { ...settings, protectPinned: true, protectAudible: true, protectIncognito: true, respectAutoDiscardableFalse: true }
      : settings;
    // A tab that couldn't be checked is held back only from routine cleanup; a manual action or low
    // memory checks it again and may unload it. Detected drafts stay held.
    const uncheckedMayUnload = input.reason === "manual" || input.pressure.level === "high" || input.pressure.level === "emergency";
    const workHold = settings.protectUnsavedWork ? input.state.workProtectionHolds?.find(hold =>
      hold.tabId === tab.id && hold.url === tab.url && hold.lastAccessed === (tab.lastAccessed ?? 0) &&
      hold.checkedAt <= now && hold.expiresAt > now && !(hold.reason === "workStateUnknown" && uncheckedMayUnload)) : undefined;
    const skipReason = threshold == null ? "manualPolicy" : getSkipReason(tab, protectionSettings,
      input.state.protectionRules, temporaryProtectedTabIds, inactiveMinutes, threshold) ??
      (reuseGrace ? "recentlyActive" : null) ?? workHold?.reason ?? null;
    const measuredHeapBytes = metric?.jsHeapUsedBytes != null && Number.isFinite(metric.jsHeapUsedBytes) && metric.jsHeapUsedBytes >= 0
      ? metric.jsHeapUsedBytes : undefined;
    const recency = metric ? Math.max(0, 1 - (now - metric.sampledAt) / (5 * 60_000)) : 0;
    const heapScore = measuredHeapBytes == null ? 0 : Math.min(30, 6 * Math.log2(1 + measuredHeapBytes / (64 * 1024 ** 2))) *
      (input.pressure.level === "normal" ? 0.35 : 1) * recency;
    const cpuScore = cpuEvidence ? Math.min(45, metric!.cpuTaskRatio! * 45) * recency : 0;
    const score = (computeCandidateScore(runtimeTab, inactiveMinutes, input.pressure) + heapScore + cpuScore) * learningMultiplier;
    if (threshold != null) rationale.unshift(`Eligible after ${Math.round(threshold)} min inactive.`);
    if (measuredHeapBytes != null) rationale.push("Fresh JS heap contributes to priority; it is not total tab memory.");
    if (skipReason) rationale.push(`Kept: ${skipReason}.`);
    return {
      tab: runtimeTab, action: skipReason ? "skip" : "discard", skipReason: skipReason ?? undefined,
      reason: skipReason ? undefined : manual ? "manualRelease" : input.pressure.level === "emergency" ? "memoryPressure" : "autoInactive",
      inactiveMinutes, score, effectiveThresholdMinutes: threshold ?? undefined, rationale, measuredHeapBytes, cpuEvidence
    };
  });
}
