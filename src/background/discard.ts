import type {
  DiscardAttemptResult,
  DiscardBatchResult,
  DiscardDecision,
  DiscardFailureReason,
  DiscardReason
} from "../shared/types";
import {
  appendDiscardLog,
  getProtectionRules,
  getSettings,
  getTemporaryTabProtections,
  saveWorkProtectionHold,
  updateInternalDiscardIntents
} from "../shared/storage";
import { DEFAULT_SETTINGS } from "../shared/constants";
import {
  getHostname,
  isHttpUrl,
  matchesProtectedDomain,
  matchesProtectedUrlPattern
} from "../shared/url";
import { createInternalDiscardIntent, recordInternalDiscardIntent } from "./resourceIntelligence";
import { getSkipReason, isSettlingLoad } from "./policy";
import { checkUnsavedWork, type WorkProtectionResult } from "./workProtection";

interface PrefetchedWorkCheck {
  result: WorkProtectionResult;
  protectUnsavedWork: boolean;
  protectMedia: boolean;
}

/**
 * What happens to a tab Coppice could not check (no website access, a frame it can't reach, a timeout).
 * A detected draft always keeps a tab loaded. An unchecked tab is unloaded when the person asks for it or
 * memory is low; routine cleanup leaves it loaded. Keeping every unchecked tab loaded freed no memory at
 * all without website access, which is the default.
 */
export type UncheckedTabPolicy = "keep" | "unload";

export function uncheckedTabPolicyFor(reason: DiscardReason): UncheckedTabPolicy {
  return reason === "autoInactive" ? "keep" : "unload";
}

async function unsavedWorkReason(
  tab: chrome.tabs.Tab,
  startedCheck: Promise<PrefetchedWorkCheck> | undefined,
  unchecked: UncheckedTabPolicy
): Promise<DiscardFailureReason | null> {
  const settings = chrome.storage?.local ? await getSettings() : DEFAULT_SETTINGS;
  if (!settings.protectUnsavedWork && !settings.protectAudible) return null;
  const prefetched = startedCheck ? await startedCheck : undefined;
  const options = { protectUnsavedWork: settings.protectUnsavedWork, protectMedia: settings.protectAudible };
  const result = tab.id == null ? "workStateUnknown"
    : prefetched && prefetched.protectUnsavedWork === options.protectUnsavedWork && prefetched.protectMedia === options.protectMedia
      ? prefetched.result : await checkUnsavedWork(tab.id, options);
  // A URL capsule cannot recover an unsent draft, so a detected draft is never unloaded. An unchecked
  // page is not reported as checked; it only unloads under the policy above.
  const reason = result === "activeMedia" && settings.protectAudible ? "audible"
    : settings.protectUnsavedWork && (result === "unsavedWork" || (result === "workStateUnknown" && unchecked === "keep"))
      ? result : null;
  if (chrome.storage?.session) {
    try { await saveWorkProtectionHold(tab, reason === "audible" ? null : reason); } catch { /* A cache failure never disables protection. */ }
  }
  return reason;
}

async function rememberInternalDiscardIntent(tabId: number, reason: DiscardReason): Promise<void> {
  if (!chrome.storage?.session) return;
  try {
    const requestedAt = Date.now();
    const intent = createInternalDiscardIntent({
      intentId: crypto.randomUUID(),
      tabId,
      requestedAt,
      reason
    });
    await updateInternalDiscardIntents(ledger => recordInternalDiscardIntent(ledger, intent, requestedAt));
  } catch (error) {
    console.warn("Failed to persist internal discard intent", tabId, error);
  }
}

async function moveInternalDiscardIntent(fromTabId: number, toTabId: number): Promise<void> {
  if (!chrome.storage?.session) return;
  try {
    await updateInternalDiscardIntents(ledger => ledger.map(intent => intent.tabId === fromTabId ? { ...intent, tabId: toTabId } : intent));
  } catch (error) {
    console.warn("Failed to move internal discard intent", fromTabId, toTabId, error);
  }
}

async function forgetInternalDiscardIntent(tabId: number): Promise<void> {
  if (!chrome.storage?.session) return;
  try {
    await updateInternalDiscardIntents(ledger => ledger.filter(intent => intent.tabId !== tabId));
  } catch (error) {
    console.warn("Failed to clear internal discard intent", tabId, error);
  }
}

