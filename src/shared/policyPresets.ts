import { DEFAULT_SETTINGS } from "./constants";
import type { PolicyMode, Settings } from "./types";

const FIXED_THRESHOLD_MINUTES: Record<Exclude<PolicyMode, "custom">, number | null> = {
  manual: null,
  conservative: DEFAULT_SETTINGS.conservativeMinutes,
  balanced: DEFAULT_SETTINGS.balancedMinutes,
  aggressive: DEFAULT_SETTINGS.aggressiveMinutes,
  pressureAdaptive: DEFAULT_SETTINGS.balancedMinutes
};

const FIXED_POLICY_SETTINGS: Record<Exclude<PolicyMode, "custom">, Partial<Settings>> = {
  manual: {
    scanIntervalMinutes: 5,
    maxAutoDiscardsPerScan: 1,
    memoryHighAvailableRatio: DEFAULT_SETTINGS.memoryHighAvailableRatio,
    memoryEmergencyAvailableRatio: DEFAULT_SETTINGS.memoryEmergencyAvailableRatio
  },
  conservative: {
    scanIntervalMinutes: 3,
    maxAutoDiscardsPerScan: 2,
    memoryHighAvailableRatio: 0.12,
    memoryEmergencyAvailableRatio: 0.06
  },
  balanced: {
    scanIntervalMinutes: DEFAULT_SETTINGS.scanIntervalMinutes,
    maxAutoDiscardsPerScan: DEFAULT_SETTINGS.maxAutoDiscardsPerScan,
    memoryHighAvailableRatio: DEFAULT_SETTINGS.memoryHighAvailableRatio,
    memoryEmergencyAvailableRatio: DEFAULT_SETTINGS.memoryEmergencyAvailableRatio
  },
  aggressive: {
    scanIntervalMinutes: 1,
    maxAutoDiscardsPerScan: 12,
    memoryHighAvailableRatio: 0.2,
    memoryEmergencyAvailableRatio: 0.1
  },
  pressureAdaptive: {
    scanIntervalMinutes: 1,
    maxAutoDiscardsPerScan: 8,
    memoryHighAvailableRatio: 0.18,
    memoryEmergencyAvailableRatio: 0.09
  }
};

export const POLICY_MODE_THRESHOLD_PRESETS: Record<PolicyMode, number | null> = {
  ...FIXED_THRESHOLD_MINUTES,
  custom: DEFAULT_SETTINGS.customMinutes
};

export function isPolicyThresholdEditable(mode: PolicyMode): boolean {
  return mode === "custom";
}

export function getThresholdForPolicyMode(settings: Settings, mode: PolicyMode = settings.policyMode): number | null {
  if (mode === "custom") {
    return settings.customMinutes;
  }

  return FIXED_THRESHOLD_MINUTES[mode];
}

export function thresholdPatchForPolicyMode(mode: PolicyMode, minutes: number): Partial<Settings> {
  if (!isPolicyThresholdEditable(mode)) {
    return {};
  }

  return { customMinutes: minutes };
}

export function defaultThresholdPatchForPolicyMode(mode: PolicyMode): Partial<Settings> {
  return mode === "custom" ? { customMinutes: DEFAULT_SETTINGS.customMinutes } : {};
}

export function policySettingsPatchForPolicyMode(mode: PolicyMode, settings?: Settings): Partial<Settings> {
  const fixedThresholds = {
    conservativeMinutes: DEFAULT_SETTINGS.conservativeMinutes,
    balancedMinutes: DEFAULT_SETTINGS.balancedMinutes,
    aggressiveMinutes: DEFAULT_SETTINGS.aggressiveMinutes
  };

  if (mode === "custom") {
    return {
      policyMode: mode,
      ...fixedThresholds,
      customMinutes: settings?.customMinutes ?? DEFAULT_SETTINGS.customMinutes
    };
  }

  return {
    policyMode: mode,
    ...fixedThresholds,
    ...FIXED_POLICY_SETTINGS[mode]
  };
}
