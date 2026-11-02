import { deleteRecoveryCapsule, getSettings, saveLastAutoMerge } from "../shared/storage";
import { captureRecoveryCapsule } from "./recovery";
import { exactDuplicateTabKey, selectExistingDuplicateTab } from "./scanner";
import { checkTabCloseSafety } from "./sessionSafety";

interface NewTab {
  id: number;
  // Set when the first page finishes loading, if its older copy is still loading.
  url?: string;
  waitingFor?: number;
  waitingSince?: number;
}

const STORAGE_KEY = "autoMergeNewTabs";
// A duplicate shown while its older copy kept loading may be in use by then. Past this, it stays open.
const WAITING_LIMIT_MS = 30_000;
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const operation = queue.then(task);
  queue = operation.catch(() => undefined);
  return operation;
}

async function readNewTabs(): Promise<NewTab[]> {
  const stored = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter((item): item is NewTab => item && Number.isInteger(item.id) &&
    (item.url === undefined || typeof item.url === "string") &&
    (item.waitingFor === undefined || Number.isInteger(item.waitingFor)) &&
    (item.waitingSince === undefined || Number.isFinite(item.waitingSince)));
}

function isBlankTab(tab: chrome.tabs.Tab): boolean {
  return !tab.url || tab.url === "about:blank" ||
    /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(tab.url);
}

// A tab that has not committed its navigation yet only has its address in pendingUrl.
function withPendingUrl(tab: chrome.tabs.Tab): chrome.tabs.Tab {
  return tab.pendingUrl ? { ...tab, url: tab.pendingUrl } : tab;
}

/** Track only a new tab's first page. Session storage survives worker suspension. */
async function processTab(tab: chrome.tabs.Tab, created: boolean): Promise<boolean> {
  if (typeof tab.id !== "number") return false;
  // Nothing is tracked while merging is off, so turning it on never sweeps up tabs opened before.
  if (!(await getSettings()).autoMergeDuplicateTabs) return false;
  let pending = await readNewTabs();
  const before = JSON.stringify(pending);
  // Tabs Chrome restores unloaded (session restore, reopened windows) were not opened just now.
  if (created && !tab.incognito && !tab.pinned && !tab.discarded && tab.status !== "unloaded" &&
      !pending.some(item => item.id === tab.id)) {
    pending.push({ id: tab.id });
  }
  let merged = false;
  try {
    const current = pending.find(item => item.id === tab.id);
    const key = exactDuplicateTabKey(tab);
    // If the original leaves this address, stop waiting for it. Its later return
    // must not unexpectedly close a duplicate that has become an established page.
    const originalMoved = pending.some(item => item.waitingFor === tab.id && item.url !== key);
    pending = pending.filter(item => (item.waitingFor !== tab.id || item.url === key) &&
      !(originalMoved && item.id === tab.id));
    // A later navigation must never close a tab the person has already been using.
    if (current && (tab.pinned || tab.incognito || (current.url && current.url !== key) ||
        (!key && !isBlankTab(tab) && !tab.pendingUrl && tab.status !== "loading"))) {
      pending = pending.filter(item => item !== current);
    }
    if (!key || tab.status === "loading" || tab.pendingUrl ||
        !pending.some(item => item.id === tab.id || item.url === key)) return false;

    let tabs = await chrome.tabs.query({});
    pending = pending.filter(item => tabs.some(open => open.id === item.id));
    // Process in creation order. Two simultaneous opens must keep the older copy,
    // even when the newer page finishes loading first.
    const order = new Map(pending.map((item, index) => [item.id, index]));
    for (const item of [...pending]) {
      if (item.id !== tab.id && item.url !== key) continue;
      if (item.waitingSince !== undefined && Date.now() - item.waitingSince > WAITING_LIMIT_MS) {
        pending = pending.filter(other => other !== item);
        continue;
      }
      const candidate = await chrome.tabs.get(item.id).catch(() => undefined);
      if (!candidate) {
        pending = pending.filter(other => other !== item);
        continue;
      }
      // Loading again by now: the person moved on from the page that finished, so the
      // next page is not a first page.
      if (candidate.status === "loading" || candidate.pendingUrl ||
          exactDuplicateTabKey(candidate) !== key || candidate.pinned || candidate.incognito) {
        pending = pending.filter(other => other !== item);
        continue;
      }
      const older = tabs.filter(open => typeof open.id === "number" &&
        (!order.has(open.id) || order.get(open.id)! < order.get(item.id)!));
      const existing = selectExistingDuplicateTab(candidate, older.filter(open =>
        !open.pendingUrl && open.status !== "loading"));
      if (typeof existing?.id !== "number") {
        const loadingKeeper = selectExistingDuplicateTab(candidate, older.filter(open =>
          open.pendingUrl || open.status === "loading").map(withPendingUrl));
        if (typeof loadingKeeper?.id === "number") {
          item.url = key;
          item.waitingFor = loadingKeeper.id;
          item.waitingSince ??= Date.now();
        } else {
          pending = pending.filter(other => other !== item);
        }
        continue;
      }
      // Consume the first navigation even when a draft or missing permission prevents
      // merging. Granting access later must not sweep up existing working tabs.
      pending = pending.filter(other => other !== item);
      let keeper = existing;
      let sourceWindowFocused = false;
      const safe = await checkTabCloseSafety(candidate, {
        includeActive: true,
        stillEligible: async () => {
          const [latestKeeper, latestSettings, sourceWindow] = await Promise.all([
            chrome.tabs.get(existing.id as number).catch(() => undefined), getSettings(),
            chrome.windows.get(candidate.windowId).catch(() => undefined)
          ]);
          sourceWindowFocused = sourceWindow?.focused === true;
          if (latestKeeper) keeper = latestKeeper;
          return Boolean(latestSettings.autoMergeDuplicateTabs && latestKeeper && !latestKeeper.pendingUrl &&
            latestKeeper.status !== "loading" && exactDuplicateTabKey(latestKeeper) === key);
        }
      });
      if (!safe.tab) continue;
      // The capsule is saved only for a tab that passed the safety check: saving one for every blocked
      // attempt would push the oldest real capsule out of the capped list for good.
      const capsule = await captureRecoveryCapsule("closeDuplicates", [safe.tab]).catch(() => undefined);
      const discardCapsule = () => capsule ? deleteRecoveryCapsule(capsule.id).catch(() => undefined) : undefined;
      // Writing the capsule takes a moment; a tab that changed meanwhile stays open.
      const latest = await chrome.tabs.get(item.id).catch(() => undefined);
      if (!latest || latest.status === "loading" || latest.pendingUrl || exactDuplicateTabKey(latest) !== key) {
        await discardCapsule();
        continue;
      }
      try {
        await chrome.tabs.remove(item.id);
      } catch (error) {
        // Closed by the person meanwhile: keep going with the other duplicates.
        console.warn("Automatic duplicate merge skipped a tab", item.id, error);
        await discardCapsule();
        continue;
      }
      tabs = tabs.filter(open => open.id !== item.id);
      if (safe.tab.active && (sourceWindowFocused || keeper.windowId === candidate.windowId)) {
        await chrome.tabs.update(keeper.id as number, { active: true }).catch(() => undefined);
        if (sourceWindowFocused) await chrome.windows.update(keeper.windowId, { focused: true }).catch(() => undefined);
      }
      await saveLastAutoMerge({
        mergedAt: Date.now(), closedTabId: item.id, existingTabId: keeper.id as number,
        normalizedUrl: key, title: candidate.title
      }).catch(error => console.warn("Failed to record the automatic merge", error));
      if (item.id === tab.id) merged = true;
    }
    return merged;
  } finally {
    if (JSON.stringify(pending) !== before) await chrome.storage.session.set({ [STORAGE_KEY]: pending });
  }
}

