import type {
  PageOptimizerItemId,
  PageOptimizerStatus,
  PageOptimizerToggleResult,
  OptimizedTab,
  Settings
} from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/constants";
import { OPTIMIZER_CATALOG, optimizerItemStatuses } from "../shared/optimizerCatalog";
import { ALL_OPTIMIZER_ORIGINS, isOptimizerUrl, optimizerOriginsForDomain, optimizerDomainAccessGranted } from "../shared/optimizerAccess";
import { installOptimizerCleanupBridge, restoreOptimizerInPage } from "./optimizerCleanup";
import { installPageOptimizer, removePageOptimizer, probePageOptimizer, probeOptimizerInstallation } from "./pageOptimizer";
import { restoreLegacyOptimizer } from "./legacyOptimizer";
import {
  getSettings,
  getOptimizedTabs,
  getOptimizerPausedTabs,
  setOptimizerTabPaused,
  clearOptimizerTabPause,
  pruneOptimizerPausedTabs,
  pruneOptimizedTabs,
  removeOptimizedTab,
  saveOptimizedTabs,
  setOptimizedTab,
  updateSettings
} from "../shared/storage";
import { getHostname } from "../shared/url";
import type { OptimizerTarget } from "../shared/messages";
import {
  AI_CONVERSATION_OPTIMIZER_CSS,
  installAiConversationOptimizer,
  probeAiConversationOptimizer,
  removeAiConversationOptimizer
} from "./aiConversationOptimizer";

export const PAGE_OPTIMIZER_WARNING =
  "Beta. Optimizations are reversible and can be removed from the current tab or saved site.";

const LEGACY_PAGE_OPTIMIZER_CSS = `
@supports (content-visibility: auto) {
  main article,
  main [role="article"],
  main [data-testid*="conversation"],
  main [data-testid*="message"],
  main [data-message-author-role],
  [data-radix-scroll-area-viewport] article {
    content-visibility: auto !important;
    contain-intrinsic-size: 1px 720px !important;
  }
}

video:not(:hover):not(:focus-within),
canvas:not(:hover):not(:focus-within) {
  content-visibility: auto !important;
  contain-intrinsic-size: 1px 360px !important;
}
`;

const LEGACY_AI_CONVERSATION_OPTIMIZER_CSS = `
[data-message-author-role],
[data-testid*="conversation-turn"],
[data-testid*="message-row"],
article:has([data-message-author-role]) {
  content-visibility: auto !important;
  contain-intrinsic-size: 1px 900px !important;
  contain: layout style paint !important;
}
`;

const OPTIMIZER_ITEMS = OPTIMIZER_CATALOG.map(item => ({
  ...item,
  css: item.id === "aiConversationOptimizer" ? AI_CONVERSATION_OPTIMIZER_CSS
    : ""
}));

function enabledOptimizerItems(settings: Settings) {
  return OPTIMIZER_ITEMS.filter(item => settings.pageOptimizerItems[item.id]);
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function getOpenTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({});
}

function openTabIds(tabs: chrome.tabs.Tab[]): Set<number> {
  return new Set(tabs.map(tab => tab.id).filter((tabId): tabId is number => typeof tabId === "number"));
}

function optimizedRecordMatchesTab(record: OptimizedTab | undefined, tab: chrome.tabs.Tab | undefined): boolean {
  if (!record || typeof tab?.id !== "number" || record.tabId !== tab.id) return false;
  return !record.url || record.url === tab.url;
}

function sharesOrigin(previousUrl: string | undefined, currentUrl: string | undefined): boolean {
  if (!previousUrl || !currentUrl) return false;
  try {
    return new URL(previousUrl).origin === new URL(currentUrl).origin;
  } catch {
    return false;
  }
}

async function hasAllSitesOptimizerAccess(): Promise<boolean> {
  return chrome.permissions?.contains({ origins: ALL_OPTIMIZER_ORIGINS }).catch(() => false) ?? false;
}

async function revokePersistentOptimizerAccess(domains: string[]): Promise<void> {
  // A site exception is enforced by our policy, not by subtracting one origin
  // from a wildcard grant. Website grants are also used by work protection.
  const origins = [...new Set(domains.flatMap(optimizerOriginsForDomain))];
  if (origins.length === 0 || !chrome.permissions?.remove) return;
  if ((await getSettings()).protectUnsavedWork || await hasAllSitesOptimizerAccess()) return;
  try {
    await chrome.permissions.remove({ origins });
  } catch (error) {
    console.warn("Could not revoke Page optimizer site access", error);
  }
}

