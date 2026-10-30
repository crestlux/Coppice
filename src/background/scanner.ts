import { PROTECTION_SKIP_REASONS } from "../shared/constants";
import {
  isFocusProtection,
  loadAppState,
  normalizeSettings,
  pruneTemporaryTabProtections,
  pruneTabAccurateMetrics,
  appendEffectHistory,
  saveLastPressure,
  saveAutomationPlan,
  saveDiscardLearning,
  getLastMemoryRelease,
  saveLastMemoryRelease,
  saveLastDiscardSummary,
  saveRootCauseAssessment,
  updateTemporaryTabProtections
} from "../shared/storage";
import type {
  AppState,
  CloseDiscardedTabsResult,
  CloseFrozenTabsResult,
  CloseTabResult,
  DiscardActionSummary,
  DiscardAttemptResult,
  DiscardBatchResult,
  DiscardReason,
  DiscardDecision,
  DuplicateTabPreview,
  DuplicateTabsPreviewResult,
  DuplicateTabsResult,
  MemoryReleaseEstimate,
  PressureSnapshot,
  PressureRootCauseAssessment,
  PolicySimulationResult,
  ProtectionRule,
  ScanReason
} from "../shared/types";
import { getHostname, isDomainMatch, isHttpUrl, wildcardToRegExp } from "../shared/url";
import { updateBadge } from "./badge";
import { discardSelected, discardTabDirectlyWithResult, type UncheckedTabPolicy } from "./discard";

// Automatic cleanup unloads tabs it couldn't check only once low memory is confirmed.
function uncheckedTabPolicyForPressure(pressure: PressureSnapshot): UncheckedTabPolicy {
  return pressure.level === "high" || pressure.level === "emergency" ? "unload" : "keep";
}
import { evaluateTabs, getEffectiveThresholdMinutes } from "./policy";
import { collectPressureSnapshot } from "./pressure";
import { isSnoozed } from "../shared/snooze";
import { collectPowerState } from "./power";
import { adjustPolicyForPowerState, assessPressureRootCause, freshMetricsForTabs, deriveDiscardLearningRecords } from "./resourceIntelligence";
import { buildAutomationPlan } from "./automation";
import { captureRecoveryCapsule } from "./recovery";
import { syncDnrRules } from "./dnr";
import { checkTabCloseSafety } from "./sessionSafety";

export interface ScanEvaluation {
  state: AppState;
  tabs: chrome.tabs.Tab[];
  pressure: PressureSnapshot;
  idleState: chrome.idle.IdleState;
  decisions: DiscardDecision[];
}

const MEMORY_RELEASE_SAMPLE_DELAY_MS = 2000;
// Unloaded renderers keep exiting and handing memory back to the system for several seconds.
const MEMORY_RELEASE_SETTLE_DELAY_MS = 15_000;
let transientPowerNetworkDietActive = false;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

async function sampleAvailableMemory(): Promise<{ availableBytes: number; sampledAt: number }> {
  const memory = await chrome.system.memory.getInfo();
  if (!Number.isFinite(memory.availableCapacity) || memory.availableCapacity < 0) throw new Error("Invalid available-memory sample.");
  return {
    availableBytes: memory.availableCapacity,
    sampledAt: Date.now()
  };
}

export async function measureMemoryReleaseEstimate(input: {
  discardedCount: number;
  discardReason: DiscardReason;
  beforeAvailableBytes: number;
  beforeSampleValid?: boolean;
  sampleDelayMs?: number;
}): Promise<MemoryReleaseEstimate> {
  if (input.beforeSampleValid === false) throw new Error("A valid pre-discard memory sample is required to estimate release.");
  const sampleDelayMs = input.sampleDelayMs ?? MEMORY_RELEASE_SAMPLE_DELAY_MS;
  const immediate = await sampleAvailableMemory();

  if (sampleDelayMs > 0) {
    await delay(sampleDelayMs);
  }

  const delayed = await sampleAvailableMemory();

  return {
    status: "measured",
    sampledAt: delayed.sampledAt,
    discardedCount: input.discardedCount,
    discardReason: input.discardReason,
    beforeAvailableBytes: input.beforeAvailableBytes,
    immediateAvailableBytes: immediate.availableBytes,
    delayedAvailableBytes: delayed.availableBytes,
    estimatedFreedBytes: delayed.availableBytes - input.beforeAvailableBytes,
    sampleDelayMs,
    confidence: "systemDelta"
  };
}

function createNoDiscardMemoryRelease(discardReason: DiscardReason, beforeAvailableBytes: number): MemoryReleaseEstimate {
  return {
    status: "noDiscard",
    sampledAt: Date.now(),
    discardedCount: 0,
    discardReason,
    beforeAvailableBytes,
    immediateAvailableBytes: beforeAvailableBytes,
    delayedAvailableBytes: beforeAvailableBytes,
    estimatedFreedBytes: 0,
    sampleDelayMs: 0,
    confidence: "systemDelta"
  };
}

function createDiscardBatchResult(
  reason: DiscardReason,
  candidateCount: number,
  attempts: DiscardAttemptResult[]
): DiscardBatchResult {
  return {
    reason,
    candidateCount,
    attemptedCount: attempts.length,
    discardedCount: attempts.filter(attempt => attempt.status === "discarded").length,
    skippedCount: attempts.filter(attempt => attempt.status === "skipped").length,
    failedCount: attempts.filter(attempt => attempt.status === "failed").length,
    attempts
  };
}

