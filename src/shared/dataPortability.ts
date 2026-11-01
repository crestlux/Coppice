import { LEGACY_NAMES, migrateSettingsNames } from "./legacyNames";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

// Version 2 writes canonical names; version 1 remains an import-only format.
export const BACKUP_FORMAT = "coppice-backup" as const;
export const SYNC_FORMAT = "coppice-sync" as const;
export const CURRENT_BACKUP_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export const BACKUP_SECTION_NAMES = [
  "settings",
  "protectionRules",
  "focusSets",
  "sessions",
  "windowPolicies",
  "discardLog",
  "discardLearning",
  "externalDiscardObservations",
  "recoveryCapsules",
  "sessionTimeline",
  "sessionTrash",
  "effectHistory"
] as const;

export const SYNC_SECTION_NAMES = ["settings", "protectionRules", "focusSets"] as const;

export type BackupSectionName = (typeof BACKUP_SECTION_NAMES)[number];
export type SyncSectionName = (typeof SYNC_SECTION_NAMES)[number];
export type ImportMode = "merge" | "replace";
export type PortableSections = Partial<Record<BackupSectionName, JsonValue>>;

export interface BackupEnvelope {
  kind: typeof BACKUP_FORMAT;
  schemaVersion: number;
  createdAt: number;
  selectedSections: BackupSectionName[];
  sections: PortableSections;
}

export interface CreateBackupOptions {
  selectedSections?: readonly BackupSectionName[];
  createdAt?: number;
  maxBytes?: number;
}

export interface NormalizeBackupOptions {
  maxBytes?: number;
}

export interface ImportPlan {
  mode: ImportMode;
  schemaVersion: number;
  sourceCreatedAt: number;
  selectedSections: BackupSectionName[];
  writes: PortableSections;
}

export type DataPortabilityErrorCode =
  | "INVALID_JSON"
  | "INVALID_BACKUP"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INVALID_TIMESTAMP"
  | "INVALID_SECTION_SELECTION"
  | "INVALID_SECTION"
  | "NOT_JSON_SAFE"
  | "BACKUP_TOO_LARGE"
  | "INVALID_QUOTA"
  | "SYNC_ITEM_QUOTA_EXCEEDED"
  | "SYNC_TOTAL_QUOTA_EXCEEDED"
  | "SYNC_ITEM_COUNT_EXCEEDED";

export interface DataPortabilityIssue {
  code: DataPortabilityErrorCode;
  message: string;
}

export type DataPortabilityResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DataPortabilityIssue };

const ERROR_MESSAGES: Readonly<Record<DataPortabilityErrorCode, string>> = {
  INVALID_JSON: "The selected file is not valid JSON.",
  INVALID_BACKUP: "The selected file is not a valid backup.",
  UNSUPPORTED_SCHEMA_VERSION: "This backup version is not supported.",
  INVALID_TIMESTAMP: "The backup timestamp is invalid.",
  INVALID_SECTION_SELECTION: "The backup section selection is invalid.",
  INVALID_SECTION: "One or more backup sections are invalid.",
  NOT_JSON_SAFE: "The data contains values that cannot be safely exported.",
  BACKUP_TOO_LARGE: "The backup exceeds the allowed size.",
  INVALID_QUOTA: "The synchronization quota configuration is invalid.",
  SYNC_ITEM_QUOTA_EXCEEDED: "A selected synchronization section exceeds the per-item quota.",
  SYNC_TOTAL_QUOTA_EXCEEDED: "The selected synchronization data exceeds the total quota.",
  SYNC_ITEM_COUNT_EXCEEDED: "The selected synchronization data exceeds the item-count quota."
};

export class DataPortabilityError extends Error {
  readonly code: DataPortabilityErrorCode;

  constructor(code: DataPortabilityErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "DataPortabilityError";
    this.code = code;
  }
}

export interface SyncQuota {
  totalBytes: number;
  perItemBytes: number;
  maxItems: number;
  headroomRatio: number;
}

export const DEFAULT_SYNC_QUOTA: Readonly<SyncQuota> = Object.freeze({
  totalBytes: 102_400,
  perItemBytes: 8_192,
  maxItems: 512,
  headroomRatio: 0.9
});

export const SYNC_MANIFEST_KEY = "coppice.sync.manifest";

export const SYNC_SECTION_KEYS: Readonly<Record<SyncSectionName, string>> = Object.freeze({
  settings: "coppice.sync.settings",
  protectionRules: "coppice.sync.protectionRules",
  focusSets: "coppice.sync.focusSets"
});

export type SyncQuotaViolationCode = "item" | "total" | "itemCount";

