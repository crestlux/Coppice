import { sendAppMessage } from "../shared/messages";
import { DEFAULT_SETTINGS } from "../shared/constants";
import { optimizerItemStatuses } from "../shared/optimizerCatalog";
import { ALL_OPTIMIZER_ORIGINS } from "../shared/optimizerAccess";
import { optimizerItemMetricText, optimizerOverview } from "./optimizerPresentation";
import { activeSnoozeUntil, isSnoozed } from "../shared/snooze";
import type {
  AppState,
  AccurateModeStatus,
  ActiveTabAccurateMetrics,
  ActiveTabLeakCheckResult,
  CloseDiscardedTabsResult,
  CloseFrozenTabsResult,
  CloseTabResult,
  CurrentTabProtectionStatus,
  DiscardActionSummary,
  DiscardDecision,
  DuplicateTabGroupPreview,
  DuplicateTabsPreviewResult,
  DuplicateTabsResult,
  ExperimentalOptimizerItemId,
  ExperimentalOptimizerStatus,
  ExperimentalOptimizerToggleResult,
  FocusSetApplyResult,
  MemoryReleaseEstimate,
  SkipReason,
  NetworkDietMode,
  OpenTabsAccurateMetricsResult,
  PolicyMode,
  PressureSnapshot,
  SavedFocusSet,
  SaveAndCloseResult,
  Settings,
  TabAccurateMetrics,
  TabFocusToggleResult,
  TabProtectionToggleResult,
  UnprotectTabResult
} from "../shared/types";
import { formatBytes, formatMinutes, formatPercent } from "../shared/time";
import { getHostname, isDomainMatch, wildcardToRegExp } from "../shared/url";
import {
  getThresholdForPolicyMode,
  isPolicyThresholdEditable,
  policySettingsPatchForPolicyMode,
  thresholdPatchForPolicyMode
} from "../shared/policyPresets";
import {
  isPopupView,
  popupViewTransition,
  shouldReturnToOverviewOnEscape,
  type PopupView
} from "./popupNavigation";
import { presentPressureRootCause } from "./resourceIntelligencePresentation";
import { paintHeadroom, presentHeadroom } from "../shared/headroomPresentation";
import { optimizerMetricText } from "./optimizerPresentation";

interface PopupState {
  state: AppState;
  pressure: PressureSnapshot;
  decisions: DiscardDecision[];
  accurateMode?: AccurateModeStatus;
  currentTabProtection?: CurrentTabProtectionStatus;
  experimentalOptimizerStatus?: ExperimentalOptimizerStatus;
}

type ScanResult = PopupState & { discardedCount: number };

type TabSortMode = "priority" | "memory" | "lastUsed" | "window" | "title";
type TabRowAction = "discard" | "unprotect" | "close";
type CommandItem =
  | {
      key: string;
      kind: "tab";
      title: string;
      subtitle: string;
      keywords: string;
      tabId: number;
      windowId: number;
    }
  | {
      key: string;
      kind: "session";
      title: string;
      subtitle: string;
      keywords: string;
      sessionId: string;
    }
  | {
      key: string;
      kind: "focusSet";
      title: string;
      subtitle: string;
      keywords: string;
      setId: string;
    };
const VIEW_META: Record<PopupView, { kicker: string; title: string }> = {
  home: { kicker: "Dashboard", title: "Overview" },
  resources: { kicker: "Resources", title: "Resource details" },
  tabs: { kicker: "Tabs", title: "Open tabs" },
  discarded: { kicker: "Tabs", title: "Unloaded tabs" },
  frozen: { kicker: "Tabs", title: "Frozen tabs" },
  protected: { kicker: "Policy", title: "Protected tabs" },
  policy: { kicker: "Cleanup", title: "Automatic cleanup" },
  network: { kicker: "Network", title: "Network filtering" },
  optimizer: { kicker: "Performance", title: "Page optimizer" }
};

const elements = {
  statusLine: getElement("statusLine"),
  pressureBadge: getElement("pressureBadge"),
  overviewBrandButton: getButton("overviewBrandButton"),
  detailHeader: getElement("detailHeader"),
  overviewCommandCenter: getElement("overviewCommandCenter"),
  overviewIntelligence: getElement("overviewIntelligence"),
  overviewMetrics: getElement("overviewMetrics"),
  overviewActions: getElement("overviewActions"),
  commandSearchInput: getInput("commandSearchInput"),
  commandClearButton: getButton("commandClearButton"),
  commandHint: getElement("commandHint"),
  commandResults: getElement("commandResults"),
  powerIntelligence: getElement("powerIntelligence"),
  powerIntelligenceValue: getElement("powerIntelligenceValue"),
  powerIntelligenceDetail: getElement("powerIntelligenceDetail"),
  cpuIntelligence: getElement("cpuIntelligence"),
  cpuIntelligenceValue: getElement("cpuIntelligenceValue"),
  cpuIntelligenceDetail: getElement("cpuIntelligenceDetail"),
  rootCauseIntelligence: getElement("rootCauseIntelligence"),
  rootCauseIntelligenceValue: getElement("rootCauseIntelligenceValue"),
  rootCauseIntelligenceDetail: getElement("rootCauseIntelligenceDetail"),
  memorySaverIntelligence: getElement("memorySaverIntelligence"),
  memorySaverIntelligenceValue: getElement("memorySaverIntelligenceValue"),
  memorySaverIntelligenceDetail: getElement("memorySaverIntelligenceDetail"),
  viewKicker: getElement("viewKicker"),
  viewTitle: getElement("viewTitle"),
  backButton: getButton("backButton"),
  homeView: getElement("homeView"),
  resourcesView: getElement("resourcesView"),
  resourcePressureCard: getElement("resourcePressureCard"),
  resourcePressureValue: getElement("resourcePressureValue"),
  resourcePressureDetail: getElement("resourcePressureDetail"),
  resourceMemoryValue: getElement("resourceMemoryValue"),
  resourceMemoryDetail: getElement("resourceMemoryDetail"),
  resourceCpuValue: getElement("resourceCpuValue"),
  resourceCpuDetail: getElement("resourceCpuDetail"),
  resourceTabsValue: getElement("resourceTabsValue"),
  resourceTabsDetail: getElement("resourceTabsDetail"),
  tabsView: getElement("tabsView"),
  discardedView: getElement("discardedView"),
  frozenView: getElement("frozenView"),
  protectedView: getElement("protectedView"),
  policyView: getElement("policyView"),
  networkView: getElement("networkView"),
  optimizerView: getElement("optimizerView"),
  snoozeButton: getButton("snoozeButton"),
  snoozeDurationSelect: getSelect("snoozeDurationSelect"),
  snoozeCustomMinutes: getInput("snoozeCustomMinutes"),
  snoozeUntilLabel: getElement("snoozeUntilLabel"),
  headroomCard: getElement("headroomCard"),
  headroomGauge: getElement("headroomGauge"),
  memoryCapacityMetric: getElement("memoryCapacityMetric"),
  memoryUsedMetric: getElement("memoryUsedMetric"),
  memoryAvailableMetric: getElement("memoryAvailableMetric"),
  cpuMetric: getElement("cpuMetric"),
  tabMetric: getElement("tabMetric"),
  tabMetricDetail: getElement("tabMetricDetail"),
  discardedMetric: getElement("discardedMetric"),
  discardedMetricDetail: getElement("discardedMetricDetail"),
  releaseFreedMetric: getElement("releaseFreedMetric"),
  releaseFreedDetail: getElement("releaseFreedDetail"),
  releaseCountMetric: getElement("releaseCountMetric"),
  releaseSampleMetric: getElement("releaseSampleMetric"),
  frozenMetric: getElement("frozenMetric"),
  frozenMetricDetail: getElement("frozenMetricDetail"),
  protectedMetric: getElement("protectedMetric"),
  protectedMetricDetail: getElement("protectedMetricDetail"),
  policyMode: getElement("policyMode"),
  policyMetricDetail: getElement("policyMetricDetail"),
  policyFocusNotice: getElement("policyFocusNotice"),
  networkMode: getElement("networkMode"),
  networkMetricDetail: getElement("networkMetricDetail"),
  optimizerMode: getElement("optimizerMode"),
  optimizerMetricDetail: getElement("optimizerMetricDetail"),
  policyModeSelect: getSelect("policyModeSelect"),
  customThresholdMinutes: getInput("customThresholdMinutes"),
  networkDietModeSelect: getSelect("networkDietModeSelect"),
  accurateModeStatus: getElement("accurateModeStatus"),
  accurateModeTarget: getElement("accurateModeTarget"),
  accurateModeMetric: getElement("accurateModeMetric"),
  measureActiveTabButton: getButton("measureActiveTabButton"),
  measureOpenTabsButton: getButton("measureOpenTabsButton"),
  checkLeakButton: getButton("checkLeakButton"),
  optimizerStatus: getElement("optimizerStatus"),
  optimizerOverview: getElement("optimizerOverview"),
  optimizerOverviewLink: getButton("optimizerOverviewLink"),
  optimizerOverviewAction: getButton("optimizerOverviewAction"),
  optimizerQuickRestore: getButton("optimizerQuickRestore"),
  optimizerQuickExclude: getButton("optimizerQuickExclude"),
  optimizerTarget: getElement("optimizerTarget"),
  optimizerMetric: getElement("optimizerMetric"),
  optimizerToggleButton: getButton("optimizerToggleButton"),
  optimizerAllSitesButton: getButton("optimizerAllSitesButton"),
  optimizerAutoNote: getElement("optimizerAutoNote"),
  optimizerSiteToggleButton: getButton("optimizerSiteToggleButton"),
  optimizerResetButton: getButton("optimizerResetButton"),
  optimizerItemList: getElement("optimizerItemList"),
  focusModeStatus: getElement("focusModeStatus"),
  focusModeSummary: getElement("focusModeSummary"),
  focusModeToggleButton: getButton("focusModeToggleButton"),
  focusSetNameInput: getInput("focusSetNameInput"),
  saveFocusSetButton: getButton("saveFocusSetButton"),
  focusSetList: getElement("focusSetList"),
  discardAllBackgroundButton: getButton("discardAllBackgroundButton"),
  discardCurrentDomainButton: getButton("discardCurrentDomainButton"),
  discardOlderMinutes: getInput("discardOlderMinutes"),
  discardOlderButton: getButton("discardOlderButton"),
  domainRuleTarget: getElement("domainRuleTarget"),
  domainRuleStatus: getElement("domainRuleStatus"),
  domainRuleMinutes: getInput("domainRuleMinutes"),
  saveDomainRuleButton: getButton("saveDomainRuleButton"),
  removeDomainRuleButton: getButton("removeDomainRuleButton"),
  candidateSortSelect: getSelect("candidateSortSelect"),
  candidateList: getElement("candidateList"),
  discardedTabsList: getElement("discardedTabsList"),
  frozenTabsList: getElement("frozenTabsList"),
  closeAllDiscardedButton: getButton("closeAllDiscardedButton"),
  closeAllFrozenButton: getButton("closeAllFrozenButton"),
  protectedTabsList: getElement("protectedTabsList"),
  discardVerificationStatus: getElement("discardVerificationStatus"),
  discardVerificationSummary: getElement("discardVerificationSummary"),
  discardAttemptList: getElement("discardAttemptList"),
  messageLine: getElement("messageLine"),
  releaseButton: getButton("releaseButton"),
  closeDuplicatesButton: getButton("closeDuplicatesButton"),
  closeDiscardedButton: getButton("closeDiscardedButton"),
  duplicatePreviewSection: getElement("duplicatePreviewSection"),
  duplicatePreviewSummary: getElement("duplicatePreviewSummary"),
  duplicatePreviewList: getElement("duplicatePreviewList"),
  confirmCloseDuplicatesButton: getButton("confirmCloseDuplicatesButton"),
  hideDuplicatePreviewButton: getButton("hideDuplicatePreviewButton"),
  undoDiscardButton: getButton("undoDiscardButton"),
  protectTabButton: getButton("protectTabButton"),
  protectDomainButton: getButton("protectDomainButton"),
  saveWindowButton: getButton("saveWindowButton"),
  optionsButton: getButton("optionsButton")
};

let currentState: AppState | null = null;
let latestDecisions: DiscardDecision[] = [];
let openCommandTabs: chrome.tabs.Tab[] = [];
let commandItems: CommandItem[] = [];
let visibleCommandItems: CommandItem[] = [];
let activeCommandIndex = -1;
let tabAccurateMetrics = new Map<number, TabAccurateMetrics>();
let refreshInFlight = false;
let tabMutationInFlight = false;
const TAB_MUTATION_CONTROLS = "#releaseButton, #discardAllBackgroundButton, #discardCurrentDomainButton, #discardOlderButton, #saveWindowButton, #closeDiscardedButton, #closeAllDiscardedButton, #closeAllFrozenButton, #confirmCloseDuplicatesButton, #undoDiscardButton, [data-close-tab-id], [data-discard-tab-id]";

function setTabMutationPending(pending: boolean): void {
  tabMutationInFlight = pending;
  for (const button of document.querySelectorAll<HTMLButtonElement>(TAB_MUTATION_CONTROLS)) {
    // Keep navigation and search available while a long cleanup is running.
    // inert preserves each control's own disabled state across state refreshes.
    button.inert = pending;
    if (pending) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }
}
let openTabsMeasurementInFlight = false;
let leakCheckInFlight = false;
let lastActiveTabMetrics: ActiveTabAccurateMetrics | null = null;
let lastLeakCheckResult: ActiveTabLeakCheckResult | null = null;
let currentTabSort: TabSortMode = "priority";
let currentView: PopupView = "home";
let previewedDuplicateTabIds: number[] = [];
const HIGH_MEMORY_BYTES = 500 * 1024 * 1024;
const CRITICAL_MEMORY_BYTES = 1024 * 1024 * 1024;
const MAX_SNOOZE_MINUTES = 1440;
const TAB_SORT_STORAGE_KEY = "resourceGovernor.tabSortMode";
const TAB_MEASUREMENT_STALE_MS = 5 * 60_000;
const COMMAND_RESULT_LIMIT = 14;
const EXTERNAL_DISCARD_WINDOW_MS = 24 * 60 * 60_000;
const POPUP_REFRESH_INTERVAL_MS = 5_000;

const FALLBACK_APP_STATE: AppState = {
  settings: DEFAULT_SETTINGS,
  protectionRules: [],
  temporaryTabProtections: [],
  focusModeEnabled: false,
  focusSets: [],
  optimizedTabs: [],
  tabAccurateMetrics: [],
  windowPolicies: [],
  discardLog: [],
  sessions: [],
  lastMemoryRelease: undefined
};

const DEFAULT_ACCURATE_MODE_STATUS: AccurateModeStatus = {
  debuggerPermissionGranted: false
};

const DEFAULT_OPTIMIZER_STATUS: ExperimentalOptimizerStatus = {
  enabledInSettings: false,
  allSitesEnabled: false,
  allSitesAccessGranted: false,
  activeSiteExcluded: false,
  activeTabPaused: false,
  activeTabOptimized: false,
  activeSiteEnabled: false,
  activeSiteAccessGranted: false,
  canToggleActiveTab: false,
  siteDomains: [],
  items: optimizerItemStatuses(DEFAULT_SETTINGS),
  warning: "Beta. Every optimization can be removed from the current tab or saved site.",
  reason: "Open a regular HTTP or HTTPS page to optimize it."
};

let currentAccurateModeStatus: AccurateModeStatus = DEFAULT_ACCURATE_MODE_STATUS;
let currentOptimizerStatus: ExperimentalOptimizerStatus = DEFAULT_OPTIMIZER_STATUS;
let optimizerActionPending = false;
let optimizerMutationRevision = 0;

const EMPTY_DUPLICATE_PREVIEW: DuplicateTabsPreviewResult = {
  groups: [],
  closeCount: 0,
  duplicateGroupCount: 0,
  skippedActiveCount: 0,
  skippedPinnedCount: 0,
  skippedIncognitoCount: 0
};

const EMPTY_DUPLICATE_RESULT: DuplicateTabsResult = {
  closedCount: 0,
  duplicateGroupCount: 0,
  skippedActiveCount: 0,
  skippedPinnedCount: 0,
  skippedIncognitoCount: 0
};

