import { DEFAULT_PROTECTION_RULES, DEFAULT_SETTINGS, SESSION_KEYS, STORAGE_KEYS } from "./constants";
import type {
  AppState,
  AutomationPlan,
  DiscardActionSummary,
  DiscardLearningRecord,
  DiscardLogEntry,
  EffectHistoryEntry,
  ExternalDiscardObservation,
  InternalDiscardIntent,
  MemoryReleaseEstimate,
  OptimizedTab,
  PolicyMode,
  PowerStateSnapshot,
  PressureSnapshot,
  PressureRootCauseAssessment,
  ProtectionRule,
  RecoveryCapsule,
  SavedSession,
  SavedFocusSet,
  SessionTimelineSnapshot,
  Settings,
  SyncStatus,
  TabAccurateMetrics,
  TemporaryTabProtection,
  TrashedSession,
  AutoMergeResult,
  WindowPolicy,
  WorkProtectionHold
} from "./types";
import { normalizeHostname } from "./url";
import { LEGACY_NAMES, migrateSettingsNames } from "./legacyNames";

type LocalStorageShape = {
  [STORAGE_KEYS.SETTINGS]?: Partial<Settings>;
  [STORAGE_KEYS.PROTECTION_RULES]?: ProtectionRule[];
  [STORAGE_KEYS.WINDOW_POLICIES]?: WindowPolicy[];
  [STORAGE_KEYS.DISCARD_LOG]?: DiscardLogEntry[];
  [STORAGE_KEYS.SESSIONS]?: SavedSession[];
  [STORAGE_KEYS.FOCUS_SETS]?: SavedFocusSet[];
  [STORAGE_KEYS.LAST_PRESSURE]?: PressureSnapshot;
  [STORAGE_KEYS.DISCARD_LEARNING]?: DiscardLearningRecord[];
  [STORAGE_KEYS.EXTERNAL_DISCARD_OBSERVATIONS]?: ExternalDiscardObservation[];
  [STORAGE_KEYS.RECOVERY_CAPSULES]?: RecoveryCapsule[];
  [STORAGE_KEYS.SESSION_TIMELINE]?: SessionTimelineSnapshot[];
  [STORAGE_KEYS.SESSION_TRASH]?: TrashedSession[];
  [STORAGE_KEYS.EFFECT_HISTORY]?: EffectHistoryEntry[];
  [STORAGE_KEYS.SYNC_STATUS]?: SyncStatus;
};

type SessionStorageShape = {
  [SESSION_KEYS.WORK_PROTECTION_HOLDS]?: WorkProtectionHold[];
  [SESSION_KEYS.AUTOMATION_PLAN]?: AutomationPlan;
  [SESSION_KEYS.TEMPORARY_TAB_PROTECTIONS]?: TemporaryTabProtection[];
  [SESSION_KEYS.FOCUS_MODE_ENABLED]?: boolean;
  [SESSION_KEYS.PAGE_OPTIMIZED_TABS]?: OptimizedTab[];
  [SESSION_KEYS.OPTIMIZER_PAUSED_TABS]?: Array<{ tabId: number; url?: string }>;
  [SESSION_KEYS.TAB_ACCURATE_METRICS]?: TabAccurateMetrics[];
  [SESSION_KEYS.LAST_MEMORY_RELEASE]?: MemoryReleaseEstimate;
  [SESSION_KEYS.LAST_DISCARD_SUMMARY]?: DiscardActionSummary;
  [SESSION_KEYS.POWER_STATE]?: PowerStateSnapshot;
  [SESSION_KEYS.ROOT_CAUSE_ASSESSMENT]?: PressureRootCauseAssessment;
  [SESSION_KEYS.INTERNAL_DISCARD_INTENTS]?: InternalDiscardIntent[];
  [SESSION_KEYS.LAST_AUTO_MERGE]?: AutoMergeResult;
};

// One writer in the service worker serializes read-modify-write operations, including
// nested session/trash updates. Rejected writes must not poison later operations.
let storageMutationQueue: Promise<void> = Promise.resolve();

export function withStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageMutationQueue.then(operation);
  storageMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function serializeMutation<Args extends unknown[], T>(operation: (...args: Args) => Promise<T>): (...args: Args) => Promise<T> {
  return (...args) => withStorageMutation(() => operation(...args));
}

async function getLocal<T extends keyof LocalStorageShape>(key: T): Promise<LocalStorageShape[T]> {
  const result = await chrome.storage.local.get(key);
  return result[key] as LocalStorageShape[T];
}

async function setLocal(items: LocalStorageShape): Promise<void> {
  await chrome.storage.local.set(items);
}

async function getSession<T extends keyof SessionStorageShape>(key: T): Promise<SessionStorageShape[T]> {
  const result = await chrome.storage.session.get(key);
  return result[key] as SessionStorageShape[T];
}

async function setSession(items: SessionStorageShape): Promise<void> {
  await chrome.storage.session.set(items);
}