async function saveDiscardSummary(input: {
  batch: DiscardBatchResult;
  requestedAt: number;
  limit: number;
}): Promise<DiscardActionSummary> {
  const summary: DiscardActionSummary = {
    id: crypto.randomUUID(),
    requestedAt: input.requestedAt,
    completedAt: Date.now(),
    limit: input.limit,
    ...input.batch
  };
  await saveLastDiscardSummary(summary);
  return summary;
}

export async function recordSettledMemoryRelease(estimate: MemoryReleaseEstimate): Promise<MemoryReleaseEstimate | undefined> {
  const current = await getLastMemoryRelease();
  // A newer action replaced this estimate while waiting.
  if (!current || current.status !== "measured" || current.sampledAt !== estimate.sampledAt) return undefined;
  const settled = await sampleAvailableMemory();
  const settledFreedBytes = settled.availableBytes - current.beforeAvailableBytes;
  // Report the settled reading even when it is smaller. Keeping only increases
  // systematically overstates savings when unrelated applications allocate RAM.
  const latest = await getLastMemoryRelease();
  if (!latest || latest.status !== "measured" || latest.sampledAt !== estimate.sampledAt) return undefined;
  const updated: MemoryReleaseEstimate = {
    ...current,
    estimatedFreedBytes: settledFreedBytes,
    settledAvailableBytes: settled.availableBytes,
    settledDelayMs: settled.sampledAt - current.sampledAt + current.sampleDelayMs
  };
  await saveLastMemoryRelease(updated);
  return updated;
}

function scheduleSettledMemoryRelease(estimate: MemoryReleaseEstimate): void {
  if (estimate.status !== "measured") return;
  globalThis.setTimeout(() => {
    void recordSettledMemoryRelease(estimate).catch(error => console.warn("Settled memory sample failed", error));
  }, Math.max(0, MEMORY_RELEASE_SETTLE_DELAY_MS - estimate.sampleDelayMs));
}

async function saveMemoryReleaseAfterDiscard(input: {
  discardedCount: number;
  discardReason: DiscardReason;
  beforeAvailableBytes: number;
  beforeSampleValid?: boolean;
  sampleDelayMs?: number;
}): Promise<MemoryReleaseEstimate> {
  try {
    const estimate = await measureMemoryReleaseEstimate(input);
    await saveLastMemoryRelease(estimate);
    scheduleSettledMemoryRelease(estimate);
    return estimate;
  } catch (error) {
    const failedEstimate: MemoryReleaseEstimate = {
      status: "measurementFailed",
      sampledAt: Date.now(),
      discardedCount: input.discardedCount,
      discardReason: input.discardReason,
      beforeAvailableBytes: input.beforeAvailableBytes,
      immediateAvailableBytes: input.beforeAvailableBytes,
      delayedAvailableBytes: input.beforeAvailableBytes,
      estimatedFreedBytes: 0,
      sampleDelayMs: 0,
      confidence: "systemDelta",
      error: error instanceof Error ? error.message : String(error)
    };
    await saveLastMemoryRelease(failedEstimate);
    return failedEstimate;
  }
}

async function appendEffectSample(input: {
  evaluation: ScanEvaluation;
  discardedCount: number;
  discardReason?: DiscardReason;
  memoryRelease?: MemoryReleaseEstimate;
}): Promise<void> {
  await appendEffectHistory({
    id: crypto.randomUUID(),
    sampledAt: Date.now(),
    pressure: input.evaluation.pressure,
    discardedCount: input.discardedCount,
    discardReason: input.discardReason,
    estimatedFreedBytes: input.discardedCount > 0 && input.memoryRelease?.status === "measured" ? input.memoryRelease.estimatedFreedBytes : undefined,
    releaseStatus: input.discardedCount > 0 ? input.memoryRelease?.status : undefined
  });
}

export function countProtectedTabs(decisions: DiscardDecision[]): number {
  return decisions.filter(
    decision => decision.action === "skip" && decision.skipReason && PROTECTION_SKIP_REASONS.has(decision.skipReason)
  ).length;
}

function matchingProtectionRuleIds(tab: chrome.tabs.Tab, rules: ProtectionRule[]): string[] {
  if (!tab.url) return [];

  const domain = getHostname(tab.url) ?? undefined;
  const matchingIds = rules
    .filter(rule => {
      if (!rule.enabled) return false;
      if (rule.type === "domain") return Boolean(domain && isDomainMatch(domain, rule.value));
      try {
        return wildcardToRegExp(rule.value).test(tab.url as string);
      } catch {
        return false;
      }
    })
    .map(rule => rule.id);

  return [...new Set(matchingIds)];
}

function sameRuleIds(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every(ruleId => bSet.has(ruleId));
}