export function sortDiscardDecisions(decisions: DiscardDecision[]): DiscardDecision[] {
  return [...decisions]
    .filter(decision => decision.action === "discard")
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.inactiveMinutes !== a.inactiveMinutes) return b.inactiveMinutes - a.inactiveMinutes;
      if (a.tab.windowId !== b.tab.windowId) return a.tab.windowId - b.tab.windowId;
      return a.tab.tabId - b.tab.tabId;
    });
}

export async function discardSelected(
  decisions: DiscardDecision[],
  limit: number,
  reason: DiscardReason,
  unchecked: UncheckedTabPolicy = uncheckedTabPolicyFor(reason)
): Promise<DiscardBatchResult> {
  const allCandidates = sortDiscardDecisions(decisions);
  const candidates = allCandidates.slice(0, limit);
  const attempts: DiscardAttemptResult[] = [];
  const workChecks = await startWorkChecks(candidates.map(decision => decision.tab.tabId));

  for (const decision of candidates) {
    attempts.push(await discardOneWithResult(decision, reason, workChecks.get(decision.tab.tabId), unchecked));
  }

  return createBatchResult(reason, allCandidates.length, attempts);
}

// Background pages are checked for unsaved text a few at a time before the batch starts, so one
// slow page doesn't hold up the rest. Each tab's state is still rechecked right before it unloads.
const WORK_CHECK_CONCURRENCY = 4;

async function startWorkChecks(tabIds: number[]): Promise<Map<number, Promise<PrefetchedWorkCheck>>> {
  const settings = chrome.storage?.local ? await getSettings() : DEFAULT_SETTINGS;
  if (!settings.protectUnsavedWork && !settings.protectAudible) return new Map();
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => running < WORK_CHECK_CONCURRENCY
    ? (running += 1, Promise.resolve())
    : new Promise<void>(resolve => waiting.push(resolve));
  const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };
  return new Map(tabIds.filter(tabId => tabId >= 0).map(tabId => [tabId, (async () => {
    await acquire();
    const options = { protectUnsavedWork: settings.protectUnsavedWork, protectMedia: settings.protectAudible };
    try { return { ...options, result: await checkUnsavedWork(tabId, options) }; } finally { release(); }
  })()]));
}

export async function discardOne(decision: DiscardDecision, reason: DiscardReason): Promise<boolean> {
  return (await discardOneWithResult(decision, reason)).status === "discarded";
}

function createBatchResult(
  reason: DiscardReason,
  candidateCount: number,
  attempts: DiscardAttemptResult[]
): DiscardBatchResult {
  return {
    reason,
    candidateCount,
    attemptedCount: attempts.length,
    discardedCount: attempts.filter(attempt => attempt.status === "discarded").length,
    skippedCount: attempts.filter(attempt => attempt.status === "skipped").length,
    failedCount: attempts.filter(attempt => attempt.status === "failed").length,
    attempts
  };
}

function resultFromDecision(input: {
  attemptedAt: number;
  decision: DiscardDecision;
  reason: DiscardReason;
  status: DiscardAttemptResult["status"];
  failureReason?: DiscardFailureReason;
  message?: string;
  verifiedAt?: number;
}): DiscardAttemptResult {
  return {
    tabId: input.decision.tab.tabId,
    windowId: input.decision.tab.windowId,
    title: input.decision.tab.title,
    url: input.decision.tab.url,
    domain: input.decision.tab.domain,
    reason: input.reason,
    status: input.status,
    failureReason: input.failureReason,
    message: input.message,
    inactiveMinutes: input.decision.inactiveMinutes,
    attemptedAt: input.attemptedAt,
    verifiedAt: input.verifiedAt
  };
}

function resultFromTab(input: {
  attemptedAt: number;
  tabId: number;
  tab?: chrome.tabs.Tab;
  reason: DiscardReason;
  status: DiscardAttemptResult["status"];
  failureReason?: DiscardFailureReason;
  message?: string;
  inactiveMinutes?: number;
  verifiedAt?: number;
}): DiscardAttemptResult {
  return {
    tabId: input.tabId,
    windowId: input.tab?.windowId,
    title: input.tab?.title,
    url: input.tab?.url,
    domain: getHostname(input.tab?.url) ?? undefined,
    reason: input.reason,
    status: input.status,
    failureReason: input.failureReason,
    message: input.message,
    inactiveMinutes: input.inactiveMinutes ?? 0,
    attemptedAt: input.attemptedAt,
    verifiedAt: input.verifiedAt
  };
}

