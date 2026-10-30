import type {
  RecoveryCapsule,
  RecoveryCapsuleReason,
  RecoveryTabSnapshot,
  SessionTimelineSnapshot
} from "../shared/types";
import type { RestoreTarget } from "../shared/messages";
import {
  appendRecoveryCapsule,
  appendSessionTimeline,
  getRecoveryCapsules,
  getSessionTimeline,
  getSettings,
  markRecoveryCapsuleRestored
} from "../shared/storage";
import { isHttpUrl } from "../shared/url";
import { collectPressureSnapshot } from "./pressure";
import { buildSessionTopologySnapshot } from "./sessionSafety";
import { withAutoMergeSuppressed } from "./autoMergeGuard";

const CAPSULE_TTL_MS = 24 * 60 * 60_000;
const NORMAL_RESTORE_BATCH_SIZE = 4;
const HIGH_RESTORE_BATCH_SIZE = 2;
const EMERGENCY_RESTORE_BATCH_SIZE = 1;
const MAX_PRESSURE_RECHECKS = 1;
const MAX_TOTAL_PRESSURE_DELAY_MS = 3_000;
let timelineCapturePromise: Promise<SessionTimelineSnapshot | null> | null = null;
let lastTimelineCaptureAt = 0;

interface CreatedRecoveryTab {
  saved: RecoveryTabSnapshot;
  tab: chrome.tabs.Tab;
  restoredWindowId: number;
}

interface SourceWindowTabs {
  key: string;
  tabs: RecoveryTabSnapshot[];
}

function toRecoveryTab(tab: chrome.tabs.Tab): RecoveryTabSnapshot | null {
  if (!tab.url || !isHttpUrl(tab.url)) return null;
  return {
    url: tab.url,
    title: tab.title,
    originalWindowId: tab.windowId,
    originalIndex: tab.index,
    pinned: tab.pinned,
    tabId: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    active: tab.active,
    discarded: Boolean(tab.discarded)
  };
}

async function buildRecoveryTabs(tabs: chrome.tabs.Tab[]): Promise<RecoveryTabSnapshot[]> {
  const groupIds = [...new Set(
    tabs
      .map(tab => tab.groupId)
      .filter((groupId): groupId is number => typeof groupId === "number" && groupId !== -1)
  )];
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  await Promise.all(
    groupIds.map(async groupId => {
      const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
      if (group) groups.set(groupId, group);
    })
  );

  const snapshots: RecoveryTabSnapshot[] = [];
  for (const tab of tabs) {
    if (tab.incognito) continue;
    const snapshot = toRecoveryTab(tab);
    if (!snapshot) continue;
    const group = typeof tab.groupId === "number" ? groups.get(tab.groupId) : undefined;
    snapshots.push({
      ...snapshot,
      originalGroupTitle: group?.title,
      originalGroupColor: group?.color,
      originalGroupCollapsed: group?.collapsed
    });
  }
  return snapshots;
}

function topologySignature(tabs: RecoveryTabSnapshot[], capturedAt: number): string {
  const groups = new Map<number, {
    id: number;
    windowId: number;
    title?: string;
    color?: string;
    collapsed?: boolean;
  }>();
  for (const tab of tabs) {
    if (typeof tab.groupId !== "number" || tab.groupId === -1 || groups.has(tab.groupId)) continue;
    groups.set(tab.groupId, {
      id: tab.groupId,
      windowId: tab.originalWindowId ?? tab.windowId,
      title: tab.originalGroupTitle,
      color: tab.originalGroupColor,
      collapsed: tab.originalGroupCollapsed
    });
  }
  return buildSessionTopologySnapshot(
    {
      tabs: tabs.map(tab => ({
        id: tab.tabId,
        windowId: tab.originalWindowId ?? tab.windowId,
        index: tab.originalIndex,
        groupId: tab.groupId,
        url: tab.url,
        title: tab.title,
        pinned: tab.pinned,
        active: tab.active,
        discarded: tab.discarded
      })),
      groups: [...groups.values()]
    },
    { capturedAt, includeIncognito: false, metadataMode: "full" }
  ).signature;
}

