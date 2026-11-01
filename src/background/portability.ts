import { STORAGE_KEYS } from "../shared/constants";
import {
  BACKUP_SECTION_NAMES,
  SYNC_MANIFEST_KEY,
  createBackupEnvelope,
  createMergeImportPlan,
  createReplaceImportPlan,
  createSelectiveSyncProjection,
  normalizeSelectiveSyncProjection,
  hasSyncProjection,
  removeLegacySyncKeys,
  type BackupEnvelope,
  type BackupSectionName,
  type ImportMode,
  type ImportPlan,
  type SyncSectionName
} from "../shared/dataPortability";
import { getSettings, normalizeSettings, saveSyncStatus, withStorageMutation } from "../shared/storage";
import type { ProtectionRule, ProtectionRuleType, SyncStatus } from "../shared/types";
import { isHttpUrl } from "../shared/url";
import { normalizeProtectionRuleValue } from "../shared/protectionRules";

const STORAGE_KEY_BY_SECTION: Record<BackupSectionName, string> = {
  settings: STORAGE_KEYS.SETTINGS,
  protectionRules: STORAGE_KEYS.PROTECTION_RULES,
  focusSets: STORAGE_KEYS.FOCUS_SETS,
  sessions: STORAGE_KEYS.SESSIONS,
  windowPolicies: STORAGE_KEYS.WINDOW_POLICIES,
  discardLog: STORAGE_KEYS.DISCARD_LOG,
  discardLearning: STORAGE_KEYS.DISCARD_LEARNING,
  externalDiscardObservations: STORAGE_KEYS.EXTERNAL_DISCARD_OBSERVATIONS,
  recoveryCapsules: STORAGE_KEYS.RECOVERY_CAPSULES,
  sessionTimeline: STORAGE_KEYS.SESSION_TIMELINE,
  sessionTrash: STORAGE_KEYS.SESSION_TRASH,
  effectHistory: STORAGE_KEYS.EFFECT_HISTORY
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && (value[key] as string).length > 0;
}

function hasFiniteNumber<K extends string>(
  value: Record<string, unknown>,
  key: K
): value is Record<string, unknown> & Record<K, number> {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function hasEnum(value: Record<string, unknown>, key: string, allowed: readonly string[]): boolean {
  return typeof value[key] === "string" && allowed.includes(value[key] as string);
}

function isSavedTab(value: unknown, requireWindow = false): boolean {
  return (
    isRecord(value) &&
    hasString(value, "url") &&
    isHttpUrl(value.url as string) &&
    (!requireWindow || hasFiniteNumber(value, "windowId"))
  );
}

function isSavedSession(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "name") &&
    hasFiniteNumber(value, "createdAt") &&
    hasEnum(value, "source", ["window", "group", "selection"]) &&
    Array.isArray(value.tabs) &&
    value.tabs.every(tab => isSavedTab(tab))
  );
}

