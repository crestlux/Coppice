import {
  exactUrlPattern,
  getHostname,
  isDomainMatch,
  isHttpUrl,
  matchesProtectedDomain,
  wildcardToRegExp
} from "../shared/url";
import { isDuplicateProtectionRule, normalizeProtectionRuleValue } from "../shared/protectionRules";
import { randomId } from "../shared/chromeAsync";
import { SCAN_ALARM_NAME } from "../shared/constants";
import type { AppMessage, AppResponse } from "../shared/messages";
import type {
  CurrentTabProtectionStatus,
  DiscardLogEntry,
  FocusSetApplyResult,
  ProtectionRule,
  SavedFocusSet,
  Settings,
  TabFocusToggleResult,
  TabProtectionToggleResult,
  UnprotectTabResult
} from "../shared/types";
import {
  addProtectionRule,
  appendFocusSet,
  clearRuleTemporaryTabProtection,
  clearFocusTabProtections,
  clearDiscardLog,
  appendExternalDiscardObservation,
  deleteRecoveryCapsule,
  deleteSessionTimelineSnapshot,
  getFocusModeEnabled,
  getFocusSets,
  getProtectionRules,
  getTemporaryTabProtections,
  isFocusProtection,
  loadAppState,
  markDiscardLogReactivated,
  markDiscardLogUndone,
  deleteFocusSet as removeFocusSet,
  removeOptimizedTab,
  clearOptimizerTabPause,
  removeTabAccurateMetric,
  removeTemporaryTabProtection,
  removeTemporaryTabProtectionsByRuleIds,
  redactDiscardLogMetadata,
  permanentlyDeleteTrashedSession,
  restoreSessionFromTrash,
  updateProtectionRules,
  saveFocusModeEnabled,
  updateInternalDiscardIntents,
  replaceDiscardLogTabId,
  saveLastAutoMerge,
  pruneWindowPolicies,
  setTemporaryTabProtection,
  setWindowPolicy,
  upsertDiscardLearning,
  updateSettings
} from "../shared/storage";
import { syncDnrRules } from "./dnr";
import { reconcileWorkProtection } from "./workProtection";
import { ensureScanAlarm, initializeExtension, runSerializedScan } from "./init";
import {
  closeDiscardedTabs,
  closeFrozenTabs,
  closeTab,
  closeDuplicateTabs,
  collectScanEvaluation,
  discardTabNow,
  discardCurrentDomainBackgroundTabs,
  discardTabsOlderThan,
  previewDuplicateTabsForCurrentBrowser,
  exactDuplicateTabKey,
  selectExistingDuplicateTab,
  refreshStatus,
  runFocusCleanup,
  simulatePolicy
} from "./scanner";
import {
  checkActiveTabLeak,
  getAccurateModeStatus,
  measureActiveTabAccurately,
  measureOpenTabsAccurately
} from "./accurateMode";
import {
  getExperimentalOptimizerStatus,
  reconcileExperimentalOptimizerSettings,
  removeAllExperimentalOptimizerCss,
  resetExperimentalOptimizer,
  setActiveTabOptimizer,
  setAllSitesOptimizer,
  setCurrentSiteOptimizer,
  setExperimentalOptimizerEnabled,
  setExperimentalOptimizerItemEnabled,
  syncExperimentalOptimizerForTab
} from "./optimizer";
import {
  importSessions,
  removeSession,
  restoreSession,
  saveCurrentGroupAndClose,
  saveCurrentWindowAndClose,
  saveSelectedTabsAndClose,
  updateSessionName
} from "./sessions";
import { classifyDiscardEvent, computeDiscardLearningAdjustment } from "./resourceIntelligence";
import {
  captureRecoveryCapsule,
  captureTimelineSnapshot,
  restoreRecoveryCapsule,
  restoreTimelineSnapshot
} from "./recovery";
import { getThresholdForPolicyMode } from "../shared/policyPresets";
import { updateBadge } from "./badge";
import { buildEffectReport24h } from "./analytics";
import {
  exportFullBackup,
  importFullBackup,
  pullSelectiveSync,
  pushSelectiveSync,
  scheduleAutomaticSync,
  scheduleRemoteSyncPull
} from "./portability";
import { isAutoMergeSuppressed, withAutoMergeSuppressed } from "./autoMergeGuard";
import { checkTabCloseSafety } from "./sessionSafety";

async function getWindowSummaries() {
  const state = await loadAppState();
  const tabs = await chrome.tabs.query({});
  const byWindow = new Map<number, chrome.tabs.Tab[]>();

  for (const tab of tabs) {
    byWindow.set(tab.windowId, [...(byWindow.get(tab.windowId) ?? []), tab]);
  }

  const openWindowIds = new Set(byWindow.keys());
  const activePolicies = state.windowPolicies.filter(policy => openWindowIds.has(policy.windowId));
  if (activePolicies.length !== state.windowPolicies.length) {
    await pruneWindowPolicies(openWindowIds);
  }

  return [...byWindow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([windowId, windowTabs]) => {
      const activeTab = windowTabs.find(tab => tab.active) ?? windowTabs[0];
      const windowPolicy = state.windowPolicies.find(policy => policy.windowId === windowId);
      return {
        windowId,
        tabCount: windowTabs.length,
        activeTitle: activeTab?.title,
        activeDomain: getHostname(activeTab?.url) ?? undefined,
        policyMode: windowPolicy?.policyMode ?? "inherit"
      };
    });
}

async function loadRuntimeAppState() {
  const [evaluation, windowSummaries] = await Promise.all([collectScanEvaluation("periodic"), getWindowSummaries()]);
  return {
    ...evaluation.state,
    lastPressure: evaluation.pressure,
    windowSummaries
  };
}

async function getPopupState() {
  const [evaluation, accurateMode, currentTabProtection, experimentalOptimizerStatus] = await Promise.all([
    collectScanEvaluation("manual"),
    getAccurateModeStatus(),
    getCurrentTabProtectionStatus(),
    getExperimentalOptimizerStatus()
  ]);

  return {
    ...evaluation,
    accurateMode,
    currentTabProtection,
    experimentalOptimizerStatus
  };
}

// This is only an in-flight lock, not persisted application state. Concurrent
// messages from separate popups/settings pages must not reopen the same tabs.
let tabRestoreInFlight = false;
async function runTabRestore<T>(action: () => Promise<T>): Promise<T> {
  if (tabRestoreInFlight) throw new Error("A tab restore is already in progress. Wait for it to finish before restoring again.");
  tabRestoreInFlight = true;
  try {
    return await action();
  } finally {
    tabRestoreInFlight = false;
  }
}

