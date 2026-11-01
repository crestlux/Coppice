interface ChromeDebuggerDebuggee {
  tabId?: number;
  sessionId?: string;
  extensionId?: string;
  targetId?: string;
}

interface ChromeDebuggerApi {
  onEvent?: ChromeEvent<(source: ChromeDebuggerDebuggee, method: string, params?: object) => void>;
  attach(target: ChromeDebuggerDebuggee, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerDebuggee): Promise<void>;
  sendCommand(target: ChromeDebuggerDebuggee, method: string, commandParams?: object): Promise<object | undefined>;
}

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      id?: string;
      tab?: tabs.Tab;
    }

    const lastError: { message?: string } | undefined;
    const id: string;

    function sendMessage<T = unknown>(message: unknown): Promise<T>;

    interface ExtensionContext {
      contextType: "TAB" | "POPUP" | "BACKGROUND" | "OFFSCREEN_DOCUMENT" | "SIDE_PANEL";
      contextId: string;
      documentUrl?: string;
    }

    function getContexts(filter: {
      contextTypes?: ExtensionContext["contextType"][];
      documentUrls?: string[];
    }): Promise<ExtensionContext[]>;

    function getURL(path: string): string;

    const onInstalled: ChromeEvent<() => void>;
    const onStartup: ChromeEvent<() => void>;
    const onMessage: ChromeEvent<
      (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response?: unknown) => void
      ) => boolean | void
    >;
    function openOptionsPage(): Promise<void>;
  }

  namespace action {
    function setBadgeText(details: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  }

  namespace alarms {
    interface Alarm {
      name: string;
      scheduledTime: number;
      periodInMinutes?: number;
    }

    function create(name: string, alarmInfo: { periodInMinutes: number }): Promise<void>;
    function get(name: string): Promise<Alarm | undefined>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: ChromeEvent<(alarm: Alarm) => void>;
  }

  namespace idle {
    type IdleState = "active" | "idle" | "locked";
    function queryState(detectionIntervalInSeconds: number): Promise<IdleState>;
    const onStateChanged: ChromeEvent<(state: IdleState) => void>;
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }

    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }

    const local: StorageArea;
    const session: StorageArea;
    const sync: StorageArea;
    const onChanged: ChromeEvent<
      (changes: Record<string, StorageChange>, areaName: "local" | "sync" | "managed" | "session") => void
    >;
  }

  namespace offscreen {
    type Reason =
      | "TESTING"
      | "AUDIO_PLAYBACK"
      | "IFRAME_SCRIPTING"
      | "DOM_SCRAPING"
      | "BLOBS"
      | "DOM_PARSER"
      | "USER_MEDIA"
      | "DISPLAY_MEDIA"
      | "WEB_RTC"
      | "CLIPBOARD"
      | "LOCAL_STORAGE"
      | "WORKERS"
      | "BATTERY_STATUS"
      | "MATCH_MEDIA"
      | "GEOLOCATION";

    function createDocument(parameters: { url: string; reasons: Reason[]; justification: string }): Promise<void>;
    function closeDocument(): Promise<void>;
  }

  namespace permissions {
    interface Permissions {
      permissions?: string[];
      origins?: string[];
    }

    function contains(permissions: Permissions): Promise<boolean>;
    function getAll(): Promise<Permissions>;
    function request(permissions: Permissions): Promise<boolean>;
    function remove(permissions: Permissions): Promise<boolean>;
    const onAdded: ChromeEvent<(permissions: Permissions) => void>;
    const onRemoved: ChromeEvent<(permissions: Permissions) => void>;
  }

  namespace scripting {
    interface RegisteredContentScript {
      id: string; js: string[]; matches: string[]; allFrames?: boolean;
      runAt?: "document_start" | "document_end" | "document_idle";
      world?: "ISOLATED" | "MAIN"; persistAcrossSessions?: boolean; matchOriginAsFallback?: boolean;
    }
    function getRegisteredContentScripts(filter?: { ids: string[] }): Promise<RegisteredContentScript[]>;
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { ids: string[] }): Promise<void>;
    interface InjectionTarget {
      tabId: number;
      frameIds?: number[];
      allFrames?: boolean;
    }

    interface CSSInjection {
      target: InjectionTarget;
      css?: string;
      files?: string[];
      origin?: "AUTHOR" | "USER";
    }

    interface InjectionResult<T = unknown> {
      frameId: number;
      documentId?: string;
      result?: T;
      error?: unknown;
    }

    interface ScriptInjection<Args extends unknown[] = unknown[], Result = unknown> {
      target: InjectionTarget;
      args?: Args;
      func?: (...args: Args) => Result;
      files?: string[];
      world?: "ISOLATED" | "MAIN";
      injectImmediately?: boolean;
    }

    function insertCSS(injection: CSSInjection): Promise<void>;
    function removeCSS(injection: CSSInjection): Promise<void>;
    function executeScript<Args extends unknown[], Result>(
      injection: ScriptInjection<Args, Result>
    ): Promise<InjectionResult<Awaited<Result>>[]>;
  }

  namespace system {
    namespace memory {
      interface MemoryInfo {
        capacity: number;
        availableCapacity: number;
      }

      function getInfo(): Promise<MemoryInfo>;
    }

    namespace cpu {
      interface CpuProcessorUsage {
        user: number;
        kernel: number;
        idle: number;
        total: number;
      }

      interface CpuProcessorInfo {
        usage: CpuProcessorUsage;
      }

      interface CpuInfo {
        numOfProcessors: number;
        archName: string;
        modelName: string;
        processors: CpuProcessorInfo[];
      }

      function getInfo(): Promise<CpuInfo>;
    }
  }

  namespace tabs {
    interface Tab {
      id?: number;
      index: number;
      windowId: number;
      groupId?: number;
      active: boolean;
      highlighted?: boolean;
      pinned: boolean;
      audible?: boolean;
      discarded?: boolean;
      frozen?: boolean;
      incognito: boolean;
      autoDiscardable?: boolean;
      url?: string;
      pendingUrl?: string;
      title?: string;
      lastAccessed?: number;
      status?: string;
    }

    interface QueryInfo {
      active?: boolean;
      highlighted?: boolean;
      lastFocusedWindow?: boolean;
      currentWindow?: boolean;
      windowId?: number;
      groupId?: number;
      discarded?: boolean;
      url?: string | string[];
    }

    interface CreateProperties {
      url?: string;
      active?: boolean;
      pinned?: boolean;
      windowId?: number;
      index?: number;
    }

    interface UpdateProperties {
      active?: boolean;
      pinned?: boolean;
      muted?: boolean;
      url?: string;
      highlighted?: boolean;
      autoDiscardable?: boolean;
    }

    interface GroupOptions {
      tabIds: number | number[];
      groupId?: number;
      createProperties?: {
        windowId?: number;
      };
    }

    const TAB_GROUP_ID_NONE: -1;

    function query(queryInfo: QueryInfo): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    function discard(tabId: number): Promise<Tab | undefined>;
    function remove(tabIds: number | number[]): Promise<void>;
    function create(createProperties: CreateProperties): Promise<Tab>;
    function update(tabId: number, updateProperties: UpdateProperties): Promise<Tab>;
    function reload(tabId: number): Promise<void>;
    function group(options: GroupOptions): Promise<number>;

    const onActivated: ChromeEvent<(activeInfo: { tabId: number; windowId: number }) => void>;
    const onCreated: ChromeEvent<(tab: Tab) => void>;
    const onUpdated: ChromeEvent<
      (tabId: number, changeInfo: Partial<Tab> & { status?: string }, tab: Tab) => void
    >;
    const onRemoved: ChromeEvent<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>;
    const onReplaced: ChromeEvent<(addedTabId: number, removedTabId: number) => void>;
    const onMoved: ChromeEvent<(tabId: number, moveInfo: { windowId: number; fromIndex: number; toIndex: number }) => void>;
    const onAttached: ChromeEvent<(tabId: number, attachInfo: { newWindowId: number; newPosition: number }) => void>;
    const onDetached: ChromeEvent<(tabId: number, detachInfo: { oldWindowId: number; oldPosition: number }) => void>;
  }

  namespace tabGroups {
    type Color =
      | "grey"
      | "blue"
      | "red"
      | "yellow"
      | "green"
      | "pink"
      | "purple"
      | "cyan"
      | "orange";

    interface TabGroup {
      id: number;
      collapsed: boolean;
      color: Color;
      title?: string;
      windowId: number;
    }

    function get(groupId: number): Promise<TabGroup>;
    function update(
      groupId: number,
      updateProperties: { title?: string; color?: Color; collapsed?: boolean }
    ): Promise<TabGroup>;
    const onUpdated: ChromeEvent<(group: TabGroup) => void>;
  }

  namespace windows {
    interface Window {
      id?: number;
      tabs?: tabs.Tab[];
    }

    function create(createData: { url?: string; focused?: boolean }): Promise<Window>;
    function get(windowId: number): Promise<Window>;
    function update(windowId: number, updateInfo: { focused?: boolean; state?: string }): Promise<Window>;
  }

  namespace declarativeNetRequest {
    type ResourceType =
      | "main_frame"
      | "sub_frame"
      | "stylesheet"
      | "script"
      | "image"
      | "font"
      | "object"
      | "xmlhttprequest"
      | "ping"
      | "csp_report"
      | "media"
      | "websocket"
      | "webtransport"
      | "webbundle"
      | "other";

    interface Rule {
      id: number;
      priority?: number;
      action: {
        type: "block" | "allow" | "redirect" | "upgradeScheme" | "modifyHeaders" | "allowAllRequests";
      };
      condition: {
        urlFilter?: string;
        resourceTypes?: ResourceType[];
        domainType?: "firstParty" | "thirdParty";
        tabIds?: number[];
      };
    }

    function getDynamicRules(): Promise<Rule[]>;
    function updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: Rule[] }): Promise<void>;
  }

  interface ChromeEvent<T extends (...args: never[]) => unknown> {
    addListener(callback: T): void;
    removeListener(callback: T): void;
    hasListener(callback: T): boolean;
  }
}
