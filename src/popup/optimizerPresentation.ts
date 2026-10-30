import type { AiConversationOptimizerMetrics, ExperimentalOptimizerItemStatus, ExperimentalOptimizerStatus } from "../shared/types";

type OptimizerMetricStatus = Pick<
  ExperimentalOptimizerStatus,
  | "activeSiteAccessGranted"
  | "activeSiteEnabled"
  | "activeTabOptimized"
  | "canToggleActiveTab"
  | "enabledInSettings"
  | "aiConversationMetrics"
  | "pageMetrics"
  | "reason"
> & Partial<Pick<ExperimentalOptimizerStatus, "allSitesEnabled" | "allSitesAccessGranted" | "activeSiteExcluded" | "activeTabPaused">>;

export function optimizerOverview(status: ExperimentalOptimizerStatus | undefined): {
  mode: string; detail: string; tone: "neutral" | "enabled" | "warning"; action: "enable" | "allow" | "none";
} {
  if (!status) return { mode: "Checking…", detail: "", tone: "neutral", action: "none" };
  const selected = status.siteDomains.length;
  if (!status.enabledInSettings || (!status.allSitesEnabled && selected === 0)) {
    return { mode: "Automatic: Off", detail: status.activeTabOptimized ? "This tab is optimized manually" : "", tone: "neutral", action: "enable" };
  }
  const missingAccess = status.allSitesEnabled ? !status.allSitesAccessGranted : status.siteAccessGrantedCount === 0;
  if (missingAccess) return { mode: "Website access needed", detail: "Automatic optimization is paused", tone: "warning", action: "allow" };
  const mode = status.allSitesEnabled ? "Automatic: All sites" : "Automatic: Selected sites";
  if (status.items.length > 0 && !status.items.some(item => item.enabled)) {
    return {mode, detail: "No optimizations selected", tone: "warning", action: "none"};
  }
  let detail = status.activeSiteExcluded ? "This site is excluded"
    : status.activeTabPaused ? "This tab is restored until reload"
    : status.activeTabOptimized ? "This tab is optimized"
    : !status.canToggleActiveTab ? "Unavailable on this page"
    : status.activeSiteEnabled && !status.activeSiteAccessGranted ? "This site needs access"
    : status.activeSiteEnabled ? "Waiting for this page" : "This site is not selected";
  if (!status.allSitesEnabled && status.siteAccessGrantedCount !== undefined && status.siteAccessGrantedCount < selected) {
    detail = `${status.siteAccessGrantedCount} of ${selected} sites have access · ${detail}`;
  }
  return { mode, detail, tone: "enabled", action: "none" };
}

export function optimizerMetricText(status: OptimizerMetricStatus): string {
  if (status.activeTabOptimized) {
    if (status.pageMetrics?.renderingBackoff) {
      return "Rendering paused while content is changing.";
    }
    if (status.pageMetrics?.interactionDeferred || status.aiConversationMetrics?.interactionDeferred) return "New optimizations wait until you finish typing or scrolling.";
    if (status.pageMetrics?.workBudgetLimited || status.aiConversationMetrics?.workBudgetLimited) return "Working more slowly to keep this page responsive.";
    const metrics = status.aiConversationMetrics;
    if (metrics?.supported) {
      if (!metrics.runtimeActive) {
        return `${metrics.providerLabel}: optimization was interrupted. Try again.`;
      }
      if (metrics.detectedTurnCount === 0) {
        return "No conversation open.";
      }
      if (metrics.optimizedTurnCount > 0) {
        if (metrics.optimizedSectionCount) {
          return `${metrics.providerLabel}: ${metrics.optimizedSectionCount} answer sections optimized · ${metrics.skippedSectionCount ?? 0} skipped by browser`;
        }
        const skipped = metrics.skipMeasurementSupported
          ? ` · ${metrics.skippedTurnCount} skipped by browser`
          : "";
        return `${metrics.providerLabel}: ${metrics.optimizedTurnCount} of ${metrics.detectedTurnCount} messages optimized${skipped}`;
      }
      return `${metrics.providerLabel}: ${metrics.detectedTurnCount} messages · no changes applied`;
    }
    return "This tab is optimized.";
  }

  if (!status.canToggleActiveTab) {
    return status.reason ?? "Open a regular HTTP or HTTPS page to use Page Optimizer.";
  }

  if (status.activeTabPaused) {
    return "Restored until navigation or reload.";
  }
  if (status.activeSiteExcluded) {
    return "Excluded from automatic optimization.";
  }
  if (status.allSitesEnabled) {
    if (!status.allSitesAccessGranted) return "Allow website access to resume automatic optimization on all sites.";
    return status.enabledInSettings
      ? "Waiting for this page to finish loading."
      : "Automatic optimization is paused.";
  }

  if (status.activeSiteEnabled) {
    if (!status.enabledInSettings) {
      return "Automatic optimization is paused for this site.";
    }
    return status.activeSiteAccessGranted
      ? "Waiting to optimize this site."
      : "Website access is needed for this site.";
  }

  return "Not optimized.";
}

export function optimizerItemMetricText(item: ExperimentalOptimizerItemStatus, applied: boolean, ai?: AiConversationOptimizerMetrics): string {
  if (!item.enabled) return "Off";
  if (!applied) return "";
  if (item.id === "chatgptConversationOptimizer") {
    if (!ai) return "Measurement unavailable";
    if (ai.optimizedSectionCount) return ai.optimizedSectionCount + " sections in long answers optimized";
    return ai.supported ? ai.optimizedTurnCount + " of " + ai.detectedTurnCount + " messages optimized" : "No conversation detected on this page";
  }
  const metric = item.metrics;
  if (!metric) return "Measurement unavailable";
  if (metric.detected === 0) return "No eligible content on this page";
  if (metric.applied === 0) return metric.detected + " detected · waiting until safe to optimize";
  const action = item.id === "animationLimiter" || item.id === "backgroundAnimationPause" || item.id === "offscreenMediaPause" ? "paused" : "optimized";
  return metric.applied + " of " + metric.detected + " " + action + (metric.skipped > 0 ? " · " + metric.skipped + " skipped by browser" : "");
}
