/** Read-only, candidate-only checks. Never dispatch beforeunload or copy draft text. */
import { getSettings } from "../shared/storage";

export type WorkProtectionResult = "clear" | "unsavedWork" | "workStateUnknown" | "activeMedia";
export interface WorkCheckOptions { protectUnsavedWork?: boolean; protectMedia?: boolean }
interface WorkFrameResult { state: WorkProtectionResult; childFrameCount: number }

const CHECK_BUDGET_MS = 900;

// Serialized into each frame's isolated world by chrome.scripting; keep this function self-contained.
// Only edits a person made count. Values a page fills in by script, leave-warning listeners that
// analytics libraries register, and search boxes are not drafts: treating them as drafts kept
// almost every real site loaded and Coppice freed no memory.
export function inspectEditableState(options: WorkCheckOptions = {}, includeFrameCount = false): WorkProtectionResult | WorkFrameResult {
  const inspect = (): WorkProtectionResult => {
    if (document.readyState === "loading") return "workStateUnknown";
    const monitor = (globalThis as typeof globalThis & {
      __coppiceWorkProtectionV2?: { read(): "clear" | "unsavedWork"; has(element: Element): boolean }
    }).__coppiceWorkProtectionV2;
    if (options.protectUnsavedWork !== false && monitor?.read() === "unsavedWork") return "unsavedWork";
    if (options.protectMedia !== false && (document.pictureInPictureElement ||
      (window as Window & { documentPictureInPicture?: { window?: Window } }).documentPictureInPicture?.window)) return "activeMedia";
    // User-validity is fallback evidence for old documents; submission can also set it.
    const touched = (element: Element) => element.matches(":user-valid, :user-invalid");
    const isSearch = (element: HTMLInputElement) => element.type === "search" ||
      element.getAttribute("role") === "searchbox" || Boolean(element.closest('[role="search"]')) ||
      (element.form?.method === "get" && /^(q|query|search)$/i.test(element.name));

    const deadline = performance.now() + 40;
    const roots: (Document | ShadowRoot)[] = [document];
    let visited = 0;
    for (let index = 0; index < roots.length; index++) {
      const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT);
      let element: Element | null;
      while ((element = walker.nextNode() as Element | null)) {
        if (++visited > 30_000 || (visited % 100 === 0 && performance.now() > deadline)) return "workStateUnknown";
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (options.protectMedia !== false && element instanceof HTMLMediaElement &&
          !element.paused && !element.ended && element.readyState >= 2) return "activeMedia";
        if (options.protectUnsavedWork === false || monitor?.has(element)) continue;
        if (element instanceof HTMLInputElement) {
          if (element.disabled || element.readOnly || isSearch(element) ||
            ["hidden", "button", "submit", "reset", "image"].includes(element.type)) continue;
          const edited = element.type === "checkbox" || element.type === "radio"
            ? element.checked !== element.defaultChecked
            : element.type === "file" ? Boolean(element.files?.length)
            : element.value !== element.defaultValue;
          if (edited && touched(element)) return "unsavedWork";
        } else if (element instanceof HTMLTextAreaElement) {
          if (!element.disabled && !element.readOnly && element.value !== element.defaultValue &&
            touched(element)) return "unsavedWork";
        } else if (element instanceof HTMLSelectElement) {
          // Only user-interacted controls participate; untouched script-chosen defaults are ignored.
          const options = [...element.options];
          const multiple = element.multiple;
          const hasDefault = options.some(option => option.defaultSelected);
          if (!element.disabled && touched(element) && options.some((option, index) =>
            option.selected !== (hasDefault ? option.defaultSelected : !multiple && index === 0))) return "unsavedWork";
        }
      }
    }
    // Existing rich-editor text is not evidence of an edit. The event monitor retains actual
    // edits after blur, including React controlled inputs and changes that delete all text.
    return "clear";
  };
  const state = inspect();
  return includeFrameCount ? { state, childFrameCount: window.length } : state;
}

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Work protection check timed out")), Math.max(1, milliseconds));
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Inspects every frame Coppice may script, in an isolated world. It needs website access
 * (granted in Settings or Page Optimizer); without it, or on pages Chrome does not allow, the result is
 * "workStateUnknown". No debugger is attached, so Chrome shows no debugging banner.
 */
