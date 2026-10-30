import type { ExperimentalOptimizerItemId, PageOptimizerMetrics, Settings } from "../shared/types";

type Command = "install" | "remove" | "probe";
type Configuration = Partial<Settings["experimentalOptimizerItems"]>;

/** Serialized by chrome.scripting; keep every runtime dependency inside this function. */
export function runPageOptimizerInPage(command: Command, configuration: Configuration = {}): PageOptimizerMetrics {
  const key = "__resourceGovernorPageOptimizerV1";
  const host = globalThis as typeof globalThis & {
    [key]?: { stop(): void; probe(): PageOptimizerMetrics; configurationKey: string };
  };
  if (command === "probe") return host[key]?.probe() ?? { runtimeActive: false, items: {} };
  host[key]?.stop();
  delete host[key];
  if (command === "remove") return { runtimeActive: false, items: {} };
  const configurationKey = Object.entries(configuration).filter(([, value]) => value).map(([id]) => id).sort().join("|");
  // The conversation runtime is installed separately. An empty configuration
  // must not observe or repeatedly walk the site's DOM.
  if (!Object.entries(configuration).some(([id, value]) => id !== "chatgptConversationOptimizer" && value)) {
    let active = true;
    const probe = (): PageOptimizerMetrics => ({ runtimeActive: active, items: {}, discoveryComplete: true, scanDurationMs: 0, configurationKey });
    host[key] = { stop: () => { active = false; }, probe, configurationKey };
    return probe();
  }

  type Id = ExperimentalOptimizerItemId;
  type Owned = { original: string; priority: string; applied: string; appliedPriority: string };
  type Candidate = { id: Id; near: boolean; invalid: boolean; measuredWidth?: number; measuredHeight?: number };
  type ContainmentPlan = {
    element: HTMLElement; candidate: Candidate; rect: DOMRect;
    blockSize: number; inlineSize: number;
    parent: HTMLElement | null; parentHeight?: number; parentWidth?: number;
  };
  const candidates = new Map<HTMLElement, Candidate>();
  const contained = new Set<HTMLElement>();
  const unsafeLayouts = new WeakSet<HTMLElement>();
  const containerLayouts = new WeakMap<HTMLElement, boolean>();
  const horizontalSurfaces = new WeakSet<HTMLElement>();
  const lightweightContent = new WeakSet<HTMLElement>();
  const styles = new Map<HTMLElement, Map<string, Owned>>();
  const ownStyleValues = new WeakMap<HTMLElement, string>();
  const relevantStyleValues = new WeakMap<HTMLElement, { cssText: string; values: Map<string, string> }>();
  const previousStyle = document.createElement("div").style;
  const renderingProperty = /^(font|line-height|letter-spacing|word-spacing|width|min-|max-|height|block-|inline-|padding|margin|display|visibility|position|grid|flex|box-sizing|writing-mode|white-space|contain|content-visibility|--)/;
  const effectProperty = /^(backdrop-filter|box-shadow|animation)/;
  const styleValues = (declaration: CSSStyleDeclaration): Map<string, string> => {
    const values = new Map<string, string>();
    for (const name of declaration) if (renderingProperty.test(name) || effectProperty.test(name)) {
      values.set(name, declaration.getPropertyValue(name) + "\u0000" + declaration.getPropertyPriority(name));
    }
    return values;
  };
  const effects = new Set<HTMLElement>();
  const animationTargets = new Set<Element>();
  const videos = new Set<HTMLVideoElement>();
  const pausedVideos = new Set<HTMLVideoElement>();
  const manualVideos = new WeakSet<HTMLVideoElement>();
  const pausedAnimations = new Map<Animation, Id>();
  const repeatingAnimations = new Set<Animation>();
  let animationSnapshot = new Set<Animation>();
  let lastAnimationDiscovery = 0;
  let animationDiscoveryDirty = true;
  const changedRates = new Map<Animation, { original: number; applied: number }>();
  const observedRoots = new Set<Document | ShadowRoot>();
  const observedElements = new Set<Element>();
  const near = new WeakMap<Element, boolean>();
  const skippedState = new WeakMap<HTMLElement, boolean>();
  const onSkip = (event: Event): void => {
    if (!(event.target instanceof HTMLElement) || stopped) return;
    const element = event.target;
    const skipped = Boolean((event as Event & { skipped?: boolean }).skipped);
    skippedState.set(element, skipped);
    const candidate = candidates.get(element);
    // Chromium can activate size containment after the initial style/layout pass.
    if (skipped && candidate && contained.has(element) && candidate.measuredHeight !== undefined && candidate.measuredWidth !== undefined) {
      const rect = element.getBoundingClientRect();
      if (Math.abs(rect.height - candidate.measuredHeight) > 0.1 || Math.abs(rect.width - candidate.measuredWidth) > 0.1) {
        rejectLayout(element, candidate);
      }
    }
  };
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
    // Initial discovery/cache construction is finite and needs enough credit
    // to finish. Applying the maintenance allowance here can delay a large
    // static page for tens of seconds. Input gates and slice deadlines still
    // apply, and an individual long batch always triggers a cooldown.
    const allowance = kind === "discovery" ? (initialDiscoveryComplete ? 80 : 160)
      : (initialRenderingComplete ? 48 : 96);
    if (duration >= 50 || budget.spent >= allowance) {
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
  let scanTimer: number | undefined;
  let scanIdle: number | undefined;
  let interactionTimer: number | undefined;
  let animationTimer: number | undefined;
  let rediscoveryTimer: number | undefined;
  let rediscoveryStarted = 0;
  let rediscoveryChanged = 0;
  let rediscoveryQuietMs = 350;
  let settleTimer: number | undefined;
  let containmentTimer: number | undefined;
  let initialRenderingComplete = false;
  let renderingWarmupEnds = Infinity;
  const pendingContainment = new Set<HTMLElement>();
  const dirtySubtrees = new Set<Node>();
  const changingRegions = new Map<HTMLElement, number>();
  const lastRegionChange = new WeakMap<HTMLElement, { at: number; quiet: number }>();
  let renderingBackoff = false;
  let renderingBackoffCount = 0;
  let renderingResumeTimer: number | undefined;
  let churnWindowStarted = performance.now();
  let churnRecords = 0;
  let churnStreak = 0;
  let renderingChurnRate = 0;
  let renderingChurnTargets = 0;
  let lastRenderingChange = 0;
  const churnCandidates = new Set<HTMLElement>();
  const visited = new WeakSet<Element>();
  const pendingWalkers: Array<{ walker: TreeWalker; refresh: boolean }> = [];
  const pendingNodes = new Map<Node, boolean>();
  const pendingChecks = new Set<Element>();
  const repeatedGroups = new WeakMap<Element, Set<Element>>();
  const marker = "data-resource-governor-page-kind";
  const limit = 800;
  const margin = 1200;
  const enabled = (id: Id): boolean => configuration[id] === true;
  const renderingEnabled = enabled("offscreenRendering") || enabled("mediaContainment") ||
    enabled("codeBlockContainment") || enabled("imageContainment");
  const animationsEnabled = enabled("animationLimiter") || enabled("backgroundAnimationPause") || enabled("reducedMotionMode");

  const setStyle = (element: HTMLElement, property: string, value: string): void => {
    let saved = styles.get(element);
    if (!saved) styles.set(element, saved = new Map());
    const existing = saved.get(property);
    if (!existing) saved.set(property, {
      original: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
      applied: value,
      appliedPriority: "important"
    });
    else {
      // A site change after our write becomes the next restoration value.
      if (element.style.getPropertyValue(property) !== existing.applied ||
          element.style.getPropertyPriority(property) !== existing.appliedPriority) {
        existing.original = element.style.getPropertyValue(property);
        existing.priority = element.style.getPropertyPriority(property);
      }
      existing.applied = value;
    }
    element.style.setProperty(property, value, "important");
    ownStyleValues.set(element, element.getAttribute("style") ?? "");
  };
  const restoreStyle = (element: HTMLElement, property: string): void => {
    const saved = styles.get(element);
    const entry = saved?.get(property);
    if (!entry) return;
    if (element.style.getPropertyValue(property) === entry.applied &&
        element.style.getPropertyPriority(property) === entry.appliedPriority) {
      if (entry.original) element.style.setProperty(property, entry.original, entry.priority);
      else element.style.removeProperty(property);
    }
    ownStyleValues.set(element, element.getAttribute("style") ?? "");
    saved?.delete(property);
    if (saved?.size === 0) styles.delete(element);
  };
  const uncontain = (element: HTMLElement): void => {
    if (!contained.delete(element)) return;
    element.removeEventListener("contentvisibilityautostatechange", onSkip);
    restoreStyle(element, "content-visibility");
    restoreStyle(element, "contain-intrinsic-block-size");
    restoreStyle(element, "contain-intrinsic-inline-size");
    element.removeAttribute(marker);
    skippedState.delete(element);
  };
  const parentAcrossShadow = (element: Element): Element | null =>
    element.parentElement ?? ((element.getRootNode() as ShadowRoot).host ?? null);
  const within = (element: Element, selector: string): boolean => {
    let current: Element | null = element;
    while (current) {
      if (current.closest(selector)) return true;
      current = (current.getRootNode() as ShadowRoot).host ?? null;
    }
    return false;
  };
  const managedAncestor = (element: HTMLElement): boolean => {
    let parent = parentAcrossShadow(element);
    while (parent) {
      if (contained.has(parent as HTMLElement) || parent.hasAttribute("data-resource-governor-ai-turn")) return true;
      parent = parentAcrossShadow(parent);
    }
    return false;
  };
  const insideHorizontalSurface = (element: HTMLElement): boolean => {
    for (let parent = parentAcrossShadow(element); parent; parent = parentAcrossShadow(parent)) {
      if (horizontalSurfaces.has(parent as HTMLElement)) return true;
    }
    return false;
  };
  const protectedContent = (element: Element): boolean => {
    // Conversation layout belongs to its dedicated runtime, even before async
    // discovery adds markers or when that runtime is disabled.
    const conversation = '[data-resource-governor-ai-candidate],[data-message-author-role],[data-conversation-role="user"],[data-conversation-role="assistant"],[data-turn-key],[data-thread-find-target="conversation"],[data-testid^="conversation-turn"],[role="log"],[role="region"][aria-label="Conversation"],ol[aria-label^="Conversation"]';
    if (within(element, conversation) || element.querySelector(conversation)) return true;
    if (within(element, 'nav,header,footer,aside,dialog,canvas,[role="dialog"],[role="menu"],[role="navigation"],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="application"],[role="grid"],[role="treegrid"],[inert],[aria-hidden="true"],[aria-setsize],[aria-rowindex]')) return true;
    // Drawing surfaces can have interactive behavior and geometry reads without
    // semantic widget roles. Keep their containing layouts under page control.
    if (element.matches("input,textarea,select,button") ||
        element.querySelector('input,textarea,select,canvas,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="application"],[role="grid"],[role="treegrid"],[aria-busy="true"],[data-is-streaming="true"],[data-streaming="true"]')) return true;
    if (element.matches('[aria-busy="true"],[data-is-streaming="true"],[data-streaming="true"]')) return true;
    const scope = element.getRootNode() as Document | ShadowRoot;
    const active = scope.activeElement ?? document.activeElement;
    if (active && active !== document.body && (element === active || element.contains(active))) return true;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) {
      try { if (selection.containsNode(element, true)) return true; } catch { /* Detached selection. */ }
    }
    const fullscreen = scope.fullscreenElement ?? document.fullscreenElement;
    if (fullscreen && (element === fullscreen || element.contains(fullscreen) || fullscreen.contains(element))) return true;
    for (const media of element.querySelectorAll<HTMLMediaElement>("video,audio")) {
      if (!media.paused) return true;
    }
    return false;
  };
  const isNear = (element: Element): boolean => {
    const known = near.get(element);
    if (known !== undefined) return known;
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -margin && rect.top <= innerHeight + margin;
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
  const hasRenderingWork = (element: HTMLElement): boolean => {
    // A visibility boundary has its own ongoing browser cost. Short quote
    // tiles, logos and thumbnail wrappers seldom have work worth skipping.
    // Use a bounded structural/text scan; never infer cost from a hostname.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: node => node instanceof Element && node.matches("script,style,template,noscript,[hidden],[aria-hidden=true]")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    let nodes = 0, characters = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Element) nodes++;
      else characters += node.textContent?.trim().length ?? 0;
      if (nodes >= 32 || characters >= 1200) return true;
    }
    return false;
  };

  const prepareContainment = (element: HTMLElement, candidate: Candidate): ContainmentPlan | undefined => {
    if (unsafeLayouts.has(element)) { rejectLayout(element, candidate); return; }
    if (printing || renderingBackoff || !element.isConnected || candidate.invalid) {
      uncontain(element);
      return;
    }
    if (managedAncestor(element) || insideHorizontalSurface(element)) {
      uncontain(element);
      pauseRenderingObservation(element);
      return;
    }
    // Once safely measured offscreen, let content-visibility:auto render the
    // approaching element. Removing/reapplying it on every scroll discards the
    // browser's remembered size and repeatedly forces whole-page layout.
    // Content, focus, selection, media and size changes release it via events.
    if (contained.has(element)) return;
    if (!hasRenderingWork(element)) { lightweightContent.add(element); rejectLayout(element, candidate); return; }
    if (inChangingRegion(element)) { pauseRenderingObservation(element); return; }
    if (!observedElements.has(element)) {
      near.delete(element);
      candidate.near = isNear(element);
      observe(element);
    }
    if (candidate.near) return;
    const computed = getComputedStyle(element);
    if (computed.contentVisibility !== "visible" || !["static", "relative"].includes(computed.position) ||
        computed.display === "contents" || computed.display === "inline" ||
        computed.display.startsWith("table") ||
        computed.writingMode !== "horizontal-tb" || computed.transform !== "none" ||
        element.querySelector('[style*="position: sticky"],[style*="position: fixed"]')) { rejectLayout(element, candidate); return; }
    if (hasCollapsingEdges(element, computed)) { rejectLayout(element, candidate); return; }
    if (protectedContent(element)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 40 || rect.height > 16000) { rejectLayout(element, candidate); return; }
    const inset = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
      .reduce((sum, property) => sum + (parseFloat(computed[property as keyof CSSStyleDeclaration] as string) || 0), 0);
    const blockSize = Math.max(1, rect.height - inset);
    const parent = element.parentElement;
    const parentHeight = parent?.scrollHeight;
    const parentWidth = parent?.scrollWidth;
    const horizontalInset = [computed.paddingLeft, computed.paddingRight, computed.borderLeftWidth, computed.borderRightWidth].reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
    return {element, candidate, rect, blockSize, inlineSize: Math.max(1, rect.width - horizontalInset), parent, parentHeight, parentWidth};
  };
  const applyContainment = (plans: ContainmentPlan[]): void => {
    if (!plans.length) return;
    const documentHeight = document.documentElement.scrollHeight;
    const documentWidth = document.documentElement.scrollWidth;
    // Read all independent targets before writing. Alternating a style write
    // and a geometry read for each card forces one whole layout per card.
    for (const {element, candidate, rect, blockSize, inlineSize} of plans) {
      setStyle(element, "contain-intrinsic-inline-size", "auto " + inlineSize + "px");
      setStyle(element, "contain-intrinsic-block-size", "auto " + blockSize + "px");
      setStyle(element, "content-visibility", "auto");
      candidate.measuredWidth = rect.width; candidate.measuredHeight = rect.height;
      contained.add(element);
      element.addEventListener("contentvisibilityautostatechange", onSkip);
      element.setAttribute(marker, candidate.id);
    }
    // The first read resolves the batch's layout. Keep every subsequent read
    // before any rollback write. If a shared boundary changed, release the
    // whole small batch rather than guessing which target caused the shift.
    const invalid = plans.some(({element, rect, parent, parentHeight, parentWidth}) => {
      const after = element.getBoundingClientRect();
      return Math.abs(after.height - rect.height) > 0.1 || Math.abs(after.width - rect.width) > 0.1 ||
        Math.abs(after.top - rect.top) > 0.1 || Math.abs(after.left - rect.left) > 0.1 ||
        parent?.scrollHeight !== parentHeight || parent?.scrollWidth !== parentWidth;
    }) || document.documentElement.scrollHeight !== documentHeight || document.documentElement.scrollWidth !== documentWidth;
    for (const {element, candidate} of plans) {
      if (invalid) rejectLayout(element, candidate);
      // Native content-visibility manages approaching content itself.
      else pauseRenderingObservation(element);
    }
  };

  const resumeAnimation = (animation: Animation): void => {
    if (!pausedAnimations.delete(animation)) return;
    if (animation.playState === "paused") {
      try { animation.play(); } catch { /* A site may have removed the timeline. */ }
    }
  };
  const restoreAnimationRate = (animation: Animation): void => {
    const rate = changedRates.get(animation);
    if (!rate) return;
    changedRates.delete(animation);
    animation.removeEventListener("finish", onAnimationSettled);
    animation.removeEventListener("cancel", onAnimationSettled);
    // Completion must release our rate too: sites can replay the same Animation
    // object later. Preserve a rate changed by the site while we owned it.
    if (animation.playbackRate === rate.applied) animation.updatePlaybackRate(rate.original);
  };
  function onAnimationSettled(event: Event): void {
    if (event.currentTarget instanceof Animation) restoreAnimationRate(event.currentTarget);
  }
  const cssAnimationNames = (value: string): Set<string> => {
    const names = new Set<string>();
    let name = "", quote = "", quoted = false;
    const finish = (): void => { if (name && (quoted || name !== "none")) names.add(name); name = ""; quoted = false; };
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char === "\\") {
        const hex = value.slice(index + 1).match(/^[0-9a-f]{1,6}/i)?.[0];
        if (hex) {
          const point = parseInt(hex, 16);
          name += String.fromCodePoint(point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point);
          index += hex.length;
          if (/[\t\n\f\r ]/.test(value[index + 1] ?? "")) {
            if (value[index + 1] === "\r" && value[index + 2] === "\n") index++;
            index++;
          }
        } else if (index + 1 < value.length) {
          const escaped = value[++index];
          if (!/[\n\r\f]/.test(escaped)) name += escaped;
          else if (escaped === "\r" && value[index + 1] === "\n") index++;
        }
      } else if (quote) {
        if (char === quote) quote = ""; else name += char;
      } else if (char === '"' || char === "'") { quote = char; quoted = true;
      } else if (char === ",") finish();
      else if (!/[\t\n\f\r ]/.test(char)) name += char;
    }
    finish(); return names;
  };
  const updateAnimations = (forceDiscovery = false): void => {
    if (stopped || !animationsEnabled) return;
    const now = performance.now();
    if (forceDiscovery || animationDiscoveryDirty || now - lastAnimationDiscovery >= 1000) {
      animationSnapshot = new Set<Animation>();
      for (const scope of observedRoots) {
        for (const animation of scope.getAnimations()) {
          if (animationSnapshot.size >= 1000) break;
          animationSnapshot.add(animation);
        }
      }
      lastAnimationDiscovery = now;
      animationDiscoveryDirty = false;
    }
    const active = animationSnapshot;
    repeatingAnimations.clear();
    const previousTargets = new Set(animationTargets);
    const namesByTarget = new Map<Element, Map<string, Set<string>>>();
    animationTargets.clear();
    for (const animation of pausedAnimations.keys()) if (!active.has(animation)) resumeAnimation(animation);
    for (const animation of active) {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element)) { restoreAnimationRate(animation); continue; }
      const element = effect.target;
      if (!element.isConnected || protectedContent(element)) { resumeAnimation(animation); restoreAnimationRate(animation); continue; }
      if (!(animation.timeline instanceof DocumentTimeline)) { restoreAnimationRate(animation); continue; }
      if (animation.playState === "idle" || animation.playState === "finished") { resumeAnimation(animation); restoreAnimationRate(animation); continue; }
      // Older Chromium can retain a script-paused CSSAnimation after its CSS
      // name disappears. Reconcile only on a real discovery/style event; a
      // scroll/intersection update must not force styles in skipped content.
      if (forceDiscovery && pausedAnimations.has(animation) && typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation) {
        const pseudo = effect.pseudoElement ?? "";
        let byPseudo = namesByTarget.get(element);
        if (!byPseudo) namesByTarget.set(element, byPseudo = new Map());
        let names = byPseudo.get(pseudo);
        if (!names) byPseudo.set(pseudo, names = cssAnimationNames(getComputedStyle(element, pseudo || null).animationName));
        if (!names.has(animation.animationName)) {
          pausedAnimations.delete(animation);
          animation.cancel();
          continue;
        }
      }
      const timing = effect.getComputedTiming();
      if (timing.iterations === Infinity) {
        restoreAnimationRate(animation);
        if (animation.playState === "running" || pausedAnimations.has(animation)) {
          animationTargets.add(element);
          if (enabled("animationLimiter")) observe(element);
        }
        if (animation.playState === "running" || pausedAnimations.has(animation)) repeatingAnimations.add(animation);
        const reason = enabled("backgroundAnimationPause") && document.hidden ? "backgroundAnimationPause"
          : enabled("animationLimiter") && !isNear(element) ? "animationLimiter" : undefined;
        if (reason && (animation.playState === "running" || pausedAnimations.has(animation))) {
          if (animation.playState === "running") animation.pause();
          pausedAnimations.set(animation, reason);
        } else if (!reason) resumeAnimation(animation);
      } else if (enabled("reducedMotionMode") && timing.activeDuration !== null &&
                 typeof timing.activeDuration === "number" && timing.activeDuration > 150 &&
                 animation.playState === "running" && animation.playbackRate > 0 && !changedRates.has(animation)) {
        const original = animation.playbackRate;
        const applied = Math.max(original, Math.min(100, timing.activeDuration / 150));
        if (applied > original) {
          changedRates.set(animation, { original, applied });
          animation.addEventListener("finish", onAnimationSettled);
          animation.addEventListener("cancel", onAnimationSettled);
          animation.updatePlaybackRate(applied);
        }
      }
    }
    for (const [animation] of changedRates) {
      if (!active.has(animation) || animation.playState === "finished" || animation.playState === "idle") restoreAnimationRate(animation);
    }
    for (const element of previousTargets) if (!animationTargets.has(element)) {
      const candidate = candidates.get(element as HTMLElement);
      if (!candidate || candidate.invalid || contained.has(element as HTMLElement) ||
          inChangingRegion(element as HTMLElement) || managedAncestor(element as HTMLElement)) pauseRenderingObservation(element);
    }
  };
  const resumeVideo = (video: HTMLVideoElement): void => {
    if (!pausedVideos.delete(video)) return;
    if (video.isConnected && video.paused && !manualVideos.has(video)) void video.play().catch(() => undefined);
  };
  const hasMediaControls = (video: HTMLVideoElement): boolean => {
    let parent = video.parentElement;
    for (let depth = 0; parent && depth < 3 && !parent.matches("body,main"); depth++, parent = parent.parentElement) {
      if (parent.querySelectorAll("video").length > 1) break;
      if (parent.querySelector('button,[role="button"],[role="slider"],input[type="range"]')) return true;
    }
    return false;
  };
  const updateVideo = (video: HTMLVideoElement): void => {
    const pictureInPicture = (video.getRootNode() as Document | ShadowRoot).pictureInPictureElement ?? document.pictureInPictureElement;
    const eligible = video.autoplay && video.loop && video.muted && !video.controls &&
      !manualVideos.has(video) && !hasMediaControls(video) && video !== pictureInPicture &&
      !protectedContent(video);
    if (!eligible || (!document.hidden && isNear(video))) { resumeVideo(video); return; }
    if (!video.paused) {
      pausedVideos.add(video);
      video.pause();
    }
  };
  const updateInteractions = (): void => {
    if (stopped) return;
    for (const scope of observedRoots) {
      if (scope instanceof ShadowRoot && !scope.host.isConnected) {
        forgetRoot(scope);
        observedRoots.delete(scope);
        pendingNodes.delete(scope);
      }
    }
    for (const [element, properties] of styles) {
      if (!element.isConnected) {
        for (const property of [...properties.keys()]) restoreStyle(element, property);
        effects.delete(element);
        visited.delete(element);
      }
    }
    for (const element of observedElements) {
      if (!element.isConnected) {
        intersection.unobserve(element);
        element.removeEventListener("contentvisibilityautostatechange", onSkip);
        observedElements.delete(element); animationTargets.delete(element); effects.delete(element as HTMLElement); visited.delete(element);
        if (element instanceof HTMLElement) for (const property of [...(styles.get(element)?.keys() ?? [])]) restoreStyle(element, property);
      }
    }
    for (const [element, candidate] of candidates) {
      if (!element.isConnected) { uncontain(element); candidates.delete(element); intersection.unobserve(element); continue; }
      if (contained.has(element)) {
        if (managedAncestor(element)) { uncontain(element); pauseRenderingObservation(element); }
      } else if (!candidate.invalid) queueContainment(element);
    }
    updateAnimations();
    for (const video of videos) {
      if (!video.isConnected) { pausedVideos.delete(video); videos.delete(video); continue; }
      updateVideo(video);
    }
  };
  const intersection = new IntersectionObserver(entries => {
    if (stopped) return;
    let animationChanged = false;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      near.set(element, entry.isIntersecting);
      const candidate = candidates.get(element);
      if (candidate) { candidate.near = entry.isIntersecting; queueContainment(element); }
      if (animationTargets.has(element)) animationChanged = true;
      if (element instanceof HTMLVideoElement && videos.has(element)) updateVideo(element);
    }
    if (animationChanged) updateAnimations();
  }, { rootMargin: "1200px 0px", threshold: 0 });
  function observe(element: Element): void {
    if (!observedElements.has(element)) {
      observedElements.add(element);
      intersection.observe(element);
      element.addEventListener("contentvisibilityautostatechange", onSkip);
    }
  }
  function rejectLayout(element: HTMLElement, candidate: Candidate): void {
    uncontain(element);
    candidate.invalid = true;
    pauseRenderingObservation(element);
  }
  function inChangingRegion(element: HTMLElement): boolean {
    let current: Element | null = element;
    while (current) {
      if (changingRegions.has(current as HTMLElement)) return true;
      current = parentAcrossShadow(current);
    }
    return false;
  }
  function pauseRenderingObservation(element: Element): void {
    // Native intersection tracking has a cost even when our JS callback does
    // no work. Rejected photo grids must not leave hundreds of inert targets.
    if (observedElements.has(element) && !(enabled("animationLimiter") && animationTargets.has(element)) && !(element instanceof HTMLVideoElement && videos.has(element))) {
      intersection.unobserve(element);
      observedElements.delete(element);
      near.delete(element);
      if (!contained.has(element as HTMLElement)) element.removeEventListener("contentvisibilityautostatechange", onSkip);
    }
  }
  function reconsiderLayout(element: HTMLElement, candidate: Candidate): void {
    candidate.invalid = false;
    if (unsafeLayouts.has(element)) { rejectLayout(element, candidate); return; }
    if (renderingBackoff || inChangingRegion(element) || managedAncestor(element) || insideHorizontalSurface(element)) { pauseRenderingObservation(element); return; }
    if (!observedElements.has(element)) {
      near.delete(element);
      candidate.near = isNear(element);
      observe(element);
    }
  }

  const addCandidate = (element: HTMLElement | null, id: Id): void => {
    if (!element || candidates.size >= limit || insideHorizontalSurface(element) || protectedContent(element) ||
        element.hasAttribute("data-resource-governor-ai-turn")) return;
    const existing = candidates.get(element);
    if (existing) return;
    if (!hasRenderingWork(element)) { lightweightContent.add(element); return; }
    lightweightContent.delete(element);
    const computed = getComputedStyle(element);
    if (!["static", "relative"].includes(computed.position) || computed.transform !== "none" ||
        computed.display === "contents" || computed.display === "inline" || computed.display.startsWith("table")) return;
    // Hidden templates and icons must not consume the bounded candidate budget.
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 40 || rect.height > 16000) return;
    const candidate = { id, near: isNear(element), invalid: false };
    candidates.set(element, candidate);
    reconsiderLayout(element, candidate);
  };
  const mediaContainer = (element: Element): HTMLElement | null => {
    let container = element.closest("figure") ?? element.parentElement;
    for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
      if (container.matches("body,main,article,section,nav,aside") ||
          container.children.length > 8 || container.querySelectorAll("img,video,canvas,iframe").length > 4) return null;
      const computed = getComputedStyle(container);
      const rect = container.getBoundingClientRect();
      if (!["inline", "contents"].includes(computed.display) && !computed.display.startsWith("table") &&
          rect.width >= 120 && rect.height >= 40) return container;
    }
    return null;
  };
  const repeatedContent = (element: HTMLElement): boolean => {
    const parent = element.parentElement;
    if (!parent || parent.matches("body,html,nav,header,footer") || parent.children.length < 4 ||
        !element.matches("div,li,a,figure,dl")) return false;
    let group = repeatedGroups.get(parent);
    if (!group) {
      group = new Set<Element>();
      const signatures = new Map<string, Element[]>();
      for (const child of [...parent.children].slice(0, limit)) {
        if (!(child instanceof HTMLElement) || !child.matches("div,li,a,figure,dl")) continue;
        const content = child.textContent?.trim() ?? "";
        const hasLink = child.matches("a[href]") || Boolean(child.querySelector("a[href]"));
        const hasImage = Boolean(child.querySelector("img,picture"));
        if (!(hasLink && content.length >= 24) && !(hasImage && content.length >= 8) &&
            !child.querySelector("h2,h3,h4")) continue;
        // Compare markup shape, never site-specific class names or hostnames.
        const signature = child.tagName + ":" + (child.getAttribute("role") ?? "") + ":" +
          [...child.children].slice(0, 4).map(node => node.tagName).join(",");
        const peers = signatures.get(signature) ?? [];
        peers.push(child); signatures.set(signature, peers);
      }
      for (const peers of signatures.values()) if (peers.length >= 4) for (const peer of peers) group.add(peer);
      repeatedGroups.set(parent, group);
    }
    return group.has(element);
  };
  const detectEffect = (element: HTMLElement): void => {
    if (!enabled("visualEffectsReducer") || effects.size >= 250) return;
    if (effects.delete(element)) {
      restoreStyle(element, "backdrop-filter");
      restoreStyle(element, "box-shadow");
    }
    if (element.matches("img,video,canvas,svg,code,pre,span,a,path") || managedAncestor(element)) return;
    const computed = getComputedStyle(element);
    const backdrop = computed.backdropFilter;
    const blur = backdrop.match(/blur\(([\d.]+)px\)/);
    const shadows = computed.boxShadow.replace(/(?:rgba?|hsla?)\([^)]*\)/g, "").split(",");
    const reduceShadow = shadows.some(shadow => {
      const values = shadow.match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
      return (values[2] ?? 0) >= 16;
    });
    if (!(blur && Number(blur[1]) >= 5) && !reduceShadow) return;
    const rect = element.getBoundingClientRect();
    if (rect.width * rect.height < 60000 || rect.width < 200 || rect.height < 100 || protectedContent(element)) return;
    let changed = false;
    if (blur && Number(blur[1]) >= 5) { setStyle(element, "backdrop-filter", "none"); changed = true; }
    if (reduceShadow) { setStyle(element, "box-shadow", "none"); changed = true; }
    if (changed) effects.add(element);
  };
  const protectShadowSurface = (element: Element): void => {
    if (!(element.getRootNode() instanceof ShadowRoot)) return;
    if (!element.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="application"],[role="grid"]') &&
        !(element instanceof HTMLMediaElement && !element.paused)) return;
    let parent = parentAcrossShadow(element);
    while (parent) { unsafeLayouts.add(parent as HTMLElement); uncontain(parent as HTMLElement); parent = parentAcrossShadow(parent); }
  };
  const inspectElement = (element: Element, refresh = false): void => {
    if (refresh) visited.delete(element);
    if (visited.has(element)) return;
    visited.add(element);
    if (!(element instanceof HTMLElement)) {
      if (element instanceof SVGSVGElement && enabled("mediaContainment")) addCandidate(mediaContainer(element), "mediaContainment");
      return;
    }
    if (element.shadowRoot) queueRoot(element.shadowRoot);
    protectShadowSurface(element);
    // Mutation callbacks release affected caches first. Reading computed style
    // again while the same widget is still changing forces extra layout work.
    // Rediscover it when its quiet period expires instead.
    if (inChangingRegion(element)) { visited.delete(element); return; }
    // Geometry/style reads inside skipped content can force the browser to
    // render it. Its initial subtree was inspected before containment; real
    // content/style mutations release ancestors before rediscovery runs.
    if (managedAncestor(element)) return;
    if (renderingEnabled && !renderingBackoff) {
      const computed = getComputedStyle(element);
      containerLayouts.set(element, computed.containerType !== "normal");
      // A clipped horizontal carousel is already a single rendering surface.
      // Hundreds of simple lateral cards add native visibility-boundary work
      // without reducing the page's layout. Optimize the offscreen surface as
      // a whole, leaving its internal horizontal navigation under site control.
      const horizontal = !element.matches("html,body") &&
        /^(auto|scroll|hidden|clip)$/.test(computed.overflowX) &&
        element.clientWidth >= 120 && element.clientHeight >= 40 &&
        element.scrollWidth > element.clientWidth * 1.5 &&
        element.scrollHeight <= element.clientHeight + 2;
      if (horizontal) {
        horizontalSurfaces.add(element);
        if (enabled("offscreenRendering")) addCandidate(element, "offscreenRendering");
      } else horizontalSurfaces.delete(element);
      const position = computed.position;
      if (position === "sticky" || position === "fixed" || position === "absolute") {
        // Layout/paint containment establishes a containing block and clips
        // positioned descendants. Outer width/height can remain identical
        // while a badge or overlay moves, so the geometry rollback is not enough.
        let parent = parentAcrossShadow(element);
        while (parent) { unsafeLayouts.add(parent as HTMLElement); uncontain(parent as HTMLElement); parent = parentAcrossShadow(parent); }
      }
    }
    if (within(element, "nav,header,footer,aside,dialog,[role=navigation]")) return;
    if (renderingEnabled && !renderingBackoff) {
      if (enabled("codeBlockContainment") && element.matches("pre,[role=code]")) addCandidate(element, "codeBlockContainment");
      if (enabled("imageContainment") && element.matches("img,picture,figure")) addCandidate(mediaContainer(element), "imageContainment");
      if (enabled("mediaContainment") && element.matches("video,canvas,iframe,svg")) addCandidate(mediaContainer(element), "mediaContainment");
      if (enabled("offscreenRendering")) {
        const semantic = element.matches("section,article,[role=article],[role=listitem]");
        if (semantic || repeatedContent(element)) addCandidate(element, "offscreenRendering");
      }
    }
    if (enabled("offscreenMediaPause") && element instanceof HTMLVideoElement) {
      videos.add(element);
      observe(element);
    }
    detectEffect(element);
  };
  let lastScanMs = 0;
  let initialDiscoveryComplete = false;
  let containmentBatchLimit = 16;
  const drainContainment = (): void => {
    containmentTimer = undefined;
    if (stopped) return;
    const delay = workDelay("rendering");
    if (delay > 0) { containmentTimer = window.setTimeout(drainContainment, Math.min(delay, 250)); return; }
    // Discover descendants first, including sticky controls and shadow inputs.
    // Do not create a cache only to force it open while walking its children.
    if (initialDiscoveryComplete) {
      const start = performance.now();let processed = 0;
      const plans: ContainmentPlan[] = [];
      const ancestors = (element: Element): Element[] => {
        const result: Element[] = [];
        for (let parent = parentAcrossShadow(element); parent; parent = parentAcrossShadow(parent)) result.push(parent);
        return result;
      };
      for (const element of [...pendingContainment]) {
        pendingContainment.delete(element);
        const candidate = candidates.get(element);
        if (candidate && element.isConnected) {
          // A live widget elsewhere must not stall every static cache. Wait
          // only for discovery that overlaps this candidate's own subtree.
          const overlaps = (node: Node): boolean => {
            const surface = node instanceof ShadowRoot ? node.host : node;
            return surface.contains(element) || element.contains(surface);
          };
          const pending = pendingWalkers.some(({ walker }) => overlaps(walker.root)) ||
            [...pendingNodes.keys()].some(overlaps) || [...pendingChecks].some(overlaps);
          if (pending || plans.some(plan => ancestors(element).includes(plan.element) || ancestors(plan.element).includes(element))) pendingContainment.add(element);
          else {
            const plan = prepareContainment(element, candidate);
            if (plan) plans.push(plan);
          }
        }
        const warming = !initialRenderingComplete && performance.now() < renderingWarmupEnds;
        if (++processed >= (warming ? 40 : 20) || plans.length >= containmentBatchLimit || performance.now() - start >= (warming ? 8 : 2)) break;
      }
      applyContainment(plans);
      const duration = recordWork("rendering", start);
      if (duration > 12) containmentBatchLimit = Math.max(1, Math.floor(containmentBatchLimit / 2));
      else if (duration < 4) containmentBatchLimit = Math.min(16, containmentBatchLimit + 1);
    }
    // Exhausting the short warmup changes the slice size, not forward progress.
    // A cost cooldown must not strand the first queue on the maintenance delay.
    if (pendingContainment.size) containmentTimer = window.setTimeout(drainContainment, initialRenderingComplete ? 250 : 16);
    else initialRenderingComplete = true;
  };
  function queueContainment(element: HTMLElement): void {
    const candidate = candidates.get(element);
    if (renderingBackoff || !candidate || candidate.invalid || contained.has(element) ||
        (candidate.near && observedElements.has(element)) || inChangingRegion(element)) return;
    if (managedAncestor(element) || insideHorizontalSurface(element)) { pauseRenderingObservation(element); return; }
    pendingContainment.add(element);
    if (containmentTimer === undefined) containmentTimer = window.setTimeout(drainContainment, initialRenderingComplete ? 250 : 16);
  }
  const queueSubtree = (node: Node, refresh: boolean): void => {
    for (const [queued, previousRefresh] of pendingNodes) {
      if (queued === node || queued.contains(node)) {
        if (refresh && !previousRefresh) pendingNodes.set(queued, true);
        return;
      }
      if (node.contains(queued)) pendingNodes.delete(queued);
    }
    pendingNodes.set(node, refresh);
  };
  const deferRediscovery = (node: Node, quietMs = 350): void => {
    rediscoveryChanged = performance.now();
    rediscoveryQuietMs = Math.max(rediscoveryQuietMs, quietMs);
    let covered = false;
    for (const dirty of dirtySubtrees) {
      if (dirty === node || dirty.contains(node)) { covered = true; break; }
      if (node.contains(dirty)) dirtySubtrees.delete(dirty);
    }
    if (!covered) dirtySubtrees.add(node);
    if (rediscoveryTimer !== undefined) return;
    rediscoveryStarted = performance.now();
    const refresh = (): void => {
      const now = performance.now();
      // Trailing refresh, with a maximum wait so continuous updates cannot
      // prevent newly eligible descendants from ever being discovered.
      if (now - rediscoveryChanged < rediscoveryQuietMs && now - rediscoveryStarted < (rediscoveryQuietMs > 350 ? 10000 : 2000)) {
        rediscoveryTimer = window.setTimeout(refresh, rediscoveryQuietMs);
        return;
      }
      rediscoveryTimer = undefined;
      rediscoveryQuietMs = 350;
      for (const dirty of dirtySubtrees) if (dirty.isConnected) queueSubtree(dirty, true);
      dirtySubtrees.clear();
      scheduleScan(0);
    };
    rediscoveryTimer = window.setTimeout(refresh, rediscoveryQuietMs);
  };
  const markChanging = (region: HTMLElement, delay: number, now: number): void => {
    const previous = lastRegionChange.get(region);
    // A single update can settle quickly. Live prices and scroll-controlled
    // classes recur just after that short interval: do not rebuild their
    // layout cache between each tick. Resume after a genuinely quiet period.
    if (previous && now - previous.at < 10000) {
      delay = Math.max(delay, previous.at === now ? previous.quiet : Math.min(5000, previous.quiet * 2));
    }
    lastRegionChange.set(region, { at: now, quiet: delay });
    changingRegions.set(region, Math.max(changingRegions.get(region) ?? 0, now + delay));
    if (settleTimer === undefined) settleTimer = window.setTimeout(settleRegions, 250);
  };
  const settleRegions = (): void => {
    settleTimer = undefined;
    const now = performance.now();
    let settled = false;
    for (const [region, stableAfter] of changingRegions) if (!region.isConnected || now >= stableAfter) {
      changingRegions.delete(region); settled = true;
      if (region.isConnected && !renderingBackoff) queueSubtree(region, true);
    }
    if (changingRegions.size) settleTimer = window.setTimeout(settleRegions, 250);
    if (settled) { scheduleScan(0); updateInteractions(); }
  };
  const flush = (deadline?: IdleDeadline): void => {
    scanTimer = undefined;
    if (stopped) return;
    const delay = workDelay("discovery");
    if (delay > 0) { scheduleScan(Math.min(delay, 250)); return; }
    const start = performance.now();
    const hasIdleBudget = deadline !== undefined && !deadline.didTimeout && deadline.timeRemaining() > 1;
    // Chromium can repeatedly deliver idle callbacks with almost no budget,
    // without ever reporting didTimeout. One element per callback can stall a
    // full document for tens of seconds. Guarantee a small, bounded slice.
    const thinIdleSlice = deadline !== undefined && !deadline.didTimeout && !hasIdleBudget;
    // Font/viewport changes during the first walk can queue another walk.
    // Keep that startup refresh moving until rendering has had its bounded
    // warmup period; switching to 40 nodes every 250ms here stalls all caches.
    const warming = !initialDiscoveryComplete || (!initialRenderingComplete && performance.now() < renderingWarmupEnds);
    // A foreground resize/font refresh must also drain promptly after startup.
    // Keep its small time budget, rather than sleeping 250ms between 40 nodes.
    const promptContinuation = hasIdleBudget || warming || !document.hidden;
    // Once startup is finished, a visible page still needs bounded progress
    // when the browser has no idle periods. A one-ms timeout slice followed by
    // another idle wait can stretch a modest resize refresh past five seconds.
    // Keep thin idle periods and hidden maintenance small; the same foreground
    // allowance as a real idle slice still yields to input and work cooldowns.
    const timeBudget = thinIdleSlice ? 1 : hasIdleBudget ? (warming ? 8 : 4) : (warming ? 8 : document.hidden ? 1 : 4);
    // Finish an in-flight walk before accepting another overlapping refresh.
    // A mutation-heavy page can otherwise grow walkers faster than we drain them.
    if (!pendingWalkers.length) for (const [node, refresh] of pendingNodes) {
      pendingNodes.delete(node);
      if (!node.isConnected && node !== document) continue;
      const surface = node instanceof ShadowRoot ? node.host : node;
      // The quiet-period timer will enqueue this region once. Walking every
      // descendant now merely rediscovers that the same ancestor is changing.
      if (surface instanceof HTMLElement && inChangingRegion(surface)) continue;
      if (node instanceof Element) { if (refresh) visited.delete(node); pendingChecks.add(node); }
      pendingWalkers.push({ walker: document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, {
        acceptNode: descendant => changingRegions.has(descendant as HTMLElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      }), refresh });
    }
    let processed = 0;
    while (pendingChecks.size || pendingWalkers.length) {
      if (pendingChecks.size && (!pendingWalkers.length || processed % 2 === 0)) {
        const element = pendingChecks.values().next().value!;
        pendingChecks.delete(element);
        if (element.isConnected) inspectElement(element);
      } else {
        const next = pendingWalkers[0];
        if (!next.walker.root.isConnected) { pendingWalkers.shift(); continue; }
        const surface = next.walker.root instanceof ShadowRoot ? next.walker.root.host : next.walker.root;
        if (surface instanceof HTMLElement && inChangingRegion(surface)) { pendingWalkers.shift(); continue; }
        const node = next.walker.nextNode();
        if (!node) {
          if (next.walker.root === document && !initialDiscoveryComplete) {
            initialDiscoveryComplete = true;
            renderingWarmupEnds = performance.now() + 2000;
          }
          pendingWalkers.shift(); continue;
        }
        inspectElement(node as Element, next.refresh);
      }
      if (++processed >= (promptContinuation ? 180 : 40) ||
          performance.now() - start >= timeBudget || (hasIdleBudget && deadline.timeRemaining() <= 1 && performance.now() - start >= 1)) break;
    }
    if (pendingWalkers.length || pendingNodes.size || pendingChecks.size) scheduleScan(promptContinuation ? 16 : 250);
    else updateInteractions();
    lastScanMs += recordWork("discovery", start);
  };
  const scheduleScan = (delay = 120): void => {
    if (stopped || scanTimer !== undefined || scanIdle !== undefined) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = undefined;
      if (stopped) return;
      // Quiet pages can finish a dense subtree promptly; busy pages keep the
      // small fallback budget. A timeout guarantees forward progress without
      // relying on the browser ever reporting a long idle period.
      if (typeof window.requestIdleCallback === "function") {
        // A visible renderer can deliver only timeout callbacks (no idle
        // periods). Waiting 500ms for every small batch leaves even ordinary
        // pages unoptimized for many seconds. Keep the hidden-tab limit, but
        // bound foreground waiting separately from the per-slice work budget.
        scanIdle = window.requestIdleCallback(deadline => {
          scanIdle = undefined;
          flush(deadline);
        }, {timeout: document.hidden ? 500 : 50});
      } else flush();
    }, delay);
  };
  const mutations = new Map<Document | ShadowRoot, MutationObserver>();
  const backOffRendering = (): void => {
    renderingBackoff = true;
    renderingBackoffCount++;
    pendingContainment.clear();
    if (containmentTimer !== undefined) { clearTimeout(containmentTimer); containmentTimer = undefined; }
    for (const element of [...contained]) uncontain(element);
    for (const element of candidates.keys()) pauseRenderingObservation(element);
    const resume = (): void => {
      renderingResumeTimer = undefined;
      if (stopped) return;
      const quietRemaining = 5000 - (performance.now() - lastRenderingChange);
      if (quietRemaining > 0) { renderingResumeTimer = window.setTimeout(resume, quietRemaining); return; }
      renderingBackoff = false;
      churnWindowStarted = performance.now(); churnRecords = 0; churnStreak = 0; churnCandidates.clear();
      initialRenderingComplete = false; renderingWarmupEnds = performance.now() + 2000;
      for (const [element, candidate] of candidates) reconsiderLayout(element, candidate);
      for (const scope of observedRoots) queueSubtree(scope, true);
      scheduleScan(0);
    };
    renderingResumeTimer = window.setTimeout(resume, 10000);
  };
  const onMutations = (records: MutationRecord[]): void => {
    if (stopped) return;
    let relevant = false;
    let animationsChanged = false;
    const changedAt = performance.now();
    const handledAttributes = new Map<Node, Set<string | null>>();
    for (const record of records) {
      const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      if (record.type === "attributes" && target) {
        // The first record holds the state before this delivery; the DOM holds
        // the final state. Intermediate writes must not be parsed repeatedly,
        // including a class/style toggle that returns to its original value.
        const handled = handledAttributes.get(record.target) ?? new Set<string | null>();
        if (handled.has(record.attributeName)) continue;
        handled.add(record.attributeName); handledAttributes.set(record.target, handled);
      }
      const attributeValue = record.type === "attributes" && target && record.attributeName ? target.getAttribute(record.attributeName) : null;
      if (renderingBackoff) {
        // Rendering caches are already released. Do not keep parsing layout
        // styles or walking candidate ancestors merely to decide not to cache.
        // Motion events and newly inserted media remain independently observed.
        if (record.type === "attributes" && target && record.attributeName &&
            (record.oldValue === attributeValue ||
             (record.attributeName === "style" && ownStyleValues.get(target) === (attributeValue ?? "")))) continue;
        lastRenderingChange = changedAt;
        if (record.type === "childList") {
          for (const node of record.addedNodes) if (node instanceof Element) queueSubtree(node, true);
          relevant ||= [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element);
          animationsChanged ||= relevant;
        } else if (target && record.type === "attributes") {
          if (effects.has(target)) { visited.delete(target); pendingChecks.add(target); relevant = true; }
          if (target instanceof HTMLVideoElement && videos.has(target)) updateVideo(target);
          if ([...animationTargets].some(element => element === target || target.contains(element))) animationsChanged = true;
        }
        continue;
      }
      let refreshDescendants = record.attributeName !== "style";
      // A scroll-controlled ancestor class can change styles for thousands of
      // descendants. Keep their native layout until a full quiet interval;
      // repeatedly rebuilding between short scroll pauses costs more than it
      // saves. Local content/size updates can still settle sooner.
      let settleDelay = record.attributeName === "class" && renderingEnabled ? 1200 : 250;
      if (record.type === "attributes" && target && record.attributeName && record.oldValue === attributeValue) continue;
      if (record.type === "attributes" && record.attributeName === "style" && target) {
        const cssText = attributeValue ?? "";
        if (ownStyleValues.get(target) === cssText) { relevantStyleValues.delete(target); continue; }
        const cached = relevantStyleValues.get(target);
        let previous: Map<string, string>;
        if (cached?.cssText === (record.oldValue ?? "")) previous = cached.values;
        else { previousStyle.cssText = record.oldValue ?? ""; previous = styleValues(previousStyle); }
        const current = styleValues(target.style);
        relevantStyleValues.set(target, { cssText, values: current });
        const names = new Set([...previous.keys(), ...current.keys()]);
        const changed = [...names].filter(name => previous.get(name) !== current.get(name));
        const geometryChanged = changed.some(name => renderingProperty.test(name));
        const effectChanged = changed.some(name => effectProperty.test(name));
        if (!geometryChanged && !effectChanged) continue;
        animationsChanged ||= changed.some(name => /^animation/.test(name));
        // Animated inherited custom properties may affect every descendant.
        // Release once, but do not reapply the whole tree between short pauses
        // of a sticky header/scroll animation.
        if (changed.some(name => name.startsWith("--"))) settleDelay = 1200;
        // A resized carousel wrapper needs new candidate dimensions, not a
        // repeated style discovery of every descendant. Inherited properties,
        // visibility and container queries can change descendant eligibility.
        refreshDescendants = changed.some(name => /^(font|line-height|letter-spacing|word-spacing|display|visibility|writing-mode|white-space|contain|content-visibility|--)/.test(name)) ||
          (geometryChanged && containerLayouts.get(target) !== false);
      }
      if (record.type === "attributes" && target) {
        // Color/price/scroll classes do not imply a new animation. New CSS
        // animations emit animationstart; only revisit known targets here.
        if (record.attributeName === "class" && [...animationTargets].some(element =>
          element === target || target.contains(element))) animationsChanged = true;
      }
      if (target && (record.type === "characterData" || (record.type === "childList" &&
          ![...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element)))) {
        markChanging(target, settleDelay, changedAt);
      }
      if (record.type === "attributes" && target && ["class", "style", "hidden", "open", "width", "height"].includes(record.attributeName ?? "")) {
        const alreadyChanging = inChangingRegion(target);
        markChanging(target, settleDelay, changedAt);
        // Every descendant was released when this changing region started.
        // Repeated scroll variables only extend the quiet period; newly found
        // candidates already check the region before observing or containing.
        if (!alreadyChanging) for (const [element, candidate] of candidates) {
          let current: Element | null = element;
          while (current && !target.contains(current)) current = (current.getRootNode() as ShadowRoot).host ?? null;
          if (current) { uncontain(element); reconsiderLayout(element, candidate); }
        }
      }
      // Release before changed content can be given its old cached size.
      let parent: HTMLElement | null = target ?? null;
      let affectsRendering = false;
      while (parent) {
        if (contained.has(parent)) uncontain(parent);
        // Rejected layouts are cached until relevant content/style changes.
        // Reconsider ancestors too, e.g. a child margin or position was fixed.
        const candidate = candidates.get(parent);
        if (!candidate && lightweightContent.has(parent)) {
          // A short placeholder can later become a real article. Revisit that
          // boundary after its changes settle, without observing it as a
          // rendering target while it is still lightweight.
          markChanging(parent, settleDelay, changedAt);
        }
        if (candidate) {
          affectsRendering = true;
          if (!renderingBackoff) churnCandidates.add(parent);
          markChanging(parent, settleDelay, changedAt);
          reconsiderLayout(parent, candidate);
        }
        parent = parentAcrossShadow(parent) as HTMLElement | null;
      }
      if (affectsRendering) { churnRecords++; lastRenderingChange = changedAt; }
      if (target && record.type === "attributes") {
        visited.delete(target); pendingChecks.add(target);
        if (refreshDescendants && ["class", "hidden", "open", "style"].includes(record.attributeName ?? "")) deferRediscovery(target, Math.max(350, settleDelay));
      }
      if ((target?.matches("style") || target?.closest("style")) ||
          [...record.addedNodes].some(node => node instanceof HTMLStyleElement)) stylesheetChanged();
      if (record.type === "childList") {
        // textContent updates on live counters should not force a document-wide
        // animation/style enumeration on every tick.
        animationsChanged ||= [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element);
        if (target) {
          repeatedGroups.delete(target);
          for (const child of [...target.children].slice(0, limit)) { visited.delete(child); pendingChecks.add(child); }
        }
        for (const node of record.addedNodes) if (node instanceof Element) queueSubtree(node, true);
        if (record.addedNodes.length || record.removedNodes.length) relevant = true;
      } else relevant = true;
    }
    const now = performance.now(), elapsed = now - churnWindowStarted;
    if (renderingEnabled && !renderingBackoff && elapsed >= 1000) {
      // Sustained changes across many rendering targets invalidate native
      // caches faster than they can help. A short burst or one live widget
      // does not trigger this conservative fallback. Keep media/animation
      // controls independent, and retry only after the page becomes quiet.
      renderingChurnRate = Math.round(churnRecords * 1000 / elapsed);
      renderingChurnTargets = churnCandidates.size;
      const heavy = elapsed < 2500 && renderingChurnRate >= 16 && renderingChurnTargets >= 8;
      churnStreak = heavy ? churnStreak + 1 : 0;
      if (churnStreak >= 2) backOffRendering();
      churnWindowStarted = now; churnRecords = 0; churnCandidates.clear();
    }
    if (relevant) scheduleScan();
    if (animationsChanged) scheduleAnimations();
  };
  function queueRoot(scope: Document | ShadowRoot): void {
    if (observedRoots.has(scope)) return;
    observedRoots.add(scope);
    for (const name of activityEvents) scope.addEventListener(name, onActivity, { capture: true, passive: true });
    animationDiscoveryDirty = true;
    const observer = new MutationObserver(onMutations);
    mutations.set(scope, observer);
    observer.observe(scope, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeOldValue: true,
      attributeFilter: ["aria-busy", "data-streaming", "data-is-streaming", "controls", "muted", "autoplay", "loop", "class", "style", "hidden", "open", "role", "inert", "contenteditable", "aria-hidden", "aria-setsize", "aria-rowindex", "src", "srcset", "sizes", "width", "height", "data-resource-governor-ai-candidate"] });
    scope.addEventListener("animationstart", scheduleAnimations, true);
    scope.addEventListener("animationcancel", scheduleAnimations, true);
    scope.addEventListener("animationend", scheduleAnimations, true);
    // Ordinary finite transitions are left native. Only Reduced Motion needs
    // their start event to discover and shorten them.
    if (enabled("reducedMotionMode")) scope.addEventListener("transitionrun", scheduleAnimations, true);
    scope.addEventListener("play", onPlay, true);
    scope.addEventListener("volumechange", onVideoState, true);
    scope.addEventListener("enterpictureinpicture", onVideoState, true);
    scope.addEventListener("leavepictureinpicture", onVideoState, true);
    scope.addEventListener("load", onIntrinsicSize, true);
    scope.addEventListener("loadedmetadata", onIntrinsicSize, true);
    scope.addEventListener("pointerdown", onMediaIntent, true);
    scope.addEventListener("keydown", onMediaIntent, true);
    // Reattached shadow components need rediscovery; the initial document walk
    // should keep its visited cache when mutation and tree-walk queues overlap.
    queueSubtree(scope, scope instanceof ShadowRoot);
  }
  function forgetRoot(scope: Document | ShadowRoot): void {
    for (const name of activityEvents) scope.removeEventListener(name, onActivity, true);
    animationDiscoveryDirty = true;
    mutations.get(scope)?.disconnect();
    mutations.delete(scope);
    scope.removeEventListener("animationstart", scheduleAnimations, true);
    scope.removeEventListener("animationcancel", scheduleAnimations, true);
    scope.removeEventListener("animationend", scheduleAnimations, true);
    scope.removeEventListener("transitionrun", scheduleAnimations, true);
    scope.removeEventListener("play", onPlay, true);
    scope.removeEventListener("volumechange", onVideoState, true);
    scope.removeEventListener("enterpictureinpicture", onVideoState, true);
    scope.removeEventListener("leavepictureinpicture", onVideoState, true);
    scope.removeEventListener("load", onIntrinsicSize, true);
    scope.removeEventListener("loadedmetadata", onIntrinsicSize, true);
    scope.removeEventListener("pointerdown", onMediaIntent, true);
    scope.removeEventListener("keydown", onMediaIntent, true);
  }
  function onIntrinsicSize(event: Event): void {
    if (!(event.target instanceof Element)) return;
    if (event.target instanceof HTMLLinkElement && event.target.rel === "stylesheet") { stylesheetChanged(); return; }
    let element: Element | null = event.target;
    while (element) {
      const candidate = candidates.get(element as HTMLElement);
      if (candidate) { uncontain(element as HTMLElement); reconsiderLayout(element as HTMLElement, candidate); }
      visited.delete(element); pendingChecks.add(element);
      element = parentAcrossShadow(element);
    }
    scheduleScan();
  }
  function scheduleAnimations(): void {
    if (stopped || !animationsEnabled || animationTimer !== undefined) return;
    animationTimer = window.setTimeout(() => { animationTimer = undefined; updateAnimations(true); }, 40);
  }
  function onPlay(event: Event): void {
    if (event.target instanceof Element) protectShadowSurface(event.target);
    if (event.target instanceof HTMLVideoElement && videos.has(event.target)) updateVideo(event.target);
    releaseProtected();
  }
  function onVideoState(event: Event): void {
    // muted is a property, not the muted content attribute. A site can unmute
    // or enter PiP without any DOM mutation or intersection notification.
    if (event.target instanceof HTMLVideoElement && videos.has(event.target)) updateVideo(event.target);
  }
  function onMediaIntent(event: Event): void {
    if (!event.isTrusted) return;
    const target = event.target;
    const path = event.composedPath();
    const video = path.find(node => node instanceof HTMLVideoElement) ??
      (target instanceof Element ? target.closest('[role="group"],figure,div')?.querySelector("video") : null);
    if (video instanceof HTMLVideoElement) {
      manualVideos.add(video);
      // Do not automatically start a video the user just chose to pause.
      pausedVideos.delete(video);
    }
    releaseProtected();
  }
  function releaseProtected(): void {
    for (const element of contained) if (protectedContent(element)) uncontain(element);
    if (interactionTimer === undefined) interactionTimer = window.setTimeout(() => {
      interactionTimer = undefined;
      updateInteractions();
    }, 180);
  }
  const resize = (): void => {
    for (const element of [...contained]) uncontain(element);
    for (const [element, candidate] of candidates) {
      near.delete(element);
      candidate.near = isNear(element);
      reconsiderLayout(element, candidate);
    }
    for (const scope of observedRoots) deferRediscovery(scope);
    releaseProtected();
  };
  function stylesheetChanged(): void {
    if (stopped) return;
    resize();
    for (const scope of observedRoots) queueSubtree(scope, true);
    scheduleScan();
  }
  const beforePrint = (): void => { printing = true; for (const element of [...contained]) uncontain(element); };
  const afterPrint = (): void => { printing = false; releaseProtected(); };
  const visibility = (): void => {
    if (!document.hidden && (pendingWalkers.length || pendingNodes.size || pendingChecks.size || pendingContainment.size)) {
      // A timer/idle callback queued while hidden can stay throttled after the
      // tab is shown. Resume one bounded discovery slice now, then yield using
      // the existing budgets instead of waiting on that background callback.
      if (scanTimer !== undefined) { clearTimeout(scanTimer); scanTimer = undefined; }
      if (scanIdle !== undefined) { window.cancelIdleCallback(scanIdle); scanIdle = undefined; }
      flush();
      if (containmentTimer !== undefined) { clearTimeout(containmentTimer); containmentTimer = undefined; }
      if (pendingContainment.size) containmentTimer = window.setTimeout(drainContainment, 0);
    }
    updateAnimations(true);
    for (const video of videos) updateVideo(video);
  };
  const probe = (): PageOptimizerMetrics => {
    const items: PageOptimizerMetrics["items"] = {};
    const count = (id: Id) => items[id] ??= { detected: 0, applied: 0, skipped: 0 };
    for (const id of Object.keys(configuration) as Id[]) if (enabled(id) && id !== "chatgptConversationOptimizer") count(id);
    for (const [element, candidate] of candidates) {
      if (!element.isConnected) continue;
      const metric = count(candidate.id);
      metric.detected++;
      if (contained.has(element)) {
        metric.applied++;
        const child = element.firstElementChild;
        if (skippedState.get(element) === true || (child && typeof child.checkVisibility === "function" && child.checkVisibility() && !child.checkVisibility({ contentVisibilityAuto: true }))) metric.skipped++;
      }
    }
    for (const element of effects) if (element.isConnected) {
      count("visualEffectsReducer").detected++;
      if ([...(styles.get(element)?.entries() ?? [])].some(([property, owned]) =>
        ["backdrop-filter", "box-shadow"].includes(property) && element.style.getPropertyValue(property) === owned.applied &&
        element.style.getPropertyPriority(property) === owned.appliedPriority)) count("visualEffectsReducer").applied++;
    }
    if (enabled("animationLimiter")) count("animationLimiter").detected = repeatingAnimations.size;
    if (enabled("backgroundAnimationPause")) count("backgroundAnimationPause").detected = repeatingAnimations.size;
    for (const reason of pausedAnimations.values()) count(reason).applied++;
    if (enabled("reducedMotionMode")) {
      count("reducedMotionMode").detected = changedRates.size;
      count("reducedMotionMode").applied = changedRates.size;
    }
    if (enabled("offscreenMediaPause")) {
      count("offscreenMediaPause").detected = [...videos].filter(video => video.isConnected && video.autoplay && video.loop && video.muted && !video.controls).length;
      count("offscreenMediaPause").applied = pausedVideos.size;
    }
    return { runtimeActive: !stopped, items, configurationKey, ...workMetrics(), observedTargetCount: observedElements.size, changingRegionCount: changingRegions.size, renderingBackoff, renderingBackoffCount, renderingChurnRate, renderingChurnTargets, discoveryComplete: !renderingBackoff && changingRegions.size === 0 && dirtySubtrees.size === 0 && pendingNodes.size === 0 && pendingChecks.size === 0 && pendingWalkers.length === 0 && pendingContainment.size === 0 && containmentTimer === undefined && scanTimer === undefined && scanIdle === undefined, scanDurationMs: Math.round(lastScanMs * 100) / 100 };
  };
  const stop = (): void => {
    stopped = true;
    scrolling.clear();
    intersection.disconnect();
    for (const element of observedElements) element.removeEventListener("contentvisibilityautostatechange", onSkip);
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    if (scanIdle !== undefined) window.cancelIdleCallback(scanIdle);
    if (interactionTimer !== undefined) clearTimeout(interactionTimer);
    if (animationTimer !== undefined) clearTimeout(animationTimer);
    if (rediscoveryTimer !== undefined) clearTimeout(rediscoveryTimer);
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    if (containmentTimer !== undefined) clearTimeout(containmentTimer);
    if (renderingResumeTimer !== undefined) clearTimeout(renderingResumeTimer);
    for (const scope of observedRoots) {
      forgetRoot(scope);
    }
    document.removeEventListener("selectionchange", releaseProtected, true);
    document.removeEventListener("focusin", releaseProtected, true);
    document.removeEventListener("focusout", releaseProtected, true);
    document.removeEventListener("fullscreenchange", releaseProtected, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("resize", resize);
    document.fonts.removeEventListener("loadingdone", stylesheetChanged);
    window.removeEventListener("beforeprint", beforePrint);
    window.removeEventListener("afterprint", afterPrint);
    for (const element of [...contained]) uncontain(element);
    for (const [element, properties] of [...styles]) for (const property of [...properties.keys()]) restoreStyle(element, property);
    for (const animation of [...pausedAnimations.keys()]) resumeAnimation(animation);
    for (const animation of [...changedRates.keys()]) restoreAnimationRate(animation);
    for (const video of [...pausedVideos]) resumeVideo(video);
    candidates.clear(); pendingNodes.clear(); pendingChecks.clear(); pendingWalkers.length = 0; pendingContainment.clear(); dirtySubtrees.clear(); changingRegions.clear(); observedRoots.clear(); observedElements.clear();
    effects.clear(); animationTargets.clear(); videos.clear(); changedRates.clear();
    animationSnapshot.clear(); churnCandidates.clear();
  };

  host[key] = { stop, probe, configurationKey };
  queueRoot(document);
  document.addEventListener("selectionchange", releaseProtected, true);
  document.addEventListener("focusin", releaseProtected, true);
  document.addEventListener("focusout", releaseProtected, true);
  document.addEventListener("fullscreenchange", releaseProtected, true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("resize", resize);
  document.fonts.addEventListener("loadingdone", stylesheetChanged);
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  if (enabled("reducedMotionMode")) setStyle(document.documentElement, "scroll-behavior", "auto");
  scheduleScan();
  return probe();
}

async function execute(tabId: number, command: Command, configuration?: Configuration): Promise<PageOptimizerMetrics | undefined> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: runPageOptimizerInPage,
    args: [command, configuration ?? {}]
  });
  return results.find(result => result.frameId === 0)?.result ?? results[0]?.result;
}

export const installPageOptimizer = (tabId: number, configuration: Configuration) => execute(tabId, "install", configuration);
export const removePageOptimizer = (tabId: number) => execute(tabId, "remove");
export const probePageOptimizer = (tabId: number) => execute(tabId, "probe");

/** Lifecycle checks must not force layout or rediscover conversation candidates. */
export async function probeOptimizerInstallation(tabId: number) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: function readOptimizerInstallation() {
      const globals = globalThis as typeof globalThis & {
        __resourceGovernorPageOptimizerV1?: { configurationKey?: string };
        __resourceGovernorAiConversationOptimizerV2?: unknown;
      };
      return {
        pageInstalled: Boolean(globals.__resourceGovernorPageOptimizerV1),
        configurationKey: globals.__resourceGovernorPageOptimizerV1?.configurationKey,
        aiInstalled: Boolean(globals.__resourceGovernorAiConversationOptimizerV2)
      };
    }
  });
  return results.find(result => result.frameId === 0)?.result;
}