const DEFAULT_CURRENT_TAB_PROTECTION: CurrentTabProtectionStatus = {
  canToggle: false,
  exactTabProtected: false,
  protectedByDomain: false,
  protectedByUrlPattern: false
};

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${id}`);
  return element;
}

function getSelect(id: string): HTMLSelectElement {
  const element = getElement(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`Missing select: ${id}`);
  return element;
}

function getInput(id: string): HTMLInputElement {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return element;
}

// Results fade after a moment; errors stay longer; a progress line ("Unload background tabs...") stays
// until its action reports back.
const MESSAGE_VISIBLE_MS = 8_000;
const ERROR_VISIBLE_MS = 20_000;
let messageTimer: number | undefined;

function setMessage(message: string, isError = false): void {
  elements.messageLine.textContent = message;
  elements.messageLine.classList.toggle("error", isError);
  window.clearTimeout(messageTimer);
  if (!message || /(\.\.\.|…)$/.test(message)) return;
  messageTimer = window.setTimeout(() => {
    if (elements.messageLine.textContent === message) setMessage("");
  }, isError ? ERROR_VISIBLE_MS : MESSAGE_VISIBLE_MS);
}

function normalizeAccurateModeStatus(status: AccurateModeStatus | undefined): AccurateModeStatus {
  return status ?? DEFAULT_ACCURATE_MODE_STATUS;
}

function normalizeOptimizerStatus(status: ExperimentalOptimizerStatus | undefined): ExperimentalOptimizerStatus {
  return {
    ...DEFAULT_OPTIMIZER_STATUS,
    ...(status ?? {})
  };
}

function optimizerOriginsForDomain(domain: string): string[] {
  const hostname = domain.trim().toLowerCase();
  if (!hostname) return [];
  return [`http://${hostname}/*`, `https://${hostname}/*`];
}

async function requestOptimizerSiteAccess(domain: string): Promise<void> {
  const origins = optimizerOriginsForDomain(domain);
  if (origins.length === 0) throw new Error("Active HTTP or HTTPS tab required.");
  // request() must be invoked directly from the click's user gesture. Chrome
  // simply resolves true when the exact origin permission was already granted.
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    throw new Error("Site access is required for automatic Optimizer re-application.");
  }
}

function normalizeDuplicatePreview(preview: DuplicateTabsPreviewResult | undefined): DuplicateTabsPreviewResult {
  if (!preview || !Array.isArray(preview.groups)) {
    return EMPTY_DUPLICATE_PREVIEW;
  }

  return {
    groups: preview.groups,
    closeCount: preview.closeCount ?? 0,
    duplicateGroupCount: preview.duplicateGroupCount ?? preview.groups.length,
    skippedActiveCount: preview.skippedActiveCount ?? 0,
    skippedPinnedCount: preview.skippedPinnedCount ?? 0,
    skippedIncognitoCount: preview.skippedIncognitoCount ?? 0
  };
}

function normalizeDuplicateResult(result: DuplicateTabsResult | undefined): DuplicateTabsResult {
  return result ?? EMPTY_DUPLICATE_RESULT;
}

function normalizeCloseDiscardedResult(result: CloseDiscardedTabsResult | undefined): CloseDiscardedTabsResult {
  return {
    closedCount: result?.closedCount ?? 0,
    skippedActiveCount: result?.skippedActiveCount ?? 0,
    skippedPinnedCount: result?.skippedPinnedCount ?? 0,
    skippedIncognitoCount: result?.skippedIncognitoCount ?? 0,
    skippedProtectedCount: result?.skippedProtectedCount ?? 0,
    skippedChangedCount: result?.skippedChangedCount ?? 0
  };
}

async function closeDiscardedTabs(): Promise<CloseDiscardedTabsResult> {
  const result = await sendAppMessage<CloseDiscardedTabsResult | undefined>({ type: "closeDiscardedTabs" });
  if (!result) throw new Error("Could not confirm which tabs can be closed. Try again.");
  return normalizeCloseDiscardedResult(result);
}

function closeTabsResultMessage(kind: string, result: CloseDiscardedTabsResult): string {
  const skipped = result.skippedActiveCount + result.skippedPinnedCount + result.skippedIncognitoCount +
    (result.skippedProtectedCount ?? 0) + (result.skippedChangedCount ?? 0);
  return skipped > 0
    ? `Closed ${pluralize(result.closedCount, `${kind} tab`)}; kept ${pluralize(skipped, "tab")} open for protection or changed state.`
    : `Closed ${pluralize(result.closedCount, `${kind} tab`)}.`;
}

async function runCloseTabsAction(
  kind: string,
  action: () => Promise<CloseDiscardedTabsResult>
): Promise<void> {
  if (tabMutationInFlight) return;
  setTabMutationPending(true);
  setMessage(`Close ${kind} tabs...`);
  try {
    const result = await action();
    await refresh({ silent: true });
    setMessage(closeTabsResultMessage(kind, result));
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    setTabMutationPending(false);
  }
}

function normalizeCurrentTabProtectionStatus(
  status: CurrentTabProtectionStatus | undefined
): CurrentTabProtectionStatus {
  return status ?? DEFAULT_CURRENT_TAB_PROTECTION;
}

function activeMetricsForStatus(status: AccurateModeStatus): ActiveTabAccurateMetrics | undefined {
  if (!lastActiveTabMetrics || lastActiveTabMetrics.activeTabId !== status.activeTabId) {
    return undefined;
  }

  return lastActiveTabMetrics;
}

function isTabSortMode(value: string): value is TabSortMode {
  return value === "priority" || value === "memory" || value === "lastUsed" || value === "window" || value === "title";
}

function loadStoredTabSortMode(): TabSortMode {
  try {
    const value = globalThis.localStorage?.getItem(TAB_SORT_STORAGE_KEY);
    return value && isTabSortMode(value) ? value : "priority";
  } catch {
    return "priority";
  }
}

function saveTabSortMode(mode: TabSortMode): void {
  try {
    globalThis.localStorage?.setItem(TAB_SORT_STORAGE_KEY, mode);
  } catch {
    // Popup storage preferences are best-effort only.
  }
}

function normalizeLeakCheckResult(result: ActiveTabLeakCheckResult | undefined): ActiveTabLeakCheckResult | null {
  if (!result || typeof result !== "object" || typeof result.verdict !== "string") {
    return null;
  }
  return result;
}

function isAccurateOperationInFlight(): boolean {
  return openTabsMeasurementInFlight || leakCheckInFlight;
}

function hasUsableMemoryMetrics(decisions: DiscardDecision[] = latestDecisions): boolean {
  return decisions.some(decision => {
    const metric = matchingTabMetric(decision);
    return Boolean(metric && !metric.error && metric.jsHeapUsedBytes != null);
  });
}

function normalizeSettings(settings: Settings | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
    experimentalOptimizerItems: {
      ...DEFAULT_SETTINGS.experimentalOptimizerItems,
      ...(settings?.experimentalOptimizerItems ?? {})
    }
  };
}

function normalizeAppState(state: AppState | undefined): AppState {
  return {
    ...FALLBACK_APP_STATE,
    ...(state ?? {}),
    settings: normalizeSettings(state?.settings),
    protectionRules: state?.protectionRules ?? [],
    temporaryTabProtections: state?.temporaryTabProtections ?? [],
    focusModeEnabled: state?.focusModeEnabled ?? false,
    focusSets: state?.focusSets ?? [],
    optimizedTabs: state?.optimizedTabs ?? [],
    tabAccurateMetrics: state?.tabAccurateMetrics ?? [],
    windowPolicies: state?.windowPolicies ?? [],
    discardLog: state?.discardLog ?? [],
    sessions: state?.sessions ?? []
  };
}

function intelligenceState(element: HTMLElement, state: "normal" | "warning" | "danger" | "muted"): void {
  element.dataset.state = state;
}

function isLowBatteryNetworkDietActive(state: AppState): boolean {
  const power = state.powerState;
  return Boolean(
    state.settings.powerPolicyMode !== "off" &&
      power?.supported &&
      power.charging === false &&
      power.level != null &&
      power.level <= state.settings.lowBatteryThreshold
  );
}

function renderResourceIntelligence(state: AppState, pressure: PressureSnapshot): void {
  const power = state.powerState;
  if (!power) {
    elements.powerIntelligenceValue.textContent = "Checking...";
    elements.powerIntelligenceDetail.textContent = "Waiting for power-state observer";
    intelligenceState(elements.powerIntelligence, "muted");
  } else if (!power.supported) {
    elements.powerIntelligenceValue.textContent = "Unavailable";
    elements.powerIntelligenceDetail.textContent = power.reason ?? "Battery status is not exposed by Chrome";
    intelligenceState(elements.powerIntelligence, "muted");
  } else {
    const level = formatPercent(power.level);
    const powerNetworkDietActive = isLowBatteryNetworkDietActive(state);
    elements.powerIntelligenceValue.textContent = `${power.charging ? "Charging" : "On battery"} · ${level}`;
    elements.powerIntelligenceDetail.textContent = power.policyApplied
      ? `${humanizeMode(power.effectivePolicyMode ?? state.settings.policyMode)} policy active${
          powerNetworkDietActive ? " · Light Network Diet" : ""
        }`
      : powerNetworkDietActive
        ? `${humanizeMode(power.effectivePolicyMode ?? state.settings.policyMode)} tabs · Light Network Diet`
        : `${humanizeMode(power.effectivePolicyMode ?? state.settings.policyMode)} policy · no override`;
    intelligenceState(
      elements.powerIntelligence,
      !power.charging && power.level != null && power.level <= state.settings.lowBatteryThreshold
        ? "warning"
        : "normal"
    );
  }

  const cpuLevel = pressure.cpuLevel ?? "unknown";
  elements.cpuIntelligenceValue.textContent =
    cpuLevel === "unknown"
      ? "Unknown"
      : `${cpuLevel === "high" ? "High load" : "Normal"} · ${formatPercent(pressure.cpuUsageRatio)}`;
  elements.cpuIntelligenceDetail.textContent =
    pressure.cause === "combined"
      ? "CPU and memory pressure combined"
      : pressure.cause === "cpu"
        ? "CPU is the main pressure"
        : "Watching CPU";
  intelligenceState(
    elements.cpuIntelligence,
    cpuLevel === "high" ? "warning" : cpuLevel === "unknown" ? "muted" : "normal"
  );

  const rootCause = state.rootCauseAssessment;
  if (!rootCause) {
    elements.rootCauseIntelligenceValue.textContent = "Insufficient data";
    elements.rootCauseIntelligenceDetail.textContent = "Confidence unavailable";
    intelligenceState(elements.rootCauseIntelligence, "muted");
  } else {
    const presentation = presentPressureRootCause(rootCause.likelyCause, rootCause.confidence);
    elements.rootCauseIntelligenceValue.textContent = presentation.headline;
    elements.rootCauseIntelligenceDetail.textContent = rootCause.summary;
    elements.rootCauseIntelligenceDetail.title = rootCause.summary;
    intelligenceState(elements.rootCauseIntelligence, presentation.visualState);
  }

  const cutoff = Date.now() - EXTERNAL_DISCARD_WINDOW_MS;
  const externalDiscards = (state.externalDiscardObservations ?? [])
    .filter(observation => observation.observedAt >= cutoff)
    .sort((a, b) => b.observedAt - a.observedAt);
  elements.memorySaverIntelligenceValue.textContent = pluralize(
    externalDiscards.length,
    "tab unloaded by others",
    "tabs unloaded by others"
  );
  elements.memorySaverIntelligenceDetail.textContent =
    externalDiscards.length > 0
      ? `By Chrome or another extension · last ${formatMinutes((Date.now() - externalDiscards[0].observedAt) / 60_000)} ago`
      : "None in the last 24 hours";
  intelligenceState(elements.memorySaverIntelligence, externalDiscards.length > 0 ? "warning" : "normal");
}

function renderResourceDetails(pressure: PressureSnapshot): void {
  const usedBytes = Math.max(0, pressure.memoryCapacityBytes - pressure.memoryAvailableBytes);
  const memoryUsedRatio = pressure.memoryCapacityBytes > 0
    ? usedBytes / pressure.memoryCapacityBytes
    : null;
  const pressureCause = pressure.cause && pressure.cause !== "none" ? `${humanizeMode(pressure.cause)} pressure` : "";

  elements.resourcePressureCard.dataset.level = pressure.level;
  elements.resourcePressureValue.textContent = pressure.memorySampleValid === false ? "Unknown" : humanizeMode(pressure.adaptive?.stage ?? pressure.level);
  elements.resourcePressureDetail.textContent = [pressureCause, `Checked ${new Date(pressure.sampledAt).toLocaleTimeString()}`]
    .filter(Boolean)
    .join(" · ");
  elements.resourceMemoryValue.textContent = pressure.memorySampleValid === false ? "Unavailable" : `${formatBytes(usedBytes)} used`;
  elements.resourceMemoryDetail.textContent = pressure.memorySampleValid === false ? "Waiting for a memory reading" : `${formatBytes(pressure.memoryAvailableBytes)} available${
    memoryUsedRatio == null ? "" : ` · ${formatPercent(memoryUsedRatio)} used`
  }`;
  elements.resourceCpuValue.textContent = pressure.cpuUsageRatio == null
    ? "Measuring…"
    : formatPercent(pressure.cpuUsageRatio);
  elements.resourceCpuDetail.textContent = pressure.cpuUsageRatio == null
    ? "Ready after the next reading"
    : pressure.cpuLevel === "high" ? "High load" : "Normal load";
  elements.resourceTabsValue.textContent = pluralize(pressure.tabCount, "tab");
  elements.resourceTabsDetail.textContent = `${pressure.discardedTabCount} unloaded · ${
    pressure.frozenTabCount
  } frozen · ${pressure.protectedTabCount} protected`;
}

function normalizeCommandText(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase();
}

function commandKindLabel(item: CommandItem): string {
  switch (item.kind) {
    case "tab":
      return "Tab";
    case "session":
      return "Session";
    case "focusSet":
      return "Focus";
  }
}

function rebuildCommandItems(): void {
  const tabItems: CommandItem[] = openCommandTabs.flatMap(tab => {
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return [];
    const domain = getHostname(tab.url) ?? "Chrome page";
    const title = tab.title?.trim() || domain || "Untitled tab";
    const state = tab.discarded ? "Unloaded" : tab.active ? "Active" : "Open";
    return [
      {
        key: `tab:${tab.id}`,
        kind: "tab",
        title,
        subtitle: [state, domain, windowLabel(tab.windowId)].filter(Boolean).join(" · "),
        keywords: `${title} ${tab.url ?? ""} ${domain} ${state}`,
        tabId: tab.id,
        windowId: tab.windowId
      }
    ];
  });

  const sessionItems: CommandItem[] = (currentState?.sessions ?? []).map(session => ({
    key: `session:${session.id}`,
    kind: "session",
    title: session.name,
    subtitle: `${pluralize(session.tabs.length, "saved tab")} · Restore in a new window`,
    keywords: `${session.name} ${session.source} ${session.tabs
      .map(tab => `${tab.title ?? ""} ${tab.url}`)
      .join(" ")}`,
    sessionId: session.id
  }));

  const focusSetItems: CommandItem[] = (currentState?.focusSets ?? []).map(set => ({
    key: `focus:${set.id}`,
    kind: "focusSet",
    title: set.name,
    subtitle: `${pluralize(set.tabs.length, "saved tab")} · Apply Focus Set`,
    keywords: `${set.name} ${set.tabs.map(tab => `${tab.title ?? ""} ${tab.url} ${tab.domain ?? ""}`).join(" ")}`,
    setId: set.id
  }));

  commandItems = [...tabItems, ...sessionItems, ...focusSetItems];
}

function scoreCommandItem(item: CommandItem, normalizedQuery: string): number {
  if (!normalizedQuery) return item.kind === "tab" ? 20 : item.kind === "focusSet" ? 10 : 8;
  const normalizedTitle = normalizeCommandText(item.title);
  const haystack = normalizeCommandText(`${item.title} ${item.subtitle} ${item.keywords} ${commandKindLabel(item)}`);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (!tokens.every(token => haystack.includes(token))) return -1;

  let score = item.kind === "tab" ? 10 : 0;
  if (normalizedTitle === normalizedQuery) score += 160;
  else if (normalizedTitle.startsWith(normalizedQuery)) score += 100;
  else if (normalizedTitle.includes(normalizedQuery)) score += 60;
  score += tokens.reduce((total, token) => total + (normalizedTitle.includes(token) ? 12 : 3), 0);
  return score;
}

let commandSearchOpen = false;

