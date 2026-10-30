import { renderAutomationPlan } from "../shared/automationPanel";
import { sendAppMessage } from "../shared/messages";
import type {
  AppState,
  EffectReport24h,
  NetworkDietMode,
  PolicyMode,
  PolicySimulationResult,
  PowerPolicyMode,
  ProtectionRuleType,
  SessionImportResult,
  SaveAndCloseResult,
  Settings,
  SavedTab,
  SyncStatus,
  WindowSummary
} from "../shared/types";
import {
  BACKUP_SECTION_NAMES,
  type BackupEnvelope,
  type BackupSectionName,
  type ImportMode,
  type ImportPlan
} from "../shared/dataPortability";
import { formatDateTime, formatMinutes, formatPercent as formatRatio } from "../shared/time";
import { headroomLabel, paintHeadroom, presentHeadroom } from "../shared/headroomPresentation";
import { isSnoozed } from "../shared/snooze";
import {
  POLICY_MODE_THRESHOLD_PRESETS,
  getThresholdForPolicyMode,
  isPolicyThresholdEditable,
  policySettingsPatchForPolicyMode,
  thresholdPatchForPolicyMode
} from "../shared/policyPresets";
import {
  OPTIONS_SECTION_IDS,
  optionsSectionHash,
  resolveOptionsSectionId,
  type OptionsSectionId
} from "./optionsNavigation";

let currentState: AppState | null = null;
let activeOptionsSectionId: OptionsSectionId | null = null;
let refreshRequest = 0;
let actionInFlight = false;
type SettingsDraftGroup = "policyHeading" | "automationHeading" | "advancedHeading" | "syncHeading";
const dirtySettingsGroups = new Set<SettingsDraftGroup>();

const elements = {
  statusLine: getElement("statusLine"),
  automationPlan: getElement("automationPlan"),
  refreshButton: getButton("refreshButton"),
  powerStateSummary: getElement("powerStateSummary"),
  powerStateDetail: getElement("powerStateDetail"),
  rootCauseSummary: getElement("rootCauseSummary"),
  rootCauseDetail: getElement("rootCauseDetail"),
  memorySaverSummary: getElement("memorySaverSummary"),
  memorySaverDetail: getElement("memorySaverDetail"),
  overviewHeadroom: getElement("overviewHeadroom"),
  overviewHeadroomGauge: getElement("overviewHeadroomGauge"),
  overviewHeadroomValue: getElement("overviewHeadroomValue"),
  overviewHeadroomCaption: getElement("overviewHeadroomCaption"),
  overviewHeadroomUsed: getElement("overviewHeadroomUsed"),
  overviewHeadroomCpu: getElement("overviewHeadroomCpu"),
  overviewPressureBadge: getElement("overviewPressureBadge"),
  cpuPolicySummary: getElement("cpuPolicySummary"),
  cpuPolicyDetail: getElement("cpuPolicyDetail"),
  learnedDomainCount: getElement("learnedDomainCount"),
  learnedDomainsList: getElement("learnedDomainsList"),
  focusPolicyNotice: getElement("focusPolicyNotice"),
  policyMode: getSelect("policyMode"),
  scanIntervalMinutes: getInput("scanIntervalMinutes"),
  inactiveThresholdMinutes: getInput("inactiveThresholdMinutes"),
  maxAutoDiscardsPerScan: getInput("maxAutoDiscardsPerScan"),
  maxManualDiscardsPerAction: getInput("maxManualDiscardsPerAction"),
  memoryHighAvailableRatio: getInput("memoryHighAvailableRatio"),
  memoryEmergencyAvailableRatio: getInput("memoryEmergencyAvailableRatio"),
  protectPinned: getInput("protectPinned"),
  protectAudible: getInput("protectAudible"),
  protectUnsavedWork: getInput("protectUnsavedWork"),
  grantWorkProtectionAccessButton: getButton("grantWorkProtectionAccessButton"),
  workProtectionAccessStatus: getElement("workProtectionAccessStatus"),
  protectActive: getInput("protectActive"),
  protectIncognito: getInput("protectIncognito"),
  respectAutoDiscardableFalse: getInput("respectAutoDiscardableFalse"),
  savePolicyButton: getButton("savePolicyButton"),
  powerPolicyMode: getSelect("powerPolicyMode"),
  lowBatteryThreshold: getInput("lowBatteryThreshold"),
  autoMergeDuplicateTabs: getInput("autoMergeDuplicateTabs"),
  discardLearningEnabled: getInput("discardLearningEnabled"),
  quickReactivateMinutes: getInput("quickReactivateMinutes"),
  timeMachineEnabled: getInput("timeMachineEnabled"),
  timeMachineIntervalMinutes: getInput("timeMachineIntervalMinutes"),
  timeMachineRetention: getInput("timeMachineRetention"),
  recoveryCapsuleLimit: getInput("recoveryCapsuleLimit"),
  saveAutomationButton: getButton("saveAutomationButton"),
  simulatePolicyButton: getButton("simulatePolicyButton"),
  effectReportButton: getButton("effectReportButton"),
  simulationTimestamp: getElement("simulationTimestamp"),
  simulationResult: getElement("simulationResult"),
  effectReportTimestamp: getElement("effectReportTimestamp"),
  effectReportResult: getElement("effectReportResult"),
  windowPolicyList: getElement("windowPolicyList"),
  addRuleForm: getElement("addRuleForm"),
  newRuleType: getSelect("newRuleType"),
  newRuleValue: getInput("newRuleValue"),
  rulesList: getElement("rulesList"),
  networkDietMode: getSelect("networkDietMode"),
  includeActive: getInput("includeActive"),
  includePinned: getInput("includePinned"),
  saveWindowButton: getButton("saveWindowButton"),
  saveGroupButton: getButton("saveGroupButton"),
  saveSelectionButton: getButton("saveSelectionButton"),
  sessionsList: getElement("sessionsList"),
  sessionsJson: getTextArea("sessionsJson"),
  exportSessionsButton: getButton("exportSessionsButton"),
  importSessionsButton: getButton("importSessionsButton"),
  captureTimelineButton: getButton("captureTimelineButton"),
  capsuleCount: getElement("capsuleCount"),
  recoveryCapsulesList: getElement("recoveryCapsulesList"),
  timelineCount: getElement("timelineCount"),
  timelineList: getElement("timelineList"),
  trashCount: getElement("trashCount"),
  sessionTrashList: getElement("sessionTrashList"),
  backupJson: getTextArea("backupJson"),
  exportBackupButton: getButton("exportBackupButton"),
  backupImportMode: getSelect("backupImportMode"),
  importBackupButton: getButton("importBackupButton"),
  syncEnabled: getInput("syncEnabled"),
  syncSettings: getInput("syncSettings"),
  syncProtectionRules: getInput("syncProtectionRules"),
  syncFocusSets: getInput("syncFocusSets"),
  syncStatusBadge: getElement("syncStatusBadge"),
  syncStatusDetail: getElement("syncStatusDetail"),
  saveSyncButton: getButton("saveSyncButton"),
  pushSyncButton: getButton("pushSyncButton"),
  pullSyncButton: getButton("pullSyncButton"),
  clearLogButton: getButton("clearLogButton"),
  copyLogButton: getButton("copyLogButton"),
  logJson: getTextArea("logJson"),
  logList: getElement("logList"),
  keepDiscardLogLimit: getInput("keepDiscardLogLimit"),
  keepSessionLimit: getInput("keepSessionLimit"),
  cpuHighRatio: getInput("cpuHighRatio"),
  showBadge: getInput("showBadge"),
  privacyMode: getInput("privacyMode"),
  saveAdvancedButton: getButton("saveAdvancedButton")
};

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element;
}

function getInput(id: string): HTMLInputElement {
  const element = getElement(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return element;
}

function getSelect(id: string): HTMLSelectElement {
  const element = getElement(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`Missing select: ${id}`);
  return element;
}

function getTextArea(id: string): HTMLTextAreaElement {
  const element = getElement(id);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Missing textarea: ${id}`);
  return element;
}

function getButton(id: string): HTMLButtonElement {
  const element = getElement(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${id}`);
  return element;
}

function optionsSectionElement(sectionId: OptionsSectionId): HTMLElement {
  const section = getElement(sectionId).closest<HTMLElement>(".section");
  if (!section) throw new Error(`Missing section for heading: ${sectionId}`);
  return section;
}

