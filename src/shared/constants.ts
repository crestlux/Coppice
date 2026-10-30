import type { ProtectionRule, Settings } from "./types";

export const SCAN_ALARM_NAME = "resource-governor-scan";

export const STORAGE_KEYS = {
  SETTINGS: "settings",
  PROTECTION_RULES: "protectionRules",
  WINDOW_POLICIES: "windowPolicies",
  DISCARD_LOG: "discardLog",
  SESSIONS: "sessions",
  FOCUS_SETS: "focusSets",
  LAST_PRESSURE: "lastPressure",
  DISCARD_LEARNING: "discardLearning",
  EXTERNAL_DISCARD_OBSERVATIONS: "externalDiscardObservations",
  RECOVERY_CAPSULES: "recoveryCapsules",
  SESSION_TIMELINE: "sessionTimeline",
  SESSION_TRASH: "sessionTrash",
  EFFECT_HISTORY: "effectHistory",
  SYNC_STATUS: "syncStatus"
} as const;

export const SESSION_KEYS = {
  WORK_PROTECTION_HOLDS: "workProtectionHolds",
  CPU_SAMPLE: "cpuSample",
  PRESSURE_HISTORY: "pressureHistory",
  AUTOMATION_PLAN: "automationPlan",
  LAST_SCAN_AT: "lastScanAt",
  TEMPORARY_TAB_PROTECTIONS: "temporaryTabProtections",
  FOCUS_MODE_ENABLED: "focusModeEnabled",
  EXPERIMENTAL_OPTIMIZED_TABS: "experimentalOptimizedTabs",
  OPTIMIZER_PAUSED_TABS: "optimizerPausedTabs",
  TAB_ACCURATE_METRICS: "tabAccurateMetrics",
  LAST_MEMORY_RELEASE: "lastMemoryRelease",
  LAST_DISCARD_SUMMARY: "lastDiscardSummary",
  POWER_STATE: "powerState",
  ROOT_CAUSE_ASSESSMENT: "rootCauseAssessment",
  INTERNAL_DISCARD_INTENTS: "internalDiscardIntents",
  LAST_AUTO_MERGE: "lastAutoMerge"
} as const;

export const DEFAULT_SETTINGS: Settings = {
  policyMode: "balanced",
  conservativeMinutes: 30,
  balancedMinutes: 15,
  aggressiveMinutes: 5,
  customMinutes: 20,
  scanIntervalMinutes: 1,
  maxAutoDiscardsPerScan: 6,
  maxManualDiscardsPerAction: 30,
  protectPinned: true,
  protectAudible: true,
  protectUnsavedWork: true,
  protectActive: true,
  protectIncognito: true,
  respectAutoDiscardableFalse: true,
  memoryHighAvailableRatio: 0.15,
  memoryEmergencyAvailableRatio: 0.08,
  cpuHighRatio: 0.85,
  powerPolicyMode: "batterySaver",
  lowBatteryThreshold: 0.3,
  autoMergeDuplicateTabs: false,
  discardLearningEnabled: true,
  quickReactivateMinutes: 5,
  timeMachineEnabled: true,
  timeMachineIntervalMinutes: 5,
  timeMachineRetention: 100,
  recoveryCapsuleLimit: 30,
  syncEnabled: false,
  syncSettings: true,
  syncProtectionRules: true,
  syncFocusSets: true,
  networkDietMode: "off",
  keepDiscardLogLimit: 300,
  keepSessionLimit: 100,
  showBadge: true,
  privacyMode: false,
  experimentalOptimizerEnabled: false,
  experimentalOptimizerAllSites: false,
  experimentalOptimizerExcludedDomains: [],
  experimentalOptimizerItems: {
    offscreenRendering: true,
    mediaContainment: true,
    animationLimiter: true,
    visualEffectsReducer: true,
    codeBlockContainment: true,
    imageContainment: true,
    chatgptConversationOptimizer: true,
    reducedMotionMode: false,
    backgroundAnimationPause: true,
    offscreenMediaPause: true
  },
  experimentalOptimizerSiteDomains: [],
  domainDiscardRules: [],
  snoozeIndefinitely: false
};

export const DEFAULT_PROTECTION_RULES: ProtectionRule[] = [
  {
    id: "default-localhost",
    type: "domain",
    value: "localhost",
    source: "default",
    enabled: true,
    createdAt: 0
  },
  {
    id: "default-127",
    type: "domain",
    value: "127.0.0.1",
    source: "default",
    enabled: true,
    createdAt: 0
  }
];

export const PROTECTION_SKIP_REASONS = new Set([
  "unsavedWork",
  "workStateUnknown",
  "active",
  "pinned",
  "audible",
  "protectedTemporary",
  "protectedDomain",
  "protectedUrlPattern",
  "autoDiscardableFalse",
  "incognito"
]);
