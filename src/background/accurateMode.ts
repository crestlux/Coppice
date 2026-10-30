import type {
  AccurateModeStatus,
  ActiveTabAccurateMetrics,
  ActiveTabLeakCheckResult,
  LeakCheckSample,
  LeakTrendAnalysis,
  OpenTabsAccurateMetricsResult,
  TabAccurateMetrics
} from "../shared/types";
import { mergeTabAccurateMetrics } from "../shared/storage";
import { getHostname, isHttpUrl } from "../shared/url";

const DEBUGGER_PERMISSION = "debugger";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const DEBUGGER_COMMAND_TIMEOUT_MS = 1200;
const DEBUGGER_DETACH_TIMEOUT_MS = 1000;
const SAMPLE_WINDOW_MS = 250;
const OPEN_TAB_CPU_SAMPLE_MS = 60;
const OPEN_TAB_MEASUREMENT_DELAY_MS = 25;
const OPEN_TAB_MEASUREMENT_CONCURRENCY = 3;
const LEAK_CHECK_SAMPLE_COUNT = 6;
const LEAK_CHECK_SAMPLE_INTERVAL_MS = 1500;
const MEBIBYTE = 1024 * 1024;

let activeTabMeasurementPromise: Promise<ActiveTabAccurateMetrics> | null = null;
let openTabsMeasurementPromise: Promise<OpenTabsAccurateMetricsResult> | null = null;
let leakCheckPromise: Promise<ActiveTabLeakCheckResult> | null = null;

export interface PerformanceMetric {
  name: string;
  value: number;
}

