import type { PageOptimizerItemId, NetworkFilteringMode, PolicyMode, ProtectionRuleType, Settings } from "./types";
import type { BackupSectionName, ImportMode } from "./dataPortability";

export type RestoreTarget = "currentWindow" | "newWindow";
export type OptimizerTarget = { tabId: number; domain: string };

export type AppMessage =
  | { type: "getAppState" }
  | { type: "getPopupState" }
  | { type: "getAccurateModeStatus" }
  | { type: "measureActiveTabAccurately" }
  | { type: "measureOpenTabsAccurately" }
  | { type: "checkActiveTabLeak" }
  | { type: "releaseMemoryNow" }
  | { type: "discardTabsOlderThan"; inactiveMinutes: number }
  | { type: "discardCurrentDomainBackgroundTabs" }
  | { type: "previewDuplicateTabs" }
  | { type: "closeDuplicateTabs"; tabIds?: number[] }
  | { type: "closeDiscardedTabs" }
  | { type: "closeFrozenTabs" }
  | { type: "closeTab"; tabId: number }
  | { type: "discardTabNow"; tabId: number }
  | { type: "unprotectTab"; tabId: number }
  | { type: "setTabProtection"; tabId: number; protected: boolean }
  | { type: "setFocusMode"; enabled: boolean }
  | { type: "setTabFocus"; tabId: number; focused: boolean }
  | { type: "saveCurrentFocusSet"; name?: string }
  | { type: "applyFocusSet"; setId: string }
  | { type: "deleteFocusSet"; setId: string }
  | { type: "setActiveTabOptimizer"; enabled: boolean; target?: OptimizerTarget }
  | { type: "setPageOptimizerEnabled"; enabled: boolean }
  | { type: "setAllSitesOptimizer"; enabled: boolean }
  | { type: "setPageOptimizerItemEnabled"; itemId: PageOptimizerItemId; enabled: boolean }
  | { type: "setCurrentSiteOptimizer"; enabled: boolean; target?: OptimizerTarget }
  | { type: "resetPageOptimizer" }
  | { type: "getPageOptimizerStatus" }
  | { type: "toggleCurrentTabProtection" }
  | { type: "toggleCurrentDomainProtection" }
  | { type: "protectCurrentTab" }
  | { type: "protectCurrentDomain" }
  | { type: "saveWindowAndClose"; includeActive: boolean; includePinned: boolean }
  | { type: "saveGroupAndClose"; includeActive: boolean; includePinned: boolean }
  | { type: "saveSelectionAndClose"; includeActive: boolean; includePinned: boolean }
  | { type: "restoreSession"; sessionId: string; target: RestoreTarget }
  | { type: "deleteSession"; sessionId: string }
  | { type: "renameSession"; sessionId: string; name: string }
  | { type: "importSessions"; sessions: unknown }
  | { type: "restoreRecoveryCapsule"; capsuleId: string; target: RestoreTarget }
  | { type: "deleteRecoveryCapsule"; capsuleId: string }
  | { type: "captureTimelineNow" }
  | { type: "restoreTimelineSnapshot"; snapshotId: string; target: RestoreTarget }
  | { type: "deleteTimelineSnapshot"; snapshotId: string }
  | { type: "restoreTrashedSession"; trashId: string }
  | { type: "permanentlyDeleteTrashedSession"; trashId: string }
  | { type: "simulatePolicy"; patch?: Partial<Settings> }
  | { type: "getEffectReport24h" }
  | { type: "exportBackup"; selectedSections?: BackupSectionName[] }
  | { type: "importBackup"; backup: unknown; mode: ImportMode }
  | { type: "pushSelectiveSync" }
  | { type: "pullSelectiveSync" }
  | { type: "updateSettings"; patch: Partial<Settings> }
  | { type: "setNetworkFilteringMode"; mode: NetworkFilteringMode }
  | { type: "setCurrentDomainDiscardRule"; inactiveMinutes: number }
  | { type: "removeCurrentDomainDiscardRule" }
  | { type: "setSnooze"; until?: number; indefinitely?: boolean }
  | { type: "setWindowPolicy"; windowId: number; policyMode: PolicyMode | "inherit" }
  | { type: "undoDiscard"; entryId?: string }
  | { type: "addProtectionRule"; ruleType: ProtectionRuleType; value: string }
  | { type: "setProtectionRuleEnabled"; ruleId: string; enabled: boolean }
  | { type: "deleteProtectionRule"; ruleId: string }
  | { type: "clearDiscardLog" }
  | { type: "openOptions" };

export interface AppResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function sendAppMessage<T>(message: AppMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage<AppResponse<T>>(message);
  if (!response?.ok) {
    throw new Error(response?.error ?? "Unknown extension error");
  }
  return response.data as T;
}