// Quick Undo brings back the newest tab Coppice unloaded that is still open and still unloaded.
// Reopening pages closed long ago from an old log would surprise people; the Settings log can
// still reopen any entry by id.
async function latestUndoableEntry(log: DiscardLogEntry[]): Promise<DiscardLogEntry | undefined> {
  const unloaded = new Map((await chrome.tabs.query({ discarded: true })).map(tab => [tab.id, tab.url]));
  return log.find(item => !item.undoneAt && !item.reactivatedAt && unloaded.has(item.tabId) &&
    (!item.url || unloaded.get(item.tabId) === item.url));
}

async function undoDiscard(entryId?: string): Promise<boolean> {
  const state = await loadAppState();
  const entry = entryId
    ? state.discardLog.find(item => item.id === entryId)
    : await latestUndoableEntry(state.discardLog);

  if (!entry) {
    throw new Error("Nothing to undo yet.");
  }
  if (entry.undoneAt) {
    throw new Error("That tab has already been reloaded.");
  }

  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(entry.tabId);
  } catch {
    tab = null;
  }

  const sameDocumentUrl = tab && entry.url && tab.url === entry.url && !tab.pendingUrl;
  if (tab && sameDocumentUrl) {
    if (typeof tab.windowId === "number") {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (error) {
        console.warn("Failed to focus discard window", error);
      }
    }
    // Chrome reloads a discarded tab on activation. Reloading a live tab here
    // can destroy edits made after its original discard, even at the same URL.
    await chrome.tabs.update(entry.tabId, { active: true });
  } else {
    if (!entry.url) {
      throw new Error("Can’t reopen this tab: Privacy mode didn’t keep its address.");
    }
    if (!isHttpUrl(entry.url)) throw new Error("Can’t reopen this tab: its address isn’t a web page.");
    await withAutoMergeSuppressed(async () => {
      let windowId: number | undefined;
      try { windowId = (await chrome.windows.get(entry.windowId)).id; } catch { /* Original window closed. */ }
      await chrome.tabs.create({ ...(windowId != null ? { windowId } : {}), url: entry.url, active: true });
    });
  }

  await markDiscardLogUndone(entry.id);
  await updateDiscardLearningForEntry(entry.id);
  return true;
}

async function getCurrentHttpTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url || typeof tab.id !== "number" || !isHttpUrl(tab.url)) {
    throw new Error("No active HTTP tab");
  }
  return tab;
}

async function getHttpTabById(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || typeof tab.id !== "number" || !isHttpUrl(tab.url)) {
    throw new Error("No HTTP tab to protect");
  }
  return tab;
}

async function getTabById(tabId: number): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await chrome.tabs.get(tabId);
  if (typeof tab.id !== "number") {
    throw new Error("No tab to protect");
  }
  return tab as chrome.tabs.Tab & { id: number };
}

async function addCurrentTabRule(): Promise<ProtectionRule> {
  const tab = await getCurrentHttpTab();
  const rules = await getProtectionRules();
  const value = normalizeProtectionRuleValue("urlPattern", exactUrlPattern(tab.url as string));

  if (isDuplicateProtectionRule(rules, "urlPattern", value)) {
    throw new Error("Protection rule already exists");
  }

  const rule: ProtectionRule = {
    id: randomId("rule"),
    type: "urlPattern",
    value,
    source: "user",
    enabled: true,
    createdAt: Date.now()
  };
  await addProtectionRule(rule);
  return rule;
}

function exactCurrentTabRule(rules: ProtectionRule[], tabUrl: string): ProtectionRule | undefined {
  const value = normalizeProtectionRuleValue("urlPattern", exactUrlPattern(tabUrl));
  return rules.find(rule => rule.type === "urlPattern" && rule.value.toLowerCase() === value.toLowerCase());
}

function currentUrlPatternRule(rules: ProtectionRule[], tabUrl: string): ProtectionRule | undefined {
  const exactRule = exactCurrentTabRule(rules, tabUrl);
  if (exactRule?.enabled) return exactRule;

  return matchingUrlPatternRules(rules, tabUrl)[0];
}

function matchingUrlPatternRules(rules: ProtectionRule[], tabUrl: string): ProtectionRule[] {
  return rules
    .filter(rule => {
      if (!rule.enabled || rule.type !== "urlPattern") return false;
      try {
        return wildcardToRegExp(rule.value).test(tabUrl);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.value.length - a.value.length);
}

function exactCurrentDomainRule(rules: ProtectionRule[], domain: string): ProtectionRule | undefined {
  const value = normalizeProtectionRuleValue("domain", domain);
  return rules.find(rule => rule.type === "domain" && rule.value.toLowerCase() === value.toLowerCase());
}

function currentDomainRule(rules: ProtectionRule[], domain: string): ProtectionRule | undefined {
  return matchingDomainRules(rules, domain)[0];
}

function matchingDomainRules(rules: ProtectionRule[], domain: string): ProtectionRule[] {
  return rules
    .filter(rule => rule.enabled && rule.type === "domain" && isDomainMatch(domain, rule.value))
    .sort((a, b) => b.value.length - a.value.length);
}

function matchingProtectionRulesForUrl(rules: ProtectionRule[], tabUrl: string): ProtectionRule[] {
  const domain = getHostname(tabUrl);
  return [
    ...matchingUrlPatternRules(rules, tabUrl),
    ...(domain ? matchingDomainRules(rules, domain) : [])
  ];
}

async function getCurrentTabProtectionStatus(): Promise<CurrentTabProtectionStatus> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await getCurrentHttpTab();
  } catch {
    return {
      canToggle: false,
      exactTabProtected: false,
      protectedByDomain: false,
      protectedByUrlPattern: false
    };
  }

  const rules = await getProtectionRules();
  const exactRule = exactCurrentTabRule(rules, tab.url as string);
  const urlPatternRule = currentUrlPatternRule(rules, tab.url as string);
  const domain = getHostname(tab.url) ?? undefined;
  const domainRule = domain ? currentDomainRule(rules, domain) : undefined;
  const protectedByDomain = domain ? matchesProtectedDomain(domain, rules) : false;
  const protectedByUrlPattern = Boolean(urlPatternRule);

  return {
    canToggle: true,
    exactTabProtected: Boolean(exactRule?.enabled),
    protectedByDomain,
    protectedByUrlPattern,
    ruleId: exactRule?.id,
    domainRuleId: domainRule?.id,
    urlPatternRuleId: urlPatternRule?.id,
    url: tab.url,
    domain,
    title: tab.title
  };
}