export interface SyncQuotaViolation {
  code: SyncQuotaViolationCode;
  key?: string;
}

export interface SyncQuotaEstimate {
  totalBytes: number;
  itemBytes: Record<string, number>;
  itemCount: number;
  usableTotalBytes: number;
  usablePerItemBytes: number;
  maxItems: number;
  withinQuota: boolean;
  violations: SyncQuotaViolation[];
}

export interface SelectiveSyncOptions {
  selectedSections?: readonly SyncSectionName[];
  createdAt?: number;
  quota?: Partial<SyncQuota>;
}

export interface SelectiveSyncProjection {
  schemaVersion: number;
  createdAt: number;
  selectedSections: SyncSectionName[];
  items: JsonObject;
  estimate: SyncQuotaEstimate;
}

interface CloneState {
  ancestors: WeakSet<object>;
  nodes: number;
}

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DEVICE_LOCAL_SYNC_SETTING_KEYS = new Set([
  "syncEnabled",
  "syncSettings",
  "syncProtectionRules",
  "syncFocusSets"
]);
const BACKUP_SECTION_SET = new Set<string>(BACKUP_SECTION_NAMES);
const SYNC_SECTION_SET = new Set<string>(SYNC_SECTION_NAMES);
const textEncoder = new TextEncoder();

function fail(code: DataPortabilityErrorCode): never {
  throw new DataPortabilityError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value: unknown, state: CloneState, depth = 0): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail("NOT_JSON_SAFE");

  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NOT_JSON_SAFE");
    return value;
  }
  if (typeof value !== "object") fail("NOT_JSON_SAFE");

  if (state.ancestors.has(value)) fail("NOT_JSON_SAFE");
  state.ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail("NOT_JSON_SAFE");
        result.push(cloneJsonValue(value[index], state, depth + 1));
      }
      return result;
    }

    if (!isRecord(value)) fail("NOT_JSON_SAFE");
    const result: JsonObject = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) fail("NOT_JSON_SAFE");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail("NOT_JSON_SAFE");
      result[key] = cloneJsonValue(descriptor.value, state, depth + 1);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function toJsonValue(value: unknown): JsonValue {
  return cloneJsonValue(value, { ancestors: new WeakSet<object>(), nodes: 0 });
}

function toJsonObject(value: unknown, code: DataPortabilityErrorCode): JsonObject {
  const cloned = toJsonValue(value);
  if (Array.isArray(cloned) || cloned === null || typeof cloned !== "object") fail(code);
  return cloned;
}

function validateTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("INVALID_TIMESTAMP");
  return value as number;
}

function normalizeMaxBytes(maxBytes?: number): number {
  const value = maxBytes ?? DEFAULT_MAX_BACKUP_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) fail("BACKUP_TOO_LARGE");
  return value;
}

function canonicalBackupSections(values: readonly unknown[]): BackupSectionName[] {
  const selected = new Set<BackupSectionName>();
  for (const value of values) {
    if (typeof value !== "string" || !BACKUP_SECTION_SET.has(value)) fail("INVALID_SECTION_SELECTION");
    selected.add(value as BackupSectionName);
  }
  if (selected.size === 0) fail("INVALID_SECTION_SELECTION");
  return BACKUP_SECTION_NAMES.filter(section => selected.has(section));
}

function canonicalSyncSections(values: readonly unknown[]): SyncSectionName[] {
  const selected = new Set<SyncSectionName>();
  for (const value of values) {
    if (typeof value !== "string" || !SYNC_SECTION_SET.has(value)) fail("INVALID_SECTION_SELECTION");
    selected.add(value as SyncSectionName);
  }
  if (selected.size === 0) fail("INVALID_SECTION_SELECTION");
  return SYNC_SECTION_NAMES.filter(section => selected.has(section));
}

function validateSectionShape(section: BackupSectionName, value: JsonValue): void {
  if (section === "settings") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SECTION");
    return;
  }

  if (!Array.isArray(value)) fail("INVALID_SECTION");
  if (value.some(item => item === null || typeof item !== "object" || Array.isArray(item))) {
    fail("INVALID_SECTION");
  }
}

function syncSafeSectionValue(section: SyncSectionName, value: unknown): JsonValue {
  const cloned = toJsonValue(value);
  validateSectionShape(section, cloned);
  if (section !== "settings") return cloned;
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") fail("INVALID_SECTION");

  const settings: JsonObject = {};
  for (const [key, settingValue] of Object.entries(migrateSettingsNames(cloned))) {
    if (!DEVICE_LOCAL_SYNC_SETTING_KEYS.has(key)) settings[key] = toJsonValue(settingValue);
  }
  return settings;
}

