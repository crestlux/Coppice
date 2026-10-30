import { SCAN_ALARM_NAME } from "../shared/constants";
import { ensureStorageDefaults, getSettings, getLastPressure, getWindowPolicies } from "../shared/storage";
import type { Settings, PressureSnapshot } from "../shared/types";
import { syncDnrRules } from "./dnr";
import { runScan } from "./scanner";
import { automaticScanInterval } from "./automation";
import { captureTimelineSnapshot } from "./recovery";
import type { ScanReason } from "../shared/types";
import { reconcileExperimentalOptimizerSettings } from "./optimizer";
import { reconcileWorkProtection } from "./workProtection";

export interface InitializeExtensionOptions {
  runStartupTasks?: boolean;
}

let extensionReady = false;
let extensionReadyPromise: Promise<void> | null = null;
let startupTasksCompleted = false;
let startupTasksPromise: Promise<void> | null = null;
let scanQueue: Promise<void> = Promise.resolve();

export async function ensureScanAlarm(settings?: Settings, pressure?: PressureSnapshot, idleState: chrome.idle.IdleState = "active"): Promise<void> {
  const effectiveSettings = settings ?? (await getSettings());
  const [alarm, lastPressure, windowPolicies] = await Promise.all([chrome.alarms.get(SCAN_ALARM_NAME), pressure ?? getLastPressure(), getWindowPolicies()]);
  const interval = lastPressure && Date.now() >= lastPressure.sampledAt && Date.now() - lastPressure.sampledAt <= 5 * 60_000
    ? automaticScanInterval({ settings: effectiveSettings, windowPolicies }, lastPressure, idleState)
    : effectiveSettings.scanIntervalMinutes;

  if (!alarm || alarm.periodInMinutes !== interval) {
    await chrome.alarms.create(SCAN_ALARM_NAME, {
      periodInMinutes: interval
    });
  }
}

async function ensureExtensionReady(): Promise<void> {
  if (extensionReady) return;
  if (!extensionReadyPromise) {
    extensionReadyPromise = (async () => {
      await ensureStorageDefaults();
      const settings = await getSettings();
      await ensureScanAlarm(settings);
      await syncDnrRules(settings.networkDietMode);
      await reconcileWorkProtection();
      try {
        // storage.session markers survive MV3 worker suspension, so tracked
        // documents are not injected twice. After a browser/extension restart
        // those markers are gone and saved-site tabs are applied once here even
        // if Chrome emits no tabs.onUpdated event for an already open tab.
        await reconcileExperimentalOptimizerSettings(undefined, {
          dedupe: true,
          reapplyTracked: false
        });
      } catch (error) {
        console.warn("Failed to reconcile Experimental Optimizer at startup", error);
      }
      extensionReady = true;
    })().finally(() => {
      extensionReadyPromise = null;
    });
  }
  await extensionReadyPromise;
}

export function runSerializedScan(reason: ScanReason): ReturnType<typeof runScan> {
  const next = scanQueue.then(async () => {
    await ensureExtensionReady();
    const result = await runScan(reason);
    await ensureScanAlarm(result.state.settings, result.pressure, result.idleState);
    return result;
  });
  scanQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function runStartupTasks(): Promise<void> {
  if (startupTasksCompleted) return;
  if (!startupTasksPromise) {
    startupTasksPromise = (async () => {
      await captureTimelineSnapshot("startup");
      await runSerializedScan("startup");
      startupTasksCompleted = true;
    })().finally(() => {
      startupTasksPromise = null;
    });
  }
  await startupTasksPromise;
}

export async function initializeExtension(options: InitializeExtensionOptions = {}): Promise<void> {
  try {
    await ensureExtensionReady();
    if (options.runStartupTasks) {
      await runStartupTasks();
    }
  } catch (error) {
    console.warn("Failed to initialize extension", error);
  }
}