async function toggleCurrentTabProtection(): Promise<CurrentTabProtectionStatus> {
  const tab = await getCurrentHttpTab();
  const rules = await getProtectionRules();
  const exactRule = exactCurrentTabRule(rules, tab.url as string);
  const urlPatternRule = currentUrlPatternRule(rules, tab.url as string);

  if (urlPatternRule?.enabled) {
    await updateProtectionRules(current => current.filter(rule => rule.id !== urlPatternRule.id));
    await removeTemporaryTabProtectionsByRuleIds([urlPatternRule.id]);
    return getCurrentTabProtectionStatus();
  }

  if (exactRule && !exactRule.enabled) {
    await updateProtectionRules(current => current.map(rule => (rule.id === exactRule.id ? { ...rule, enabled: true } : rule)));
    return getCurrentTabProtectionStatus();
  }

  await addCurrentTabRule();
  return getCurrentTabProtectionStatus();
}

async function addCurrentDomainRule(): Promise<ProtectionRule> {
  const tab = await getCurrentHttpTab();
  const domain = getHostname(tab.url);
  if (!domain) throw new Error("Active tab has no domain");
  const rules = await getProtectionRules();
  const value = normalizeProtectionRuleValue("domain", domain);

  if (isDuplicateProtectionRule(rules, "domain", value)) {
    throw new Error("Protection rule already exists");
  }

  const rule: ProtectionRule = {
    id: randomId("rule"),
    type: "domain",
    value,
    source: "user",
    enabled: true,
    createdAt: Date.now()
  };
  await addProtectionRule(rule);
  return rule;
}

async function toggleCurrentDomainProtection(): Promise<CurrentTabProtectionStatus> {
  const tab = await getCurrentHttpTab();
  const domain = getHostname(tab.url);
  if (!domain) throw new Error("Active tab has no domain");

  const rules = await getProtectionRules();
  const domainRule = currentDomainRule(rules, domain);
  const exactRule = exactCurrentDomainRule(rules, domain);

  if (domainRule?.enabled) {
    await updateProtectionRules(current => current.filter(rule => rule.id !== domainRule.id));
    await removeTemporaryTabProtectionsByRuleIds([domainRule.id]);
    return getCurrentTabProtectionStatus();
  }

  if (exactRule && !exactRule.enabled) {
    await updateProtectionRules(current => current.map(rule => (rule.id === exactRule.id ? { ...rule, enabled: true } : rule)));
    return getCurrentTabProtectionStatus();
  }

  await addCurrentDomainRule();
  return getCurrentTabProtectionStatus();
}

async function unprotectTab(tabId: number): Promise<UnprotectTabResult> {
  const tab = await getHttpTabById(tabId);
  const tabUrl = tab.url as string;

  const rules = await getProtectionRules();
  const matchingRules = matchingProtectionRulesForUrl(rules, tabUrl);
  const removedRuleIds = [...new Set(matchingRules.map(rule => rule.id))];

  if (removedRuleIds.length === 0) {
    throw new Error("This tab is protected by policy or Chrome, not by a protection rule.");
  }

  const removedRuleSet = new Set(removedRuleIds);
  await updateProtectionRules(current => current.filter(rule => !removedRuleSet.has(rule.id)));
  await removeTemporaryTabProtectionsByRuleIds(removedRuleIds);

  return {
    tabId,
    removedRuleIds,
    removedCount: removedRuleIds.length
  };
}

async function setTabProtection(tabId: number, protectedTab: boolean): Promise<TabProtectionToggleResult> {
  const tab = await getTabById(tabId);
  const rules = await getProtectionRules();
  const matchingRules = tab.url && isHttpUrl(tab.url) ? matchingProtectionRulesForUrl(rules, tab.url) : [];
  const permanentRuleIds = [...new Set(matchingRules.map(rule => rule.id))];
  const permanentlyProtected = permanentRuleIds.length > 0;
  const existingTemporary = (await getTemporaryTabProtections()).find(protection => protection.tabId === tabId);
  const focused = existingTemporary ? isFocusProtection(existingTemporary) : false;

  if (!protectedTab) {
    if (existingTemporary?.source === "user" && focused) {
      await setTemporaryTabProtection({
        tabId,
        windowId: tab.windowId,
        createdAt: existingTemporary.createdAt,
        source: "focus",
        focus: true,
        focusedAt: existingTemporary.focusedAt ?? existingTemporary.createdAt,
        url: tab.url,
        title: tab.title
      });
    } else if (existingTemporary?.source === "user") {
      await removeTemporaryTabProtection(tabId);
    }
    return {
      tabId,
      protected: permanentlyProtected || focused,
      temporary: false,
      changed: existingTemporary?.source === "user"
    };
  }

  if (existingTemporary?.source === "user") {
    return {
      tabId,
      protected: true,
      temporary: true,
      changed: false
    };
  }

  if (permanentlyProtected) {
    await setTemporaryTabProtection({
      tabId,
      windowId: tab.windowId,
      createdAt: existingTemporary?.createdAt ?? Date.now(),
      source: "rule",
      ruleIds: permanentRuleIds,
      focus: focused || undefined,
      focusedAt: focused ? existingTemporary?.focusedAt ?? existingTemporary?.createdAt ?? Date.now() : undefined,
      url: tab.url,
      title: tab.title
    });
    return {
      tabId,
      protected: true,
      temporary: false,
      changed: !existingTemporary
    };
  }

  if (!tab.url || !isHttpUrl(tab.url)) {
    throw new Error("Only HTTP and HTTPS tabs can be whitelisted.");
  }

  await setTemporaryTabProtection({
    tabId,
    windowId: tab.windowId,
    createdAt: existingTemporary?.createdAt ?? Date.now(),
    source: "user",
    focus: focused || undefined,
    focusedAt: focused ? existingTemporary?.focusedAt ?? existingTemporary?.createdAt ?? Date.now() : undefined,
    url: tab.url,
    title: tab.title
  });

  return {
    tabId,
    protected: true,
    temporary: true,
    changed: true
  };
}

function countFocusProtections(protections: Awaited<ReturnType<typeof getTemporaryTabProtections>>): number {
  return protections.filter(isFocusProtection).length;
}

async function setFocusMode(enabled: boolean) {
  await saveFocusModeEnabled(enabled);
  if (!enabled) {
    await clearFocusTabProtections();
  }
  await refreshStatus("periodic");
  return loadRuntimeAppState();
}

