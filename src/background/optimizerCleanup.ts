/** Runs in the isolated world; no imports or external closures are available. */
export function installOptimizerCleanupBridge(): void {
  type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => void;
  const host = globalThis as typeof globalThis & {
    __resourceGovernorOptimizerCleanup?: { api: typeof chrome.runtime; listener: Listener };
    __resourceGovernorPageOptimizerV1?: { stop(): void };
    __resourceGovernorAiConversationOptimizerV2?: { stop(): void };
  };
  const previous = host.__resourceGovernorOptimizerCleanup;
  if (previous?.api === chrome.runtime) return;
  // Chrome can invalidate the old extension context while its page globals
  // remain. Never reuse a listener bound to that expired runtime API object.
  try { previous?.api.onMessage.removeListener(previous.listener); } catch { /* Expired context. */ }
  const listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void): void => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== "object" ||
        !("type" in message) || message.type !== "resourceGovernor.restoreOptimizer") return;
    // Message delivery to an existing content script does not need a fresh
    // host grant. This still works when Chrome denies new script injection.
    host.__resourceGovernorPageOptimizerV1?.stop();
    delete host.__resourceGovernorPageOptimizerV1;
    host.__resourceGovernorAiConversationOptimizerV2?.stop();
    delete host.__resourceGovernorAiConversationOptimizerV2;
    chrome.runtime.onMessage.removeListener(listener);
    delete host.__resourceGovernorOptimizerCleanup;
    respond({ restored: true });
  };
  chrome.runtime.onMessage.addListener(listener);
  host.__resourceGovernorOptimizerCleanup = { api: chrome.runtime, listener };
}