export function normalizeSettings(input?: Partial<Settings> | Record<string, unknown>): Settings {
  const settings = migrateSettingsNames(input) as Partial<Settings>;
  const finiteNumber = (value: unknown, fallback: number, minimum: number, maximum: number, integer = false): number => {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const bounded = Math.min(maximum, Math.max(minimum, numeric));
    return integer ? Math.round(bounded) : bounded;
  };
  const booleanValue = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  const enumValue = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
  const optimizerSiteDomains = Array.isArray(settings?.pageOptimizerSiteDomains)
    ? [
        ...new Set(
          settings.pageOptimizerSiteDomains
            .map(normalizeHostname)
            .filter((domain): domain is string => domain !== null)
        )
      ]
    : DEFAULT_SETTINGS.pageOptimizerSiteDomains;
  const seenDiscardRuleDomains = new Set<string>();
  const domainDiscardRules = Array.isArray(settings?.domainDiscardRules)
    ? settings.domainDiscardRules
        .filter(
          rule =>
            rule !== null &&
            typeof rule === "object" &&
            typeof rule.domain === "string" &&
            Number.isFinite(rule.inactiveMinutes)
        )
        .map(rule => {
          const domain = normalizeHostname(rule.domain);
          return domain
            ? {
                domain,
                inactiveMinutes: Math.min(43_200, Math.max(1, Math.round(rule.inactiveMinutes))),
                createdAt: Number.isFinite(rule.createdAt) ? rule.createdAt : Date.now()
              }
            : null;
        })
        .filter((rule): rule is NonNullable<typeof rule> => {
          if (!rule || seenDiscardRuleDomains.has(rule.domain)) return false;
          seenDiscardRuleDomains.add(rule.domain);
          return true;
        })
    : DEFAULT_SETTINGS.domainDiscardRules;
  const memoryHighAvailableRatio = finiteNumber(
    settings?.memoryHighAvailableRatio,
    DEFAULT_SETTINGS.memoryHighAvailableRatio,
    0.01,
    1
  );
  const memoryEmergencyAvailableRatio = Math.min(
    memoryHighAvailableRatio,
    finiteNumber(
      settings?.memoryEmergencyAvailableRatio,
      DEFAULT_SETTINGS.memoryEmergencyAvailableRatio,
      0.01,
      1
    )
  );
  const optimizerItems = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS.pageOptimizerItems).map(([key, fallback]) => [
      key,
      booleanValue(settings?.pageOptimizerItems?.[key as keyof Settings["pageOptimizerItems"]], fallback)
    ])
  ) as Settings["pageOptimizerItems"];

  return {
    ...DEFAULT_SETTINGS,
    policyMode: enumValue(
      settings?.policyMode,
      ["manual", "conservative", "balanced", "aggressive", "pressureAdaptive", "custom"],
      DEFAULT_SETTINGS.policyMode
    ),
    conservativeMinutes: finiteNumber(settings?.conservativeMinutes, DEFAULT_SETTINGS.conservativeMinutes, 1, 10_080, true),
    balancedMinutes: finiteNumber(settings?.balancedMinutes, DEFAULT_SETTINGS.balancedMinutes, 1, 10_080, true),
    aggressiveMinutes: finiteNumber(settings?.aggressiveMinutes, DEFAULT_SETTINGS.aggressiveMinutes, 1, 10_080, true),
    customMinutes: finiteNumber(settings?.customMinutes, DEFAULT_SETTINGS.customMinutes, 1, 10_080, true),
    scanIntervalMinutes: finiteNumber(settings?.scanIntervalMinutes, DEFAULT_SETTINGS.scanIntervalMinutes, 1, 1_440, true),
    maxAutoDiscardsPerScan: finiteNumber(settings?.maxAutoDiscardsPerScan, DEFAULT_SETTINGS.maxAutoDiscardsPerScan, 1, 100, true),
    maxManualDiscardsPerAction: finiteNumber(settings?.maxManualDiscardsPerAction, DEFAULT_SETTINGS.maxManualDiscardsPerAction, 1, 1_000, true),
    protectPinned: booleanValue(settings?.protectPinned, DEFAULT_SETTINGS.protectPinned),
    protectAudible: booleanValue(settings?.protectAudible, DEFAULT_SETTINGS.protectAudible),
    protectUnsavedWork: booleanValue(settings?.protectUnsavedWork, DEFAULT_SETTINGS.protectUnsavedWork),
    protectActive: booleanValue(settings?.protectActive, DEFAULT_SETTINGS.protectActive),
    protectIncognito: booleanValue(settings?.protectIncognito, DEFAULT_SETTINGS.protectIncognito),
    respectAutoDiscardableFalse: booleanValue(
      settings?.respectAutoDiscardableFalse,
      DEFAULT_SETTINGS.respectAutoDiscardableFalse
    ),
    memoryHighAvailableRatio,
    memoryEmergencyAvailableRatio,
    cpuHighRatio: finiteNumber(settings?.cpuHighRatio, DEFAULT_SETTINGS.cpuHighRatio, 0.01, 1),
    pageOptimizerItems: optimizerItems,
    pageOptimizerSiteDomains: optimizerSiteDomains,
    pageOptimizerAllSites: booleanValue(settings?.pageOptimizerAllSites, false),
    pageOptimizerExcludedDomains: Array.isArray(settings?.pageOptimizerExcludedDomains)
      ? [...new Set(settings.pageOptimizerExcludedDomains.map(normalizeHostname).filter((domain): domain is string => domain !== null))]
      : [],
    domainDiscardRules,
    powerPolicyMode:
      settings?.powerPolicyMode === "off" ||
      settings?.powerPolicyMode === "batterySaver" ||
      settings?.powerPolicyMode === "lowBatteryAggressive"
        ? settings.powerPolicyMode
        : DEFAULT_SETTINGS.powerPolicyMode,
    lowBatteryThreshold: finiteNumber(
      settings?.lowBatteryThreshold,
      DEFAULT_SETTINGS.lowBatteryThreshold,
      0.05,
      1
    ),
    autoMergeDuplicateTabs: booleanValue(
      settings?.autoMergeDuplicateTabs,
      DEFAULT_SETTINGS.autoMergeDuplicateTabs
    ),
    discardLearningEnabled: booleanValue(
      settings?.discardLearningEnabled,
      DEFAULT_SETTINGS.discardLearningEnabled
    ),
    quickReactivateMinutes: finiteNumber(
      settings?.quickReactivateMinutes,
      DEFAULT_SETTINGS.quickReactivateMinutes,
      1,
      120,
      true
    ),
    timeMachineEnabled: booleanValue(settings?.timeMachineEnabled, DEFAULT_SETTINGS.timeMachineEnabled),
    timeMachineIntervalMinutes: finiteNumber(
      settings?.timeMachineIntervalMinutes,
      DEFAULT_SETTINGS.timeMachineIntervalMinutes,
      1,
      1440,
      true
    ),
    timeMachineRetention: finiteNumber(
      settings?.timeMachineRetention,
      DEFAULT_SETTINGS.timeMachineRetention,
      1,
      1000,
      true
    ),
    recoveryCapsuleLimit: finiteNumber(
      settings?.recoveryCapsuleLimit,
      DEFAULT_SETTINGS.recoveryCapsuleLimit,
      1,
      500,
      true
    ),
    syncEnabled: booleanValue(settings?.syncEnabled, DEFAULT_SETTINGS.syncEnabled),
    syncSettings: booleanValue(settings?.syncSettings, DEFAULT_SETTINGS.syncSettings),
    syncProtectionRules: booleanValue(settings?.syncProtectionRules, DEFAULT_SETTINGS.syncProtectionRules),
    syncFocusSets: booleanValue(settings?.syncFocusSets, DEFAULT_SETTINGS.syncFocusSets),
    networkFilteringMode: enumValue(settings?.networkFilteringMode, ["off", "light"], DEFAULT_SETTINGS.networkFilteringMode),
    keepDiscardLogLimit: finiteNumber(
      settings?.keepDiscardLogLimit,
      DEFAULT_SETTINGS.keepDiscardLogLimit,
      1,
      10_000,
      true
    ),
    keepSessionLimit: finiteNumber(settings?.keepSessionLimit, DEFAULT_SETTINGS.keepSessionLimit, 1, 5_000, true),
    showBadge: booleanValue(settings?.showBadge, DEFAULT_SETTINGS.showBadge),
    privacyMode: booleanValue(settings?.privacyMode, DEFAULT_SETTINGS.privacyMode),
    pageOptimizerEnabled: booleanValue(
      settings?.pageOptimizerEnabled,
      DEFAULT_SETTINGS.pageOptimizerEnabled
    ),
    snoozeIndefinitely: booleanValue(settings?.snoozeIndefinitely, DEFAULT_SETTINGS.snoozeIndefinitely ?? false),
    ...(typeof settings?.snoozeUntil === "number" &&
    Number.isSafeInteger(settings.snoozeUntil) &&
    settings.snoozeUntil >= 0
      ? { snoozeUntil: settings.snoozeUntil }
      : {})
  };
}

