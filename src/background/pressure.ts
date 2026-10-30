import { SESSION_KEYS } from "../shared/constants";
import type { PressureSnapshot, Settings } from "../shared/types";
import { derivePressureSnapshot } from "./pressureModel";

interface CpuSample { idle: number; total: number; sampledAt?: number; processors?: number; }

export function computePressureLevel(
  memoryAvailableRatio: number,
  settings: Pick<Settings, "memoryEmergencyAvailableRatio" | "memoryHighAvailableRatio">
): PressureSnapshot["level"] {
  if (!Number.isFinite(memoryAvailableRatio) || memoryAvailableRatio < 0) return "normal";
  if (memoryAvailableRatio <= settings.memoryEmergencyAvailableRatio) return "emergency";
  if (memoryAvailableRatio <= settings.memoryHighAvailableRatio) return "high";
  return "normal";
}

export function sumCpuTimes(info: chrome.system.cpu.CpuInfo): Pick<CpuSample, "idle" | "total"> {
  return info.processors.reduce((acc, processor) => ({
    idle: acc.idle + processor.usage.idle, total: acc.total + processor.usage.total
  }), { idle: 0, total: 0 });
}

async function sampleCpuUsage(
  info: chrome.system.cpu.CpuInfo,
  options: { persistSample?: boolean; now?: number } = {}
): Promise<{ usageRatio: number | null; windowMs: number | null }> {
  const current = { ...sumCpuTimes(info), sampledAt: options.now ?? Date.now(), processors: info.processors.length };
  const result = await chrome.storage.session.get(SESSION_KEYS.CPU_SAMPLE);
  const previous = result[SESSION_KEYS.CPU_SAMPLE] as CpuSample | undefined;
  const elapsed = previous?.sampledAt == null ? Infinity : current.sampledAt - previous.sampledAt;
  // UI refreshes within one second cannot provide a useful delta and must not
  // keep resetting the baseline. Sleep, topology changes and old schemas reset it.
  if (options.persistSample !== false && (elapsed >= 1000 || elapsed < 0)) {
    await chrome.storage.session.set({ [SESSION_KEYS.CPU_SAMPLE]: current });
  }
  if (!previous || !Number.isFinite(elapsed) || elapsed < 1000 || elapsed > 6 * 60_000 ||
    previous.processors !== current.processors || current.processors === 0 ||
    !Number.isFinite(previous.idle) || !Number.isFinite(previous.total) ||
    !Number.isFinite(current.idle) || !Number.isFinite(current.total)) return { usageRatio: null, windowMs: null };
  const deltaIdle = current.idle - previous.idle;
  const deltaTotal = current.total - previous.total;
  if (deltaTotal <= 0 || deltaIdle < 0 || deltaIdle > deltaTotal) return { usageRatio: null, windowMs: null };
  return { usageRatio: Math.max(0, Math.min(1, 1 - deltaIdle / deltaTotal)), windowMs: elapsed };
}

export async function computeCpuUsageRatio(info: chrome.system.cpu.CpuInfo, options: { persistSample?: boolean; now?: number } = {}): Promise<number | null> {
  return (await sampleCpuUsage(info, options)).usageRatio;
}

export async function collectPressureSnapshot(
  settings: Settings, knownTabs?: chrome.tabs.Tab[],
  options: { persistCpuSample?: boolean; persistHistory?: boolean } = {}
): Promise<PressureSnapshot> {
  const [tabs, memory, cpu, session] = await Promise.all([
    knownTabs ?? chrome.tabs.query({}),
    chrome.system.memory.getInfo().catch(() => null),
    chrome.system.cpu.getInfo().catch(() => null),
    chrome.storage.session.get(SESSION_KEYS.PRESSURE_HISTORY)
  ]);
  const sampledAt = Date.now();
  const memorySampleValid = Boolean(memory && Number.isFinite(memory.capacity) && memory.capacity > 0 &&
    Number.isFinite(memory.availableCapacity) && memory.availableCapacity >= 0 && memory.availableCapacity <= memory.capacity);
  const cpuSample = cpu ? await sampleCpuUsage(cpu, {
    persistSample: options.persistCpuSample, now: sampledAt
  }) : { usageRatio: null, windowMs: null };
  const cpuUsageRatio = cpuSample.usageRatio;
  const raw: PressureSnapshot = {
    sampledAt,
    memorySampleValid,
    memoryCapacityBytes: memorySampleValid ? memory!.capacity : 0,
    memoryAvailableBytes: memorySampleValid ? memory!.availableCapacity : 0,
    memoryAvailableRatio: memorySampleValid ? memory!.availableCapacity / memory!.capacity : 0,
    cpuUsageRatio, cpuSampleWindowMs: cpuSample.windowMs ?? undefined, tabCount: tabs.length,
    discardedTabCount: tabs.filter(tab => tab.discarded).length,
    frozenTabCount: tabs.filter(tab => tab.frozen).length, protectedTabCount: 0, level: "normal"
  };
  const stored = session[SESSION_KEYS.PRESSURE_HISTORY];
  const history: PressureSnapshot[] = Array.isArray(stored) ? stored.filter(item =>
    item && typeof item === "object" && Number.isFinite(item.sampledAt) &&
    item.sampledAt <= sampledAt && sampledAt - item.sampledAt <= 10 * 60_000) : [];
  const snapshot = derivePressureSnapshot(raw, history, settings);
  if ((options.persistHistory ?? options.persistCpuSample !== false) &&
    (!history.length || sampledAt - history.at(-1)!.sampledAt >= 15_000)) {
    await chrome.storage.session.set({ [SESSION_KEYS.PRESSURE_HISTORY]: [...history, snapshot].slice(-20) });
  }
  return snapshot;
}