function normalizeSections(
  source: Readonly<Record<string, unknown>>,
  selectedSections: readonly BackupSectionName[],
  rejectUnselected = false
): PortableSections {
  if (rejectUnselected) {
    for (const key of Object.keys(source)) {
      if (!BACKUP_SECTION_SET.has(key) || !selectedSections.includes(key as BackupSectionName)) {
        fail("INVALID_SECTION_SELECTION");
      }
    }
  }

  const sections: PortableSections = {};
  for (const section of selectedSections) {
    if (!Object.hasOwn(source, section)) fail("INVALID_SECTION");
    const value = toJsonValue(source[section]);
    validateSectionShape(section, value);
    sections[section] = section === "settings" ? toJsonValue(migrateSettingsNames(value)) : value;
  }
  return sections;
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function estimateJsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(toJsonValue(value)));
}

function assertWithinBackupLimit(envelope: BackupEnvelope, maxBytes?: number): void {
  if (estimateJsonBytes(envelope) > normalizeMaxBytes(maxBytes)) fail("BACKUP_TOO_LARGE");
}

function migrationReadyNormalize(record: JsonObject): BackupEnvelope {
  if (record.kind !== BACKUP_FORMAT && record.kind !== LEGACY_NAMES.backupFormat) fail("INVALID_BACKUP");
  if (!Number.isSafeInteger(record.schemaVersion)) fail("INVALID_BACKUP");
  if (record.schemaVersion !== 1 && record.schemaVersion !== CURRENT_BACKUP_SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA_VERSION");
  if (record.kind === LEGACY_NAMES.backupFormat && record.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA_VERSION");

  // Normalize names before merge planning so current defaults cannot mask legacy preferences.
  const createdAt = validateTimestamp(record.createdAt);
  if (!Array.isArray(record.selectedSections)) fail("INVALID_SECTION_SELECTION");
  const selectedSections = canonicalBackupSections(record.selectedSections);
  const rawSections = toJsonObject(record.sections, "INVALID_SECTION");
  const sections = normalizeSections(rawSections, selectedSections, true);

  return {
    kind: BACKUP_FORMAT,
    schemaVersion: CURRENT_BACKUP_SCHEMA_VERSION,
    createdAt,
    selectedSections,
    sections
  };
}

export function createBackupEnvelope(
  source: Readonly<Record<string, unknown>>,
  options: CreateBackupOptions = {}
): BackupEnvelope {
  if (!isRecord(source)) fail("INVALID_SECTION");
  const availableSections = BACKUP_SECTION_NAMES.filter(section => Object.hasOwn(source, section));
  const selectedSections = canonicalBackupSections(options.selectedSections ?? availableSections);
  const envelope: BackupEnvelope = {
    kind: BACKUP_FORMAT,
    schemaVersion: CURRENT_BACKUP_SCHEMA_VERSION,
    createdAt: validateTimestamp(options.createdAt ?? Date.now()),
    selectedSections,
    sections: normalizeSections(source, selectedSections)
  };
  assertWithinBackupLimit(envelope, options.maxBytes);
  return envelope;
}

export function normalizeBackupImport(input: unknown, options: NormalizeBackupOptions = {}): BackupEnvelope {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  let parsed: unknown = input;

  if (typeof input === "string") {
    if (utf8Bytes(input) > maxBytes) fail("BACKUP_TOO_LARGE");
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      fail("INVALID_JSON");
    }
  }

  const record = toJsonObject(parsed, "INVALID_BACKUP");
  const normalized = migrationReadyNormalize(record);
  assertWithinBackupLimit(normalized, maxBytes);
  return normalized;
}

function issueFrom(error: unknown): DataPortabilityIssue {
  if (error instanceof DataPortabilityError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INVALID_BACKUP", message: ERROR_MESSAGES.INVALID_BACKUP };
}

export function validateBackupEnvelope(
  input: unknown,
  options: NormalizeBackupOptions = {}
): DataPortabilityResult<BackupEnvelope> {
  try {
    return { ok: true, value: normalizeBackupImport(input, options) };
  } catch (error) {
    return { ok: false, error: issueFrom(error) };
  }
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return toJsonValue(value) as JsonObject;
}

function deepMergeObjects(current: JsonObject, incoming: JsonObject): JsonObject {
  const result = cloneJsonObject(current);
  for (const [key, incomingValue] of Object.entries(incoming)) {
    const currentValue = result[key];
    if (
      currentValue !== null &&
      incomingValue !== null &&
      typeof currentValue === "object" &&
      typeof incomingValue === "object" &&
      !Array.isArray(currentValue) &&
      !Array.isArray(incomingValue)
    ) {
      result[key] = deepMergeObjects(currentValue, incomingValue);
    } else {
      result[key] = toJsonValue(incomingValue);
    }
  }
  return result;
}

function arrayIdentity(section: BackupSectionName, value: JsonValue): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.id === "string" && value.id) return `id:${value.id}`;
    if (section === "discardLearning" && typeof value.domain === "string" && value.domain) {
      return `domain:${value.domain}`;
    }
    if (section === "windowPolicies" && typeof value.windowId === "number" && Number.isFinite(value.windowId)) {
      return `window:${value.windowId}`;
    }
  }
  return `value:${JSON.stringify(value)}`;
}