export async function getSettings(): Promise<Settings> {
  return normalizeSettings(await getLocal(STORAGE_KEYS.SETTINGS));
}

async function saveSettingsUnqueued(settings: Settings): Promise<void> {
  await setLocal({ [STORAGE_KEYS.SETTINGS]: normalizeSettings(settings) });
}
export const saveSettings = serializeMutation(saveSettingsUnqueued);

async function updateSettingsUnqueued(patch: Partial<Settings>): Promise<Settings> {
  const settings = normalizeSettings({ ...(await getSettings()), ...patch });
  await saveSettingsUnqueued(settings);
  return settings;
}
export const updateSettings = serializeMutation(updateSettingsUnqueued);

export async function getProtectionRules(): Promise<ProtectionRule[]> {
  return (await getLocal(STORAGE_KEYS.PROTECTION_RULES)) ?? DEFAULT_PROTECTION_RULES;
}

async function saveProtectionRulesUnqueued(rules: ProtectionRule[]): Promise<void> {
  await setLocal({ [STORAGE_KEYS.PROTECTION_RULES]: rules });
}
export const saveProtectionRules = serializeMutation(saveProtectionRulesUnqueued);

async function updateProtectionRulesUnqueued(update: (rules: ProtectionRule[]) => ProtectionRule[]): Promise<ProtectionRule[]> {
  const next = update(await getProtectionRules());
  await saveProtectionRulesUnqueued(next);
  return next;
}
export const updateProtectionRules = serializeMutation(updateProtectionRulesUnqueued);

export async function getTemporaryTabProtections(): Promise<TemporaryTabProtection[]> {
  return (await getSession(SESSION_KEYS.TEMPORARY_TAB_PROTECTIONS)) ?? [];
}

async function saveTemporaryTabProtectionsUnqueued(protections: TemporaryTabProtection[]): Promise<void> {
  await setSession({ [SESSION_KEYS.TEMPORARY_TAB_PROTECTIONS]: protections });
}
export const saveTemporaryTabProtections = serializeMutation(saveTemporaryTabProtectionsUnqueued);

async function updateTemporaryTabProtectionsUnqueued(
  update: (protections: TemporaryTabProtection[]) => TemporaryTabProtection[]
): Promise<TemporaryTabProtection[]> {
  const current = await getTemporaryTabProtections();
  const next = update(current);
  if (next !== current) await saveTemporaryTabProtectionsUnqueued(next);
  return next;
}
export const updateTemporaryTabProtections = serializeMutation(updateTemporaryTabProtectionsUnqueued);

async function setTemporaryTabProtectionUnqueued(
  protection: TemporaryTabProtection
): Promise<TemporaryTabProtection[]> {
  const protections = await getTemporaryTabProtections();
  const next = [protection, ...protections.filter(item => item.tabId !== protection.tabId)];
  await saveTemporaryTabProtectionsUnqueued(next);
  return next;
}
export const setTemporaryTabProtection = serializeMutation(setTemporaryTabProtectionUnqueued);

export function isFocusProtection(protection: TemporaryTabProtection): boolean {
  return protection.source === "focus" || protection.focus === true;
}

async function removeTemporaryTabProtectionUnqueued(tabId: number): Promise<TemporaryTabProtection[]> {
  const protections = await getTemporaryTabProtections();
  const next = protections.filter(item => item.tabId !== tabId);
  if (next.length !== protections.length) {
    await saveTemporaryTabProtectionsUnqueued(next);
  }
  return next;
}
export const removeTemporaryTabProtection = serializeMutation(removeTemporaryTabProtectionUnqueued);

async function removeTemporaryTabProtectionsByRuleIdsUnqueued(ruleIds: string[]): Promise<TemporaryTabProtection[]> {
  if (ruleIds.length === 0) return getTemporaryTabProtections();

  const ruleIdSet = new Set(ruleIds);
  const protections = await getTemporaryTabProtections();
  const next = protections.flatMap(item => {
    const remainingRuleIds = item.ruleIds?.filter(ruleId => !ruleIdSet.has(ruleId)) ?? [];
    if (remainingRuleIds.length === (item.ruleIds?.length ?? 0)) return [item];
    if (remainingRuleIds.length > 0) return [{ ...item, ruleIds: remainingRuleIds }];
    if (isFocusProtection(item)) {
      return [{ ...item, source: "focus" as const, ruleIds: undefined, focus: true }];
    }
    if (item.source === "rule") return [];
    return [{ ...item, ruleIds: undefined }];
  });
  if (next.length !== protections.length || next.some((item, index) => item !== protections[index])) {
    await saveTemporaryTabProtectionsUnqueued(next);
  }
  return next;
}
export const removeTemporaryTabProtectionsByRuleIds = serializeMutation(removeTemporaryTabProtectionsByRuleIdsUnqueued);

/** Clears navigation-derived rule protection without erasing independent Focus state. */
async function clearRuleTemporaryTabProtectionUnqueued(tabId: number): Promise<TemporaryTabProtection[]> {
  const protections = await getTemporaryTabProtections();
  const next = protections.flatMap(item => {
    if (item.tabId !== tabId || item.source !== "rule") return [item];
    if (isFocusProtection(item)) {
      return [{ ...item, source: "focus" as const, ruleIds: undefined, focus: true }];
    }
    return [];
  });
  if (next.length !== protections.length || next.some((item, index) => item !== protections[index])) {
    await saveTemporaryTabProtectionsUnqueued(next);
  }
  return next;
}
export const clearRuleTemporaryTabProtection = serializeMutation(clearRuleTemporaryTabProtectionUnqueued);

async function clearFocusTabProtectionsUnqueued(): Promise<TemporaryTabProtection[]> {
  const protections = await getTemporaryTabProtections();
  const next = protections
    .filter(item => item.source !== "focus")
    .map(item => (item.focus || item.focusedAt ? { ...item, focus: undefined, focusedAt: undefined } : item));

  if (
    next.length !== protections.length ||
    next.some((item, index) => item !== protections[index])
  ) {
    await saveTemporaryTabProtectionsUnqueued(next);
  }

  return next;
}
export const clearFocusTabProtections = serializeMutation(clearFocusTabProtectionsUnqueued);

async function pruneTemporaryTabProtectionsUnqueued(openTabIds: Set<number>): Promise<TemporaryTabProtection[]> {
  const protections = await getTemporaryTabProtections();
  const next = protections.filter(item => openTabIds.has(item.tabId));
  if (next.length !== protections.length) {
    await saveTemporaryTabProtectionsUnqueued(next);
  }
  return next;
}
export const pruneTemporaryTabProtections = serializeMutation(pruneTemporaryTabProtectionsUnqueued);

