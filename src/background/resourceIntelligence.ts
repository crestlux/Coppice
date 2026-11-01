import type {
  DiscardLogEntry,
  AppState,
  DiscardLearningRecord,
  DiscardReason,
  MemoryReleaseEstimate,
  PressureSnapshot,
  Settings,
  TabAccurateMetrics
} from "../shared/types";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_CPU_HIGH_RATIO = 0.85;
const DEFAULT_INTENT_TTL_MS = 10_000;
const DEFAULT_MAX_INTENTS = 256;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonNegativeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface PowerStateSnapshot {
  /** False when the platform does not expose a usable battery/power API. */
  available: boolean;
  charging?: boolean | null;
  /** Battery charge as a ratio in the inclusive range 0..1. */
  level?: number | null;
}

export interface PowerPolicyOptions {
  lowBatteryLevel: number;
  criticalBatteryLevel: number;
  batteryInactiveMultiplier: number;
  lowBatteryInactiveMultiplier: number;
  criticalBatteryInactiveMultiplier: number;
  maxDiscardsOnBattery: number;
  maxDiscardsOnLowBattery: number;
  maxDiscardsOnCriticalBattery: number;
  minimumInactiveMinutes: number;
  enableNetworkFilteringOnLowBattery: boolean;
}

export type PowerPolicyStatus =
  | "unavailable"
  | "charging"
  | "batteryUnknown"
  | "onBattery"
  | "lowBattery"
  | "criticalBattery";

export interface PowerPolicyAdjustment {
  status: PowerPolicyStatus;
  applied: boolean;
  batteryLevel: number | null;
  inactiveMinutes: number;
  maxAutoDiscardsPerScan: number;
  networkFilteringMode: Settings["networkFilteringMode"];
  reason: string;
}

const DEFAULT_POWER_POLICY_OPTIONS: PowerPolicyOptions = {
  lowBatteryLevel: 0.2,
  criticalBatteryLevel: 0.1,
  batteryInactiveMultiplier: 0.9,
  lowBatteryInactiveMultiplier: 0.75,
  criticalBatteryInactiveMultiplier: 0.6,
  maxDiscardsOnBattery: 4,
  maxDiscardsOnLowBattery: 2,
  maxDiscardsOnCriticalBattery: 1,
  minimumInactiveMinutes: 2,
  enableNetworkFilteringOnLowBattery: true
};

/**
 * Derives a bounded policy recommendation from power state.
 *
 * Missing, malformed, or charging state never makes cleanup more aggressive.
 * Battery policy can shorten the inactive threshold, but it also reduces the
 * per-scan cap so that a low battery cannot trigger a large discard burst.
 */