function closeCommandResults(): void {
  commandSearchOpen = false;
  elements.commandResults.hidden = true;
  elements.commandHint.hidden = true;
  elements.commandClearButton.hidden = true;
  elements.commandSearchInput.setAttribute("aria-expanded", "false");
  elements.commandSearchInput.removeAttribute("aria-activedescendant");
}

function renderCommandResults(forceOpen = false): void {
  const query = elements.commandSearchInput.value.trim();
  if (forceOpen) commandSearchOpen = true;
  elements.commandClearButton.hidden = !commandSearchOpen;
  if (!commandSearchOpen) {
    closeCommandResults();
    return;
  }

  const normalizedQuery = normalizeCommandText(query);
  const previousKey = visibleCommandItems[activeCommandIndex]?.key;
  visibleCommandItems = commandItems
    .map(item => ({ item, score: scoreCommandItem(item, normalizedQuery) }))
    .filter(result => result.score >= 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, COMMAND_RESULT_LIMIT)
    .map(result => result.item);

  const previousIndex = previousKey ? visibleCommandItems.findIndex(item => item.key === previousKey) : -1;
  activeCommandIndex = previousIndex >= 0 ? previousIndex : visibleCommandItems.length > 0 ? 0 : -1;
  elements.commandResults.textContent = "";

  if (visibleCommandItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-empty";
    empty.innerHTML = "<strong>No matches</strong><span>Try a tab title, URL, session, or Focus Set name.</span>";
    elements.commandResults.append(empty);
  } else {
    for (const [index, item] of visibleCommandItems.entries()) {
      const result = document.createElement("button");
      const kind = document.createElement("span");
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      const subtitle = document.createElement("small");
      const action = document.createElement("span");

      result.type = "button";
      result.id = `command-option-${index}`;
      result.className = `command-result ${index === activeCommandIndex ? "is-active" : ""}`;
      result.dataset.commandKey = item.key;
      result.setAttribute("role", "option");
      result.setAttribute("aria-selected", String(index === activeCommandIndex));
      kind.className = `command-kind ${item.kind}`;
      kind.textContent = commandKindLabel(item);
      copy.className = "command-result-copy";
      title.textContent = item.title;
      subtitle.textContent = item.subtitle;
      copy.append(title, subtitle);
      action.className = "command-result-action";
      action.textContent = item.kind === "tab" ? "Switch" : item.kind === "session" ? "Restore" : "Apply";
      result.append(kind, copy, action);
      elements.commandResults.append(result);
    }
  }

  elements.commandResults.hidden = false;
  elements.commandSearchInput.setAttribute("aria-expanded", "true");
  if (activeCommandIndex >= 0) {
    elements.commandSearchInput.setAttribute("aria-activedescendant", `command-option-${activeCommandIndex}`);
  } else {
    elements.commandSearchInput.removeAttribute("aria-activedescendant");
  }
  elements.commandHint.hidden = false;
  elements.commandHint.textContent = query
    ? `${visibleCommandItems.length} result${visibleCommandItems.length === 1 ? "" : "s"} · Enter to open`
    : `${openCommandTabs.length} open tabs · ${currentState?.sessions.length ?? 0} sessions · ${
        currentState?.focusSets.length ?? 0
      } Focus Sets`;
}

function moveCommandSelection(offset: number): void {
  if (visibleCommandItems.length === 0) return;
  activeCommandIndex = (activeCommandIndex + offset + visibleCommandItems.length) % visibleCommandItems.length;
  renderCommandResults(true);
  document.getElementById(`command-option-${activeCommandIndex}`)?.scrollIntoView({ block: "nearest" });
}

async function executeCommand(item: CommandItem): Promise<void> {
  closeCommandResults();
  elements.commandSearchInput.blur();

  try {
    if (item.kind === "tab") {
      setMessage(`Switching to ${item.title}...`);
      await chrome.windows.update(item.windowId, { focused: true }).catch(() => undefined);
      await chrome.tabs.update(item.tabId, { active: true });
      setMessage(`Switched to ${item.title}.`);
      return;
    }

    if (item.kind === "session") {
      setMessage(`Restoring ${item.title}...`);
      const restoredCount = await sendAppMessage<number>({
        type: "restoreSession",
        sessionId: item.sessionId,
        target: "newWindow"
      });
      await refresh({ silent: true });
      setMessage(`Restored ${pluralize(restoredCount, "tab")} from ${item.title}.`);
      return;
    }

    setMessage(`Applying ${item.title}...`);
    const result = await sendAppMessage<FocusSetApplyResult>({ type: "applyFocusSet", setId: item.setId });
    await refresh({ silent: true });
    setMessage(
      `Applied ${item.title}: ${pluralize(result.matchedCount, "open tab")} focused, ${pluralize(
        result.missingCount,
        "saved tab"
      )} missing.`
    );
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
  }
}

async function refreshCommandSources(): Promise<void> {
  try {
    openCommandTabs = await chrome.tabs.query({});
  } catch {
    openCommandTabs = [];
  }
  rebuildCommandItems();
  renderCommandResults();
}

function viewElement(view: PopupView): HTMLElement {
  switch (view) {
    case "home":
      return elements.homeView;
    case "resources":
      return elements.resourcesView;
    case "tabs":
      return elements.tabsView;
    case "discarded":
      return elements.discardedView;
    case "frozen":
      return elements.frozenView;
    case "protected":
      return elements.protectedView;
    case "policy":
      return elements.policyView;
    case "network":
      return elements.networkView;
    case "optimizer":
      return elements.optimizerView;
  }
}

type ViewFocusTarget = "back" | "overview" | "none";

interface ShowViewOptions {
  focus?: ViewFocusTarget;
  resetScroll?: boolean;
}

// The page itself never scrolls (a scrolling page makes Chrome resize the popup window); the main column does.
const popupScroller = document.querySelector<HTMLElement>(".popup-shell");

function resetPopupScroll(): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (popupScroller ?? window).scrollTo({ top: 0, left: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

// The reserved scrollbar space differs by platform (none with overlay scrollbars), so measure it once.
function reserveScrollbarSpace(): void {
  if (!popupScroller) return;
  popupScroller.style.setProperty("--gutter", `${popupScroller.offsetWidth - popupScroller.clientWidth}px`);
}
reserveScrollbarSpace();

function animateViewEntry(view: PopupView, transition: ReturnType<typeof popupViewTransition>): void {
  if (transition === "none") return;
  const panel = viewElement(view);
  panel.classList.remove("view-enter-detail", "view-enter-overview");
  void panel.offsetWidth;
  panel.classList.add(transition === "overview" ? "view-enter-overview" : "view-enter-detail");
}

function focusViewNavigation(target: ViewFocusTarget): void {
  if (target === "back") {
    elements.backButton.focus({ preventScroll: true });
  } else if (target === "overview") {
    elements.overviewBrandButton.focus({ preventScroll: true });
  }
}

function showView(view: PopupView, options: ShowViewOptions = {}): void {
  const previousView = currentView;
  const transition = popupViewTransition(previousView, view);
  const changed = transition !== "none";
  currentView = view;

  if (changed) {
    for (const key of Object.keys(VIEW_META) as PopupView[]) {
      viewElement(key).hidden = key !== view;
    }
  }

  const meta = VIEW_META[view];
  const isOverview = view === "home";
  elements.viewKicker.textContent = meta.kicker;
  elements.viewTitle.textContent = meta.title;
  elements.detailHeader.hidden = isOverview;
  elements.detailHeader.setAttribute("aria-label", `${meta.title} detail navigation`);
  elements.overviewCommandCenter.hidden = !isOverview;
  elements.overviewIntelligence.hidden = view !== "resources";
  elements.overviewMetrics.hidden = !isOverview;
  elements.overviewActions.hidden = !isOverview;
  document.body.dataset.popupView = view;
  if (isOverview) {
    elements.overviewBrandButton.setAttribute("aria-label", "Overview");
    elements.overviewBrandButton.title = "Overview";
    elements.overviewBrandButton.setAttribute("aria-current", "page");
  } else {
    elements.overviewBrandButton.setAttribute("aria-label", "Back to Overview");
    elements.overviewBrandButton.title = "Back to Overview";
    elements.overviewBrandButton.removeAttribute("aria-current");
    closeCommandResults();
  }

  for (const card of document.querySelectorAll<HTMLButtonElement>("[data-view-target]")) {
    card.classList.toggle("active", card.dataset.viewTarget === view);
  }

  if (changed) animateViewEntry(view, transition);
  if (options.resetScroll ?? changed) resetPopupScroll();
  const focusTarget = options.focus ?? (changed ? (isOverview ? "overview" : "back") : "none");
  focusViewNavigation(focusTarget);
}

function returnToOverview(): void {
  showView("home", { focus: "overview", resetScroll: true });
}

function renderQuickSettings(state: AppState): void {
  const { settings } = state;
  const focusLocked = state.focusModeEnabled;
  const customEditable = isPolicyThresholdEditable(settings.policyMode);
  const threshold = getThresholdForPolicyMode(settings, settings.policyMode);

  elements.policyModeSelect.value = settings.policyMode;
  elements.policyModeSelect.disabled = focusLocked;
  elements.policyModeSelect.title = focusLocked ? "Turn off Focus mode before changing the cleanup mode." : "";
  elements.networkDietModeSelect.value = settings.networkDietMode;
  elements.customThresholdMinutes.disabled = focusLocked || !customEditable;
  elements.customThresholdMinutes.title = focusLocked ? "Turn off Focus mode before changing when tabs unload." : "";
  // Manual mode never unloads on its own, so the field says so instead of sitting empty.
  elements.customThresholdMinutes.placeholder = threshold == null ? "Only when you ask" : "";
  elements.policyFocusNotice.hidden = !focusLocked;

  if (document.activeElement !== elements.customThresholdMinutes) {
    elements.customThresholdMinutes.value = threshold == null ? "" : String(threshold);
  }
}

function renderSnooze(settings: Settings): void {
  const until = activeSnoozeUntil(settings);
  const indefinite = Boolean(settings.snoozeIndefinitely);
  const snoozed = indefinite || Boolean(until);
  const custom = elements.snoozeDurationSelect.value === "custom";

  elements.snoozeButton.classList.toggle("active", snoozed);
  elements.snoozeButton.textContent = snoozed ? "Resume" : "Snooze";
  elements.snoozeButton.title = snoozed
    ? indefinite
      ? "Automatic cleanup is paused until you resume it."
      : `Automatic cleanup is paused until ${new Date(until as number).toLocaleTimeString()}.`
    : "Pause automatic cleanup for the selected time. Manual actions still work.";
  elements.snoozeDurationSelect.disabled = snoozed;
  elements.snoozeCustomMinutes.hidden = !custom || snoozed;
  elements.snoozeCustomMinutes.disabled = snoozed;
  elements.snoozeUntilLabel.hidden = !snoozed;
  elements.snoozeUntilLabel.textContent = indefinite
    ? "Until resumed"
    : until
      ? `Until ${new Date(until).toLocaleTimeString()}`
      : "";
}

function getSelectedSnoozeMs(): number | null {
  const value = elements.snoozeDurationSelect.value;
  if (value === "indefinite") return null;
  const minutes = value === "custom" ? Number(elements.snoozeCustomMinutes.value) : Number(value);

  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SNOOZE_MINUTES) {
    return null;
  }

  return minutes * 60_000;
}

function renderAccurateModeStatus(status: AccurateModeStatus, metrics?: ActiveTabAccurateMetrics): void {
  status = normalizeAccurateModeStatus(status);
  currentAccurateModeStatus = status;
  const enabled = status.debuggerPermissionGranted;
  const canMeasure = enabled && typeof status.activeTabId === "number";

  elements.accurateModeStatus.textContent = enabled ? "Enabled" : "Off";
  elements.accurateModeStatus.className = enabled ? "status-pill enabled" : "status-pill";
  elements.measureActiveTabButton.disabled = !canMeasure || isAccurateOperationInFlight();
  elements.measureOpenTabsButton.disabled = !enabled || isAccurateOperationInFlight();
  elements.measureOpenTabsButton.textContent = openTabsMeasurementInFlight ? "Measuring..." : "Measure all tabs";
  elements.checkLeakButton.disabled = !canMeasure || isAccurateOperationInFlight();
  elements.checkLeakButton.textContent = leakCheckInFlight ? "Checking..." : "Check for leaks";
  elements.accurateModeTarget.textContent = status.activeTabDomain
    ? `${status.activeTabDomain} · ${status.activeTabTitle ?? "Untitled"}`
    : "Open a website first";

  if (metrics) {
    const jsHeap = metrics.jsHeapUsedBytes == null ? "N/A" : formatBytes(metrics.jsHeapUsedBytes);
    const nodeCount = metrics.nodeCount == null ? "-" : Math.round(metrics.nodeCount).toLocaleString();
    elements.accurateModeMetric.textContent = `${jsHeap} JS heap · ${formatPercent(
      metrics.cpuTaskRatio ?? null
    )} task CPU · ${nodeCount} DOM nodes`;
    return;
  }

  elements.accurateModeMetric.textContent = enabled
    ? "Ready to measure JavaScript memory."
    : "Memory measurement is unavailable.";
}

function renderExperimentalOptimizerStatus(status: ExperimentalOptimizerStatus | undefined): void {
  const normalized = normalizeOptimizerStatus(status);
  currentOptimizerStatus = normalized;
  const enabled = normalized.enabledInSettings;
  const applied = normalized.activeTabOptimized;
  const available = normalized.canToggleActiveTab || applied;
  const aiMetrics = normalized.aiConversationMetrics;
  const detectedTurns = aiMetrics?.supported ? aiMetrics.detectedTurnCount : undefined;
  const optimizedTurns = aiMetrics?.supported ? aiMetrics.optimizedTurnCount : undefined;

  const overview = optimizerOverview(status);
  elements.optimizerMode.textContent = overview.mode;
  elements.optimizerMetricDetail.textContent = overview.detail;
  elements.optimizerMetricDetail.hidden = !overview.detail;
  elements.optimizerOverview.dataset.state = overview.tone;
  elements.optimizerOverviewAction.hidden = overview.action === "none" || applied || normalized.activeTabPaused;
  elements.optimizerOverviewAction.textContent = overview.action === "allow"
    ? normalized.allSitesEnabled ? "Allow website access" : "Review access"
    : "Enable all sites";
  elements.optimizerOverviewAction.disabled = optimizerActionPending;
  elements.optimizerQuickRestore.hidden = !applied && !normalized.activeTabPaused;
  elements.optimizerQuickRestore.textContent = applied ? "Pause on this tab" : "Optimize tab";
  elements.optimizerQuickRestore.disabled = optimizerActionPending;
  elements.optimizerQuickExclude.hidden = !normalized.canToggleActiveTab || normalized.activeSiteExcluded || (!applied && !normalized.activeSiteEnabled);
  elements.optimizerQuickExclude.disabled = optimizerActionPending;
  elements.optimizerStatus.textContent = normalized.items.every(item => !item.enabled) ? "Off" : applied && optimizedTurns !== undefined
    ? optimizedTurns > 0
      ? `${optimizedTurns} offscreen`
      : `${detectedTurns ?? 0} detected`
    : applied
      ? "Active"
      : available
        ? normalized.activeTabPaused ? "Paused" : "Not active"
        : "Unavailable";
  elements.optimizerStatus.className = applied ? "status-pill enabled" : "status-pill";
  elements.optimizerToggleButton.disabled = optimizerActionPending || (!normalized.canToggleActiveTab && !applied);
  elements.optimizerSiteToggleButton.disabled = optimizerActionPending || (!normalized.canToggleActiveTab && !normalized.activeSiteEnabled);
  elements.optimizerResetButton.disabled =
    optimizerActionPending || (!enabled && !normalized.allSitesEnabled && !normalized.allSitesAccessGranted &&
    normalized.siteDomains.length === 0 && !normalized.activeTabOptimized);
  const allSitesActive = enabled && normalized.allSitesEnabled && normalized.allSitesAccessGranted;
  elements.optimizerAllSitesButton.textContent = allSitesActive
    ? "Use selected sites only"
    : normalized.allSitesEnabled && !normalized.allSitesAccessGranted
      ? "Allow Automatic Optimization on All Sites"
      : "Optimize all sites automatically";
  elements.optimizerAllSitesButton.classList.toggle("active", allSitesActive);
  elements.optimizerAllSitesButton.disabled = optimizerActionPending;
  elements.optimizerAutoNote.textContent = allSitesActive
    ? "Automatic on all websites except excluded sites."
    : "Chrome will ask for website access.";
  elements.optimizerToggleButton.textContent = applied ? "Pause on this tab" : "Optimize this tab";
  elements.optimizerSiteToggleButton.textContent = normalized.allSitesEnabled
    ? normalized.activeSiteExcluded ? "Include this site" : "Exclude this site"
    : normalized.activeSiteEnabled
    ? !enabled
      ? "Resume for This Site"
      : normalized.activeSiteAccessGranted
        ? "Stop optimizing this site"
        : "Allow this site"
    : "Always optimize this site";
  elements.optimizerSiteToggleButton.classList.toggle("active", normalized.activeSiteEnabled && !normalized.activeSiteExcluded);
  elements.optimizerTarget.textContent = normalized.canToggleActiveTab && normalized.activeTabDomain
    ? normalized.activeTabDomain
    : "Select a regular web page";
  elements.optimizerMetric.textContent = optimizerMetricText(normalized);
  const focusedItem = (document.activeElement as HTMLElement | null)?.dataset.optimizerItemId;
  elements.optimizerItemList.textContent = "";

  for (const item of normalized.items) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const main = document.createElement("span");
    const title = document.createElement("strong");
    const description = document.createElement("small");

    label.className = "optimizer-item";
    checkbox.type = "checkbox";
    checkbox.checked = item.enabled;
    checkbox.disabled = optimizerActionPending;
    checkbox.dataset.optimizerItemId = item.id;
    checkbox.id = `optimizerItem-${item.id}`;
    label.htmlFor = checkbox.id;
    title.id = `${checkbox.id}-label`;
    description.id = `${checkbox.id}-description`;
    checkbox.setAttribute("aria-labelledby", title.id);
    checkbox.setAttribute("aria-describedby", description.id);
    title.textContent = item.label;
    description.textContent = item.description;
    main.append(title, description);
    const checking = item.enabled && normalized.activeTabOptimized && normalized.pageMetrics?.discoveryComplete === false && item.id !== "chatgptConversationOptimizer";
    const renderingPaused = item.enabled && normalized.activeTabOptimized && normalized.pageMetrics?.renderingBackoff &&
      ["offscreenRendering", "mediaContainment", "codeBlockContainment", "imageContainment"].includes(item.id);
    const metric = renderingPaused ? "Waiting for live content to settle"
      : checking && !item.metrics?.detected
      ? "Checking page content…"
      : optimizerItemMetricText(item, normalized.activeTabOptimized, normalized.aiConversationMetrics) + (checking ? " · Updating…" : "");
    if (metric) {
      const evidence = document.createElement("small");
      evidence.className = "optimizer-item-evidence";
      evidence.textContent = metric;
      main.append(evidence);
    }
    label.append(checkbox, main);
    elements.optimizerItemList.append(label);
    if (focusedItem === item.id && !checkbox.disabled) checkbox.focus({ preventScroll: true });
  }
}