async function hasPersistentOptimizerAccess(domain: string | undefined): Promise<boolean> {
  if (!domain || !chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ origins: optimizerOriginsForDomain(domain) }).catch(() => false);
}

function statusForTab(input: {
  settings: Settings;
  tab?: chrome.tabs.Tab;
  optimizedTabs: OptimizedTab[];
}): PageOptimizerStatus {
  const tab = input.tab;
  const activeTabId = tab?.id;
  const canUseTab = Boolean(typeof activeTabId === "number" && isOptimizerUrl(tab?.url));
  const activeTabOptimized = optimizedRecordMatchesTab(
    input.optimizedTabs.find(record => record.tabId === activeTabId),
    tab
  );
  const activeTabDomain = getHostname(tab?.url) ?? undefined;
  const activeSiteExcluded = Boolean(activeTabDomain && input.settings.pageOptimizerExcludedDomains.includes(activeTabDomain));
  const activeSiteEnabled = Boolean(canUseTab && activeTabDomain && !activeSiteExcluded &&
    (input.settings.pageOptimizerAllSites || input.settings.pageOptimizerSiteDomains.includes(activeTabDomain)));

  return {
    enabledInSettings: input.settings.pageOptimizerEnabled,
    allSitesEnabled: input.settings.pageOptimizerAllSites,
    allSitesAccessGranted: false,
    activeSiteExcluded,
    activeTabPaused: false,
    activeTabOptimized,
    activeSiteEnabled,
    activeSiteAccessGranted: false,
    canToggleActiveTab: canUseTab,
    siteDomains: input.settings.pageOptimizerSiteDomains,
    items: optimizerItemStatuses(input.settings),
    warning: PAGE_OPTIMIZER_WARNING,
    reason: canUseTab ? undefined : "Chrome does not allow optimization on this page. Open a regular HTTP or HTTPS page.",
    activeTabId,
    activeTabDomain,
    activeTabTitle: tab?.title
  };
}

export async function getPageOptimizerStatus(): Promise<PageOptimizerStatus> {
  const [settings, activeTab, optimizedTabs, pausedTabs] = await Promise.all([
    getSettings(),
    getActiveTab(),
    getOptimizedTabs(),
    getOptimizerPausedTabs()
  ]);

  const status = statusForTab({
    settings,
    tab: activeTab,
    optimizedTabs
  });
  status.activeTabPaused = pausedTabs.some(tab => tab.tabId === status.activeTabId && tab.url === activeTab?.url);
  // Hash/history changes can outrun the asynchronous onUpdated record. A live
  // runtime in the same-origin document is stronger evidence than that stale
  // URL; a new document has no runtime and must not inherit a manual selection.
  const tracked = optimizedTabs.find(record => record.tabId === status.activeTabId);
  if (!status.activeTabOptimized && settings.pageOptimizerEnabled && tracked &&
      typeof status.activeTabId === "number" && sharesOrigin(tracked.url, activeTab?.url)) {
    const installation = await probeOptimizerInstallation(status.activeTabId).catch(() => undefined);
    status.activeTabOptimized = installation?.pageInstalled === true;
  }
  const shouldProbeAiConversation = Boolean(
    status.activeTabOptimized &&
      typeof status.activeTabId === "number" &&
      settings.pageOptimizerItems.aiConversationOptimizer
  );
  const [activeSiteAccessGranted, allSitesAccessGranted, aiConversationMetrics, pageMetrics, permissions] = await Promise.all([
    hasPersistentOptimizerAccess(status.activeTabDomain),
    hasAllSitesOptimizerAccess(),
    shouldProbeAiConversation
      ? probeAiConversationOptimizer(status.activeTabId as number).catch(() => undefined)
      : Promise.resolve(undefined),
    status.activeTabOptimized && typeof status.activeTabId === "number"
      ? probePageOptimizer(status.activeTabId).catch(() => undefined)
      : Promise.resolve(undefined),
    chrome.permissions?.getAll?.().catch(() => undefined)
  ]);
  const items = status.items.map(item => ({ ...item, metrics: pageMetrics?.items?.[item.id] }));
  const siteAccessGrantedCount = permissions ? settings.pageOptimizerSiteDomains.filter(domain =>
    !settings.pageOptimizerExcludedDomains.includes(domain) && optimizerDomainAccessGranted(domain, permissions.origins ?? [])).length : undefined;
  return { ...status, items, activeSiteAccessGranted, allSitesAccessGranted, siteAccessGrantedCount, aiConversationMetrics, pageMetrics };
}