interface PerformanceMetricsResponse {
  metrics?: PerformanceMetric[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => reject(new Error(label)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

function debuggerApi(): ChromeDebuggerApi {
  const api = (chrome as unknown as { debugger?: ChromeDebuggerApi }).debugger;
  if (!api) {
    throw new Error("Debugger API is unavailable. Reload the unpacked extension after the manifest update.");
  }
  return api;
}

const pendingDebuggerAttachments = new Set<Promise<void>>();

async function attachDebugger(debuggerClient: ChromeDebuggerApi, debuggee: ChromeDebuggerDebuggee): Promise<void> {
  const attachment = debuggerClient.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
  pendingDebuggerAttachments.add(attachment);
  try {
    await withTimeout(attachment, DEBUGGER_COMMAND_TIMEOUT_MS, "Debugger attach timed out");
    pendingDebuggerAttachments.delete(attachment);
  } catch (error) {
    // A timeout cannot cancel Chrome's attach request. Clean up a late success
    // and prevent another measurement from racing that pending connection.
    void attachment.then(() => detachDebugger(debuggerClient, debuggee), () => undefined)
      .catch(cleanupError => console.warn("Failed to detach late debugger attachment", cleanupError))
      .finally(() => pendingDebuggerAttachments.delete(attachment));
    throw error;
  }
}

async function detachDebugger(debuggerClient: ChromeDebuggerApi, debuggee: ChromeDebuggerDebuggee): Promise<void> {
  await withTimeout(debuggerClient.detach(debuggee), DEBUGGER_DETACH_TIMEOUT_MS, "Debugger detach timed out");
}

async function sendDebuggerCommand<T>(
  debuggerClient: ChromeDebuggerApi,
  debuggee: ChromeDebuggerDebuggee,
  method: string,
  commandParams?: object
): Promise<T | undefined> {
  return (await withTimeout(
    debuggerClient.sendCommand(debuggee, method, commandParams),
    DEBUGGER_COMMAND_TIMEOUT_MS,
    `${method} timed out`
  )) as T | undefined;
}

export function metricValue(metrics: PerformanceMetric[], name: string): number | undefined {
  const value = metrics.find(metric => metric.name === name)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assertSameNavigation(before: PerformanceMetric[], after: PerformanceMetric[]): void {
  const first = metricValue(before, "NavigationStart");
  const last = metricValue(after, "NavigationStart");
  if (first !== undefined && last !== undefined && first !== last) {
    throw new Error("The tab navigated during measurement. Measure the current page again.");
  }
}

export function computeCpuTaskRatio(startTaskDuration: number | undefined, endTaskDuration: number | undefined, elapsedMs: number): number | undefined {
  if (startTaskDuration == null || endTaskDuration == null || elapsedMs <= 0) {
    return undefined;
  }

  const elapsedSeconds = elapsedMs / 1000;
  const taskDelta = Math.max(0, endTaskDuration - startTaskDuration);
  return Math.min(1, taskDelta / elapsedSeconds);
}

function hasAnyAccurateModeOperation(except?: "active" | "openTabs" | "leakCheck"): boolean {
  return Boolean(
    pendingDebuggerAttachments.size ||
    (except !== "active" && activeTabMeasurementPromise) ||
      (except !== "openTabs" && openTabsMeasurementPromise) ||
      (except !== "leakCheck" && leakCheckPromise)
  );
}

function assertNoCompetingAccurateModeOperation(except?: "active" | "openTabs" | "leakCheck"): void {
  if (hasAnyAccurateModeOperation(except)) {
    throw new Error("Tab memory is already being measured. Wait for it to finish.");
  }
}

async function hasDebuggerPermission(): Promise<boolean> {
  try {
    if (!(chrome as unknown as { debugger?: ChromeDebuggerApi }).debugger) {
      return false;
    }
    return await chrome.permissions.contains({ permissions: [DEBUGGER_PERMISSION] });
  } catch {
    return false;
  }
}

async function getActiveHttpTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== "number" || !tab.url || !isHttpUrl(tab.url)) {
    return null;
  }
  return tab;
}

function statusFromTab(debuggerPermissionGranted: boolean, tab: chrome.tabs.Tab | null): AccurateModeStatus {
  return {
    debuggerPermissionGranted,
    activeTabId: tab?.id,
    activeTabUrl: tab?.url,
    activeTabWindowId: tab?.windowId,
    activeTabTitle: tab?.title,
    activeTabDomain: getHostname(tab?.url) ?? undefined
  };
}

async function getPerformanceMetrics(debuggerClient: ChromeDebuggerApi, tabId: number): Promise<PerformanceMetric[]> {
  const response = await sendDebuggerCommand<PerformanceMetricsResponse>(debuggerClient, { tabId }, "Performance.getMetrics");
  return response?.metrics ?? [];
}

async function disablePerformanceMetrics(debuggerClient: ChromeDebuggerApi, tabId: number): Promise<void> {
  try {
    await sendDebuggerCommand(debuggerClient, { tabId }, "Performance.disable");
  } catch {
    // Best-effort cleanup before detach. Some targets reject the command after navigation or close.
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await worker(item, index);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tabIdentity(tab: chrome.tabs.Tab, sampledAt: number): Omit<TabAccurateMetrics, "sampledAt"> & { sampledAt: number } {
  return {
    tabId: typeof tab.id === "number" ? tab.id : -1,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    domain: getHostname(tab.url) ?? undefined,
    sampledAt
  };
}

export function metricsToTabAccurateMetrics(
  tab: chrome.tabs.Tab,
  metrics: PerformanceMetric[],
  sampledAt: number,
  cpuTaskRatio?: number
): TabAccurateMetrics {
  return {
    ...tabIdentity(tab, sampledAt),
    jsHeapUsedBytes: metricValue(metrics, "JSHeapUsedSize"),
    jsHeapTotalBytes: metricValue(metrics, "JSHeapTotalSize"),
    cpuTaskRatio,
    documentCount: metricValue(metrics, "Documents"),
    nodeCount: metricValue(metrics, "Nodes")
  };
}

function skippedTabMetrics(tab: chrome.tabs.Tab, sampledAt: number, error: string): TabAccurateMetrics {
  return {
    ...tabIdentity(tab, sampledAt),
    error
  };
}

function metricsToLeakSample(metrics: PerformanceMetric[], sampledAt: number): LeakCheckSample {
  return {
    sampledAt,
    jsHeapUsedBytes: metricValue(metrics, "JSHeapUsedSize"),
    jsHeapTotalBytes: metricValue(metrics, "JSHeapTotalSize"),
    nodeCount: metricValue(metrics, "Nodes")
  };
}

export function analyzeLeakSamples(samples: LeakCheckSample[]): LeakTrendAnalysis {
  const finiteSamples = samples.filter(
    (sample): sample is LeakCheckSample & { jsHeapUsedBytes: number } =>
      typeof sample.jsHeapUsedBytes === "number" && Number.isFinite(sample.jsHeapUsedBytes)
  );

  if (finiteSamples.length < 3) {
    return {
      verdict: "insufficientData",
      reason: "Need at least three finite JS heap samples.",
      increasingSampleCount: 0
    };
  }

  const baselineSample = finiteSamples[0] as LeakCheckSample & { jsHeapUsedBytes: number };
  const finalSample = finiteSamples[finiteSamples.length - 1] as LeakCheckSample & { jsHeapUsedBytes: number };
  const baselineBytes = baselineSample.jsHeapUsedBytes;
  const finalBytes = finalSample.jsHeapUsedBytes;
  const deltaBytes = finalBytes - baselineBytes;
  const durationMs = Math.max(1, finalSample.sampledAt - baselineSample.sampledAt);
  const deltaPercent = baselineBytes > 0 ? deltaBytes / baselineBytes : undefined;
  const slopeBytesPerMinute = deltaBytes / (durationMs / 60_000);
  const increasingSampleCount = finiteSamples.reduce((count, sample, index) => {
    if (index === 0) return count;
    const previous = finiteSamples[index - 1];
    return previous && sample.jsHeapUsedBytes > previous.jsHeapUsedBytes ? count + 1 : count;
  }, 0);
  const firstNodeSample = samples.find(sample => typeof sample.nodeCount === "number");
  const lastNodeSample = [...samples].reverse().find(sample => typeof sample.nodeCount === "number");
  const nodeDelta =
    firstNodeSample?.nodeCount != null && lastNodeSample?.nodeCount != null
      ? lastNodeSample.nodeCount - firstNodeSample.nodeCount
      : undefined;
  const steadyGrowthCount = Math.ceil((finiteSamples.length - 1) * 0.6);
  const significantGrowthBytes = Math.max(10 * MEBIBYTE, baselineBytes * 0.15);
  const likelyLeakGrowthBytes = Math.max(25 * MEBIBYTE, baselineBytes * 0.25);

  if (deltaBytes >= likelyLeakGrowthBytes && increasingSampleCount >= finiteSamples.length - 2) {
    return {
      verdict: "likelyLeak",
      reason: "JS heap grew substantially across nearly every sample.",
      baselineBytes,
      finalBytes,
      deltaBytes,
      deltaPercent,
      slopeBytesPerMinute,
      increasingSampleCount,
      nodeDelta
    };
  }

  if (deltaBytes >= significantGrowthBytes && increasingSampleCount >= steadyGrowthCount) {
    return {
      verdict: "growing",
      reason: "JS heap is trending upward, but the sample window is too short to prove a leak.",
      baselineBytes,
      finalBytes,
      deltaBytes,
      deltaPercent,
      slopeBytesPerMinute,
      increasingSampleCount,
      nodeDelta
    };
  }

  return {
    verdict: "stable",
    reason: deltaBytes <= 0 ? "JS heap did not grow during the sample window." : "Growth stayed below leak thresholds.",
    baselineBytes,
    finalBytes,
    deltaBytes,
    deltaPercent,
    slopeBytesPerMinute,
    increasingSampleCount,
    nodeDelta
  };
}

export async function getAccurateModeStatus(): Promise<AccurateModeStatus> {
  const [debuggerPermissionGranted, tab] = await Promise.all([hasDebuggerPermission(), getActiveHttpTab()]);
  return statusFromTab(debuggerPermissionGranted, tab);
}

export async function measureActiveTabAccurately(): Promise<ActiveTabAccurateMetrics> {
  if (activeTabMeasurementPromise) {
    return activeTabMeasurementPromise;
  }
  assertNoCompetingAccurateModeOperation("active");

  activeTabMeasurementPromise = doMeasureActiveTabAccurately()
    .then(async result => {
      if (result.activeTabId != null) {
        await mergeTabAccurateMetrics([
          {
            tabId: result.activeTabId,
            windowId: result.activeTabWindowId ?? -1,
            url: result.activeTabUrl,
            title: result.activeTabTitle,
            domain: result.activeTabDomain,
            jsHeapUsedBytes: result.jsHeapUsedBytes,
            jsHeapTotalBytes: result.jsHeapTotalBytes,
            cpuTaskRatio: result.cpuTaskRatio,
            documentCount: result.documentCount,
            nodeCount: result.nodeCount,
            sampledAt: result.sampledAt
          }
        ]);
      }
      return result;
    })
    .finally(() => {
      activeTabMeasurementPromise = null;
    });
  return activeTabMeasurementPromise;
}

async function doMeasureActiveTabAccurately(): Promise<ActiveTabAccurateMetrics> {
  const debuggerPermissionGranted = await hasDebuggerPermission();
  if (!debuggerPermissionGranted) {
    throw new Error("Measuring tab memory needs the debugger permission. Reload Coppice in chrome://extensions and try again.");
  }

  const tab = await getActiveHttpTab();
  if (tab?.id == null) {
    throw new Error("No active HTTP tab to measure");
  }

  const debuggee = { tabId: tab.id };
  let attached = false;

  try {
    const debuggerClient = debuggerApi();
    await attachDebugger(debuggerClient, debuggee);
    attached = true;
    await sendDebuggerCommand(debuggerClient, debuggee, "Performance.enable");

    const start = Date.now();
    const startMetrics = await getPerformanceMetrics(debuggerClient, tab.id);
    await delay(SAMPLE_WINDOW_MS);
    const endMetrics = await getPerformanceMetrics(debuggerClient, tab.id);
    assertSameNavigation(startMetrics, endMetrics);
    const elapsedMs = Math.max(1, Date.now() - start);
    const taskDurationSeconds = metricValue(endMetrics, "TaskDuration");

    return {
      ...statusFromTab(true, tab),
      sampledAt: Date.now(),
      sampleWindowMs: elapsedMs,
      jsHeapUsedBytes: metricValue(endMetrics, "JSHeapUsedSize"),
      jsHeapTotalBytes: metricValue(endMetrics, "JSHeapTotalSize"),
      cpuTaskRatio: computeCpuTaskRatio(
        metricValue(startMetrics, "TaskDuration"),
        taskDurationSeconds,
        elapsedMs
      ),
      taskDurationSeconds,
      documentCount: metricValue(endMetrics, "Documents"),
      nodeCount: metricValue(endMetrics, "Nodes")
    };
  } finally {
    if (attached) {
      try {
        const debuggerClient = debuggerApi();
        await disablePerformanceMetrics(debuggerClient, tab.id);
        await detachDebugger(debuggerClient, debuggee);
      } catch (error) {
        console.warn("Failed to detach debugger", error);
      }
    }
  }
}

async function measureOpenTabAccurately(tab: chrome.tabs.Tab): Promise<TabAccurateMetrics> {
  const sampledAt = Date.now();

  if (typeof tab.id !== "number") {
    return skippedTabMetrics(tab, sampledAt, "no tab id");
  }
  if (tab.incognito) {
    return skippedTabMetrics(tab, sampledAt, "incognito");
  }
  if (tab.discarded) {
    return skippedTabMetrics(tab, sampledAt, "discarded");
  }
  if (!isHttpUrl(tab.url)) {
    return skippedTabMetrics(tab, sampledAt, "special URL");
  }

  const debuggee = { tabId: tab.id };
  let attached = false;

  try {
    const debuggerClient = debuggerApi();
    await attachDebugger(debuggerClient, debuggee);
    attached = true;
    await sendDebuggerCommand(debuggerClient, debuggee, "Performance.enable");
    const start = Date.now();
    const startMetrics = await getPerformanceMetrics(debuggerClient, tab.id);
    await delay(OPEN_TAB_CPU_SAMPLE_MS);
    const endMetrics = await getPerformanceMetrics(debuggerClient, tab.id);
    assertSameNavigation(startMetrics, endMetrics);
    const elapsedMs = Math.max(1, Date.now() - start);
    return metricsToTabAccurateMetrics(
      tab,
      endMetrics,
      Date.now(),
      computeCpuTaskRatio(metricValue(startMetrics, "TaskDuration"), metricValue(endMetrics, "TaskDuration"), elapsedMs)
    );
  } catch (error) {
    return skippedTabMetrics(tab, sampledAt, getErrorMessage(error));
  } finally {
    if (attached) {
      try {
        const debuggerClient = debuggerApi();
        await disablePerformanceMetrics(debuggerClient, tab.id);
        await detachDebugger(debuggerClient, debuggee);
      } catch (error) {
        console.warn("Failed to detach debugger", error);
      }
    }
  }
}

export async function measureOpenTabsAccurately(): Promise<OpenTabsAccurateMetricsResult> {
  if (openTabsMeasurementPromise) {
    return openTabsMeasurementPromise;
  }
  assertNoCompetingAccurateModeOperation("openTabs");

  openTabsMeasurementPromise = doMeasureOpenTabsAccurately()
    .then(async result => {
      await mergeTabAccurateMetrics(result.tabs.filter(tab => !tab.error));
      return result;
    })
    .finally(() => {
      openTabsMeasurementPromise = null;
    });
  return openTabsMeasurementPromise;
}

async function doMeasureOpenTabsAccurately(): Promise<OpenTabsAccurateMetricsResult> {
  const debuggerPermissionGranted = await hasDebuggerPermission();
  if (!debuggerPermissionGranted) {
    throw new Error("Measuring tab memory needs the debugger permission. Reload Coppice in chrome://extensions and try again.");
  }

  const tabs = (await chrome.tabs.query({})).sort((a, b) => {
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  });

  const measuredTabs = await mapWithConcurrency(tabs, OPEN_TAB_MEASUREMENT_CONCURRENCY, async tab => {
    const metrics = await measureOpenTabAccurately(tab);
    await delay(OPEN_TAB_MEASUREMENT_DELAY_MS);
    return metrics;
  });

  const measuredCount = measuredTabs.filter(tab => !tab.error && tab.jsHeapUsedBytes != null).length;

  return {
    sampledAt: Date.now(),
    measuredCount,
    failedCount: measuredTabs.length - measuredCount,
    tabs: measuredTabs
  };
}

export async function checkActiveTabLeak(): Promise<ActiveTabLeakCheckResult> {
  if (leakCheckPromise) {
    return leakCheckPromise;
  }
  assertNoCompetingAccurateModeOperation("leakCheck");

  leakCheckPromise = doCheckActiveTabLeak()
    .then(async result => {
      if (result.activeTabId != null) {
        await mergeTabAccurateMetrics([
          {
            tabId: result.activeTabId,
            windowId: result.activeTabWindowId ?? -1,
            url: result.activeTabUrl,
            title: result.activeTabTitle,
            domain: result.activeTabDomain,
            jsHeapUsedBytes: result.finalBytes,
            leakVerdict: result.verdict,
            leakDeltaBytes: result.deltaBytes,
            sampledAt: result.sampledAt
          }
        ]);
      }
      return result;
    })
    .finally(() => {
      leakCheckPromise = null;
    });
  return leakCheckPromise;
}

async function doCheckActiveTabLeak(): Promise<ActiveTabLeakCheckResult> {
  const debuggerPermissionGranted = await hasDebuggerPermission();
  if (!debuggerPermissionGranted) {
    throw new Error("Leak Check requires the debugger permission. Reload the unpacked extension after the manifest update.");
  }

  const tab = await getActiveHttpTab();
  if (tab?.id == null) {
    throw new Error("No active HTTP tab to check");
  }

  const debuggee = { tabId: tab.id };
  const samples: LeakCheckSample[] = [];
  let attached = false;

  try {
    const debuggerClient = debuggerApi();
    await attachDebugger(debuggerClient, debuggee);
    attached = true;
    await sendDebuggerCommand(debuggerClient, debuggee, "Performance.enable");

    let initialMetrics: PerformanceMetric[] | undefined;
    for (let index = 0; index < LEAK_CHECK_SAMPLE_COUNT; index += 1) {
      const sampledAt = Date.now();
      const metrics = await getPerformanceMetrics(debuggerClient, tab.id);
      if (initialMetrics) assertSameNavigation(initialMetrics, metrics);
      else initialMetrics = metrics;
      samples.push(metricsToLeakSample(metrics, sampledAt));
      if (index < LEAK_CHECK_SAMPLE_COUNT - 1) {
        await delay(LEAK_CHECK_SAMPLE_INTERVAL_MS);
      }
    }

    const analysis = analyzeLeakSamples(samples);
    const firstSample = samples[0];
    const lastSample = samples[samples.length - 1];

    return {
      ...statusFromTab(true, tab),
      ...analysis,
      sampledAt: Date.now(),
      sampleIntervalMs: LEAK_CHECK_SAMPLE_INTERVAL_MS,
      sampleCount: samples.length,
      durationMs: firstSample && lastSample ? Math.max(0, lastSample.sampledAt - firstSample.sampledAt) : 0,
      samples
    };
  } finally {
    if (attached) {
      try {
        const debuggerClient = debuggerApi();
        await disablePerformanceMetrics(debuggerClient, tab.id);
        await detachDebugger(debuggerClient, debuggee);
      } catch (error) {
        console.warn("Failed to detach debugger after leak check", error);
      }
    }
  }
}