function mergeSectionArrays(
  section: BackupSectionName,
  current: readonly JsonValue[],
  incoming: readonly JsonValue[]
): JsonValue[] {
  const incomingIds = new Set(incoming.map(item => arrayIdentity(section, item)));
  return [
    ...incoming.map(item => toJsonValue(item)),
    ...current.filter(item => !incomingIds.has(arrayIdentity(section, item))).map(item => toJsonValue(item))
  ];
}

export function createImportPlan(
  mode: ImportMode,
  currentSource: Readonly<Record<string, unknown>>,
  imported: unknown
): ImportPlan {
  if (mode !== "merge" && mode !== "replace") fail("INVALID_BACKUP");
  if (!isRecord(currentSource)) fail("INVALID_SECTION");
  const envelope = normalizeBackupImport(imported);
  const writes: PortableSections = {};

  for (const section of envelope.selectedSections) {
    const incomingValue = envelope.sections[section];
    if (incomingValue === undefined) fail("INVALID_SECTION");

    if (mode === "replace" || !Object.hasOwn(currentSource, section)) {
      writes[section] = toJsonValue(incomingValue);
      continue;
    }

    const currentValue = toJsonValue(currentSource[section]);
    validateSectionShape(section, currentValue);
    if (
      section === "settings" &&
      !Array.isArray(currentValue) &&
      currentValue !== null &&
      typeof currentValue === "object" &&
      !Array.isArray(incomingValue) &&
      incomingValue !== null &&
      typeof incomingValue === "object"
    ) {
      writes[section] = deepMergeObjects(currentValue, incomingValue);
    } else if (Array.isArray(currentValue) && Array.isArray(incomingValue)) {
      writes[section] = mergeSectionArrays(section, currentValue, incomingValue);
    } else {
      fail("INVALID_SECTION");
    }
  }

  return {
    mode,
    schemaVersion: envelope.schemaVersion,
    sourceCreatedAt: envelope.createdAt,
    selectedSections: [...envelope.selectedSections],
    writes
  };
}

export function createMergeImportPlan(
  currentSource: Readonly<Record<string, unknown>>,
  imported: unknown
): ImportPlan {
  return createImportPlan("merge", currentSource, imported);
}

export function createReplaceImportPlan(imported: unknown): ImportPlan {
  return createImportPlan("replace", {}, imported);
}

function normalizeQuota(patch: Partial<SyncQuota> = {}): SyncQuota {
  const quota: SyncQuota = { ...DEFAULT_SYNC_QUOTA, ...patch };
  if (
    !Number.isSafeInteger(quota.totalBytes) ||
    quota.totalBytes <= 0 ||
    !Number.isSafeInteger(quota.perItemBytes) ||
    quota.perItemBytes <= 0 ||
    !Number.isSafeInteger(quota.maxItems) ||
    quota.maxItems <= 0 ||
    !Number.isFinite(quota.headroomRatio) ||
    quota.headroomRatio <= 0 ||
    quota.headroomRatio > 1
  ) {
    fail("INVALID_QUOTA");
  }
  return quota;
}

export function estimateSyncQuota(
  items: Readonly<Record<string, unknown>>,
  quotaPatch: Partial<SyncQuota> = {}
): SyncQuotaEstimate {
  if (!isRecord(items)) fail("NOT_JSON_SAFE");
  const quota = normalizeQuota(quotaPatch);
  const usableTotalBytes = Math.floor(quota.totalBytes * quota.headroomRatio);
  const usablePerItemBytes = Math.floor(quota.perItemBytes * quota.headroomRatio);
  const itemBytes: Record<string, number> = {};
  const violations: SyncQuotaViolation[] = [];
  let totalBytes = 0;

  for (const [key, rawValue] of Object.entries(items)) {
    const value = toJsonValue(rawValue);
    const bytes = utf8Bytes(key) + utf8Bytes(JSON.stringify(value));
    itemBytes[key] = bytes;
    totalBytes += bytes;
    if (bytes > usablePerItemBytes) violations.push({ code: "item", key });
  }

  const itemCount = Object.keys(items).length;
  if (itemCount > quota.maxItems) violations.push({ code: "itemCount" });
  if (totalBytes > usableTotalBytes) violations.push({ code: "total" });

  return {
    totalBytes,
    itemBytes,
    itemCount,
    usableTotalBytes,
    usablePerItemBytes,
    maxItems: quota.maxItems,
    withinQuota: violations.length === 0,
    violations
  };
}

