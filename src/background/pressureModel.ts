import type { AdaptivePressure, PressureSnapshot, Settings } from "../shared/types";

const MiB = 1024 ** 2;
const MINUTE = 60_000;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export function memoryBoundaries(capacity: number, settings: Settings) {
  // Percentages alone overreact on large-memory machines. These are upper
  // bounds for low headroom, not estimates of Chrome's resident memory.
  const high = Math.min(capacity * settings.memoryHighAvailableRatio, 4096 * MiB);
  const emergency = Math.min(capacity * settings.memoryEmergencyAvailableRatio, 1024 * MiB, high);
  return { high, emergency, margin: Math.min(capacity * 0.02, 512 * MiB) };
}

function rawLevel(snapshot: PressureSnapshot, settings: Settings): PressureSnapshot["level"] {
  if (snapshot.memorySampleValid === false || snapshot.memoryCapacityBytes <= 0) return "normal";
  const { high, emergency } = memoryBoundaries(snapshot.memoryCapacityBytes, settings);
  return snapshot.memoryAvailableBytes <= emergency ? "emergency"
    : snapshot.memoryAvailableBytes <= high ? "high" : "normal";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Bounded, time-aware state; callers own I/O and decide whether this sample is committed. */
export function derivePressureSnapshot(
  current: PressureSnapshot, history: readonly PressureSnapshot[], settings: Settings
): PressureSnapshot {
  const recent = history.filter(item => Number.isFinite(item.sampledAt) &&
    item.sampledAt < current.sampledAt && current.sampledAt - item.sampledAt <= 10 * MINUTE &&
    item.memoryCapacityBytes === current.memoryCapacityBytes)
    .sort((a, b) => a.sampledAt - b.sampledAt).slice(-19);
  // A sleep/wake gap is a new observation period, not sustained pressure.
  let start = 0;
  const all = [...recent, current];
  for (let i = 1; i < all.length; i++) {
    if (all[i].sampledAt - all[i - 1].sampledAt > 6 * MINUTE) start = i;
  }
  const samples = all.slice(start);
  const prior = samples.at(-2);
  const compatible = prior?.adaptive?.highBoundaryBytes === memoryBoundaries(current.memoryCapacityBytes, settings).high &&
    prior?.adaptive?.emergencyBoundaryBytes === memoryBoundaries(current.memoryCapacityBytes, settings).emergency &&
    prior?.adaptive?.cpuHighBoundary === settings.cpuHighRatio;
  const previous = compatible ? prior?.adaptive : undefined;
  const deltaSeconds = prior ? (current.sampledAt - prior.sampledAt) / 1000 : 0;
  const validMemory = current.memorySampleValid !== false && current.memoryCapacityBytes > 0;
  const validCpu = current.cpuUsageRatio != null && Number.isFinite(current.cpuUsageRatio);
  const { high, emergency, margin } = memoryBoundaries(current.memoryCapacityBytes, settings);
  const rawMemoryLevel = rawLevel(current, settings);
  const memoryHighSeconds = rawMemoryLevel !== "normal" && prior && rawLevel(prior, settings) !== "normal"
    ? Math.min(600, (previous?.memoryHighSeconds ?? 0) + deltaSeconds) : 0;
  const cpuHigh = validCpu && current.cpuUsageRatio! >= settings.cpuHighRatio;
  const cpuHighSeconds = cpuHigh && prior?.cpuUsageRatio != null && prior.cpuUsageRatio >= settings.cpuHighRatio
    ? Math.min(600, (previous?.cpuHighSeconds ?? 0) + deltaSeconds) : 0;
  const alpha = prior ? 1 - Math.exp(-deltaSeconds / 90) : 1;
  const smooth = (value: number | null, last: number | null | undefined) =>
    value == null ? null : last == null ? value : last + alpha * (value - last);
  const smoothedAvailableRatio = smooth(validMemory ? current.memoryAvailableRatio : null, previous?.smoothedAvailableRatio);
  const smoothedCpuRatio = smooth(validCpu ? current.cpuUsageRatio : null, previous?.smoothedCpuRatio);
  const previousLevel = previous ? prior!.level : "normal";
  const recoveryBoundary = (previousLevel === "emergency" ? emergency : high) + margin;
  const recovering = validMemory && previousLevel !== "normal" &&
    current.memoryAvailableBytes > recoveryBoundary;
  const recoverySeconds = recovering && prior!.memoryAvailableBytes > recoveryBoundary
    ? (previous?.recoverySeconds ?? 0) + deltaSeconds : 0;

  let level: PressureSnapshot["level"] = "normal";
  if (validMemory) {
    if (rawMemoryLevel === "emergency") level = "emergency"; // Act immediately at critical headroom.
    else if (previousLevel !== "normal" && recoverySeconds < 60) level = previousLevel;
    else if (rawMemoryLevel === "high" && memoryHighSeconds >= 30) level = "high";
    else if (previousLevel === "emergency" && current.memoryAvailableBytes <= high + margin) level = "high";
  }
  const trendSamples = samples.filter(item => item.memorySampleValid !== false &&
    current.sampledAt - item.sampledAt <= 5 * MINUTE);
  const slopes: number[] = [];
  if (trendSamples.length >= 3 &&
    trendSamples.at(-1)!.sampledAt - trendSamples[0].sampledAt >= MINUTE) {
    for (let i = 0; i < trendSamples.length; i++) {
      for (let j = i + 1; j < trendSamples.length; j++) {
        const elapsed = trendSamples[j].sampledAt - trendSamples[i].sampledAt;
        if (elapsed >= 15_000) slopes.push(
          (trendSamples[j].memoryAvailableBytes - trendSamples[i].memoryAvailableBytes) / elapsed * MINUTE);
      }
    }
  }
  const availableTrendBytesPerMinute = slopes.length ? median(slopes) : null;
  const secondsToEmergency = validMemory && availableTrendBytesPerMinute != null &&
    availableTrendBytesPerMinute < -current.memoryCapacityBytes * 0.001 &&
    current.memoryAvailableBytes > emergency
    ? (current.memoryAvailableBytes - emergency) / -availableTrendBytesPerMinute * 60 : null;
  const earlyWarning = secondsToEmergency != null && secondsToEmergency <= 120;
  const cpuRecovering = validCpu && current.cpuUsageRatio! < settings.cpuHighRatio - 0.08;
  const cpuRecoverySeconds = cpuRecovering && prior?.cpuUsageRatio != null && prior.cpuUsageRatio < settings.cpuHighRatio - 0.08
    ? (previous?.cpuRecoverySeconds ?? 0) + deltaSeconds : 0;
  const cpuLevel = !validCpu ? "unknown" : cpuHighSeconds >= 30 ||
    (previous && prior?.cpuLevel === "high" && cpuRecoverySeconds < 30) ? "high" : "normal";
  const stage: AdaptivePressure["stage"] = !validMemory ? "unknown"
    : (level === "emergency" && rawMemoryLevel !== "emergency") || (level === "high" && rawMemoryLevel === "normal") ? "recovering"
    : level === "emergency" ? "emergency" : level === "high" ? "high"
    : rawMemoryLevel !== "normal" || earlyWarning || (cpuHigh && cpuHighSeconds < 30) ? "watch" : "steady";
  const severity = validMemory ? clamp(
    (high + margin - Math.min(current.memoryAvailableBytes, (smoothedAvailableRatio ?? 1) * current.memoryCapacityBytes)) /
    Math.max(1, high + margin - emergency), 0, 1) : 0;
  const evidence = [
    !validMemory ? "Memory reading unavailable; memory pressure is not inferred."
      : stage === "watch" ? "Confirming a pressure signal before shortening tab inactivity."
      : stage === "recovering" ? "Headroom is recovering; waiting for a stable exit before restoring normal policy."
      : level === "emergency" ? "Critical available memory requires prompt, bounded relief."
      : level === "high" ? "Low memory headroom has persisted across observations."
      : "Memory headroom is stable; keep recently used tabs available.",
    `Memory signal observed for ${Math.round(memoryHighSeconds)} s; CPU signal for ${Math.round(cpuHighSeconds)} s.`
  ];
  if (validMemory) evidence.push(`Available memory: ${Math.round(current.memoryAvailableBytes / MiB)} MiB; high boundary ${Math.round(high / MiB)} MiB, critical boundary ${Math.round(emergency / MiB)} MiB.`);
  if (availableTrendBytesPerMinute != null) evidence.push(`Recent available-memory trend: ${Math.round(availableTrendBytesPerMinute / MiB)} MiB/min across ${trendSamples.length} samples; this is an observation, not a guaranteed forecast.`);
  if (earlyWarning) evidence.push("Recent headroom decline projects a critical boundary within two minutes; sampling sooner.");
  if (current.cpuSampleWindowMs != null) evidence.push(`System CPU is averaged over ${Math.round(current.cpuSampleWindowMs / 1000)} s; it does not identify the responsible process.`);
  if (!validCpu) evidence.push("CPU needs two recent, valid counter samples.");
  return {
    ...current, level, cpuLevel,
    cause: level !== "normal" ? cpuLevel === "high" ? "combined" : "memory" : cpuLevel === "high" ? "cpu" : "none",
    adaptive: { stage, rawMemoryLevel, smoothedAvailableRatio, smoothedCpuRatio,
      memoryHighSeconds, cpuHighSeconds, cpuRecoverySeconds, cpuHighBoundary: settings.cpuHighRatio, recoverySeconds, sampleCount: samples.length,
      observationSeconds: (current.sampledAt - samples[0].sampledAt) / 1000,
      availableTrendBytesPerMinute, secondsToEmergency, highBoundaryBytes: high, emergencyBoundaryBytes: emergency,
      severity, evidence }
  };
}

export function adaptivePolicyParameters(settings: Settings, pressure: PressureSnapshot, idleState: chrome.idle.IdleState) {
  const stage = pressure.adaptive?.stage ?? (pressure.level === "normal" ? "steady" : pressure.level);
  const severity = pressure.adaptive?.severity ?? (pressure.level === "emergency" ? 1 : 0.6);
  const away = idleState !== "active";
  let inactiveMinutes = away ? 30 : 45;
  let batchLimit = 1;
  let scanMinutes = clamp(settings.scanIntervalMinutes * (away ? 3 : 2), 0.5, 5);
  if (stage === "unknown") { inactiveMinutes = 30; batchLimit = 0; scanMinutes = 1; }
  if (stage === "watch") { inactiveMinutes = 20; batchLimit = 0; scanMinutes = 0.5; }
  if (stage === "recovering") { inactiveMinutes = 30; batchLimit = 0; scanMinutes = 0.5; }
  if (stage === "high") {
    inactiveMinutes = Math.max(5, Math.round(12 - 7 * severity - (away ? 2 : 0)));
    batchLimit = Math.ceil(2 + severity * 3); scanMinutes = 0.5;
  }
  if (stage === "emergency") {
    inactiveMinutes = Math.max(2, Math.round(4 - severity * 2));
    batchLimit = 8; scanMinutes = 0.5;
  }
  if (pressure.cpuLevel === "high") { scanMinutes = 0.5; batchLimit = Math.min(2, Math.max(1, batchLimit)); }
  return { inactiveMinutes, batchLimit: Math.min(settings.maxAutoDiscardsPerScan, batchLimit), scanMinutes };
}