async function setTabFocus(tabId: number, focused: boolean): Promise<TabFocusToggleResult> {
  const focusModeEnabled = await getFocusModeEnabled();
  if (!focusModeEnabled) {
    throw new Error("Turn on Focus Mode before choosing focus tabs.");
  }

  const tab = await getTabById(tabId);
  if (focused && (!tab.url || !isHttpUrl(tab.url))) {
    throw new Error("Only HTTP and HTTPS tabs can be focus targets.");
  }
  if (tab.discarded && focused) {
    throw new Error("Unloaded tabs can’t be focus targets until they reload.");
  }

  const protections = await getTemporaryTabProtections();
  const existing = protections.find(protection => protection.tabId === tabId);
  const wasFocused = existing ? isFocusProtection(existing) : false;
  let nextProtections = protections;

  if (focused) {
    await setTemporaryTabProtection({
      tabId,
      windowId: tab.windowId,
      createdAt: existing?.createdAt ?? Date.now(),
      source: existing && existing.source !== "focus" ? existing.source : "focus",
      ruleIds: existing?.ruleIds,
      focus: true,
      focusedAt: existing?.focusedAt ?? Date.now(),
      url: tab.url,
      title: tab.title
    });
    nextProtections = await getTemporaryTabProtections();
    const cleanup = await runFocusCleanup();
    nextProtections = cleanup.state.temporaryTabProtections;

    return {
      tabId,
      focused,
      focusModeEnabled,
      changed: wasFocused !== focused,
      activeFocusCount: countFocusProtections(nextProtections),
      cleanupDiscardedCount: cleanup.discardedCount,
      cleanupEligibleCount: cleanup.eligibleCount
    };
  } else if (existing && wasFocused) {
    if (existing.source === "focus") {
      nextProtections = await removeTemporaryTabProtection(tabId);
    } else {
      await setTemporaryTabProtection({
        ...existing,
        focus: undefined,
        focusedAt: undefined,
        url: tab.url,
        title: tab.title
      });
      nextProtections = await getTemporaryTabProtections();
    }
  }

  return {
    tabId,
    focused,
    focusModeEnabled,
    changed: wasFocused !== focused,
    activeFocusCount: countFocusProtections(nextProtections),
    cleanupDiscardedCount: 0,
    cleanupEligibleCount: 0
  };
}

