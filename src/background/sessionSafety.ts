import { DEFAULT_SETTINGS } from "../shared/constants";
import { getProtectionRules, getSettings, getTemporaryTabProtections } from "../shared/storage";
import { getHostname, matchesProtectedDomain, matchesProtectedUrlPattern } from "../shared/url";
import { checkUnsavedWork } from "./workProtection";

export type CloseSafetyReason = "changed" | "protected" | "missing";

export interface CloseSafetyOptions {
  includeActive?: boolean;
  includePinned?: boolean;
  stillEligible?: () => Promise<boolean>;
}

/** A URL snapshot restores navigation, never an unsaved document. Check before every close. */
export async function checkTabCloseSafety(
  expected: chrome.tabs.Tab,
  options: CloseSafetyOptions = {}
): Promise<{ tab: chrome.tabs.Tab; reason?: never } | { tab?: never; reason: CloseSafetyReason }> {
  if (typeof expected.id !== "number") return { reason: "missing" };
  const settings = chrome.storage?.local ? await getSettings() : DEFAULT_SETTINGS;
  const inspect = (tab: chrome.tabs.Tab | undefined): CloseSafetyReason | undefined => {
    if (!tab) return "missing";
    if (tab.url !== expected.url || tab.pendingUrl || tab.status === "loading" ||
        tab.windowId !== expected.windowId || tab.groupId !== expected.groupId ||
        tab.lastAccessed !== expected.lastAccessed || tab.discarded !== expected.discarded ||
        tab.frozen !== expected.frozen || (!options.includeActive && tab.active) ||
        (tab.active && !expected.active)) return "changed";
    if (tab.incognito || (!options.includePinned && tab.pinned) ||
        (settings.protectAudible && tab.audible) ||
        (settings.respectAutoDiscardableFalse && tab.autoDiscardable === false)) return "protected";
    return undefined;
  };
  let tab = await chrome.tabs.get(expected.id).catch(() => undefined);
  const reason = inspect(tab);
  if (reason) return { reason };
  // A discarded page has no live document to inspect; probing would be both pointless and costly.
  if (!tab!.discarded && (settings.protectUnsavedWork || settings.protectAudible)) {
    const workState = await checkUnsavedWork(expected.id, {
      protectUnsavedWork: settings.protectUnsavedWork,
      protectMedia: settings.protectAudible
    });
    if ((settings.protectUnsavedWork && (workState === "unsavedWork" || workState === "workStateUnknown")) ||
        (settings.protectAudible && workState === "activeMedia")) return { reason: "protected" };
  }
  // Read each protection collection once, after the potentially slow frame
  // inspection, so a Keep loaded action during that inspection is respected.
  const [rules, temporary] = await Promise.all([
    chrome.storage?.local ? getProtectionRules() : Promise.resolve([]),
    chrome.storage?.session ? getTemporaryTabProtections() : Promise.resolve([])
  ]);
  const domain = getHostname(expected.url);
  if (temporary.some(protection => protection.tabId === expected.id) ||
      (domain && matchesProtectedDomain(domain, rules)) ||
      (expected.url && matchesProtectedUrlPattern(expected.url, rules))) return { reason: "protected" };
  // In a duplicate cleanup the keeper may disappear while the page is checked.
  if (options.stillEligible && !await options.stillEligible()) return { reason: "changed" };
  // Recheck the candidate after every asynchronous guard, including the keeper.
  tab = await chrome.tabs.get(expected.id).catch(() => undefined);
  const latestReason = inspect(tab);
  return latestReason ? { reason: latestReason } : { tab: tab! };
}

export const SESSION_SAFETY_SCHEMA_VERSION = 1 as const;

export type SnapshotMetadataMode = "full" | "urlsOnly" | "structureOnly";

export type SnapshotWindowState = "normal" | "minimized" | "maximized" | "fullscreen" | "locked-fullscreen";

export interface SessionTabLike {
  id?: number;
  windowId: number;
  index?: number;
  groupId?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  pinned?: boolean;
  active?: boolean;
  muted?: boolean;
  discarded?: boolean;
  incognito?: boolean;
}

export interface SessionWindowLike {
  id?: number;
  order?: number;
  focused?: boolean;
  incognito?: boolean;
  state?: SnapshotWindowState;
}

