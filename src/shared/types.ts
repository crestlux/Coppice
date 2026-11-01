export type PolicyMode = "manual" | "conservative" | "balanced" | "aggressive" | "pressureAdaptive" | "custom";

export type NetworkFilteringMode = "off" | "light";

export type PowerPolicyMode = "off" | "batterySaver" | "lowBatteryAggressive";

export type ProtectionRuleType = "domain" | "urlPattern";

export type ProtectionSource = "default" | "user";

export interface DomainDiscardRule {
  domain: string;
  inactiveMinutes: number;
  createdAt: number;
}

export type PageOptimizerItemId =
  | "offscreenRendering"
  | "mediaContainment"
  | "animationLimiter"
  | "visualEffectsReducer"
  | "codeBlockContainment"
  | "imageContainment"
  | "aiConversationOptimizer"
  | "reducedMotionMode"
  | "backgroundAnimationPause"
  | "offscreenMediaPause";

export type AiConversationProvider = "chatgpt" | "gemini" | "claude" | "generic" | "unsupported";

export interface PageOptimizerItemMetrics {
  detected: number;
  applied: number;
  skipped: number;
}

export interface PageOptimizerMetrics {
  runtimeActive: boolean;
  items: Partial<Record<PageOptimizerItemId, PageOptimizerItemMetrics>>;
  scanDurationMs?: number;
  observedTargetCount?: number;
  changingRegionCount?: number;
  renderingBackoff?: boolean;
  renderingBackoffCount?: number;
  renderingChurnRate?: number;
  renderingChurnTargets?: number;
  discoveryComplete?: boolean;
  configurationKey?: string;
  interactionDeferred?: boolean;
  workBudgetLimited?: boolean;
  workBudgetBackoffCount?: number;
  workDurationMs?: number;
}

export interface AiConversationOptimizerMetrics {
  provider: AiConversationProvider;
  providerLabel: string;
  supported: boolean;
  runtimeActive: boolean;
  strategy?: string;
  detectedTurnCount: number;
  optimizedTurnCount: number;
  cssAppliedTurnCount: number;
  offscreenTurnCount: number;
  skippedTurnCount: number;
  skipMeasurementSupported: boolean;
  recentTurnCount: number;
  excludedTurnCount: number;
  detectedSectionCount?: number;
  optimizedSectionCount?: number;
  skippedSectionCount?: number;
  interactionDeferred?: boolean;
  workBudgetLimited?: boolean;
  workBudgetBackoffCount?: number;
  workDurationMs?: number;
}

export type DiscardReason = "manualRelease" | "autoInactive" | "memoryPressure";

export type DiscardAttemptStatus = "discarded" | "skipped" | "failed";

export type DiscardFailureReason =
  | "noTabId"
  | "noTab"
  | "noUrl"
  | "specialScheme"
  | "becameActive"
  | "pinned"
  | "audible"
  | "unsavedWork"
  | "workStateUnknown"
  | "alreadyDiscarded"
  | "incognito"
  | "autoDiscardableFalse"
  | "protectedTemporary"
  | "protectedDomain"
  | "protectedUrlPattern"
  | "recentlyActive"
  | "loading"
  | "onlyTabInWindow"
  | "chromeDiscardFailed"
  | "verificationFailed"
  | "chromeError";

export type SkipReason =
  | "active"
  | "pinned"
  | "audible"
  | "unsavedWork"
  | "workStateUnknown"
  | "discarded"
  | "noTabId"
  | "noUrl"
  | "specialScheme"
  | "protectedTemporary"
  | "protectedDomain"
  | "protectedUrlPattern"
  | "recentlyActive"
  | "loading"
  | "manualPolicy"
  | "autoDiscardableFalse"
  | "incognito"
  | "unknown";

