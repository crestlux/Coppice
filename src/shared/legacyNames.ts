/** Read-only compatibility identifiers. New writes use Coppice names exclusively. */
export const LEGACY_NAMES = {
  scanAlarm: "resource-governor-scan",
  tabSort: "resourceGovernor.tabSortMode",
  optimizedTabs: "experimentalOptimizedTabs",
  backupFormat: "chrome-resource-governor-backup",
  syncFormat: "chrome-resource-governor-sync",
  syncPrefix: "resourceGovernor.sync.",
  syncManifest: "resourceGovernor.sync.manifest",
  syncSections: {
    settings: "resourceGovernor.sync.settings",
    protectionRules: "resourceGovernor.sync.protectionRules",
    focusSets: "resourceGovernor.sync.focusSets"
  },
  optimizer: {
    page: "__resourceGovernorPageOptimizerV1",
    ai: "__resourceGovernorAiConversationOptimizerV2",
    bridge: "__resourceGovernorOptimizerCleanup",
    restoreMessage: "resourceGovernor.restoreOptimizer",
    aiAttributes: [
      "data-resource-governor-ai-runtime", "data-resource-governor-ai-provider",
      "data-resource-governor-ai-detected", "data-resource-governor-ai-recent",
      "data-resource-governor-ai-excluded", "data-resource-governor-ai-strategy",
      "data-resource-governor-ai-candidate", "data-resource-governor-ai-section",
      "data-resource-governor-ai-turn"
    ],
    aiTurnSizeProperty: "--resource-governor-ai-turn-size"
  }
} as const;

const SETTING_NAMES = {
  networkDietMode: "networkFilteringMode",
  experimentalOptimizerEnabled: "pageOptimizerEnabled",
  experimentalOptimizerAllSites: "pageOptimizerAllSites",
  experimentalOptimizerExcludedDomains: "pageOptimizerExcludedDomains",
  experimentalOptimizerItems: "pageOptimizerItems",
  experimentalOptimizerSiteDomains: "pageOptimizerSiteDomains"
} as const;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

function migrateItemNames(value: Record<string, unknown>): Record<string, unknown> {
  const items = { ...value };
  if (!Object.hasOwn(items, "aiConversationOptimizer") && Object.hasOwn(items, "chatgptConversationOptimizer")) {
    items.aiConversationOptimizer = items.chatgptConversationOptimizer;
  }
  delete items.chatgptConversationOptimizer;
  return items;
}

/** Idempotent; presence, not truthiness, decides which value wins. Does not add defaults. */
export function migrateSettingsNames(value: unknown): Record<string, unknown> {
  const source = record(value) ?? {};
  const settings = { ...source };
  for (const [previous, current] of Object.entries(SETTING_NAMES)) {
    if (!Object.hasOwn(settings, current) && Object.hasOwn(source, previous)) settings[current] = source[previous];
    delete settings[previous];
  }
  const currentItems = record(settings.pageOptimizerItems);
  if (currentItems) {
    const previousItems = record(source.experimentalOptimizerItems);
    settings.pageOptimizerItems = {
      ...(previousItems ? migrateItemNames(previousItems) : {}),
      ...migrateItemNames(currentItems)
    };
  }
  return settings;
}

export function readMigratedTabSort(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, key: string): string | null {
  const current = storage.getItem(key);
  const previous = storage.getItem(LEGACY_NAMES.tabSort);
  if (current !== null) {
    if (previous !== null) storage.removeItem(LEGACY_NAMES.tabSort);
    return current;
  }
  if (previous === null) return null;
  // A failed write must leave the previous preference available for another attempt.
  storage.setItem(key, previous);
  storage.removeItem(LEGACY_NAMES.tabSort);
  return previous;
}
