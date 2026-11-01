import { LEGACY_NAMES } from "../shared/legacyNames";
import { LEGACY_OPTIMIZER_ITEM_CSS } from "./legacyOptimizerCss";

/** Serialized by chrome.scripting: compatibility names are passed as data, not captured. */
export function restoreLegacyOptimizerInPage(names: typeof LEGACY_NAMES.optimizer): void {
  const host = globalThis as unknown as Record<string, {
    stop?(): void;
    api?: typeof chrome.runtime;
    listener?: (message: unknown, sender: chrome.runtime.MessageSender, respond: (value?: unknown) => void) => void;
  } | undefined>;
  const bridge = host[names.bridge];
  try {
    if (bridge?.listener) bridge.api?.onMessage.removeListener(bridge.listener);
  } catch { /* An updated extension may invalidate the previous runtime API. */ }
  delete host[names.bridge];
  for (const key of [names.page, names.ai]) {
    try { host[key]?.stop?.(); } catch { /* Continue cleanup if an expired runtime cannot stop. */ }
    finally { delete host[key]; }
  }
  // Reloading an extension creates a new isolated world. The previous globals
  // may be gone while its DOM markers remain. Remove only our AI metadata and
  // size variable; page-owned styles and DOM content must stay untouched.
  const selector = names.aiAttributes.map(attribute => `[${attribute}]`).join(",");
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    for (const attribute of names.aiAttributes) element.removeAttribute(attribute);
    element.style?.removeProperty(names.aiTurnSizeProperty);
  }
}

/** Old CSS is removed with its exact original text; it is never inserted again. */
export async function restoreLegacyOptimizer(tabId: number): Promise<void> {
  // An existing content-script channel may still work after host access is revoked.
  await chrome.tabs.sendMessage?.(tabId, { type: LEGACY_NAMES.optimizer.restoreMessage }).catch(() => undefined);
  await chrome.scripting.executeScript({
    target: { tabId }, func: restoreLegacyOptimizerInPage, args: [LEGACY_NAMES.optimizer]
  }).catch(() => undefined);
  for (const css of LEGACY_OPTIMIZER_ITEM_CSS) {
    await chrome.scripting.removeCSS({target: { tabId }, css}).catch(() => undefined);
  }
}