export async function getOptimizedTabs(): Promise<OptimizedTab[]> {
  return (await getSession(SESSION_KEYS.PAGE_OPTIMIZED_TABS)) ?? [];
}

async function saveOptimizedTabsUnqueued(tabs: OptimizedTab[]): Promise<void> {
  await setSession({ [SESSION_KEYS.PAGE_OPTIMIZED_TABS]: tabs });
}
export const saveOptimizedTabs = serializeMutation(saveOptimizedTabsUnqueued);

async function setOptimizedTabUnqueued(tab: OptimizedTab): Promise<OptimizedTab[]> {
  const tabs = await getOptimizedTabs();
  const next = [tab, ...tabs.filter(item => item.tabId !== tab.tabId)];
  await saveOptimizedTabsUnqueued(next);
  return next;
}
export const setOptimizedTab = serializeMutation(setOptimizedTabUnqueued);

async function removeOptimizedTabUnqueued(tabId: number): Promise<OptimizedTab[]> {
  const tabs = await getOptimizedTabs();
  const next = tabs.filter(item => item.tabId !== tabId);
  if (next.length !== tabs.length) {
    await saveOptimizedTabsUnqueued(next);
  }
  return next;
}
export const removeOptimizedTab = serializeMutation(removeOptimizedTabUnqueued);

async function pruneOptimizedTabsUnqueued(openTabIds: Set<number>): Promise<OptimizedTab[]> {
  const tabs = await getOptimizedTabs();
  const next = tabs.filter(item => openTabIds.has(item.tabId));
  if (next.length !== tabs.length) {
    await saveOptimizedTabsUnqueued(next);
  }
  return next;
}
export const pruneOptimizedTabs = serializeMutation(pruneOptimizedTabsUnqueued);

export async function getOptimizerPausedTabs(): Promise<Array<{ tabId: number; url?: string }>> {
  return (await getSession(SESSION_KEYS.OPTIMIZER_PAUSED_TABS)) ?? [];
}

export const setOptimizerTabPaused = serializeMutation(async (tabId: number, url?: string): Promise<void> => {
  const tabs = await getOptimizerPausedTabs();
  await setSession({ [SESSION_KEYS.OPTIMIZER_PAUSED_TABS]: [{ tabId, url }, ...tabs.filter(tab => tab.tabId !== tabId)] });
});

export const clearOptimizerTabPause = serializeMutation(async (tabId?: number): Promise<void> => {
  const tabs = await getOptimizerPausedTabs();
  const next = tabId === undefined ? [] : tabs.filter(tab => tab.tabId !== tabId);
  if (next.length !== tabs.length) await setSession({ [SESSION_KEYS.OPTIMIZER_PAUSED_TABS]: next });
});

export const pruneOptimizerPausedTabs = serializeMutation(async (openIds: Set<number>): Promise<void> => {
  const tabs = await getOptimizerPausedTabs();
  const next = tabs.filter(tab => openIds.has(tab.tabId));
  if (next.length !== tabs.length) await setSession({ [SESSION_KEYS.OPTIMIZER_PAUSED_TABS]: next });
});

const TAB_METRICS_RETENTION_MS = 30 * 60_000;

export async function getTabAccurateMetrics(): Promise<TabAccurateMetrics[]> {
  return (await getSession(SESSION_KEYS.TAB_ACCURATE_METRICS)) ?? [];
}

async function saveTabAccurateMetricsUnqueued(metrics: TabAccurateMetrics[]): Promise<void> {
  const unique = new Map<number, TabAccurateMetrics>();
  for (const metric of [...metrics].sort((a, b) => b.sampledAt - a.sampledAt)) {
    if (!unique.has(metric.tabId)) unique.set(metric.tabId, metric);
  }
  await setSession({ [SESSION_KEYS.TAB_ACCURATE_METRICS]: [...unique.values()] });
}
export const saveTabAccurateMetrics = serializeMutation(saveTabAccurateMetricsUnqueued);

async function mergeTabAccurateMetricsUnqueued(metrics: TabAccurateMetrics[]): Promise<TabAccurateMetrics[]> {
  const previous = await getTabAccurateMetrics();
  const incomingIds = new Set(metrics.map(metric => metric.tabId));
  const next = [...metrics, ...previous.filter(metric => !incomingIds.has(metric.tabId))];
  await saveTabAccurateMetricsUnqueued(next);
  return next;
}
export const mergeTabAccurateMetrics = serializeMutation(mergeTabAccurateMetricsUnqueued);

async function removeTabAccurateMetricUnqueued(tabId: number): Promise<TabAccurateMetrics[]> {
  const metrics = await getTabAccurateMetrics();
  const next = metrics.filter(metric => metric.tabId !== tabId);
  if (next.length !== metrics.length) await saveTabAccurateMetricsUnqueued(next);
  return next;
}
export const removeTabAccurateMetric = serializeMutation(removeTabAccurateMetricUnqueued);

async function pruneTabAccurateMetricsUnqueued(
  openTabIds: Set<number>,
  now = Date.now()
): Promise<TabAccurateMetrics[]> {
  const metrics = await getTabAccurateMetrics();
  const next = metrics.filter(
    metric => openTabIds.has(metric.tabId) && now - metric.sampledAt <= TAB_METRICS_RETENTION_MS
  );
  if (next.length !== metrics.length) await saveTabAccurateMetricsUnqueued(next);
  return next;
}
export const pruneTabAccurateMetrics = serializeMutation(pruneTabAccurateMetricsUnqueued);

export async function getFocusModeEnabled(): Promise<boolean> {
  return Boolean(await getSession(SESSION_KEYS.FOCUS_MODE_ENABLED));
}

async function saveFocusModeEnabledUnqueued(enabled: boolean): Promise<void> {
  await setSession({ [SESSION_KEYS.FOCUS_MODE_ENABLED]: enabled });
}
export const saveFocusModeEnabled = serializeMutation(saveFocusModeEnabledUnqueued);

export async function getLastMemoryRelease(): Promise<MemoryReleaseEstimate | undefined> {
  return await getSession(SESSION_KEYS.LAST_MEMORY_RELEASE);
}

async function saveLastMemoryReleaseUnqueued(estimate: MemoryReleaseEstimate): Promise<void> {
  await setSession({ [SESSION_KEYS.LAST_MEMORY_RELEASE]: estimate });
}
export const saveLastMemoryRelease = serializeMutation(saveLastMemoryReleaseUnqueued);

export async function getLastDiscardSummary(): Promise<DiscardActionSummary | undefined> {
  return await getSession(SESSION_KEYS.LAST_DISCARD_SUMMARY);
}