export interface SessionGroupLike {
  id: number;
  windowId: number;
  title?: string;
  color?: string;
  collapsed?: boolean;
}

export interface SessionTopologyInput {
  tabs: readonly SessionTabLike[];
  windows?: readonly SessionWindowLike[];
  groups?: readonly SessionGroupLike[];
}

export interface SnapshotTab {
  key: string;
  sourceTabId?: number;
  index: number;
  groupKey?: string;
  url?: string;
  title?: string;
  favIconUrl?: string;
  pinned: boolean;
  active: boolean;
  muted: boolean;
  discarded: boolean;
}

export interface SnapshotGroup {
  key: string;
  sourceGroupId?: number;
  title?: string;
  color?: string;
  collapsed: boolean;
  memberTabKeys: string[];
}

export interface SnapshotWindow {
  key: string;
  sourceWindowId?: number;
  order: number;
  focused: boolean;
  state: SnapshotWindowState;
  groups: SnapshotGroup[];
  tabs: SnapshotTab[];
}

export interface SessionTopologySnapshot {
  schemaVersion: typeof SESSION_SAFETY_SCHEMA_VERSION;
  capturedAt: number;
  metadataMode: SnapshotMetadataMode;
  signature: string;
  totalTabCount: number;
  restorableTabCount: number;
  windows: SnapshotWindow[];
}

export interface SnapshotOptions {
  capturedAt: number;
  includeIncognito?: boolean;
  metadataMode?: SnapshotMetadataMode;
}

export type RecoveryCapsuleReason =
  | "bulkAction"
  | "emergencyCleanup"
  | "manual"
  | "sessionRestore"
  | "other";

export interface RecoveryCapsule {
  schemaVersion: typeof SESSION_SAFETY_SCHEMA_VERSION;
  id: string;
  reason: RecoveryCapsuleReason;
  actionLabel?: string;
  createdAt: number;
  expiresAt: number;
  snapshotSignature: string;
  snapshot: SessionTopologySnapshot;
}

export interface CreateRecoveryCapsuleOptions {
  now: number;
  ttlMs: number;
  reason: RecoveryCapsuleReason;
  id?: string;
  actionLabel?: string;
  metadataMode?: SnapshotMetadataMode;
}

export type RestoreSkipReason = "discardedExcluded" | "missingUrl" | "unsupportedProtocol";

export interface RestoreSkippedTab {
  tabKey: string;
  windowKey: string;
  reason: RestoreSkipReason;
  url?: string;
}

export interface RestoreTabStep {
  tabKey: string;
  windowKey: string;
  url: string;
  title?: string;
  createOrder: number;
  finalIndex: number;
  pinned: boolean;
  active: boolean;
  discarded: boolean;
  groupKey?: string;
}

export interface RestoreGroupStep {
  groupKey: string;
  title?: string;
  color?: string;
  collapsed: boolean;
  memberTabKeys: string[];
}

export interface RestoreWindowPlan {
  windowKey: string;
  sourceWindowId?: number;
  order: number;
  focused: boolean;
  state: SnapshotWindowState;
  anchorTabKey: string;
  activeTabKey: string;
  createTabs: RestoreTabStep[];
  groups: RestoreGroupStep[];
}

export interface RestoreOrderingPlan {
  schemaVersion: typeof SESSION_SAFETY_SCHEMA_VERSION;
  snapshotSignature: string;
  totalTabCount: number;
  restorableTabCount: number;
  windows: RestoreWindowPlan[];
  skippedTabs: RestoreSkippedTab[];
}

export interface RestorePlanOptions {
  allowedProtocols?: readonly string[];
  includeDiscarded?: boolean;
}

export type TimelineSnapshotReason = "automatic" | "browserStartup" | "browserShutdown" | "manual" | "recovery";

export interface TimelineSnapshot {
  schemaVersion: typeof SESSION_SAFETY_SCHEMA_VERSION;
  id: string;
  createdAt: number;
  reason: TimelineSnapshotReason;
  signature: string;
  snapshot: SessionTopologySnapshot;
}

export interface TimelineRetentionOptions {
  now: number;
  maxItems: number;
  maxAgeMs: number;
}

