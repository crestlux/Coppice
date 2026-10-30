import type { RestoreTarget } from "../shared/messages";
import type { SavedSession, SavedSessionSource, SavedTab, SessionImportResult, SaveAndCloseResult } from "../shared/types";
import { randomId, safeChromeCall } from "../shared/chromeAsync";
import {
  appendSession,
  deleteSession,
  getSessions,
  getSettings,
  moveSessionToTrash,
  renameSession,
  mergeSessions
} from "../shared/storage";
import { isHttpUrl } from "../shared/url";
import { captureRecoveryCapsule, captureTimelineSnapshot, createRestorePressureGate } from "./recovery";
import { withAutoMergeSuppressed } from "./autoMergeGuard";
import { checkTabCloseSafety } from "./sessionSafety";

const TAB_GROUP_ID_NONE = -1;
const TAB_GROUP_COLORS = new Set<chrome.tabGroups.Color>([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
]);

export interface SaveAndCloseOptions {
  includeActive: boolean;
  includePinned: boolean;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab || typeof activeTab.windowId !== "number") {
    throw new Error("No active window");
  }
  return activeTab;
}

async function toSavedTab(tab: chrome.tabs.Tab): Promise<SavedTab> {
  let group: chrome.tabGroups.TabGroup | null = null;

  if (typeof tab.groupId === "number" && tab.groupId !== TAB_GROUP_ID_NONE) {
    group = await safeChromeCall("tabGroups.get", () => chrome.tabGroups.get(tab.groupId as number));
  }

  return {
    url: tab.url as string,
    title: tab.title,
    originalWindowId: tab.windowId,
    originalIndex: tab.index,
    originalGroupId: group ? tab.groupId : undefined,
    originalGroupTitle: group?.title,
    originalGroupColor: group?.color,
    originalGroupCollapsed: group?.collapsed,
    pinned: tab.pinned
  };
}

function filterSavableTabs(tabs: chrome.tabs.Tab[], options: SaveAndCloseOptions): chrome.tabs.Tab[] {
  return tabs
    .filter(tab => {
      if (typeof tab.id !== "number" || !tab.url) return false;
      if (tab.incognito) return false;
      if (!isHttpUrl(tab.url)) return false;
      if (!options.includeActive && tab.active) return false;
      if (!options.includePinned && tab.pinned) return false;
      return true;
    })
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
}