async function saveLastDiscardSummaryUnqueued(summary: DiscardActionSummary): Promise<void> {
  await setSession({ [SESSION_KEYS.LAST_DISCARD_SUMMARY]: summary });
}
export const saveLastDiscardSummary = serializeMutation(saveLastDiscardSummaryUnqueued);

async function addProtectionRuleUnqueued(rule: ProtectionRule): Promise<ProtectionRule[]> {
  const rules = await getProtectionRules();
  const next = [rule, ...rules.filter(existing => existing.id !== rule.id)];
  await saveProtectionRulesUnqueued(next);
  return next;
}
export const addProtectionRule = serializeMutation(addProtectionRuleUnqueued);

async function getDiscardLogUnqueued(): Promise<DiscardLogEntry[]> {
  const log = (await getLocal(STORAGE_KEYS.DISCARD_LOG)) ?? [];
  const settings = await getSettings();
  if (!settings.privacyMode) return log;
  const redacted = log.map(entry => ({ ...entry, title: undefined, url: undefined }));
  if (log.some(entry => entry.title !== undefined || entry.url !== undefined)) {
    await saveDiscardLogUnqueued(redacted);
  }
  return redacted;
}
export const getDiscardLog = serializeMutation(getDiscardLogUnqueued);

async function redactDiscardLogMetadataUnqueued(): Promise<DiscardLogEntry[]> {
  const log = (await getLocal(STORAGE_KEYS.DISCARD_LOG)) ?? [];
  const redacted = log.map(entry => ({ ...entry, title: undefined, url: undefined }));
  if (log.some(entry => entry.title !== undefined || entry.url !== undefined)) {
    await saveDiscardLogUnqueued(redacted);
  }
  return redacted;
}
export const redactDiscardLogMetadata = serializeMutation(redactDiscardLogMetadataUnqueued);

async function saveDiscardLogUnqueued(log: DiscardLogEntry[]): Promise<void> {
  await setLocal({ [STORAGE_KEYS.DISCARD_LOG]: log });
}
export const saveDiscardLog = serializeMutation(saveDiscardLogUnqueued);

async function appendDiscardLogUnqueued(entry: DiscardLogEntry): Promise<void> {
  const [settings, log] = await Promise.all([getSettings(), getDiscardLogUnqueued()]);
  const privacyEntry = settings.privacyMode
    ? {
        ...entry,
        title: undefined,
        url: undefined
      }
    : entry;
  await saveDiscardLogUnqueued([privacyEntry, ...log].slice(0, settings.keepDiscardLogLimit));
}
export const appendDiscardLog = serializeMutation(appendDiscardLogUnqueued);

async function clearDiscardLogUnqueued(): Promise<void> {
  await saveDiscardLogUnqueued([]);
}
export const clearDiscardLog = serializeMutation(clearDiscardLogUnqueued);

async function markDiscardLogUndoneUnqueued(entryId: string): Promise<DiscardLogEntry | null> {
  const log = await getDiscardLogUnqueued();
  const entry = log.find(item => item.id === entryId);
  if (!entry) return null;

  await saveDiscardLogUnqueued(log.map(item => (item.id === entryId ? { ...item, undoneAt: Date.now() } : item)));
  return entry;
}
export const markDiscardLogUndone = serializeMutation(markDiscardLogUndoneUnqueued);

async function markDiscardLogReactivatedUnqueued(entryId: string, reactivatedAt = Date.now()): Promise<DiscardLogEntry | null> {
  const log = await getDiscardLogUnqueued();
  const entry = log.find(item => item.id === entryId);
  if (!entry) return null;
  await saveDiscardLogUnqueued(log.map(item => (item.id === entryId ? { ...item, reactivatedAt } : item)));
  return entry;
}
export const markDiscardLogReactivated = serializeMutation(markDiscardLogReactivatedUnqueued);

// Chrome gives a tab a new id when it is unloaded and again when it reloads. Open log entries follow
// the tab so Undo and reopen feedback still find it.
async function replaceDiscardLogTabIdUnqueued(removedTabId: number, addedTabId: number): Promise<void> {
  const log = await getDiscardLogUnqueued();
  if (!log.some(item => item.tabId === removedTabId && !item.undoneAt && !item.reactivatedAt)) return;
  await saveDiscardLogUnqueued(log.map(item =>
    item.tabId === removedTabId && !item.undoneAt && !item.reactivatedAt ? { ...item, tabId: addedTabId } : item));
}
export const replaceDiscardLogTabId = serializeMutation(replaceDiscardLogTabIdUnqueued);

export async function getDiscardLearning(): Promise<DiscardLearningRecord[]> {
  return (await getLocal(STORAGE_KEYS.DISCARD_LEARNING)) ?? [];
}

async function saveDiscardLearningUnqueued(records: DiscardLearningRecord[]): Promise<void> {
  await setLocal({
    [STORAGE_KEYS.DISCARD_LEARNING]: [...records]
      .sort((a, b) => b.lastFeedbackAt - a.lastFeedbackAt)
      .slice(0, 200)
  });
}
export const saveDiscardLearning = serializeMutation(saveDiscardLearningUnqueued);

async function upsertDiscardLearningUnqueued(record: DiscardLearningRecord): Promise<DiscardLearningRecord[]> {
  const records = await getDiscardLearning();
  const next = [record, ...records.filter(item => item.domain !== record.domain)];
  await saveDiscardLearningUnqueued(next);
  return next;
}
export const upsertDiscardLearning = serializeMutation(upsertDiscardLearningUnqueued);

const EXTERNAL_DISCARD_RETENTION_MS = 24 * 60 * 60_000;

export async function getExternalDiscardObservations(now = Date.now()): Promise<ExternalDiscardObservation[]> {
  const observations = (await getLocal(STORAGE_KEYS.EXTERNAL_DISCARD_OBSERVATIONS)) ?? [];
  return observations.filter(item => now - item.observedAt <= EXTERNAL_DISCARD_RETENTION_MS);
}

async function appendExternalDiscardObservationUnqueued(
  observation: ExternalDiscardObservation
): Promise<ExternalDiscardObservation[]> {
  const next = [observation, ...(await getExternalDiscardObservations())].slice(0, 500);
  await setLocal({ [STORAGE_KEYS.EXTERNAL_DISCARD_OBSERVATIONS]: next });
  return next;
}
export const appendExternalDiscardObservation = serializeMutation(appendExternalDiscardObservationUnqueued);

export async function getRecoveryCapsules(now = Date.now()): Promise<RecoveryCapsule[]> {
  const capsules = (await getLocal(STORAGE_KEYS.RECOVERY_CAPSULES)) ?? [];
  return capsules.filter(capsule => capsule.expiresAt > now);
}

async function saveRecoveryCapsulesUnqueued(capsules: RecoveryCapsule[]): Promise<void> {
  const settings = await getSettings();
  await setLocal({
    [STORAGE_KEYS.RECOVERY_CAPSULES]: [...capsules]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, settings.recoveryCapsuleLimit)
  });
}
export const saveRecoveryCapsules = serializeMutation(saveRecoveryCapsulesUnqueued);