function leakVerdictLabel(result: ActiveTabLeakCheckResult): string {
  switch (result.verdict) {
    case "likelyLeak":
      return "Likely leak";
    case "growing":
      return "Growing";
    case "stable":
      return "Stable";
    case "insufficientData":
      return "Insufficient data";
  }
}

function leakVerdictClass(result: ActiveTabLeakCheckResult): string {
  switch (result.verdict) {
    case "likelyLeak":
      return "status-pill danger";
    case "growing":
      return "status-pill warning";
    case "stable":
      return "status-pill enabled";
    case "insufficientData":
      return "status-pill";
  }
}

function formatSignedBytes(value: number | undefined): string {
  if (value == null) return "N/A";
  if (value === 0) return "0 B";
  return `${value > 0 ? "+" : "-"}${formatBytes(Math.abs(value))}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${Math.round(ms / 1000)} s`;
}

function renderLeakCheckResult(result: ActiveTabLeakCheckResult | null | undefined): void {
  if (!result) {
    renderAccurateModeStatus(currentAccurateModeStatus);
    return;
  }

  renderAccurateModeStatus(result);
  elements.accurateModeStatus.textContent = leakVerdictLabel(result);
  elements.accurateModeStatus.className = leakVerdictClass(result);

  const delta = formatSignedBytes(result.deltaBytes);
  const percent = result.deltaPercent == null ? "N/A" : formatPercent(result.deltaPercent);
  const slope = result.slopeBytesPerMinute == null ? "N/A" : `${formatSignedBytes(result.slopeBytesPerMinute)}/min`;
  const nodes = result.nodeDelta == null ? "" : ` · nodes ${result.nodeDelta >= 0 ? "+" : ""}${Math.round(result.nodeDelta).toLocaleString()}`;

  elements.accurateModeMetric.textContent = `${leakVerdictLabel(result)} · ${delta} (${percent}) over ${formatDuration(
    result.durationMs
  )} · ${slope} · ${result.increasingSampleCount}/${Math.max(0, result.sampleCount - 1)} increases${nodes}`;
}

function renderCurrentTabProtectionStatus(status: CurrentTabProtectionStatus | undefined): void {
  const currentStatus = normalizeCurrentTabProtectionStatus(status);
  const tabUrlProtected = currentStatus.exactTabProtected || currentStatus.protectedByUrlPattern;

  elements.protectTabButton.disabled = !currentStatus.canToggle;
  elements.protectDomainButton.disabled = !currentStatus.canToggle;

  if (!currentStatus.canToggle) {
    // Keep the action names; the reason goes in the hint.
    elements.protectTabButton.textContent = "Protect this tab";
    elements.protectTabButton.title = "Open a website first. Chrome pages can’t be protected.";
    elements.protectDomainButton.textContent = "Protect this site";
    elements.protectDomainButton.title = "Open a website first. Chrome pages can’t be protected.";
    return;
  }

  elements.protectTabButton.textContent = tabUrlProtected
    ? "Unprotect this tab"
    : "Protect this tab";

  if (tabUrlProtected) {
    elements.protectTabButton.title = currentStatus.exactTabProtected
      ? "Remove the exact URL protection rule for the active tab."
      : "Remove the URL pattern protection rule covering the active tab.";
  } else if (currentStatus.protectedByDomain) {
    elements.protectTabButton.title =
      "This tab is already covered by a domain rule. Clicking adds an exact tab rule without changing the domain rule.";
  } else {
    elements.protectTabButton.title = "Add an exact URL protection rule for the active tab.";
  }

  elements.protectDomainButton.textContent = currentStatus.protectedByDomain
    ? "Unprotect this site"
    : "Protect this site";
  elements.protectDomainButton.title = currentStatus.protectedByDomain
    ? `Remove the domain protection rule covering ${currentStatus.domain ?? "this tab"}.`
    : `Protect ${currentStatus.domain ?? "this domain"} from automatic cleanup.`;
}

function humanizeMode(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, char => char.toUpperCase());
}

function previewActionLabel(action: string): string {
  switch (action) {
    case "keep":
      return "Keep";
    case "close":
      return "Close";
    case "skipActive":
      return "Skip active";
    case "skipPinned":
      return "Skip pinned";
    default:
      return action;
  }
}

function appendDuplicateTabRow(container: HTMLElement, tab: DuplicateTabGroupPreview["keepTab"]): void {
  const row = document.createElement("div");
  const main = document.createElement("div");
  const title = document.createElement("span");
  const meta = document.createElement("span");
  const badge = document.createElement("span");

  row.className = `duplicate-tab ${tab.action}`;
  main.className = "duplicate-tab-main";
  title.className = "duplicate-tab-title";
  meta.className = "duplicate-tab-meta";
  badge.className = "duplicate-action";
  title.textContent = tab.title || tab.domain || tab.url || "Untitled tab";
  meta.textContent = [windowLabel(tab.windowId), tab.domain ?? tab.url ?? ""].filter(Boolean).join(" · ");
  badge.textContent = previewActionLabel(tab.action);

  main.append(title, meta);
  row.append(main, badge);
  container.append(row);
}

function renderDuplicatePreview(preview: DuplicateTabsPreviewResult): void {
  preview = normalizeDuplicatePreview(preview);
  previewedDuplicateTabIds = preview.groups.flatMap(group => group.closeTabs.map(tab => tab.tabId));
  if (preview.closeCount === 0 || previewedDuplicateTabIds.length === 0) {
    previewedDuplicateTabIds = [];
    elements.duplicatePreviewSection.hidden = true;
    elements.duplicatePreviewList.textContent = "";
    elements.confirmCloseDuplicatesButton.disabled = true;
    elements.duplicatePreviewSummary.textContent = "No duplicates";
    return;
  }

  elements.duplicatePreviewSection.hidden = false;
  elements.duplicatePreviewList.textContent = "";
  elements.confirmCloseDuplicatesButton.disabled = false;
  elements.duplicatePreviewSummary.textContent = `${preview.closeCount} to close · ${preview.duplicateGroupCount} groups`;

  if (preview.groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "duplicate-empty";
    empty.textContent = "No duplicate tabs found with the current matching rules.";
    elements.duplicatePreviewList.append(empty);
    return;
  }

  for (const group of preview.groups) {
    const groupElement = document.createElement("div");
    const title = document.createElement("div");
    const normalized = document.createElement("div");
    const list = document.createElement("div");

    groupElement.className = "duplicate-group";
    title.className = "duplicate-group-title";
    normalized.className = "duplicate-group-meta";
    list.className = "duplicate-group-list";
    title.textContent = group.displayUrl;
    normalized.textContent = `Matched as ${group.normalizedUrl}`;

    appendDuplicateTabRow(list, group.keepTab);
    for (const tab of group.closeTabs) appendDuplicateTabRow(list, tab);
    for (const tab of group.skippedTabs) appendDuplicateTabRow(list, tab);

    groupElement.append(title, normalized, list);
    elements.duplicatePreviewList.append(groupElement);
  }
}

function describeDecision(decision: DiscardDecision): string {
  if (decision.action === "discard") {
    return `${discardPriorityLabel(decision)} priority`;
  }

  switch (decision.skipReason) {
    case "active":
      return "Auto-protected: selected tab";
    case "pinned":
      return "Protected: pinned";
    case "audible":
      return "Protected: playing audio";
    case "unsavedWork":
      return "Protected: possible unsaved work";
    case "workStateUnknown":
      return "Protected: work check unavailable";
    case "discarded":
      return "Already unloaded";
    case "noTabId":
      return "Unavailable: no tab ID";
    case "noUrl":
      return "Unavailable: no URL";
    case "specialScheme":
      return "Unavailable: special URL";
    case "protectedTemporary":
      return "Protected: temporary whitelist";
    case "protectedDomain":
      return "Protected: domain rule";
    case "protectedUrlPattern":
      return "Protected: URL rule";
    case "recentlyActive":
      return "Waiting: recently used";
    case "manualPolicy":
      return "Manual policy";
    case "autoDiscardableFalse":
      return "Protected by Chrome";
    case "incognito":
      return "Protected: incognito";
    case "unknown":
      return "Unavailable";
    default:
      return "Can’t unload";
  }
}

function discardPriorityLabel(decision: DiscardDecision): "High" | "Medium" | "Low" {
  if (decision.score >= 60) return "High";
  if (decision.score >= 20) return "Medium";
  return "Low";
}

/** Window names only matter with several windows; ids like 1584237960 mean nothing to people. */
function windowLabel(windowId: number): string {
  const ids = [...new Set(latestDecisions.map(decision => decision.tab.windowId))].sort((a, b) => a - b);
  return ids.length > 1 && ids.includes(windowId) ? `Window ${ids.indexOf(windowId) + 1}` : "";
}

function getDirectDiscardBlockLabel(decision: DiscardDecision): string | null {
  if (decision.tab.tabId < 0) return "Unavailable";
  if (decision.tab.audible) return "Playing audio";
  if (decision.tab.discarded) return "Unloaded";
  if (!decision.tab.url) return "Chrome page";
  if (!decision.tab.url.startsWith("http://") && !decision.tab.url.startsWith("https://")) return "Chrome page";
  if (isFocusProtectionForDecision(decision)) return "In Focus mode";
  if (isTabWhitelisted(decision)) return "Kept loaded";
  return null;
}

function isHttpTabDecision(decision: DiscardDecision): boolean {
  return Boolean(
    decision.tab.tabId >= 0 &&
      decision.tab.url &&
      (decision.tab.url.startsWith("http://") || decision.tab.url.startsWith("https://"))
  );
}

function matchingProtectionRuleIdsForDecision(decision: DiscardDecision): string[] {
  const rules = currentState?.protectionRules ?? [];
  const url = decision.tab.url;
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return [];

  const domain = decision.tab.domain ?? getHostname(url) ?? undefined;
  const matchingIds = rules
    .filter(rule => {
      if (!rule.enabled) return false;
      if (rule.type === "domain") return Boolean(domain && isDomainMatch(domain, rule.value));
      try {
        return wildcardToRegExp(rule.value).test(url);
      } catch {
        return false;
      }
    })
    .map(rule => rule.id);

  return [...new Set(matchingIds)];
}

function canUnprotectDecision(decision: DiscardDecision): boolean {
  return matchingProtectionRuleIdsForDecision(decision).length > 0;
}

function hasMatchingProtectionRule(decision: DiscardDecision): boolean {
  return matchingProtectionRuleIdsForDecision(decision).length > 0;
}

function temporaryTabProtectionForDecision(decision: DiscardDecision) {
  return currentState?.temporaryTabProtections.find(protection => protection.tabId === decision.tab.tabId);
}

function isFocusProtectionForDecision(decision: DiscardDecision): boolean {
  const protection = temporaryTabProtectionForDecision(decision);
  return Boolean(protection && (protection.source === "focus" || protection.focus));
}

function isTemporaryWhitelistForDecision(decision: DiscardDecision): boolean {
  const protection = temporaryTabProtectionForDecision(decision);
  return Boolean(protection && protection.source !== "focus");
}

function isTabWhitelisted(decision: DiscardDecision): boolean {
  return Boolean(isTemporaryWhitelistForDecision(decision) || hasMatchingProtectionRule(decision));
}

function countRuleProtectedTabs(decisions: DiscardDecision[]): number {
  return decisions.filter(hasMatchingProtectionRule).length;
}

function countTemporaryProtectedTabs(decisions: DiscardDecision[]): number {
  return decisions.filter(isTemporaryWhitelistForDecision).length;
}

function countFocusedTabs(): number {
  return (
    currentState?.temporaryTabProtections.filter(protection => protection.source === "focus" || protection.focus)
      .length ?? 0
  );
}

function renderFocusMode(state: AppState): void {
  const focusedCount = state.temporaryTabProtections.filter(
    protection => protection.source === "focus" || protection.focus
  ).length;
  const active = state.focusModeEnabled && focusedCount > 0;

  elements.focusModeStatus.textContent = state.focusModeEnabled ? (active ? "Active" : "On") : "Off";
  elements.focusModeStatus.className = state.focusModeEnabled
    ? `status-pill ${active ? "enabled" : "warning"}`
    : "status-pill";
  elements.focusModeSummary.textContent = state.focusModeEnabled
    ? `${pluralize(focusedCount, "focused tab")} · ${active ? "Aggressive cleanup on" : "Choose Focus below"}`
    : "0 focused tabs";
  elements.focusModeToggleButton.textContent = state.focusModeEnabled ? "Turn off Focus mode" : "Turn on Focus mode";
  elements.focusModeToggleButton.classList.toggle("active", state.focusModeEnabled);
  elements.saveFocusSetButton.disabled = focusedCount === 0;
  renderFocusSets(state.focusSets);
}

function renderFocusSets(sets: SavedFocusSet[]): void {
  elements.focusSetList.textContent = "";
  if (sets.length === 0) {
    const empty = document.createElement("span");
    empty.className = "inline-empty";
    empty.textContent = "No saved Focus sets";
    elements.focusSetList.append(empty);
    return;
  }

  for (const set of sets) {
    const row = document.createElement("div");
    const main = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("small");
    const applyButton = document.createElement("button");
    const deleteButton = document.createElement("button");
    row.className = "focus-set-row";
    title.textContent = set.name;
    meta.textContent = pluralize(set.tabs.length, "saved tab");
    main.append(title, meta);
    applyButton.type = "button";
    applyButton.textContent = "Apply";
    applyButton.dataset.applyFocusSetId = set.id;
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.dataset.deleteFocusSetId = set.id;
    row.append(main, applyButton, deleteButton);
    elements.focusSetList.append(row);
  }
}