export async function checkUnsavedWork(tabId: number, options: WorkCheckOptions = {}): Promise<WorkProtectionResult> {
  const scripting = (chrome as unknown as { scripting?: typeof chrome.scripting }).scripting;
  if (!scripting?.executeScript) return "workStateUnknown";
  try {
    const results = await bounded(scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      // Run as soon as each frame exists instead of waiting for slow ad frames to go idle.
      injectImmediately: true,
      func: inspectEditableState,
      args: [options, true]
    }), CHECK_BUDGET_MS);
    if (!Array.isArray(results) || !results.length) return "workStateUnknown";
    if (!results.some(result => result.frameId === 0) || new Set(results.map(result => result.frameId)).size !== results.length) return "workStateUnknown";
    const frames = results.map(result => result.result as WorkFrameResult | undefined);
    if (frames.some(frame => frame?.state === "unsavedWork")) return "unsavedWork";
    if (frames.some(frame => frame?.state === "activeMedia")) return "activeMedia";
    // allFrames can omit an origin the extension cannot access. A clean parent is not
    // proof that a nested editor is clean; verify full frame-tree coverage independently.
    if (!frames.every(frame => frame?.state === "clear" && Number.isInteger(frame.childFrameCount) && frame.childFrameCount >= 0)) return "workStateUnknown";
    if (frames.reduce((sum, frame) => sum + (frame?.childFrameCount ?? 0), 0) !== results.length - 1) return "workStateUnknown";
    return "clear";
  } catch {
    return "workStateUnknown";
  }
}

const MONITOR_ID = "coppice-work-protection-v2";
const MONITOR_FILE = "src/content/workProtection.js";
let reconciliation: Promise<void> = Promise.resolve();

/** Register only on granted origins, independently of Page Optimizer. No host access is requested here. */
export async function reconcileWorkProtection(): Promise<void> {
  const run = async () => {
    if (!chrome.scripting?.getRegisteredContentScripts || !chrome.permissions?.getAll) return;
    const [settings, permissions, registered] = await Promise.all([
      getSettings(), chrome.permissions.getAll(), chrome.scripting.getRegisteredContentScripts({ ids: [MONITOR_ID] })
    ]);
    const matches = [...new Set((permissions.origins ?? []).flatMap(origin => origin === "<all_urls>"
      ? ["http://*/*", "https://*/*"] : /^(https?|\*):\/\//.test(origin) ? [origin] : []))].sort();
    const enabled = settings.protectUnsavedWork && matches.length > 0;
    const registrationMatches = enabled && registered.length === 1 &&
      JSON.stringify([...registered[0].matches].sort()) === JSON.stringify(matches);
    if (registered.length && !registrationMatches) await chrome.scripting.unregisterContentScripts({ ids: [MONITOR_ID] });
    if (enabled && !registrationMatches) await chrome.scripting.registerContentScripts([{
      id: MONITOR_ID, js: [MONITOR_FILE], matches, allFrames: true, runAt: "document_start",
      world: "ISOLATED", persistAcrossSessions: true, matchOriginAsFallback: true
    }]);
    // Worker restarts must not rescan/inject all of a person's open pages. Session storage
    // survives worker suspension, but clears when the extension/browser is restarted.
    const revision = JSON.stringify({ version: 2, enabled, matches });
    const session = await chrome.storage.session.get("workProtectionMonitorRevision");
    if (session.workProtectionMonitorRevision === revision) return;
    const tabs = await chrome.tabs.query({});
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, tabs.length) }, async () => {
      while (index < tabs.length) {
        const tab = tabs[index++];
        if (tab.id == null || tab.discarded || !/^https?:/.test(tab.url ?? "")) continue;
        try {
          const target = { tabId: tab.id, allFrames: true };
          if (enabled) await bounded(chrome.scripting.executeScript({ target, files: [MONITOR_FILE], injectImmediately: true }), CHECK_BUDGET_MS);
          else await bounded(chrome.scripting.executeScript({ target, func: () => {
            (globalThis as typeof globalThis & { __coppiceWorkProtectionV2?: { dispose(): void } }).__coppiceWorkProtectionV2?.dispose();
          } }), CHECK_BUDGET_MS);
        } catch { /* Denied origins are not instrumented; candidate checks report unavailable. */ }
      }
    }));
    await chrome.storage.session.set({ workProtectionMonitorRevision: revision });
  };
  const next = reconciliation.then(run, run);
  reconciliation = next.catch(() => undefined);
  await next;
}
