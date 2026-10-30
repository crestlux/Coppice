/** Local, event-driven edit evidence. Never sends or persists field contents. */
export function installWorkProtectionMonitor(): void {
  const scope = globalThis as typeof globalThis & {
    __coppiceWorkProtectionV2?: { read(): "clear" | "unsavedWork"; has(element: Element): boolean; dispose(): void };
  };
  if (scope.__coppiceWorkProtectionV2) return;
  const baseline = new WeakMap<Element, string | null>();
  // SPA navigation can detach a large editor long before the next discard check.
  // Tracking edits must not keep that editor or its document subtree alive.
  const dirty = new Set<WeakRef<Element>>();
  const dirtyReferences = new WeakMap<Element, WeakRef<Element>>();
  let overflow = false;
  const controller = new AbortController();
  const options = { capture: true, passive: true, signal: controller.signal };
  type EditorContext = EventTarget & { text?: string };
  let observedContext: { context: WeakRef<EditorContext>; listener: EventListener } | undefined;

  function editable(event: Event): Element | null {
    for (const node of event.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node instanceof HTMLInputElement) {
        if (node.disabled || node.readOnly || ["hidden", "button", "submit", "reset", "image", "search"].includes(node.type)) return null;
        // Autocomplete/combobox also describe addresses and work forms, not only search.
        if (node.getAttribute("role") === "searchbox" || node.closest('[role="search"]') ||
          (node.form?.method === "get" && /^(q|query|search)$/i.test(node.name))) return null;
        return node;
      }
      if (node instanceof HTMLTextAreaElement) return node.disabled || node.readOnly ? null : node;
      if (node instanceof HTMLSelectElement) return node.disabled ? null : node;
      if (node.isContentEditable) {
        let editor = node;
        while (editor.parentElement?.isContentEditable) editor = editor.parentElement;
        return editor;
      }
      if ((node as HTMLElement & { editContext?: unknown }).editContext) return node;
    }
    return null;
  }

  function fingerprint(element: Element, defaults = false): string | null {
    let value: string;
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio"].includes(element.type)) return String(defaults ? element.defaultChecked : element.checked);
      if (element.type === "file") return !defaults && element.files?.length ? null : "empty-file";
      value = defaults ? element.defaultValue : element.value;
    } else if (element instanceof HTMLTextAreaElement) value = defaults ? element.defaultValue : element.value;
    else if (element instanceof HTMLSelectElement) {
      const choices = Array.from(element.options);
      let selectedDefault = -1;
      if (defaults && !element.multiple) {
        for (let i = 0; i < choices.length; i++) if (choices[i].defaultSelected) selectedDefault = i;
        if (selectedDefault < 0 && element.size <= 1) selectedDefault = choices.findIndex(option => !option.disabled &&
          !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled));
      }
      value = choices.map((option, index) => (defaults
        ? element.multiple ? option.defaultSelected : index === selectedDefault
        : option.selected) ? "1" : "0").join("");
    }
    else {
      const context = (element as HTMLElement & { editContext?: { text?: string } }).editContext;
      if (context) value = context.text ?? "";
      else {
        // textContent/querySelectorAll would traverse a huge document before a
        // length check could stop it. Bound collection itself, not just hashing.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        const pieces: string[] = [];
        const deadline = performance.now() + 4;
        let visited = 0, characters = 0, media = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (++visited > 2048 || (visited % 32 === 0 && performance.now() > deadline)) return null;
          if (node instanceof Text) {
            characters += node.length;
            if (characters > 131_072) return null;
            pieces.push(node.data);
          } else if (node instanceof Element && node.matches("img,video,audio,canvas,svg")) media++;
        }
        // Attachment counts detect structural edits without collecting URLs/payloads.
        value = pieces.join("") + ":media:" + media;
      }
    }
    // Large documents need a conservative dirty flag, not a full-document hash on every keystroke.
    if (value.length > 131_072) return null;
    let first = 2166136261, second = 5381;
    for (let i = 0; i < value.length; i++) {
      first = Math.imul(first ^ value.charCodeAt(i), 16777619);
      second = Math.imul(second, 33) ^ value.charCodeAt(i);
    }
    return `${value.length}:${first >>> 0}:${second >>> 0}`;
  }

  function forgetChanged(element: Element): void {
    const reference = dirtyReferences.get(element);
    if (reference) dirty.delete(reference);
    dirtyReferences.delete(element);
  }
  function pruneDetached(): void {
    for (const reference of dirty) {
      const element = reference.deref();
      if (!element || !element.isConnected) {
        dirty.delete(reference);
        if (element) dirtyReferences.delete(element);
      }
    }
  }
  function markChanged(element: Element): void {
    if (dirtyReferences.has(element)) return;
    if (dirty.size >= 128) pruneDetached();
    if (dirty.size >= 128) { overflow = true; return; }
    const reference = new WeakRef(element);
    dirty.add(reference);
    dirtyReferences.set(element, reference);
  }
  function releaseContext(): void {
    observedContext?.context.deref()?.removeEventListener("textupdate", observedContext.listener, true);
    observedContext = undefined;
  }
  function observeContext(element: Element): void {
    const context = (element as HTMLElement & { editContext?: EditorContext }).editContext;
    if (context === observedContext?.context.deref()) return;
    releaseContext();
    if (!context) return;
    // The active editor may be detached without a blur event. Neither the
    // listener nor its cleanup handle should retain that editor or its buffer.
    const reference = new WeakRef(element);
    const listener: EventListener = event => {
      if (!event.isTrusted) return;
      const editor = reference.deref();
      if (editor?.isConnected) markChanged(editor);
    };
    context.addEventListener("textupdate", listener, true);
    observedContext = { context: new WeakRef(context), listener };
  }
  function before(event: Event): void {
    if (!event.isTrusted) return;
    const element = editable(event);
    if (!element) return;
    if (!baseline.has(element)) {
      // A late install must not relabel an already edited native field as clean
      // merely because the person focuses it again. Preserve browser evidence.
      const touched = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) &&
        element.matches(":user-valid, :user-invalid");
      baseline.set(element, fingerprint(element, touched));
      if (touched && baseline.get(element) !== fingerprint(element)) markChanged(element);
    }
    observeContext(element);
  }
  function changed(event: Event): void {
    if (!event.isTrusted) return;
    const element = editable(event);
    if (!element) return;
    markChanged(element);
  }
  for (const name of ["focusin", "pointerdown", "keydown", "beforeinput"]) document.addEventListener(name, before, options);
  for (const name of ["input", "change"]) document.addEventListener(name, changed, options);
  document.addEventListener("focusout", releaseContext, options);
  document.addEventListener("reset", event => {
    if (!event.isTrusted) return;
    // A task runs after all reset listeners and the native default action;
    // microtasks can run between trusted event listeners before cancellation.
    setTimeout(() => {
      if (controller.signal.aborted || event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      // Native reset does not clear contenteditable/EditContext documents.
      // Use .form semantics, including controls associated from outside the form.
      for (const element of event.target.elements) if ((element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && element.form === event.target) {
        forgetChanged(element);
        baseline.delete(element);
      }
    }, 0);
  }, options);
  // Submission alone is not proof of saving: validation or the network request can fail.
  scope.__coppiceWorkProtectionV2 = {
    has(element) { return baseline.has(element); },
    read() {
      pruneDetached();
      for (const reference of dirty) {
        const element = reference.deref();
        if (!element) { dirty.delete(reference); continue; }
        const initial = baseline.get(element), current = fingerprint(element);
        if (initial != null && current != null && initial === current) { forgetChanged(element); continue; }
        return "unsavedWork";
      }
      return overflow ? "unsavedWork" : "clear";
    },
    dispose() { controller.abort(); releaseContext(); dirty.clear(); delete scope.__coppiceWorkProtectionV2; }
  };
}