export async function captureRecoveryCapsule(
  reason: RecoveryCapsuleReason,
  tabs: chrome.tabs.Tab[]
): Promise<RecoveryCapsule | null> {
  if (!chrome.storage?.local) return null;
  const restorableTabs = await buildRecoveryTabs(tabs);
  if (restorableTabs.length === 0) return null;

  const createdAt = Date.now();
  const capsule: RecoveryCapsule = {
    id: `capsule-${crypto.randomUUID()}`,
    createdAt,
    expiresAt: createdAt + CAPSULE_TTL_MS,
    reason,
    signature: topologySignature(restorableTabs, createdAt),
    tabs: restorableTabs
  };
  await appendRecoveryCapsule(capsule);
  return capsule;
}

export async function captureTimelineSnapshot(
  source: SessionTimelineSnapshot["source"] = "browserEvent",
  force = false
): Promise<SessionTimelineSnapshot | null> {
  if (!chrome.storage?.local) return null;
  if (timelineCapturePromise) return timelineCapturePromise;

  timelineCapturePromise = (async () => {
    const settings = await getSettings();
    if (!settings.timeMachineEnabled && !force) return null;

    const now = Date.now();
    const minimumInterval = Math.max(1, settings.timeMachineIntervalMinutes) * 60_000;
    const before = await getSessionTimeline();
    const persistedLastCaptureAt = before[0]?.createdAt ?? 0;
    if (!force && now - Math.max(lastTimelineCaptureAt, persistedLastCaptureAt) < minimumInterval) return null;

    const tabs = await chrome.tabs.query({});
    const snapshots = await buildRecoveryTabs(tabs);
    if (snapshots.length === 0) return null;

    const snapshot: SessionTimelineSnapshot = {
      id: `timeline-${crypto.randomUUID()}`,
      createdAt: now,
      source,
      signature: topologySignature(snapshots, now),
      tabs: snapshots
    };
    const after = await appendSessionTimeline(snapshot);
    lastTimelineCaptureAt = now;
    return after[0]?.id === before[0]?.id ? null : snapshot;
  })().finally(() => {
    timelineCapturePromise = null;
  });

  return timelineCapturePromise;
}

function sourceWindowKey(tab: RecoveryTabSnapshot): string {
  return `window:${tab.originalWindowId ?? tab.windowId}`;
}

function groupTabsBySourceWindow(tabs: RecoveryTabSnapshot[]): SourceWindowTabs[] {
  const windows = new Map<string, SourceWindowTabs>();
  for (const tab of tabs) {
    const key = sourceWindowKey(tab);
    const sourceWindow = windows.get(key) ?? { key, tabs: [] };
    sourceWindow.tabs.push(tab);
    windows.set(key, sourceWindow);
  }
  for (const sourceWindow of windows.values()) {
    sourceWindow.tabs.sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));
  }
  return [...windows.values()];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}