export interface Settings {
  policyMode: PolicyMode;
  conservativeMinutes: number;
  balancedMinutes: number;
  aggressiveMinutes: number;
  customMinutes: number;
  scanIntervalMinutes: number;
  maxAutoDiscardsPerScan: number;
  maxManualDiscardsPerAction: number;
  protectPinned: boolean;
  protectAudible: boolean;
  protectUnsavedWork: boolean;
  protectActive: boolean;
  protectIncognito: boolean;
  respectAutoDiscardableFalse: boolean;
  memoryHighAvailableRatio: number;
  memoryEmergencyAvailableRatio: number;
  cpuHighRatio: number;
  powerPolicyMode: PowerPolicyMode;
  lowBatteryThreshold: number;
  autoMergeDuplicateTabs: boolean;
  discardLearningEnabled: boolean;
  quickReactivateMinutes: number;
  timeMachineEnabled: boolean;
  timeMachineIntervalMinutes: number;
  timeMachineRetention: number;
  recoveryCapsuleLimit: number;
  syncEnabled: boolean;
  syncSettings: boolean;
  syncProtectionRules: boolean;
  syncFocusSets: boolean;
  networkFilteringMode: NetworkFilteringMode;
  keepDiscardLogLimit: number;
  keepSessionLimit: number;
  showBadge: boolean;
  privacyMode: boolean;
  pageOptimizerEnabled: boolean;
  pageOptimizerAllSites: boolean;
  pageOptimizerExcludedDomains: string[];
  pageOptimizerItems: Record<PageOptimizerItemId, boolean>;
  pageOptimizerSiteDomains: string[];
  domainDiscardRules: DomainDiscardRule[];
  snoozeUntil?: number;
  snoozeIndefinitely?: boolean;
}

export interface ProtectionRule {
  id: string;
  type: ProtectionRuleType;
  value: string;
  source: ProtectionSource;
  enabled: boolean;
  createdAt: number;
}

export type TemporaryTabProtectionSource = "user" | "rule" | "focus";

export interface TemporaryTabProtection {
  tabId: number;
  windowId: number;
  createdAt: number;
  source: TemporaryTabProtectionSource;
  ruleIds?: string[];
  focus?: boolean;
  focusedAt?: number;
  url?: string;
  title?: string;
}

export interface OptimizedTab {
  tabId: number;
  windowId: number;
  createdAt: number;
  source?: "manual" | "site" | "global";
  url?: string;
  domain?: string;
  title?: string;
}

export interface SavedFocusTab {
  url: string;
  title?: string;
  domain?: string;
}

export interface SavedFocusSet {
  id: string;
  name: string;
  createdAt: number;
  tabs: SavedFocusTab[];
}

export interface FocusSetApplyResult {
  setId: string;
  matchedCount: number;
  missingCount: number;
  cleanupDiscardedCount: number;
  cleanupEligibleCount: number;
}

export interface TabRuntimeState {
  tabId: number;
  windowId: number;
  groupId?: number;
  url?: string;
  title?: string;
  domain?: string;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  frozen?: boolean;
  incognito: boolean;
  autoDiscardable?: boolean;
  lastAccessedAt: number;
  lastObservedAt: number;
}


export interface AdaptivePressure {
  stage: "steady" | "watch" | "high" | "emergency" | "recovering" | "unknown";
  rawMemoryLevel: PressureSnapshot["level"];
  smoothedAvailableRatio: number | null;
  smoothedCpuRatio: number | null;
  memoryHighSeconds: number;
  cpuHighSeconds: number;
  cpuRecoverySeconds: number;
  cpuHighBoundary: number;
  recoverySeconds: number;
  sampleCount: number;
  observationSeconds: number;
  availableTrendBytesPerMinute: number | null;
  secondsToEmergency: number | null;
  highBoundaryBytes: number;
  emergencyBoundaryBytes: number;
  severity: number;
  evidence: string[];
}