function renderDomainDiscardRule(state: AppState, domain?: string): void {
  const rule = domain ? state.settings.domainDiscardRules.find(candidate => candidate.domain === domain) : undefined;
  elements.discardCurrentDomainButton.disabled = !domain;
  elements.domainRuleTarget.textContent = domain ?? "Open a website first";
  elements.domainRuleStatus.textContent = rule
    ? `Unloads after ${rule.inactiveMinutes} minutes inactive`
    : "No rule for this site";
  if (rule) elements.domainRuleMinutes.value = String(rule.inactiveMinutes);
  elements.domainRuleMinutes.disabled = !domain;
  elements.saveDomainRuleButton.disabled = !domain;
  elements.removeDomainRuleButton.disabled = !rule;
}

function renderDiscardVerification(summary: DiscardActionSummary | undefined): void {
  elements.discardAttemptList.textContent = "";
  if (!summary) {
    elements.discardVerificationStatus.textContent = "None yet";
    elements.discardVerificationStatus.className = "status-pill";
    elements.discardVerificationSummary.textContent = "Results of the next unload appear here.";
    return;
  }

  const verified = summary.discardedCount;
  const issues = summary.skippedCount + summary.failedCount;
  elements.discardVerificationStatus.textContent = issues > 0 ? `${issues} not unloaded` : "All unloaded";
  elements.discardVerificationStatus.className = issues > 0 ? "status-pill warning" : "status-pill enabled";
  // Plain counts: unloaded, kept loaded on purpose, and failed.
  elements.discardVerificationSummary.textContent = [
    `${pluralize(verified, "tab")} unloaded`,
    summary.skippedCount ? `${summary.skippedCount} kept loaded` : "",
    summary.failedCount ? `${summary.failedCount} failed` : ""
  ].filter(Boolean).join(", ") + ".";

  for (const attempt of summary.attempts.slice(0, 8)) {
    const item = document.createElement("li");
    const main = document.createElement("span");
    const status = document.createElement("strong");
    main.textContent = attempt.title || attempt.domain || `Tab ${attempt.tabId}`;
    status.textContent = attempt.status === "discarded" ? "Unloaded" : attempt.message ?? attempt.failureReason ?? attempt.status;
    status.className = attempt.status;
    item.append(main, status);
    elements.discardAttemptList.append(item);
  }
}

function thresholdDetail(settings: Settings): string {
  const threshold = getThresholdForPolicyMode(settings);
  if (threshold == null) return "Manual unload only";
  return `${threshold}m inactive threshold`;
}

function memoryReleaseLabel(estimate: MemoryReleaseEstimate | undefined): string {
  if (!estimate) return "No estimate";
  if (estimate.status === "noDiscard") return "No tabs unloaded";
  if (estimate.status === "measurementFailed") return "Estimate failed";
  return formatSignedBytes((estimate.settledAvailableBytes ?? estimate.delayedAvailableBytes) - estimate.beforeAvailableBytes);
}

// Who started an unload, in the words people use for it.
function releaseReasonLabel(reason: MemoryReleaseEstimate["discardReason"]): string {
  return reason === "manualRelease" ? "You asked" : reason === "memoryPressure" ? "Low memory" : "Automatic cleanup";
}

function renderMemoryRelease(estimate: MemoryReleaseEstimate | undefined, _logCount: number): void {
  if (!estimate) {
    elements.discardedMetricDetail.textContent = "No unload by Coppice yet";
  } else if (estimate.status === "noDiscard") {
    elements.discardedMetricDetail.textContent = "Last time, no tabs could be unloaded";
  } else if (estimate.status === "measurementFailed") {
    elements.discardedMetricDetail.textContent = `Last unload: ${pluralize(estimate.discardedCount, "tab")}, RAM not measured`;
  } else {
    elements.discardedMetricDetail.textContent = `Last unload: ${memoryReleaseLabel(estimate)} available RAM`;
  }

  elements.releaseFreedMetric.textContent = memoryReleaseLabel(estimate);

  if (!estimate) {
    elements.releaseFreedDetail.textContent = "Includes other apps.";
    elements.releaseCountMetric.textContent = "-";
    elements.releaseSampleMetric.textContent = "No unload yet.";
    return;
  }

  if (estimate.status === "noDiscard") {
    elements.releaseFreedDetail.textContent = "No tabs could be unloaded last time.";
    elements.releaseCountMetric.textContent = "0 tabs";
    elements.releaseSampleMetric.textContent = `${releaseReasonLabel(estimate.discardReason)}, nothing to measure.`;
    return;
  }

  if (estimate.status === "measurementFailed") {
    elements.releaseFreedDetail.textContent = estimate.error ?? "Couldn’t measure memory after unloading.";
    elements.releaseCountMetric.textContent = pluralize(estimate.discardedCount, "tab");
    elements.releaseSampleMetric.textContent = `${releaseReasonLabel(estimate.discardReason)}, not measured.`;
    return;
  }

  elements.releaseFreedDetail.textContent = `Available RAM ${formatBytes(
    estimate.beforeAvailableBytes
  )} → ${formatBytes(estimate.settledAvailableBytes ?? estimate.delayedAvailableBytes)}. Includes other apps.`;
  elements.releaseCountMetric.textContent = pluralize(estimate.discardedCount, "tab");
  elements.releaseSampleMetric.textContent = `${releaseReasonLabel(estimate.discardReason)}, measured after ${
    Math.round((estimate.settledDelayMs ?? estimate.sampleDelayMs) / 1000)} s.`;
}