async function createSessionFromTabs(
  source: SavedSessionSource,
  namePrefix: string,
  tabs: chrome.tabs.Tab[],
  options: SaveAndCloseOptions
): Promise<SaveAndCloseResult> {
  const tabsToSave = filterSavableTabs(tabs, options);

  if (tabsToSave.length === 0) {
    throw new Error("No eligible tabs to save");
  }

  const savedTabs = await Promise.all(tabsToSave.map(toSavedTab));
  const session: SavedSession = {
    id: randomId("session"),
    name: `${namePrefix} ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    source,
    tabs: savedTabs
  };

  await appendSession(session);

  await captureRecoveryCapsule("saveAndClose", tabsToSave);
  let closedCount = 0;
  // Closing the active tab first activates another candidate. Close it last so
  // our own focus change is not mistaken for the user returning to that page.
  for (const tab of [...tabsToSave].sort((a, b) => Number(a.active) - Number(b.active))) {
    const safe = await checkTabCloseSafety(tab, options);
    if (!safe.tab) continue;
    await chrome.tabs.remove(safe.tab.id as number);
    closedCount += 1;
  }
  await captureTimelineSnapshot("manual", true);

  return { ...session, closedCount, keptOpenCount: tabsToSave.length - closedCount };
}

export async function saveCurrentWindowAndClose(options: SaveAndCloseOptions): Promise<SaveAndCloseResult> {
  const activeTab = await getActiveTab();
  const tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  return createSessionFromTabs("window", "Window Session", tabs, options);
}

export async function saveCurrentGroupAndClose(options: SaveAndCloseOptions): Promise<SaveAndCloseResult> {
  const activeTab = await getActiveTab();
  if (typeof activeTab.groupId !== "number" || activeTab.groupId === TAB_GROUP_ID_NONE) {
    throw new Error("Active tab is not in a group");
  }

  const tabs = await chrome.tabs.query({
    windowId: activeTab.windowId,
    groupId: activeTab.groupId
  });

  return createSessionFromTabs("group", "Group Session", tabs, options);
}

export async function saveSelectedTabsAndClose(options: SaveAndCloseOptions): Promise<SaveAndCloseResult> {
  const activeTab = await getActiveTab();
  const tabs = await chrome.tabs.query({
    windowId: activeTab.windowId,
    highlighted: true
  });

  return createSessionFromTabs("selection", "Selected Tabs Session", tabs, options);
}

async function createTabForRestore(savedTab: SavedTab, targetWindowId?: number, active = false): Promise<chrome.tabs.Tab> {
  return withAutoMergeSuppressed(() =>
    chrome.tabs.create({
      url: savedTab.url,
      windowId: targetWindowId,
      pinned: Boolean(savedTab.pinned),
      active
    })
  );
}

async function restoreGroups(createdTabs: Array<{ savedTab: SavedTab; tab: chrome.tabs.Tab }>): Promise<void> {
  const grouped = new Map<string, Array<{ savedTab: SavedTab; tab: chrome.tabs.Tab }>>();

  for (const item of createdTabs) {
    if (
      (item.savedTab.originalGroupId == null &&
        item.savedTab.originalGroupTitle === undefined &&
        item.savedTab.originalGroupColor === undefined &&
        item.savedTab.originalGroupCollapsed === undefined) ||
      typeof item.tab.id !== "number"
    ) {
      continue;
    }

    const windowKey = item.savedTab.originalWindowId ?? "legacy-window";
    const groupKey = item.savedTab.originalGroupId != null
      ? `group:${item.savedTab.originalGroupId}`
      : `legacy:${item.savedTab.originalGroupTitle ?? ""}\u0000${item.savedTab.originalGroupColor ?? ""}`;
    const key = `${windowKey}\u0000${groupKey}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }

  for (const items of grouped.values()) {
    const metadata = items[0]?.savedTab;
    const tabIds = items.map(item => item.tab.id).filter((id): id is number => typeof id === "number");
    if (tabIds.length === 0) continue;

    try {
      const groupId = await chrome.tabs.group({ tabIds });
      const update: { title?: string; color?: chrome.tabGroups.Color; collapsed?: boolean } = {};
      if (metadata?.originalGroupTitle !== undefined) update.title = metadata.originalGroupTitle;
      if (metadata?.originalGroupColor !== undefined) update.color = metadata.originalGroupColor;
      if (metadata?.originalGroupCollapsed !== undefined) update.collapsed = metadata.originalGroupCollapsed;
      if (Object.keys(update).length > 0) await chrome.tabGroups.update(groupId, update);
    } catch (error) {
      console.warn("Failed to restore tab group", metadata?.originalGroupTitle, error);
    }
  }
}

export async function restoreSession(sessionId: string, target: RestoreTarget): Promise<number> {
  const sessions = await getSessions();
  const session = sessions.find(item => item.id === sessionId);
  if (!session) throw new Error("Session not found");
  if (session.tabs.length === 0) return 0;
  if (target !== "currentWindow" && target !== "newWindow") throw new Error("Invalid session restore target.");
  if (session.tabs.some(tab => typeof tab.url !== "string" || !isHttpUrl(tab.url))) {
    throw new Error("Session contains an invalid or unsupported URL. No tabs were restored.");
  }

  const createdTabs: Array<{ savedTab: SavedTab; tab: chrome.tabs.Tab }> = [];
  // Resolve the destination before pressure checks or snapshot writes yield.
  // Omitting windowId on every create follows the user's changing focus.
  let targetWindowId = target === "currentWindow" ? (await getActiveTab()).windowId : undefined;
  await captureTimelineSnapshot("manual", true);
  const beforeCreate = createRestorePressureGate(await getSettings());

  if (target === "newWindow") {
    const [first, ...rest] = session.tabs;
    await beforeCreate();
    const createdWindow = await withAutoMergeSuppressed(() => chrome.windows.create({ url: first.url, focused: true }));
    targetWindowId = createdWindow.id ?? createdWindow.tabs?.[0]?.windowId;
    const firstTab = createdWindow.tabs?.[0] ?? (targetWindowId != null ? (await chrome.tabs.query({ windowId: targetWindowId }))[0] : undefined);

    if (!firstTab || targetWindowId == null) throw new Error("Chrome created the restore window without a tab.");
    createdTabs.push({ savedTab: first, tab: firstTab });
    if (first.pinned && firstTab.id != null) await chrome.tabs.update(firstTab.id, { pinned: true });

    for (const savedTab of rest) {
      await beforeCreate();
      createdTabs.push({ savedTab, tab: await createTabForRestore(savedTab, targetWindowId, false) });
    }
  } else {
    for (const [index, savedTab] of session.tabs.entries()) {
      await beforeCreate();
      createdTabs.push({ savedTab, tab: await createTabForRestore(savedTab, targetWindowId, index === 0) });
    }
  }

  await restoreGroups(createdTabs);
  await captureTimelineSnapshot("manual", true);
  return createdTabs.length;
}