export interface AutomationPlan {
  evaluatedAt: number;
  mode: "manual" | "paused" | "observe" | "routine" | "pressureRelief" | "cpuRelief" | "probe" | "cooldown";
  pressureStage: AdaptivePressure["stage"];
  inactiveThresholdMinutes: number | null;
  maxDiscards: number;
  eligibleCount: number;
  selectedTabIds: number[];
  nextScanMinutes: number;
  cooldownUntil?: number;
  measuredCandidateCount: number;
  recentOutcomeCount: number;
  ineffectiveOutcomeCount: number;
  reasons: string[];
}

export interface PressureSnapshot {
  memorySampleValid?: boolean;
  cpuSampleWindowMs?: number;
  adaptive?: AdaptivePressure;
  sampledAt: number;
  memoryCapacityBytes: number;
  memoryAvailableBytes: number;
  memoryAvailableRatio: number;
  cpuUsageRatio: number | null;
  tabCount: number;
  discardedTabCount: number;
  frozenTabCount: number;
  protectedTabCount: number;
  level: "normal" | "high" | "emergency";
  cpuLevel?: "unknown" | "normal" | "high";
  cause?: "none" | "memory" | "cpu" | "combined";
}

export interface PowerStateSnapshot {
  supported: boolean;
  sampledAt: number;
  charging: boolean | null;
  level: number | null;
  dischargingTime?: number | null;
  policyApplied: boolean;
  effectivePolicyMode?: PolicyMode;
  reason?: string;
}

export type PressureRootCause = "none" | "chromeTabs" | "mixed" | "otherApplications" | "insufficientData" | "unknown";

export interface PressureRootCauseAssessment {
  assessedAt: number;
  likelyCause: PressureRootCause;
  confidence: number;
  summary: string;
  freshMetricCount: number;
  measuredHeapBytes: number;
  recentExternalDiscardCount: number;
  recentReleaseBytes?: number;
  recommendation?: "noAction" | "allowBoundedTabCleanup" | "holdAndRemeasure" | "avoidFurtherTabCleanup";
  shouldSuppressAutomaticDiscard?: boolean;
  evidence?: string[];
}

export interface MemoryReleaseEstimate {
  status: "measured" | "noDiscard" | "measurementFailed";
  sampledAt: number;
  discardedCount: number;
  discardReason: DiscardReason;
  beforeAvailableBytes: number;
  immediateAvailableBytes: number;
  delayedAvailableBytes: number;
  estimatedFreedBytes: number;
  sampleDelayMs: number;
  /** A later reading, taken once unloaded renderers have exited; it replaces the estimate when it shows more. */
  settledAvailableBytes?: number;
  settledDelayMs?: number;
  confidence: "systemDelta";
  error?: string;
}

export interface DiscardCandidate {
  tab: TabRuntimeState;
  inactiveMinutes: number;
  score: number;
}

export interface DiscardDecision {
  effectiveThresholdMinutes?: number;
  rationale?: string[];
  measuredHeapBytes?: number;
  cpuEvidence?: boolean;
  tab: TabRuntimeState;
  action: "discard" | "skip";
  reason?: DiscardReason;
  skipReason?: SkipReason;
  inactiveMinutes: number;
  score: number;
}

export interface DiscardLogEntry {
  id: string;
  tabId: number;
  windowId: number;
  url?: string;
  title?: string;
  domain?: string;
  discardedAt: number;
  reason: DiscardReason;
  inactiveMinutes: number;
  undoneAt?: number;
  reactivatedAt?: number;
}

export interface DiscardLearningRecord {
  baselinePenaltyMinutes?: number;
  observedCount?: number;
  effectiveSampleCount?: number;
  weightedQuickRate?: number;
  confidence?: number;
  risk?: "none" | "low" | "medium" | "high";
  domain: string;
  quickReactivations: number;
  undoCount: number;
  lastFeedbackAt: number;
  thresholdPenaltyMinutes: number;
}

export interface ExternalDiscardObservation {
  id: string;
  tabId: number;
  windowId?: number;
  domain?: string;
  observedAt: number;
  source: "chromeOrOtherExtension";
}

