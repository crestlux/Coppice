/** Runs in the isolated world; no imports or external closures are available. */
export function installOptimizerCleanupBridge(): void {
  type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => void;
  const host = globalThis as typeof globalThis & {
    __coppiceOptimizerCleanup?: { api: typeof chrome.runtime; listener: Listener; restore?: () => void };
    __coppicePageOptimizerV1?: { stop(): void };
    __coppiceAiConversationOptimizerV2?: { stop(): void };
  };
  const cleanupEvent = "coppice.restoreOptimizer";
  const api = chrome.runtime;
  const previous = host.__coppiceOptimizerCleanup;
  if (previous?.api === api) return;
  // Chrome can invalidate the old extension context while its page globals
  // remain. Never reuse a listener bound to that expired runtime API object.
  try { previous?.api.onMessage.removeListener(previous.listener); } catch { /* Expired context. */ }
  // DOM events reach the previous isolated world after Chrome invalidates its
  // extension API. The event can only restore rendering, never access data.
  window.dispatchEvent(new Event(cleanupEvent));
  const restore = (): void => {
    try { host.__coppicePageOptimizerV1?.stop(); } catch { /* Continue restoring the AI runtime. */ }
    delete host.__coppicePageOptimizerV1;
    try { host.__coppiceAiConversationOptimizerV2?.stop(); } catch { /* Expired runtime. */ }
    delete host.__coppiceAiConversationOptimizerV2;
    try { api.onMessage.removeListener(listener); } catch { /* Expired extension API. */ }
    window.removeEventListener(cleanupEvent, restore);
    delete host.__coppiceOptimizerCleanup;
  };
  const listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void): void => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== "object" ||
        !("type" in message) || message.type !== "coppice.restoreOptimizer") return;
    // Message delivery to an existing content script does not need a fresh
    // host grant. This still works when Chrome denies new script injection.
    restore();
    respond({ restored: true });
  };
  api.onMessage.addListener(listener);
  window.addEventListener(cleanupEvent, restore);
  host.__coppiceOptimizerCleanup = { api, listener, restore };
}

/** Reaches cleanup listeners left in an invalidated isolated world after reload. */
export function restoreOptimizerInPage(): void {
  window.dispatchEvent(new Event("coppice.restoreOptimizer"));
}