async function saveCurrentFocusSet(name?: string): Promise<SavedFocusSet> {
  const [protections, tabs] = await Promise.all([getTemporaryTabProtections(), chrome.tabs.query({})]);
  const focusedIds = new Set(protections.filter(isFocusProtection).map(protection => protection.tabId));
  const focusTabs = tabs
    .filter(
      (tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
        typeof tab.id === "number" && Boolean(tab.url && isHttpUrl(tab.url)) && focusedIds.has(tab.id)
    )
    .map(tab => ({
      url: tab.url,
      title: tab.title,
      domain: getHostname(tab.url) ?? undefined
    }));
  const uniqueTabs = [...new Map(focusTabs.map(tab => [tab.url, tab])).values()];

  if (uniqueTabs.length === 0) throw new Error("Choose at least one Focus tab before saving a set.");

  const cleanName = name?.trim().slice(0, 80);
  const set: SavedFocusSet = {
    id: randomId("focus"),
    name: cleanName || `Focus set ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    tabs: uniqueTabs
  };
  await appendFocusSet(set);
  return set;
}

async function applyFocusSet(setId: string): Promise<FocusSetApplyResult> {
  const set = (await getFocusSets()).find(candidate => candidate.id === setId);
  if (!set) throw new Error("Saved Focus set not found.");

  const tabs = await chrome.tabs.query({});
  const openByUrl = new Map<string, chrome.tabs.Tab[]>();
  for (const tab of tabs) {
    if (!tab.url || typeof tab.id !== "number" || !isHttpUrl(tab.url) || tab.discarded) continue;
    openByUrl.set(tab.url, [...(openByUrl.get(tab.url) ?? []), tab]);
  }

  const matchingTabs = set.tabs.flatMap(saved => openByUrl.get(saved.url) ?? []);
  const uniqueMatchingTabs = [...new Map(matchingTabs.map(tab => [tab.id, tab])).values()];
  if (uniqueMatchingTabs.length === 0) {
    throw new Error("None of the saved Focus tabs are currently open.");
  }

  await clearFocusTabProtections();
  await saveFocusModeEnabled(true);
  for (const tab of uniqueMatchingTabs) {
    if (typeof tab.id !== "number" || !tab.url) continue;
    const existing = (await getTemporaryTabProtections()).find(protection => protection.tabId === tab.id);
    await setTemporaryTabProtection({
      tabId: tab.id,
      windowId: tab.windowId,
      createdAt: existing?.createdAt ?? Date.now(),
      source: existing && existing.source !== "focus" ? existing.source : "focus",
      ruleIds: existing?.ruleIds,
      focus: true,
      focusedAt: Date.now(),
      url: tab.url,
      title: tab.title
    });
  }

  const cleanup = await runFocusCleanup();
  const matchedUrls = new Set(uniqueMatchingTabs.map(tab => tab.url));
  return {
    setId,
    matchedCount: uniqueMatchingTabs.length,
    missingCount: set.tabs.filter(tab => !matchedUrls.has(tab.url)).length,
    cleanupDiscardedCount: cleanup.discardedCount,
    cleanupEligibleCount: cleanup.eligibleCount
  };
}

async function currentHttpDomain(): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await getCurrentHttpTab();
  } catch {
    throw new Error("Active HTTP or HTTPS tab required.");
  }
  const domain = getHostname(tab.url);
  if (!domain) throw new Error("Active HTTP or HTTPS tab required.");
  return domain;
}

async function setCurrentDomainDiscardRule(inactiveMinutes: number): Promise<Settings> {
  if (!Number.isFinite(inactiveMinutes) || inactiveMinutes < 1 || inactiveMinutes > 43_200) {
    throw new Error("Inactive minutes must be between 1 and 43200.");
  }
  const [domain, settings] = await Promise.all([currentHttpDomain(), loadAppState().then(state => state.settings)]);
  return updateSettings({
    domainDiscardRules: [
      {
        domain,
        inactiveMinutes: Math.round(inactiveMinutes),
        createdAt: Date.now()
      },
      ...settings.domainDiscardRules.filter(rule => rule.domain !== domain)
    ]
  });
}

async function removeCurrentDomainDiscardRule(): Promise<Settings> {
  const [domain, settings] = await Promise.all([currentHttpDomain(), loadAppState().then(state => state.settings)]);
  return updateSettings({
    domainDiscardRules: settings.domainDiscardRules.filter(rule => rule.domain !== domain)
  });
}

let focusRefreshPromise: Promise<void> | null = null;
let focusRefreshQueued = false;
let statusRefreshPromise: Promise<void> | null = null;
let statusRefreshQueued = false;

async function refreshStatusCoalesced(): Promise<void> {
  if (statusRefreshPromise) {
    statusRefreshQueued = true;
    return statusRefreshPromise;
  }
  statusRefreshPromise = (async () => {
    do {
      statusRefreshQueued = false;
      await refreshStatus("periodic");
    } while (statusRefreshQueued);
  })().finally(() => {
    statusRefreshPromise = null;
  });
  return statusRefreshPromise;
}

async function refreshOrRunFocusCleanup(): Promise<void> {
  if (focusRefreshPromise) {
    focusRefreshQueued = true;
    return focusRefreshPromise;
  }

  focusRefreshPromise = (async () => {
    do {
      focusRefreshQueued = false;
      const state = await loadAppState();
      const hasFocusTargets = state.focusModeEnabled && state.temporaryTabProtections.some(isFocusProtection);
      if (hasFocusTargets) {
        await runFocusCleanup();
      } else {
        await refreshStatus("periodic");
      }
    } while (focusRefreshQueued);
  })().finally(() => {
    focusRefreshPromise = null;
  });

  return focusRefreshPromise;
}

function containsPolicyModePatch(patch: Partial<Settings>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, "policyMode");
}

export async function rememberRuleProtectionForTab(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") return;
  if (!tab.url || !isHttpUrl(tab.url)) {
    await clearRuleTemporaryTabProtection(tab.id);
    return;
  }

  const rules = await getProtectionRules();
  const matchingRules = matchingProtectionRulesForUrl(rules, tab.url);
  const ruleIds = [...new Set(matchingRules.map(rule => rule.id))];
  if (ruleIds.length === 0) {
    await clearRuleTemporaryTabProtection(tab.id);
    return;
  }

  const existingTemporary = (await getTemporaryTabProtections()).find(protection => protection.tabId === tab.id);
  if (existingTemporary?.source === "user") return;
  const focused = existingTemporary ? isFocusProtection(existingTemporary) : false;

  await setTemporaryTabProtection({
    tabId: tab.id,
    windowId: tab.windowId,
    createdAt: existingTemporary?.createdAt ?? Date.now(),
    source: "rule",
    ruleIds,
    focus: focused || undefined,
    focusedAt: focused ? existingTemporary?.focusedAt ?? existingTemporary?.createdAt ?? Date.now() : undefined,
    url: tab.url,
    title: tab.title
  });
}

async function createProtectionRule(ruleType: ProtectionRule["type"], value: string): Promise<ProtectionRule> {
  const cleanValue = normalizeProtectionRuleValue(ruleType, value);
  const rules = await getProtectionRules();

  if (isDuplicateProtectionRule(rules, ruleType, cleanValue)) {
    throw new Error("Protection rule already exists");
  }

  const rule: ProtectionRule = {
    id: randomId("rule"),
    type: ruleType,
    value: cleanValue,
    source: "user",
    enabled: true,
    createdAt: Date.now()
  };

  await addProtectionRule(rule);
  return rule;
}

async function setProtectionRuleEnabled(ruleId: string, enabled: boolean): Promise<ProtectionRule[]> {
  const next = await updateProtectionRules(rules => rules.map(rule => (rule.id === ruleId ? { ...rule, enabled } : rule)));
  if (!enabled) {
    await removeTemporaryTabProtectionsByRuleIds([ruleId]);
  }
  return next;
}

async function deleteProtectionRule(ruleId: string): Promise<ProtectionRule[]> {
  const next = await updateProtectionRules(rules => rules.filter(rule => rule.id !== ruleId));
  await removeTemporaryTabProtectionsByRuleIds([ruleId]);
  return next;
}

async function updateDiscardLearningForEntry(entryId: string): Promise<void> {
  const state = await loadAppState();
  if (!state.settings.discardLearningEnabled) return;
  const entry = state.discardLog.find(item => item.id === entryId);
  if (!entry?.domain) return;

  const baseInactiveMinutes = getThresholdForPolicyMode(state.settings) ?? state.settings.balancedMinutes;
  const adjustment = computeDiscardLearningAdjustment({
    events: state.discardLog,
    now: Date.now(),
    baseScore: baseInactiveMinutes,
    baseInactiveMinutes,
    scope: { domain: entry.domain },
    options: { quickReactivationWindowMs: state.settings.quickReactivateMinutes * 60_000 }
  });
  await upsertDiscardLearning({
    domain: entry.domain,
    observedCount: adjustment.observedCount,
    effectiveSampleCount: adjustment.effectiveSampleCount,
    weightedQuickRate: adjustment.weightedQuickRate,
    confidence: adjustment.confidence,
    risk: adjustment.risk,
    quickReactivations: adjustment.quickReactivationCount,
    undoCount: adjustment.quickUndoCount,
    lastFeedbackAt: Date.now(),
    thresholdPenaltyMinutes: Math.max(0, Math.round(adjustment.adjustedInactiveMinutes - baseInactiveMinutes))
  });
}

async function learnFromTabActivation(tabId: number): Promise<void> {
  const state = await loadAppState();
  if (!state.settings.discardLearningEnabled) return;
  const now = Date.now();
  const windowMs = state.settings.quickReactivateMinutes * 60_000;
  const entry = state.discardLog.find(
    item => item.tabId === tabId && !item.reactivatedAt && now - item.discardedAt >= 0 && now - item.discardedAt <= windowMs
  );
  if (!entry) return;
  await markDiscardLogReactivated(entry.id, now);
  await updateDiscardLearningForEntry(entry.id);
}

let discardObservationQueue: Promise<void> = Promise.resolve();

function observeDiscardTransition(tabId: number, discarded: boolean, tab: chrome.tabs.Tab): Promise<void> {
  const operation = discardObservationQueue.then(async () => {
  if (!discarded) return;
  const observedAt = Date.now();
  let classification!: ReturnType<typeof classifyDiscardEvent>;
  await updateInternalDiscardIntents(ledger => {
    classification = classifyDiscardEvent({ tabId, observedAt, discarded, ledger });
    return classification.remainingLedger;
  });
  if (classification.source !== "externalOrNative") return;
  await appendExternalDiscardObservation({
    id: `external-discard-${crypto.randomUUID()}`,
    tabId,
    windowId: tab.windowId,
    domain: getHostname(tab.url) ?? undefined,
    observedAt,
    source: "chromeOrOtherExtension"
  });
  });
  discardObservationQueue = operation.catch(() => undefined);
  return operation;
}

// Chrome replaces a tab with a new id when it unloads (and often when it reloads). The replacement is
// queued ahead of the discard event it precedes, so Coppice's own unloads are not mistaken for
// Chrome Memory Saver or another extension, and Undo still finds the tab.
function followReplacedTab(addedTabId: number, removedTabId: number): Promise<void> {
  const operation = discardObservationQueue.then(async () => {
    await updateInternalDiscardIntents(ledger => ledger.map(intent =>
      intent.tabId === removedTabId ? { ...intent, tabId: addedTabId } : intent));
    await replaceDiscardLogTabId(removedTabId, addedTabId);
  });
  discardObservationQueue = operation.catch(() => undefined);
  return operation;
}

const RECENTLY_CREATED_TAB_TTL_MS = 30_000;
const recentlyCreatedTabs = new Map<number, number>();
const controlledRestoreTabs = new Map<number, number>();
let autoMergeQueue: Promise<void> = Promise.resolve();

export function markControlledRestoreTab(tabId: number, now = Date.now()): void {
  controlledRestoreTabs.set(tabId, now);
}

export function isControlledRestoreTab(tabId: number, now = Date.now()): boolean {
  const createdAt = controlledRestoreTabs.get(tabId);
  if (createdAt == null) return false;
  if (now - createdAt > RECENTLY_CREATED_TAB_TTL_MS) {
    controlledRestoreTabs.delete(tabId);
    return false;
  }
  return true;
}

async function tryAutoMergeDuplicate(tab: chrome.tabs.Tab): Promise<boolean> {
  const state = await loadAppState();
  if (!state.settings.autoMergeDuplicateTabs || typeof tab.id !== "number" || tab.pinned || tab.incognito ||
      tab.status === "loading" || tab.pendingUrl) {
    return false;
  }
  const createdAt = recentlyCreatedTabs.get(tab.id);
  if (createdAt == null || Date.now() - createdAt > RECENTLY_CREATED_TAB_TTL_MS) {
    recentlyCreatedTabs.delete(tab.id);
    return false;
  }
  const normalizedUrl = exactDuplicateTabKey(tab);
  if (!normalizedUrl) return false;

  const existing = selectExistingDuplicateTab(tab, await chrome.tabs.query({}));
  if (typeof existing?.id !== "number") return false;

  await captureRecoveryCapsule("closeDuplicates", [tab]);
  const safe = await checkTabCloseSafety(tab, {
    includeActive: true,
    stillEligible: async () => {
      const keeper = await chrome.tabs.get(existing.id as number).catch(() => undefined);
      return Boolean(keeper && !keeper.pendingUrl && keeper.status !== "loading" && exactDuplicateTabKey(keeper) === normalizedUrl);
    }
  });
  if (!safe.tab) return false;
  await chrome.tabs.remove(tab.id);
  // A link opened in the background must stay a background operation.
  if (safe.tab.active) {
    await chrome.tabs.update(existing.id, { active: true }).catch(() => undefined);
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => undefined);
  }
  recentlyCreatedTabs.delete(tab.id);
  await saveLastAutoMerge({
    mergedAt: Date.now(),
    closedTabId: tab.id,
    existingTabId: existing.id,
    normalizedUrl,
    title: tab.title
  });
  return true;
}

function runSerializedAutoMerge(tab: chrome.tabs.Tab): Promise<boolean> {
  const operation = autoMergeQueue.then(() => tryAutoMergeDuplicate(tab));
  autoMergeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function handleMessage(message: AppMessage): Promise<unknown> {
  switch (message.type) {
    case "getAppState":
      return loadRuntimeAppState();
    case "getPopupState":
      return getPopupState();
    case "getAccurateModeStatus":
      return getAccurateModeStatus();
    case "measureActiveTabAccurately":
      return measureActiveTabAccurately();
    case "measureOpenTabsAccurately":
      return measureOpenTabsAccurately();
    case "checkActiveTabLeak":
      return checkActiveTabLeak();
    case "releaseMemoryNow":
      return runSerializedScan("manual");
    case "discardTabsOlderThan":
      return discardTabsOlderThan(message.inactiveMinutes);
    case "discardCurrentDomainBackgroundTabs":
      return discardCurrentDomainBackgroundTabs();
    case "previewDuplicateTabs":
      return previewDuplicateTabsForCurrentBrowser();
    case "closeDuplicateTabs":
      return closeDuplicateTabs(message.tabIds);
    case "closeDiscardedTabs":
      return closeDiscardedTabs();
    case "closeFrozenTabs":
      return closeFrozenTabs();
    case "closeTab":
      return closeTab(message.tabId);
    case "discardTabNow":
      return discardTabNow(message.tabId);
    case "unprotectTab":
      return unprotectTab(message.tabId);
    case "setTabProtection":
      return setTabProtection(message.tabId, message.protected);
    case "setFocusMode":
      return setFocusMode(message.enabled);
    case "setTabFocus":
      return setTabFocus(message.tabId, message.focused);
    case "saveCurrentFocusSet":
      return saveCurrentFocusSet(message.name);
    case "applyFocusSet":
      return applyFocusSet(message.setId);
    case "deleteFocusSet":
      return removeFocusSet(message.setId);
    case "getExperimentalOptimizerStatus":
      return getExperimentalOptimizerStatus();
    case "setActiveTabOptimizer":
      return setActiveTabOptimizer(message.enabled, message.target);
    case "setAllSitesOptimizer":
      return setAllSitesOptimizer(message.enabled);
    case "setExperimentalOptimizerEnabled":
      return setExperimentalOptimizerEnabled(message.enabled);
    case "setExperimentalOptimizerItemEnabled":
      return setExperimentalOptimizerItemEnabled(message.itemId, message.enabled);
    case "setCurrentSiteOptimizer":
      return setCurrentSiteOptimizer(message.enabled, message.target);
    case "resetExperimentalOptimizer":
      return resetExperimentalOptimizer();
    case "toggleCurrentTabProtection":
      return toggleCurrentTabProtection();
    case "toggleCurrentDomainProtection":
      return toggleCurrentDomainProtection();
    case "protectCurrentTab":
      return addCurrentTabRule();
    case "protectCurrentDomain":
      return toggleCurrentDomainProtection();
    case "saveWindowAndClose":
      return saveCurrentWindowAndClose(message);
    case "saveGroupAndClose":
      return saveCurrentGroupAndClose(message);
    case "saveSelectionAndClose":
      return saveSelectedTabsAndClose(message);
    case "restoreSession":
      return runTabRestore(() => restoreSession(message.sessionId, message.target));
    case "deleteSession":
      return removeSession(message.sessionId);
    case "renameSession":
      return updateSessionName(message.sessionId, message.name);
    case "importSessions":
      return importSessions(message.sessions);
    case "restoreRecoveryCapsule":
      return runTabRestore(() => restoreRecoveryCapsule(message.capsuleId, message.target));
    case "deleteRecoveryCapsule":
      return deleteRecoveryCapsule(message.capsuleId);
    case "captureTimelineNow":
      return captureTimelineSnapshot("manual", true);
    case "restoreTimelineSnapshot":
      return runTabRestore(() => restoreTimelineSnapshot(message.snapshotId, message.target));
    case "deleteTimelineSnapshot":
      return deleteSessionTimelineSnapshot(message.snapshotId);
    case "restoreTrashedSession":
      return restoreSessionFromTrash(message.trashId);
    case "permanentlyDeleteTrashedSession":
      return permanentlyDeleteTrashedSession(message.trashId);
    case "simulatePolicy":
      return simulatePolicy(message.patch);
    case "getEffectReport24h": {
      const state = await loadAppState();
      return buildEffectReport24h({
        history: state.effectHistory ?? [],
        discardLog: state.discardLog,
        learning: state.discardLearning ?? [],
        externalDiscards: state.externalDiscardObservations ?? [],
        quickReactivateMinutes: state.settings.quickReactivateMinutes
      });
    }
    case "exportBackup":
      return exportFullBackup(message.selectedSections);
    case "importBackup":
      return importFullBackup(message.backup, message.mode);
    case "pushSelectiveSync":
      return pushSelectiveSync();
    case "pullSelectiveSync":
      return pullSelectiveSync();
    case "updateSettings": {
      if (containsPolicyModePatch(message.patch) && (await getFocusModeEnabled())) {
        throw new Error("Turn off Focus Mode before changing Policy Mode.");
      }
      const settings = await updateSettings(message.patch);
      if (message.patch.protectUnsavedWork !== undefined) await reconcileWorkProtection();
      if (message.patch.privacyMode === true) {
        await redactDiscardLogMetadata();
      }
      if (message.patch.experimentalOptimizerEnabled === false) {
        await removeAllExperimentalOptimizerCss();
      }
      await ensureScanAlarm(settings);
      await syncDnrRules(settings.networkDietMode);
      if (settings.syncEnabled) scheduleAutomaticSync();
      return settings;
    }
    case "setNetworkDietMode": {
      const settings = await updateSettings({ networkDietMode: message.mode });
      await syncDnrRules(settings.networkDietMode);
      return settings;
    }
    case "setCurrentDomainDiscardRule":
      return setCurrentDomainDiscardRule(message.inactiveMinutes);
    case "removeCurrentDomainDiscardRule":
      return removeCurrentDomainDiscardRule();
    case "setSnooze": {
      const settings = await updateSettings({
        snoozeUntil: message.indefinitely ? undefined : message.until,
        snoozeIndefinitely: Boolean(message.indefinitely)
      });
      await refreshStatus("periodic");
      return settings;
    }
    case "setWindowPolicy":
      if (await getFocusModeEnabled()) {
        throw new Error("Turn off Focus Mode before changing window policy.");
      }
      return setWindowPolicy(message.windowId, message.policyMode);
    case "undoDiscard":
      return runTabRestore(() => undoDiscard(message.entryId));
    case "addProtectionRule":
      return createProtectionRule(message.ruleType, message.value);
    case "setProtectionRuleEnabled":
      return setProtectionRuleEnabled(message.ruleId, message.enabled);
    case "deleteProtectionRule":
      return deleteProtectionRule(message.ruleId);
    case "clearDiscardLog":
      await clearDiscardLog();
      return [];
    case "openOptions":
      await chrome.runtime.openOptionsPage();
      return true;
    default:
      throw new Error(`Unsupported message: ${String((message as { type?: unknown }).type)}`);
  }
}

function isAppMessage(message: unknown): message is AppMessage {
  return Boolean(message && typeof message === "object" && "type" in message);
}

function optimizerSettingsFingerprint(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const settings = value as Partial<Settings>;
  return JSON.stringify([
    settings.experimentalOptimizerEnabled,
    settings.experimentalOptimizerItems,
    settings.experimentalOptimizerSiteDomains,
    settings.experimentalOptimizerAllSites,
    settings.experimentalOptimizerExcludedDomains
  ]);
}

function runEventTask(label: string, task: () => Promise<unknown>): void {
  void task().catch(error => {
    console.warn(`Background event failed: ${label}`, error);
  });
}

export function registerEventHandlers(): void {
  const reconcileOptimizerAccess = (permissions: chrome.permissions.Permissions) => {
    if (permissions.origins?.length) {
      runEventTask("permissions(work protection)", reconcileWorkProtection);
      runEventTask("permissions(optimizer)", () => reconcileExperimentalOptimizerSettings(undefined, { force: true }));
    }
  };
  chrome.permissions?.onAdded?.addListener(reconcileOptimizerAccess);
  chrome.permissions?.onRemoved?.addListener(reconcileOptimizerAccess);
  chrome.runtime.onInstalled.addListener(() => {
    runEventTask("runtime.onInstalled", async () => {
      await initializeExtension();
      // No scan runs on install or update; show low memory on the toolbar now instead of at the first alarm.
      await updateBadge((await collectScanEvaluation("manual")).pressure);
    });
  });

  chrome.runtime.onStartup.addListener(() => {
    runEventTask("runtime.onStartup", () => initializeExtension({ runStartupTasks: true }));
  });

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === SCAN_ALARM_NAME) {
      runEventTask("alarms.onAlarm", async () => {
        try {
          await runSerializedScan("periodic");
        } finally {
          // The scan alarm also supplies the periodic trigger promised by Time
          // Machine. captureTimelineSnapshot enforces its own interval and
          // topology deduplication before querying all tabs.
          await captureTimelineSnapshot("browserEvent");
        }
      });
    }
  });

  chrome.tabs.onActivated.addListener(activeInfo => {
    runEventTask("tabs.onActivated", async () => {
      const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => undefined);
      if (tab) await syncExperimentalOptimizerForTab(tab);
      await learnFromTabActivation(activeInfo.tabId);
      await captureTimelineSnapshot("browserEvent");
      await refreshOrRunFocusCleanup();
    });
  });

  chrome.tabs.onCreated.addListener(tab => {
    const controlledRestore = isAutoMergeSuppressed(tab.id);
    runEventTask("tabs.onCreated", async () => {
      const now = Date.now();
      for (const [tabId, createdAt] of recentlyCreatedTabs) {
        if (now - createdAt > RECENTLY_CREATED_TAB_TTL_MS) recentlyCreatedTabs.delete(tabId);
      }
      for (const [tabId, createdAt] of controlledRestoreTabs) {
        if (now - createdAt > RECENTLY_CREATED_TAB_TTL_MS) controlledRestoreTabs.delete(tabId);
      }
      if (controlledRestore) {
        if (typeof tab.id === "number") markControlledRestoreTab(tab.id, now);
        await refreshStatusCoalesced();
        return;
      }
      if (typeof tab.id === "number") recentlyCreatedTabs.set(tab.id, now);
      if (await runSerializedAutoMerge(tab)) return;
      await syncExperimentalOptimizerForTab(tab);
      await captureTimelineSnapshot("browserEvent");
      await refreshOrRunFocusCleanup();
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading" || "url" in changeInfo) {
      runEventTask("tabs.onUpdated(metrics)", () => removeTabAccurateMetric(tabId));
    }
    const optimizerDocumentComplete = changeInfo.status === "complete";
    if (optimizerDocumentComplete || changeInfo.status === "loading" || "url" in changeInfo ||
        "discarded" in changeInfo || "frozen" in changeInfo) {
      runEventTask("tabs.onUpdated(optimizer)", () => syncExperimentalOptimizerForTab(tab, {
        force: optimizerDocumentComplete || changeInfo.frozen === false,
        navigation: changeInfo.status === "loading" || "url" in changeInfo
      }));
    }
    const controlledRestore = isControlledRestoreTab(tabId);
    if (optimizerDocumentComplete && !controlledRestore && recentlyCreatedTabs.has(tabId)) {
      runEventTask("tabs.onUpdated(autoMerge)", () => runSerializedAutoMerge(tab));
    }
    const topologyStateChanged =
      "url" in changeInfo || "pinned" in changeInfo || "groupId" in changeInfo;
    const resourceStateChanged =
      "url" in changeInfo ||
      "audible" in changeInfo ||
      "discarded" in changeInfo ||
      "frozen" in changeInfo ||
      "pinned" in changeInfo ||
      "autoDiscardable" in changeInfo;
    if (optimizerDocumentComplete && !resourceStateChanged && !topologyStateChanged) {
      // A same-URL reload drops programmatically inserted CSS, but it does not
      // require a full resource-policy refresh.
      return;
    }
    if (resourceStateChanged) {
      runEventTask("tabs.onUpdated", async () => {
        if (changeInfo.discarded === true) {
          await observeDiscardTransition(tabId, true, tab);
        }
        if ("url" in changeInfo) {
          if (!controlledRestore && await runSerializedAutoMerge(tab)) return;
          await rememberRuleProtectionForTab(tab);
        }
        if (topologyStateChanged) {
          await captureTimelineSnapshot("browserEvent");
        }
        if (controlledRestore || "discarded" in changeInfo) {
          await refreshStatusCoalesced();
        } else {
          await refreshOrRunFocusCleanup();
        }
      });
    } else if (topologyStateChanged) {
      runEventTask("tabs.onUpdated(topology)", () => captureTimelineSnapshot("browserEvent"));
    }
  });

  chrome.tabs.onMoved.addListener(() => {
    runEventTask("tabs.onMoved", () => captureTimelineSnapshot("browserEvent"));
  });

  chrome.tabs.onAttached.addListener(() => {
    runEventTask("tabs.onAttached", () => captureTimelineSnapshot("browserEvent"));
  });

  chrome.tabs.onDetached.addListener(() => {
    runEventTask("tabs.onDetached", () => captureTimelineSnapshot("browserEvent"));
  });

  chrome.tabGroups.onUpdated.addListener(() => {
    runEventTask("tabGroups.onUpdated", () => captureTimelineSnapshot("browserEvent"));
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    // Queued synchronously so it runs before the new tab's discard update is classified.
    void followReplacedTab(addedTabId, removedTabId).catch(error => console.warn("tabs.onReplaced failed", error));
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    runEventTask("tabs.onRemoved", async () => {
      recentlyCreatedTabs.delete(tabId);
      controlledRestoreTabs.delete(tabId);
      await removeTemporaryTabProtection(tabId);
      await removeOptimizedTab(tabId);
      await clearOptimizerTabPause(tabId);
      await removeTabAccurateMetric(tabId);
      await captureTimelineSnapshot("browserEvent");
      await refreshOrRunFocusCleanup();
    });
  });

  chrome.idle.onStateChanged.addListener(() => {
    runEventTask("idle.onStateChanged", () => refreshStatusCoalesced());
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.settings) {
      runEventTask("storage.onChanged(settings)", async () => {
        const state = await loadAppState();
        const oldSettings = changes.settings.oldValue as Partial<Settings> | undefined;
        const newSettings = changes.settings.newValue as Partial<Settings> | undefined;
        if (oldSettings?.protectUnsavedWork !== newSettings?.protectUnsavedWork) await reconcileWorkProtection();
        if (
          optimizerSettingsFingerprint(changes.settings.oldValue) !==
          optimizerSettingsFingerprint(changes.settings.newValue)
        ) {
          await reconcileExperimentalOptimizerSettings(
            changes.settings.oldValue as Partial<Settings> | undefined,
            { dedupe: true }
          );
        }
        await ensureScanAlarm(state.settings);
        await syncDnrRules(state.settings.networkDietMode);
        await refreshStatusCoalesced();
      });
    }
    if (
      areaName === "local" &&
      (changes.settings || changes.protectionRules || changes.focusSets)
    ) {
      scheduleAutomaticSync();
    }
    if (
      areaName === "sync" &&
      Object.keys(changes).some(key => key.startsWith("resourceGovernor.sync."))
    ) {
      scheduleRemoteSyncPull();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isAppMessage(message)) return false;

    void handleMessage(message)
      .then(data => {
        const response: AppResponse = { ok: true, data };
        sendResponse(response);
      })
      .catch(error => {
        const response: AppResponse = {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
        sendResponse(response);
      });

    return true;
  });
}
