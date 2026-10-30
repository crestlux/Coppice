export type PopupView =
  | "home"
  | "resources"
  | "tabs"
  | "discarded"
  | "frozen"
  | "protected"
  | "policy"
  | "network"
  | "optimizer";

export type PopupViewTransition = "none" | "detail" | "overview";

const POPUP_VIEWS = new Set<PopupView>([
  "home",
  "resources",
  "tabs",
  "discarded",
  "frozen",
  "protected",
  "policy",
  "network",
  "optimizer"
]);

export function isPopupView(value: string | undefined): value is PopupView {
  return typeof value === "string" && POPUP_VIEWS.has(value as PopupView);
}

export function popupViewTransition(previous: PopupView, next: PopupView): PopupViewTransition {
  if (previous === next) return "none";
  return next === "home" ? "overview" : "detail";
}

export function shouldReturnToOverviewOnEscape(input: {
  key: string;
  currentView: PopupView;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}): boolean {
  return (
    input.key === "Escape" &&
    input.currentView !== "home" &&
    !input.defaultPrevented &&
    !input.isComposing
  );
}