export function createRestorePressureGate(settings: Awaited<ReturnType<typeof getSettings>>): () => Promise<void> {
  let remainingInBatch = 0;
  let remainingDelayBudget = MAX_TOTAL_PRESSURE_DELAY_MS;

  return async () => {
    if (remainingInBatch > 0) {
      remainingInBatch -= 1;
      return;
    }

    let pressure: Awaited<ReturnType<typeof collectPressureSnapshot>> | undefined;
    for (let attempt = 0; attempt <= MAX_PRESSURE_RECHECKS; attempt += 1) {
      try {
        pressure = await collectPressureSnapshot(settings, undefined, { persistCpuSample: false, persistHistory: false });
      } catch (error) {
        console.warn("Failed to sample pressure before recovery restore", error);
        pressure = undefined;
        break;
      }

      const isEmergency = pressure.level === "emergency" || pressure.adaptive?.rawMemoryLevel === "emergency";
      const isHigh = pressure.level === "high" || pressure.adaptive?.rawMemoryLevel === "high" || pressure.memorySampleValid === false || pressure.cpuLevel === "high" || (pressure.cpuUsageRatio != null && pressure.cpuUsageRatio >= settings.cpuHighRatio);
      if ((!isEmergency && !isHigh) || attempt === MAX_PRESSURE_RECHECKS || remainingDelayBudget <= 0) {
        break;
      }

      const requestedDelay = isEmergency ? 750 : 200;
      const delay = Math.min(requestedDelay, remainingDelayBudget);
      remainingDelayBudget -= delay;
      await sleep(delay);
    }

    const batchSize = pressure?.level === "emergency" || pressure?.adaptive?.rawMemoryLevel === "emergency"
      ? EMERGENCY_RESTORE_BATCH_SIZE
      : pressure?.level === "high" || pressure?.adaptive?.rawMemoryLevel === "high" || pressure?.memorySampleValid === false || pressure?.cpuLevel === "high"
        ? HIGH_RESTORE_BATCH_SIZE
        : NORMAL_RESTORE_BATCH_SIZE;
    remainingInBatch = batchSize - 1;
  };
}

function recoveryGroupKey(saved: RecoveryTabSnapshot): string | null {
  const windowKey = sourceWindowKey(saved);
  if (typeof saved.groupId === "number" && saved.groupId !== -1) {
    return `${windowKey}\u0000group:${saved.groupId}`;
  }
  if (saved.originalGroupTitle !== undefined || saved.originalGroupColor !== undefined) {
    return `${windowKey}\u0000legacy:${saved.originalGroupTitle ?? ""}\u0000${saved.originalGroupColor ?? ""}`;
  }
  return null;
}

async function restoreGroups(createdTabs: CreatedRecoveryTab[]): Promise<void> {
  const grouped = new Map<string, {
    title?: string;
    color?: chrome.tabGroups.Color;
    collapsed?: boolean;
    items: CreatedRecoveryTab[];
  }>();

  for (const item of createdTabs) {
    if (item.tab.id == null) continue;
    const sourceGroupKey = recoveryGroupKey(item.saved);
    if (!sourceGroupKey) continue;
    const key = `${item.restoredWindowId}\u0000${sourceGroupKey}`;
    const group = grouped.get(key) ?? {
      title: item.saved.originalGroupTitle,
      color: item.saved.originalGroupColor,
      collapsed: item.saved.originalGroupCollapsed,
      items: []
    };
    group.items.push(item);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    const tabIds = group.items
      .map(item => item.tab.id)
      .filter((id): id is number => typeof id === "number");
    if (tabIds.length === 0) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds });
      const update: { title?: string; color?: chrome.tabGroups.Color; collapsed?: boolean } = {};
      if (group.title !== undefined) update.title = group.title;
      if (group.color !== undefined) update.color = group.color;
      if (group.collapsed !== undefined) update.collapsed = group.collapsed;
      if (Object.keys(update).length > 0) {
        await chrome.tabGroups.update(groupId, update);
      }
    } catch (error) {
      console.warn("Failed to restore recovery tab group", error);
    }
  }
}

async function activateRestoredTabs(createdTabs: CreatedRecoveryTab[], target: RestoreTarget): Promise<void> {
  if (target === "currentWindow") {
    const active = createdTabs.find(item => item.saved.active) ?? createdTabs[0];
    if (active?.tab.id != null) await chrome.tabs.update(active.tab.id, { active: true });
    return;
  }

  const windows = new Map<number, CreatedRecoveryTab[]>();
  for (const item of createdTabs) {
    windows.set(item.restoredWindowId, [...(windows.get(item.restoredWindowId) ?? []), item]);
  }
  for (const items of windows.values()) {
    const active = items.find(item => item.saved.active) ?? items[0];
    if (active?.tab.id != null) await chrome.tabs.update(active.tab.id, { active: true });
  }
}