export interface InternalDiscardIntent {
  intentId: string;
  tabId: number;
  requestedAt: number;
  expiresAt: number;
  reason?: DiscardReason;
}

export interface AutoMergeResult {
  mergedAt: number;
  closedTabId: number;
  existingTabId: number;
  normalizedUrl: string;
  title?: string;
}

export interface DiscardAttemptResult {
  tabId: number;
  windowId?: number;
  title?: string;
  url?: string;
  domain?: string;
  reason: DiscardReason;
  status: DiscardAttemptStatus;
  failureReason?: DiscardFailureReason;
  message?: string;
  inactiveMinutes: number;
  attemptedAt: number;
  verifiedAt?: number;
}

export interface DiscardBatchResult {
  reason: DiscardReason;
  candidateCount: number;
  attemptedCount: number;
  discardedCount: number;
  skippedCount: number;
  failedCount: number;
  attempts: DiscardAttemptResult[];
}

export interface DiscardActionSummary extends DiscardBatchResult {
  id: string;
  requestedAt: number;
  completedAt: number;
  limit: number;
}

export interface WindowPolicy {
  windowId: number;
  policyMode: PolicyMode | "inherit";
  updatedAt: number;
}

export interface WindowSummary {
  windowId: number;
  tabCount: number;
  activeTitle?: string;
  activeDomain?: string;
  policyMode: PolicyMode | "inherit";
}

export type SavedSessionSource = "window" | "group" | "selection";

export interface SavedSession {
  id: string;
  name: string;
  createdAt: number;
  source: SavedSessionSource;
  tabs: SavedTab[];
}

export type SaveAndCloseResult = SavedSession & { closedCount: number; keptOpenCount: number };

export interface RecoveryTabSnapshot extends SavedTab {
  tabId?: number;
  windowId: number;
  groupId?: number;
  active?: boolean;
  discarded?: boolean;
}

export type RecoveryCapsuleReason =
  | "autoDiscard"
  | "manualDiscard"
  | "closeDuplicates"
  | "closeDiscarded"
  | "closeFrozen"
  | "saveAndClose"
  | "sessionRestore";

export interface RecoveryCapsule {
  id: string;
  createdAt: number;
  expiresAt: number;
  reason: RecoveryCapsuleReason;
  signature?: string;
  tabs: RecoveryTabSnapshot[];
  restoredAt?: number;
}

export interface SessionTimelineSnapshot {
  id: string;
  createdAt: number;
  source: "startup" | "browserEvent" | "manual";
  signature: string;
  tabs: RecoveryTabSnapshot[];
}

export interface TrashedSession {
  id: string;
  deletedAt: number;
  expiresAt: number;
  session: SavedSession;
}

/** The pressure fields the effect report, automation outcomes and backup validation read. */
export type EffectHistoryPressure = Pick<PressureSnapshot, "sampledAt" | "memoryAvailableRatio" | "level" | "cpuLevel">;

export interface EffectHistoryEntry {
  releaseStatus?: MemoryReleaseEstimate["status"];
  id: string;
  sampledAt: number;
  pressure: EffectHistoryPressure;
  discardedCount: number;
  discardReason?: DiscardReason;
  estimatedFreedBytes?: number;
}

export interface EffectReport24h {
  generatedAt: number;
  periodStart: number;
  sampleCount: number;
  highSampleCount: number;
  emergencySampleCount: number;
  cpuHighSampleCount: number;
  automaticDiscardCount: number;
  manualDiscardCount: number;
  estimatedFreedBytes: number;
  quickReactivationCount: number;
  undoCount: number;
  externalDiscardCount: number;
  topLearningDomains: DiscardLearningRecord[];
}

export interface PolicySimulationResult {
  automationPlan?: AutomationPlan;
  plannedCount?: number;
  simulatedAt: number;
  policyMode: PolicyMode;
  eligibleCount: number;
  protectedCount: number;
  recentCount: number;
  candidates: DiscardDecision[];
  skipCounts: Partial<Record<SkipReason, number>>;
}