export interface AppendTimelineOptions extends TimelineRetentionOptions {
  reason: TimelineSnapshotReason;
  id?: string;
  minimumIntervalMs?: number;
}

export interface AppendTimelineResult {
  snapshots: TimelineSnapshot[];
  entry?: TimelineSnapshot;
  status: "added" | "coalesced" | "disabled" | "duplicate";
}

export interface SessionIdentity {
  id: string;
}

export interface SessionMetadataTab {
  url?: string;
  title?: string;
  favIconUrl?: string;
  domain?: string;
  originalGroupTitle?: string;
}

export interface SessionMetadataShape extends SessionIdentity {
  name: string;
  tabs: readonly SessionMetadataTab[];
}

export interface SessionTrashItem<T extends SessionIdentity = SessionIdentity> {
  schemaVersion: typeof SESSION_SAFETY_SCHEMA_VERSION;
  trashId: string;
  deletedAt: number;
  expiresAt: number;
  originalIndex: number;
  session: T;
}

export interface MoveSessionToTrashOptions<T extends SessionIdentity> {
  now: number;
  ttlMs: number;
  trashId?: string;
  sanitize?: (session: T) => T;
}

export interface MoveSessionToTrashResult<T extends SessionIdentity> {
  sessions: T[];
  trash: Array<SessionTrashItem<T>>;
  moved?: SessionTrashItem<T>;
}

export type RestoreTrashConflictMode = "copy" | "replace" | "skip";

export interface RestoreSessionFromTrashOptions {
  now: number;
  onConflict?: RestoreTrashConflictMode;
  copyId?: string;
}

export interface RestoreSessionFromTrashResult<T extends SessionIdentity> {
  sessions: T[];
  trash: Array<SessionTrashItem<T>>;
  restoredSession?: T;
  status: "conflict" | "copied" | "expired" | "notFound" | "replaced" | "restored";
}

export type RestoreQueuePriority = "windowAnchor" | "user" | "active" | "pinned" | "normal";

export interface RestoreQueueItem {
  id: string;
  tabKey: string;
  windowKey: string;
  url: string;
  priority: RestoreQueuePriority;
  order: number;
}

export interface CreateRestoreQueueOptions {
  priorityTabKeys?: readonly string[];
}

export interface RestorePressureState {
  level: "normal" | "high" | "emergency";
  cpuUsageRatio?: number | null;
}

export interface RestoreBatchOptions {
  normalBatchSize?: number;
  highBatchSize?: number;
  cpuHighRatio?: number;
  pauseOnHighCpu?: boolean;
  retryAfterMs?: number;
}

export interface RestoreBatchDecision {
  action: "complete" | "pause" | "restore";
  reason: "emergencyPressure" | "highCpu" | "highPressure" | "queueEmpty" | "ready";
  batch: RestoreQueueItem[];
  remaining: RestoreQueueItem[];
  retryAfterMs?: number;
}

interface IndexedTab {
  input: SessionTabLike;
  inputOrder: number;
}

const METADATA_PRIVACY_RANK: Record<SnapshotMetadataMode, number> = {
  full: 0,
  urlsOnly: 1,
  structureOnly: 2
};

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function normalizeProtocol(protocol: string): string {
  const normalized = protocol.trim().toLowerCase();
  return normalized.endsWith(":") ? normalized : `${normalized}:`;
}