async function restoreTabs(tabs: RecoveryTabSnapshot[], target: RestoreTarget): Promise<number> {
  if (tabs.length === 0) return 0;
  if (target !== "currentWindow" && target !== "newWindow") {
    throw new Error("Invalid recovery restore target.");
  }
  if (tabs.some(tab => typeof tab.url !== "string" || !isHttpUrl(tab.url))) {
    throw new Error("Recovery data contains an invalid or unsupported URL. No tabs were restored.");
  }
  const sourceWindows = groupTabsBySourceWindow(tabs);
  const [destination] = target === "currentWindow"
    ? await chrome.tabs.query({ active: true, lastFocusedWindow: true }) : [];
  if (target === "currentWindow" && destination?.windowId == null) {
    throw new Error("No active window. Choose Open in new window to restore these tabs.");
  }
  const beforeCreate = createRestorePressureGate(await getSettings());
  const createdTabs: CreatedRecoveryTab[] = [];

  if (target === "newWindow") {
    for (const [windowIndex, sourceWindow] of sourceWindows.entries()) {
      const [first, ...rest] = sourceWindow.tabs;
      if (!first) continue;
      await beforeCreate();
      const createdWindow = await withAutoMergeSuppressed(() =>
        chrome.windows.create({ url: first.url, focused: windowIndex === 0 })
      );
      const firstCreated = createdWindow.tabs?.[0]
        ?? (createdWindow.id != null ? (await chrome.tabs.query({ windowId: createdWindow.id }))[0] : undefined);
      const restoredWindowId = createdWindow.id ?? firstCreated?.windowId;
      if (restoredWindowId == null || !firstCreated) {
        throw new Error(`Failed to create recovery window ${sourceWindow.key}`);
      }
      createdTabs.push({ saved: first, tab: firstCreated, restoredWindowId });
      if (first.pinned && firstCreated.id != null) {
        await chrome.tabs.update(firstCreated.id, { pinned: true });
      }

      for (const saved of rest) {
        await beforeCreate();
        const created = await withAutoMergeSuppressed(() =>
          chrome.tabs.create({
            url: saved.url,
            windowId: restoredWindowId,
            pinned: Boolean(saved.pinned),
            active: false
          })
        );
        createdTabs.push({ saved, tab: created, restoredWindowId });
      }
    }
  } else {
    const targetWindowId = destination?.windowId;
    for (const sourceWindow of sourceWindows) {
      for (const saved of sourceWindow.tabs) {
        await beforeCreate();
        const created = await withAutoMergeSuppressed(() =>
          chrome.tabs.create({
            url: saved.url,
            windowId: targetWindowId,
            pinned: Boolean(saved.pinned),
            active: false
          })
        );
        createdTabs.push({ saved, tab: created, restoredWindowId: created.windowId });
      }
    }
  }

  await restoreGroups(createdTabs);
  await activateRestoredTabs(createdTabs, target);
  return createdTabs.length;
}

export async function restoreRecoveryCapsule(id: string, target: RestoreTarget): Promise<number> {
  const capsule = (await getRecoveryCapsules()).find(item => item.id === id);
  if (!capsule) throw new Error("Recovery capsule not found or expired.");
  const restored = await restoreTabs(capsule.tabs, target);
  await markRecoveryCapsuleRestored(id);
  await captureTimelineSnapshot("manual", true);
  return restored;
}

export async function restoreTimelineSnapshot(id: string, target: RestoreTarget): Promise<number> {
  const snapshot = (await getSessionTimeline()).find(item => item.id === id);
  if (!snapshot) throw new Error("Time Machine snapshot not found.");
  return restoreTabs(snapshot.tabs, target);
}