async function insertCss(tabId: number, css: string): Promise<void> {
  await chrome.scripting.insertCSS({
    target: { tabId },
    css
  });
}

async function removeCss(tabId: number, css: string): Promise<void> {
  await chrome.scripting.removeCSS({
    target: { tabId },
    css
  });
}

async function insertEnabledOptimizerCss(tabId: number, settings: Settings): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func: installOptimizerCleanupBridge });
  const enabledItems = enabledOptimizerItems(settings);
  const aiConversationItem = enabledItems.find(item => item.id === "aiConversationOptimizer");
  if (aiConversationItem) {
    await insertCss(tabId, aiConversationItem.css);
    await installAiConversationOptimizer(tabId);
  }
  for (const item of enabledItems) {
    if (item.id === "aiConversationOptimizer") continue;
    if (item.css) await insertCss(tabId, item.css);
  }
  await installPageOptimizer(tabId, settings.pageOptimizerItems);
}

const tabCssJobs = new Map<number, Promise<void>>();
function serializeTabCss<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const job = (tabCssJobs.get(tabId) ?? Promise.resolve()).then(operation);
  const settled = job.then(() => undefined, () => undefined);
  tabCssJobs.set(tabId, settled);
  void settled.then(() => { if (tabCssJobs.get(tabId) === settled) tabCssJobs.delete(tabId); });
  return job;
}

async function replaceOptimizerCss(tabId: number, settings: Settings, automaticUrl?: string): Promise<boolean> {
  return serializeTabCss(tabId, async () => {
    // A settings change may overtake a queued browser event. Do not reinstall
    // an obsolete configuration after the user has disabled or changed it.
    const current = await getSettings();
    if (!current.pageOptimizerEnabled || optimizerSettingsFingerprint(current) !== optimizerSettingsFingerprint(settings)) return false;
    if (automaticUrl !== undefined) {
      const paused = (await getOptimizerPausedTabs()).some(tab => tab.tabId === tabId && tab.url === automaticUrl);
      const liveTab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (paused || !liveTab || liveTab.url !== automaticUrl || liveTab.discarded || liveTab.frozen || liveTab.status === "loading") return false;
    }
    const configurationKey = Object.entries(settings.pageOptimizerItems).filter(([, value]) => value).map(([id]) => id).sort().join("|");
    const runtime = await probeOptimizerInstallation(tabId).catch(() => undefined);
    if (runtime?.pageInstalled && runtime.configurationKey === configurationKey) {
      const aiReady = !settings.pageOptimizerItems.aiConversationOptimizer || runtime.aiInstalled;
      if (aiReady) {
        // An older installed runtime can survive an extension update. Attach
        // the current cleanup channel even when rendering needs no reinstall.
        await chrome.scripting.executeScript({ target: { tabId }, func: installOptimizerCleanupBridge });
        return true;
      }
    }
    // A load-complete event can describe SPA history or an iframe. Only a new
    // document, changed configuration or missing runtime requires installation.
    await removeAllOptimizerCssFromTabNow(tabId);
    try {
      await insertEnabledOptimizerCss(tabId, settings);
      const after = await getSettings();
      const paused = automaticUrl !== undefined && (await getOptimizerPausedTabs()).some(tab => tab.tabId === tabId && tab.url === automaticUrl);
      if (paused || optimizerSettingsFingerprint(after) !== optimizerSettingsFingerprint(settings)) {
        await removeAllOptimizerCssFromTabNow(tabId);
        return false;
      }
      return true;
    } catch (error) {
      await removeAllOptimizerCssFromTabNow(tabId);
      throw error;
    }
  });
}

let optimizerReconcileQueue: Promise<void> = Promise.resolve();
const optimizerReconcileJobs = new Map<string, Promise<void>>();
let lastReconciledFingerprint: string | undefined;
let optimizerMutationQueue: Promise<void> = Promise.resolve();

function runOptimizerMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = optimizerMutationQueue.then(operation);
  optimizerMutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function optimizerSettingsFingerprint(settings: Settings): string {
  return JSON.stringify([
    settings.pageOptimizerEnabled,
    settings.pageOptimizerItems,
    settings.pageOptimizerSiteDomains,
    settings.pageOptimizerAllSites,
    settings.pageOptimizerExcludedDomains
  ]);
}