function isRestorableUrl(url: string | undefined, allowedProtocols: ReadonlySet<string>): boolean {
  if (!url) return false;
  try {
    return allowedProtocols.has(new URL(url).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function strongerPrivacyMode(current: SnapshotMetadataMode, requested: SnapshotMetadataMode): SnapshotMetadataMode {
  return METADATA_PRIVACY_RANK[current] >= METADATA_PRIVACY_RANK[requested] ? current : requested;
}

function applyTabMetadataMode(tab: SnapshotTab, mode: SnapshotMetadataMode): SnapshotTab {
  const result = { ...tab };
  if (mode !== "full") {
    delete result.title;
    delete result.favIconUrl;
  }
  if (mode === "structureOnly") {
    delete result.url;
  }
  return result;
}

function signatureHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeTopologySignature(snapshot: SessionTopologySnapshot): string {
  const payload = snapshot.windows.map(window => ({
    state: window.state,
    groups: window.groups.map(group => ({
      key: group.key,
      title: group.title ?? null,
      color: group.color ?? null,
      collapsed: group.collapsed,
      members: group.memberTabKeys
    })),
    tabs: window.tabs.map(tab => ({
      url: tab.url ?? null,
      pinned: tab.pinned,
      active: tab.active,
      muted: tab.muted,
      discarded: tab.discarded,
      groupKey: tab.groupKey ?? null
    }))
  }));
  return `topology-v${SESSION_SAFETY_SCHEMA_VERSION}-${signatureHash(JSON.stringify(payload))}`;
}

export function buildSessionTopologySnapshot(
  input: SessionTopologyInput,
  options: SnapshotOptions
): SessionTopologySnapshot {
  const metadataMode = options.metadataMode ?? "full";
  const includeIncognito = options.includeIncognito ?? false;
  const suppliedWindows = (input.windows ?? []).filter(window => includeIncognito || !window.incognito);
  const permittedWindowIds = new Set(
    suppliedWindows
      .map(window => window.id)
      .filter((id): id is number => typeof id === "number")
  );
  const indexedTabs: IndexedTab[] = input.tabs
    .map((tab, inputOrder) => ({ input: tab, inputOrder }))
    .filter(({ input: tab }) => {
      if (!includeIncognito && tab.incognito) return false;
      if (!includeIncognito && input.windows?.some(window => window.id === tab.windowId && window.incognito)) return false;
      return suppliedWindows.length === 0 || permittedWindowIds.has(tab.windowId) || !input.windows?.some(window => window.id === tab.windowId);
    });

  const windowIds = new Set<number>();
  for (const window of suppliedWindows) {
    if (typeof window.id === "number") windowIds.add(window.id);
  }
  for (const { input: tab } of indexedTabs) windowIds.add(tab.windowId);

  const suppliedWindowById = new Map(
    suppliedWindows
      .filter((window): window is SessionWindowLike & { id: number } => typeof window.id === "number")
      .map(window => [window.id, window])
  );
  const sortedWindowIds = [...windowIds].sort((left, right) => {
    const leftWindow = suppliedWindowById.get(left);
    const rightWindow = suppliedWindowById.get(right);
    const leftOrder = finiteOr(leftWindow?.order, left);
    const rightOrder = finiteOr(rightWindow?.order, right);
    return compareNumbers(leftOrder, rightOrder) || compareNumbers(left, right);
  });
  const groupById = new Map((input.groups ?? []).map(group => [group.id, group]));

  const windows: SnapshotWindow[] = sortedWindowIds.map((windowId, windowIndex) => {
    const sourceWindow = suppliedWindowById.get(windowId);
    const windowTabs = indexedTabs
      .filter(({ input: tab }) => tab.windowId === windowId)
      .sort((left, right) => {
        const indexDifference = compareNumbers(
          finiteOr(left.input.index, left.inputOrder),
          finiteOr(right.input.index, right.inputOrder)
        );
        return indexDifference || compareNumbers(finiteOr(left.input.id, left.inputOrder), finiteOr(right.input.id, right.inputOrder));
      });
    const groupIds = [...new Set(
      windowTabs
        .map(({ input: tab }) => tab.groupId)
        .filter((groupId): groupId is number => typeof groupId === "number" && groupId >= 0)
    )].sort((left, right) => {
      const firstLeft = windowTabs.findIndex(({ input: tab }) => tab.groupId === left);
      const firstRight = windowTabs.findIndex(({ input: tab }) => tab.groupId === right);
      return compareNumbers(firstLeft, firstRight) || compareNumbers(left, right);
    });
    const groupKeyById = new Map(groupIds.map((groupId, index) => [groupId, `g${windowIndex + 1}-${index + 1}`]));
    const tabs: SnapshotTab[] = windowTabs.map(({ input: tab }, tabIndex) => {
      const snapshotTab: SnapshotTab = {
        key: `t${windowIndex + 1}-${tabIndex + 1}`,
        sourceTabId: tab.id,
        index: tabIndex,
        groupKey: typeof tab.groupId === "number" ? groupKeyById.get(tab.groupId) : undefined,
        url: metadataMode === "structureOnly" ? undefined : tab.url,
        title: metadataMode === "full" ? tab.title : undefined,
        favIconUrl: metadataMode === "full" ? tab.favIconUrl : undefined,
        pinned: Boolean(tab.pinned),
        active: Boolean(tab.active),
        muted: Boolean(tab.muted),
        discarded: Boolean(tab.discarded)
      };
      return snapshotTab;
    });
    const groups: SnapshotGroup[] = groupIds.map(groupId => {
      const sourceGroup = groupById.get(groupId);
      const key = groupKeyById.get(groupId) as string;
      return {
        key,
        sourceGroupId: groupId,
        title: metadataMode === "full" ? sourceGroup?.title : undefined,
        color: sourceGroup?.color,
        collapsed: Boolean(sourceGroup?.collapsed),
        memberTabKeys: tabs.filter(tab => tab.groupKey === key).map(tab => tab.key)
      };
    });
    return {
      key: `w${windowIndex + 1}`,
      sourceWindowId: windowId,
      order: windowIndex,
      focused: Boolean(sourceWindow?.focused),
      state: sourceWindow?.state ?? "normal",
      groups,
      tabs
    };
  });

  const allowedProtocols = new Set(["http:", "https:"]);
  const snapshot: SessionTopologySnapshot = {
    schemaVersion: SESSION_SAFETY_SCHEMA_VERSION,
    capturedAt: options.capturedAt,
    metadataMode,
    signature: "",
    totalTabCount: windows.reduce((total, window) => total + window.tabs.length, 0),
    restorableTabCount: windows.reduce(
      (total, window) => total + window.tabs.filter(tab => isRestorableUrl(tab.url, allowedProtocols)).length,
      0
    ),
    windows
  };
  snapshot.signature = computeTopologySignature(snapshot);
  return snapshot;
}

export function stripSnapshotMetadata(
  snapshot: SessionTopologySnapshot,
  requestedMode: SnapshotMetadataMode
): SessionTopologySnapshot {
  const metadataMode = strongerPrivacyMode(snapshot.metadataMode, requestedMode);
  const windows = snapshot.windows.map(window => ({
    ...window,
    groups: window.groups.map(group => ({
      ...group,
      title: metadataMode === "full" ? group.title : undefined,
      memberTabKeys: [...group.memberTabKeys]
    })),
    tabs: window.tabs.map(tab => applyTabMetadataMode(tab, metadataMode))
  }));
  const allowedProtocols = new Set(["http:", "https:"]);
  const result: SessionTopologySnapshot = {
    ...snapshot,
    metadataMode,
    windows,
    restorableTabCount: windows.reduce(
      (total, window) => total + window.tabs.filter(tab => isRestorableUrl(tab.url, allowedProtocols)).length,
      0
    ),
    signature: ""
  };
  result.signature = computeTopologySignature(result);
  return result;
}

function validatePositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
}

export function createRecoveryCapsule(
  snapshot: SessionTopologySnapshot,
  options: CreateRecoveryCapsuleOptions
): RecoveryCapsule {
  validatePositiveDuration(options.ttlMs, "ttlMs");
  const storedSnapshot = stripSnapshotMetadata(snapshot, options.metadataMode ?? snapshot.metadataMode);
  const id = options.id ?? `capsule-${options.now.toString(36)}-${storedSnapshot.signature.slice(-8)}`;
  return {
    schemaVersion: SESSION_SAFETY_SCHEMA_VERSION,
    id,
    reason: options.reason,
    actionLabel: options.actionLabel,
    createdAt: options.now,
    expiresAt: options.now + options.ttlMs,
    snapshotSignature: storedSnapshot.signature,
    snapshot: storedSnapshot
  };
}

export function isRecoveryCapsuleExpired(capsule: RecoveryCapsule, now: number): boolean {
  return capsule.expiresAt <= now;
}

export function pruneRecoveryCapsules(capsules: readonly RecoveryCapsule[], now: number): RecoveryCapsule[] {
  return capsules
    .filter(capsule => !isRecoveryCapsuleExpired(capsule, now))
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

export function buildRestoreOrderingPlan(
  snapshot: SessionTopologySnapshot,
  options: RestorePlanOptions = {}
): RestoreOrderingPlan {
  const allowedProtocols = new Set((options.allowedProtocols ?? ["http:", "https:"]).map(normalizeProtocol));
  const includeDiscarded = options.includeDiscarded ?? true;
  const skippedTabs: RestoreSkippedTab[] = [];
  const windows: RestoreWindowPlan[] = [];

  for (const window of snapshot.windows) {
    const eligibleTabs: SnapshotTab[] = [];
    for (const tab of window.tabs) {
      if (!includeDiscarded && tab.discarded) {
        skippedTabs.push({ tabKey: tab.key, windowKey: window.key, reason: "discardedExcluded", url: tab.url });
      } else if (!tab.url) {
        skippedTabs.push({ tabKey: tab.key, windowKey: window.key, reason: "missingUrl" });
      } else if (!isRestorableUrl(tab.url, allowedProtocols)) {
        skippedTabs.push({ tabKey: tab.key, windowKey: window.key, reason: "unsupportedProtocol", url: tab.url });
      } else {
        eligibleTabs.push(tab);
      }
    }
    if (eligibleTabs.length === 0) continue;

    const creationTabs = [...eligibleTabs].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return compareNumbers(left.index, right.index) || left.key.localeCompare(right.key);
    });
    const createTabs = creationTabs.map((tab, createOrder): RestoreTabStep => ({
      tabKey: tab.key,
      windowKey: window.key,
      url: tab.url as string,
      title: tab.title,
      createOrder,
      finalIndex: tab.index,
      pinned: tab.pinned,
      active: tab.active,
      discarded: tab.discarded,
      groupKey: tab.groupKey
    }));
    const eligibleKeys = new Set(eligibleTabs.map(tab => tab.key));
    const groups = window.groups
      .map((group): RestoreGroupStep => ({
        groupKey: group.key,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        memberTabKeys: group.memberTabKeys.filter(tabKey => eligibleKeys.has(tabKey))
      }))
      .filter(group => group.memberTabKeys.length > 0);
    const activeTab = eligibleTabs.find(tab => tab.active) ?? creationTabs[0];
    windows.push({
      windowKey: window.key,
      sourceWindowId: window.sourceWindowId,
      order: window.order,
      focused: window.focused,
      state: window.state,
      anchorTabKey: createTabs[0].tabKey,
      activeTabKey: activeTab.key,
      createTabs,
      groups
    });
  }

  return {
    schemaVersion: SESSION_SAFETY_SCHEMA_VERSION,
    snapshotSignature: snapshot.signature,
    totalTabCount: snapshot.totalTabCount,
    restorableTabCount: windows.reduce((total, window) => total + window.createTabs.length, 0),
    windows,
    skippedTabs
  };
}

function timelineSort(left: TimelineSnapshot, right: TimelineSnapshot): number {
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}

export function pruneTimelineSnapshots(
  snapshots: readonly TimelineSnapshot[],
  options: TimelineRetentionOptions
): TimelineSnapshot[] {
  const maxItems = Math.max(0, Math.floor(options.maxItems));
  if (maxItems === 0 || !Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0) return [];
  const oldestAllowed = options.now - options.maxAgeMs;
  return [...snapshots]
    .filter(snapshot => snapshot.createdAt >= oldestAllowed && snapshot.createdAt <= options.now)
    .sort(timelineSort)
    .slice(0, maxItems);
}

function createTimelineSnapshot(
  snapshot: SessionTopologySnapshot,
  options: AppendTimelineOptions
): TimelineSnapshot {
  const storedSnapshot = stripSnapshotMetadata(snapshot, snapshot.metadataMode);
  return {
    schemaVersion: SESSION_SAFETY_SCHEMA_VERSION,
    id: options.id ?? `timeline-${options.now.toString(36)}-${storedSnapshot.signature.slice(-8)}`,
    createdAt: options.now,
    reason: options.reason,
    signature: storedSnapshot.signature,
    snapshot: storedSnapshot
  };
}

export function appendTimelineSnapshot(
  existing: readonly TimelineSnapshot[],
  snapshot: SessionTopologySnapshot,
  options: AppendTimelineOptions
): AppendTimelineResult {
  const retained = pruneTimelineSnapshots(existing, options);
  if (Math.max(0, Math.floor(options.maxItems)) === 0 || options.maxAgeMs <= 0) {
    return { snapshots: retained, status: "disabled" };
  }
  const entry = createTimelineSnapshot(snapshot, options);
  const newest = retained[0];
  if (newest?.signature === entry.signature) {
    return { snapshots: retained, entry: newest, status: "duplicate" };
  }

  const minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? 0);
  const withinCoalescingWindow = newest && entry.createdAt - newest.createdAt < minimumIntervalMs;
  const combined = withinCoalescingWindow ? [entry, ...retained.slice(1)] : [entry, ...retained];
  return {
    snapshots: pruneTimelineSnapshots(combined, options),
    entry,
    status: withinCoalescingWindow ? "coalesced" : "added"
  };
}