export function adjustPolicyForPowerState(input: {
  powerState?: PowerStateSnapshot | null;
  inactiveMinutes: number;
  settings: Pick<Settings, "maxAutoDiscardsPerScan" | "networkFilteringMode">;
  options?: Partial<PowerPolicyOptions>;
}): PowerPolicyAdjustment {
  const baseInactiveMinutes = nonNegativeFinite(input.inactiveMinutes, 0);
  const baseMaxDiscards = Math.max(0, Math.floor(nonNegativeFinite(input.settings.maxAutoDiscardsPerScan, 0)));
  const unchanged = (
    status: PowerPolicyStatus,
    reason: string,
    batteryLevel: number | null = null
  ): PowerPolicyAdjustment => ({
    status,
    applied: false,
    batteryLevel,
    inactiveMinutes: baseInactiveMinutes,
    maxAutoDiscardsPerScan: baseMaxDiscards,
    networkFilteringMode: input.settings.networkFilteringMode,
    reason
  });

  const state = input.powerState;
  if (!state?.available) {
    return unchanged("unavailable", "Power information is unavailable; the configured policy is unchanged.");
  }
  if (typeof state.charging !== "boolean") {
    return unchanged("unavailable", "Power information is incomplete; the configured policy is unchanged.");
  }
  if (state.charging) {
    return unchanged("charging", "External power is connected; the configured policy is unchanged.", isRatio(state.level) ? state.level : null);
  }
  if (!isRatio(state.level)) {
    return unchanged("batteryUnknown", "Battery level is unavailable; the configured policy is unchanged.");
  }

  const configured = { ...DEFAULT_POWER_POLICY_OPTIONS, ...input.options };
  const criticalLevel = isRatio(configured.criticalBatteryLevel)
    ? configured.criticalBatteryLevel
    : DEFAULT_POWER_POLICY_OPTIONS.criticalBatteryLevel;
  const lowLevelCandidate = isRatio(configured.lowBatteryLevel)
    ? configured.lowBatteryLevel
    : DEFAULT_POWER_POLICY_OPTIONS.lowBatteryLevel;
  const lowLevel = Math.max(criticalLevel, lowLevelCandidate);
  const minimumInactiveMinutes = Math.max(
    1,
    nonNegativeFinite(configured.minimumInactiveMinutes, DEFAULT_POWER_POLICY_OPTIONS.minimumInactiveMinutes)
  );

  let status: PowerPolicyStatus = "onBattery";
  let multiplier = nonNegativeFinite(
    configured.batteryInactiveMultiplier,
    DEFAULT_POWER_POLICY_OPTIONS.batteryInactiveMultiplier
  );
  let discardCap = configured.maxDiscardsOnBattery;

  if (state.level <= criticalLevel) {
    status = "criticalBattery";
    multiplier = nonNegativeFinite(
      configured.criticalBatteryInactiveMultiplier,
      DEFAULT_POWER_POLICY_OPTIONS.criticalBatteryInactiveMultiplier
    );
    discardCap = configured.maxDiscardsOnCriticalBattery;
  } else if (state.level <= lowLevel) {
    status = "lowBattery";
    multiplier = nonNegativeFinite(
      configured.lowBatteryInactiveMultiplier,
      DEFAULT_POWER_POLICY_OPTIONS.lowBatteryInactiveMultiplier
    );
    discardCap = configured.maxDiscardsOnLowBattery;
  }

  // Never let custom options lengthen the threshold or increase the configured cap.
  const safeMultiplier = clamp(multiplier, 0.25, 1);
  const safeCap = Math.max(0, Math.floor(nonNegativeFinite(discardCap, 0)));
  const inactiveMinutes =
    baseInactiveMinutes === 0 ? 0 : Math.max(minimumInactiveMinutes, Math.ceil(baseInactiveMinutes * safeMultiplier));
  const maxAutoDiscardsPerScan = Math.min(baseMaxDiscards, safeCap);
  const enableNetworkFiltering =
    configured.enableNetworkFilteringOnLowBattery && (status === "lowBattery" || status === "criticalBattery");
  const networkFilteringMode = enableNetworkFiltering ? "light" : input.settings.networkFilteringMode;
  const applied =
    inactiveMinutes !== baseInactiveMinutes ||
    maxAutoDiscardsPerScan !== baseMaxDiscards ||
    networkFilteringMode !== input.settings.networkFilteringMode;

  return {
    status,
    applied,
    batteryLevel: state.level,
    inactiveMinutes,
    maxAutoDiscardsPerScan,
    networkFilteringMode,
    reason:
      status === "criticalBattery"
        ? "Critical battery policy uses an earlier threshold, a one-tab cleanup cap, and light network filtering."
        : status === "lowBattery"
          ? "Low battery policy uses an earlier threshold, a small cleanup cap, and light network filtering."
          : "Battery policy makes a small, bounded adjustment while preserving configured protections."
  };
}

export type CpuPressureLevel = "unknown" | "normal" | "high";

export interface CpuPressureClassification {
  level: CpuPressureLevel;
  isHigh: boolean;
  usageRatio: number | null;
  highRatio: number;
  usedFallbackThreshold: boolean;
  reason: string;
}

/** Classifies the already sampled CPU ratio without performing any I/O. */
export function classifyCpuPressure(
  cpuUsageRatio: number | null | undefined,
  settings: Pick<Settings, "cpuHighRatio">
): CpuPressureClassification {
  const thresholdIsValid = isRatio(settings.cpuHighRatio) && settings.cpuHighRatio > 0;
  const highRatio = thresholdIsValid ? settings.cpuHighRatio : DEFAULT_CPU_HIGH_RATIO;

  if (!isRatio(cpuUsageRatio)) {
    return {
      level: "unknown",
      isHigh: false,
      usageRatio: null,
      highRatio,
      usedFallbackThreshold: !thresholdIsValid,
      reason: "No valid CPU delta sample is available; CPU pressure is not inferred."
    };
  }

  const isHigh = cpuUsageRatio >= highRatio;
  return {
    level: isHigh ? "high" : "normal",
    isHigh,
    usageRatio: cpuUsageRatio,
    highRatio,
    usedFallbackThreshold: !thresholdIsValid,
    reason: isHigh
      ? "CPU usage meets or exceeds the configured high-CPU ratio."
      : "CPU usage is below the configured high-CPU ratio."
  };
}

export type DiscardEventSource = "internal" | "externalOrNative" | "notDiscard";

export interface InternalDiscardIntent {
  intentId: string;
  tabId: number;
  requestedAt: number;
  expiresAt: number;
  reason?: DiscardReason;
}