async function rememberRuleProtectedTabs(
  tabs: chrome.tabs.Tab[],
  decisions: DiscardDecision[],
  state: AppState
): Promise<AppState> {
  const tabById = new Map(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === "number")
      .map(tab => [tab.id, tab])
  );
  const temporaryTabProtections = await updateTemporaryTabProtections(current => {
    const nextByTabId = new Map(current.map(protection => [protection.tabId, protection]));
    let changed = false;

    for (const decision of decisions) {
      if (decision.skipReason !== "protectedDomain" && decision.skipReason !== "protectedUrlPattern") continue;

      const tab = tabById.get(decision.tab.tabId);
      if (!tab) continue;

      const existing = nextByTabId.get(tab.id);
      if (existing?.source === "user") continue;
      const focused = existing ? isFocusProtection(existing) : false;

      const ruleIds = matchingProtectionRuleIds(tab, state.protectionRules);
      if (ruleIds.length === 0) continue;

      const next = {
        tabId: tab.id,
        windowId: tab.windowId,
        createdAt: existing?.createdAt ?? Date.now(),
        source: "rule" as const,
        ruleIds,
        focus: focused || undefined,
        focusedAt: focused ? existing?.focusedAt ?? existing?.createdAt ?? Date.now() : undefined,
        url: tab.url,
        title: tab.title
      };

      if (
        !existing ||
        existing.source !== next.source ||
        existing.windowId !== next.windowId ||
        existing.url !== next.url ||
        existing.title !== next.title ||
        existing.focus !== next.focus ||
        existing.focusedAt !== next.focusedAt ||
        !sameRuleIds(existing.ruleIds, ruleIds)
      ) {
        nextByTabId.set(tab.id, next);
        changed = true;
      }
    }

    if (!changed) return current;
    return [...nextByTabId.values()].sort((a, b) => b.createdAt - a.createdAt);
  });
  return {
    ...state,
    temporaryTabProtections
  };
}

const TRACKING_QUERY_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "_hsenc",
  "_hsmi",
  "vero_id"
]);

function isTrackingQueryParam(name: string): boolean {
  return name.toLowerCase().startsWith("utm_") || TRACKING_QUERY_NAMES.has(name.toLowerCase());
}