export async function reconcilePageOptimizerSettings(
  previousSettings?: Partial<Settings>,
  options: { dedupe?: boolean; force?: boolean; reapplyTracked?: boolean } = {}
): Promise<void> {
  const settings = await getSettings();
  const fingerprint = optimizerSettingsFingerprint(settings);
  const existingJob = optimizerReconcileJobs.get(fingerprint);
  if (existingJob) return existingJob;
  if (options.dedupe && !options.force && fingerprint === lastReconciledFingerprint) return;

  const job = optimizerReconcileQueue.then(async () => {
    if (optimizerSettingsFingerprint(await getSettings()) !== fingerprint) return;
    if (options.dedupe && !options.force && fingerprint === lastReconciledFingerprint) return;
    if (!settings.pageOptimizerEnabled) {
      await removeAllPageOptimizerCss();
      await revokePersistentOptimizerAccess(
        (previousSettings?.pageOptimizerSiteDomains ?? []).filter(
          domain => !settings.pageOptimizerSiteDomains.includes(domain)
        )
      );
      lastReconciledFingerprint = fingerprint;
      return;
    }

    const openTabs = await getOpenTabs();
    await pruneOptimizerPausedTabs(openTabIds(openTabs));
    const optimizedTabs = await pruneOptimizedTabs(openTabIds(openTabs));
    const optimizedById = new Map(optimizedTabs.map(record => [record.tabId, record]));
    const previousSiteDomains = new Set(previousSettings?.pageOptimizerSiteDomains ?? []);

    for (const tab of openTabs) {
      if (typeof tab.id !== "number") continue;
      const record = optimizedById.get(tab.id);
      const domain = getHostname(tab.url);
      const siteEnabled = Boolean(domain && settings.pageOptimizerSiteDomains.includes(domain));
      if (!record && !siteEnabled && !settings.pageOptimizerAllSites) continue;

      const siteNewlyEnabled = Boolean(domain && siteEnabled && !previousSiteDomains.has(domain));
      const source = siteNewlyEnabled
        ? "site"
        : record?.source ??
          (record?.domain && previousSiteDomains.has(record.domain)
            ? "site"
            : siteEnabled
              ? "site"
              : settings.pageOptimizerAllSites ? "global" : "manual");
      await syncPageOptimizerForTab(tab, {
        force: options.reapplyTracked ?? Boolean(record),
        source
      });
    }
    await revokePersistentOptimizerAccess(
      (previousSettings?.pageOptimizerSiteDomains ?? []).filter(
        domain => !settings.pageOptimizerSiteDomains.includes(domain)
      )
    );
    lastReconciledFingerprint = fingerprint;
  });
  optimizerReconcileJobs.set(fingerprint, job);
  optimizerReconcileQueue = job.catch(() => undefined);
  void job
    .finally(() => {
      if (optimizerReconcileJobs.get(fingerprint) === job) {
        optimizerReconcileJobs.delete(fingerprint);
      }
    })
    .catch(() => undefined);
  return job;
}

function removeAllOptimizerCssFromTab(tabId: number): Promise<void> {
  return serializeTabCss(tabId, () => removeAllOptimizerCssFromTabNow(tabId));
}

async function removeAllOptimizerCssFromTabNow(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func: restoreOptimizerInPage }).catch(() => undefined);
  await restoreLegacyOptimizer(tabId);
  await chrome.tabs.sendMessage?.(tabId, { type: "coppice.restoreOptimizer" }).catch(() => undefined);
  await removePageOptimizer(tabId).catch(() => undefined);
  await removeCss(tabId, LEGACY_PAGE_OPTIMIZER_CSS).catch(() => undefined);
  await removeCss(tabId, LEGACY_AI_CONVERSATION_OPTIMIZER_CSS).catch(() => undefined);
  for (const item of OPTIMIZER_ITEMS) {
    if (item.css) await removeCss(tabId, item.css).catch(() => undefined);
  }
  // Keep the AI runtime marker in place until generic containment CSS is gone;
  // otherwise reconfiguration can briefly expose AI turns to the generic rule.
  await removeAiConversationOptimizer(tabId).catch(() => undefined);
}