export async function removeSession(sessionId: string): Promise<SavedSession[]> {
  const session = (await getSessions()).find(item => item.id === sessionId);
  if (!session) throw new Error("Session not found");
  await moveSessionToTrash(session);
  return deleteSession(sessionId);
}

export async function updateSessionName(sessionId: string, name: string): Promise<SavedSession[]> {
  return renameSession(sessionId, name.trim() || "Untitled Session");
}

export function isValidSavedSession(session: SavedSession): boolean {
  return (
    typeof session.id === "string" &&
    typeof session.name === "string" &&
    Array.isArray(session.tabs) &&
    session.tabs.every(tab => typeof tab.url === "string" && isHttpUrl(tab.url))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timestampValue(value: unknown): number {
  const numeric = numberValue(value);
  if (numeric != null) return numeric;

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return Date.now();
}

function sessionSourceValue(value: unknown): SavedSessionSource {
  return value === "group" || value === "selection" || value === "window" ? value : "window";
}

function tabGroupColorValue(value: unknown): chrome.tabGroups.Color | undefined {
  return typeof value === "string" && TAB_GROUP_COLORS.has(value as chrome.tabGroups.Color)
    ? (value as chrome.tabGroups.Color)
    : undefined;
}

function looksLikeTabInput(value: unknown): boolean {
  return typeof value === "string" || (isObject(value) && typeof value.url === "string");
}

function sessionImportCandidates(payload: unknown): unknown[] {
  if (isObject(payload) && Array.isArray(payload.sessions)) {
    return payload.sessions;
  }

  if (Array.isArray(payload)) {
    if (payload.length > 0 && payload.every(looksLikeTabInput)) {
      return [{ name: "Imported Session", tabs: payload }];
    }
    return payload;
  }

  return [payload];
}

function normalizeSavedTabInput(input: unknown): SavedTab | null {
  if (typeof input === "string") {
    return isHttpUrl(input) ? { url: input } : null;
  }

  if (!isObject(input) || typeof input.url !== "string" || !isHttpUrl(input.url)) {
    return null;
  }

  return {
    url: input.url,
    title: stringValue(input.title),
    originalWindowId: numberValue(input.originalWindowId),
    originalIndex: numberValue(input.originalIndex),
    originalGroupId: numberValue(input.originalGroupId),
    originalGroupTitle: stringValue(input.originalGroupTitle),
    originalGroupColor: tabGroupColorValue(input.originalGroupColor),
    originalGroupCollapsed: booleanValue(input.originalGroupCollapsed),
    pinned: booleanValue(input.pinned)
  };
}

function normalizeSavedSessionInput(input: unknown, index: number): SavedSession | null {
  if (!isObject(input)) {
    return null;
  }

  const rawTabs = Array.isArray(input.tabs)
    ? input.tabs
    : Array.isArray(input.urls)
      ? input.urls
      : [];
  const tabs = rawTabs.map(normalizeSavedTabInput).filter((tab): tab is SavedTab => tab !== null);

  if (tabs.length === 0) {
    return null;
  }

  return {
    id: stringValue(input.id) ?? randomId("session"),
    name: stringValue(input.name) ?? `Imported Session ${index + 1}`,
    createdAt: timestampValue(input.createdAt),
    source: sessionSourceValue(input.source),
    tabs
  };
}

export function normalizeSessionImportPayload(payload: unknown): { sessions: SavedSession[]; skippedCount: number } {
  const candidates = sessionImportCandidates(payload);
  const sessions = candidates
    .map((candidate, index) => normalizeSavedSessionInput(candidate, index))
    .filter((session): session is SavedSession => session !== null);

  return {
    sessions,
    skippedCount: candidates.length - sessions.length
  };
}

export async function importSessions(payload: unknown): Promise<SessionImportResult> {
  const { sessions: importedSessions, skippedCount } = normalizeSessionImportPayload(payload);

  if (importedSessions.length === 0) {
    throw new Error("No valid sessions found in JSON");
  }

  await mergeSessions(importedSessions);

  return {
    importedCount: importedSessions.length,
    skippedCount,
    sessions: await getSessions()
  };
}