function assertSyncEstimate(estimate: SyncQuotaEstimate): void {
  if (estimate.violations.some(violation => violation.code === "item")) fail("SYNC_ITEM_QUOTA_EXCEEDED");
  if (estimate.violations.some(violation => violation.code === "itemCount")) fail("SYNC_ITEM_COUNT_EXCEEDED");
  if (estimate.violations.some(violation => violation.code === "total")) fail("SYNC_TOTAL_QUOTA_EXCEEDED");
}

export function createSelectiveSyncProjection(
  source: Readonly<Record<string, unknown>>,
  options: SelectiveSyncOptions = {}
): SelectiveSyncProjection {
  if (!isRecord(source)) fail("INVALID_SECTION");
  const availableSections = SYNC_SECTION_NAMES.filter(section => Object.hasOwn(source, section));
  const selectedSections = canonicalSyncSections(options.selectedSections ?? availableSections);
  const createdAt = validateTimestamp(options.createdAt ?? Date.now());
  const items: JsonObject = {
    [SYNC_MANIFEST_KEY]: {
      kind: SYNC_FORMAT,
      schemaVersion: CURRENT_BACKUP_SCHEMA_VERSION,
      createdAt,
      selectedSections
    }
  };

  for (const section of selectedSections) {
    if (!Object.hasOwn(source, section)) fail("INVALID_SECTION");
    const value = syncSafeSectionValue(section, source[section]);
    items[SYNC_SECTION_KEYS[section]] = value;
  }

  const estimate = estimateSyncQuota(items, options.quota);
  assertSyncEstimate(estimate);
  return {
    schemaVersion: CURRENT_BACKUP_SCHEMA_VERSION,
    createdAt,
    selectedSections,
    items,
    estimate
  };
}

export function normalizeSelectiveSyncProjection(items: unknown): BackupEnvelope {
  const record = toJsonObject(items, "INVALID_BACKUP");
  // Read one complete namespace; never fill holes with stale sections from another generation.
  const legacy = !Object.hasOwn(record, SYNC_MANIFEST_KEY);
  const manifest = toJsonObject(record[legacy ? LEGACY_NAMES.syncManifest : SYNC_MANIFEST_KEY], "INVALID_BACKUP");
  if (manifest.kind !== (legacy ? LEGACY_NAMES.syncFormat : SYNC_FORMAT)) fail("INVALID_BACKUP");
  if (!Number.isSafeInteger(manifest.schemaVersion)) fail("INVALID_BACKUP");
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== CURRENT_BACKUP_SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA_VERSION");
  if (legacy && manifest.schemaVersion !== 1) fail("UNSUPPORTED_SCHEMA_VERSION");
  const createdAt = validateTimestamp(manifest.createdAt);
  if (!Array.isArray(manifest.selectedSections)) fail("INVALID_SECTION_SELECTION");
  const selectedSections = canonicalSyncSections(manifest.selectedSections);
  const sections: Record<string, unknown> = {};
  for (const section of selectedSections) {
    const key = legacy ? LEGACY_NAMES.syncSections[section] : SYNC_SECTION_KEYS[section];
    if (!Object.hasOwn(record, key)) fail("INVALID_SECTION");
    sections[section] = syncSafeSectionValue(section, record[key]);
  }
  return createBackupEnvelope(sections, { selectedSections, createdAt });
}

export function hasSyncProjection(items: Record<string, unknown>): boolean {
  return Object.hasOwn(items, SYNC_MANIFEST_KEY) || Object.hasOwn(items, LEGACY_NAMES.syncManifest);
}

export function isSyncStorageKey(key: string): boolean {
  return key.startsWith("coppice.sync.") || key.startsWith(LEGACY_NAMES.syncPrefix);
}

/** Call only after the canonical snapshot has been committed successfully. */
export async function removeLegacySyncKeys(items: Record<string, unknown>): Promise<void> {
  const keys = [LEGACY_NAMES.syncManifest, ...Object.values(LEGACY_NAMES.syncSections)]
    .filter(key => Object.hasOwn(items, key));
  if (keys.length) await chrome.storage.sync.remove(keys);
}