export function autoMergeCreatedTab(tab: chrome.tabs.Tab): Promise<boolean> {
  return serialize(() => processTab(tab, true));
}

export function autoMergeUpdatedTab(tab: chrome.tabs.Tab): Promise<boolean> {
  return serialize(() => processTab(tab, false));
}

export function forgetAutoMergeTab(tabId: number): Promise<void> {
  return serialize(async () => {
    const pending = await readNewTabs();
    if (pending.some(item => item.id === tabId || item.waitingFor === tabId)) {
      await chrome.storage.session.set({ [STORAGE_KEY]: pending.filter(item => item.id !== tabId && item.waitingFor !== tabId) });
    }
  });
}

/** Turning merging off forgets every tracked tab, so turning it back on never treats a tab in use as new. */
export function clearAutoMergeTracking(): Promise<void> {
  return serialize(async () => {
    if ((await readNewTabs()).length) await chrome.storage.session.set({ [STORAGE_KEY]: [] });
  });
}

/** Chrome can swap a tab for a new id (prerender, discard). Its tracking moves with it. */
export function replaceAutoMergeTab(removedTabId: number, addedTabId: number): Promise<void> {
  return serialize(async () => {
    const pending = await readNewTabs();
    if (!pending.some(item => item.id === removedTabId || item.waitingFor === removedTabId)) return;
    await chrome.storage.session.set({ [STORAGE_KEY]: pending.map(item => ({
      ...item,
      id: item.id === removedTabId ? addedTabId : item.id,
      waitingFor: item.waitingFor === removedTabId ? addedTabId : item.waitingFor
    })) });
  });
}