function activateOptionsSection(
  sectionId: OptionsSectionId,
  options: { updateHistory?: boolean; scrollIntoView?: boolean } = {}
): void {
  const changed = activeOptionsSectionId !== sectionId;
  if (changed) {
    for (const candidateId of OPTIONS_SECTION_IDS) {
      const section = optionsSectionElement(candidateId);
      const active = candidateId === sectionId;
      section.classList.toggle("is-active", active);
      section.hidden = !active;
    }
    activeOptionsSectionId = sectionId;
  }

  for (const link of document.querySelectorAll<HTMLAnchorElement>(".options-nav a[href^='#']")) {
    const active = resolveOptionsSectionId(link.hash) === sectionId;
    link.classList.toggle("is-active", active);
    if (active) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }

  const hash = optionsSectionHash(sectionId);
  if (options.updateHistory && window.location.hash !== hash) {
    window.history.pushState({ optionsSection: sectionId }, "", hash);
  }
  if (options.scrollIntoView && changed) {
    optionsSectionElement(sectionId).scrollIntoView({ block: "start", behavior: "auto" });
  }
}

function initializeOptionsNavigation(): void {
  const activateFromLocation = (scrollIntoView = false): void => {
    const sectionId = resolveOptionsSectionId(window.location.hash);
    const canonicalHash = optionsSectionHash(sectionId);
    if (window.location.hash !== canonicalHash) {
      window.history.replaceState({ optionsSection: sectionId }, "", canonicalHash);
    }
    activateOptionsSection(sectionId, { scrollIntoView });
  };

  for (const link of document.querySelectorAll<HTMLAnchorElement>(".options-nav a[href^='#']")) {
    link.addEventListener("click", event => {
      event.preventDefault();
      activateOptionsSection(resolveOptionsSectionId(link.hash), {
        updateHistory: true,
        scrollIntoView: true
      });
    });
  }

  window.addEventListener("popstate", () => activateFromLocation(true));
  window.addEventListener("hashchange", () => activateFromLocation(true));
  activateFromLocation();
}

function setStatus(message: string, isError = false): void {
  elements.statusLine.textContent = message;
  elements.statusLine.classList.toggle("error", isError);
}

function focusSettingInput(input: HTMLInputElement): void {
  const sectionId = input.closest(".section")?.getAttribute("aria-labelledby");
  if (sectionId) activateOptionsSection(resolveOptionsSectionId(sectionId), { updateHistory: true, scrollIntoView: true });
  const disclosure = input.closest("details");
  if (disclosure) disclosure.open = true;
  input.focus();
}

function numberValue(input: HTMLInputElement): number {
  const value = Number(input.value);
  if (input.value.trim() === "" || !Number.isFinite(value) || !input.checkValidity()) {
    focusSettingInput(input);
    const minimum = input.min ? ` at least ${input.min}` : "";
    const maximum = input.max ? ` and at most ${input.max}` : "";
    const label = input.labels?.[0]?.childNodes;
    const name = label ? [...label].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(" ").trim() : input.id;
    throw new Error(`Enter a valid value for ${name || input.id}${minimum}${maximum}.`);
  }
  return value;
}

function setNumber(input: HTMLInputElement, value: number): void {
  input.value = String(value);
}

function setInactiveThresholdValue(value: number | null, editable: boolean): void {
  elements.inactiveThresholdMinutes.disabled = !editable;
  elements.inactiveThresholdMinutes.value = value == null ? "" : String(value);
}

function setPresetControlledInputsEditable(mode: PolicyMode, locked = false): void {
  const editable = isPolicyThresholdEditable(mode);

  for (const input of [
    elements.scanIntervalMinutes,
    elements.inactiveThresholdMinutes,
    elements.maxAutoDiscardsPerScan,
    elements.memoryHighAvailableRatio,
    elements.memoryEmergencyAvailableRatio
  ]) {
    input.disabled = locked || !editable;
    input.title = locked ? "Turn off Focus Mode before changing Policy Mode settings." : "";
  }
}

function applyPolicyModeValues(settings: Settings, mode: PolicyMode): Settings {
  return {
    ...settings,
    ...policySettingsPatchForPolicyMode(mode, settings)
  };
}

function renderPolicy(settings: Settings): void {
  const focusLocked = Boolean(currentState?.focusModeEnabled);

  elements.policyMode.value = settings.policyMode;
  elements.policyMode.disabled = focusLocked;
  elements.policyMode.title = focusLocked ? "Turn off Focus Mode before changing Policy Mode." : "";
  elements.focusPolicyNotice.hidden = !focusLocked;
  setNumber(elements.scanIntervalMinutes, settings.scanIntervalMinutes);
  setInactiveThresholdValue(settings.policyMode === "pressureAdaptive" ? null : getThresholdForPolicyMode(settings), !focusLocked && isPolicyThresholdEditable(settings.policyMode));
  elements.inactiveThresholdMinutes.title = focusLocked
    ? "Turn off Focus Mode before changing inactive threshold."
    : "";
  elements.inactiveThresholdMinutes.placeholder = settings.policyMode === "pressureAdaptive" ? "Adaptive: 2–45" : "";
  setPresetControlledInputsEditable(settings.policyMode, focusLocked);
  setNumber(elements.maxAutoDiscardsPerScan, settings.maxAutoDiscardsPerScan);
  setNumber(elements.maxManualDiscardsPerAction, settings.maxManualDiscardsPerAction);
  setNumber(elements.memoryHighAvailableRatio, Number((settings.memoryHighAvailableRatio * 100).toFixed(4)));
  setNumber(elements.memoryEmergencyAvailableRatio, Number((settings.memoryEmergencyAvailableRatio * 100).toFixed(4)));
  elements.protectPinned.checked = settings.protectPinned;
  elements.protectAudible.checked = settings.protectAudible;
  elements.protectUnsavedWork.checked = settings.protectUnsavedWork;
  // The active tab cannot be safely discarded. Keep the legacy setting normalized
  // on the next save while presenting the actual, non-optional behavior.
  elements.protectActive.checked = true;
  elements.protectIncognito.checked = settings.protectIncognito;
  elements.respectAutoDiscardableFalse.checked = settings.respectAutoDiscardableFalse;
}

const WORK_PROTECTION_ORIGINS = ["http://*/*", "https://*/*"];
let workAccessRequest = 0;

async function refreshWorkProtectionAccess(): Promise<void> {
  const request = ++workAccessRequest;
  try {
    const granted = await chrome.permissions.contains({ origins: WORK_PROTECTION_ORIGINS });
    if (request !== workAccessRequest) return;
    elements.grantWorkProtectionAccessButton.hidden = granted;
    elements.workProtectionAccessStatus.textContent = granted
      ? "Website access allowed."
      : "No website access. Unchecked tabs unload only when you ask or memory runs low.";
  } catch {
    if (request !== workAccessRequest) return;
    elements.grantWorkProtectionAccessButton.hidden = false;
    elements.workProtectionAccessStatus.textContent = "Couldn’t read website access. Unchecked tabs unload only when you ask or memory runs low.";
  }
}