function assertRuntimeSectionShape(section: BackupSectionName, value: unknown): void {
  if (section === "settings") {
    if (!isRecord(value)) throw new Error("Backup settings are invalid.");
    return;
  }
  if (!Array.isArray(value)) throw new Error(`Backup section ${section} is invalid.`);

  const valid = value.every(item => {
    if (!isRecord(item)) return false;
    switch (section) {
      case "protectionRules":
        return (
          hasString(item, "id") &&
          hasEnum(item, "type", ["domain", "urlPattern"]) &&
          typeof item.value === "string" &&
          hasEnum(item, "source", ["default", "user"]) &&
          typeof item.enabled === "boolean" &&
          hasFiniteNumber(item, "createdAt")
        );
      case "focusSets":
        return (
          hasString(item, "id") &&
          hasString(item, "name") &&
          hasFiniteNumber(item, "createdAt") &&
          Array.isArray(item.tabs) &&
          item.tabs.every(tab => isSavedTab(tab))
        );
      case "sessions":
        return isSavedSession(item);
      case "windowPolicies":
        return (
          hasFiniteNumber(item, "windowId") &&
          hasEnum(item, "policyMode", ["inherit", "manual", "conservative", "balanced", "aggressive", "pressureAdaptive", "custom"]) &&
          hasFiniteNumber(item, "updatedAt")
        );
      case "discardLog":
        return (
          hasString(item, "id") &&
          hasFiniteNumber(item, "tabId") &&
          hasFiniteNumber(item, "windowId") &&
          hasFiniteNumber(item, "discardedAt") &&
          hasEnum(item, "reason", ["manualRelease", "autoInactive", "memoryPressure"]) &&
          hasFiniteNumber(item, "inactiveMinutes") &&
          (!Object.hasOwn(item, "url") || (typeof item.url === "string" && isHttpUrl(item.url)))
        );
      case "discardLearning":
        return (
          hasString(item, "domain") &&
          hasFiniteNumber(item, "quickReactivations") &&
          hasFiniteNumber(item, "undoCount") &&
          hasFiniteNumber(item, "lastFeedbackAt") &&
          hasFiniteNumber(item, "thresholdPenaltyMinutes")
        );
      case "externalDiscardObservations":
        return (
          hasString(item, "id") &&
          hasFiniteNumber(item, "tabId") &&
          hasFiniteNumber(item, "observedAt") &&
          item.source === "chromeOrOtherExtension"
        );
      case "recoveryCapsules":
        return (
          hasString(item, "id") &&
          hasFiniteNumber(item, "createdAt") &&
          hasFiniteNumber(item, "expiresAt") &&
          hasEnum(item, "reason", ["autoDiscard", "manualDiscard", "closeDuplicates", "closeDiscarded", "closeFrozen", "saveAndClose", "sessionRestore"]) &&
          Array.isArray(item.tabs) &&
          item.tabs.every(tab => isSavedTab(tab, true))
        );
      case "sessionTimeline":
        return (
          hasString(item, "id") &&
          hasFiniteNumber(item, "createdAt") &&
          hasEnum(item, "source", ["startup", "browserEvent", "manual"]) &&
          hasString(item, "signature") &&
          Array.isArray(item.tabs) &&
          item.tabs.every(tab => isSavedTab(tab, true))
        );
      case "sessionTrash":
        return (
          hasString(item, "id") &&
          hasFiniteNumber(item, "deletedAt") &&
          hasFiniteNumber(item, "expiresAt") &&
          isSavedSession(item.session)
        );
      case "effectHistory": {
        const pressure = item.pressure;
        return (
          hasString(item, "id") &&
          hasFiniteNumber(item, "sampledAt") &&
          hasFiniteNumber(item, "discardedCount") &&
          isRecord(pressure) &&
          hasFiniteNumber(pressure, "sampledAt") &&
          hasFiniteNumber(pressure, "memoryAvailableRatio") &&
          hasEnum(pressure, "level", ["normal", "high", "emergency"])
        );
      }
      default:
        return false;
    }
  });

  if (!valid) throw new Error(`Backup section ${section} contains invalid records.`);
}

function portableRecordIdentity(section: BackupSectionName, item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  if (section === "windowPolicies" && typeof item.windowId === "number") {
    return `window:${item.windowId}`;
  }
  if (section === "discardLearning" && typeof item.domain === "string") {
    return `domain:${item.domain.trim().toLowerCase()}`;
  }
  return typeof item.id === "string" && item.id ? `id:${item.id}` : undefined;
}

function assertUniqueRuntimeRecords(section: BackupSectionName, value: unknown): void {
  if (section === "settings" || !Array.isArray(value)) return;
  const identities = new Set<string>();
  for (const item of value) {
    const identity = portableRecordIdentity(section, item);
    if (!identity) continue;
    if (identities.has(identity)) {
      throw new Error(`Backup section ${section} contains duplicate records.`);
    }
    identities.add(identity);
  }
}