export async function removeAllPageOptimizerCss(): Promise<number> {
  const openTabs = await getOpenTabs();
  const optimizedTabs = await pruneOptimizedTabs(openTabIds(openTabs));
  const deferredTabs: OptimizedTab[] = [];
  let removedCount = 0;

  for (const tab of optimizedTabs) {
    const liveTab = openTabs.find(item => item.id === tab.tabId);
    if (liveTab?.discarded) continue;
    if (liveTab?.frozen) {
      // A frozen document cannot execute cleanup until Chrome resumes it.
      deferredTabs.push(tab);
      continue;
    }
    try {
      await removeAllOptimizerCssFromTab(tab.tabId);
      removedCount += 1;
    } catch (error) {
      console.warn("Failed to remove page optimizer CSS", tab.tabId, error);
    }
  }

  await saveOptimizedTabs(deferredTabs);
  return removedCount;
}

export function setPageOptimizerEnabled(enabled: boolean): Promise<PageOptimizerStatus> {
  return runOptimizerMutation(async () => {
    const previousSettings = await getSettings();
    await updateSettings({ pageOptimizerEnabled: enabled });
    await reconcilePageOptimizerSettings(previousSettings, { force: true });
    return getPageOptimizerStatus();
  });
}

export function setAllSitesOptimizer(enabled: boolean): Promise<PageOptimizerStatus> {
  return runOptimizerMutation(async () => {
    // The popup requests access synchronously in its click handler. Never
    // advertise automatic coverage before Chrome has actually granted it.
    if (enabled && !await hasAllSitesOptimizerAccess()) {
      throw new Error("Allow access to all websites to turn on automatic optimization.");
    }
    const previousSettings = await getSettings();
    await updateSettings({
      pageOptimizerAllSites: enabled,
      pageOptimizerEnabled: enabled ? true : previousSettings.pageOptimizerEnabled
    });
    await reconcilePageOptimizerSettings(previousSettings, { force: true });
    return getPageOptimizerStatus();
  });
}

export function setPageOptimizerItemEnabled(
  itemId: PageOptimizerItemId,
  enabled: boolean
): Promise<PageOptimizerStatus> {
  const item = OPTIMIZER_ITEMS.find(candidate => candidate.id === itemId);
  if (!item) return Promise.reject(new Error("Unknown Page optimizer item."));

  return runOptimizerMutation(async () => {
    const settings = await getSettings();
    await updateSettings({
      pageOptimizerItems: {
        ...settings.pageOptimizerItems,
        [itemId]: enabled
      }
    });
    await reconcilePageOptimizerSettings(settings, { force: true });
    return getPageOptimizerStatus();
  });
}

const tabSyncJobs = new Map<number, Promise<boolean>>();
type OptimizerSyncOptions = { force?: boolean; source?: OptimizedTab["source"]; navigation?: boolean };

export function syncPageOptimizerForTab(tab: chrome.tabs.Tab, options: OptimizerSyncOptions = {}): Promise<boolean> {
  if (typeof tab.id !== "number") return Promise.resolve(false);
  const tabId = tab.id;
  const job = (tabSyncJobs.get(tabId) ?? Promise.resolve(false)).catch(() => false).then(async () => {
    const liveTab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!liveTab) return false;
    return syncOptimizerDocument(liveTab, options);
  });
  tabSyncJobs.set(tabId, job);
  void job.finally(() => { if (tabSyncJobs.get(tabId) === job) tabSyncJobs.delete(tabId); }).catch(() => undefined);
  return job;
}