async function appendRecoveryCapsuleUnqueued(capsule: RecoveryCapsule): Promise<RecoveryCapsule[]> {
  const next = [capsule, ...(await getRecoveryCapsules()).filter(item => item.id !== capsule.id)];
  await saveRecoveryCapsulesUnqueued(next);
  return next;
}
export const appendRecoveryCapsule = serializeMutation(appendRecoveryCapsuleUnqueued);

async function markRecoveryCapsuleRestoredUnqueued(id: string): Promise<RecoveryCapsule | null> {
  const capsules = await getRecoveryCapsules();
  const capsule = capsules.find(item => item.id === id);
  if (!capsule) return null;
  await saveRecoveryCapsulesUnqueued(capsules.map(item => (item.id === id ? { ...item, restoredAt: Date.now() } : item)));
  return capsule;
}
export const markRecoveryCapsuleRestored = serializeMutation(markRecoveryCapsuleRestoredUnqueued);

async function deleteRecoveryCapsuleUnqueued(id: string): Promise<RecoveryCapsule[]> {
  const next = (await getRecoveryCapsules()).filter(item => item.id !== id);
  await saveRecoveryCapsulesUnqueued(next);
  return next;
}
export const deleteRecoveryCapsule = serializeMutation(deleteRecoveryCapsuleUnqueued);

export async function getSessionTimeline(): Promise<SessionTimelineSnapshot[]> {
  return (await getLocal(STORAGE_KEYS.SESSION_TIMELINE)) ?? [];
}

async function saveSessionTimelineUnqueued(snapshots: SessionTimelineSnapshot[]): Promise<void> {
  const settings = await getSettings();
  await setLocal({
    [STORAGE_KEYS.SESSION_TIMELINE]: [...snapshots]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, settings.timeMachineRetention)
  });
}
export const saveSessionTimeline = serializeMutation(saveSessionTimelineUnqueued);

async function appendSessionTimelineUnqueued(snapshot: SessionTimelineSnapshot): Promise<SessionTimelineSnapshot[]> {
  const existing = await getSessionTimeline();
  if (existing[0]?.signature === snapshot.signature) return existing;
  const next = [snapshot, ...existing];
  await saveSessionTimelineUnqueued(next);
  return next;
}
export const appendSessionTimeline = serializeMutation(appendSessionTimelineUnqueued);

async function deleteSessionTimelineSnapshotUnqueued(id: string): Promise<SessionTimelineSnapshot[]> {
  const next = (await getSessionTimeline()).filter(item => item.id !== id);
  await saveSessionTimelineUnqueued(next);
  return next;
}
export const deleteSessionTimelineSnapshot = serializeMutation(deleteSessionTimelineSnapshotUnqueued);

export async function getSessionTrash(now = Date.now()): Promise<TrashedSession[]> {
  return ((await getLocal(STORAGE_KEYS.SESSION_TRASH)) ?? []).filter(
    item => !Number.isFinite(item.expiresAt) || item.expiresAt > now
  );
}

async function saveSessionTrashUnqueued(items: TrashedSession[]): Promise<void> {
  await setLocal({
    [STORAGE_KEYS.SESSION_TRASH]: [...items].sort((a, b) => b.deletedAt - a.deletedAt).slice(0, 100)
  });
}
export const saveSessionTrash = serializeMutation(saveSessionTrashUnqueued);

async function moveSessionToTrashUnqueued(session: SavedSession): Promise<TrashedSession[]> {
  const trashItem: TrashedSession = {
    id: `trash-${session.id}-${Date.now()}`,
    deletedAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
    session
  };
  const next = [trashItem, ...(await getSessionTrash())];
  await saveSessionTrashUnqueued(next);
  return next;
}
export const moveSessionToTrash = serializeMutation(moveSessionToTrashUnqueued);

async function restoreSessionFromTrashUnqueued(trashId: string): Promise<SavedSession | null> {
  const trash = await getSessionTrash();
  const item = trash.find(entry => entry.id === trashId);
  if (!item) return null;
  const sessions = await getSessions();
  const restoredSession = sessions.some(session => session.id === item.session.id)
    ? { ...item.session, id: `session-${crypto.randomUUID()}`, name: `${item.session.name} (restored)` }
    : item.session;
  await appendSessionUnqueued(restoredSession);
  await saveSessionTrashUnqueued(trash.filter(entry => entry.id !== trashId));
  return restoredSession;
}
export const restoreSessionFromTrash = serializeMutation(restoreSessionFromTrashUnqueued);

async function permanentlyDeleteTrashedSessionUnqueued(trashId: string): Promise<TrashedSession[]> {
  const next = (await getSessionTrash()).filter(item => item.id !== trashId);
  await saveSessionTrashUnqueued(next);
  return next;
}
export const permanentlyDeleteTrashedSession = serializeMutation(permanentlyDeleteTrashedSessionUnqueued);

const EFFECT_HISTORY_RETENTION_MS = 24 * 60 * 60_000;

// Every scan appends a sample and loadAppState reads the whole list. Samples used to carry the full
// pressure, root-cause and power snapshots (about 2 KB each, up to 2,000 a day) that nothing reads.
function compactEffectHistoryEntry(entry: EffectHistoryEntry): EffectHistoryEntry {
  const { sampledAt, memoryAvailableRatio, level, cpuLevel } = entry.pressure;
  const { id, discardedCount, discardReason, estimatedFreedBytes, releaseStatus } = entry;
  return { id, sampledAt: entry.sampledAt, pressure: { sampledAt, memoryAvailableRatio, level, cpuLevel },
    discardedCount, discardReason, estimatedFreedBytes, releaseStatus };
}

export async function getEffectHistory(now = Date.now()): Promise<EffectHistoryEntry[]> {
  const history = (await getLocal(STORAGE_KEYS.EFFECT_HISTORY)) ?? [];
  return history.filter(item => now - item.sampledAt <= EFFECT_HISTORY_RETENTION_MS).map(compactEffectHistoryEntry);
}

async function appendEffectHistoryUnqueued(entry: EffectHistoryEntry): Promise<EffectHistoryEntry[]> {
  const next = [compactEffectHistoryEntry(entry), ...(await getEffectHistory())].slice(0, 2_000);
  await setLocal({ [STORAGE_KEYS.EFFECT_HISTORY]: next });
  return next;
}
export const appendEffectHistory = serializeMutation(appendEffectHistoryUnqueued);

export async function getSyncStatus(): Promise<SyncStatus | undefined> {
  return await getLocal(STORAGE_KEYS.SYNC_STATUS);
}

async function saveSyncStatusUnqueued(status: SyncStatus): Promise<void> {
  await setLocal({ [STORAGE_KEYS.SYNC_STATUS]: status });
}
export const saveSyncStatus = serializeMutation(saveSyncStatusUnqueued);