function normalizePortableProtectionRules(value: unknown): ProtectionRule[] {
  if (!Array.isArray(value)) throw new Error("Backup section protectionRules is invalid.");
  const ids = new Set<string>();
  const signatures = new Set<string>();

  return value.map(item => {
    if (!isRecord(item)) throw new Error("Backup section protectionRules contains invalid records.");
    const type = item.type as ProtectionRuleType;
    let normalizedValue: string;
    try {
      normalizedValue = normalizeProtectionRuleValue(type, item.value as string);
    } catch (error) {
      throw new Error(
        `Backup protection rule is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const id = item.id as string;
    const signature = `${type}\u0000${normalizedValue.toLowerCase()}`;
    if (ids.has(id) || signatures.has(signature)) {
      throw new Error("Backup protection rules contain duplicates.");
    }
    ids.add(id);
    signatures.add(signature);
    return { ...(item as unknown as ProtectionRule), value: normalizedValue };
  });
}

async function getPortableSource(): Promise<Record<string, unknown>> {
  const keys = BACKUP_SECTION_NAMES.map(section => STORAGE_KEY_BY_SECTION[section]);
  const stored = await chrome.storage.local.get(keys);
  const source: Record<string, unknown> = {};
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60_000;
  for (const section of BACKUP_SECTION_NAMES) {
    const value = stored[STORAGE_KEY_BY_SECTION[section]];
    if (section === "settings") {
      source[section] = normalizeSettings(value as Record<string, unknown> | undefined);
      continue;
    }
    const records = Array.isArray(value) ? value : [];
    source[section] = section === "recoveryCapsules"
      ? records.filter(item => isRecord(item) && hasFiniteNumber(item, "expiresAt") && item.expiresAt > now)
      : section === "sessionTrash"
        ? records.filter(item => isRecord(item) && hasFiniteNumber(item, "expiresAt") && item.expiresAt > now)
        : section === "externalDiscardObservations"
          ? records.filter(item => isRecord(item) && hasFiniteNumber(item, "observedAt") && item.observedAt >= dayAgo && item.observedAt <= now)
          : section === "effectHistory"
            ? records.filter(item => isRecord(item) && hasFiniteNumber(item, "sampledAt") && item.sampledAt >= dayAgo && item.sampledAt <= now)
            : records;
  }
  const portableSettings = source.settings as ReturnType<typeof normalizeSettings>;
  if (portableSettings.privacyMode && Array.isArray(source.discardLog)) {
    source.discardLog = source.discardLog.map(item => {
      if (!isRecord(item)) return item;
      const redacted = { ...item };
      delete redacted.title;
      delete redacted.url;
      return redacted;
    });
  }
  return source;
}

async function applyImportPlan(plan: ImportPlan): Promise<ImportPlan> {
  const writes: Record<string, unknown> = {};
  for (const section of plan.selectedSections) {
    const value = plan.writes[section];
    if (value === undefined) continue;
    assertRuntimeSectionShape(section, value);
    assertUniqueRuntimeRecords(section, value);
    writes[STORAGE_KEY_BY_SECTION[section]] = section === "settings"
      ? normalizeSettings(value as Record<string, unknown>)
      : section === "protectionRules"
        ? normalizePortableProtectionRules(value)
        : value;
  }
  await chrome.storage.local.set(writes);
  return plan;
}

export async function exportFullBackup(selectedSections?: BackupSectionName[]): Promise<BackupEnvelope> {
  return createBackupEnvelope(await getPortableSource(), {
    selectedSections: selectedSections?.length ? selectedSections : undefined
  });
}

export async function importFullBackup(backup: unknown, mode: ImportMode): Promise<ImportPlan> {
  return withStorageMutation(async () => {
    const plan =
      mode === "replace"
        ? createReplaceImportPlan(backup)
        : createMergeImportPlan(await getPortableSource(), backup);
    return applyImportPlan(plan);
  });
}

function selectedSyncSections(settings: Awaited<ReturnType<typeof getSettings>>): SyncSectionName[] {
  const sections: SyncSectionName[] = [];
  if (settings.syncSettings) sections.push("settings");
  if (settings.syncProtectionRules) sections.push("protectionRules");
  if (settings.syncFocusSets) sections.push("focusSets");
  return sections;
}

function syncStatus(input: Partial<SyncStatus> & Pick<SyncStatus, "enabled" | "sections">): SyncStatus {
  return { ...input };
}

let syncOperationQueue: Promise<void> = Promise.resolve();
function queueSync<T>(operation: () => Promise<T>): Promise<T> {
  const result = syncOperationQueue.then(operation);
  syncOperationQueue = result.then(() => undefined, () => undefined);
  return result;
}
export const pushSelectiveSync = (): Promise<SyncStatus> => queueSync(doPushSelectiveSync);
export const pullSelectiveSync = (): Promise<ImportPlan> => queueSync(doPullSelectiveSync);

async function doPushSelectiveSync(): Promise<SyncStatus> {
  const settings = await getSettings();
  const sections = selectedSyncSections(settings);
  if (!settings.syncEnabled) throw new Error("Selective sync is disabled.");
  if (sections.length === 0) throw new Error("Select at least one section to synchronize.");

  try {
    // Changing this device's selection must not delete another device's sections.
    const remote = await chrome.storage.sync.get(null);
    const previous = hasSyncProjection(remote) ? normalizeSelectiveSyncProjection(remote) : undefined;
    const source: Record<string, unknown> = { ...previous?.sections };
    const local = await getPortableSource();
    for (const section of sections) source[section] = local[section];
    const selectedSections = [...new Set([...(previous?.selectedSections ?? []) as SyncSectionName[], ...sections])];
    const projection = createSelectiveSyncProjection(source, { selectedSections });
    ignoreRemoteSyncChangesUntil = Date.now() + 3_000;
    await chrome.storage.sync.set(projection.items);
    await removeLegacySyncKeys(remote);
    const status = syncStatus({
      enabled: true,
      lastSyncedAt: projection.createdAt,
      byteSize: projection.estimate.totalBytes,
      sections
    });
    await saveSyncStatus(status);
    return status;
  } catch (error) {
    const status = syncStatus({
      enabled: true,
      sections,
      error: error instanceof Error ? error.message : String(error)
    });
    await saveSyncStatus(status);
    throw error;
  }
}

async function doPullSelectiveSync(): Promise<ImportPlan> {
  const settings = await getSettings();
  if (!settings.syncEnabled) throw new Error("Selective sync is disabled.");
  try {
    const remote = await chrome.storage.sync.get(null);
    const envelope = normalizeSelectiveSyncProjection(remote);
    const plan = await withStorageMutation(async () => {
      const currentSettings = await getSettings();
      if (!currentSettings.syncEnabled) throw new Error("Selective sync is disabled.");
      const selected = new Set(selectedSyncSections(currentSettings));
      const selectedSections = envelope.selectedSections.filter(section => selected.has(section as SyncSectionName));
      if (!selectedSections.length) return {
        mode: "replace" as const, schemaVersion: envelope.schemaVersion,
        sourceCreatedAt: envelope.createdAt, selectedSections: [], writes: {}
      };
      const filtered = { ...envelope, selectedSections,
        sections: Object.fromEntries(selectedSections.map(section => [section, envelope.sections[section]])) };
      const plan = createMergeImportPlan(await getPortableSource(), filtered);
      // Sync collections are authoritative snapshots: merge would resurrect deletions.
      // Settings still merge so device-local sync controls remain untouched.
      for (const section of selectedSections) {
        if (section !== "settings") plan.writes[section] = envelope.sections[section];
      }
      plan.mode = "replace";
      return applyImportPlan(plan);
    });
    if (!Object.hasOwn(remote, SYNC_MANIFEST_KEY)) {
      // Preserve every remote section, including sections this device does not import.
      const projection = createSelectiveSyncProjection(envelope.sections, {
        selectedSections: envelope.selectedSections as SyncSectionName[], createdAt: envelope.createdAt
      });
      ignoreRemoteSyncChangesUntil = Date.now() + 3_000;
      await chrome.storage.sync.set(projection.items);
    }
    await removeLegacySyncKeys(remote);
    await saveSyncStatus({
      enabled: true,
      lastSyncedAt: Date.now(),
      sections: plan.selectedSections
    });
    return plan;
  } catch (error) {
    await saveSyncStatus({
      enabled: true,
      sections: selectedSyncSections(settings),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

let automaticSyncPromise: Promise<void> | null = null;
let remotePullPromise: Promise<void> | null = null;
let ignoreRemoteSyncChangesUntil = 0;
let automaticSyncQueued = false;
let remotePullQueued = false;
let remotePullTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

export function scheduleAutomaticSync(): void {
  automaticSyncQueued = true;
  if (automaticSyncPromise) return;
  automaticSyncPromise = (async () => {
    while (automaticSyncQueued) {
      automaticSyncQueued = false;
      const settings = await getSettings();
      if (settings.syncEnabled) await pushSelectiveSync();
    }
  })()
    .catch(error => console.warn("Automatic selective sync failed", error))
    .finally(() => {
      automaticSyncPromise = null;
      if (automaticSyncQueued) scheduleAutomaticSync();
    });
}

export function scheduleRemoteSyncPull(): void {
  remotePullQueued = true;
  const remainingIgnoreMs = ignoreRemoteSyncChangesUntil - Date.now();
  if (remainingIgnoreMs > 0) {
    if (remotePullTimer == null) {
      remotePullTimer = globalThis.setTimeout(() => {
        remotePullTimer = null;
        scheduleRemoteSyncPull();
      }, remainingIgnoreMs);
    }
    return;
  }
  if (remotePullPromise) return;
  remotePullPromise = (async () => {
    while (remotePullQueued) {
      remotePullQueued = false;
      const settings = await getSettings();
      if (settings.syncEnabled) await pullSelectiveSync();
    }
  })()
    .catch(error => console.warn("Automatic remote sync pull failed", error))
    .finally(() => {
      remotePullPromise = null;
      if (remotePullQueued) scheduleRemoteSyncPull();
    });
}