async function syncOptimizerDocument(
  tab: chrome.tabs.Tab,
  options: OptimizerSyncOptions
): Promise<boolean> {
  if (typeof tab.id !== "number") return false;
  if (options.navigation) await clearOptimizerTabPause(tab.id);
  // Auto optimization must never wake discarded pages or block on frozen ones.
  if (tab.discarded) {
    await removeOptimizedTab(tab.id);
    return false;
  }
  if (tab.frozen || tab.status === "loading") return false;

  const [settings, optimizedTabs, pausedTabs] = await Promise.all([getSettings(), getOptimizedTabs(), getOptimizerPausedTabs()]);
  const domain = getHostname(tab.url);
  let optimizedTab = optimizedTabs.find(item => item.tabId === tab.id);
  const wasOptimized = Boolean(optimizedTab);
  const paused = pausedTabs.some(item => item.tabId === tab.id && item.url === tab.url);
  const isEligible = Boolean(isOptimizerUrl(tab.url) && domain);
  let isSameTrackedDocument = optimizedRecordMatchesTab(optimizedTab, tab);
  const excluded = Boolean(domain && settings.pageOptimizerExcludedDomains.includes(domain));
  const siteEnabled = Boolean(domain && !excluded && settings.pageOptimizerSiteDomains.includes(domain));
  const automaticRequested = !excluded && (siteEnabled || settings.pageOptimizerAllSites);
  const shouldOptimizeSavedSite = Boolean(
    settings.pageOptimizerEnabled &&
      isEligible &&
      !paused && automaticRequested && await hasPersistentOptimizerAccess(domain ?? undefined)
  );
  const trackedSource = optimizedTab?.source ?? (siteEnabled ? "site" : "manual");
  // SPA scrolling, anchors and history updates can change the URL without
  // replacing the document. Its isolated-world runtime proves it is still live;
  // a new document or another origin must not inherit a manual application.
  if (!isSameTrackedDocument && optimizedTab && settings.pageOptimizerEnabled &&
      isEligible && trackedSource === "manual" && sharesOrigin(optimizedTab.url, tab.url)) {
    const existingRuntime = await probeOptimizerInstallation(tab.id).catch(() => undefined);
    if (existingRuntime?.pageInstalled) {
      optimizedTab = { ...optimizedTab, url: tab.url, domain: domain ?? undefined, title: tab.title };
      await setOptimizedTab(optimizedTab);
      isSameTrackedDocument = true;
    }
  }
  // A manually optimized tab is intentionally session-scoped. Keep it active
  // in the tracked document (and on same-URL reloads), without saving the site.
  const shouldKeepManualTab = Boolean(
    settings.pageOptimizerEnabled &&
      isEligible &&
      !paused &&
      isSameTrackedDocument &&
      trackedSource === "manual"
  );
  const shouldOptimize = shouldOptimizeSavedSite || shouldKeepManualTab;

  if (!shouldOptimize) {
    if (wasOptimized) {
      await removeAllOptimizerCssFromTab(tab.id).catch(() => undefined);
      await removeOptimizedTab(tab.id);
    }
    return false;
  }

  const source = options.source === "site" && siteEnabled ? "site"
    : shouldKeepManualTab ? "manual" : siteEnabled ? "site" : "global";
  if (isSameTrackedDocument && !options.force) {
    if (optimizedTab && optimizedTab.source !== source) {
      await setOptimizedTab({ ...optimizedTab, source });
    }
    return true;
  }

  try {
    if (!await replaceOptimizerCss(tab.id, settings, tab.url)) return false;
    await setOptimizedTab({
      tabId: tab.id,
      windowId: tab.windowId,
      createdAt: Date.now(),
      source,
      url: tab.url,
      domain: domain ?? undefined,
      title: tab.title
    });
    return true;
  } catch (error) {
    await removeOptimizedTab(tab.id);
    console.warn("Could not auto-apply Page optimizer", tab.id, error);
    return false;
  }
}

function assertOptimizerTarget(tab: chrome.tabs.Tab | undefined, expected?: OptimizerTarget): void {
  if (expected && (!tab || tab.id !== expected.tabId || getHostname(tab.url) !== expected.domain)) {
    throw new Error("The active page changed. Reopen the popup and try again.");
  }
}

export function setCurrentSiteOptimizer(enabled: boolean, target?: OptimizerTarget): Promise<PageOptimizerStatus> {
  return runOptimizerMutation(async () => {
    const activeTab = await getActiveTab();
    assertOptimizerTarget(activeTab, target);
    const domain = getHostname(activeTab?.url);
    if (!activeTab?.url || typeof activeTab.id !== "number" || !domain || !isOptimizerUrl(activeTab.url)) {
      throw new Error("Active HTTP or HTTPS tab required.");
    }

    const settings = await getSettings();
    const siteDomains = enabled
      ? [domain, ...settings.pageOptimizerSiteDomains.filter(item => item !== domain)]
      : settings.pageOptimizerSiteDomains.filter(item => item !== domain);
    await updateSettings({
      pageOptimizerEnabled: enabled ? true : settings.pageOptimizerEnabled,
      pageOptimizerSiteDomains: siteDomains,
      pageOptimizerExcludedDomains: enabled
        ? settings.pageOptimizerExcludedDomains.filter(item => item !== domain)
        : [...new Set([domain, ...settings.pageOptimizerExcludedDomains])]
    });
    if (enabled) await clearOptimizerTabPause(activeTab.id);
    else {
      // Excluding a site also restores tabs that were explicitly optimized
      // before the exclusion. A later manual apply is still a valid override.
      const records = await getOptimizedTabs();
      const tabs = await getOpenTabs();
      for (const tab of tabs) {
        if (typeof tab.id !== "number" || getHostname(tab.url) !== domain) continue;
        if (tab.frozen || tab.status === "loading") {
          const record = records.find(record => record.tabId === tab.id);
          if (record) await setOptimizedTab({ ...record, source: "global" });
          continue;
        }
        if (records.some(record => record.tabId === tab.id)) {
          if (!tab.discarded) await removeAllOptimizerCssFromTab(tab.id);
          await removeOptimizedTab(tab.id);
        }
      }
    }
    await reconcilePageOptimizerSettings(settings, { force: true });
    return getPageOptimizerStatus();
  });
}