export function duplicateTabKey(tab: chrome.tabs.Tab): string | null {
  if (!tab.url || typeof tab.id !== "number" || tab.incognito) {
    return null;
  }

  try {
    const url = new URL(tab.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hostname = url.hostname.toLowerCase();
    // Hashes can identify different SPA documents. Subdomains, trailing slashes,
    // and repeated query parameter order also carry meaning; preserve them.
    const params = [...url.searchParams.entries()]
      .filter(([name]) => !isTrackingQueryParam(name))
      .sort(([nameA], [nameB]) => nameA.localeCompare(nameB));
    url.search = "";
    for (const [name, value] of params) {
      url.searchParams.append(name, value);
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function exactDuplicateTabKey(tab: chrome.tabs.Tab): string | null {
  if (!tab.url || typeof tab.id !== "number" || tab.incognito) return null;

  try {
    const url = new URL(tab.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function selectExistingDuplicateTab(
  newTab: chrome.tabs.Tab,
  openTabs: chrome.tabs.Tab[]
): chrome.tabs.Tab | null {
  if (typeof newTab.id !== "number" || newTab.pinned || newTab.incognito) return null;
  const key = exactDuplicateTabKey(newTab);
  if (!key) return null;
  return (
    openTabs
      .filter(tab => tab.id !== newTab.id && exactDuplicateTabKey(tab) === key && typeof tab.id === "number")
      .sort(
        (a, b) =>
          Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
      )[0] ?? null
  );
}

function chooseDuplicateKeeper(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab {
  return [...tabs].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if ((b.lastAccessed ?? 0) !== (a.lastAccessed ?? 0)) return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  })[0] as chrome.tabs.Tab;
}

function toDuplicateTabPreview(tab: chrome.tabs.Tab, action: DuplicateTabPreview["action"]): DuplicateTabPreview {
  return {
    tabId: tab.id as number,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    domain: getHostname(tab.url) ?? undefined,
    active: tab.active,
    pinned: tab.pinned,
    lastAccessedAt: tab.lastAccessed,
    action
  };
}

export function previewDuplicateTabs(tabs: chrome.tabs.Tab[]): DuplicateTabsPreviewResult {
  const groups = new Map<string, chrome.tabs.Tab[]>();
  let skippedIncognitoCount = 0;

  for (const tab of tabs) {
    if (tab.incognito) {
      skippedIncognitoCount += 1;
      continue;
    }

    const key = duplicateTabKey(tab);
    if (!key) continue;

    groups.set(key, [...(groups.get(key) ?? []), tab]);
  }

  const previewGroups: DuplicateTabsPreviewResult["groups"] = [];
  let skippedActiveCount = 0;
  let skippedPinnedCount = 0;

  for (const [normalizedUrl, group] of groups.entries()) {
    if (group.length < 2) continue;

    const keeper = chooseDuplicateKeeper(group);
    const closeTabs: DuplicateTabPreview[] = [];
    const skippedTabs: DuplicateTabPreview[] = [];

    for (const tab of group) {
      if (tab.id == null || tab.id === keeper.id) continue;
      if (tab.active) {
        skippedActiveCount += 1;
        skippedTabs.push(toDuplicateTabPreview(tab, "skipActive"));
        continue;
      }
      if (tab.pinned) {
        skippedPinnedCount += 1;
        skippedTabs.push(toDuplicateTabPreview(tab, "skipPinned"));
        continue;
      }
      closeTabs.push(toDuplicateTabPreview(tab, "close"));
    }

    if (closeTabs.length > 0 || skippedTabs.length > 0) {
      previewGroups.push({
        normalizedUrl,
        displayUrl: keeper.url ?? normalizedUrl,
        keepTab: toDuplicateTabPreview(keeper, "keep"),
        closeTabs,
        skippedTabs
      });
    }
  }

  const closeCount = previewGroups.reduce((total, group) => total + group.closeTabs.length, 0);

  return {
    groups: previewGroups,
    closeCount,
    duplicateGroupCount: previewGroups.length,
    skippedActiveCount,
    skippedPinnedCount,
    skippedIncognitoCount
  };
}

export function getDuplicateTabCloseIds(tabs: chrome.tabs.Tab[]): {
  ids: number[];
  duplicateGroupCount: number;
  skippedActiveCount: number;
  skippedPinnedCount: number;
  skippedIncognitoCount: number;
} {
  const preview = previewDuplicateTabs(tabs);
  return {
    ids: preview.groups.flatMap(group => group.closeTabs.map(tab => tab.tabId)),
    duplicateGroupCount: preview.duplicateGroupCount,
    skippedActiveCount: preview.skippedActiveCount,
    skippedPinnedCount: preview.skippedPinnedCount,
    skippedIncognitoCount: preview.skippedIncognitoCount
  };
}

export async function previewDuplicateTabsForCurrentBrowser(): Promise<DuplicateTabsPreviewResult> {
  return previewDuplicateTabs(await chrome.tabs.query({}));
}

export function selectPreviewedDuplicateTabs(
  tabs: chrome.tabs.Tab[],
  previewedTabIds?: number[]
): { ids: number[]; duplicateGroupCount: number; preview: DuplicateTabsPreviewResult } {
  if (
    previewedTabIds &&
    (previewedTabIds.length > 10_000 || previewedTabIds.some(tabId => !Number.isInteger(tabId) || tabId < 0))
  ) {
    throw new Error("Duplicate preview contains invalid tab IDs.");
  }
  const preview = previewDuplicateTabs(tabs);
  const allowedIds = previewedTabIds ? new Set(previewedTabIds) : null;
  const selectedGroups = preview.groups
    .map(group => ({
      ...group,
      closeTabs: allowedIds ? group.closeTabs.filter(tab => allowedIds.has(tab.tabId)) : group.closeTabs
    }))
    .filter(group => group.closeTabs.length > 0);
  return {
    ids: selectedGroups.flatMap(group => group.closeTabs.map(tab => tab.tabId)),
    duplicateGroupCount: selectedGroups.length,
    preview
  };
}

interface SafeCloseCounts {
  closedCount: number;
  skippedProtectedCount: number;
  skippedChangedCount: number;
}

async function closeCheckedTabs(
  tabs: chrome.tabs.Tab[],
  stillEligible?: (tab: chrome.tabs.Tab) => Promise<boolean>
): Promise<SafeCloseCounts> {
  const result: SafeCloseCounts = { closedCount: 0, skippedProtectedCount: 0, skippedChangedCount: 0 };
  for (const expected of tabs) {
    const safe = await checkTabCloseSafety(expected, {
      stillEligible: stillEligible ? () => stillEligible(expected) : undefined
    });
    if (!safe.tab) {
      if (safe.reason === "protected") result.skippedProtectedCount += 1;
      else result.skippedChangedCount += 1;
      continue;
    }
    await chrome.tabs.remove(safe.tab.id as number);
    result.closedCount += 1;
  }
  return result;
}

export async function closeDuplicateTabs(previewedTabIds?: number[]): Promise<DuplicateTabsResult & SafeCloseCounts> {
  const tabs = await chrome.tabs.query({});
  const selected = selectPreviewedDuplicateTabs(tabs, previewedTabIds);
  const { ids, preview } = selected;

  const selectedIds = new Set(ids);
  const candidates = tabs.filter(tab => tab.id != null && selectedIds.has(tab.id));
  if (candidates.length > 0) {
    await captureRecoveryCapsule(
      "closeDuplicates",
      candidates
    );
  }
  const keeperByTab = new Map(preview.groups.flatMap(group =>
    group.closeTabs.map(tab => [tab.tabId, group.keepTab.tabId] as const)));
  const counts = await closeCheckedTabs(candidates, async candidate => {
    const keeperId = keeperByTab.get(candidate.id as number);
    if (keeperId == null) return false;
    const keeper = await chrome.tabs.get(keeperId).catch(() => undefined);
    return Boolean(keeper && !keeper.pendingUrl && keeper.status !== "loading" &&
      duplicateTabKey(keeper) === duplicateTabKey(candidate));
  });

  return {
    ...counts,
    duplicateGroupCount: selected.duplicateGroupCount,
    skippedActiveCount: preview.skippedActiveCount,
    skippedPinnedCount: preview.skippedPinnedCount,
    skippedIncognitoCount: preview.skippedIncognitoCount
  };
}

export function getDiscardedTabCloseIds(tabs: chrome.tabs.Tab[]): {
  ids: number[];
  skippedActiveCount: number;
  skippedPinnedCount: number;
  skippedIncognitoCount: number;
} {
  const ids: number[] = [];
  let skippedActiveCount = 0;
  let skippedPinnedCount = 0;
  let skippedIncognitoCount = 0;

  for (const tab of tabs) {
    if (!tab.discarded || typeof tab.id !== "number") continue;
    if (tab.active) {
      skippedActiveCount += 1;
      continue;
    }
    if (tab.pinned) {
      skippedPinnedCount += 1;
      continue;
    }
    if (tab.incognito) {
      skippedIncognitoCount += 1;
      continue;
    }
    ids.push(tab.id);
  }

  return {
    ids,
    skippedActiveCount,
    skippedPinnedCount,
    skippedIncognitoCount
  };
}

export async function closeDiscardedTabs(): Promise<CloseDiscardedTabsResult & SafeCloseCounts> {
  const tabs = await chrome.tabs.query({});
  const discardedTabs = getDiscardedTabCloseIds(tabs);

  const selectedIds = new Set(discardedTabs.ids);
  const candidates = tabs.filter(tab => tab.id != null && selectedIds.has(tab.id));
  if (candidates.length > 0) {
    await captureRecoveryCapsule(
      "closeDiscarded",
      candidates
    );
  }
  const counts = await closeCheckedTabs(candidates);

  return {
    ...counts,
    skippedActiveCount: discardedTabs.skippedActiveCount,
    skippedPinnedCount: discardedTabs.skippedPinnedCount,
    skippedIncognitoCount: discardedTabs.skippedIncognitoCount
  };
}

export function getFrozenTabCloseIds(tabs: chrome.tabs.Tab[]): {
  ids: number[];
  skippedActiveCount: number;
  skippedPinnedCount: number;
  skippedIncognitoCount: number;
} {
  const ids: number[] = [];
  let skippedActiveCount = 0;
  let skippedPinnedCount = 0;
  let skippedIncognitoCount = 0;

  for (const tab of tabs) {
    if (!tab.frozen || typeof tab.id !== "number") continue;
    if (tab.active) {
      skippedActiveCount += 1;
      continue;
    }
    if (tab.pinned) {
      skippedPinnedCount += 1;
      continue;
    }
    if (tab.incognito) {
      skippedIncognitoCount += 1;
      continue;
    }
    ids.push(tab.id);
  }

  return { ids, skippedActiveCount, skippedPinnedCount, skippedIncognitoCount };
}

export async function closeFrozenTabs(): Promise<CloseFrozenTabsResult & SafeCloseCounts> {
  const tabs = await chrome.tabs.query({});
  const frozenTabs = getFrozenTabCloseIds(tabs);
  const selectedIds = new Set(frozenTabs.ids);
  const candidates = tabs.filter(tab => tab.id != null && selectedIds.has(tab.id));
  if (candidates.length > 0) {
    await captureRecoveryCapsule(
      "closeFrozen",
      candidates
    );
  }
  const counts = await closeCheckedTabs(candidates);
  return {
    ...counts,
    skippedActiveCount: frozenTabs.skippedActiveCount,
    skippedPinnedCount: frozenTabs.skippedPinnedCount,
    skippedIncognitoCount: frozenTabs.skippedIncognitoCount
  };
}

export async function closeTab(tabId: number): Promise<CloseTabResult> {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Invalid tab ID.");
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("The tab no longer exists.");
  await captureRecoveryCapsule("manualDiscard", [tab]);
  const safe = await checkTabCloseSafety(tab, { includeActive: true, includePinned: true });
  if (!safe.tab) throw new Error(safe.reason === "protected"
    ? "This tab is protected and has been kept open. Check Keep loaded, unsaved work, and active media before closing it."
    : "The tab changed while checking. It has been kept open; try again.");
  await chrome.tabs.remove(tabId);
  return { tabId, title: tab.title, closed: true };
}

export async function collectScanEvaluation(reason: ScanReason, options: { commitObservation?: boolean } = {}): Promise<ScanEvaluation> {
  const state = await loadAppState();
  const tabs = await chrome.tabs.query({});
  const [pressure, idleState, powerState] = await Promise.all([
    collectPressureSnapshot(state.settings, tabs, { persistCpuSample: options.commitObservation === true, persistHistory: options.commitObservation === true }),
    chrome.idle.queryState(60),
    collectPowerState(state.settings)
  ]);
  if (state.settings.powerPolicyMode !== "off") {
    const powerAdjustment = adjustPolicyForPowerState({
      powerState: {
        available: powerState.supported,
        charging: powerState.charging,
        level: powerState.level
      },
      inactiveMinutes: 10,
      settings: state.settings,
      options: {
        lowBatteryLevel: state.settings.lowBatteryThreshold,
        criticalBatteryLevel: Math.max(0.05, state.settings.lowBatteryThreshold / 2)
      }
    });
    if (powerAdjustment.networkDietMode !== state.settings.networkDietMode) {
      // Reassert on every evaluation. Another settings sync may have restored
      // the configured mode while this transient power adjustment is active;
      // syncDnrRules itself deduplicates unchanged requests.
      await syncDnrRules(powerAdjustment.networkDietMode);
      transientPowerNetworkDietActive = true;
    } else if (transientPowerNetworkDietActive) {
      await syncDnrRules(state.settings.networkDietMode);
      transientPowerNetworkDietActive = false;
    }
  } else if (transientPowerNetworkDietActive) {
    await syncDnrRules(state.settings.networkDietMode);
    transientPowerNetworkDietActive = false;
  }
  const openTabIds = new Set(
    tabs.map(tab => tab.id).filter((tabId): tabId is number => typeof tabId === "number")
  );
  const [temporaryTabProtections, tabAccurateMetrics] = await Promise.all([
    pruneTemporaryTabProtections(openTabIds),
    pruneTabAccurateMetrics(openTabIds)
  ]);
  const rootCauseResult = assessPressureRootCause({
    pressure,
    tabMetrics: freshMetricsForTabs(tabAccurateMetrics, tabs, pressure.sampledAt),
    memoryRelease: state.lastMemoryRelease,
    discardEvents: (state.externalDiscardObservations ?? []).map(item => ({
      source: "externalOrNative" as const,
      observedAt: item.observedAt
    })),
    now: pressure.sampledAt
  });
  const rootCauseAssessment: PressureRootCauseAssessment = {
    assessedAt: pressure.sampledAt,
    likelyCause: rootCauseResult.likelyCause,
    confidence: rootCauseResult.confidence,
    summary: rootCauseResult.evidence.join(" "),
    freshMetricCount: rootCauseResult.freshMetricCount,
    measuredHeapBytes: rootCauseResult.measuredHeapBytes,
    recentExternalDiscardCount: rootCauseResult.recentExternalDiscardCount,
    recentReleaseBytes: state.lastMemoryRelease?.estimatedFreedBytes,
    recommendation: rootCauseResult.recommendation,
    shouldSuppressAutomaticDiscard: rootCauseResult.shouldSuppressAutomaticDiscard,
    evidence: rootCauseResult.evidence
  };
  await saveRootCauseAssessment(rootCauseAssessment);

  const discardLearning = deriveDiscardLearningRecords(state, pressure.sampledAt, getEffectiveThresholdMinutes(state.settings, pressure, idleState, powerState) ?? state.settings.balancedMinutes);
  if (options.commitObservation && state.settings.discardLearningEnabled) await saveDiscardLearning(discardLearning);
  const stateWithTemporaryProtections: AppState = {
    ...state,
    discardLearning,
    temporaryTabProtections,
    tabAccurateMetrics,
    powerState,
    rootCauseAssessment
  };

  const decisions = evaluateTabs({
    tabs,
    state: stateWithTemporaryProtections,
    pressure,
    idleState,
    reason
  });

  const pressureWithProtection = {
    ...pressure,
    protectedTabCount: countProtectedTabs(decisions)
  };
  const stateWithRememberedProtections = await rememberRuleProtectedTabs(
    tabs,
    decisions,
    stateWithTemporaryProtections
  );

  const automationPlan = buildAutomationPlan({
    state: stateWithRememberedProtections, pressure: pressureWithProtection, idleState,
    decisions: reason === "manual" ? evaluateTabs({ tabs, state: stateWithRememberedProtections, pressure: pressureWithProtection, idleState, reason: "periodic" }) : decisions
  });
  await saveAutomationPlan(automationPlan);
  return {
    state: { ...stateWithRememberedProtections, automationPlan },
    tabs,
    pressure: pressureWithProtection,
    idleState,
    decisions
  };
}

export function automaticDiscardLimit(evaluation: Pick<ScanEvaluation, "state" | "pressure"> & Partial<Pick<ScanEvaluation, "decisions" | "idleState">>): number {
  return buildAutomationPlan({ ...evaluation, decisions: evaluation.decisions ?? [] }).maxDiscards;
}

function plannedDecisions(evaluation: ScanEvaluation): DiscardDecision[] {
  const plan = buildAutomationPlan(evaluation);
  const selected = new Set(plan.selectedTabIds);
  return evaluation.decisions.filter(decision => selected.has(decision.tab.tabId));
}

async function runScanOnce(reason: ScanReason): Promise<ScanEvaluation & { discardedCount: number }> {
  const evaluation = await collectScanEvaluation(reason, { commitObservation: reason !== "manual" });
  let discardedCount = 0;
  let discardReason: DiscardReason | undefined;
  let lastMemoryRelease = evaluation.state.lastMemoryRelease;
  let lastDiscardSummary = evaluation.state.lastDiscardSummary;
  const snoozed = reason !== "manual" && isSnoozed(evaluation.state.settings);
  const requestedAt = Date.now();

  if (reason === "manual") {
    discardReason = "manualRelease";
    const batch = await discardSelected(
      evaluation.decisions,
      evaluation.state.settings.maxManualDiscardsPerAction,
      discardReason
    );
    discardedCount = batch.discardedCount;
    lastDiscardSummary = await saveDiscardSummary({
      batch,
      requestedAt,
      limit: evaluation.state.settings.maxManualDiscardsPerAction
    });
  } else if (!snoozed) {
    discardReason = evaluation.pressure.level === "emergency" ? "memoryPressure" : "autoInactive";
    const limit = automaticDiscardLimit(evaluation);
    const batch = await discardSelected(
      plannedDecisions(evaluation),
      limit,
      discardReason,
      uncheckedTabPolicyForPressure(evaluation.pressure)
    );
    discardedCount = batch.discardedCount;
    if (batch.attemptedCount > 0 || batch.failedCount > 0) {
      lastDiscardSummary = await saveDiscardSummary({
        batch,
        requestedAt,
        limit
      });
    }
  }

  if (discardedCount > 0 && discardReason) {
    lastMemoryRelease = await saveMemoryReleaseAfterDiscard({
      discardedCount,
      discardReason,
      beforeSampleValid: evaluation.pressure.memorySampleValid,
      beforeAvailableBytes: evaluation.pressure.memoryAvailableBytes
    });
  } else if (reason === "manual" && discardReason) {
    lastMemoryRelease = createNoDiscardMemoryRelease(discardReason, evaluation.pressure.memoryAvailableBytes);
    await saveLastMemoryRelease(lastMemoryRelease);
  }

  await saveLastPressure(evaluation.pressure);
  await appendEffectSample({
    evaluation,
    discardedCount,
    discardReason,
    memoryRelease: lastMemoryRelease
  });
  await updateBadge(evaluation.pressure);

  return {
    ...evaluation,
    state: {
      ...evaluation.state,
      lastMemoryRelease,
      lastDiscardSummary
    },
    discardedCount
  };
}

async function runFilteredManualDiscard(
  evaluation: ScanEvaluation,
  predicate: (decision: DiscardDecision) => boolean
): Promise<ScanEvaluation & { discardedCount: number }> {
  const discardReason: DiscardReason = "manualRelease";
  const requestedAt = Date.now();
  const filteredDecisions = filterDiscardDecisions(evaluation.decisions, predicate);
  const batch = await discardSelected(
    filteredDecisions,
    evaluation.state.settings.maxManualDiscardsPerAction,
    discardReason
  );
  const lastDiscardSummary = await saveDiscardSummary({
    batch,
    requestedAt,
    limit: evaluation.state.settings.maxManualDiscardsPerAction
  });
  const lastMemoryRelease =
    batch.discardedCount > 0
      ? await saveMemoryReleaseAfterDiscard({
          discardedCount: batch.discardedCount,
          discardReason,
          beforeSampleValid: evaluation.pressure.memorySampleValid,
      beforeAvailableBytes: evaluation.pressure.memoryAvailableBytes
        })
      : createNoDiscardMemoryRelease(discardReason, evaluation.pressure.memoryAvailableBytes);

  if (batch.discardedCount === 0) await saveLastMemoryRelease(lastMemoryRelease);
  await saveLastPressure(evaluation.pressure);
  await appendEffectSample({
    evaluation,
    discardedCount: batch.discardedCount,
    discardReason,
    memoryRelease: lastMemoryRelease
  });
  await updateBadge(evaluation.pressure);

  return {
    ...evaluation,
    state: {
      ...evaluation.state,
      lastDiscardSummary,
      lastMemoryRelease
    },
    discardedCount: batch.discardedCount
  };
}

export function filterDiscardDecisions(
  decisions: DiscardDecision[],
  predicate: (decision: DiscardDecision) => boolean
): DiscardDecision[] {
  return decisions.filter(decision => decision.action !== "discard" || predicate(decision));
}

export async function discardTabsOlderThan(
  inactiveMinutes: number
): Promise<ScanEvaluation & { discardedCount: number }> {
  if (!Number.isFinite(inactiveMinutes) || inactiveMinutes < 1 || inactiveMinutes > 43_200) {
    throw new Error("Inactive minutes must be between 1 and 43200.");
  }
  const evaluation = await collectScanEvaluation("manual");
  return runFilteredManualDiscard(evaluation, decision => decision.inactiveMinutes >= inactiveMinutes);
}

export async function discardCurrentDomainBackgroundTabs(): Promise<
  ScanEvaluation & { discardedCount: number }
> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeDomain = isHttpUrl(activeTab?.url) ? getHostname(activeTab?.url) : null;
  if (!activeDomain) throw new Error("Active HTTP or HTTPS tab required.");

  const evaluation = await collectScanEvaluation("manual");
  return runFilteredManualDiscard(evaluation, decision => decision.tab.domain === activeDomain);
}

async function runFocusCleanupOnce(): Promise<ScanEvaluation & { discardedCount: number; eligibleCount: number }> {
  const evaluation = await collectScanEvaluation("periodic", { commitObservation: true });
  const hasFocusTargets = evaluation.state.temporaryTabProtections.some(isFocusProtection);
  const discardReason: DiscardReason = evaluation.pressure.level === "emergency" ? "memoryPressure" : "autoInactive";
  let discardedCount = 0;
  let lastMemoryRelease = evaluation.state.lastMemoryRelease;
  let lastDiscardSummary = evaluation.state.lastDiscardSummary;
  const requestedAt = Date.now();
  const snoozed = isSnoozed(evaluation.state.settings);

  if (evaluation.state.focusModeEnabled && hasFocusTargets && !snoozed) {
    const limit = automaticDiscardLimit(evaluation);
    const batch = await discardSelected(
      plannedDecisions(evaluation),
      limit,
      discardReason,
      uncheckedTabPolicyForPressure(evaluation.pressure)
    );
    discardedCount = batch.discardedCount;
    if (batch.attemptedCount > 0 || batch.failedCount > 0) {
      lastDiscardSummary = await saveDiscardSummary({
        batch,
        requestedAt,
        limit
      });
    }
  }

  if (discardedCount > 0) {
    lastMemoryRelease = await saveMemoryReleaseAfterDiscard({
      discardedCount,
      discardReason,
      beforeSampleValid: evaluation.pressure.memorySampleValid,
      beforeAvailableBytes: evaluation.pressure.memoryAvailableBytes,
      sampleDelayMs: 0
    });
  }

  await saveLastPressure(evaluation.pressure);
  await appendEffectSample({
    evaluation,
    discardedCount,
    discardReason: evaluation.state.focusModeEnabled && hasFocusTargets && !snoozed ? discardReason : undefined,
    memoryRelease: lastMemoryRelease
  });
  await updateBadge(evaluation.pressure);

  return {
    ...evaluation,
    state: {
      ...evaluation.state,
      lastMemoryRelease,
      lastDiscardSummary
    },
    discardedCount,
    eligibleCount: evaluation.decisions.filter(decision => decision.action === "discard").length
  };
}

export async function discardTabNow(tabId: number): Promise<ScanEvaluation & { discardedCount: number }> {
  const state = await loadAppState();
  const [tab, pressure, idleState] = await Promise.all([
    chrome.tabs.get(tabId),
    collectPressureSnapshot(state.settings, undefined, { persistCpuSample: false, persistHistory: false }),
    chrome.idle.queryState(60)
  ]);

  const decisions = evaluateTabs({
    tabs: [tab],
    state,
    pressure,
    idleState,
    reason: "manual"
  });

  const pressureWithProtection = {
    ...pressure,
    protectedTabCount: countProtectedTabs(decisions)
  };
  const skipReason = decisions[0]?.skipReason;
  if (
    skipReason === "protectedTemporary" ||
    skipReason === "protectedDomain" ||
    skipReason === "protectedUrlPattern"
  ) {
    throw new Error("This tab is protected. Turn off Keep loaded or its rule first.");
  }

  const discardReason: DiscardReason = "manualRelease";
  const attempt = await discardTabDirectlyWithResult(tabId, discardReason);
  const batch = createDiscardBatchResult(discardReason, 1, [attempt]);
  const lastDiscardSummary = await saveDiscardSummary({
    batch,
    requestedAt: Date.now(),
    limit: 1
  });
  const discardedCount = batch.discardedCount;

  if (discardedCount === 0) {
    throw new Error(attempt.message ?? "Tab could not be discarded.");
  }

  const lastMemoryRelease = await saveMemoryReleaseAfterDiscard({
    discardedCount,
    discardReason,
    beforeSampleValid: pressure.memorySampleValid,
    beforeAvailableBytes: pressure.memoryAvailableBytes
  });

  await saveLastPressure(pressureWithProtection);
  await appendEffectSample({
    evaluation: {
      state,
      tabs: [tab],
      pressure: pressureWithProtection,
      idleState,
      decisions
    },
    discardedCount,
    discardReason,
    memoryRelease: lastMemoryRelease
  });
  await updateBadge(pressureWithProtection);

  return {
    state: {
      ...state,
      lastMemoryRelease,
      lastDiscardSummary
    },
    tabs: [tab],
    pressure: pressureWithProtection,
    idleState,
    decisions,
    discardedCount
  };
}

export async function refreshStatus(reason: ScanReason = "periodic"): Promise<ScanEvaluation> {
  const evaluation = await collectScanEvaluation(reason);
  await saveLastPressure(evaluation.pressure);
  await updateBadge(evaluation.pressure);
  return evaluation;
}

export async function simulatePolicy(patch: Partial<AppState["settings"]> = {}): Promise<PolicySimulationResult> {
  const state = await loadAppState();
  const settings = normalizeSettings({ ...state.settings, ...patch });
  const tabs = await chrome.tabs.query({});
  const [pressure, idleState, powerState] = await Promise.all([
    collectPressureSnapshot(settings, tabs, { persistCpuSample: false, persistHistory: false }),
    chrome.idle.queryState(60),
    collectPowerState(settings, { persist: false })
  ]);
  const root = assessPressureRootCause({
    pressure, tabMetrics: freshMetricsForTabs(state.tabAccurateMetrics, tabs, pressure.sampledAt),
    memoryRelease: state.lastMemoryRelease,
    discardEvents: (state.externalDiscardObservations ?? []).map(item => ({ source: "externalOrNative" as const, observedAt: item.observedAt })),
    now: pressure.sampledAt
  });
  const simulatedState: AppState = {
    ...state, settings, powerState,
    rootCauseAssessment: { ...root, assessedAt: pressure.sampledAt, summary: root.evidence.join(" ") }
  };
  const decisions = evaluateTabs({ tabs, state: simulatedState, pressure, idleState, reason: "periodic" });
  const automationPlan = buildAutomationPlan({ state: simulatedState, pressure, idleState, decisions });
  const skipCounts: PolicySimulationResult["skipCounts"] = {};
  for (const decision of decisions) {
    if (decision.action === "skip" && decision.skipReason) {
      skipCounts[decision.skipReason] = (skipCounts[decision.skipReason] ?? 0) + 1;
    }
  }
  return {
    simulatedAt: pressure.sampledAt, policyMode: settings.policyMode,
    eligibleCount: decisions.filter(decision => decision.action === "discard").length,
    plannedCount: automationPlan.selectedTabIds.length, automationPlan,
    protectedCount: countProtectedTabs(decisions), recentCount: skipCounts.recentlyActive ?? 0,
    candidates: decisions.sort((a, b) => b.score - a.score), skipCounts
  };
}

let automaticActionQueue: Promise<unknown> = Promise.resolve();
function queueAutomaticAction<T>(action: () => Promise<T>): Promise<T> {
  const operation = automaticActionQueue.then(action);
  automaticActionQueue = operation.catch(() => undefined);
  return operation;
}
export function runScan(reason: ScanReason): ReturnType<typeof runScanOnce> {
  return queueAutomaticAction(() => runScanOnce(reason));
}
export function runFocusCleanup(): ReturnType<typeof runFocusCleanupOnce> {
  return queueAutomaticAction(runFocusCleanupOnce);
}
