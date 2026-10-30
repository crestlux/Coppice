import type { ExperimentalOptimizerItemId, ExperimentalOptimizerItemStatus, Settings } from "./types";

export const OPTIMIZER_CATALOG: ReadonlyArray<{
  id: ExperimentalOptimizerItemId;
  label: string;
  description: string;
}> = [
  { id: "offscreenRendering", label: "Offscreen rendering", description: "Defers distant sections, cards and feeds." },
  { id: "mediaContainment", label: "Media rendering", description: "Defers distant media; playing content stays visible." },
  { id: "animationLimiter", label: "Offscreen animation pause", description: "Resumes when back in view." },
  { id: "visualEffectsReducer", label: "Visual effects reducer", description: "Reduces large blurs and shadows." },
  { id: "codeBlockContainment", label: "Code block rendering", description: "Defers distant code; editors stay active." },
  { id: "imageContainment", label: "Image rendering", description: "Defers distant images without changing their size." },
  { id: "chatgptConversationOptimizer", label: "AI conversation optimizer", description: "Defers older messages and sections of long answers." },
  { id: "reducedMotionMode", label: "Reduced motion", description: "Shortens animations and transitions." },
  { id: "backgroundAnimationPause", label: "Background animation pause", description: "Resumes when you return to the tab." },
  { id: "offscreenMediaPause", label: "Offscreen video pause", description: "Only silent autoplay loops; your playback stays running." }
];

export function optimizerItemStatuses(settings: Pick<Settings, "experimentalOptimizerItems">): ExperimentalOptimizerItemStatus[] {
  return OPTIMIZER_CATALOG.map(item => ({ ...item, enabled: settings.experimentalOptimizerItems[item.id] }));
}
