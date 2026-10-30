import type { NetworkDietMode } from "../shared/types";

export const DNR_DYNAMIC_RULE_ID_START = 10000;
const DNR_DYNAMIC_RULE_ID_END = 10999;
let lastSynchronizedMode: NetworkDietMode | null = null;
let syncQueue: Promise<void> = Promise.resolve();

export function getLightRules(): chrome.declarativeNetRequest.Rule[] {
  return [
    {
      id: DNR_DYNAMIC_RULE_ID_START + 1,
      priority: 1,
      action: { type: "block" },
      condition: {
        resourceTypes: ["ping"],
        domainType: "thirdParty"
      }
    },
    {
      id: DNR_DYNAMIC_RULE_ID_START + 2,
      priority: 1,
      action: { type: "block" },
      condition: {
        urlFilter: "||google-analytics.com^",
        resourceTypes: ["script", "xmlhttprequest", "image"]
      }
    },
    {
      id: DNR_DYNAMIC_RULE_ID_START + 3,
      priority: 1,
      action: { type: "block" },
      condition: {
        urlFilter: "||googletagmanager.com^",
        resourceTypes: ["script"]
      }
    },
    {
      id: DNR_DYNAMIC_RULE_ID_START + 4,
      priority: 1,
      action: { type: "block" },
      condition: {
        urlFilter: "||doubleclick.net^",
        resourceTypes: ["script", "image", "sub_frame", "xmlhttprequest"]
      }
    }
  ];
}

export function isOwnedDnrRuleId(id: number): boolean {
  return id >= DNR_DYNAMIC_RULE_ID_START && id <= DNR_DYNAMIC_RULE_ID_END;
}

async function syncDnrRulesNow(mode: NetworkDietMode): Promise<void> {
  if (lastSynchronizedMode === mode) return;
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const ownedRuleIds = currentRules.map(rule => rule.id).filter(isOwnedDnrRuleId);

  if (mode === "off") {
    if (ownedRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ownedRuleIds
      });
    }
    lastSynchronizedMode = mode;
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ownedRuleIds,
    addRules: getLightRules()
  });
  lastSynchronizedMode = mode;
}

/** Serializes rule replacement so overlapping power/settings refreshes cannot
 * leave Chrome with rules from an older request. */
export function syncDnrRules(mode: NetworkDietMode): Promise<void> {
  if (mode !== "off" && mode !== "light") {
    return Promise.reject(new Error("Invalid Network Diet mode."));
  }
  const operation = syncQueue.then(() => syncDnrRulesNow(mode));
  syncQueue = operation.catch(() => undefined);
  return operation;
}