function discardResultMessage(label: string, result: ScanResult): string {
  const release = result.state.lastMemoryRelease;
  const summary = result.state.lastDiscardSummary;
  const issues = (summary?.failedCount ?? 0) + (summary?.skippedCount ?? 0);
  const issueSuffix = issues > 0 ? ` ${pluralize(issues, "attempt")} changed or failed; see Unload check.` : "";
  if (result.discardedCount === 0) return `${label} complete: no tabs unloaded.${issueSuffix}`;
  // Short enough for one line, so the result never pushes the popup past its height.
  const unloaded = `Unloaded ${pluralize(result.discardedCount, "tab")}`;
  if (release?.status === "measurementFailed") return `${unloaded}; RAM estimate failed.${issueSuffix}`;
  if (release?.status === "measured") return `${unloaded}. Available system RAM ${memoryReleaseLabel(release)}.${issueSuffix}`;
  return `${unloaded}.${issueSuffix}`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function protectedActionLabel(decision: DiscardDecision): string {
  switch (decision.skipReason) {
    case "active":
      return "Active";
    case "pinned":
      return "Pinned";
    case "audible":
      return "Audio";
    case "unsavedWork":
      return "Unsaved work";
    case "workStateUnknown":
      return "Check pending";
    case "protectedTemporary":
      return "Kept loaded";
    case "autoDiscardableFalse":
      return "Chrome";
    case "incognito":
      return "Incognito";
    default:
      return "Locked";
  }
}

function tabLoadLabel(decision: DiscardDecision): string {
  if (decision.tab.discarded) return "Unloaded";
  if (decision.tab.frozen) return "Frozen";
  return "Loaded";
}

function appendCandidateTag(container: HTMLElement, label: string, variant = "neutral"): void {
  const tag = document.createElement("span");
  tag.className = `candidate-tag ${variant}`;
  tag.textContent = label;
  container.append(tag);
}

function decisionVariant(decision: DiscardDecision): string {
  if (decision.action === "discard") return "success";
  if (
    decision.skipReason === "active" ||
    decision.skipReason === "pinned" ||
    decision.skipReason === "audible" ||
    decision.skipReason === "unsavedWork" ||
    decision.skipReason === "workStateUnknown" ||
    decision.skipReason === "protectedTemporary" ||
    decision.skipReason === "protectedDomain" ||
    decision.skipReason === "protectedUrlPattern" ||
    decision.skipReason === "incognito" ||
    decision.skipReason === "autoDiscardableFalse"
  ) {
    return "protected";
  }
  if (decision.skipReason === "recentlyActive" || decision.skipReason === "manualPolicy") return "warning";
  return "neutral";
}

function matchingTabMetric(decision: DiscardDecision): TabAccurateMetrics | undefined {
  const metric = tabAccurateMetrics.get(decision.tab.tabId);
  if (!metric) return undefined;
  if (metric.url && decision.tab.url && metric.url !== decision.tab.url) return undefined;
  return metric;
}

function isMemoryHeavy(metric: TabAccurateMetrics | undefined): boolean {
  return (metric?.jsHeapUsedBytes ?? 0) >= HIGH_MEMORY_BYTES;
}

function isMemoryCritical(metric: TabAccurateMetrics | undefined): boolean {
  return (metric?.jsHeapUsedBytes ?? 0) >= CRITICAL_MEMORY_BYTES;
}

function isResourceHeavy(metric: TabAccurateMetrics | undefined): boolean {
  return (metric?.cpuTaskRatio ?? 0) >= 0.2;
}

function isLeakRisk(metric: TabAccurateMetrics | undefined): boolean {
  return metric?.leakVerdict === "likelyLeak" || metric?.leakVerdict === "growing";
}

function pruneTabAccurateMetrics(decisions: DiscardDecision[]): void {
  if (tabAccurateMetrics.size === 0) return;

  const currentTabs = new Map(decisions.map(decision => [decision.tab.tabId, decision.tab.url]));
  for (const [tabId, metric] of tabAccurateMetrics.entries()) {
    const currentUrl = currentTabs.get(tabId);
    if (currentUrl == null || (metric.url && currentUrl && metric.url !== currentUrl)) {
      tabAccurateMetrics.delete(tabId);
    }
  }
}

function tabMemoryScore(decision: DiscardDecision): number {
  const metric = matchingTabMetric(decision);
  return metric?.jsHeapUsedBytes ?? -1;
}

function compareByPriority(a: DiscardDecision, b: DiscardDecision): number {
  if (a.action !== b.action) return a.action === "discard" ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  return b.inactiveMinutes - a.inactiveMinutes;
}

function compareByWindow(a: DiscardDecision, b: DiscardDecision): number {
  if (a.tab.windowId !== b.tab.windowId) return a.tab.windowId - b.tab.windowId;
  if (a.tab.active !== b.tab.active) return a.tab.active ? -1 : 1;
  return compareByTitle(a, b);
}

function compareByTitle(a: DiscardDecision, b: DiscardDecision): number {
  const titleA = (a.tab.title || a.tab.domain || "").toLowerCase();
  const titleB = (b.tab.title || b.tab.domain || "").toLowerCase();
  return titleA.localeCompare(titleB);
}

// Tabs that were never measured on purpose (unloaded, Chrome pages, incognito) already say why in their status.
const EXPECTED_MEASUREMENT_SKIPS = new Set(["no tab id", "incognito", "discarded", "special URL"]);

function formatTabResources(decision: DiscardDecision): string {
  const metric = matchingTabMetric(decision);
  if (!metric || (metric.error && EXPECTED_MEASUREMENT_SKIPS.has(metric.error))) return "";

  if (metric.error) {
    return `Unavailable · ${metric.error}`;
  }

  const stale = Date.now() - metric.sampledAt > TAB_MEASUREMENT_STALE_MS;
  const trust = stale ? "Stale measurement" : "Measured";

  const parts = [
    `JS heap ${metric.jsHeapUsedBytes == null ? "N/A" : formatBytes(metric.jsHeapUsedBytes)}${
      metric.jsHeapTotalBytes == null ? "" : ` / ${formatBytes(metric.jsHeapTotalBytes)}`
    }`,
    `CPU ${formatPercent(metric.cpuTaskRatio ?? null)}`
  ];

  if (metric.nodeCount != null) {
    parts.push(`DOM ${Math.round(metric.nodeCount).toLocaleString()}`);
  }

  return `${trust} · ${parts.join(" · ")}`;
}

function measurementTrust(metric: TabAccurateMetrics | undefined): { label: string; variant: string } | null {
  if (!metric || (metric.error && EXPECTED_MEASUREMENT_SKIPS.has(metric.error))) return null;
  if (metric.error) return { label: "Unavailable", variant: "warning" };
  const ageMinutes = Math.max(0, (Date.now() - metric.sampledAt) / 60_000);
  if (Date.now() - metric.sampledAt > TAB_MEASUREMENT_STALE_MS) {
    return { label: `Stale ${formatMinutes(ageMinutes)}`, variant: "warning" };
  }
  return { label: `Measured ${formatMinutes(ageMinutes)} ago`, variant: "success" };
}

function resourceClass(metric: TabAccurateMetrics | undefined): string {
  if (!metric || metric.error) return "candidate-resources muted";
  if (isMemoryCritical(metric) || metric.leakVerdict === "likelyLeak") return "candidate-resources danger";
  if (isMemoryHeavy(metric) || isResourceHeavy(metric) || metric.leakVerdict === "growing") return "candidate-resources warning";
  return "candidate-resources";
}

function sortTabDecisions(decisions: DiscardDecision[]): DiscardDecision[] {
  return [...decisions].sort((a, b) => {
    if (currentTabSort === "memory") {
      const memoryDiff = tabMemoryScore(b) - tabMemoryScore(a);
      if (memoryDiff !== 0) return memoryDiff;
      return compareByPriority(a, b);
    }

    if (currentTabSort === "lastUsed") {
      if (b.inactiveMinutes !== a.inactiveMinutes) return b.inactiveMinutes - a.inactiveMinutes;
      return compareByPriority(a, b);
    }

    if (currentTabSort === "window") {
      const windowDiff = compareByWindow(a, b);
      if (windowDiff !== 0) return windowDiff;
      return compareByPriority(a, b);
    }

    if (currentTabSort === "title") {
      const titleDiff = compareByTitle(a, b);
      if (titleDiff !== 0) return titleDiff;
      return compareByPriority(a, b);
    }

    const priorityDiff = compareByPriority(a, b);
    if (priorityDiff !== 0) return priorityDiff;
    return compareByWindow(a, b);
  });
}

function isSpecialTabDecision(decision: DiscardDecision): boolean {
  return (
    decision.skipReason === "specialScheme" ||
    decision.skipReason === "noUrl" ||
    decision.skipReason === "noTabId"
  );
}

function appendListEmpty(container: HTMLElement, message: string): void {
  const empty = document.createElement("li");
  empty.className = "empty-list-row";
  empty.textContent = message;
  container.append(empty);
}

function appendCandidateSectionHeader(
  container: HTMLElement,
  label: string,
  count: number,
  variant: "web" | "special"
): void {
  const header = document.createElement("li");
  const title = document.createElement("span");
  const badge = document.createElement("span");

  header.className = `candidate-section-header ${variant}`;
  title.textContent = label;
  badge.textContent = `${count} tab${count === 1 ? "" : "s"}`;

  header.append(title, badge);
  container.append(header);
}

function appendTabDecision(container: HTMLElement, decision: DiscardDecision, action: TabRowAction = "discard"): void {
  const item = document.createElement("li");
  const main = document.createElement("div");
  const title = document.createElement("span");
  const context = document.createElement("span");
  const tags = document.createElement("div");
  const memory = document.createElement("span");
  const actions = document.createElement("div");
  const focusLabel = document.createElement("label");
  const focusCheckbox = document.createElement("input");
  const focusText = document.createElement("span");
  const whitelistLabel = document.createElement("label");
  const whitelistCheckbox = document.createElement("input");
  const whitelistText = document.createElement("span");
  const discardButton = document.createElement("button");
  const directBlockLabel = getDirectDiscardBlockLabel(decision);
  const metric = matchingTabMetric(decision);
  const resourceText = formatTabResources(decision);
  const contextTarget = decision.tab.domain ?? decision.tab.url ?? "unknown";
  const temporaryProtection = temporaryTabProtectionForDecision(decision);
  const temporarilyWhitelisted = isTemporaryWhitelistForDecision(decision);
  const ruleProtected = hasMatchingProtectionRule(decision);
  const whitelisted = temporarilyWhitelisted || ruleProtected;
  const focused = isFocusProtectionForDecision(decision);
  const focusModeEnabled = currentState?.focusModeEnabled ?? false;
  const canToggleFocus = focusModeEnabled && isHttpTabDecision(decision) && !decision.tab.discarded;
  const canToggleWhitelist = isHttpTabDecision(decision) || temporarilyWhitelisted;
  const whitelistDisabled = !canToggleWhitelist || ruleProtected;

  item.classList.toggle("is-protected", Boolean(directBlockLabel) || ruleProtected);
  item.classList.toggle("is-focused", focused);
  item.classList.toggle("is-special", isSpecialTabDecision(decision));
  item.classList.toggle("has-memory", Boolean(metric && !metric.error));
  item.classList.toggle("is-discarded", decision.tab.discarded);
  item.classList.toggle("is-heavy-memory", isMemoryHeavy(metric));
  item.classList.toggle("is-leak-risk", isLeakRisk(metric));
  item.classList.toggle("is-resource-heavy", isResourceHeavy(metric));
  main.className = "candidate-main";
  actions.className = "tab-row-actions";
  title.className = "candidate-title";
  title.textContent = decision.tab.title || decision.tab.domain || decision.tab.url || "Untitled tab";
  context.className = "candidate-context";
  for (const [className, text] of [["candidate-window", windowLabel(decision.tab.windowId)], ["candidate-domain", contextTarget],
    ["candidate-time", `${formatMinutes(decision.inactiveMinutes)} ago`]]) {
    if (!text) continue;
    const part = document.createElement("span");
    part.className = className;
    part.textContent = text;
    context.append(part);
  }
  context.title = `Last used ${formatMinutes(decision.inactiveMinutes)} ago`;
  tags.className = "candidate-tags";
  if (decision.tab.active) appendCandidateTag(tags, "Active tab", "protected");
  if (decision.tab.pinned) appendCandidateTag(tags, "Pinned", "protected");
  if (decision.tab.audible && action !== "discard") appendCandidateTag(tags, "Audio", "protected");
  if (focused) appendCandidateTag(tags, "Focus", "focus");
  if (ruleProtected) appendCandidateTag(tags, "Protected by rule", "protected");
  else if (temporaryProtection?.source === "rule") appendCandidateTag(tags, "Kept loaded by rule", "success");
  else if (temporarilyWhitelisted) appendCandidateTag(tags, "Kept loaded", "success");
  // Loaded is the normal case; only unusual states get a tag.
  // Unloaded rows say so with a muted title and their button; Frozen has no other sign.
  if (decision.tab.frozen && !decision.tab.discarded) appendCandidateTag(tags, tabLoadLabel(decision));
  const trust = measurementTrust(metric);
  if (trust) appendCandidateTag(tags, trust.label, trust.variant);
  if (isMemoryCritical(metric)) appendCandidateTag(tags, "Critical memory", "danger");
  else if (isMemoryHeavy(metric)) appendCandidateTag(tags, "High memory", "warning");
  if (isResourceHeavy(metric)) appendCandidateTag(tags, "High activity", "warning");
  if (metric?.leakVerdict === "likelyLeak") appendCandidateTag(tags, "Leak risk", "danger");
  else if (metric?.leakVerdict === "growing") appendCandidateTag(tags, "Heap growing", "warning");
  // These reasons are already shown by the tags above or by the disabled button.
  const shownElsewhere: SkipReason[] = ["active", "pinned", "audible", "discarded", "specialScheme", "noUrl", "noTabId"];
  // Low is the usual priority, so only Medium and High get a chip.
  const lowPriority = decision.action === "discard" && discardPriorityLabel(decision) === "Low";
  if (!lowPriority && (decision.action === "discard" || !decision.skipReason || !shownElsewhere.includes(decision.skipReason))) {
    appendCandidateTag(tags, describeDecision(decision), decisionVariant(decision));
  }
  memory.className = resourceClass(metric);
  memory.textContent = resourceText;
  memory.hidden = !resourceText;

  focusCheckbox.type = "checkbox";
  focusCheckbox.checked = focused;
  focusCheckbox.disabled = !focusModeEnabled || (!canToggleFocus && !focused);
  focusCheckbox.dataset.focusTabId = String(decision.tab.tabId);
  focusLabel.className = ["tab-focus", focused ? "is-checked" : "", !focusModeEnabled ? "is-disabled" : ""]
    .filter(Boolean)
    .join(" ");
  focusLabel.title = focusModeEnabled
    ? focused
      ? "Remove this tab from Focus mode."
      : "Focus this tab and clean up surrounding inactive tabs."
    : "Turn on Focus mode first.";
  focusText.textContent = "Focus";
  focusLabel.append(focusCheckbox, focusText);

  whitelistCheckbox.type = "checkbox";
  // An on/off setting, so it is a switch; the native switch attribute takes over where Chrome supports it.
  whitelistCheckbox.setAttribute("switch", "");
  whitelistCheckbox.setAttribute("role", "switch");
  whitelistCheckbox.checked = whitelisted;
  whitelistCheckbox.disabled = whitelistDisabled;
  whitelistCheckbox.dataset.whitelistTabId = String(decision.tab.tabId);
  whitelistLabel.className = [
    "tab-whitelist",
    whitelisted ? "is-checked" : "",
    ruleProtected ? "is-rule-protected" : "",
    temporarilyWhitelisted ? "is-temporary" : ""
  ]
    .filter(Boolean)
    .join(" ");
  whitelistLabel.title = ruleProtected
    ? "A protection rule keeps this tab loaded. Change it in Protected tabs."
    : temporarilyWhitelisted
      ? "Stop keeping this tab loaded."
      : "Keep this tab loaded until it closes.";
  whitelistText.textContent = "Keep loaded";
  whitelistLabel.append(whitelistCheckbox, whitelistText);

  discardButton.type = "button";
  if (action === "close") {
    discardButton.textContent = "Close";
    discardButton.disabled = decision.tab.tabId < 0;
    discardButton.dataset.closeTabId = String(decision.tab.tabId);
    discardButton.className = "close-tab-action";
  } else if (action === "unprotect") {
    const canUnprotect = canUnprotectDecision(decision);
    const canUnwhitelist = !canUnprotect && temporarilyWhitelisted;
    discardButton.textContent = canUnprotect ? "Unprotect" : canUnwhitelist ? "Allow unload" : protectedActionLabel(decision);
    discardButton.disabled = !canUnprotect && !canUnwhitelist;
    discardButton.classList.toggle("unprotect-action", canUnprotect);
    discardButton.classList.toggle("unwhitelist-action", canUnwhitelist);
    if (canUnprotect) {
      discardButton.dataset.unprotectTabId = String(decision.tab.tabId);
    } else if (canUnwhitelist) {
      discardButton.dataset.unwhitelistTabId = String(decision.tab.tabId);
    }
  } else {
    discardButton.textContent = directBlockLabel ?? "Unload";
    discardButton.disabled = Boolean(directBlockLabel);
    discardButton.dataset.discardTabId = String(decision.tab.tabId);
  }

  main.append(title);
  main.append(context);
  main.append(memory);
  main.append(tags);
  if (action === "discard") {
    // The Focus toggle can only act while Focus mode is on; otherwise it is left out of the row.
    if (focusModeEnabled || focused) actions.append(focusLabel);
    actions.append(whitelistLabel);
  }
  actions.append(discardButton);
  item.append(main, actions);
  container.append(item);
}

function renderTabs(decisions: DiscardDecision[]): void {
  const sortedTabs = sortTabDecisions(decisions);
  const webTabs = sortedTabs.filter(decision => !isSpecialTabDecision(decision));
  const specialTabs = sortedTabs.filter(isSpecialTabDecision);
  const hasSpecialTabs = specialTabs.length > 0;

  elements.candidateList.textContent = "";

  if (sortedTabs.length === 0) {
    appendListEmpty(elements.candidateList, "No tabs found.");
    return;
  }

  if (webTabs.length > 0) {
    if (hasSpecialTabs) appendCandidateSectionHeader(elements.candidateList, "Web tabs", webTabs.length, "web");
    for (const decision of webTabs) appendTabDecision(elements.candidateList, decision);
  }

  if (hasSpecialTabs) {
    appendCandidateSectionHeader(elements.candidateList, "Special tabs", specialTabs.length, "special");
    for (const decision of specialTabs) appendTabDecision(elements.candidateList, decision);
  }
}

function isProtectedTabDecision(decision: DiscardDecision): boolean {
  return (
    decision.skipReason === "active" ||
    decision.skipReason === "pinned" ||
    decision.skipReason === "audible" ||
    decision.skipReason === "unsavedWork" ||
    decision.skipReason === "workStateUnknown" ||
    decision.skipReason === "protectedTemporary" ||
    decision.skipReason === "protectedDomain" ||
    decision.skipReason === "protectedUrlPattern" ||
    decision.skipReason === "autoDiscardableFalse" ||
    decision.skipReason === "incognito"
  );
}

function renderFilteredTabs(
  container: HTMLElement,
  decisions: DiscardDecision[],
  predicate: (decision: DiscardDecision) => boolean,
  emptyMessage: string,
  action: TabRowAction = "discard"
): void {
  const filtered = sortTabDecisions(decisions).filter(predicate);

  container.textContent = "";

  if (filtered.length === 0) {
    appendListEmpty(container, emptyMessage);
    return;
  }

  for (const decision of filtered) {
    appendTabDecision(container, decision, action);
  }
}

function renderDetailLists(decisions: DiscardDecision[]): void {
  renderTabs(decisions);
  renderFilteredTabs(
    elements.discardedTabsList,
    decisions,
    decision => decision.tab.discarded,
    "No unloaded tabs.",
    "close"
  );
  renderFilteredTabs(
    elements.frozenTabsList,
    decisions,
    decision => Boolean(decision.tab.frozen),
    "No frozen tabs.",
    "close"
  );
  renderFilteredTabs(
    elements.protectedTabsList,
    decisions,
    isProtectedTabDecision,
    "No protected tabs.",
    "unprotect"
  );
}

function renderHeadroom(headroom: ReturnType<typeof presentHeadroom>): void {
  paintHeadroom({
    card: elements.headroomCard,
    gauge: elements.headroomGauge,
    value: elements.memoryAvailableMetric,
    caption: elements.memoryCapacityMetric,
    used: elements.memoryUsedMetric
  }, headroom);
}

function render(data: PopupState, optimizerRevision = optimizerMutationRevision): void {
  const { pressure, decisions } = data;
  const state = normalizeAppState(data.state);
  const readyToDiscardCount = decisions.filter(decision => decision.action === "discard").length;

  currentState = state;
  renderResourceIntelligence(state, pressure);
  renderResourceDetails(pressure);
  rebuildCommandItems();
  renderCommandResults();
  for (const metric of state.tabAccurateMetrics) {
    const existing = tabAccurateMetrics.get(metric.tabId);
    if (!existing || metric.sampledAt >= existing.sampledAt) tabAccurateMetrics.set(metric.tabId, metric);
  }
  const ruleProtectedCount = countRuleProtectedTabs(decisions);
  const temporaryProtectedCount = countTemporaryProtectedTabs(decisions);
  const focusedCount = countFocusedTabs();
  latestDecisions = decisions;
  pruneTabAccurateMetrics(decisions);
  elements.statusLine.textContent = `Updated ${new Date(pressure.sampledAt).toLocaleTimeString()}`;
  const snoozed = isSnoozed(state.settings);
  elements.pressureBadge.textContent = snoozed ? "Paused" : pressure.memorySampleValid === false ? "Unknown" : humanizeMode(pressure.adaptive?.stage ?? pressure.level);
  elements.pressureBadge.className = snoozed ? "pressure paused" : `pressure ${pressure.level}`;
  renderHeadroom(presentHeadroom(pressure, state.settings, snoozed));
  elements.cpuMetric.textContent = pressure.cpuUsageRatio == null ? "Measuring…" : formatPercent(pressure.cpuUsageRatio);
  elements.tabMetric.textContent = String(pressure.tabCount);
  const measuredTabCount = decisions.filter(decision => {
    const metric = matchingTabMetric(decision);
    return Boolean(metric && !metric.error && Date.now() - metric.sampledAt <= TAB_MEASUREMENT_STALE_MS);
  }).length;
  elements.tabMetricDetail.textContent = measuredTabCount > 0
    ? `${readyToDiscardCount} ready to unload, ${measuredTabCount} measured`
    : `${readyToDiscardCount} ready to unload`;
  elements.discardedMetric.textContent = String(pressure.discardedTabCount);
  elements.closeDiscardedButton.disabled = pressure.discardedTabCount === 0;
  elements.closeAllDiscardedButton.disabled = pressure.discardedTabCount === 0;
  elements.closeAllFrozenButton.disabled = pressure.frozenTabCount === 0;
  // Same rule as the background: only a tab that is still open and still unloaded can be undone.
  const unloadedTabUrls = new Map(decisions.filter(decision => decision.tab.discarded)
    .map(decision => [decision.tab.tabId, decision.tab.url]));
  elements.undoDiscardButton.disabled = !state.discardLog.some(entry => !entry.undoneAt && !entry.reactivatedAt &&
    unloadedTabUrls.has(entry.tabId) && (!entry.url || unloadedTabUrls.get(entry.tabId) === entry.url));
  elements.undoDiscardButton.title = elements.undoDiscardButton.disabled
    ? "Nothing to undo: no tab Coppice unloaded is still waiting."
    : "Reload the tab Coppice unloaded most recently.";
  renderMemoryRelease(state.lastMemoryRelease, state.discardLog.length);
  followSettledRelease(state.lastMemoryRelease);
  renderDiscardVerification(state.lastDiscardSummary);
  elements.frozenMetric.textContent = String(pressure.frozenTabCount);
  elements.frozenMetricDetail.textContent =
    pressure.frozenTabCount > 0 ? "Chrome has frozen tabs" : "No Chrome-frozen tabs";
  elements.protectedMetric.textContent = String(pressure.protectedTabCount);
  elements.protectedMetricDetail.textContent = "Excluded from cleanup";
  elements.protectedMetricDetail.title = `${pluralize(
    ruleProtectedCount,
    "rule match",
    "rule matches"
  )} · ${pluralize(temporaryProtectedCount, "whitelist")} · ${pluralize(focusedCount, "focus tab")}`;
  elements.policyMode.textContent = state.focusModeEnabled ? "Focus mode" : humanizeMode(state.settings.policyMode);
  elements.policyMetricDetail.textContent = state.focusModeEnabled
    ? focusedCount > 0
      ? `Aggressive cleanup around ${pluralize(focusedCount, "focus tab")}`
      : "Choose Focus tabs"
    : state.settings.policyMode === "pressureAdaptive" && state.automationPlan?.inactiveThresholdMinutes != null
      ? `${state.automationPlan.inactiveThresholdMinutes} min now · ${state.automationPlan.pressureStage}`
      : thresholdDetail(state.settings);
  const powerNetworkDietActive = isLowBatteryNetworkDietActive(state);
  elements.networkMode.textContent = powerNetworkDietActive && state.settings.networkDietMode === "off"
    ? "Light (Power)"
    : humanizeMode(state.settings.networkDietMode);
  elements.networkMetricDetail.textContent = powerNetworkDietActive
    ? state.settings.networkDietMode === "light"
      ? "Light configured · low-battery policy active"
      : "Enabled for low battery"
    : state.settings.networkDietMode === "light"
      ? "Blocks common trackers"
      : "No requests blocked";
  elements.candidateSortSelect.value = currentTabSort;

  renderQuickSettings(state);
  renderFocusMode(state);
  renderDomainDiscardRule(state, data.currentTabProtection?.domain);
  renderSnooze(state.settings);
  const accurateStatus = normalizeAccurateModeStatus(data.accurateMode);

  if (lastActiveTabMetrics && lastActiveTabMetrics.activeTabId !== accurateStatus.activeTabId) {
    lastActiveTabMetrics = null;
  }

  if (lastLeakCheckResult && lastLeakCheckResult.activeTabId === accurateStatus.activeTabId) {
    renderLeakCheckResult(lastLeakCheckResult);
  } else if (lastLeakCheckResult && lastLeakCheckResult.activeTabId !== accurateStatus.activeTabId) {
    lastLeakCheckResult = null;
    renderAccurateModeStatus(accurateStatus, activeMetricsForStatus(accurateStatus));
  } else {
    renderAccurateModeStatus(accurateStatus, activeMetricsForStatus(accurateStatus));
  }
  if (!optimizerActionPending && optimizerRevision === optimizerMutationRevision) renderExperimentalOptimizerStatus(data.experimentalOptimizerStatus);
  renderCurrentTabProtectionStatus(data.currentTabProtection);
  renderDetailLists(decisions);
  if (tabMutationInFlight) setTabMutationPending(true);
}

async function refresh(options: { silent?: boolean } = {}): Promise<void> {
  if (refreshInFlight || isAccurateOperationInFlight()) return;

  refreshInFlight = true;
  const optimizerRevision = optimizerMutationRevision;
  try {
    render(await sendAppMessage<PopupState>({ type: "getPopupState" }), optimizerRevision);
    await refreshCommandSources();
    if (!options.silent) {
      setMessage("");
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    refreshInFlight = false;
  }
}

async function runAction<T>(label: string, action: () => Promise<T>, resultMessage?: (result: T) => string, mutatesTabs = false): Promise<void> {
  if (mutatesTabs && tabMutationInFlight) return;
  if (mutatesTabs) setTabMutationPending(true);
  setMessage(`${label}...`);
  try {
    const result = await action();
    await refresh({ silent: true });
    setMessage(resultMessage?.(result) ?? `${label} complete.`);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    if (mutatesTabs) setTabMutationPending(false);
  }
}

// System memory can move in either direction while the post-unload sample settles.
let releaseMessage: { label: string; result: ScanResult; text: string } | undefined;

function followSettledRelease(release: MemoryReleaseEstimate | undefined): void {
  const shown = releaseMessage?.result.state.lastMemoryRelease;
  if (!releaseMessage || !release || !shown || release.sampledAt !== shown.sampledAt ||
    (release.settledAvailableBytes ?? release.delayedAvailableBytes) === (shown.settledAvailableBytes ?? shown.delayedAvailableBytes) ||
    elements.messageLine.textContent !== releaseMessage.text) return;
  const result = { ...releaseMessage.result, state: { ...releaseMessage.result.state, lastMemoryRelease: release } };
  releaseMessage = { label: releaseMessage.label, result, text: discardResultMessage(releaseMessage.label, result) };
  setMessage(releaseMessage.text);
}

async function runDiscardAction(label: string, action: () => Promise<ScanResult>): Promise<void> {
  if (tabMutationInFlight) return;
  setTabMutationPending(true);
  releaseMessage = undefined;
  setMessage(`${label}...`);
  try {
    const result = await action();
    await refresh({ silent: true });
    if (result.state.lastMemoryRelease) {
      const logCount = currentState?.discardLog.length ?? result.state.discardLog.length;
      if (currentState) {
        currentState = {
          ...currentState,
          lastMemoryRelease: result.state.lastMemoryRelease
        };
      }
      renderMemoryRelease(result.state.lastMemoryRelease, logCount);
    }
    releaseMessage = { label, result, text: discardResultMessage(label, result) };
    setMessage(releaseMessage.text);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    setTabMutationPending(false);
  }
}

async function measureOpenTabsForMemorySort(options: { silent?: boolean } = {}): Promise<void> {
  if (openTabsMeasurementInFlight) return;
  if (!currentAccurateModeStatus.debuggerPermissionGranted) {
    if (!options.silent) {
      setMessage("Memory sort needs Accurate mode debugger permission; showing policy priority instead.", true);
    }
    return;
  }

  openTabsMeasurementInFlight = true;
  renderAccurateModeStatus(currentAccurateModeStatus);
  if (!options.silent) setMessage("Measure open tabs...");

  try {
    elements.measureOpenTabsButton.disabled = true;
    elements.measureOpenTabsButton.textContent = "Measuring...";
    const result = await sendAppMessage<OpenTabsAccurateMetricsResult>({ type: "measureOpenTabsAccurately" });
    tabAccurateMetrics = new Map(
      result.tabs.map(tab => {
        const existing = tabAccurateMetrics.get(tab.tabId);
        return [
          tab.tabId,
          {
            ...existing,
            ...tab,
            cpuTaskRatio: tab.cpuTaskRatio ?? existing?.cpuTaskRatio,
            leakVerdict: existing?.leakVerdict,
            leakDeltaBytes: existing?.leakDeltaBytes
          }
        ];
      })
    );
    renderDetailLists(latestDecisions);
    if (!options.silent) {
      setMessage(
        `Measured ${result.measuredCount} open tab${result.measuredCount === 1 ? "" : "s"}; ${result.failedCount} unavailable.`
      );
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    openTabsMeasurementInFlight = false;
    const status = normalizeAccurateModeStatus(
      await sendAppMessage<AccurateModeStatus>({ type: "getAccurateModeStatus" }).catch(() => undefined)
    );
    renderAccurateModeStatus(status, activeMetricsForStatus(status));
  }
}

elements.releaseButton.addEventListener("click", () => {
  void runDiscardAction("Unload background tabs", () => sendAppMessage<ScanResult>({ type: "releaseMemoryNow" }));
});

elements.discardAllBackgroundButton.addEventListener("click", () => {
  void runDiscardAction("Unload background tabs", () =>
    sendAppMessage<ScanResult>({ type: "releaseMemoryNow" })
  );
});

elements.discardCurrentDomainButton.addEventListener("click", () => {
  void runDiscardAction("Unload this site", () =>
    sendAppMessage<ScanResult>({ type: "discardCurrentDomainBackgroundTabs" })
  );
});

elements.discardOlderButton.addEventListener("click", () => {
  const inactiveMinutes = Number(elements.discardOlderMinutes.value);
  if (!Number.isFinite(inactiveMinutes) || !Number.isInteger(inactiveMinutes) || inactiveMinutes < 1 || inactiveMinutes > 43_200) {
    setMessage("Older-than minutes must be between 1 and 43200.", true);
    return;
  }
  void runDiscardAction(`Unload tabs inactive for ${Math.round(inactiveMinutes)}m`, () =>
    sendAppMessage<ScanResult>({ type: "discardTabsOlderThan", inactiveMinutes })
  );
});

elements.focusModeToggleButton.addEventListener("click", () => {
  void (async () => {
    const nextEnabled = !(currentState?.focusModeEnabled ?? false);
    setMessage(nextEnabled ? "Turn on Focus mode..." : "Turn off Focus mode...");
    try {
      await sendAppMessage<AppState>({ type: "setFocusMode", enabled: nextEnabled });
      await refresh({ silent: true });
      setMessage(nextEnabled ? "Focus mode is on. Turn on Focus for the tabs you want to keep." : "Focus mode is off.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.saveFocusSetButton.addEventListener("click", () => {
  void (async () => {
    setMessage("Save Focus set...");
    try {
      const set = await sendAppMessage<SavedFocusSet>({
        type: "saveCurrentFocusSet",
        name: elements.focusSetNameInput.value
      });
      elements.focusSetNameInput.value = "";
      await refresh({ silent: true });
      setMessage(`Saved ${set.name} with ${pluralize(set.tabs.length, "tab")}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.focusSetList.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.dataset.applyFocusSetId) {
    void (async () => {
      setMessage("Apply Focus set...");
      try {
        const result = await sendAppMessage<FocusSetApplyResult>({
          type: "applyFocusSet",
          setId: target.dataset.applyFocusSetId as string
        });
        await refresh({ silent: true });
        setMessage(
          `Focused ${pluralize(result.matchedCount, "open tab")}; ${pluralize(
            result.missingCount,
            "saved tab"
          )} missing; discarded ${pluralize(result.cleanupDiscardedCount, "background tab")}.`
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error), true);
      }
    })();
    return;
  }

  if (target.dataset.deleteFocusSetId) {
    void runAction("Delete Focus set", () =>
      sendAppMessage({ type: "deleteFocusSet", setId: target.dataset.deleteFocusSetId as string })
    );
  }
});

elements.saveDomainRuleButton.addEventListener("click", () => {
  const inactiveMinutes = Number(elements.domainRuleMinutes.value);
  if (!Number.isFinite(inactiveMinutes) || !Number.isInteger(inactiveMinutes) || inactiveMinutes < 1 || inactiveMinutes > 43_200) {
    setMessage("Domain rule minutes must be between 1 and 43200.", true);
    return;
  }
  void runAction("Save rule", () =>
    sendAppMessage({ type: "setCurrentDomainDiscardRule", inactiveMinutes })
  );
});

elements.removeDomainRuleButton.addEventListener("click", () => {
  void runAction("Remove rule", () =>
    sendAppMessage({ type: "removeCurrentDomainDiscardRule" })
  );
});

elements.backButton.addEventListener("click", () => {
  returnToOverview();
});

elements.overviewBrandButton.addEventListener("click", () => {
  returnToOverview();
});

for (const card of document.querySelectorAll<HTMLButtonElement>("[data-view-target]")) {
  card.addEventListener("click", () => {
    const view = card.dataset.viewTarget;
    if (isPopupView(view)) {
      showView(view);
    }
  });
}

elements.snoozeButton.addEventListener("click", () => {
  void (async () => {
    const settings = normalizeSettings(currentState?.settings);
    const snoozed = isSnoozed(settings);
    const wantsIndefinite = elements.snoozeDurationSelect.value === "indefinite";
    const selectedMs = getSelectedSnoozeMs();

    if (!snoozed && !wantsIndefinite && selectedMs == null) {
      setMessage(`Snooze duration must be between 1 and ${MAX_SNOOZE_MINUTES} minutes.`, true);
      return;
    }

    const nextUntil = snoozed || wantsIndefinite ? undefined : Date.now() + selectedMs!;
    const indefinitely = !snoozed && wantsIndefinite;

    setMessage(snoozed ? "Resuming automatic unloading..." : "Snoozing automatic unloading...");
    try {
      const settings = await sendAppMessage<Settings>({
        type: "setSnooze",
        until: nextUntil,
        indefinitely
      });
      if (currentState) {
        currentState = {
          ...currentState,
          settings
        };
      }
      renderSnooze(settings);
      await refresh({ silent: true });
      setMessage(
        indefinitely
          ? "Automatic unloading paused until you resume it."
          : nextUntil
            ? `Automatic unloading paused until ${new Date(nextUntil).toLocaleTimeString()}.`
            : "Automatic unloading resumed."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.snoozeDurationSelect.addEventListener("change", () => {
  if (currentState) {
    renderSnooze(currentState.settings);
    return;
  }

  elements.snoozeCustomMinutes.hidden = elements.snoozeDurationSelect.value !== "custom";
});

elements.snoozeCustomMinutes.addEventListener("change", () => {
  if (elements.snoozeDurationSelect.value === "indefinite") {
    setMessage("");
    return;
  }

  if (getSelectedSnoozeMs() == null) {
    setMessage(`Snooze duration must be between 1 and ${MAX_SNOOZE_MINUTES} minutes.`, true);
  } else {
    setMessage("");
  }
});

elements.closeDuplicatesButton.addEventListener("click", () => {
  void (async () => {
    showView("tabs");
    setMessage("Find duplicate tabs...");
    try {
      const preview = normalizeDuplicatePreview(
        await sendAppMessage<DuplicateTabsPreviewResult>({ type: "previewDuplicateTabs" })
      );
      renderDuplicatePreview(preview);
      setMessage(
        preview.closeCount === 0
          ? "No duplicate tabs found."
          : `${preview.closeCount} duplicate tab${preview.closeCount === 1 ? "" : "s"} ready to close.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.closeDiscardedButton.addEventListener("click", () => {
  void runCloseTabsAction("discarded", closeDiscardedTabs);
});

elements.closeAllDiscardedButton.addEventListener("click", () => {
  void runCloseTabsAction("discarded", closeDiscardedTabs);
});

elements.closeAllFrozenButton.addEventListener("click", () => {
  void runCloseTabsAction("frozen", () =>
    sendAppMessage<CloseFrozenTabsResult>({ type: "closeFrozenTabs" })
  );
});

elements.confirmCloseDuplicatesButton.addEventListener("click", () => {
  if (tabMutationInFlight) return;
  setTabMutationPending(true);
  void (async () => {
    setMessage("Close previewed duplicate tabs...");
    try {
      const result = normalizeDuplicateResult(
        await sendAppMessage<DuplicateTabsResult>({
          type: "closeDuplicateTabs",
          tabIds: [...previewedDuplicateTabIds]
        })
      );
      await refresh({ silent: true });
      const preview = normalizeDuplicatePreview(
        await sendAppMessage<DuplicateTabsPreviewResult>({ type: "previewDuplicateTabs" })
      );
      renderDuplicatePreview(preview);
      setMessage(
        `Closed ${result.closedCount} duplicate tab${result.closedCount === 1 ? "" : "s"} across ${
          result.duplicateGroupCount
        } group${result.duplicateGroupCount === 1 ? "" : "s"}.${
          (result.skippedProtectedCount ?? 0) + (result.skippedChangedCount ?? 0) > 0
            ? ` Kept ${pluralize((result.skippedProtectedCount ?? 0) + (result.skippedChangedCount ?? 0), "tab")} open for protection or changed state.` : ""
        }`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      setTabMutationPending(false);
    }
  })();
});

elements.hideDuplicatePreviewButton.addEventListener("click", () => {
  previewedDuplicateTabIds = [];
  elements.duplicatePreviewSection.hidden = true;
});

elements.measureActiveTabButton.addEventListener("click", () => {
  void (async () => {
    setMessage("Measure active tab...");
    try {
      const metrics = await sendAppMessage<ActiveTabAccurateMetrics>({ type: "measureActiveTabAccurately" });
      lastActiveTabMetrics = metrics;
      if (metrics.activeTabId != null) {
        const existing = tabAccurateMetrics.get(metrics.activeTabId);
        tabAccurateMetrics.set(metrics.activeTabId, {
          ...existing,
          tabId: metrics.activeTabId,
          windowId: latestDecisions.find(decision => decision.tab.tabId === metrics.activeTabId)?.tab.windowId ?? existing?.windowId ?? -1,
          title: metrics.activeTabTitle,
          domain: metrics.activeTabDomain,
          jsHeapUsedBytes: metrics.jsHeapUsedBytes,
          jsHeapTotalBytes: metrics.jsHeapTotalBytes,
          cpuTaskRatio: metrics.cpuTaskRatio,
          documentCount: metrics.documentCount,
          nodeCount: metrics.nodeCount,
          sampledAt: metrics.sampledAt
        });
        renderDetailLists(latestDecisions);
      }
      renderAccurateModeStatus(metrics, metrics);
      setMessage("Active tab measured.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.measureOpenTabsButton.addEventListener("click", () => {
  void measureOpenTabsForMemorySort();
});

elements.checkLeakButton.addEventListener("click", () => {
  void (async () => {
    if (leakCheckInFlight) return;

    leakCheckInFlight = true;
    renderAccurateModeStatus(currentAccurateModeStatus);
    setMessage("Check active tab for leak-like growth...");
    try {
      const result = normalizeLeakCheckResult(
        await sendAppMessage<ActiveTabLeakCheckResult | undefined>({ type: "checkActiveTabLeak" })
      );
      if (!result) {
        throw new Error("Leak Check returned no result. Rebuild and reload the unpacked extension.");
      }
      lastLeakCheckResult = result;

      if (result.activeTabId != null && result.finalBytes != null) {
        const existing = tabAccurateMetrics.get(result.activeTabId);
        tabAccurateMetrics.set(result.activeTabId, {
          ...existing,
          tabId: result.activeTabId,
          windowId: latestDecisions.find(decision => decision.tab.tabId === result.activeTabId)?.tab.windowId ?? existing?.windowId ?? -1,
          title: result.activeTabTitle ?? existing?.title,
          domain: result.activeTabDomain ?? existing?.domain,
          jsHeapUsedBytes: result.finalBytes,
          leakVerdict: result.verdict,
          leakDeltaBytes: result.deltaBytes,
          sampledAt: result.sampledAt
        });
        renderDetailLists(latestDecisions);
      }

      renderLeakCheckResult(result);
      setMessage(`${leakVerdictLabel(result)}: ${result.reason}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    } finally {
      leakCheckInFlight = false;
      if (lastLeakCheckResult) {
        renderLeakCheckResult(lastLeakCheckResult);
      } else {
        const status = normalizeAccurateModeStatus(
          await sendAppMessage<AccurateModeStatus>({ type: "getAccurateModeStatus" }).catch(() => undefined)
        );
        renderAccurateModeStatus(status, activeMetricsForStatus(status));
      }
    }
  })();
});

async function runOptimizerAction(
  action: () => Promise<ExperimentalOptimizerStatus>,
  message: (status: ExperimentalOptimizerStatus) => string
): Promise<void> {
  if (optimizerActionPending) return;
  const focused = document.activeElement as HTMLElement | null;
  const focusedItem = focused?.dataset.optimizerItemId;
  const startedView = currentView;
  optimizerActionPending = true;
  optimizerMutationRevision++;
  renderExperimentalOptimizerStatus(currentOptimizerStatus);
  try {
    // Invoke before any await: permission requests must retain the click gesture.
    const status = await action();
    renderExperimentalOptimizerStatus(status);
    setMessage(message(status));
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    optimizerActionPending = false;
    optimizerMutationRevision++;
    renderExperimentalOptimizerStatus(currentOptimizerStatus);
    // A successful exclusion can hide the quick action that held focus.
    if (currentView === startedView && (document.activeElement === document.body || document.activeElement === focused)) {
      const nextFocus = focusedItem
        ? elements.optimizerItemList.querySelector<HTMLInputElement>(`input[data-optimizer-item-id="${focusedItem}"]`)
        : focused;
      if (nextFocus?.isConnected && !nextFocus.hidden) nextFocus.focus();
      else if (focused === elements.optimizerQuickExclude || focused === elements.optimizerOverviewAction) elements.optimizerOverviewLink.focus();
    }
  }
}

function toggleAutomaticOptimization(): void {
  const enabled = !(currentOptimizerStatus.allSitesEnabled &&
    currentOptimizerStatus.allSitesAccessGranted && currentOptimizerStatus.enabledInSettings);
  void runOptimizerAction(async () => {
    if (enabled && !await chrome.permissions.request({ origins: ALL_OPTIMIZER_ORIGINS })) {
      throw new Error("Website access was not granted. Automatic optimization is unchanged.");
    }
    return sendAppMessage<ExperimentalOptimizerStatus>({ type: "setAllSitesOptimizer", enabled });
  }, () => enabled ? "Automatic optimization enabled for all sites." : "Automatic optimization limited to saved sites.");
}
elements.optimizerAllSitesButton.addEventListener("click", toggleAutomaticOptimization);
elements.optimizerOverviewAction.addEventListener("click", () => {
  const overview = optimizerOverview(currentOptimizerStatus);
  if (overview.action === "allow" && !currentOptimizerStatus.allSitesEnabled) {
    elements.optimizerOverviewLink.click();
    elements.optimizerSiteToggleButton.focus();
  } else toggleAutomaticOptimization();
});

function toggleCurrentTabOptimization(): void {
  const enabled = !currentOptimizerStatus.activeTabOptimized;
  const target = { tabId: currentOptimizerStatus.activeTabId!, domain: currentOptimizerStatus.activeTabDomain! };
  void runOptimizerAction(() => sendAppMessage<ExperimentalOptimizerToggleResult>({
    type: "setActiveTabOptimizer", enabled, target
  }), status => status.activeTabOptimized ? "Tab optimized." : enabled ? "Optimization could not be applied. Try again." : "Tab restored until navigation or reload.");
}
elements.optimizerToggleButton.addEventListener("click", toggleCurrentTabOptimization);
elements.optimizerQuickRestore.addEventListener("click", toggleCurrentTabOptimization);

function setCurrentSiteOptimization(enabled: boolean): void {
  const domain = currentOptimizerStatus.activeTabDomain;
  const target = { tabId: currentOptimizerStatus.activeTabId!, domain: domain! };
  void runOptimizerAction(async () => {
    if (enabled) {
      if (!domain) throw new Error("Open a website first.");
      if (!currentOptimizerStatus.allSitesAccessGranted) await requestOptimizerSiteAccess(domain);
    }
    return sendAppMessage<ExperimentalOptimizerStatus>({ type: "setCurrentSiteOptimizer", enabled, target });
  }, status => enabled
    ? status.activeTabOptimized ? "Automatic optimization enabled for this site." : "Site saved. Waiting to optimize this page."
    : "Site excluded from automatic optimization.");
}
elements.optimizerSiteToggleButton.addEventListener("click", () => {
  setCurrentSiteOptimization(currentOptimizerStatus.allSitesEnabled
    ? currentOptimizerStatus.activeSiteExcluded
    : !currentOptimizerStatus.activeSiteEnabled || !currentOptimizerStatus.activeSiteAccessGranted || !currentOptimizerStatus.enabledInSettings);
});
elements.optimizerQuickExclude.addEventListener("click", () => setCurrentSiteOptimization(false));
elements.optimizerResetButton.addEventListener("click", () => {
  void runOptimizerAction(() => sendAppMessage<ExperimentalOptimizerStatus>({ type: "resetExperimentalOptimizer" }),
    () => "Optimizer reset.");
});

elements.optimizerItemList.addEventListener("change", event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.dataset.optimizerItemId || optimizerActionPending) return;
  const itemId = target.dataset.optimizerItemId as ExperimentalOptimizerItemId;
  const enabled = target.checked;
  const wasApplied = currentOptimizerStatus.activeTabOptimized;
  void runOptimizerAction(() => sendAppMessage<ExperimentalOptimizerStatus>({
    type: "setExperimentalOptimizerItemEnabled", itemId, enabled
  }), status => wasApplied && !status.activeTabOptimized
    ? "Setting saved. Optimization could not be reapplied to this page."
    : enabled ? "Optimization enabled." : "Optimization disabled.");
});

elements.policyModeSelect.addEventListener("change", () => {
  if (currentState?.focusModeEnabled) {
    elements.policyModeSelect.value = currentState.settings.policyMode;
    setMessage("Turn off Focus mode before changing the cleanup mode.", true);
    return;
  }

  const policyMode = elements.policyModeSelect.value as PolicyMode;
  const patch = policySettingsPatchForPolicyMode(policyMode, currentState?.settings);

  void runAction("Update policy mode", () => sendAppMessage({ type: "updateSettings", patch }));
});

elements.customThresholdMinutes.addEventListener("change", () => {
  if (currentState?.focusModeEnabled) {
    elements.customThresholdMinutes.value = String(getThresholdForPolicyMode(currentState.settings) ?? "");
    setMessage("Turn off Focus mode before changing when tabs unload.", true);
    return;
  }

  const customMinutes = Number(elements.customThresholdMinutes.value);
  if (!Number.isFinite(customMinutes) || !Number.isInteger(customMinutes) || customMinutes < 1 || customMinutes > 10_080) {
    setMessage("Custom threshold must be between 1 and 10080 minutes.", true);
    return;
  }

  void runAction("Update custom threshold", () =>
    sendAppMessage({
      type: "updateSettings",
      patch: {
        policyMode: "custom",
        ...thresholdPatchForPolicyMode("custom", customMinutes)
      }
    })
  );
});

elements.networkDietModeSelect.addEventListener("change", () => {
  void runAction("Update network diet", () =>
    sendAppMessage({
      type: "setNetworkDietMode",
      mode: elements.networkDietModeSelect.value as NetworkDietMode
    })
  );
});

function handleTabListClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.dataset.closeTabId) {
    if (tabMutationInFlight) return;
    setTabMutationPending(true);
    const tabId = Number(target.dataset.closeTabId);
    void (async () => {
      target.disabled = true;
      setMessage("Close tab...");
      try {
        const result = await sendAppMessage<CloseTabResult>({ type: "closeTab", tabId });
        await refresh({ silent: true });
        setMessage(`Closed ${result.title ?? `tab ${result.tabId}`}.`);
      } catch (error) {
        target.disabled = false;
        setMessage(error instanceof Error ? error.message : String(error), true);
      } finally {
        setTabMutationPending(false);
      }
    })();
    return;
  }

  if (target.dataset.unprotectTabId) {
    void (async () => {
      setMessage("Unprotect tab...");
      try {
        const result = await sendAppMessage<UnprotectTabResult>({
          type: "unprotectTab",
          tabId: Number(target.dataset.unprotectTabId)
        });
        await refresh({ silent: true });
        setMessage(`Removed ${result.removedCount} protection rule${result.removedCount === 1 ? "" : "s"}.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error), true);
      }
    })();
    return;
  }

  if (target.dataset.unwhitelistTabId) {
    void (async () => {
      setMessage("Remove temporary whitelist...");
      try {
        await sendAppMessage<TabProtectionToggleResult>({
          type: "setTabProtection",
          tabId: Number(target.dataset.unwhitelistTabId),
          protected: false
        });
        await refresh({ silent: true });
        setMessage("Temporary whitelist removed.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error), true);
      }
    })();
    return;
  }

  if (!target.dataset.discardTabId) return;

  void runDiscardAction("Unload tab", () =>
    sendAppMessage<ScanResult>({
      type: "discardTabNow",
      tabId: Number(target.dataset.discardTabId)
    })
  );
}

function handleTabListChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    return;
  }

  if (target.dataset.focusTabId) {
    const tabId = Number(target.dataset.focusTabId);
    const focused = target.checked;
    target.disabled = true;

    void (async () => {
      setMessage(focused ? "Add focus tab..." : "Remove focus tab...");
      try {
        const result = await sendAppMessage<TabFocusToggleResult>({
          type: "setTabFocus",
          tabId,
          focused
        });
        await refresh({ silent: true });
        setMessage(
          result.focused
            ? result.cleanupDiscardedCount > 0
              ? `Focus added. Discarded ${pluralize(result.cleanupDiscardedCount, "background tab")}.`
              : result.cleanupEligibleCount > 0
                ? "Focus added. No background tabs could be unloaded."
                : `Focus added. ${pluralize(result.activeFocusCount, "focus tab")} active; no background tabs ready.`
            : `Focus removed. ${pluralize(result.activeFocusCount, "focus tab")} active.`
        );
      } catch (error) {
        target.checked = !focused;
        target.disabled = false;
        setMessage(error instanceof Error ? error.message : String(error), true);
      }
    })();
    return;
  }

  if (!target.dataset.whitelistTabId) return;

  const tabId = Number(target.dataset.whitelistTabId);
  const protectedTab = target.checked;
  target.disabled = true;

  void (async () => {
    setMessage(protectedTab ? "Whitelist tab..." : "Remove tab whitelist...");
    try {
      const result = await sendAppMessage<TabProtectionToggleResult>({
        type: "setTabProtection",
        tabId,
        protected: protectedTab
      });
      await refresh({ silent: true });
      if (!protectedTab && result.protected && result.changed) {
        setMessage("Temporary whitelist removed; another protection still applies.");
      } else if (result.protected && result.temporary) {
        setMessage(result.changed ? "Tab temporarily whitelisted." : "Tab is already temporarily whitelisted.");
      } else if (result.protected) {
        setMessage(result.changed ? "Tab protection synced from rule." : "Tab is protected by an existing rule.");
      } else {
        setMessage(result.changed ? "Temporary whitelist removed." : "No temporary whitelist found.");
      }
    } catch (error) {
      target.checked = !protectedTab;
      target.disabled = false;
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
}

elements.candidateList.addEventListener("click", handleTabListClick);
elements.discardedTabsList.addEventListener("click", handleTabListClick);
elements.frozenTabsList.addEventListener("click", handleTabListClick);
elements.protectedTabsList.addEventListener("click", handleTabListClick);
elements.candidateList.addEventListener("change", handleTabListChange);
elements.discardedTabsList.addEventListener("change", handleTabListChange);
elements.frozenTabsList.addEventListener("change", handleTabListChange);
elements.protectedTabsList.addEventListener("change", handleTabListChange);

elements.candidateSortSelect.addEventListener("change", () => {
  const value = elements.candidateSortSelect.value;
  currentTabSort = isTabSortMode(value) ? value : "priority";
  saveTabSortMode(currentTabSort);
  renderDetailLists(latestDecisions);

  if (currentTabSort === "memory" && !hasUsableMemoryMetrics()) {
    if (currentAccurateModeStatus.debuggerPermissionGranted) {
      void measureOpenTabsForMemorySort();
    } else {
      setMessage("Memory sort needs Accurate mode debugger permission; showing policy priority instead.", true);
    }
  }
});

elements.undoDiscardButton.addEventListener("click", () => {
  void runAction("Undo last unload", () => sendAppMessage({ type: "undoDiscard" }), undefined, true);
});

elements.protectTabButton.addEventListener("click", () => {
  void (async () => {
    setMessage("Toggle current tab protection...");
    try {
      const status = normalizeCurrentTabProtectionStatus(
        await sendAppMessage<CurrentTabProtectionStatus>({ type: "toggleCurrentTabProtection" })
      );
      await refresh({ silent: true });
      renderCurrentTabProtectionStatus(status);
      setMessage(
        status.exactTabProtected || status.protectedByUrlPattern
          ? "Current tab protected."
          : status.protectedByDomain || status.protectedByUrlPattern
            ? "Current tab URL protection removed; domain protection still applies."
            : "Current tab unprotected."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.protectDomainButton.addEventListener("click", () => {
  void (async () => {
    setMessage("Toggle current domain protection...");
    try {
      const status = normalizeCurrentTabProtectionStatus(
        await sendAppMessage<CurrentTabProtectionStatus>({ type: "toggleCurrentDomainProtection" })
      );
      await refresh({ silent: true });
      renderCurrentTabProtectionStatus(status);
      setMessage(status.domainRuleId ? "Current domain protected." : "Current domain unprotected.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.saveWindowButton.addEventListener("click", () => {
  void runAction("Save current window", () =>
    sendAppMessage<SaveAndCloseResult>({
      type: "saveWindowAndClose",
      includeActive: false,
      includePinned: false
    }), result => `Saved ${pluralize(result.tabs.length, "tab")}; closed ${result.closedCount}, kept ${result.keptOpenCount} open.`, true
  );
});

elements.optionsButton.addEventListener("click", () => {
  void (async () => {
    try {
      await sendAppMessage({ type: "openOptions" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), true);
    }
  })();
});

elements.commandSearchInput.addEventListener("focus", () => {
  renderCommandResults(true);
});

elements.commandSearchInput.addEventListener("pointerdown", () => renderCommandResults(true));

elements.commandSearchInput.addEventListener("input", () => {
  visibleCommandItems = [];
  activeCommandIndex = -1;
  renderCommandResults(true);
});

elements.commandSearchInput.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (elements.commandResults.hidden) renderCommandResults(true);
    else moveCommandSelection(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (elements.commandResults.hidden) renderCommandResults(true);
    else moveCommandSelection(-1);
    return;
  }
  if (event.key === "Enter") {
    if (elements.commandResults.hidden) return;
    const item = visibleCommandItems[activeCommandIndex] ?? visibleCommandItems[0];
    if (!item) return;
    event.preventDefault();
    void executeCommand(item);
    return;
  }
  if (event.key === "Escape") {
    if (elements.commandResults.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    closeCommandResults();
  }
});

elements.commandClearButton.addEventListener("click", () => {
  elements.commandSearchInput.value = "";
  visibleCommandItems = [];
  activeCommandIndex = -1;
  elements.commandSearchInput.focus();
  closeCommandResults();
});

elements.overviewCommandCenter.addEventListener("focusout", event => {
  if (!(event.relatedTarget instanceof Node) || !elements.overviewCommandCenter.contains(event.relatedTarget)) {
    closeCommandResults();
  }
});

elements.commandResults.addEventListener("pointermove", event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const result = target.closest<HTMLButtonElement>("[data-command-key]");
  if (!result) return;
  const index = visibleCommandItems.findIndex(item => item.key === result.dataset.commandKey);
  if (index < 0 || index === activeCommandIndex) return;
  activeCommandIndex = index;
  for (const [resultIndex, button] of Array.from(
    elements.commandResults.querySelectorAll<HTMLButtonElement>("[data-command-key]")
  ).entries()) {
    button.classList.toggle("is-active", resultIndex === activeCommandIndex);
    button.setAttribute("aria-selected", String(resultIndex === activeCommandIndex));
  }
  elements.commandSearchInput.setAttribute("aria-activedescendant", `command-option-${activeCommandIndex}`);
});

elements.commandResults.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const result = target.closest<HTMLButtonElement>("[data-command-key]");
  const item = visibleCommandItems.find(candidate => candidate.key === result?.dataset.commandKey);
  if (item) void executeCommand(item);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && commandSearchOpen && !event.isComposing) {
    event.preventDefault();
    elements.commandSearchInput.focus();
    closeCommandResults();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
    event.preventDefault();
    if (currentView !== "home") {
      showView("home", { focus: "none", resetScroll: true });
    }
    elements.commandSearchInput.focus();
    elements.commandSearchInput.select();
    renderCommandResults(true);
    return;
  }

  if (
    shouldReturnToOverviewOnEscape({
      key: event.key,
      currentView,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.isComposing
    })
  ) {
    event.preventDefault();
    returnToOverview();
  }
});

document.addEventListener("pointerdown", event => {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(".global-command-center")) return;
  closeCommandResults();
});

currentTabSort = loadStoredTabSortMode();
elements.candidateSortSelect.value = currentTabSort;
showView("home");
void (async () => {
  await refresh();
  if (
    currentTabSort === "memory" &&
    currentAccurateModeStatus.debuggerPermissionGranted &&
    !hasUsableMemoryMetrics()
  ) {
    void measureOpenTabsForMemorySort({ silent: true });
  }
})();

window.setInterval(() => {
  if (!document.hidden) {
    void refresh({ silent: true });
  }
}, POPUP_REFRESH_INTERVAL_MS);