function renderAdvanced(settings: Settings): void {
  setNumber(elements.keepDiscardLogLimit, settings.keepDiscardLogLimit);
  setNumber(elements.keepSessionLimit, settings.keepSessionLimit);
  setNumber(elements.cpuHighRatio, settings.cpuHighRatio * 100);
  elements.showBadge.checked = settings.showBadge;
  elements.privacyMode.checked = settings.privacyMode;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** unitIndex;
  return `${scaled.toFixed(scaled >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
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

function updateAutomationControlAvailability(): void {
  elements.lowBatteryThreshold.disabled = elements.powerPolicyMode.value === "off";
  elements.quickReactivateMinutes.disabled = !elements.discardLearningEnabled.checked;
  for (const input of [elements.timeMachineIntervalMinutes, elements.timeMachineRetention]) {
    input.disabled = !elements.timeMachineEnabled.checked;
  }
}

function updateSyncControlAvailability(): void {
  const enabled = elements.syncEnabled.checked;
  const sectionInputs = [elements.syncSettings, elements.syncProtectionRules, elements.syncFocusSets];
  for (const input of sectionInputs) {
    input.disabled = !enabled;
  }
  const hasSection = sectionInputs.some(input => input.checked);
  const persisted = currentState?.settings;
  const savedSelection = Boolean(
    persisted &&
      persisted.syncEnabled === enabled &&
      persisted.syncSettings === elements.syncSettings.checked &&
      persisted.syncProtectionRules === elements.syncProtectionRules.checked &&
      persisted.syncFocusSets === elements.syncFocusSets.checked
  );
  elements.pushSyncButton.disabled = !enabled || !hasSection || !savedSelection;
  elements.pullSyncButton.disabled = !enabled || !savedSelection;
}

function renderAutomation(state: AppState): void {
  const { settings } = state;
  elements.powerPolicyMode.value = settings.powerPolicyMode;
  setNumber(elements.lowBatteryThreshold, Number((settings.lowBatteryThreshold * 100).toFixed(4)));
  elements.autoMergeDuplicateTabs.checked = settings.autoMergeDuplicateTabs;
  elements.discardLearningEnabled.checked = settings.discardLearningEnabled;
  setNumber(elements.quickReactivateMinutes, settings.quickReactivateMinutes);
  elements.timeMachineEnabled.checked = settings.timeMachineEnabled;
  setNumber(elements.timeMachineIntervalMinutes, settings.timeMachineIntervalMinutes);
  setNumber(elements.timeMachineRetention, settings.timeMachineRetention);
  setNumber(elements.recoveryCapsuleLimit, settings.recoveryCapsuleLimit);
  updateAutomationControlAvailability();
}

function renderSyncSettings(settings: Settings): void {
  elements.syncEnabled.checked = settings.syncEnabled;
  elements.syncSettings.checked = settings.syncSettings;
  elements.syncProtectionRules.checked = settings.syncProtectionRules;
  elements.syncFocusSets.checked = settings.syncFocusSets;
  updateSyncControlAvailability();
}

function renderOverviewHeadroom(state: AppState): void {
  const pressure = state.lastPressure;
  if (!pressure) return;
  const headroom = presentHeadroom(pressure, state.settings, isSnoozed(state.settings));
  paintHeadroom({
    card: elements.overviewHeadroom,
    gauge: elements.overviewHeadroomGauge,
    value: elements.overviewHeadroomValue,
    caption: elements.overviewHeadroomCaption,
    used: elements.overviewHeadroomUsed
  }, headroom);
  elements.overviewPressureBadge.textContent = headroomLabel(headroom.state);
  elements.overviewHeadroomCpu.textContent = pressure.cpuUsageRatio == null ? "Measuring…" : formatRatio(pressure.cpuUsageRatio);
}

function renderIntelligence(state: AppState): void {
  renderOverviewHeadroom(state);
  renderAutomationPlan(elements.automationPlan, state.automationPlan);
  const power = state.powerState;
  if (!power) {
    elements.powerStateSummary.textContent = "Waiting for a battery sample";
    elements.powerStateDetail.textContent = "";
  } else if (!power.supported || power.level == null || power.charging == null) {
    elements.powerStateSummary.textContent = "Battery status unavailable";
    elements.powerStateDetail.textContent = power.reason ?? "Chrome did not expose battery information on this device.";
  } else {
    elements.powerStateSummary.textContent = `${formatPercent(power.level)} · ${power.charging ? "charging" : "on battery"}`;
    const network = isLowBatteryNetworkDietActive(state) ? "Light network filtering is on to save battery." : "";
    elements.powerStateDetail.textContent = power.policyApplied
      ? `Cleanup is adjusted to save battery.${network ? ` ${network}` : ""}`
      : network || "No battery adjustment needed.";
  }

  const rootCause = state.rootCauseAssessment;
  if (!rootCause) {
    elements.rootCauseSummary.textContent = "Not enough data yet";
    elements.rootCauseDetail.textContent = "";
  } else {
    const causeLabel: Record<typeof rootCause.likelyCause, string> = {
      none: "No memory pressure",
      chromeTabs: "Mostly Chrome tabs",
      mixed: "Chrome tabs and other apps",
      otherApplications: "Mostly other apps",
      insufficientData: "Not enough data yet",
      unknown: "Unclear"
    };
    elements.rootCauseSummary.textContent = causeLabel[rootCause.likelyCause];
    elements.rootCauseDetail.textContent = `${rootCause.summary}`;
  }

  const observations = state.externalDiscardObservations ?? [];
  if (observations.length === 0) {
    elements.memorySaverSummary.textContent = "Nothing unloaded by others";
    elements.memorySaverDetail.textContent = "Chrome and other extensions have not unloaded any tabs.";
  } else {
    const latest = observations.reduce((newest, item) => item.observedAt > newest.observedAt ? item : newest);
    elements.memorySaverSummary.textContent = `${observations.length} tab${observations.length === 1 ? "" : "s"} unloaded by others`;
    elements.memorySaverDetail.textContent = `By Chrome or another extension. Latest ${formatDateTime(latest.observedAt)}${latest.domain ? ` on ${latest.domain}` : ""}.`;
  }

  const pressure = state.lastPressure;
  if (!pressure || pressure.cpuUsageRatio == null) {
    elements.cpuPolicySummary.textContent = "Waiting for CPU data";
    elements.cpuPolicyDetail.textContent = `High at ${formatPercent(state.settings.cpuHighRatio)}.`;
  } else {
    const cpuHigh = pressure.cpuLevel === "high";
    elements.cpuPolicySummary.textContent = `${formatPercent(pressure.cpuUsageRatio)} · ${cpuHigh ? "high" : "normal"}`;
    elements.cpuPolicyDetail.textContent = `High at ${formatPercent(state.settings.cpuHighRatio)}.`;
  }

  const learned = [...(state.discardLearning ?? [])]
    .sort((a, b) => b.thresholdPenaltyMinutes - a.thresholdPenaltyMinutes || b.lastFeedbackAt - a.lastFeedbackAt)
    .slice(0, 8);
  elements.learnedDomainCount.textContent = `${state.discardLearning?.length ?? 0} site${state.discardLearning?.length === 1 ? "" : "s"}`;
  elements.learnedDomainsList.textContent = "";
  if (learned.length === 0) {
    elements.learnedDomainsList.className = "compact-list empty-state";
    elements.learnedDomainsList.textContent = "Sites you reopen soon after they unload will show up here.";
  } else {
    elements.learnedDomainsList.className = "compact-list";
    for (const record of learned) {
      const item = document.createElement("div");
      const domain = document.createElement("strong");
      const feedback = document.createElement("span");
      const penalty = document.createElement("span");
      item.className = "compact-item";
      domain.textContent = record.domain;
      feedback.textContent = `${record.quickReactivations} quick reopen · ${record.undoCount} Undo · ${record.observedCount ?? "?"} resolved`;
      penalty.className = "penalty-pill";
      penalty.title = "Delay relative to the current global inactivity threshold; individual site rules can differ.";
      penalty.textContent = `+${record.thresholdPenaltyMinutes} min`;
      item.append(domain, feedback, penalty);
      elements.learnedDomainsList.append(item);
    }
  }
}

function createActionButton(label: string, datasetKey: string, id: string, danger = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset[datasetKey] = id;
  if (danger) button.className = "danger-button";
  return button;
}

function createSafetyRow(titleText: string, metaText: string, actions: HTMLButtonElement[]): HTMLDivElement {
  const row = document.createElement("div");
  const main = document.createElement("div");
  const title = document.createElement("div");
  const meta = document.createElement("div");
  const actionContainer = document.createElement("div");
  row.className = "row safety-row";
  main.className = "row-main";
  title.className = "row-title";
  meta.className = "row-meta";
  actionContainer.className = "row-actions";
  title.textContent = titleText;
  meta.textContent = metaText;
  main.append(title, meta);
  actionContainer.append(...actions);
  row.append(main, actionContainer);
  return row;
}

function appendRecoveryPreview(row: HTMLElement, tabs: SavedTab[]): void {
  const details = document.createElement("details");
  details.className = "recovery-preview";
  const summary = document.createElement("summary");
  summary.textContent = `View ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
  const list = document.createElement("ul");
  for (const tab of tabs) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const address = document.createElement("span");
    title.textContent = tab.title || tab.url;
    address.textContent = tab.url;
    item.append(title, address);
    list.append(item);
  }
  details.append(summary, list);
  row.querySelector(".row-main")?.append(details);
}