export async function getPowerState(): Promise<PowerStateSnapshot | undefined> {
  return await getSession(SESSION_KEYS.POWER_STATE);
}

async function savePowerStateUnqueued(state: PowerStateSnapshot): Promise<void> {
  await setSession({ [SESSION_KEYS.POWER_STATE]: state });
}
export const savePowerState = serializeMutation(savePowerStateUnqueued);

export async function getRootCauseAssessment(): Promise<PressureRootCauseAssessment | undefined> {
  return await getSession(SESSION_KEYS.ROOT_CAUSE_ASSESSMENT);
}

async function saveRootCauseAssessmentUnqueued(assessment: PressureRootCauseAssessment): Promise<void> {
  await setSession({ [SESSION_KEYS.ROOT_CAUSE_ASSESSMENT]: assessment });
}
export const saveRootCauseAssessment = serializeMutation(saveRootCauseAssessmentUnqueued);

export async function getInternalDiscardIntents(): Promise<InternalDiscardIntent[]> {
  return (await getSession(SESSION_KEYS.INTERNAL_DISCARD_INTENTS)) ?? [];
}

async function saveInternalDiscardIntentsUnqueued(intents: InternalDiscardIntent[]): Promise<void> {
  await setSession({ [SESSION_KEYS.INTERNAL_DISCARD_INTENTS]: intents });
}
export const saveInternalDiscardIntents = serializeMutation(saveInternalDiscardIntentsUnqueued);

async function updateInternalDiscardIntentsUnqueued(
  update: (intents: InternalDiscardIntent[]) => InternalDiscardIntent[]
): Promise<InternalDiscardIntent[]> {
  const next = update(await getInternalDiscardIntents());
  await saveInternalDiscardIntentsUnqueued(next);
  return next;
}
export const updateInternalDiscardIntents = serializeMutation(updateInternalDiscardIntentsUnqueued);

export async function getLastAutoMerge(): Promise<AutoMergeResult | undefined> {
  return await getSession(SESSION_KEYS.LAST_AUTO_MERGE);
}

async function saveLastAutoMergeUnqueued(result: AutoMergeResult): Promise<void> {
  await setSession({ [SESSION_KEYS.LAST_AUTO_MERGE]: result });
}
export const saveLastAutoMerge = serializeMutation(saveLastAutoMergeUnqueued);

export async function getWindowPolicies(): Promise<WindowPolicy[]> {
  return (await getLocal(STORAGE_KEYS.WINDOW_POLICIES)) ?? [];
}

async function saveWindowPoliciesUnqueued(policies: WindowPolicy[]): Promise<void> {
  await setLocal({ [STORAGE_KEYS.WINDOW_POLICIES]: policies });
}
export const saveWindowPolicies = serializeMutation(saveWindowPoliciesUnqueued);

async function pruneWindowPoliciesUnqueued(openWindowIds: Set<number>): Promise<WindowPolicy[]> {
  const next = (await getWindowPolicies()).filter(policy => openWindowIds.has(policy.windowId));
  await saveWindowPoliciesUnqueued(next);
  return next;
}
export const pruneWindowPolicies = serializeMutation(pruneWindowPoliciesUnqueued);

async function setWindowPolicyUnqueued(
  windowId: number,
  policyMode: PolicyMode | "inherit"
): Promise<WindowPolicy[]> {
  const policies = await getWindowPolicies();
  const next =
    policyMode === "inherit"
      ? policies.filter(policy => policy.windowId !== windowId)
      : [
          ...policies.filter(policy => policy.windowId !== windowId),
          {
            windowId,
            policyMode,
            updatedAt: Date.now()
          }
        ];
  await saveWindowPoliciesUnqueued(next);
  return next;
}
export const setWindowPolicy = serializeMutation(setWindowPolicyUnqueued);

export async function getSessions(): Promise<SavedSession[]> {
  return (await getLocal(STORAGE_KEYS.SESSIONS)) ?? [];
}

export async function getFocusSets(): Promise<SavedFocusSet[]> {
  return (await getLocal(STORAGE_KEYS.FOCUS_SETS)) ?? [];
}

async function saveFocusSetsUnqueued(sets: SavedFocusSet[]): Promise<void> {
  await setLocal({ [STORAGE_KEYS.FOCUS_SETS]: sets.slice(0, 20) });
}
export const saveFocusSets = serializeMutation(saveFocusSetsUnqueued);

async function appendFocusSetUnqueued(set: SavedFocusSet): Promise<SavedFocusSet[]> {
  const sets = [set, ...(await getFocusSets()).filter(existing => existing.id !== set.id)];
  await saveFocusSetsUnqueued(sets);
  return sets;
}
export const appendFocusSet = serializeMutation(appendFocusSetUnqueued);

async function deleteFocusSetUnqueued(setId: string): Promise<SavedFocusSet[]> {
  const sets = (await getFocusSets()).filter(set => set.id !== setId);
  await saveFocusSetsUnqueued(sets);
  return sets;
}
export const deleteFocusSet = serializeMutation(deleteFocusSetUnqueued);

async function saveSessionsUnqueued(sessions: SavedSession[]): Promise<void> {
  const settings = await getSettings();
  await setLocal({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, settings.keepSessionLimit) });
}
export const saveSessions = serializeMutation(saveSessionsUnqueued);

async function appendSessionUnqueued(session: SavedSession): Promise<SavedSession[]> {
  const sessions = [session, ...(await getSessions())];
  await saveSessionsUnqueued(sessions);
  return sessions;
}
export const appendSession = serializeMutation(appendSessionUnqueued);

export const mergeSessions = serializeMutation(async (incoming: SavedSession[]): Promise<SavedSession[]> => {
  const ids = new Set(incoming.map(session => session.id));
  const next = [...incoming, ...(await getSessions()).filter(session => !ids.has(session.id))];
  await saveSessionsUnqueued(next);
  return next;
});

async function deleteSessionUnqueued(sessionId: string): Promise<SavedSession[]> {
  const sessions = (await getSessions()).filter(session => session.id !== sessionId);
  await saveSessionsUnqueued(sessions);
  return sessions;
}
export const deleteSession = serializeMutation(deleteSessionUnqueued);

async function renameSessionUnqueued(sessionId: string, name: string): Promise<SavedSession[]> {
  const sessions = (await getSessions()).map(session => (session.id === sessionId ? { ...session, name } : session));
  await saveSessionsUnqueued(sessions);
  return sessions;
}
export const renameSession = serializeMutation(renameSessionUnqueued);

export async function getLastPressure(): Promise<PressureSnapshot | undefined> {
  return await getLocal(STORAGE_KEYS.LAST_PRESSURE);
}

async function saveLastPressureUnqueued(pressure: PressureSnapshot): Promise<void> {
  await setLocal({ [STORAGE_KEYS.LAST_PRESSURE]: pressure });
}
export const saveLastPressure = serializeMutation(saveLastPressureUnqueued);