export function resetPageOptimizer(): Promise<PageOptimizerStatus> {
  return runOptimizerMutation(async () => {
    const previousSettings = await getSettings();
    await updateSettings({
      pageOptimizerEnabled: false,
      pageOptimizerAllSites: false,
      pageOptimizerExcludedDomains: [],
      pageOptimizerItems: { ...DEFAULT_SETTINGS.pageOptimizerItems },
      pageOptimizerSiteDomains: []
    });
    await reconcilePageOptimizerSettings(previousSettings, { force: true });
    await clearOptimizerTabPause();
    // Resetting rendering preferences must not disable independent draft checks.
    // Chrome's extension site-access controls remain available to revoke grants.
    if (!(await getSettings()).protectUnsavedWork) {
      await chrome.permissions?.remove({ origins: [
        ...ALL_OPTIMIZER_ORIGINS,
        ...previousSettings.pageOptimizerSiteDomains.flatMap(optimizerOriginsForDomain)
      ] }).catch(() => undefined);
    }
    return getPageOptimizerStatus();
  });
}

export function setActiveTabOptimizer(enabled: boolean, target?: OptimizerTarget): Promise<PageOptimizerToggleResult> {
  return runOptimizerMutation(async () => {
    const activeTab = await getActiveTab();
    assertOptimizerTarget(activeTab, target);
    if (!activeTab?.url || typeof activeTab.id !== "number" || !isOptimizerUrl(activeTab.url)) {
      throw new Error("Active HTTP or HTTPS tab required.");
    }

    const before = await pruneOptimizedTabs(openTabIds(await getOpenTabs()));
    const wasOptimized = optimizedRecordMatchesTab(
      before.find(tab => tab.tabId === activeTab.id),
      activeTab
    );
    let settings = await getSettings();
    const enabledMasterForThisApply = enabled && !settings.pageOptimizerEnabled;
    if (enabled && !settings.pageOptimizerEnabled) {
      const previousSettings = settings;
      settings = await updateSettings({ pageOptimizerEnabled: true });
      await reconcilePageOptimizerSettings(previousSettings, { force: true });
    }

    if (enabled) {
      await clearOptimizerTabPause(activeTab.id);
      try {
        if (!await replaceOptimizerCss(activeTab.id, settings)) {
          return { ...await getPageOptimizerStatus(), changed: false };
        }
      } catch (error) {
        if (enabledMasterForThisApply) {
          try {
            const failedSettings = await getSettings();
            await updateSettings({ pageOptimizerEnabled: false });
            await reconcilePageOptimizerSettings(failedSettings, { force: true });
          } catch (rollbackError) {
            console.warn("Could not roll back Page optimizer after failed application", rollbackError);
          }
        }
        throw new Error(
          `Could not apply Page optimizer. ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await setOptimizedTab({
        tabId: activeTab.id,
        windowId: activeTab.windowId,
        createdAt: Date.now(),
        source: "manual",
        url: activeTab.url,
        domain: getHostname(activeTab.url) ?? undefined,
        title: activeTab.title
      });
    } else {
      await setOptimizerTabPaused(activeTab.id, activeTab.url);
      try {
        await removeAllOptimizerCssFromTab(activeTab.id);
      } catch (error) {
        console.warn("Failed to remove page optimizer CSS", activeTab.id, error);
      }
      await removeOptimizedTab(activeTab.id);
    }

    const status = await getPageOptimizerStatus();
    return {
      ...status,
      changed: wasOptimized !== enabled
    };
  });
}