export interface DiscardEventClassification {
  source: DiscardEventSource;
  observedAt: number;
  tabId: number;
  confidence: "high" | "medium";
  matchedIntent?: InternalDiscardIntent;
  remainingLedger: InternalDiscardIntent[];
  reason: string;
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative timestamp.`);
}

function isValidIntent(intent: InternalDiscardIntent): boolean {
  return (
    typeof intent.intentId === "string" &&
    intent.intentId.length > 0 &&
    Number.isInteger(intent.tabId) &&
    intent.tabId >= 0 &&
    Number.isFinite(intent.requestedAt) &&
    intent.requestedAt >= 0 &&
    Number.isFinite(intent.expiresAt) &&
    intent.expiresAt >= intent.requestedAt
  );
}

export function createInternalDiscardIntent(input: {
  intentId: string;
  tabId: number;
  requestedAt: number;
  reason?: DiscardReason;
  ttlMs?: number;
}): InternalDiscardIntent {
  if (!input.intentId) throw new RangeError("intentId must not be empty.");
  if (!Number.isInteger(input.tabId) || input.tabId < 0) throw new RangeError("tabId must be a non-negative integer.");
  assertTimestamp(input.requestedAt, "requestedAt");
  const ttlMs = nonNegativeFinite(input.ttlMs ?? DEFAULT_INTENT_TTL_MS, DEFAULT_INTENT_TTL_MS);
  if (ttlMs <= 0) throw new RangeError("ttlMs must be greater than zero.");

  return {
    intentId: input.intentId,
    tabId: input.tabId,
    requestedAt: input.requestedAt,
    expiresAt: input.requestedAt + ttlMs,
    reason: input.reason
  };
}

/** Removes malformed/expired intents and bounds persisted session state. */
export function pruneDiscardIntentLedger(
  ledger: readonly InternalDiscardIntent[],
  now: number,
  maxEntries = DEFAULT_MAX_INTENTS
): InternalDiscardIntent[] {
  assertTimestamp(now, "now");
  const safeMaximum = Math.max(0, Math.floor(nonNegativeFinite(maxEntries, DEFAULT_MAX_INTENTS)));
  if (safeMaximum === 0) return [];

  const valid = ledger
    .filter(intent => isValidIntent(intent) && intent.expiresAt >= now)
    .sort((a, b) => a.requestedAt - b.requestedAt || a.intentId.localeCompare(b.intentId));
  return valid.slice(Math.max(0, valid.length - safeMaximum));
}

export function recordInternalDiscardIntent(
  ledger: readonly InternalDiscardIntent[],
  intent: InternalDiscardIntent,
  now = intent.requestedAt,
  maxEntries = DEFAULT_MAX_INTENTS
): InternalDiscardIntent[] {
  if (!isValidIntent(intent)) throw new RangeError("The discard intent is malformed.");
  return pruneDiscardIntentLedger([...ledger, intent], now, maxEntries);
}

/**
 * Correlates a tabs.onUpdated discarded=true event with the internal intent ledger.
 * Without a matching live intent, Chrome does not expose whether the event came
 * from Memory Saver or another extension, so the result intentionally combines them.
 */
export function classifyDiscardEvent(input: {
  tabId: number;
  observedAt: number;
  discarded: boolean;
  ledger: readonly InternalDiscardIntent[];
}): DiscardEventClassification {
  if (!Number.isInteger(input.tabId) || input.tabId < 0) throw new RangeError("tabId must be a non-negative integer.");
  assertTimestamp(input.observedAt, "observedAt");
  const liveLedger = pruneDiscardIntentLedger(input.ledger, input.observedAt);

  if (!input.discarded) {
    return {
      source: "notDiscard",
      observedAt: input.observedAt,
      tabId: input.tabId,
      confidence: "high",
      remainingLedger: liveLedger,
      reason: "The observed update did not transition the tab into the discarded state."
    };
  }

  const matchedIntent = [...liveLedger]
    .reverse()
    .find(
      intent =>
        intent.tabId === input.tabId &&
        intent.requestedAt <= input.observedAt &&
        intent.expiresAt >= input.observedAt
    );

  if (!matchedIntent) {
    return {
      source: "externalOrNative",
      observedAt: input.observedAt,
      tabId: input.tabId,
      confidence: "medium",
      remainingLedger: liveLedger,
      reason: "No live internal intent matched; Chrome Memory Saver or another extension may have discarded the tab."
    };
  }

  return {
    source: "internal",
    observedAt: input.observedAt,
    tabId: input.tabId,
    confidence: "high",
    matchedIntent,
    remainingLedger: liveLedger.filter(intent => intent.intentId !== matchedIntent.intentId),
    reason: "The discarded event matched a live internal discard intent."
  };
}

export type PressureLikelyCause = "none" | "chromeTabs" | "otherApplications" | "mixed" | "unknown";
export type RootCauseRecommendation =
  | "noAction"
  | "allowBoundedTabCleanup"
  | "holdAndRemeasure"
  | "avoidFurtherTabCleanup";

export interface PressureRootCauseOptions {
  tabMetricFreshnessMs: number;
  memoryReleaseFreshnessMs: number;
  externalDiscardFreshnessMs: number;
  minimumMetricCoverage: number;
  lowMeasuredHeapCapacityRatio: number;
  highMeasuredHeapCapacityRatio: number;
  minimumMeaningfulReleaseBytes: number;
  minimumMeaningfulReleaseCapacityRatio: number;
}

export interface PressureRootCauseAssessment {
  likelyCause: PressureLikelyCause;
  confidence: number;
  confidenceBand: "low" | "medium" | "high";
  recommendation: RootCauseRecommendation;
  shouldSuppressAutomaticDiscard: boolean;
  tabEvidenceScore: number;
  otherEvidenceScore: number;
  freshMetricCount: number;
  metricCoverage: number;
  measuredHeapBytes: number;
  measuredHeapCapacityRatio: number | null;
  recentMemoryRelease: boolean;
  recentExternalDiscardCount: number;
  evidence: string[];
}

const DEFAULT_ROOT_CAUSE_OPTIONS: PressureRootCauseOptions = {
  tabMetricFreshnessMs: 5 * 60_000,
  memoryReleaseFreshnessMs: 10 * 60_000,
  externalDiscardFreshnessMs: 5 * 60_000,
  minimumMetricCoverage: 0.25,
  lowMeasuredHeapCapacityRatio: 0.01,
  highMeasuredHeapCapacityRatio: 0.04,
  minimumMeaningfulReleaseBytes: 128 * MEBIBYTE,
  minimumMeaningfulReleaseCapacityRatio: 0.0025
};

function isFresh(sampledAt: number, now: number, freshnessMs: number): boolean {
  return (
    Number.isFinite(sampledAt) &&
    sampledAt >= 0 &&
    sampledAt <= now &&
    now - sampledAt <= Math.max(0, freshnessMs)
  );
}

function confidenceBand(confidence: number): PressureRootCauseAssessment["confidenceBand"] {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function deduplicateFreshMetrics(
  metrics: readonly Pick<TabAccurateMetrics, "tabId" | "sampledAt" | "jsHeapUsedBytes" | "error">[],
  now: number,
  freshnessMs: number
): Array<Pick<TabAccurateMetrics, "tabId" | "sampledAt" | "jsHeapUsedBytes" | "error">> {
  const latestByTab = new Map<number, Pick<TabAccurateMetrics, "tabId" | "sampledAt" | "jsHeapUsedBytes" | "error">>();
  for (const metric of metrics) {
    if (
      !Number.isInteger(metric.tabId) ||
      metric.tabId < 0 ||
      metric.error ||
      !isFresh(metric.sampledAt, now, freshnessMs) ||
      typeof metric.jsHeapUsedBytes !== "number" ||
      !Number.isFinite(metric.jsHeapUsedBytes) ||
      metric.jsHeapUsedBytes < 0
    ) {
      continue;
    }
    const previous = latestByTab.get(metric.tabId);
    if (!previous || metric.sampledAt > previous.sampledAt) latestByTab.set(metric.tabId, metric);
  }
  return [...latestByTab.values()];
}

/**
 * Estimates whether system memory pressure is plausibly tab-driven.
 *
 * Accurate-mode JS heap is deliberately treated as partial evidence: browser,
 * renderer, GPU, native DOM, and other application memory are not represented.
 */
export function assessPressureRootCause(input: {
  pressure: Pick<
    PressureSnapshot,
    "level" | "memoryCapacityBytes" | "memoryAvailableRatio" | "tabCount" | "discardedTabCount"
  > & Partial<Pick<PressureSnapshot, "cpuLevel" | "memorySampleValid">>;
  tabMetrics?: readonly Pick<TabAccurateMetrics, "tabId" | "sampledAt" | "jsHeapUsedBytes" | "error">[];
  memoryRelease?: Pick<
    MemoryReleaseEstimate,
    "status" | "sampledAt" | "discardedCount" | "estimatedFreedBytes"
  > | null;
  discardEvents?: readonly Pick<DiscardEventClassification, "source" | "observedAt">[];
  now: number;
  options?: Partial<PressureRootCauseOptions>;
}): PressureRootCauseAssessment {
  assertTimestamp(input.now, "now");
  const options = { ...DEFAULT_ROOT_CAUSE_OPTIONS, ...input.options };
  const capacity = nonNegativeFinite(input.pressure.memoryCapacityBytes, 0);
  const activeTabCount = Math.max(0, input.pressure.tabCount - input.pressure.discardedTabCount);
  const freshMetrics = deduplicateFreshMetrics(
    input.tabMetrics ?? [],
    input.now,
    nonNegativeFinite(options.tabMetricFreshnessMs, DEFAULT_ROOT_CAUSE_OPTIONS.tabMetricFreshnessMs)
  );
  const measuredHeapBytes = freshMetrics.reduce((total, metric) => total + (metric.jsHeapUsedBytes ?? 0), 0);
  const metricCoverage = activeTabCount > 0 ? clamp(freshMetrics.length / activeTabCount, 0, 1) : 0;
  const measuredHeapCapacityRatio = capacity > 0 ? measuredHeapBytes / capacity : null;
  const releaseFreshnessMs = nonNegativeFinite(
    options.memoryReleaseFreshnessMs,
    DEFAULT_ROOT_CAUSE_OPTIONS.memoryReleaseFreshnessMs
  );
  const recentMemoryRelease = Boolean(
    input.memoryRelease && isFresh(input.memoryRelease.sampledAt, input.now, releaseFreshnessMs)
  );
  const externalFreshnessMs = nonNegativeFinite(
    options.externalDiscardFreshnessMs,
    DEFAULT_ROOT_CAUSE_OPTIONS.externalDiscardFreshnessMs
  );
  const recentExternalDiscardCount = (input.discardEvents ?? []).filter(
    event => event.source === "externalOrNative" && isFresh(event.observedAt, input.now, externalFreshnessMs)
  ).length;
  const evidence: string[] = [];

  if (input.pressure.level === "normal" || input.pressure.memorySampleValid === false) {
    return {
      likelyCause: input.pressure.cpuLevel === "high" || input.pressure.memorySampleValid === false ? "unknown" : "none",
      confidence: input.pressure.cpuLevel === "high" || input.pressure.memorySampleValid === false ? 0.25 : 0.95,
      confidenceBand: input.pressure.cpuLevel === "high" || input.pressure.memorySampleValid === false ? "low" : "high",
      recommendation: input.pressure.cpuLevel === "high" ? "holdAndRemeasure" : "noAction",
      shouldSuppressAutomaticDiscard: true,
      tabEvidenceScore: 0,
      otherEvidenceScore: 0,
      freshMetricCount: freshMetrics.length,
      metricCoverage: round(metricCoverage),
      measuredHeapBytes,
      measuredHeapCapacityRatio: measuredHeapCapacityRatio == null ? null : round(measuredHeapCapacityRatio),
      recentMemoryRelease,
      recentExternalDiscardCount,
      evidence: [input.pressure.memorySampleValid === false ? "Memory reading unavailable." : input.pressure.cpuLevel === "high" ? "CPU use is high. Tabs are unloaded for CPU only after they are measured." : "System memory is currently in the normal range."]
    };
  }

  let tabEvidenceScore = 0;
  let otherEvidenceScore = 0;
  let directionalSources = 0;
  const minimumCoverage = clamp(
    nonNegativeFinite(options.minimumMetricCoverage, DEFAULT_ROOT_CAUSE_OPTIONS.minimumMetricCoverage),
    0,
    1
  );

  if (measuredHeapCapacityRatio != null && metricCoverage >= minimumCoverage) {
    const highHeapRatio = clamp(
      nonNegativeFinite(
        options.highMeasuredHeapCapacityRatio,
        DEFAULT_ROOT_CAUSE_OPTIONS.highMeasuredHeapCapacityRatio
      ),
      0.001,
      1
    );
    const lowHeapRatio = clamp(
      nonNegativeFinite(options.lowMeasuredHeapCapacityRatio, DEFAULT_ROOT_CAUSE_OPTIONS.lowMeasuredHeapCapacityRatio),
      0,
      highHeapRatio
    );
    if (measuredHeapCapacityRatio >= highHeapRatio) {
      const excessRatio = Math.min(1, (measuredHeapCapacityRatio - highHeapRatio) / Math.max(highHeapRatio, 0.001));
      tabEvidenceScore += (1.5 + excessRatio) * metricCoverage;
      directionalSources += 1;
      evidence.push("Measured tabs use a large share of memory.");
    } else if (measuredHeapCapacityRatio <= lowHeapRatio && metricCoverage >= 0.5) {
      evidence.push("Measured tabs use little JavaScript memory. Page, media and GPU memory are not measured, so other apps cannot be blamed yet.");
    } else {
      evidence.push("Tab measurements do not point to a clear cause.");
    }
  } else if (freshMetrics.length > 0) {
    evidence.push("Too few tabs are measured to tell the cause.");
  } else {
    evidence.push("No recent tab measurements.");
  }

  let releaseSupportsTabs = false;
  if (recentMemoryRelease && input.memoryRelease) {
    if (input.memoryRelease.status === "measured" && input.memoryRelease.discardedCount > 0) {
      const minimumReleaseBytes = Math.max(
        nonNegativeFinite(
          options.minimumMeaningfulReleaseBytes,
          DEFAULT_ROOT_CAUSE_OPTIONS.minimumMeaningfulReleaseBytes
        ),
        capacity *
          clamp(
            nonNegativeFinite(
              options.minimumMeaningfulReleaseCapacityRatio,
              DEFAULT_ROOT_CAUSE_OPTIONS.minimumMeaningfulReleaseCapacityRatio
            ),
            0,
            1
          )
      );
      if (input.memoryRelease.estimatedFreedBytes >= minimumReleaseBytes) {
        tabEvidenceScore += 2;
        directionalSources += 1;
        releaseSupportsTabs = true;
        evidence.push("The last unload freed a meaningful amount of memory.");
      } else if (input.memoryRelease.estimatedFreedBytes <= minimumReleaseBytes * 0.25) {
        otherEvidenceScore += 0.5;
        directionalSources += 1;
        evidence.push("The last unload freed little or no memory.");
      } else {
        tabEvidenceScore += 0.4;
        otherEvidenceScore += 0.4;
        evidence.push("The last unload had an unclear effect on memory.");
      }
    } else if (input.memoryRelease.status === "measurementFailed") {
      evidence.push("Memory was not measured after the last unload.");
    }
  }

  if (recentExternalDiscardCount > 0) {
    // This is weak evidence only: the browser/another extension may be reacting
    // to the same pressure, but the source cannot be identified by tabs.onUpdated.
    // Native discard activity is a coexistence signal, not process attribution.
    evidence.push("Chrome or another extension unloaded tabs recently; give it a moment.");
  }

  tabEvidenceScore = round(tabEvidenceScore);
  otherEvidenceScore = round(otherEvidenceScore);
  const totalScore = tabEvidenceScore + otherEvidenceScore;
  let likelyCause: PressureLikelyCause;

  if (totalScore < 0.75 || directionalSources === 0) {
    likelyCause = "unknown";
  } else if (tabEvidenceScore > 0 && otherEvidenceScore >= 0.5) {
    likelyCause = "mixed";
  } else if (tabEvidenceScore >= otherEvidenceScore * 1.5 && tabEvidenceScore >= 1) {
    likelyCause = "chromeTabs";
  } else if (otherEvidenceScore >= tabEvidenceScore * 1.5 && otherEvidenceScore >= 1) {
    likelyCause = "otherApplications";
  } else {
    likelyCause = "mixed";
  }

  const dominance = totalScore > 0 ? Math.abs(tabEvidenceScore - otherEvidenceScore) / totalScore : 0;
  const sourceStrength = Math.min(0.3, directionalSources * 0.08);
  const totalStrength = Math.min(0.25, totalScore * 0.06);
  const shapeStrength = likelyCause === "mixed" ? (1 - dominance) * 0.15 : dominance * 0.25;
  const confidence =
    likelyCause === "unknown" ? 0.25 : round(clamp(0.3 + sourceStrength + totalStrength + shapeStrength, 0, 0.9));

  let recommendation: RootCauseRecommendation = "holdAndRemeasure";
  if (likelyCause === "otherApplications") recommendation = "avoidFurtherTabCleanup";
  if (
    likelyCause === "chromeTabs" &&
    confidence >= 0.5 &&
    (recentExternalDiscardCount === 0 || releaseSupportsTabs)
  ) {
    recommendation = "allowBoundedTabCleanup";
  }

  return {
    likelyCause,
    confidence,
    confidenceBand: confidenceBand(confidence),
    recommendation,
    shouldSuppressAutomaticDiscard: recommendation !== "allowBoundedTabCleanup",
    tabEvidenceScore,
    otherEvidenceScore,
    freshMetricCount: freshMetrics.length,
    metricCoverage: round(metricCoverage),
    measuredHeapBytes,
    measuredHeapCapacityRatio: measuredHeapCapacityRatio == null ? null : round(measuredHeapCapacityRatio),
    recentMemoryRelease,
    recentExternalDiscardCount,
    evidence
  };
}

export type DiscardLearningEvent = Pick<DiscardLogEntry, "tabId" | "domain" | "discardedAt" | "undoneAt"> & {
  reactivatedAt?: number;
};

export type DiscardLearningRisk = "none" | "low" | "medium" | "high";
export type DiscardLearningSuggestion = "none" | "extendInactivity" | "offerProtection";

export interface DiscardLearningOptions {
  quickReactivationWindowMs: number;
  lookbackMs: number;
  maximumInactiveMinutes: number;
}

export interface DiscardLearningAdjustment {
  risk: DiscardLearningRisk;
  suggestion: DiscardLearningSuggestion;
  sampleCount: number;
  observedCount: number;
  effectiveSampleCount: number;
  weightedQuickRate: number;
  confidence: number;
  quickReactivationCount: number;
  quickUndoCount: number;
  quickSignalCount: number;
  quickSignalRate: number;
  scoreMultiplier: number;
  thresholdMultiplier: number;
  adjustedScore: number;
  adjustedInactiveMinutes: number;
  reason: string;
}

const DEFAULT_DISCARD_LEARNING_OPTIONS: DiscardLearningOptions = {
  quickReactivationWindowMs: 10 * 60_000,
  lookbackMs: 30 * 24 * 60 * 60_000,
  maximumInactiveMinutes: 24 * 60
};

/**
 * Converts quick reactivation/Undo history into a ranking and threshold adjustment.
 * The result only suggests protection; it never silently creates a protection rule.
 */
export function computeDiscardLearningAdjustment(input: {
  events: readonly DiscardLearningEvent[];
  now: number;
  baseScore: number;
  baseInactiveMinutes: number;
  scope?: { tabId?: number; domain?: string };
  options?: Partial<DiscardLearningOptions>;
}): DiscardLearningAdjustment {
  assertTimestamp(input.now, "now");
  const options = { ...DEFAULT_DISCARD_LEARNING_OPTIONS, ...input.options };
  const lookbackMs = nonNegativeFinite(options.lookbackMs, DEFAULT_DISCARD_LEARNING_OPTIONS.lookbackMs);
  const quickWindowMs = nonNegativeFinite(options.quickReactivationWindowMs, DEFAULT_DISCARD_LEARNING_OPTIONS.quickReactivationWindowMs);
  const scopeDomain = input.scope?.domain?.trim().toLowerCase();
  const events = input.events.filter(event =>
    Number.isFinite(event.discardedAt) && event.discardedAt >= 0 && event.discardedAt <= input.now &&
    input.now - event.discardedAt <= lookbackMs &&
    (input.scope?.tabId == null || event.tabId === input.scope.tabId) &&
    (!scopeDomain || event.domain?.trim().toLowerCase() === scopeDomain));
  let quickReactivationCount = 0, quickUndoCount = 0, quickSignalCount = 0, observedCount = 0;
  let badWeight = 0, observedWeight = 0;
  for (const event of events) {
    const validFeedback = (time: number | undefined): time is number =>
      typeof time === "number" && Number.isFinite(time) && time >= event.discardedAt && time <= input.now;
    const quickReactivation = validFeedback(event.reactivatedAt) && event.reactivatedAt - event.discardedAt <= quickWindowMs;
    // Explicit Undo is feedback even when its quick-return window has elapsed.
    const undo = validFeedback(event.undoneAt);
    if (quickReactivation) quickReactivationCount++;
    if (undo) quickUndoCount++;
    const bad = quickReactivation || undo;
    if (bad) quickSignalCount++;
    // An unresolved, recent discard is not a successful outcome yet.
    if (!bad && input.now - event.discardedAt < quickWindowMs) continue;
    observedCount++;
    const age = input.now - Math.max(event.discardedAt,
      bad ? Math.max(quickReactivation ? event.reactivatedAt! : 0, undo ? event.undoneAt! : 0) : 0);
    const weight = 2 ** (-age / (7 * 24 * 60 * 60_000)) * (undo ? 1.5 : 1);
    observedWeight += weight;
    if (bad) badWeight += weight;
  }
  // A small prior and evidence strength stop one observation from becoming a
  // permanent domain rule. Successes and time both dilute old negative feedback.
  const weightedQuickRate = observedWeight > 0 ? badWeight / observedWeight : 0;
  const strength = badWeight / (observedWeight + 1) * Math.min(1, badWeight / 3);
  const risk: DiscardLearningRisk = strength >= 0.55 ? "high" : strength >= 0.28 ? "medium" : strength >= 0.03 ? "low" : "none";
  const thresholdMultiplier = risk === "none" ? 1 : 1 + 1.5 * strength;
  const scoreMultiplier = risk === "none" ? 1 : 1 - 0.7 * strength;
  const baseScore = nonNegativeFinite(input.baseScore, 0);
  const baseInactiveMinutes = nonNegativeFinite(input.baseInactiveMinutes, 0);
  const maximumInactiveMinutes = Math.max(baseInactiveMinutes, nonNegativeFinite(options.maximumInactiveMinutes, DEFAULT_DISCARD_LEARNING_OPTIONS.maximumInactiveMinutes));
  return {
    risk, suggestion: risk === "high" ? "offerProtection" : risk === "none" ? "none" : "extendInactivity",
    sampleCount: events.length, observedCount, effectiveSampleCount: round(observedWeight),
    confidence: round(observedWeight / (observedWeight + 4)), weightedQuickRate: round(weightedQuickRate),
    quickReactivationCount, quickUndoCount, quickSignalCount,
    quickSignalRate: observedCount > 0 ? round(quickSignalCount / observedCount) : 0,
    scoreMultiplier: round(scoreMultiplier), thresholdMultiplier: round(thresholdMultiplier),
    adjustedScore: round(baseScore * scoreMultiplier),
    adjustedInactiveMinutes: Math.min(maximumInactiveMinutes, Math.ceil(baseInactiveMinutes * thresholdMultiplier)),
    reason: risk === "none" ? "Recent outcomes do not call for a learning delay."
      : `${quickSignalCount} returns or Undo in ${observedCount} resolved outcomes; recent feedback extends inactivity and lowers priority.`
  };
}

/** Only current documents can contribute evidence; tab IDs survive navigation. */
export function freshMetricsForTabs(
  metrics: readonly TabAccurateMetrics[], tabs: readonly chrome.tabs.Tab[], now: number
): TabAccurateMetrics[] {
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const latest = new Map<number, TabAccurateMetrics>();
  for (const metric of metrics) {
    const tab = byId.get(metric.tabId);
    if (!tab || tab.discarded || metric.error || !metric.url || metric.url !== tab.url ||
      metric.windowId !== tab.windowId || !isFresh(metric.sampledAt, now, 5 * 60_000)) continue;
    if (!latest.has(metric.tabId) || latest.get(metric.tabId)!.sampledAt < metric.sampledAt) latest.set(metric.tabId, metric);
  }
  return [...latest.values()];
}

export function deriveDiscardLearningRecords(
  state: Pick<AppState, "settings" | "discardLog" | "discardLearning">, now: number, baseInactiveMinutes: number
): DiscardLearningRecord[] {
  const domains = new Set([...(state.discardLearning ?? []).map(item => item.domain),
    ...state.discardLog.map(item => item.domain).filter((domain): domain is string => Boolean(domain))]);
  return [...domains].flatMap<DiscardLearningRecord>(domain => {
    const events = state.discardLog.filter(item => item.domain === domain);
    if (!events.length) {
      const previous = state.discardLearning?.find(item => item.domain === domain);
      if (!previous || previous.lastFeedbackAt > now || now - previous.lastFeedbackAt > 30 * 24 * 60 * 60_000) return [];
      // Store the original baseline so displaying decay does not compound it on every scan.
      const baselinePenaltyMinutes = previous.baselinePenaltyMinutes ?? previous.thresholdPenaltyMinutes;
      return [{ ...previous, baselinePenaltyMinutes, thresholdPenaltyMinutes: Math.round(baselinePenaltyMinutes * 2 ** (-(now - previous.lastFeedbackAt) / (7 * 24 * 60 * 60_000))) }];
    }
    const adjustment = computeDiscardLearningAdjustment({
      events, now, baseScore: 1, baseInactiveMinutes,
      options: { quickReactivationWindowMs: state.settings.quickReactivateMinutes * 60_000 }
    });
    if (!adjustment.quickSignalCount) return [];
    const lastFeedbackAt = Math.max(0, ...events.flatMap(event => [event.reactivatedAt, event.undoneAt])
      .filter((time): time is number => typeof time === "number" && Number.isFinite(time) && time <= now));
    return [{
      domain, lastFeedbackAt, quickReactivations: adjustment.quickReactivationCount, undoCount: adjustment.quickUndoCount,
      thresholdPenaltyMinutes: Math.max(0, adjustment.adjustedInactiveMinutes - baseInactiveMinutes),
      observedCount: adjustment.observedCount, effectiveSampleCount: adjustment.effectiveSampleCount,
      weightedQuickRate: adjustment.weightedQuickRate, confidence: adjustment.confidence, risk: adjustment.risk
    }];
  }).sort((a, b) => b.lastFeedbackAt - a.lastFeedbackAt).slice(0, 200);
}
