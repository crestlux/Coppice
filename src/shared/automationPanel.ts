import type { AutomationPlan } from "./types";
import "./automationPanel.css";

const labels: Record<AutomationPlan["mode"], string> = {
  manual: "Manual cleanup", paused: "Automatic cleanup paused", observe: "Cleanup on hold",
  routine: "Routine cleanup", pressureRelief: "Memory cleanup",
  cpuRelief: "Busy tabs first", probe: "Memory cleanup", cooldown: "Cleanup paused briefly"
};
export function renderAutomationPlan(container: HTMLElement, plan?: AutomationPlan): void {
  container.replaceChildren();
  container.classList.add("automation-plan");
  if (!plan) { container.textContent = "Checking tabs…"; return; }
  const heading = document.createElement("strong");
  const stale = Date.now() - plan.evaluatedAt > 5 * 60_000;
  heading.textContent = `${labels[plan.mode]}${stale ? " · previous scan" : ""}`;
  const metrics = document.createElement("p");
  metrics.className = "automation-plan-metrics";
  metrics.textContent = plan.selectedTabIds.length
    ? `${plan.selectedTabIds.length} tab${plan.selectedTabIds.length === 1 ? "" : "s"} ready to unload.`
    : plan.cooldownUntil && plan.cooldownUntil > Date.now()
      ? `Resumes after ${new Date(plan.cooldownUntil).toLocaleTimeString()}.` : "No tabs ready to unload.";
  container.append(heading, metrics);
}