async function verifyDiscarded(tabId: number, expectedUrl: string | undefined): Promise<boolean> {
  // The discard response is a snapshot. A navigation or reactivation can
  // invalidate it immediately, so verify the current tab after the event turn.
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise(resolve => globalThis.setTimeout(resolve, 75));
      const current = await chrome.tabs.get(tabId);
      if (current.active || current.pendingUrl || current.url !== expectedUrl) return false;
      if (current.discarded) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function skipReasonForLatestTab(
  tab: chrome.tabs.Tab,
  decision: DiscardDecision,
  reason: DiscardReason
): Promise<DiscardFailureReason | null> {
  if (tab.id == null) return "noTabId";
  if (tab.active) return "becameActive";
  if (decision.tab.url && tab.url !== decision.tab.url) return "recentlyActive";
  if (tab.discarded) return "alreadyDiscarded";
  if (!tab.url) return "noUrl";
  if (!isHttpUrl(tab.url)) return "specialScheme";
  if (
    typeof tab.lastAccessed === "number" &&
    Number.isFinite(tab.lastAccessed) &&
    tab.lastAccessed > decision.tab.lastAccessedAt
  ) {
    return "recentlyActive";
  }

  let settings = DEFAULT_SETTINGS;
  let rules: Awaited<ReturnType<typeof getProtectionRules>> = [];
  let temporaryProtectedTabIds = new Set<number>();
  if (chrome.storage?.local) {
    const context = await Promise.all([
      getSettings(),
      getProtectionRules(),
      chrome.storage?.session ? getTemporaryTabProtections() : Promise.resolve([])
    ]);
    settings = context[0];
    rules = context[1];
    temporaryProtectedTabIds = new Set(context[2].map(protection => protection.tabId));
  }

  const effectiveSettings = reason === "memoryPressure"
    ? {
        ...settings,
        protectPinned: true,
        protectAudible: true,
        protectIncognito: true,
        respectAutoDiscardableFalse: true
      }
    : settings;
  const inactiveMinutes = typeof tab.lastAccessed === "number"
    ? Math.max(0, (Date.now() - tab.lastAccessed) / 60_000)
    : decision.inactiveMinutes;
  const skipReason = getSkipReason(
    tab,
    effectiveSettings,
    rules,
    temporaryProtectedTabIds,
    inactiveMinutes,
    0
  );
  if (skipReason === "active") return "becameActive";
  if (skipReason === "discarded") return "alreadyDiscarded";
  if (skipReason === "manualPolicy" || skipReason === "unknown") return null;
  return skipReason;
}

function discardFailureMessage(reason: DiscardFailureReason): string {
  switch (reason) {
    case "noTabId":
      return "Chrome did not provide a tab ID.";
    case "noTab":
      return "The tab no longer exists.";
    case "noUrl":
      return "The tab has no URL.";
    case "specialScheme":
      return "Chrome pages can’t be unloaded.";
    case "becameActive":
      return "The tab became active before unloading.";
    case "pinned":
      return "Pinned tabs are protected.";
    case "audible":
      return "Tabs playing audio or video are protected.";
    case "unsavedWork":
      return "Kept loaded: this tab has unfinished edits.";
    case "workStateUnknown":
      return "Kept loaded: work protection could not check this page. Check website access in Settings.";
    case "alreadyDiscarded":
      return "The tab is already unloaded.";
    case "incognito":
      return "Incognito tabs are protected.";
    case "autoDiscardableFalse":
      return "The page asked Chrome not to unload it.";
    case "protectedTemporary":
      return "You kept this tab loaded just before unloading.";
    case "protectedDomain":
      return "The site became protected just before unloading.";
    case "protectedUrlPattern":
      return "The page became protected just before unloading.";
    case "loading":
      return "The tab is still loading.";
    case "recentlyActive":
      return "The tab was used again before unloading.";
    case "onlyTabInWindow":
      return "The selected tab is the only tab in its window.";
    case "chromeDiscardFailed":
      return "Chrome did not unload the tab.";
    case "verificationFailed":
      return "Chrome accepted the request, but the tab didn’t unload.";
    case "chromeError":
      return "Chrome returned an error while unloading the tab.";
  }
}

export async function discardOneWithResult(
  decision: DiscardDecision,
  reason: DiscardReason,
  startedWorkCheck?: Promise<PrefetchedWorkCheck>,
  unchecked: UncheckedTabPolicy = uncheckedTabPolicyFor(reason)
): Promise<DiscardAttemptResult> {
  const attemptedAt = Date.now();
  const tabId = decision.tab.tabId;
  if (tabId < 0) {
    return resultFromDecision({
      attemptedAt,
      decision,
      reason,
      status: "skipped",
      failureReason: "noTabId",
      message: discardFailureMessage("noTabId")
    });
  }

  try {
    const latest = await chrome.tabs.get(tabId);
    let skipReason = await skipReasonForLatestTab(latest, decision, reason);
    if (!skipReason) skipReason = await unsavedWorkReason(latest, startedWorkCheck, unchecked);
    // A page check can take time. Recheck activation, navigation and protections
    // before issuing a destructive operation.
    if (!skipReason) skipReason = await skipReasonForLatestTab(await chrome.tabs.get(tabId), decision, reason);

    if (skipReason) {
      return resultFromDecision({
        attemptedAt,
        decision,
        reason,
        status: "skipped",
        failureReason: skipReason,
        message: discardFailureMessage(skipReason)
      });
    }

    await rememberInternalDiscardIntent(tabId, reason);
    const result = await chrome.tabs.discard(tabId);
    if (!result) {
      await forgetInternalDiscardIntent(tabId);
      return resultFromDecision({
        attemptedAt,
        decision,
        reason,
        status: "failed",
        failureReason: "chromeDiscardFailed",
        message: discardFailureMessage("chromeDiscardFailed")
      });
    }

    // Chrome usually replaces an unloaded tab with a new id; verify and log the tab it returned.
    const discardedTabId = result.id ?? tabId;
    if (discardedTabId !== tabId) await moveInternalDiscardIntent(tabId, discardedTabId);
    const verified = await verifyDiscarded(discardedTabId, latest.url);
    const verifiedAt = Date.now();
    if (!verified) {
      await forgetInternalDiscardIntent(discardedTabId);
      return resultFromDecision({
        attemptedAt,
        decision,
        reason,
        status: "failed",
        failureReason: "verificationFailed",
        message: discardFailureMessage("verificationFailed"),
        verifiedAt
      });
    }

    try {
      await appendDiscardLog({
        id: crypto.randomUUID(),
        tabId: discardedTabId,
        windowId: decision.tab.windowId,
        url: decision.tab.url,
        title: decision.tab.title,
        domain: decision.tab.domain,
        discardedAt: Date.now(),
        reason,
        inactiveMinutes: decision.inactiveMinutes
      });
    } catch (error) {
      console.warn("Tab was discarded, but its discard log could not be saved", tabId, error);
    }

    return resultFromDecision({
      attemptedAt,
      decision,
      reason,
      status: "discarded",
      verifiedAt
    });
  } catch (error) {
    await forgetInternalDiscardIntent(tabId);
    console.warn("Failed to discard tab", tabId, error);
    return resultFromDecision({
      attemptedAt,
      decision,
      reason,
      status: "failed",
      failureReason: "chromeError",
      message: error instanceof Error ? error.message : discardFailureMessage("chromeError")
    });
  }
}

async function activateFallbackTabBeforeDiscard(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null || !tab.active) return;

  const sameWindowTabs = await chrome.tabs.query({ windowId: tab.windowId });
  const fallback =
    sameWindowTabs.find(candidate => candidate.id != null && candidate.id !== tab.id && !candidate.discarded) ??
    sameWindowTabs.find(candidate => candidate.id != null && candidate.id !== tab.id);

  if (fallback?.id == null) {
    throw new Error("Can’t unload the selected tab: this window has no other tab to switch to.");
  }

  await chrome.tabs.update(fallback.id, { active: true });
}