function setRecoveryEmpty(container: HTMLElement, message: string): void {
  const empty = document.createElement("p");
  empty.className = "recovery-empty";
  empty.textContent = message;
  container.append(empty);
}

function renderRecovery(state: AppState): void {
  const capsules = state.recoveryCapsules ?? [];
  const timeline = [...(state.sessionTimeline ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const trash = state.sessionTrash ?? [];
  elements.capsuleCount.textContent = String(capsules.length);
  elements.timelineCount.textContent = String(timeline.length);
  elements.trashCount.textContent = String(trash.length);
  elements.recoveryCapsulesList.textContent = "";
  elements.timelineList.textContent = "";
  elements.sessionTrashList.textContent = "";

  if (capsules.length === 0) setRecoveryEmpty(elements.recoveryCapsulesList, "No cleanup to recover. Saved tabs will appear here after a cleanup action.");
  for (const capsule of capsules) {
    const restoreHere = createActionButton("Restore here", "capsuleRestoreCurrent", capsule.id);
    const restoreNew = createActionButton("Open in new window", "capsuleRestoreNew", capsule.id);
    const remove = createActionButton("Delete", "capsuleDelete", capsule.id, true);
    const stateText = capsule.restoredAt ? ` · restored ${formatDateTime(capsule.restoredAt)}` : ` · expires ${formatDateTime(capsule.expiresAt)}`;
    const reason = { autoDiscard: "Automatic cleanup", manualDiscard: "Manual cleanup", closeDuplicates: "Closed duplicate tabs", closeDiscarded: "Closed unloaded tabs", closeFrozen: "Closed frozen tabs", saveAndClose: "Saved and closed tabs", sessionRestore: "Session restore" }[capsule.reason];
    const row = createSafetyRow(
      `${reason} · ${formatDateTime(capsule.createdAt)}`,
      `${capsule.tabs.length} tabs${stateText}`,
      [restoreHere, restoreNew, remove]
    );
    appendRecoveryPreview(row, capsule.tabs);
    elements.recoveryCapsulesList.append(row);
  }

  if (timeline.length === 0) setRecoveryEmpty(elements.timelineList, "No snapshots yet. Use Take snapshot now to save the current set of tabs.");
  const olderSnapshots = document.createElement("details");
  olderSnapshots.className = "older-snapshots";
  const olderSummary = document.createElement("summary");
  olderSummary.textContent = `Show ${Math.max(0, timeline.length - 5)} older snapshots`;
  olderSnapshots.append(olderSummary);
  timeline.forEach((snapshot, index) => {
    const sourceLabel = { startup: "Browser startup", browserEvent: "Automatic snapshot", manual: "Manual snapshot" }[snapshot.source];
    const windowCount = new Set(snapshot.tabs.map(tab => tab.windowId)).size;
    const row = createSafetyRow(
      formatDateTime(snapshot.createdAt),
      `${snapshot.tabs.length} tabs · ${windowCount} window${windowCount === 1 ? "" : "s"} · ${sourceLabel}`,
      [
        createActionButton("Restore here", "timelineRestoreCurrent", snapshot.id),
        createActionButton("Open in new window", "timelineRestoreNew", snapshot.id),
        createActionButton("Delete", "timelineDelete", snapshot.id, true)
      ]
    );
    row.classList.add("timeline-row");
    appendRecoveryPreview(row, snapshot.tabs);
    if (index < 5) elements.timelineList.append(row);
    else olderSnapshots.append(row);
  });
  if (timeline.length > 5) elements.timelineList.append(olderSnapshots);

  if (trash.length === 0) setRecoveryEmpty(elements.sessionTrashList, "No deleted sessions.");
  for (const item of trash) {
    elements.sessionTrashList.append(createSafetyRow(
      item.session.name,
      `${item.session.tabs.length} tabs · deleted ${formatDateTime(item.deletedAt)} · expires ${formatDateTime(item.expiresAt)}`,
      [
        createActionButton("Restore to Sessions", "trashRestore", item.id),
        createActionButton("Delete permanently", "trashDelete", item.id, true)
      ]
    ));
  }
}

function renderSyncStatus(state: AppState): void {
  const status = state.syncStatus;
  const enabled = state.settings.syncEnabled;
  elements.syncStatusBadge.textContent = enabled ? (status?.error ? "Needs attention" : "Enabled") : "Disabled";
  elements.syncStatusBadge.classList.toggle("error-badge", Boolean(status?.error));
  if (status?.error) {
    elements.syncStatusDetail.textContent = `Last sync error: ${status.error}`;
    elements.syncStatusDetail.className = "callout error-callout";
  } else if (status?.lastSyncedAt) {
    elements.syncStatusDetail.textContent = `Last synchronized ${formatDateTime(status.lastSyncedAt)} · ${status.sections.join(", ") || "no sections"}${status.byteSize != null ? ` · ${formatBytes(status.byteSize)}` : ""}.`;
    elements.syncStatusDetail.className = "callout success-callout";
  } else {
    elements.syncStatusDetail.textContent = enabled ? "Selective sync is enabled but has not run yet." : "No synchronization has run yet.";
    elements.syncStatusDetail.className = "callout neutral-callout";
  }
}

function appendMetricGrid(container: HTMLElement, metrics: Array<[string, string]>): void {
  const grid = document.createElement("div");
  grid.className = "metric-grid";
  for (const [labelText, valueText] of metrics) {
    const metric = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("strong");
    metric.className = "metric";
    label.textContent = labelText;
    value.textContent = valueText;
    metric.append(label, value);
    grid.append(metric);
  }
  container.append(grid);
}

function renderPolicySimulation(result: PolicySimulationResult): void {
  elements.simulationTimestamp.textContent = formatDateTime(result.simulatedAt);
  elements.simulationResult.textContent = "";
  elements.simulationResult.className = "result-content";
  appendMetricGrid(elements.simulationResult, [
    ["Eligible", String(result.eligibleCount)],
    ["Protected", String(result.protectedCount)],
    ["Recent", String(result.recentCount)],
    ["Planned now", String(result.plannedCount ?? result.eligibleCount)]
  ]);

  if (result.automationPlan) {
    const planPanel = document.createElement("div");
    renderAutomationPlan(planPanel, result.automationPlan);
    elements.simulationResult.append(planPanel);
  }
  const skipSummary = Object.entries(result.skipCounts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(" · ");
  if (skipSummary) {
    const summary = document.createElement("p");
    summary.className = "result-note";
    summary.textContent = `Skip reasons · ${skipSummary}`;
    elements.simulationResult.append(summary);
  }

  const candidates = result.candidates.filter(candidate => candidate.action === "discard").slice(0, 8);
  const list = document.createElement("div");
  list.className = "mini-result-list";
  if (candidates.length === 0) {
    list.textContent = "No tabs would be unloaded with these settings.";
  } else {
    for (const candidate of candidates) {
      const item = document.createElement("div");
      const title = document.createElement("strong");
      const meta = document.createElement("span");
      title.textContent = candidate.tab.title ?? candidate.tab.domain ?? "Untitled tab";
      const selected = result.automationPlan?.selectedTabIds.includes(candidate.tab.tabId);
      meta.textContent = `${selected ? "Planned" : "Eligible; held by batch or controller"} · ${formatMinutes(candidate.inactiveMinutes)} inactive · threshold ${Math.round(candidate.effectiveThresholdMinutes ?? 0)} min · score ${candidate.score.toFixed(1)}`;
      item.title = candidate.rationale?.join(" ") ?? "";
      item.append(title, meta);
      list.append(item);
    }
  }
  elements.simulationResult.append(list);
}

function renderEffectReport(report: EffectReport24h): void {
  elements.effectReportTimestamp.textContent = formatDateTime(report.generatedAt);
  elements.effectReportResult.textContent = "";
  elements.effectReportResult.className = "result-content";
  appendMetricGrid(elements.effectReportResult, [
    ["Samples", String(report.sampleCount)],
    ["High / emergency", `${report.highSampleCount} / ${report.emergencySampleCount}`],
    ["CPU high", String(report.cpuHighSampleCount)],
    ["RAM increases (all apps)", formatBytes(report.estimatedFreedBytes)],
    ["Automatic / manual unloads", `${report.automaticDiscardCount} / ${report.manualDiscardCount}`],
    ["Unloaded by others", String(report.externalDiscardCount)],
    ["Quick reopen", String(report.quickReactivationCount)],
    ["Undo", String(report.undoCount)]
  ]);

  const learning = document.createElement("div");
  learning.className = "mini-result-list";
  if (report.topLearningDomains.length === 0) {
    learning.textContent = "No learned-domain feedback in the report window.";
  } else {
    for (const record of report.topLearningDomains.slice(0, 5)) {
      const item = document.createElement("div");
      const domain = document.createElement("strong");
      const meta = document.createElement("span");
      domain.textContent = record.domain;
      meta.textContent = `+${record.thresholdPenaltyMinutes} min · ${record.quickReactivations} quick reopen · ${record.undoCount} Undo`;
      item.append(domain, meta);
      learning.append(item);
    }
  }
  elements.effectReportResult.append(learning);
}

function renderRules(state: AppState): void {
  elements.rulesList.textContent = "";

  for (const rule of state.protectionRules) {
    const row = document.createElement("div");
    const main = document.createElement("div");
    const title = document.createElement("div");
    const meta = document.createElement("div");
    const actions = document.createElement("div");
    const enabledLabel = document.createElement("label");
    const enabled = document.createElement("input");
    const deleteButton = document.createElement("button");

    row.className = "row";
    main.className = "row-main";
    title.className = "row-title";
    meta.className = "row-meta";
    actions.className = "row-actions";
    enabled.type = "checkbox";
    enabled.checked = rule.enabled;
    enabled.dataset.ruleEnable = rule.id;
    enabled.setAttribute("aria-label", `${rule.value} enabled`);
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.dataset.ruleDelete = rule.id;
    deleteButton.setAttribute("aria-label", `Delete ${rule.value} protection rule`);
    title.textContent = rule.value;
    meta.textContent = `${rule.type} · ${rule.source}`;

    enabledLabel.append(enabled, "Enabled");
    actions.append(enabledLabel, deleteButton);
    main.append(title, meta);
    row.append(main, actions);
    elements.rulesList.append(row);
  }
}

function createPolicySelect(window: WindowSummary): HTMLSelectElement {
  const select = document.createElement("select");
  select.dataset.windowPolicy = String(window.windowId);
  select.setAttribute("aria-label", `Policy for Window ${window.windowId}`);
  select.disabled = Boolean(currentState?.focusModeEnabled);
  select.title = select.disabled ? "Turn off Focus Mode before changing window policy." : "";

  for (const [value, label] of [
    ["inherit", "Inherit global"],
    ["manual", "Manual only"],
    ["conservative", "Conservative"],
    ["balanced", "Balanced"],
    ["aggressive", "Aggressive"],
    ["pressureAdaptive", "Pressure adaptive"],
    ["custom", "Custom"]
  ] as Array<[PolicyMode | "inherit", string]>) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  select.value = window.policyMode;
  return select;
}

function renderWindowPolicies(state: AppState): void {
  elements.windowPolicyList.textContent = "";
  const windows = state.windowSummaries ?? [];

  if (windows.length === 0) {
    elements.windowPolicyList.textContent = "No open windows found.";
    return;
  }

  for (const window of windows) {
    const row = document.createElement("div");
    const main = document.createElement("div");
    const title = document.createElement("div");
    const meta = document.createElement("div");
    const actions = document.createElement("div");

    row.className = "row";
    main.className = "row-main";
    title.className = "row-title";
    meta.className = "row-meta";
    actions.className = "row-actions";
    title.textContent = `Window ${window.windowId}`;
    meta.textContent = `${window.tabCount} tabs · ${window.activeDomain ?? "no active site"} · ${
      window.activeTitle ?? "Untitled"
    }`;

    actions.append(createPolicySelect(window));
    main.append(title, meta);
    row.append(main, actions);
    elements.windowPolicyList.append(row);
  }
}

function renderSessions(state: AppState): void {
  elements.sessionsList.textContent = "";

  if (state.sessions.length === 0) {
    elements.sessionsList.textContent = "No saved sessions.";
    return;
  }

  for (const session of state.sessions) {
    const row = document.createElement("div");
    const main = document.createElement("div");
    const title = document.createElement("div");
    const meta = document.createElement("div");
    const actions = document.createElement("div");
    const nameInput = document.createElement("input");
    const renameButton = document.createElement("button");
    const restoreCurrent = document.createElement("button");
    const restoreNew = document.createElement("button");
    const deleteButton = document.createElement("button");

    row.className = "row";
    main.className = "row-main";
    title.className = "row-title";
    meta.className = "row-meta";
    actions.className = "row-actions";
    nameInput.type = "text";
    nameInput.value = session.name;
    nameInput.dataset.sessionName = session.id;
    nameInput.setAttribute("aria-label", `Name for ${session.name}`);
    renameButton.type = "button";
    renameButton.textContent = "Rename";
    renameButton.dataset.sessionRename = session.id;
    renameButton.setAttribute("aria-label", `Rename ${session.name}`);
    restoreCurrent.type = "button";
    restoreCurrent.textContent = "Restore here";
    restoreCurrent.dataset.sessionRestoreCurrent = session.id;
    restoreCurrent.setAttribute("aria-label", `Restore ${session.name} in current window`);
    restoreNew.type = "button";
    restoreNew.textContent = "Restore in new window";
    restoreNew.dataset.sessionRestoreNew = session.id;
    restoreNew.setAttribute("aria-label", `Restore ${session.name} in a new window`);
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.dataset.sessionDelete = session.id;
    deleteButton.setAttribute("aria-label", `Move ${session.name} to Session Trash`);
    title.textContent = session.name;
    meta.textContent = `${session.source} · ${session.tabs.length} tabs · ${formatDateTime(session.createdAt)}`;

    main.append(title, meta);
    actions.append(nameInput, renameButton, restoreCurrent, restoreNew, deleteButton);
    row.append(main, actions);
    elements.sessionsList.append(row);
  }
}

function renderLog(state: AppState): void {
  elements.logList.textContent = "";
  if (!elements.logJson.hidden) {
    elements.logJson.value = JSON.stringify(state.discardLog, null, 2);
  }

  if (state.discardLog.length === 0) {
    elements.logList.textContent = "No activity yet.";
    return;
  }

  for (const entry of state.discardLog.slice(0, 80)) {
    const row = document.createElement("div");
    const main = document.createElement("div");
    const title = document.createElement("div");
    const meta = document.createElement("div");
    const actions = document.createElement("div");
    const undoButton = document.createElement("button");

    row.className = "row log-row";
    main.className = "row-main";
    title.className = "row-title";
    meta.className = "row-meta";
    actions.className = "row-actions";
    title.textContent = entry.title || entry.domain || "Unloaded tab";
    meta.textContent = `${formatDateTime(entry.discardedAt)} · ${entry.reason} · inactive ${formatMinutes(
      entry.inactiveMinutes
    )}${entry.undoneAt ? ` · undone ${formatDateTime(entry.undoneAt)}` : ""}`;
    undoButton.type = "button";
    undoButton.textContent = entry.undoneAt ? "Undone" : "Undo";
    undoButton.disabled = Boolean(entry.undoneAt);
    undoButton.dataset.undoDiscard = entry.id;
    undoButton.setAttribute("aria-label", entry.undoneAt ? `${title.textContent} already undone` : `Undo unload for ${title.textContent}`);

    main.append(title, meta);
    actions.append(undoButton);
    row.append(main, actions);
    elements.logList.append(row);
  }
}

function render(state: AppState): void {
  currentState = state;
  // Background actions refresh status as well. They must not erase edits in a
  // different settings section that the person has not saved yet.
  if (!dirtySettingsGroups.has("policyHeading")) renderPolicy(state.settings);
  if (!dirtySettingsGroups.has("advancedHeading")) renderAdvanced(state.settings);
  if (!dirtySettingsGroups.has("automationHeading")) renderAutomation(state);
  if (!dirtySettingsGroups.has("syncHeading")) renderSyncSettings(state.settings);
  elements.networkDietMode.value = state.settings.networkDietMode;
  renderIntelligence(state);
  renderWindowPolicies(state);
  renderRules(state);
  renderSessions(state);
  renderRecovery(state);
  renderSyncStatus(state);
  renderLog(state);
}

async function refresh(): Promise<boolean> {
  const request = ++refreshRequest;
  const shell = document.querySelector<HTMLElement>(".options-shell");
  const sections = document.querySelectorAll<HTMLElement>(".options-shell > section");
  shell?.setAttribute("aria-busy", "true");
  for (const section of sections) section.inert = true;
  elements.refreshButton.disabled = true;
  try {
    const state = await sendAppMessage<AppState>({ type: "getAppState" });
    if (request !== refreshRequest) return false;
    render(state);
    setStatus(`Loaded ${new Date().toLocaleTimeString()}${dirtySettingsGroups.size ? " · Unsaved changes kept." : ""}`);
    return true;
  } catch (error) {
    if (request !== refreshRequest) return false;
    setStatus(error instanceof Error ? error.message : String(error), true);
    return false;
  } finally {
    if (request === refreshRequest) {
      shell?.setAttribute("aria-busy", "false");
      for (const section of sections) section.inert = actionInFlight || currentState === null;
      elements.refreshButton.disabled = actionInFlight;
    }
  }
}

function lockActionControls(button = document.activeElement): () => void {
  const sections = document.querySelectorAll<HTMLElement>(".options-shell > section");
  const trigger = button instanceof HTMLButtonElement && !button.disabled ? button : null;
  if (trigger) trigger.disabled = true;
  for (const section of sections) {
    section.inert = true;
    section.setAttribute("aria-busy", "true");
  }
  elements.refreshButton.disabled = true;
  return () => {
    if (trigger?.isConnected) trigger.disabled = false;
    for (const section of sections) {
      section.inert = currentState === null;
      section.setAttribute("aria-busy", "false");
    }
    elements.refreshButton.disabled = false;
    updateSyncControlAvailability();
  };
}

async function runAction(label: string, action: () => Promise<unknown>, savedGroup?: SettingsDraftGroup): Promise<void> {
  if (actionInFlight) return;
  actionInFlight = true;
  let unlock: (() => void) | undefined;
  setStatus(`${label}...`);
  try {
    // Run synchronous validation before making fields inert so invalid inputs
    // can still receive focus and native validation feedback.
    const pending = action();
    unlock = lockActionControls();
    await pending;
    if (savedGroup) dirtySettingsGroups.delete(savedGroup);
    const refreshed = await refresh();
    setStatus(refreshed ? `${label} complete.`
      : `${label} completed, but the latest state could not be loaded. Use Refresh.`, !refreshed);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    actionInFlight = false;
    unlock?.();
  }
}

async function runResultAction<T>(
  label: string,
  button: HTMLButtonElement,
  action: () => Promise<T>,
  showResult: (result: T) => void | string | Promise<void | string>
): Promise<void> {
  if (actionInFlight) return;
  actionInFlight = true;
  let unlock: (() => void) | undefined;
  setStatus(`${label}...`);
  try {
    const pending = action();
    unlock = lockActionControls(button);
    const result = await pending;
    // Result presenters can focus exported text or refresh the current view.
    unlock();
    unlock = undefined;
    const completionMessage = await showResult(result);
    setStatus(completionMessage ?? `${label} complete.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    actionInFlight = false;
    unlock?.();
    for (const section of document.querySelectorAll<HTMLElement>(".options-shell > section")) section.inert = currentState === null;
    elements.refreshButton.disabled = false;
  }
}

function collectPolicyPatch(): Partial<Settings> {
  const focusLocked = Boolean(currentState?.focusModeEnabled);
  const policyMode = focusLocked && currentState ? currentState.settings.policyMode : (elements.policyMode.value as PolicyMode);
  const modePatch = focusLocked ? {} : policySettingsPatchForPolicyMode(policyMode, currentState?.settings);
  let customPolicyPatch: Partial<Settings> = {};
  if (!focusLocked && isPolicyThresholdEditable(policyMode)) {
    const highRatio = numberValue(elements.memoryHighAvailableRatio) / 100;
    const emergencyRatio = numberValue(elements.memoryEmergencyAvailableRatio) / 100;
    if (emergencyRatio > highRatio) {
      focusSettingInput(elements.memoryEmergencyAvailableRatio);
      throw new Error("Emergency memory percentage must be less than or equal to the high-pressure percentage.");
    }
    customPolicyPatch = {
      scanIntervalMinutes: numberValue(elements.scanIntervalMinutes),
      ...thresholdPatchForPolicyMode(policyMode, numberValue(elements.inactiveThresholdMinutes)),
      maxAutoDiscardsPerScan: numberValue(elements.maxAutoDiscardsPerScan),
      memoryHighAvailableRatio: highRatio,
      memoryEmergencyAvailableRatio: emergencyRatio
    };
  }

  return {
    ...modePatch,
    ...customPolicyPatch,
    maxManualDiscardsPerAction: numberValue(elements.maxManualDiscardsPerAction),
    protectPinned: elements.protectPinned.checked,
    protectAudible: elements.protectAudible.checked,
    protectUnsavedWork: elements.protectUnsavedWork.checked,
    protectActive: true,
    protectIncognito: elements.protectIncognito.checked,
    respectAutoDiscardableFalse: elements.respectAutoDiscardableFalse.checked
  };
}

function collectAdvancedPatch(): Partial<Settings> {
  return {
    keepDiscardLogLimit: numberValue(elements.keepDiscardLogLimit),
    keepSessionLimit: numberValue(elements.keepSessionLimit),
    cpuHighRatio: numberValue(elements.cpuHighRatio) / 100,
    showBadge: elements.showBadge.checked,
    privacyMode: elements.privacyMode.checked
  };
}

function collectAutomationPatch(): Partial<Settings> {
  const saved = currentState?.settings;
  return {
    powerPolicyMode: elements.powerPolicyMode.value as PowerPolicyMode,
    lowBatteryThreshold: elements.lowBatteryThreshold.disabled && saved ? saved.lowBatteryThreshold : numberValue(elements.lowBatteryThreshold) / 100,
    autoMergeDuplicateTabs: elements.autoMergeDuplicateTabs.checked,
    discardLearningEnabled: elements.discardLearningEnabled.checked,
    quickReactivateMinutes: elements.quickReactivateMinutes.disabled && saved ? saved.quickReactivateMinutes : numberValue(elements.quickReactivateMinutes),
    timeMachineEnabled: elements.timeMachineEnabled.checked,
    timeMachineIntervalMinutes: elements.timeMachineIntervalMinutes.disabled && saved ? saved.timeMachineIntervalMinutes : numberValue(elements.timeMachineIntervalMinutes),
    timeMachineRetention: elements.timeMachineRetention.disabled && saved ? saved.timeMachineRetention : numberValue(elements.timeMachineRetention),
    recoveryCapsuleLimit: numberValue(elements.recoveryCapsuleLimit)
  };
}

function collectSyncPatch(): Partial<Settings> {
  if (
    elements.syncEnabled.checked &&
    !elements.syncSettings.checked &&
    !elements.syncProtectionRules.checked &&
    !elements.syncFocusSets.checked
  ) {
    throw new Error("Select at least one section before enabling selective sync.");
  }
  return {
    syncEnabled: elements.syncEnabled.checked,
    syncSettings: elements.syncSettings.checked,
    syncProtectionRules: elements.syncProtectionRules.checked,
    syncFocusSets: elements.syncFocusSets.checked
  };
}

function collectSimulationPatch(): Partial<Settings> {
  return {
    ...collectPolicyPatch(),
    ...collectAutomationPatch(),
    ...collectAdvancedPatch()
  };
}

function selectedBackupSections(): BackupSectionName[] {
  const selected = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-backup-section]:checked"))
    .map(input => input.dataset.backupSection)
    .filter((value): value is BackupSectionName =>
      typeof value === "string" && BACKUP_SECTION_NAMES.includes(value as BackupSectionName)
    );
  if (selected.length === 0) throw new Error("Select at least one backup section.");
  return selected;
}

function parseBackupJson(): unknown {
  const raw = elements.backupJson.value.trim();
  if (!raw) throw new Error("Paste backup JSON before importing.");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(error instanceof Error ? `Invalid backup JSON: ${error.message}` : "Invalid backup JSON");
  }
}

function parseSessionImportJson(): unknown {
  const raw = elements.sessionsJson.value.trim();
  if (!raw) {
    throw new Error("Paste session JSON before importing");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(error instanceof Error ? `Invalid session JSON: ${error.message}` : "Invalid session JSON");
  }
}

async function importSessionsFromJson(): Promise<void> {
  await runResultAction("Import sessions", elements.importSessionsButton, () =>
    sendAppMessage<SessionImportResult>({
      type: "importSessions",
      sessions: parseSessionImportJson()
    }), async result => {
      const refreshed = await refresh();
      const summary = `Imported ${result.importedCount} session${result.importedCount === 1 ? "" : "s"}${
        result.skippedCount > 0 ? `, skipped ${result.skippedCount}` : ""
      }.`;
      if (!refreshed) throw new Error(`${summary} The latest state could not be loaded. Use Refresh.`);
      return summary;
    }
  );
}

elements.refreshButton.addEventListener("click", () => void refresh());

elements.grantWorkProtectionAccessButton.addEventListener("click", () => {
  if (actionInFlight) return;
  void runResultAction("Allow website checks", elements.grantWorkProtectionAccessButton, () =>
    // Chrome requires request() during the original click, before an await.
    chrome.permissions.request({ origins: WORK_PROTECTION_ORIGINS }), async granted => {
      await refreshWorkProtectionAccess();
      if (!granted) throw new Error("Website access wasn’t granted. Unchecked tabs unload only when you ask or memory runs low.");
      return "Website access allowed.";
    }
  );
});

chrome.permissions.onAdded?.addListener(() => void refreshWorkProtectionAccess());
chrome.permissions.onRemoved?.addListener(() => void refreshWorkProtectionAccess());

elements.policyMode.addEventListener("change", () => {
  if (currentState?.focusModeEnabled) {
    elements.policyMode.value = currentState.settings.policyMode;
    setStatus("Turn off Focus Mode before changing Policy Mode.", true);
    return;
  }

  const mode = elements.policyMode.value as PolicyMode;
  if (currentState) {
    const settings = applyPolicyModeValues(currentState.settings, mode);
    setNumber(elements.scanIntervalMinutes, settings.scanIntervalMinutes);
    setInactiveThresholdValue(getThresholdForPolicyMode(settings, mode), isPolicyThresholdEditable(mode));
    setNumber(elements.maxAutoDiscardsPerScan, settings.maxAutoDiscardsPerScan);
    setNumber(elements.memoryHighAvailableRatio, Number((settings.memoryHighAvailableRatio * 100).toFixed(4)));
    setNumber(elements.memoryEmergencyAvailableRatio, Number((settings.memoryEmergencyAvailableRatio * 100).toFixed(4)));
    setPresetControlledInputsEditable(mode);
  } else {
    setInactiveThresholdValue(POLICY_MODE_THRESHOLD_PRESETS[mode], isPolicyThresholdEditable(mode));
  }

  setStatus("Policy preview changed. Use Save Policy to apply it, or run the simulator without saving.");
});

elements.savePolicyButton.addEventListener("click", () => {
  void runAction("Save policy", () => sendAppMessage({ type: "updateSettings", patch: collectPolicyPatch() }), "policyHeading");
});

elements.saveAutomationButton.addEventListener("click", () => {
  void runAction("Save power and behavior", () =>
    sendAppMessage({ type: "updateSettings", patch: collectAutomationPatch() }), "automationHeading"
  );
});

elements.powerPolicyMode.addEventListener("change", updateAutomationControlAvailability);
elements.timeMachineEnabled.addEventListener("change", updateAutomationControlAvailability);
elements.discardLearningEnabled.addEventListener("change", updateAutomationControlAvailability);

for (const input of [
  elements.powerPolicyMode,
  elements.lowBatteryThreshold,
  elements.autoMergeDuplicateTabs,
  elements.discardLearningEnabled,
  elements.quickReactivateMinutes,
  elements.timeMachineEnabled,
  elements.timeMachineIntervalMinutes,
  elements.timeMachineRetention,
  elements.recoveryCapsuleLimit
]) {
  input.addEventListener("change", () => {
    setStatus("Preview updated. Choose Save power and behavior to apply it, or run the simulator without saving.");
  });
}

elements.simulatePolicyButton.addEventListener("click", () => {
  void runResultAction(
    "Simulate policy",
    elements.simulatePolicyButton,
    () => sendAppMessage<PolicySimulationResult>({ type: "simulatePolicy", patch: collectSimulationPatch() }),
    renderPolicySimulation
  );
});

elements.effectReportButton.addEventListener("click", () => {
  void runResultAction(
    "Generate 24-hour report",
    elements.effectReportButton,
    () => sendAppMessage<EffectReport24h>({ type: "getEffectReport24h" }),
    renderEffectReport
  );
});

for (const input of [
  elements.scanIntervalMinutes,
  elements.inactiveThresholdMinutes,
  elements.maxAutoDiscardsPerScan,
  elements.maxManualDiscardsPerAction,
  elements.memoryHighAvailableRatio,
  elements.memoryEmergencyAvailableRatio,
  elements.protectPinned,
  elements.protectAudible,
  elements.protectUnsavedWork,
  elements.protectActive,
  elements.protectIncognito,
  elements.respectAutoDiscardableFalse
]) {
  input.addEventListener("change", () => {
    setStatus("Policy preview changed. Use Save Policy to apply it, or run the simulator without saving.");
  });
}

elements.saveAdvancedButton.addEventListener("click", () => {
  void runAction("Save advanced settings", () =>
    sendAppMessage({ type: "updateSettings", patch: collectAdvancedPatch() }), "advancedHeading"
  );
});

for (const input of [
  elements.keepDiscardLogLimit,
  elements.keepSessionLimit,
  elements.cpuHighRatio,
  elements.showBadge,
  elements.privacyMode
]) {
  input.addEventListener("change", () => {
    setStatus("Advanced preview changed. Use Save Advanced to apply it, or run the simulator without saving.");
  });
}

elements.networkDietMode.addEventListener("change", () => {
  void runAction("Update network filtering", () =>
    sendAppMessage({
      type: "setNetworkDietMode",
      mode: elements.networkDietMode.value as NetworkDietMode
    })
  );
});

elements.windowPolicyList.addEventListener("change", event => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || !target.dataset.windowPolicy) return;
  if (currentState?.focusModeEnabled) {
    setStatus("Turn off Focus Mode before changing window policy.", true);
    void refresh();
    return;
  }

  void runAction("Update window policy", () =>
    sendAppMessage({
      type: "setWindowPolicy",
      windowId: Number(target.dataset.windowPolicy),
      policyMode: target.value as PolicyMode | "inherit"
    })
  );
});

elements.addRuleForm.addEventListener("submit", event => {
  event.preventDefault();
  void runAction("Add protection rule", () =>
    sendAppMessage({
      type: "addProtectionRule",
      ruleType: elements.newRuleType.value as ProtectionRuleType,
      value: elements.newRuleValue.value
    }).then(() => {
      elements.newRuleValue.value = "";
    })
  );
});

elements.rulesList.addEventListener("change", event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.dataset.ruleEnable) return;

  void runAction("Update protection rule", () =>
    sendAppMessage({
      type: "setProtectionRuleEnabled",
      ruleId: target.dataset.ruleEnable as string,
      enabled: target.checked
    })
  );
});

elements.rulesList.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.ruleDelete) return;

  void runAction("Delete protection rule", () =>
    sendAppMessage({
      type: "deleteProtectionRule",
      ruleId: target.dataset.ruleDelete as string
    })
  );
});

async function showSavedSessionResult(result: SaveAndCloseResult): Promise<string> {
  const refreshed = await refresh();
  const summary = `Saved ${result.tabs.length} tabs; closed ${result.closedCount}, kept ${result.keptOpenCount} open.`;
  if (!refreshed) throw new Error(`${summary} The latest state could not be loaded. Use Refresh.`);
  return summary;
}

elements.saveWindowButton.addEventListener("click", () => {
  void runResultAction("Save window and close", elements.saveWindowButton, () =>
    sendAppMessage<SaveAndCloseResult>({
      type: "saveWindowAndClose",
      includeActive: elements.includeActive.checked,
      includePinned: elements.includePinned.checked
    }), showSavedSessionResult
  );
});

elements.saveGroupButton.addEventListener("click", () => {
  void runResultAction("Save group and close", elements.saveGroupButton, () =>
    sendAppMessage<SaveAndCloseResult>({
      type: "saveGroupAndClose",
      includeActive: elements.includeActive.checked,
      includePinned: elements.includePinned.checked
    }), showSavedSessionResult
  );
});

elements.saveSelectionButton.addEventListener("click", () => {
  void runResultAction("Save selected tabs and close", elements.saveSelectionButton, () =>
    sendAppMessage<SaveAndCloseResult>({
      type: "saveSelectionAndClose",
      includeActive: elements.includeActive.checked,
      includePinned: elements.includePinned.checked
    }), showSavedSessionResult
  );
});

elements.sessionsList.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.dataset.sessionRename) {
    const input = elements.sessionsList.querySelector<HTMLInputElement>(
      `input[data-session-name="${target.dataset.sessionRename}"]`
    );
    const name = input?.value ?? "Untitled session";
    void runAction("Rename session", () =>
      sendAppMessage({ type: "renameSession", sessionId: target.dataset.sessionRename as string, name })
    );
  }

  if (target.dataset.sessionRestoreCurrent) {
    void runAction("Restore session", () =>
      sendAppMessage({
        type: "restoreSession",
        sessionId: target.dataset.sessionRestoreCurrent as string,
        target: "currentWindow"
      })
    );
  }

  if (target.dataset.sessionRestoreNew) {
    void runAction("Restore session", () =>
      sendAppMessage({
        type: "restoreSession",
        sessionId: target.dataset.sessionRestoreNew as string,
        target: "newWindow"
      })
    );
  }

  if (target.dataset.sessionDelete) {
    void runAction("Move session to Trash", () =>
      sendAppMessage({ type: "deleteSession", sessionId: target.dataset.sessionDelete as string })
    );
  }
});

elements.exportSessionsButton.addEventListener("click", () => {
  elements.sessionsJson.value = JSON.stringify(currentState?.sessions ?? [], null, 2);
  setStatus("Sessions exported to the text area.");
});

elements.importSessionsButton.addEventListener("click", () => {
  void importSessionsFromJson();
});

elements.captureTimelineButton.addEventListener("click", () => {
  void runAction("Take snapshot", () => sendAppMessage({ type: "captureTimelineNow" }));
});

elements.recoveryCapsulesList.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.dataset.capsuleRestoreCurrent) {
    void runAction("Restore recovery capsule", () => sendAppMessage({
      type: "restoreRecoveryCapsule",
      capsuleId: target.dataset.capsuleRestoreCurrent as string,
      target: "currentWindow"
    }));
    return;
  }
  if (target.dataset.capsuleRestoreNew) {
    void runAction("Restore recovery capsule", () => sendAppMessage({
      type: "restoreRecoveryCapsule",
      capsuleId: target.dataset.capsuleRestoreNew as string,
      target: "newWindow"
    }));
    return;
  }
  if (target.dataset.capsuleDelete) {
    if (!window.confirm("Delete this Recovery Capsule? Its tabs can no longer be restored from the capsule.")) {
      setStatus("Recovery Capsule deletion cancelled.");
      return;
    }
    void runAction("Delete recovery capsule", () => sendAppMessage({
      type: "deleteRecoveryCapsule",
      capsuleId: target.dataset.capsuleDelete as string
    }));
  }
});

elements.timelineList.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.dataset.timelineRestoreCurrent) {
    void runAction("Restore Time Machine snapshot", () => sendAppMessage({
      type: "restoreTimelineSnapshot",
      snapshotId: target.dataset.timelineRestoreCurrent as string,
      target: "currentWindow"
    }));
    return;
  }
  if (target.dataset.timelineRestoreNew) {
    void runAction("Restore Time Machine snapshot", () => sendAppMessage({
      type: "restoreTimelineSnapshot",
      snapshotId: target.dataset.timelineRestoreNew as string,
      target: "newWindow"
    }));
    return;
  }
  if (target.dataset.timelineDelete) {
    if (!window.confirm("Delete this Time Machine snapshot? This snapshot cannot be recovered after deletion.")) {
      setStatus("Time Machine snapshot deletion cancelled.");
      return;
    }
    void runAction("Delete Time Machine snapshot", () => sendAppMessage({
      type: "deleteTimelineSnapshot",
      snapshotId: target.dataset.timelineDelete as string
    }));
  }
});

elements.sessionTrashList.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (target.dataset.trashRestore) {
    void runAction("Restore trashed session", () => sendAppMessage({
      type: "restoreTrashedSession",
      trashId: target.dataset.trashRestore as string
    }));
    return;
  }
  if (target.dataset.trashDelete) {
    if (!window.confirm("Permanently delete this session from Trash? This action cannot be undone.")) {
      setStatus("Permanent deletion cancelled.");
      return;
    }
    void runAction("Permanently delete session", () => sendAppMessage({
      type: "permanentlyDeleteTrashedSession",
      trashId: target.dataset.trashDelete as string
    }));
  }
});

elements.exportBackupButton.addEventListener("click", () => {
  void runResultAction(
    "Export selected backup",
    elements.exportBackupButton,
    () => sendAppMessage<BackupEnvelope>({ type: "exportBackup", selectedSections: selectedBackupSections() }),
    backup => {
      elements.backupJson.value = JSON.stringify(backup, null, 2);
      elements.backupJson.focus();
    }
  );
});

elements.importBackupButton.addEventListener("click", () => {
  const mode = elements.backupImportMode.value as ImportMode;
  if (mode === "replace" && !window.confirm("Replace the selected local sections with this backup? This cannot be undone unless you export a backup first.")) {
    setStatus("Backup import cancelled.");
    return;
  }
  void runResultAction(
    `Import backup (${mode})`,
    elements.importBackupButton,
    () => sendAppMessage<ImportPlan>({ type: "importBackup", backup: parseBackupJson(), mode }),
    async plan => {
      const refreshed = await refresh();
      const summary = `Imported ${plan.selectedSections.length} backup section${plan.selectedSections.length === 1 ? "" : "s"} in ${plan.mode} mode.`;
      if (!refreshed) throw new Error(`${summary} The latest state could not be loaded. Use Refresh.`);
      return summary;
    }
  );
});

elements.syncEnabled.addEventListener("change", () => {
  updateSyncControlAvailability();
  setStatus("Sync selection changed. Save it before using Push or Pull.");
});

for (const input of [elements.syncSettings, elements.syncProtectionRules, elements.syncFocusSets]) {
  input.addEventListener("change", () => {
    updateSyncControlAvailability();
    setStatus("Sync selection changed. Save it before using Push or Pull.");
  });
}

elements.saveSyncButton.addEventListener("click", () => {
  void runAction("Save sync choices", () =>
    sendAppMessage({ type: "updateSettings", patch: collectSyncPatch() }), "syncHeading"
  );
});

elements.pushSyncButton.addEventListener("click", () => {
  void runAction("Upload to Chrome Sync", () => sendAppMessage<SyncStatus>({ type: "pushSelectiveSync" }));
});

elements.pullSyncButton.addEventListener("click", () => {
  void runAction("Download from Chrome Sync", () => sendAppMessage<ImportPlan>({ type: "pullSelectiveSync" }));
});

elements.clearLogButton.addEventListener("click", () => {
  if (!window.confirm("Clear the whole activity log? Undo history and the last 24 hours of feedback will be removed.")) {
    setStatus("Log not cleared.");
    return;
  }
  void runAction("Clear log", () => sendAppMessage({ type: "clearDiscardLog" }));
});

elements.logList.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.undoDiscard) return;

  void runAction("Undo unload", () => sendAppMessage({ type: "undoDiscard", entryId: target.dataset.undoDiscard }));
});

elements.copyLogButton.addEventListener("click", () => {
  const json = JSON.stringify(currentState?.discardLog ?? [], null, 2);
  elements.logJson.value = json;
  elements.logJson.hidden = false;
  elements.logJson.focus();
  elements.logJson.select();
  void (async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(json);
      setStatus("Activity log copied as JSON.");
    } catch {
      setStatus("Clipboard unavailable. The JSON is in the text area below.");
    }
  })();
});

initializeOptionsNavigation();
for (const group of ["policyHeading", "automationHeading", "advancedHeading", "syncHeading"] as const) {
  const section = optionsSectionElement(group);
  const markDirty = (event: Event): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) dirtySettingsGroups.add(group);
  };
  section.addEventListener("input", markDirty);
  section.addEventListener("change", markDirty);
}
void refresh();
void refreshWorkProtectionAccess();
