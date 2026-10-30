import type {
  DiscardLearningRecord,
  DiscardLogEntry,
  EffectHistoryEntry,
  EffectReport24h,
  ExternalDiscardObservation
} from "../shared/types";

const DAY_MS = 24 * 60 * 60_000;

export function buildEffectReport24h(input: {
  history: EffectHistoryEntry[];
  discardLog: DiscardLogEntry[];
  learning: DiscardLearningRecord[];
  externalDiscards: ExternalDiscardObservation[];
  quickReactivateMinutes: number;
  now?: number;
}): EffectReport24h {
  const generatedAt = input.now ?? Date.now();
  const periodStart = generatedAt - DAY_MS;
  const quickReactivateMinutes = Number.isFinite(input.quickReactivateMinutes)
    ? Math.max(0, input.quickReactivateMinutes)
    : 0;
  const quickReactivateWindowMs = quickReactivateMinutes * 60_000;
  const isInReportWindow = (timestamp: number | undefined): timestamp is number =>
    typeof timestamp === "number" &&
    Number.isFinite(timestamp) &&
    timestamp >= periodStart &&
    timestamp <= generatedAt;
  const isQuickReactivation = (entry: DiscardLogEntry): boolean =>
    isInReportWindow(entry.reactivatedAt) &&
    entry.reactivatedAt >= entry.discardedAt &&
    entry.reactivatedAt - entry.discardedAt <= quickReactivateWindowMs;
  const isUndoFeedback = (entry: DiscardLogEntry): boolean =>
    isInReportWindow(entry.undoneAt) && entry.undoneAt >= entry.discardedAt;
  const history = input.history.filter(item => item.sampledAt >= periodStart && item.sampledAt <= generatedAt);
  const log = input.discardLog.filter(item => item.discardedAt >= periodStart && item.discardedAt <= generatedAt);
  const currentLearningByDomain = new Map(input.learning.map(item => [item.domain.toLowerCase(), item]));
  const feedbackByDomain = new Map<string, DiscardLearningRecord>();

  for (const entry of input.discardLog) {
    const quickReactivation = isQuickReactivation(entry);
    const undo = isUndoFeedback(entry);
    const domain = entry.domain?.trim().toLowerCase();
    if (!domain || (!quickReactivation && !undo)) continue;

    const feedbackAt = Math.max(
      quickReactivation ? (entry.reactivatedAt as number) : 0,
      undo ? (entry.undoneAt as number) : 0
    );
    const current = feedbackByDomain.get(domain);
    feedbackByDomain.set(domain, {
      domain,
      quickReactivations: (current?.quickReactivations ?? 0) + (quickReactivation ? 1 : 0),
      undoCount: (current?.undoCount ?? 0) + (undo ? 1 : 0),
      lastFeedbackAt: Math.max(current?.lastFeedbackAt ?? 0, feedbackAt),
      thresholdPenaltyMinutes: currentLearningByDomain.get(domain)?.thresholdPenaltyMinutes ?? 0
    });
  }

  return {
    generatedAt,
    periodStart,
    sampleCount: history.length,
    highSampleCount: history.filter(item => item.pressure.level === "high").length,
    emergencySampleCount: history.filter(item => item.pressure.level === "emergency").length,
    cpuHighSampleCount: history.filter(item => item.pressure.cpuLevel === "high").length,
    automaticDiscardCount: log.filter(item => item.reason !== "manualRelease").length,
    manualDiscardCount: log.filter(item => item.reason === "manualRelease").length,
    estimatedFreedBytes: history.reduce((total, item) => total + Math.max(0, item.estimatedFreedBytes ?? 0), 0),
    quickReactivationCount: input.discardLog.filter(isQuickReactivation).length,
    undoCount: input.discardLog.filter(isUndoFeedback).length,
    externalDiscardCount: input.externalDiscards.filter(
      item => item.observedAt >= periodStart && item.observedAt <= generatedAt
    ).length,
    topLearningDomains: [...feedbackByDomain.values()]
      .sort(
        (a, b) =>
          b.quickReactivations + b.undoCount - (a.quickReactivations + a.undoCount) ||
          b.lastFeedbackAt - a.lastFeedbackAt
      )
      .slice(0, 8)
  };
}
