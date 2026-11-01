import type { AiConversationOptimizerMetrics } from "../shared/types";

export const AI_CONVERSATION_OPTIMIZER_CSS = `
@supports (content-visibility: auto) {
  [data-coppice-ai-turn="optimized"] {
    content-visibility: auto !important;
    contain-intrinsic-block-size: auto var(--coppice-ai-turn-size, 720px) !important;
  }
}
`;

type AiConversationRuntimeCommand = "install" | "remove" | "probe";

/**
 * Runs in the extension's isolated world. Keep this function self-contained:
 * chrome.scripting.executeScript serializes it without module scope.
 */
export function runAiConversationOptimizerInPage(
  command: AiConversationRuntimeCommand
): AiConversationOptimizerMetrics {
  const runtimeKey = "__coppiceAiConversationOptimizerV2";
  const turnAttribute = "data-coppice-ai-turn";
  const candidateAttribute = "data-coppice-ai-candidate";
  const turnSizeProperty = "--coppice-ai-turn-size";
  const runtimeAttribute = "data-coppice-ai-runtime";
  const providerAttribute = "data-coppice-ai-provider";
  const detectedAttribute = "data-coppice-ai-detected";
  const recentAttribute = "data-coppice-ai-recent";
  const excludedAttribute = "data-coppice-ai-excluded";
  const strategyAttribute = "data-coppice-ai-strategy";
  const sectionAttribute = "data-coppice-ai-section";
  const root = document.documentElement;
  const runtimeGlobal = globalThis as typeof globalThis & {
    [runtimeKey]?: {
      refresh: () => void;
      stop: () => void;
      probe?: () => AiConversationOptimizerMetrics;
      exportSkipStates?: () => Array<[HTMLElement, boolean]>;
    };
  };

  type Provider = AiConversationOptimizerMetrics["provider"];
  type Discovery = {
    provider: Provider;
    providerLabel: string;
    supported: boolean;
    strategy?: string;
    candidates: HTMLElement[];
    recentReserve: number;
  };

  const providerForPage = (): Pick<Discovery, "provider" | "providerLabel" | "supported"> => {
    const hostname = location.hostname.toLowerCase();
    if (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com") {
      return { provider: "chatgpt", providerLabel: "ChatGPT", supported: true };
    }
    if (hostname === "gemini.google.com") {
      return { provider: "gemini", providerLabel: "Gemini", supported: true };
    }
    if (hostname === "claude.ai" || hostname.endsWith(".claude.ai")) {
      return { provider: "claude", providerLabel: "Claude", supported: true };
    }
    return { provider: "unsupported", providerLabel: "This page", supported: false };
  };

  const elementsFor = (selector: string): HTMLElement[] => {
    try {
      return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => {
        if (!element.isConnected) return false;
        if (element.closest("nav, aside, header, footer, dialog")) return false;
        // Do not flatten a whole transcript into strings on every discovery.
        const hasContent = element.childElementCount > 0 || Boolean(element.firstChild?.textContent?.trim());
        return hasContent && element.getClientRects().length > 0;
      });
    } catch {
      return [];
    }
  };

  const firstStrategy = (
    strategies: Array<{ name: string; selector: string; minimum?: number; recentReserve?: number }>
  ): Pick<Discovery, "strategy" | "candidates" | "recentReserve"> => {
    const containmentRoot = (element: HTMLElement): HTMLElement => {
      const display = getComputedStyle(element).display;
      if (display !== "inline" && display !== "contents") return element;

      const elementHeight = element.getBoundingClientRect().height;
      const blockChild = [...element.children]
        .filter((child): child is HTMLElement => child instanceof HTMLElement)
        .find(child => {
          const childDisplay = getComputedStyle(child).display;
          if (childDisplay === "inline" || childDisplay === "contents" || child.getClientRects().length === 0) {
            return false;
          }
          return child.getBoundingClientRect().height >= Math.max(1, elementHeight * 0.5);
        });
      return blockChild ?? element;
    };

    const fallback = [
      { name: "semantic-message-turns", selector: 'main [data-message-author-role], main [data-testid^="conversation-turn"], main [data-conversation-role="user"], main [data-conversation-role="assistant"]', minimum: 4, recentReserve: 2 },
      { name: "semantic-conversation-log", selector: '[role="log"] > [role="listitem"], [role="log"] > article, [role="log"] > div', minimum: 4, recentReserve: 2 }
    ];
    for (const strategy of [...strategies, ...fallback]) {
      // A prefix cap silently abandoned the tail of chats over 1,000 messages.
      // Containment is now processed in bounded batches instead.
      const found = [...new Set(elementsFor(strategy.selector).map(containmentRoot))];
      const foundSet = new Set(found);
      const candidates = found.filter(element => {
        let parent = element.parentElement;
        while (parent) { if (foundSet.has(parent)) return false; parent = parent.parentElement; }
        return true;
      });
      if (candidates.length >= (strategy.minimum ?? 1)) {
        return {
          strategy: strategy.name,
          candidates,
          recentReserve: strategy.recentReserve ?? 2
        };
      }
    }
    return { candidates: [], recentReserve: 2 };
  };

  const discover = (): Discovery => {
    const provider = providerForPage();
    if (!provider.supported) {
      const generic = firstStrategy([
        { name: "semantic-message-turns", selector: 'main [data-message-author-role], [role="log"] [data-message-author-role], main [data-testid^="conversation-turn"]', minimum: 4 },
        { name: "semantic-conversation-log", selector: '[role="log"] > [role="listitem"], [role="log"] > article, [role="log"] > div', minimum: 4 }
      ]);
      const supported = generic.candidates.length >= 4;
      return { ...generic, provider: supported ? "generic" : "unsupported", providerLabel: "Conversation", supported };
    }

    if (provider.provider === "chatgpt") {
      return {
        ...provider,
        ...firstStrategy([
          {
            name: "chatgpt-keyed-turns",
            selector: 'main [data-turn-key], [data-thread-find-target="conversation"] [data-turn-key]',
            recentReserve: 2
          },
          {
            name: "chatgpt-conversation-roles",
            selector: 'main [data-conversation-role="user"], main [data-conversation-role="assistant"]',
            recentReserve: 2
          },
          {
            name: "chatgpt-semantic-list",
            selector:
              'main[aria-label="ChatGPT"] ol[aria-label^="Conversation"] > li[class*="messageTurn"]',
            recentReserve: 2
          },
          {
            name: "chatgpt-conversation-region",
            selector: '[role="region"][aria-label="Conversation"] ol > li[id]',
            recentReserve: 2
          },
          {
            name: "chatgpt-testid-turns",
            selector: 'main [data-testid^="conversation-turn"]',
            recentReserve: 2
          },
          {
            name: "chatgpt-role-messages",
            selector: "main [data-message-author-role]",
            recentReserve: 2
          }
        ])
      };
    }

    if (provider.provider === "gemini") {
      return {
        ...provider,
        ...firstStrategy([
          {
            name: "gemini-shared-turns",
            selector: "main share-turn-viewer",
            minimum: 2,
            recentReserve: 1
          },
          {
            name: "gemini-chat-window-turns",
            selector: "chat-window .conversation-container",
            minimum: 2,
            recentReserve: 1
          },
          {
            name: "gemini-scroller-turns",
            selector: "infinite-scroller .conversation-container",
            minimum: 2,
            recentReserve: 1
          },
          {
            name: "gemini-main-turns",
            selector: "main .conversation-container",
            minimum: 2,
            recentReserve: 1
          },
          {
            name: "gemini-message-elements",
            selector: "main user-query, main model-response, main response-container",
            minimum: 2,
            recentReserve: 2
          },
          {
            name: "gemini-message-testids",
            selector:
              'main [data-test-id="user-query"], main [data-test-id="model-response"], main [data-testid="user-query"], main [data-testid="model-response"]',
            minimum: 2,
            recentReserve: 2
          }
        ])
      };
    }

    return {
      ...provider,
      ...firstStrategy([
        {
          name: "claude-testid-turns",
          selector: 'main [data-testid^="conversation-turn"], main [data-testid*="conversation-turn"]',
          minimum: 2,
          recentReserve: 2
        },
        {
          name: "claude-transcript-rows",
          selector:
            '[data-testid="transcript-list"] [class~="group"][class*="group/message-row"]:not([class*="ms-auto"])',
          minimum: 2,
          recentReserve: 2
        },
        {
          name: "claude-transcript-messages",
          selector:
            '[data-testid="transcript-list"] [data-testid="user-message"], [data-testid="transcript-list"] .font-claude-response',
          minimum: 2,
          recentReserve: 2
        },
        {
          name: "claude-message-elements",
          selector: 'main [data-testid="user-message"], main .font-claude-response',
          minimum: 2,
          recentReserve: 2
        },
        {
          name: "claude-rendered-messages",
          selector: 'main [data-testid="user-message"], main [data-test-render-count]',
          minimum: 2,
          recentReserve: 2
        }
      ])
    };
  };

  const isSafetyExcluded = (element: HTMLElement): boolean => {
    if (element.closest('dialog,[role="dialog"],[contenteditable]:not([contenteditable="false"])') ||
        element.querySelector('textarea,input,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return true;
    const activeElement = document.activeElement;
    if (activeElement && activeElement !== document.body && element.contains(activeElement)) return true;

    const selection = document.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      selection.containsNode(element, true)
    ) {
      return true;
    }

    // Site-owned virtual lists and embedded editors keep their own sizing and
    // lifecycle. Adding a second outer cache can defeat their scroll anchors.
    if (element.closest('[data-virtualized-turn-content],[data-virtualizer]') ||
        element.querySelector('[data-virtualized-turn-content],[data-virtualizer],iframe,canvas,[style*="position: sticky"],[style*="position: fixed"],[style*="position: absolute"]')) return true;

    if (
      element.closest('[aria-busy="true"], [data-is-streaming="true"], [data-streaming="true"]') ||
      element.querySelector('[aria-busy="true"], [data-is-streaming="true"], [data-streaming="true"]')
    ) {
      return true;
    }

    return [...element.querySelectorAll<HTMLMediaElement>("audio, video")].some(media => !media.paused);
  };

  const clearRootState = (): void => {
    root.removeAttribute(runtimeAttribute);
    root.removeAttribute(providerAttribute);
    root.removeAttribute(detectedAttribute);
    root.removeAttribute(recentAttribute);
    root.removeAttribute(excludedAttribute);
    root.removeAttribute(strategyAttribute);
  };

  const clearTurnMarkers = (): void => {
    for (const element of document.querySelectorAll("[" + sectionAttribute + "]")) element.removeAttribute(sectionAttribute);
    for (const element of document.querySelectorAll("[" + candidateAttribute + "]")) element.removeAttribute(candidateAttribute);
    for (const element of document.querySelectorAll<HTMLElement>(`[${turnAttribute}]`)) {
      element.removeAttribute(turnAttribute);
      element.style.removeProperty(turnSizeProperty);
    }
  };

  const ownStyleValues = new WeakMap<HTMLElement, string>();
  let sectionOwners = new Map<HTMLElement, HTMLElement>();
  let turnSections = new Map<HTMLElement, HTMLElement[]>();
  const skippedStates = new WeakMap<HTMLElement, boolean>();
  const inheritedSkipStates = new WeakMap<HTMLElement, boolean>();
  const verifiedCss = new WeakSet<HTMLElement>();
  const longTurnThreshold = Math.max(4800, innerHeight * 4);
  const blockSelector = 'p,h1,h2,h3,h4,pre,blockquote,ul,ol,table,figure';
  function sectionsForTurn(turn: HTMLElement): HTMLElement[] {
    if (turn.getBoundingClientRect().height < longTurnThreshold ||
        turn.closest('[data-virtualized-turn-content],[data-virtualizer]') ||
        turn.querySelector('[data-virtualized-turn-content],[data-virtualizer]')) return [];
    const turnStyle = getComputedStyle(turn);
    if (!turn.hasAttribute(turnAttribute) && (turnStyle.contentVisibility !== 'visible' || turnStyle.contain !== 'none')) return [];
    // Use existing block boundaries, never wrap or move framework-owned DOM.
    // Parent and grandparent groups cover both plain markdown and wrapped blocks.
    const parents = new Set<HTMLElement>();
    const checkedParents = new Set<HTMLElement>();
    for (const block of turn.querySelectorAll<HTMLElement>(blockSelector)) {
      for (const parent of [block.parentElement, block.parentElement?.parentElement]) {
        if (!parent || checkedParents.has(parent)) continue;
        checkedParents.add(parent);
        if (parent && turn.contains(parent) && parent.childElementCount >= 8 &&
            !parent.matches('ul,ol,table,thead,tbody,tr,pre,blockquote') &&
            !parent.closest('nav,aside,header,footer,button,[role="button"],table,pre,[contenteditable]:not([contenteditable="false"])')) parents.add(parent);
      }
    }
    const groups = [...parents];
    const roots = groups.filter(parent => !groups.some(other => other !== parent && other.contains(parent)));
    const sections = roots.flatMap(parent => [...parent.children].filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches('p,div,section,article,ul,ol,pre,blockquote,figure,table,h1,h2,h3,h4') &&
      (child.matches(blockSelector) || Boolean(child.querySelector(blockSelector)))));
    return sections.length >= 8 ? sections : [];
  }
  const unmarkTurn = (element: HTMLElement): void => {
    if (!element.hasAttribute(turnAttribute)) return;
    element.removeAttribute(turnAttribute);
    element.style.removeProperty(turnSizeProperty);
    skippedStates.delete(element);
    verifiedCss.delete(element);
    ownStyleValues.set(element, element.getAttribute("style") ?? "");
  };

  let scrollRootCache = new WeakMap<HTMLElement, HTMLElement | null>();
  const scrollRootFor = (element: HTMLElement): HTMLElement | null => {
    // Cache the nearest scrolling ancestor including each shared wrapper.
    // Thousands of sibling blocks must not each walk the same deep chat shell.
    const visited: HTMLElement[] = [];
    let scrollRoot: HTMLElement | null = null;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.scrollingElement) break;
      if (scrollRootCache.has(parent)) { scrollRoot = scrollRootCache.get(parent) ?? null; break; }
      visited.push(parent);
      if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) {
        scrollRoot = parent;
        break;
      }
    }
    for (const ancestor of visited) scrollRootCache.set(ancestor, scrollRoot);
    return scrollRoot;
  };
  const viewportFor = (element: HTMLElement): { top: number; bottom: number } => {
    const scrollRoot = scrollRootFor(element);
    if (!scrollRoot) return { top: 0, bottom: innerHeight };
    const top = scrollRoot.getBoundingClientRect().top + scrollRoot.clientTop;
    return { top, bottom: top + scrollRoot.clientHeight };
  };

  const hasCollapsingEdges = (element: HTMLElement, computed: CSSStyleDeclaration): boolean => {
    const parentDisplay = element.parentElement ? getComputedStyle(element.parentElement).display : "";
    const independent = /flex|grid|flow-root|inline-block/.test(computed.display) || /flex|grid/.test(parentDisplay) ||
      computed.cssFloat !== "none" || /auto|scroll|hidden/.test(computed.overflowX + computed.overflowY);
    if (independent) return false;
    for (const [child, side] of [[element.firstElementChild, "Top"], [element.lastElementChild, "Bottom"]] as const) {
      if (!child) continue;
      const childStyle = getComputedStyle(child);
      if (childStyle.display === "none" || childStyle.display === "inline" || ["absolute", "fixed"].includes(childStyle.position)) continue;
      const inset = (parseFloat(computed[("padding" + side) as keyof CSSStyleDeclaration] as string) || 0) +
        (parseFloat(computed[("border" + side + "Width") as keyof CSSStyleDeclaration] as string) || 0);
      const margin = parseFloat(childStyle[("margin" + side) as keyof CSSStyleDeclaration] as string) || 0;
      if (inset === 0 && Math.abs(margin) > 0.1) return true;
    }
    return false;
  };

  const unstable = new WeakSet<HTMLElement>();
  const descendantLayouts = new WeakMap<HTMLElement, boolean>();
  const hasPositionedDescendants = (element: HTMLElement): boolean => {
    const cached = descendantLayouts.get(element);
    if (cached !== undefined) return cached;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
    let checked = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Bound a single turn's work. Larger documents are optimized through
      // their existing sections; a huge indivisible subtree stays native.
      if (++checked > 1024 || ["absolute", "fixed", "sticky"].includes(getComputedStyle(node as Element).position)) {
        descendantLayouts.set(element, true);
        return true;
      }
    }
    descendantLayouts.set(element, false);
    return false;
  };
  const retryBatchLimits = new WeakMap<HTMLElement, number>();
  const measuredSizes = new WeakMap<HTMLElement, { width: number; height: number }>();
  type TurnPlan = { element: HTMLElement; before: DOMRect; measuredHeight: number; scrollRoot: HTMLElement; scrollHeight: number; scrollWidth: number; scrollTop: number; scrollLeft: number };
  const prepareTurn = (element: HTMLElement): TurnPlan | undefined => {
    if (element.hasAttribute(turnAttribute) || unstable.has(element) || !element.isConnected) return;
    const before = element.getBoundingClientRect();
    const viewport = viewportFor(element);
    if (before.bottom >= viewport.top - 800 && before.top <= viewport.bottom + 800) return;
    const scrollRoot = scrollRootFor(element) ?? document.documentElement;
    const scrollHeight = scrollRoot.scrollHeight;
    const scrollWidth = scrollRoot.scrollWidth;
    if (before.height <= 0) return;
    const style = getComputedStyle(element);
    // Do not layer another size cache onto site-managed virtualization/layout.
    if (style.contentVisibility !== "visible" || style.contain !== "none" ||
        style.writingMode !== "horizontal-tb" || style.transform !== "none" ||
        !["static", "relative"].includes(style.position) || style.display.startsWith("inline") ||
        style.display.startsWith("table") || style.display === "contents") return;
    if (hasCollapsingEdges(element, style)) return;
    // A class or stylesheet can position a descendant without any inline style.
    // Containment can move/clip it without changing the outer turn dimensions.
    if (hasPositionedDescendants(element)) return;
    const padding = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
    const measuredHeight = Math.max(1, before.height - padding);
    return { element, before, measuredHeight, scrollRoot, scrollHeight, scrollWidth, scrollTop: scrollRoot.scrollTop, scrollLeft: scrollRoot.scrollLeft };
  };
  const applyTurns = (plans: TurnPlan[]): void => {
    if (!plans.length) return;
    // Read -> write -> verify the whole small batch, never force layout once
    // per message. Retain the geometry rollback guard for third-party layouts.
    for (const { element, before, measuredHeight } of plans) {
      element.style.setProperty(turnSizeProperty, measuredHeight + "px");
      ownStyleValues.set(element, element.getAttribute("style") ?? "");
      measuredSizes.set(element, { width: before.width, height: before.height });
      element.setAttribute(turnAttribute, "optimized");
    }
    const invalid = plans.some(({ element, before, scrollRoot, scrollHeight, scrollWidth, scrollTop, scrollLeft }) => {
      const after = element.getBoundingClientRect();
      return Math.abs(after.height - before.height) > 0.1 || Math.abs(after.top - before.top) > 0.1 ||
        Math.abs(after.left - before.left) > 0.1 || Math.abs(after.width - before.width) > 0.1 ||
        scrollRoot.scrollHeight !== scrollHeight || scrollRoot.scrollWidth !== scrollWidth ||
        scrollRoot.scrollTop !== scrollTop || scrollRoot.scrollLeft !== scrollLeft;
    });
    for (const { element } of plans) {
      if (!invalid) {
        retryBatchLimits.delete(element);
        if (getComputedStyle(element).contentVisibility === 'auto') verifiedCss.add(element);
        if (!skippedStates.has(element) && inheritedSkipStates.has(element)) skippedStates.set(element, inheritedSkipStates.get(element)!);
        continue;
      }
      unmarkTurn(element);
      // One unusual block must not permanently disqualify every safe neighbour.
      // Retry smaller groups on later frames; only an individually failing
      // boundary is rejected. Each retry still passes the geometry guard.
      if (plans.length > 1) {
        retryBatchLimits.set(element, Math.max(1, Math.floor(plans.length / 2)));
        pendingTurns.add(element);
      } else { retryBatchLimits.delete(element); unstable.add(element); }
    }
    if (invalid) {
      // A briefly smaller scroll range can clamp the current position. Undo
      // that clamp in the same task as the rejected layout change.
      const restored = new Set<HTMLElement>();
      for (const { scrollRoot, scrollTop, scrollLeft } of plans) if (!restored.has(scrollRoot)) {
        restored.add(scrollRoot);
        scrollRoot.scrollTo({ top: scrollTop, left: scrollLeft, behavior: 'instant' });
      }
    }
  };

  const metrics = (fallbackDiscovery?: Discovery): AiConversationOptimizerMetrics => {
    const discovery = fallbackDiscovery ?? discover();
    const marked = [...document.querySelectorAll<HTMLElement>(`[${turnAttribute}="optimized"]`)];
    const optimizedOwners = new Set<HTMLElement>();
    const cssOwners = new Set<HTMLElement>();
    const offscreenOwners = new Set<HTMLElement>();
    const skippedOwners = new Set<HTMLElement>();
    let optimizedSectionCount = 0;
    let skippedSectionCount = 0;
    let skipMeasurementSupported = false;

    for (const element of marked) {
      const owner = sectionOwners.get(element) ?? element;
      optimizedOwners.add(owner);
      const section = sectionOwners.has(element);
      if (section) optimizedSectionCount += 1;
      // Polling status must never synchronously lay out thousands of hidden
      // math/markdown subtrees. CSS is verified at application; native events
      // report skipping. Offscreen count is a conservative skipped lower bound.
      if (verifiedCss.has(element)) cssOwners.add(owner);
      if ('oncontentvisibilityautostatechange' in element) skipMeasurementSupported = true;
      if (skippedStates.get(element) === true) {
        offscreenOwners.add(owner);
        skippedOwners.add(owner);
        if (section) skippedSectionCount += 1;
      }
    }

    const detectedFromRuntime = Number.parseInt(root.getAttribute(detectedAttribute) ?? "", 10);
    const recentFromRuntime = Number.parseInt(root.getAttribute(recentAttribute) ?? "", 10);
    const excludedFromRuntime = Number.parseInt(root.getAttribute(excludedAttribute) ?? "", 10);
    const runtimeProvider = root.getAttribute(providerAttribute) as Provider | null;
    const provider = runtimeProvider ?? discovery.provider;
    const providerLabel =
      provider === "chatgpt"
        ? "ChatGPT"
        : provider === "gemini"
          ? "Gemini"
          : provider === "claude"
            ? "Claude"
            : provider === "generic" ? "Conversation" : "This page";

    return {
      provider,
      providerLabel,
      supported: provider !== "unsupported",
      runtimeActive: root.getAttribute(runtimeAttribute) === "2",
      strategy: root.getAttribute(strategyAttribute) ?? discovery.strategy,
      detectedTurnCount: Number.isFinite(detectedFromRuntime)
        ? detectedFromRuntime
        : discovery.candidates.length,
      optimizedTurnCount: optimizedOwners.size,
      cssAppliedTurnCount: cssOwners.size,
      offscreenTurnCount: offscreenOwners.size,
      skippedTurnCount: skippedOwners.size,
      detectedSectionCount: sectionOwners.size,
      optimizedSectionCount,
      skippedSectionCount,
      skipMeasurementSupported,
      recentTurnCount: Number.isFinite(recentFromRuntime)
        ? recentFromRuntime
        : Math.min(discovery.recentReserve, discovery.candidates.length),
      excludedTurnCount: Number.isFinite(excludedFromRuntime) ? excludedFromRuntime : 0
    };
  };

  if (command === "remove") {
    runtimeGlobal[runtimeKey]?.stop();
    delete runtimeGlobal[runtimeKey];
    clearTurnMarkers();
    clearRootState();
    return metrics();
  }

  if (command === "probe") {
    return runtimeGlobal[runtimeKey]?.probe?.() ?? metrics();
  }

  // Reinstallation can remove and reapply CSS in the same frame. Chromium then
  // retains its skip state without emitting a new initial transition event.
  for (const [element, skipped] of runtimeGlobal[runtimeKey]?.exportSkipStates?.() ?? []) inheritedSkipStates.set(element, skipped);
  runtimeGlobal[runtimeKey]?.stop();
  clearTurnMarkers();
  clearRootState();

  let lastDiscovery = discover();
  let observed = new Set<HTMLElement>();
  let knownCandidates = new Set<HTMLElement>();
  const excluded = new Set<HTMLElement>();
  const pendingTurns = new Set<HTMLElement>();
  const quietTurns = new Map<HTMLElement, number>();
  const changeHistory = new WeakMap<HTMLElement, number>();
  const interactionProtected = new Set<HTMLElement>();
  let mutationTimer: number | undefined;
  let quietTimer: number | undefined;
  let workFrame: number | undefined;
  let hiddenWorkTimer: number | undefined;
  let stopped = false;
  let printing = false;

  // Only queued optimizer work is delayed. Focus/selection, changed content and
  // restoration keep their synchronous safety path. No page LongTask is blamed
  // on this runtime: the budget measures our own discovery and layout batches.
  type WorkKind = "discovery" | "rendering";
  const workBudgets = {
    discovery: { started: performance.now(), spent: 0, until: 0, backoffs: 0 },
    rendering: { started: performance.now(), spent: 0, until: 0, backoffs: 0 }
  };
  let workDurationMs = 0;
  let inputUntil = 0;
  let composingUntil = 0;
  const scrolling = new Map<EventTarget, number>();
  const activityEvents = ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "focusout", "scroll", "scrollend"];
  const onActivity = (event: Event): void => {
    const now = performance.now();
    if (event.type === "scroll") {
      // scroll does no layout work. Native scrollend resumes work promptly; the
      // finite expiry also handles removed scrollers and missing scrollend.
      if (event.target) scrolling.set(event.target, now + ("onscrollend" in document ? 800 : 180));
    } else if (event.type === "scrollend") {
      if (event.target) scrolling.delete(event.target);
    } else if (event.type === "focusout") {
      composingUntil = 0;
    } else {
      inputUntil = now + 180;
      if (event.type.startsWith("composition")) composingUntil = event.type === "compositionend" ? 0 : now + 2000;
      else if ((event as InputEvent).isComposing) composingUntil = now + 2000;
    }
  };
  const interactionDelay = (): number => {
    const now = performance.now();
    let remaining = Math.max(inputUntil, composingUntil) - now;
    for (const [target, until] of scrolling) {
      if (until <= now || (target instanceof Node && !target.isConnected)) scrolling.delete(target);
      else remaining = Math.max(remaining, until - now);
    }
    return Math.max(0, remaining);
  };
  const workDelay = (kind: WorkKind): number =>
    Math.ceil(Math.max(interactionDelay(), workBudgets[kind].until - performance.now(), 0));
  const recordWork = (kind: WorkKind, started: number): number => {
    const now = performance.now(), duration = Math.max(0, now - started);
    workDurationMs += duration;
    const budget = workBudgets[kind];
    if (now - budget.started >= 1000) { budget.started = now; budget.spent = 0; }
    budget.spent += duration;
    if (duration >= 50 || budget.spent >= (kind === "discovery" ? 80 : 48)) {
      budget.until = now + Math.min(1000, Math.max(250, budget.spent * 8));
      budget.spent = 0;
      budget.started = budget.until;
      budget.backoffs++;
    }
    return duration;
  };
  const workMetrics = () => ({
    interactionDeferred: interactionDelay() > 0,
    workBudgetLimited: Object.values(workBudgets).some(budget => budget.until > performance.now()),
    workBudgetBackoffCount: workBudgets.discovery.backoffs + workBudgets.rendering.backoffs,
    workDurationMs: Math.round(workDurationMs * 100) / 100
  });
  const genericConversationSelector = '[role="log"],[data-message-author-role],[data-testid^="conversation-turn"],[data-conversation-role="user"],[data-conversation-role="assistant"]';
  const namedProvider = providerForPage().supported;
  let discoveryOnly = false;
  let observingMutations = false;
  const conversationSurfaceSelector = namedProvider
    ? 'main,[role="region"],[data-thread-find-target="conversation"],[data-testid="transcript-list"],chat-window,share-viewer,share-landing-page'
    : genericConversationSelector;
  const messageSelector = genericConversationSelector + ',[data-turn-key],[data-content-search-turn-key],share-turn-viewer,.conversation-container,user-query,model-response,[data-testid="user-message"],.font-claude-response,[data-test-render-count]';
  const semanticAttributes = new Set(['role', 'data-message-author-role', 'data-testid', 'data-conversation-role', 'data-turn-key', 'data-thread-find-target']);
  const intersectionObservers = new Map<HTMLElement | null, IntersectionObserver>();
  const observedRoots = new Map<HTMLElement, HTMLElement | null>();
  const candidateWidths = new Map<HTMLElement, number>();
  const candidateHeights = new WeakMap<HTMLElement, number>();

  function publishCounts(): void {
    if (!lastDiscovery.supported) { clearRootState(); return; }
    root.setAttribute(runtimeAttribute, "2");
    root.setAttribute(providerAttribute, lastDiscovery.provider);
    root.setAttribute(detectedAttribute, String(lastDiscovery.candidates.length));
    root.setAttribute(recentAttribute, String(Math.min(lastDiscovery.recentReserve, lastDiscovery.candidates.length)));
    root.setAttribute(excludedAttribute, String(new Set([...excluded].map(element => sectionOwners.get(element) ?? element)).size));
    if (lastDiscovery.strategy) root.setAttribute(strategyAttribute, lastDiscovery.strategy);
  }

  function scheduleWork(): void {
    if (stopped || printing || !pendingTurns.size || workFrame !== undefined || hiddenWorkTimer !== undefined) return;
    // Hidden documents cannot rely on rAF. Both paths are event-driven and stop
    // completely when their finite queue is empty.
    const delay = workDelay("rendering");
    if (document.hidden || delay > 0) hiddenWorkTimer = window.setTimeout(() => { hiddenWorkTimer = undefined; flushWork(); }, delay > 0 ? Math.min(delay, 250) : 50);
    else workFrame = requestAnimationFrame(() => { workFrame = undefined; flushWork(); });
  }
  function queueTurn(element: HTMLElement): void {
    if (!observed.has(element) || quietTurns.has(element) || element.hasAttribute(turnAttribute)) return;
    pendingTurns.add(element);
    scheduleWork();
  }
  function observerFor(scrollRoot: HTMLElement | null): IntersectionObserver {
    let observer = intersectionObservers.get(scrollRoot);
    if (!observer) {
      observer = new IntersectionObserver(entries => {
        if (stopped || printing) return;
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          // Native auto containment renders approaching messages and preserves
          // its size cache. Scrolling must not remove and reapply it.
          if (observed.has(element) && !entry.isIntersecting) queueTurn(element);
        }
      }, { root: scrollRoot, rootMargin: "800px 0px 800px 0px", threshold: 0 });
      intersectionObservers.set(scrollRoot, observer);
    }
    return observer;
  }
  function ensureObservation(element: HTMLElement): void {
    const scrollRoot = scrollRootFor(element);
    if (observedRoots.has(element) && observedRoots.get(element) === scrollRoot) return;
    if (observedRoots.has(element)) intersectionObservers.get(observedRoots.get(element) ?? null)?.unobserve(element);
    observedRoots.set(element, scrollRoot);
    observerFor(scrollRoot).observe(element);
  }
  let workBatchLimit = 48;
  function flushWork(): void {
    if (stopped || printing) return;
    if (workDelay("rendering") > 0) { scheduleWork(); return; }
    const started = performance.now();
    const plans: TurnPlan[] = [];
    let processed = 0;
    let batchLimit = workBatchLimit;
    for (const element of pendingTurns) {
      batchLimit = Math.min(batchLimit, retryBatchLimits.get(element) ?? 48);
      if (plans.length >= batchLimit) break;
      pendingTurns.delete(element);
      if (!element.isConnected || !observed.has(element) || quietTurns.has(element)) continue;
      ensureObservation(element);
      if (isSafetyExcluded(element)) {
        excluded.add(element);
        unmarkTurn(element);
      } else {
        excluded.delete(element);
        const plan = prepareTurn(element);
        if (plan) plans.push(plan);
      }
      // Bound both the number of writes and the discovery/measurement time.
      if (++processed >= 48 || plans.length >= batchLimit || performance.now() - started >= 6) break;
    }
    applyTurns(plans);
    // Once auto containment is installed, Chromium itself renders approaching
    // content. Keeping thousands of duplicate visibility targets is needless
    // work on every subsequent layout. Dirty/resize events re-observe as needed.
    for (const { element } of plans) if (element.hasAttribute(turnAttribute)) {
      intersectionObservers.get(observedRoots.get(element) ?? null)?.unobserve(element);
      observedRoots.delete(element);
    }
    publishCounts();
    const duration = recordWork("rendering", started);
    if (duration > 12) workBatchLimit = Math.max(1, Math.floor(workBatchLimit / 2));
    else if (duration < 4) workBatchLimit = Math.min(48, workBatchLimit + 1);
    scheduleWork();
  }
  function scheduleQuiet(): void {
    if (stopped || !quietTurns.size || quietTimer !== undefined) return;
    const next = Math.min(...quietTurns.values());
    quietTimer = window.setTimeout(() => {
      quietTimer = undefined;
      const now = performance.now();
      for (const [element, deadline] of quietTurns) if (deadline <= now) {
        quietTurns.delete(element);
        queueTurn(element);
      }
      scheduleQuiet();
    }, Math.max(1, next - performance.now()));
  }
  function invalidate(element: HTMLElement, waitForQuiet = true): void {
    unmarkTurn(element);
    unstable.delete(element);
    descendantLayouts.delete(element);
    pendingTurns.delete(element);
    if (!observed.has(element)) return;
    if (waitForQuiet) {
      const now = performance.now();
      const previous = changeHistory.get(element);
      changeHistory.set(element, now);
      // Slow streaming and repeated markdown/math updates can arrive just past
      // a fixed debounce. Do not oscillate between rendering and containment.
      const delay = previous !== undefined && now - previous < 1200 ? 1200 : 250;
      quietTurns.set(element, now + delay);
      scheduleQuiet();
    } else {
      quietTurns.delete(element);
      queueTurn(element);
    }
  }
  function candidateFor(node: Node | null): HTMLElement | undefined {
    let element = node instanceof HTMLElement ? node : node?.parentElement;
    while (element) {
      if (knownCandidates.has(element)) return element;
      element = element.parentElement;
    }
    return undefined;
  }

  const onSkip = (event: Event): void => {
    if (stopped || !(event.target instanceof HTMLElement)) return;
    const element = event.target;
    const skipped = Boolean((event as Event & { skipped?: boolean }).skipped);
    skippedStates.set(element, skipped);
  };
  const resizeObserver = new ResizeObserver(entries => {
    if (stopped || printing) return;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
      const height = entry.borderBoxSize[0]?.blockSize ?? 0;
      const previousHeight = candidateHeights.get(element) ?? 0;
      candidateHeights.set(element, height);
      if (!sectionOwners.has(element) && height >= longTurnThreshold && previousHeight < longTurnThreshold && !turnSections.has(element)) scheduleMutationRefresh();
      const previous = candidateWidths.get(element);
      if (previous === undefined) continue;
      candidateWidths.set(element, width);
      if (Number.isFinite(previous) && Math.abs(width - previous) > 0.1) invalidate(element);
      else if (element.hasAttribute(turnAttribute)) {
        const measured = measuredSizes.get(element);
        if (measured && Math.abs(height - measured.height) > 0.1) {
          unmarkTurn(element); unstable.add(element);
        }
      }
    }
  });

  function forget(element: HTMLElement): void {
    unmarkTurn(element);
    element.removeAttribute(candidateAttribute);
    element.removeAttribute(sectionAttribute);
    element.removeEventListener("contentvisibilityautostatechange", onSkip);
    resizeObserver.unobserve(element);
    intersectionObservers.get(observedRoots.get(element) ?? null)?.unobserve(element);
    observedRoots.delete(element);
    candidateWidths.delete(element);
    changeHistory.delete(element);
    pendingTurns.delete(element);
    quietTurns.delete(element);
    excluded.delete(element);
    interactionProtected.delete(element);
  }
  function refresh(discovery?: Discovery): void {
    if (stopped || printing) return;
    if (!discovery && workDelay("discovery") > 0) { scheduleMutationRefresh(); return; }
    const started = performance.now();
    discovery ??= discover();
    lastDiscovery = discovery;
    const nextSections = new Map<HTMLElement, HTMLElement[]>();
    const nextOwners = new Map<HTMLElement, HTMLElement>();
    const nextCandidates = new Set(discovery.candidates);
    const nextObserved = new Set(discovery.candidates.slice(0, Math.max(0, discovery.candidates.length - discovery.recentReserve)));
    for (const turn of discovery.candidates) {
      const sections = sectionsForTurn(turn);
      if (!sections.length) continue;
      nextSections.set(turn, sections);
      nextObserved.delete(turn);
      for (const section of sections) { nextCandidates.add(section); nextOwners.set(section, turn); }
      // Completed offscreen portions of a huge recent answer are eligible too;
      // its tail, the viewport and any actively changing blocks stay rendered.
      for (const section of sections.slice(0, -2)) nextObserved.add(section);
    }
    for (const element of knownCandidates) if (!nextCandidates.has(element)) forget(element);
    sectionOwners = nextOwners;
    turnSections = nextSections;
    const previouslyObserved = observed;
    observed = nextObserved;
    knownCandidates = nextCandidates;
    const newestFirst = discovery.candidates.slice().reverse().flatMap(turn => [turn, ...(nextSections.get(turn) ?? [])]);
    for (const element of newestFirst) {
      if (!element.hasAttribute(candidateAttribute)) element.setAttribute(candidateAttribute, "true");
      if (sectionOwners.has(element)) element.setAttribute(sectionAttribute, "true");
      if (!candidateWidths.has(element)) {
        // Initial ResizeObserver delivery provides widths without synchronous
        // measurement of every message during installation.
        candidateWidths.set(element, NaN);
        resizeObserver.observe(element, { box: "border-box" });
        element.addEventListener("contentvisibilityautostatechange", onSkip);
      }
      if (nextObserved.has(element) && !previouslyObserved.has(element)) queueTurn(element);
      else if (!nextObserved.has(element)) {
        unmarkTurn(element); pendingTurns.delete(element); quietTurns.delete(element); excluded.delete(element);
        intersectionObservers.get(observedRoots.get(element) ?? null)?.unobserve(element);
        observedRoots.delete(element);
      }
    }
    const usedRoots = new Set(observedRoots.values());
    for (const [scrollRoot, observer] of intersectionObservers) if (!usedRoots.has(scrollRoot)) {
      observer.disconnect(); intersectionObservers.delete(scrollRoot);
    }
    updateMutationObservation();
    publishCounts();
    recordWork("discovery", started);
  }
  function scheduleMutationRefresh(): void {
    if (stopped || printing || mutationTimer !== undefined) return;
    // Leading deadline: continuous streaming cannot postpone discovery forever.
    mutationTimer = window.setTimeout(() => { mutationTimer = undefined; refresh(); }, Math.max(180, Math.min(workDelay("discovery"), 250)));
  }

  const paintOnlyProperties = new Set(['color', 'background-color', 'opacity', 'outline-color', 'border-color',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'caret-color', 'fill', 'stroke']);
  const oldInlineStyle = document.createElement('span').style;
  const newInlineStyle = document.createElement('span').style;
  function paintOnlyChange(before: string | null, after: string | null): boolean {
    oldInlineStyle.cssText = before ?? '';
    newInlineStyle.cssText = after ?? '';
    const properties = new Set([...oldInlineStyle, ...newInlineStyle]);
    for (const name of properties) if (!paintOnlyProperties.has(name) &&
      (oldInlineStyle.getPropertyValue(name) !== newInlineStyle.getPropertyValue(name) ||
       oldInlineStyle.getPropertyPriority(name) !== newInlineStyle.getPropertyPriority(name))) return false;
    return true;
  }

  const mutationObserver = new MutationObserver(records => {
    if (stopped) return;
    if (discoveryOnly) {
      const introduced = records.some(record => record.type === "attributes"
        ? record.target instanceof Element && record.target.matches(genericConversationSelector)
        : [...record.addedNodes].some(node => node instanceof Element &&
          (node.matches(genericConversationSelector) || Boolean(node.firstElementChild && node.querySelector(genericConversationSelector)))));
      if (introduced) { updateMutationObservation(); scheduleMutationRefresh(); }
      return;
    }
    const surfaceRemoved = !namedProvider && records.some(record => record.type === "attributes"
      ? semanticAttributes.has(record.attributeName ?? "")
      : [...record.removedNodes].some(node => node instanceof Element &&
        (node.matches(genericConversationSelector) || Boolean(node.firstElementChild && node.querySelector(genericConversationSelector)))));
    if (surfaceRemoved && !document.querySelector(genericConversationSelector)) { refresh(); return; }

    const changed = new Set<HTMLElement>();
    const ancestors = new Set<Element>();
    const attributes = new Map<Element, Map<string, string | null>>();
    let discoverAgain = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target) continue;
      if (record.type === "attributes") {
        let values = attributes.get(target);
        if (!values) { values = new Map(); attributes.set(target, values); }
        const name = record.attributeName ?? "";
        if (!values.has(name)) values.set(name, record.oldValue);
        continue;
      }
      if (target.matches('style') || [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element && node.matches('style,link[rel="stylesheet"]'))) {
        ancestors.add(document.documentElement);
      }
      const candidate = candidateFor(target);
      if (candidate) {
        changed.add(candidate);
        if (record.type === "childList" && turnSections.has(candidate)) discoverAgain = true;
        continue;
      }
      // Composer edits and unrelated live widgets never rescan the transcript.
      if (target.closest('textarea,input,[contenteditable]:not([contenteditable="false"])')) continue;
      if (record.type === "childList") {
        if ([...record.removedNodes].some(node => node instanceof Element &&
          (node.hasAttribute(candidateAttribute) || node.querySelector('[' + candidateAttribute + ']')))) discoverAgain = true;
        if ([...record.addedNodes].some(node => node instanceof Element &&
          (node.matches(messageSelector) || node.querySelector(messageSelector)))) discoverAgain = true;
        // Semantic list children may not carry a provider-specific attribute.
        if (target.matches('[role="log"]') || target.closest('[role="log"]') ||
            (lastDiscovery.strategy?.includes('semantic-list') && target.closest('ol'))) discoverAgain = true;
      }
    }
    for (const [target, values] of attributes) for (const [name, before] of values) {
      const after = target.getAttribute(name);
      if (after === before) continue;
      if (name === "style" && target instanceof HTMLElement && ownStyleValues.get(target) === (after ?? "")) continue;
      if (name === "style" && paintOnlyChange(before, after)) continue;
      const candidate = candidateFor(target);
      if (candidate) {
        changed.add(candidate);
        for (const section of turnSections.get(candidate) ?? []) if (target.contains(section)) {
          changed.add(section);
          scrollRootCache = new WeakMap();
        }
      }
      else if (!target.closest('textarea,input,[contenteditable]:not([contenteditable="false"])')) ancestors.add(target);
      if (semanticAttributes.has(name)) discoverAgain = true;
      if (!candidate && target.closest(conversationSurfaceSelector) && !knownCandidates.size) discoverAgain = true;
    }
    for (const target of ancestors) {
      let containsCandidates = false;
      for (const element of knownCandidates) if (target.contains(element)) { changed.add(element); containsCandidates = true; }
      if (containsCandidates) {
        scrollRootCache = new WeakMap();
        // Also catches hidden/revealed siblings and replaced provider classes.
        discoverAgain = true;
      }
    }
    for (const element of changed) invalidate(element);
    if (discoverAgain) scheduleMutationRefresh();
  });
  function updateMutationObservation(): void {
    const nextDiscoveryOnly = !namedProvider && knownCandidates.size === 0 && !document.querySelector(genericConversationSelector);
    if (observingMutations && discoveryOnly === nextDiscoveryOnly) return;
    discoveryOnly = nextDiscoveryOnly;
    observingMutations = true;
    mutationObserver.observe(root, {
      childList: true, subtree: true, characterData: !discoveryOnly, attributes: true, attributeOldValue: true,
      attributeFilter: discoveryOnly ? [...semanticAttributes]
        : [...semanticAttributes, "aria-busy", "data-is-streaming", "data-streaming", "data-talvt-turn-state", "data-virtualized-turn-content", "data-virtualizer", "class", "style", "hidden", "open", "width", "height", "contenteditable"]
    });
  }
  const onInteraction = (event: Event): void => {
    const affected = new Set(interactionProtected);
    interactionProtected.clear();
    const focused = candidateFor(document.activeElement);
    const target = candidateFor(event.target instanceof Node ? event.target : null);
    if (focused) { affected.add(focused); interactionProtected.add(focused); }
    if (target) affected.add(target);
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) for (const element of observed) if (selection.containsNode(element, true)) {
      affected.add(element); interactionProtected.add(element);
    }
    for (const element of affected) invalidate(element);
  };
  const interactionEvents = ["selectionchange", "focusin", "focusout", "play", "pause", "ended"];
  for (const name of interactionEvents) document.addEventListener(name, onInteraction, true);
  for (const name of activityEvents) document.addEventListener(name, onActivity, { capture: true, passive: true });
  const recalibrate = (): void => {
    scrollRootCache = new WeakMap();
    for (const element of observed) invalidate(element);
    scheduleMutationRefresh();
  };
  const onIntrinsicSize = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    if (event.target instanceof HTMLLinkElement && event.target.rel === "stylesheet") { recalibrate(); return; }
    const element = candidateFor(event.target);
    if (element) invalidate(element);
  };
  document.addEventListener("load", onIntrinsicSize, true);
  document.addEventListener("loadedmetadata", onIntrinsicSize, true);
  document.fonts.addEventListener("loadingdone", recalibrate);
  const beforePrint = (): void => { printing = true; clearTurnMarkers(); };
  const afterPrint = (): void => { printing = false; recalibrate(); };
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  window.addEventListener("resize", recalibrate, true);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    scrolling.clear();
    mutationObserver.disconnect();
    for (const observer of intersectionObservers.values()) observer.disconnect();
    intersectionObservers.clear(); observedRoots.clear(); resizeObserver.disconnect();
    for (const element of candidateWidths.keys()) element.removeEventListener("contentvisibilityautostatechange", onSkip);
    candidateWidths.clear();
    if (mutationTimer !== undefined) window.clearTimeout(mutationTimer);
    if (quietTimer !== undefined) window.clearTimeout(quietTimer);
    if (hiddenWorkTimer !== undefined) window.clearTimeout(hiddenWorkTimer);
    if (workFrame !== undefined) cancelAnimationFrame(workFrame);
    for (const name of interactionEvents) document.removeEventListener(name, onInteraction, true);
    for (const name of activityEvents) document.removeEventListener(name, onActivity, true);
    window.removeEventListener("resize", recalibrate, true);
    document.removeEventListener("load", onIntrinsicSize, true);
    document.removeEventListener("loadedmetadata", onIntrinsicSize, true);
    document.fonts.removeEventListener("loadingdone", recalibrate);
    window.removeEventListener("beforeprint", beforePrint);
    window.removeEventListener("afterprint", afterPrint);
    // A framework can temporarily detach a turn and keep its DOM for reuse.
    // Clean tracked nodes before dropping references; a document query cannot
    // reach a node removed immediately before the mutation callback runs.
    for (const element of knownCandidates) forget(element);
    observed.clear(); knownCandidates.clear(); pendingTurns.clear(); quietTurns.clear(); excluded.clear(); interactionProtected.clear();
    sectionOwners.clear(); turnSections.clear();
    clearTurnMarkers(); clearRootState();
  };
  runtimeGlobal[runtimeKey] = {
    refresh, stop, probe: () => ({ ...metrics(lastDiscovery), ...workMetrics() }),
    exportSkipStates: () => [...knownCandidates].filter(element => element.hasAttribute(turnAttribute) && skippedStates.has(element))
      .map(element => [element, skippedStates.get(element)!])
  };
  refresh(lastDiscovery);
  return { ...metrics(lastDiscovery), ...workMetrics() };
}

async function executeRuntime(
  tabId: number,
  command: AiConversationRuntimeCommand
): Promise<AiConversationOptimizerMetrics | undefined> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: runAiConversationOptimizerInPage,
    args: [command]
  });
  return results.find(result => result.frameId === 0)?.result ?? results[0]?.result;
}

export function installAiConversationOptimizer(tabId: number): Promise<AiConversationOptimizerMetrics | undefined> {
  return executeRuntime(tabId, "install");
}

export function removeAiConversationOptimizer(tabId: number): Promise<AiConversationOptimizerMetrics | undefined> {
  return executeRuntime(tabId, "remove");
}

export function probeAiConversationOptimizer(tabId: number): Promise<AiConversationOptimizerMetrics | undefined> {
  return executeRuntime(tabId, "probe");
}
