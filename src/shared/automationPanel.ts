import type { AutomationPlan } from "./types";
import "./automationPanel.css";

const labels: Record<AutomationPlan["mode"], string> = {
  manual: "Manual policy", paused: "Automation paused", observe: "Observing pressure",
  routine: "Routine cleanup", pressureRelief: "Memory cleanup",
  cpuRelief: "Busy tabs first", probe: "Checking cleanup effect", cooldown: "Waiting for a memory reading"
};
export function renderAutomationPlan(container: HTMLElement, plan?: AutomationPlan): void {
  const expanded = container.querySelector("details")?.open ?? false;
  container.replaceChildren();
  container.classList.add("automation-plan");
  if (!plan) { container.textContent = "No scan yet."; return; }
  const heading = document.createElement("strong");
  const stale = Date.now() - plan.evaluatedAt > 5 * 60_000;
  heading.textContent = `${labels[plan.mode]}${stale ? " · previous scan" : ""}`;
  const metrics = document.createElement("p");
  metrics.className = "automation-plan-metrics";
  metrics.textContent = plan.selectedTabIds.length
    ? `${plan.selectedTabIds.length} tabs selected for cleanup.` : "No tabs selected for cleanup.";
  const details = document.createElement("details");
  details.open = expanded;
  const summary = document.createElement("summary");
  summary.textContent = "Why this action";
  const reasons = document.createElement("ul");
  const entries = [...plan.reasons];
  if (plan.cooldownUntil) entries.push(`Recheck after ${new Date(plan.cooldownUntil).toLocaleTimeString()}.`);
  for (const text of entries) { const item = document.createElement("li"); item.textContent = text; reasons.append(item); }
  details.append(summary, reasons);
  container.append(heading, metrics, details);
}
