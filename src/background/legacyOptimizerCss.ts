// Exact previous CSS strings are required by chrome.scripting.removeCSS during upgrades.
export const LEGACY_OPTIMIZER_ITEM_CSS: string[] = [
  `
@supports (content-visibility: auto) {
  [data-resource-governor-ai-turn="optimized"] {
    content-visibility: auto !important;
    contain-intrinsic-block-size: auto var(--resource-governor-ai-turn-size, 720px) !important;
  }
}
`,
  "\n@supports (content-visibility: auto) {\n  html:not([data-resource-governor-ai-runtime=\"2\"]) main article,\n  html:not([data-resource-governor-ai-runtime=\"2\"]) main [role=\"article\"],\n  html:not([data-resource-governor-ai-runtime=\"2\"]) main [data-testid*=\"conversation\"],\n  html:not([data-resource-governor-ai-runtime=\"2\"]) main [data-testid*=\"message\"],\n  html:not([data-resource-governor-ai-runtime=\"2\"]) main [data-message-author-role],\n  html:not([data-resource-governor-ai-runtime=\"2\"]) [data-radix-scroll-area-viewport] article {\n    content-visibility: auto !important;\n    contain-intrinsic-size: 1px 720px !important;\n  }\n}\n",
  "\n@supports (content-visibility: auto) {\n  video:not(:hover):not(:focus-within),\n  canvas:not(:hover):not(:focus-within) {\n    content-visibility: auto !important;\n    contain-intrinsic-size: 1px 360px !important;\n  }\n}\n",
  "\n[class*=\"animate-\"],\n[class*=\"animation\"],\n[class*=\"spinner\"],\n[class*=\"pulse\"],\n[class*=\"shimmer\"],\n[data-state=\"loading\"] {\n  animation-duration: 1ms !important;\n  animation-iteration-count: 1 !important;\n  transition-duration: 1ms !important;\n}\n",
  "\n[style*=\"backdrop-filter\"],\n[style*=\"blur(\"],\n[class*=\"backdrop-blur\"],\n[class*=\"blur-\"],\n[class*=\"shadow-2xl\"],\n[class*=\"shadow-xl\"] {\n  backdrop-filter: none !important;\n  -webkit-backdrop-filter: none !important;\n  filter: none !important;\n  box-shadow: none !important;\n}\n",
  "\npre,\npre code,\n[class*=\"highlight\"],\n[class*=\"syntax\"],\n[class*=\"cm-editor\"],\n[data-language] {\n  content-visibility: auto !important;\n  contain-intrinsic-size: 1px 520px !important;\n  contain: layout style paint !important;\n}\n",
  "\nimg,\npicture,\nfigure {\n  content-visibility: auto !important;\n  contain-intrinsic-size: 1px 480px !important;\n}\n",
  "\n@supports (content-visibility: auto) {\n  [data-resource-governor-ai-turn=\"optimized\"] {\n    content-visibility: auto !important;\n    contain-intrinsic-size: auto var(--resource-governor-ai-turn-size, 720px) !important;\n  }\n}\n",
  "\nhtml {\n  scroll-behavior: auto !important;\n}\n\nbody *,\nbody *::before,\nbody *::after {\n  transition-duration: 0.01ms !important;\n  animation-duration: 0.01ms !important;\n  animation-iteration-count: 1 !important;\n}\n"
];