export function stripSessionMetadata<T extends SessionMetadataShape>(
  session: T,
  mode: SnapshotMetadataMode
): T {
  if (mode === "full") {
    return { ...session, tabs: session.tabs.map(tab => ({ ...tab })) } as T;
  }
  const tabs = session.tabs.map(tab => {
    const result = { ...tab };
    delete result.title;
    delete result.favIconUrl;
    delete result.originalGroupTitle;
    if (mode === "structureOnly") {
      delete result.url;
      delete result.domain;
    }
    return result;
  });
  return {
    ...session,
    name: mode === "structureOnly" ? "Private session" : session.name,
    tabs
  } as T;
}

export function pruneSessionTrash<T extends SessionIdentity>(
  trash: readonly SessionTrashItem<T>[],
  now: number
): Array<SessionTrashItem<T>> {
  return [...trash]
    .filter(item => item.expiresAt > now)
    .sort((left, right) => right.deletedAt - left.deletedAt || left.trashId.localeCompare(right.trashId));
}

export function moveSessionToTrash<T extends SessionIdentity>(
  sessions: readonly T[],
  trash: readonly SessionTrashItem<T>[],
  sessionId: string,
  options: MoveSessionToTrashOptions<T>
): MoveSessionToTrashResult<T> {
  validatePositiveDuration(options.ttlMs, "ttlMs");
  const originalIndex = sessions.findIndex(session => session.id === sessionId);
  const retainedTrash = pruneSessionTrash(trash, options.now);
  if (originalIndex < 0) return { sessions: [...sessions], trash: retainedTrash };

  const sourceSession = sessions[originalIndex];
  const storedSession = options.sanitize ? options.sanitize(sourceSession) : sourceSession;
  const trashId = options.trashId ?? `trash-${sessionId}-${options.now.toString(36)}`;
  const moved: SessionTrashItem<T> = {
    schemaVersion: SESSION_SAFETY_SCHEMA_VERSION,
    trashId,
    deletedAt: options.now,
    expiresAt: options.now + options.ttlMs,
    originalIndex,
    session: storedSession
  };
  return {
    sessions: sessions.filter((_, index) => index !== originalIndex),
    trash: [moved, ...retainedTrash.filter(item => item.trashId !== trashId)],
    moved
  };
}