async function latestExplicitProtectionReason(tab: chrome.tabs.Tab): Promise<DiscardFailureReason | null> {
  if (tab.id == null || !tab.url || !chrome.storage?.local) return null;
  const [rules, temporaryProtections] = await Promise.all([
    getProtectionRules(),
    chrome.storage?.session ? getTemporaryTabProtections() : Promise.resolve([])
  ]);
  if (temporaryProtections.some(protection => protection.tabId === tab.id)) return "protectedTemporary";
  const hostname = getHostname(tab.url);
  if (hostname && matchesProtectedDomain(hostname, rules)) return "protectedDomain";
  if (matchesProtectedUrlPattern(tab.url, rules)) return "protectedUrlPattern";
  return null;
}

export async function discardTabDirectly(tabId: number, reason: DiscardReason = "manualRelease"): Promise<boolean> {
  return (await discardTabDirectlyWithResult(tabId, reason)).status === "discarded";
}

export async function discardTabDirectlyWithResult(
  tabId: number,
  reason: DiscardReason = "manualRelease"
): Promise<DiscardAttemptResult> {
  const attemptedAt = Date.now();
  try {
    const latest = await chrome.tabs.get(tabId);
    const inactiveMinutes =
      typeof latest.lastAccessed === "number" ? Math.max(0, (Date.now() - latest.lastAccessed) / 60_000) : 0;

    if (
      latest.id == null ||
      latest.audible ||
      latest.discarded ||
      !latest.url ||
      !isHttpUrl(latest.url)
    ) {
      const failureReason =
        latest.id == null
          ? "noTabId"
          : latest.audible
            ? "audible"
            : latest.discarded
              ? "alreadyDiscarded"
              : !latest.url
                ? "noUrl"
                : "specialScheme";
      return resultFromTab({
        attemptedAt,
        tabId,
        tab: latest,
        reason,
        status: "skipped",
        failureReason,
        message: discardFailureMessage(failureReason),
        inactiveMinutes
      });
    }

    const protectionReason = await latestExplicitProtectionReason(latest) ??
      await unsavedWorkReason(latest, undefined, uncheckedTabPolicyFor(reason));
    if (protectionReason) {
      return resultFromTab({
        attemptedAt,
        tabId,
        tab: latest,
        reason,
        status: "skipped",
        failureReason: protectionReason,
        message: discardFailureMessage(protectionReason),
        inactiveMinutes
      });
    }

    try {
      await activateFallbackTabBeforeDiscard(latest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return resultFromTab({
        attemptedAt,
        tabId,
        tab: latest,
        reason,
        status: "skipped",
        failureReason: "onlyTabInWindow",
        message,
        inactiveMinutes
      });
    }

    const current = await chrome.tabs.get(tabId);
    const changedReason: DiscardFailureReason | null = current.active ? "becameActive"
      : current.pendingUrl || current.url !== latest.url || current.lastAccessed !== latest.lastAccessed ? "recentlyActive"
      : current.audible ? "audible" : isSettlingLoad(current) ? "loading"
      : await latestExplicitProtectionReason(current);
    if (changedReason) {
      return resultFromTab({ attemptedAt, tabId, tab: current, reason, status: "skipped",
        failureReason: changedReason, message: discardFailureMessage(changedReason), inactiveMinutes });
    }

    await rememberInternalDiscardIntent(tabId, reason);
    const result = await chrome.tabs.discard(tabId);
    if (!result) {
      await forgetInternalDiscardIntent(tabId);
      return resultFromTab({
        attemptedAt,
        tabId,
        tab: latest,
        reason,
        status: "failed",
        failureReason: "chromeDiscardFailed",
        message: discardFailureMessage("chromeDiscardFailed"),
        inactiveMinutes
      });
    }

    // Chrome usually replaces an unloaded tab with a new id; verify and log the tab it returned.
    const discardedTabId = result.id ?? tabId;
    if (discardedTabId !== tabId) await moveInternalDiscardIntent(tabId, discardedTabId);
    const verified = await verifyDiscarded(discardedTabId, latest.url);
    const verifiedAt = Date.now();
    if (!verified) {
      await forgetInternalDiscardIntent(discardedTabId);
      return resultFromTab({
        attemptedAt,
        tabId,
        tab: latest,
        reason,
        status: "failed",
        failureReason: "verificationFailed",
        message: discardFailureMessage("verificationFailed"),
        inactiveMinutes,
        verifiedAt
      });
    }

    try {
      await appendDiscardLog({
        id: crypto.randomUUID(),
        tabId: discardedTabId,
        windowId: latest.windowId,
        url: latest.url,
        title: latest.title,
        domain: getHostname(latest.url) ?? undefined,
        discardedAt: Date.now(),
        reason,
        inactiveMinutes
      });
    } catch (error) {
      console.warn("Tab was discarded, but its discard log could not be saved", tabId, error);
    }

    return resultFromTab({
      attemptedAt,
      tabId,
      tab: latest,
      reason,
      status: "discarded",
      inactiveMinutes,
      verifiedAt
    });
  } catch (error) {
    await forgetInternalDiscardIntent(tabId);
    console.warn("Failed to directly discard tab", tabId, error);
    return resultFromTab({
      attemptedAt,
      tabId,
      reason,
      status: "failed",
      failureReason: "chromeError",
      message: error instanceof Error ? error.message : discardFailureMessage("chromeError")
    });
  }
}