export interface SyncStatus {
  enabled: boolean;
  lastSyncedAt?: number;
  byteSize?: number;
  sections: string[];
  error?: string;
}

export interface SessionImportResult {
  importedCount: number;
  skippedCount: number;
  sessions: SavedSession[];
}

export interface DuplicateTabsResult {
  skippedProtectedCount?: number;
  skippedChangedCount?: number;
  closedCount: number;
  duplicateGroupCount: number;
  skippedActiveCount: number;
  skippedPinnedCount: number;
  skippedIncognitoCount: number;
}

export interface CloseDiscardedTabsResult {
  skippedProtectedCount?: number;
  skippedChangedCount?: number;
  closedCount: number;
  skippedActiveCount: number;
  skippedPinnedCount: number;
  skippedIncognitoCount: number;
}

export interface CloseFrozenTabsResult extends CloseDiscardedTabsResult {}

export interface CloseTabResult {
  tabId: number;
  title?: string;
  closed: boolean;
}

export type DuplicateTabPreviewAction = "keep" | "close" | "skipActive" | "skipPinned";

export interface DuplicateTabPreview {
  tabId: number;
  windowId: number;
  title?: string;
  url?: string;
  domain?: string;
  active: boolean;
  pinned: boolean;
  lastAccessedAt?: number;
  action: DuplicateTabPreviewAction;
}

export interface DuplicateTabGroupPreview {
  normalizedUrl: string;
  displayUrl: string;
  keepTab: DuplicateTabPreview;
  closeTabs: DuplicateTabPreview[];
  skippedTabs: DuplicateTabPreview[];
}

export interface DuplicateTabsPreviewResult {
  groups: DuplicateTabGroupPreview[];
  closeCount: number;
  duplicateGroupCount: number;
  skippedActiveCount: number;
  skippedPinnedCount: number;
  skippedIncognitoCount: number;
}

export interface AccurateModeStatus {
  debuggerPermissionGranted: boolean;
  activeTabUrl?: string;
  activeTabWindowId?: number;
  activeTabId?: number;
  activeTabTitle?: string;
  activeTabDomain?: string;
}

export interface ActiveTabAccurateMetrics extends AccurateModeStatus {
  sampledAt: number;
  sampleWindowMs: number;
  jsHeapUsedBytes?: number;
  jsHeapTotalBytes?: number;
  cpuTaskRatio?: number;
  taskDurationSeconds?: number;
  documentCount?: number;
  nodeCount?: number;
}

export interface TabAccurateMetrics {
  tabId: number;
  windowId: number;
  title?: string;
  url?: string;
  domain?: string;
  jsHeapUsedBytes?: number;
  jsHeapTotalBytes?: number;
  cpuTaskRatio?: number;
  documentCount?: number;
  nodeCount?: number;
  leakVerdict?: LeakCheckVerdict;
  leakDeltaBytes?: number;
  sampledAt: number;
  error?: string;
}

export interface OpenTabsAccurateMetricsResult {
  sampledAt: number;
  measuredCount: number;
  failedCount: number;
  tabs: TabAccurateMetrics[];
}

export type LeakCheckVerdict = "likelyLeak" | "growing" | "stable" | "insufficientData";

export interface LeakCheckSample {
  sampledAt: number;
  jsHeapUsedBytes?: number;
  jsHeapTotalBytes?: number;
  nodeCount?: number;
}

export interface LeakTrendAnalysis {
  verdict: LeakCheckVerdict;
  reason: string;
  baselineBytes?: number;
  finalBytes?: number;
  deltaBytes?: number;
  deltaPercent?: number;
  slopeBytesPerMinute?: number;
  increasingSampleCount: number;
  nodeDelta?: number;
}

export interface ActiveTabLeakCheckResult extends AccurateModeStatus, LeakTrendAnalysis {
  sampledAt: number;
  sampleIntervalMs: number;
  sampleCount: number;
  durationMs: number;
  samples: LeakCheckSample[];
}

