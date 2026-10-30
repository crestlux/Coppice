import type { PolicyMode, PowerStateSnapshot, Settings } from "../shared/types";
import { savePowerState } from "../shared/storage";

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
let creatingOffscreenDocument: Promise<void> | null = null;
let batteryReadPromise: Promise<BatteryBridgeResponse> | null = null;

interface BatteryBridgeResponse {
  supported: boolean;
  charging?: boolean;
  level?: number;
  dischargingTime?: number | null;
  reason?: string;
}

export function effectivePolicyForPower(
  settings: Pick<Settings, "policyMode" | "powerPolicyMode" | "lowBatteryThreshold">,
  battery: Pick<PowerStateSnapshot, "supported" | "charging" | "level">
): { policyMode: PolicyMode; applied: boolean; reason: string } {
  if (settings.powerPolicyMode === "off") {
    return { policyMode: settings.policyMode, applied: false, reason: "Power policy is disabled." };
  }
  if (
    !battery.supported ||
    battery.charging == null ||
    battery.level == null ||
    !Number.isFinite(battery.level) ||
    battery.level < 0 ||
    battery.level > 1
  ) {
    return { policyMode: settings.policyMode, applied: false, reason: "Battery status is unavailable." };
  }
  if (battery.charging) {
    return { policyMode: settings.policyMode, applied: false, reason: "External power is connected." };
  }
  if (settings.policyMode === "manual") {
    return { policyMode: "manual", applied: false, reason: "Manual policy remains active on battery." };
  }

  if (settings.powerPolicyMode === "lowBatteryAggressive" && battery.level <= settings.lowBatteryThreshold) {
    return { policyMode: "aggressive", applied: true, reason: "Low battery aggressive policy is active." };
  }

  return {
    policyMode: settings.policyMode,
    applied: true,
    reason: "Bounded battery-saver adjustments are active."
  };
}

async function ensureOffscreenDocument(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length > 0) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["BATTERY_STATUS"],
        justification: "Read charging and battery level for the user-configured power policy."
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }
  await creatingOffscreenDocument;
}

async function readBatteryBridge(): Promise<BatteryBridgeResponse> {
  if (batteryReadPromise) return batteryReadPromise;
  batteryReadPromise = (async () => {
    try {
      await ensureOffscreenDocument();
      return await chrome.runtime.sendMessage<BatteryBridgeResponse>({
        target: "resource-governor-offscreen",
        action: "getBatteryStatus"
      });
    } finally {
      if (typeof chrome.offscreen?.closeDocument === "function") {
        await chrome.offscreen.closeDocument().catch(() => undefined);
      }
    }
  })().finally(() => {
    batteryReadPromise = null;
  });
  return batteryReadPromise;
}

export async function collectPowerState(settings: Settings, options: { persist?: boolean } = {}): Promise<PowerStateSnapshot> {
  const sampledAt = Date.now();
  let response: BatteryBridgeResponse;

  try {
    response = await readBatteryBridge();
  } catch (error) {
    response = {
      supported: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  const base: PowerStateSnapshot = {
    supported: response?.supported === true,
    sampledAt,
    charging: typeof response?.charging === "boolean" ? response.charging : null,
    level: typeof response?.level === "number" && Number.isFinite(response.level)
      ? Math.max(0, Math.min(1, response.level))
      : null,
    dischargingTime:
      typeof response?.dischargingTime === "number" && Number.isFinite(response.dischargingTime)
        ? Math.max(0, response.dischargingTime)
        : null,
    policyApplied: false,
    reason: response?.reason
  };
  const effective = effectivePolicyForPower(settings, base);
  const snapshot: PowerStateSnapshot = {
    ...base,
    policyApplied: effective.applied,
    effectivePolicyMode: effective.policyMode,
    reason: response?.reason ?? effective.reason
  };
  if (options.persist !== false) await savePowerState(snapshot);
  return snapshot;
}