export async function getWorkProtectionHolds(): Promise<WorkProtectionHold[]> {
  const value = await getSession(SESSION_KEYS.WORK_PROTECTION_HOLDS);
  const now = Date.now();
  return Array.isArray(value) ? value.filter(hold => hold && Number.isInteger(hold.tabId) &&
    typeof hold.url === "string" && Number.isFinite(hold.lastAccessed) && Number.isFinite(hold.checkedAt) &&
    hold.checkedAt <= now && hold.expiresAt > now && hold.expiresAt <= hold.checkedAt + 5 * 60_000 &&
    (hold.reason === "unsavedWork" || hold.reason === "workStateUnknown")).slice(-1000) : [];
}

// Only "keep loaded" decisions are cached. A selected-tab retry inspects again;
// automatic scans can move on to other tabs instead of retrying the same drafts.
export const saveWorkProtectionHold = serializeMutation(async (tab: chrome.tabs.Tab, reason: WorkProtectionHold["reason"] | null) => {
  if (tab.id == null) return;
  const current = (await getWorkProtectionHolds()).filter(hold => hold.tabId !== tab.id);
  if (reason && tab.url) {
    const checkedAt = Date.now();
    current.push({tabId:tab.id,url:tab.url,lastAccessed:tab.lastAccessed ?? 0,reason,checkedAt,expiresAt:checkedAt + 5 * 60_000});
  }
  await setSession({[SESSION_KEYS.WORK_PROTECTION_HOLDS]:current.slice(-1000)});
});

export async function loadAppState(): Promise<AppState> {
  const [
    settings,
    protectionRules,
    temporaryTabProtections,
    windowPolicies,
    discardLog,
    sessions,
    focusSets,
    lastPressure,
    focusModeEnabled,
    optimizedTabs,
    tabAccurateMetrics,
    lastMemoryRelease,
    lastDiscardSummary,
    powerState,
    rootCauseAssessment,
    discardLearning,
    externalDiscardObservations,
    recoveryCapsules,
    sessionTimeline,
    sessionTrash,
    effectHistory,
    lastAutoMerge,
    syncStatus,
    workProtectionHolds
  ] = await Promise.all([
    getSettings(),
    getProtectionRules(),
    getTemporaryTabProtections(),
    getWindowPolicies(),
    getDiscardLog(),
    getSessions(),
    getFocusSets(),
    getLastPressure(),
    getFocusModeEnabled(),
    getOptimizedTabs(),
    getTabAccurateMetrics(),
    getLastMemoryRelease(),
    getLastDiscardSummary(),
    getPowerState(),
    getRootCauseAssessment(),
    getDiscardLearning(),
    getExternalDiscardObservations(),
    getRecoveryCapsules(),
    getSessionTimeline(),
    getSessionTrash(),
    getEffectHistory(),
    getLastAutoMerge(),
    getSyncStatus(),
    getWorkProtectionHolds()
  ]);

  return {
    workProtectionHolds,
    automationPlan: await getSession(SESSION_KEYS.AUTOMATION_PLAN),
    settings,
    protectionRules,
    temporaryTabProtections,
    focusModeEnabled,
    focusSets,
    optimizedTabs,
    tabAccurateMetrics,
    windowPolicies,
    discardLog,
    sessions,
    lastPressure,
    lastMemoryRelease,
    lastDiscardSummary,
    powerState,
    rootCauseAssessment,
    discardLearning,
    externalDiscardObservations,
    recoveryCapsules,
    sessionTimeline,
    sessionTrash,
    effectHistory,
    lastAutoMerge,
    syncStatus
  };
}

async function ensureStorageDefaultsUnqueued(): Promise<void> {
  const result = (await chrome.storage.local.get(null)) as LocalStorageShape;
  const updates: LocalStorageShape = {};

  updates[STORAGE_KEYS.SETTINGS] = normalizeSettings(result[STORAGE_KEYS.SETTINGS]);

  if (!Array.isArray(result[STORAGE_KEYS.PROTECTION_RULES])) {
    updates[STORAGE_KEYS.PROTECTION_RULES] = DEFAULT_PROTECTION_RULES;
  }

  if (!Array.isArray(result[STORAGE_KEYS.WINDOW_POLICIES])) {
    updates[STORAGE_KEYS.WINDOW_POLICIES] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.DISCARD_LOG])) {
    updates[STORAGE_KEYS.DISCARD_LOG] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.SESSIONS])) {
    updates[STORAGE_KEYS.SESSIONS] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.FOCUS_SETS])) {
    updates[STORAGE_KEYS.FOCUS_SETS] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.DISCARD_LEARNING])) {
    updates[STORAGE_KEYS.DISCARD_LEARNING] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.EXTERNAL_DISCARD_OBSERVATIONS])) {
    updates[STORAGE_KEYS.EXTERNAL_DISCARD_OBSERVATIONS] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.RECOVERY_CAPSULES])) {
    updates[STORAGE_KEYS.RECOVERY_CAPSULES] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.SESSION_TIMELINE])) {
    updates[STORAGE_KEYS.SESSION_TIMELINE] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.SESSION_TRASH])) {
    updates[STORAGE_KEYS.SESSION_TRASH] = [];
  }

  if (!Array.isArray(result[STORAGE_KEYS.EFFECT_HISTORY])) {
    updates[STORAGE_KEYS.EFFECT_HISTORY] = [];
  }

  if (!result[STORAGE_KEYS.SYNC_STATUS]) {
    updates[STORAGE_KEYS.SYNC_STATUS] = {
      enabled: updates[STORAGE_KEYS.SETTINGS]?.syncEnabled ?? false,
      sections: []
    };
  }

  await setLocal(updates);
  // Write before removing so interrupted upgrades can be retried without losing tab state.
  const session = await chrome.storage.session.get([SESSION_KEYS.PAGE_OPTIMIZED_TABS, LEGACY_NAMES.optimizedTabs]);
  if (Object.hasOwn(session, LEGACY_NAMES.optimizedTabs)) {
    if (!Object.hasOwn(session, SESSION_KEYS.PAGE_OPTIMIZED_TABS)) {
      await chrome.storage.session.set({ [SESSION_KEYS.PAGE_OPTIMIZED_TABS]: session[LEGACY_NAMES.optimizedTabs] });
    }
    await chrome.storage.session.remove(LEGACY_NAMES.optimizedTabs);
  }
}
export const ensureStorageDefaults = serializeMutation(ensureStorageDefaultsUnqueued);

async function saveAutomationPlanUnqueued(plan: AutomationPlan): Promise<void> {
  await setSession({ [SESSION_KEYS.AUTOMATION_PLAN]: plan });
}
export const saveAutomationPlan = serializeMutation(saveAutomationPlanUnqueued);