function uniqueCopyId(baseId: string, sessions: readonly SessionIdentity[], requestedId?: string): string {
  const takenIds = new Set(sessions.map(session => session.id));
  const preferred = requestedId?.trim() || baseId;
  if (!takenIds.has(preferred)) return preferred;
  let suffix = 2;
  while (takenIds.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function insertAt<T>(items: readonly T[], item: T, requestedIndex: number): T[] {
  const index = Math.max(0, Math.min(Math.floor(requestedIndex), items.length));
  return [...items.slice(0, index), item, ...items.slice(index)];
}

export function restoreSessionFromTrash<T extends SessionIdentity>(
  sessions: readonly T[],
  trash: readonly SessionTrashItem<T>[],
  trashId: string,
  options: RestoreSessionFromTrashOptions
): RestoreSessionFromTrashResult<T> {
  const originalItem = trash.find(item => item.trashId === trashId);
  const retainedTrash = pruneSessionTrash(trash, options.now);
  if (originalItem && originalItem.expiresAt <= options.now) {
    return { sessions: [...sessions], trash: retainedTrash, status: "expired" };
  }
  const item = retainedTrash.find(candidate => candidate.trashId === trashId);
  if (!item) return { sessions: [...sessions], trash: retainedTrash, status: "notFound" };

  const conflictIndex = sessions.findIndex(session => session.id === item.session.id);
  const onConflict = options.onConflict ?? "copy";
  if (conflictIndex >= 0 && onConflict === "skip") {
    return { sessions: [...sessions], trash: retainedTrash, status: "conflict" };
  }

  let restoredSession = item.session;
  let baseSessions = [...sessions];
  let status: RestoreSessionFromTrashResult<T>["status"] = "restored";
  if (conflictIndex >= 0 && onConflict === "replace") {
    baseSessions = sessions.filter((_, index) => index !== conflictIndex);
    status = "replaced";
  } else if (conflictIndex >= 0) {
    const copyBaseId = options.copyId ?? `${item.session.id}-restored-${item.deletedAt.toString(36)}`;
    restoredSession = { ...item.session, id: uniqueCopyId(copyBaseId, sessions) } as T;
    status = "copied";
  }

  return {
    sessions: insertAt(baseSessions, restoredSession, item.originalIndex),
    trash: retainedTrash.filter(candidate => candidate.trashId !== trashId),
    restoredSession,
    status
  };
}

const RESTORE_PRIORITY_RANK: Record<RestoreQueuePriority, number> = {
  windowAnchor: 0,
  user: 1,
  active: 2,
  pinned: 3,
  normal: 4
};

export function createPressureAwareRestoreQueue(
  plan: RestoreOrderingPlan,
  options: CreateRestoreQueueOptions = {}
): RestoreQueueItem[] {
  const priorityTabKeys = new Set(options.priorityTabKeys ?? []);
  const queue: RestoreQueueItem[] = [];
  let order = 0;
  for (const window of [...plan.windows].sort((left, right) => left.order - right.order)) {
    for (const tab of window.createTabs) {
      let priority: RestoreQueuePriority = "normal";
      if (tab.tabKey === window.anchorTabKey) priority = "windowAnchor";
      else if (priorityTabKeys.has(tab.tabKey)) priority = "user";
      else if (tab.tabKey === window.activeTabKey) priority = "active";
      else if (tab.pinned) priority = "pinned";
      queue.push({
        id: `${window.windowKey}:${tab.tabKey}`,
        tabKey: tab.tabKey,
        windowKey: window.windowKey,
        url: tab.url,
        priority,
        order
      });
      order += 1;
    }
  }
  return queue.sort((left, right) => {
    return RESTORE_PRIORITY_RANK[left.priority] - RESTORE_PRIORITY_RANK[right.priority] || left.order - right.order;
  });
}

function positiveBatchSize(value: number | undefined, fallback: number): number {
  return Math.max(0, Math.floor(value ?? fallback));
}

export function decidePressureAwareRestoreBatch(
  queue: readonly RestoreQueueItem[],
  pressure: RestorePressureState,
  options: RestoreBatchOptions = {}
): RestoreBatchDecision {
  const pending = [...queue];
  if (pending.length === 0) {
    return { action: "complete", reason: "queueEmpty", batch: [], remaining: [] };
  }
  const retryAfterMs = Math.max(0, options.retryAfterMs ?? 60_000);
  if (pressure.level === "emergency") {
    return { action: "pause", reason: "emergencyPressure", batch: [], remaining: pending, retryAfterMs };
  }
  const cpuHighRatio = options.cpuHighRatio ?? 0.85;
  const cpuIsHigh = typeof pressure.cpuUsageRatio === "number" && pressure.cpuUsageRatio >= cpuHighRatio;
  if ((options.pauseOnHighCpu ?? true) && cpuIsHigh) {
    return { action: "pause", reason: "highCpu", batch: [], remaining: pending, retryAfterMs };
  }

  const batchSize = pressure.level === "high"
    ? positiveBatchSize(options.highBatchSize, 0)
    : positiveBatchSize(options.normalBatchSize, 4);
  if (batchSize === 0) {
    return { action: "pause", reason: "highPressure", batch: [], remaining: pending, retryAfterMs };
  }
  return {
    action: "restore",
    reason: "ready",
    batch: pending.slice(0, batchSize),
    remaining: pending.slice(batchSize)
  };
}