export interface CurrentTabProtectionStatus {
  canToggle: boolean;
  exactTabProtected: boolean;
  protectedByDomain: boolean;
  protectedByUrlPattern: boolean;
  ruleId?: string;
  domainRuleId?: string;
  urlPatternRuleId?: string;
  url?: string;
  domain?: string;
  title?: string;
}

export interface UnprotectTabResult {
  tabId: number;
  removedRuleIds: string[];
  removedCount: number;
}

export interface TabProtectionToggleResult {
  tabId: number;
  protected: boolean;
  temporary: boolean;
  changed: boolean;
}

export interface TabFocusToggleResult {
  tabId: number;
  focused: boolean;
  focusModeEnabled: boolean;
  changed: boolean;
  activeFocusCount: number;
  cleanupDiscardedCount: number;
  cleanupEligibleCount: number;
}

export interface PageOptimizerStatus {
  enabledInSettings: boolean;
  allSitesEnabled: boolean;
  allSitesAccessGranted: boolean;
  activeSiteExcluded: boolean;
  activeTabPaused: boolean;
  activeTabOptimized: boolean;
  activeSiteEnabled: boolean;
  activeSiteAccessGranted: boolean;
  canToggleActiveTab: boolean;
  siteDomains: string[];
  siteAccessGrantedCount?: number;
  items: PageOptimizerItemStatus[];
  warning: string;
  reason?: string;
  activeTabId?: number;
  activeTabDomain?: string;
  activeTabTitle?: string;
  aiConversationMetrics?: AiConversationOptimizerMetrics;
  pageMetrics?: PageOptimizerMetrics;
}

export interface PageOptimizerToggleResult extends PageOptimizerStatus {
  changed: boolean;
}

export interface PageOptimizerItemStatus {
  metrics?: PageOptimizerItemMetrics;
  id: PageOptimizerItemId;
  label: string;
  description: string;
  enabled: boolean;
}

export interface SavedTab {
  url: string;
  title?: string;
  originalWindowId?: number;
  originalIndex?: number;
  originalGroupId?: number;
  originalGroupTitle?: string;
  originalGroupColor?: chrome.tabGroups.Color;
  originalGroupCollapsed?: boolean;
  pinned?: boolean;
}

export interface WorkProtectionHold {
  tabId: number;
  url: string;
  lastAccessed: number;
  checkedAt: number;
  expiresAt: number;
  reason: "unsavedWork" | "workStateUnknown";
}

export interface AppState {
  workProtectionHolds?: WorkProtectionHold[];
  automationPlan?: AutomationPlan;
  settings: Settings;
  protectionRules: ProtectionRule[];
  temporaryTabProtections: TemporaryTabProtection[];
  focusModeEnabled: boolean;
  focusSets: SavedFocusSet[];
  optimizedTabs: OptimizedTab[];
  tabAccurateMetrics: TabAccurateMetrics[];
  windowPolicies: WindowPolicy[];
  discardLog: DiscardLogEntry[];
  sessions: SavedSession[];
  lastPressure?: PressureSnapshot;
  lastMemoryRelease?: MemoryReleaseEstimate;
  lastDiscardSummary?: DiscardActionSummary;
  powerState?: PowerStateSnapshot;
  rootCauseAssessment?: PressureRootCauseAssessment;
  discardLearning?: DiscardLearningRecord[];
  externalDiscardObservations?: ExternalDiscardObservation[];
  recoveryCapsules?: RecoveryCapsule[];
  sessionTimeline?: SessionTimelineSnapshot[];
  sessionTrash?: TrashedSession[];
  effectHistory?: EffectHistoryEntry[];
  lastAutoMerge?: AutoMergeResult;
  syncStatus?: SyncStatus;
  windowSummaries?: WindowSummary[];
  currentTabProtection?: CurrentTabProtectionStatus;
  pageOptimizerStatus?: PageOptimizerStatus;
}

export type ScanReason = "startup" | "periodic" | "manual";
