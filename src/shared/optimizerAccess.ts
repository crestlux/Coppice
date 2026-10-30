/** Optional access used only when the user enables automatic optimization. */
export const ALL_OPTIMIZER_ORIGINS = ["http://*/*", "https://*/*"];

export function optimizerOriginsForDomain(domain: string): string[] {
  return [`http://${domain}/*`, `https://${domain}/*`];
}

/** Matches the HTTP(S) origins returned by permissions.getAll(), without tab access. */
export function optimizerDomainAccessGranted(domain: string, origins: readonly string[]): boolean {
  return ["http", "https"].every(scheme => origins.some(origin => {
    if (origin === "<all_urls>") return true;
    const match = /^(\*|https?):\/\/([^/]+)\/\*$/.exec(origin);
    if (!match || (match[1] !== "*" && match[1] !== scheme)) return false;
    const host = match[2];
    return host === "*" || host === domain ||
      (host.startsWith("*.") && (domain === host.slice(2) || domain.endsWith(host.slice(1))));
  }));
}

export function isOptimizerUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // Chrome blocks extension scripts on its store, even with host access.
    return parsed.hostname !== "chromewebstore.google.com" &&
      !(parsed.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/.test(parsed.pathname));
  } catch {
    return false;
  }
}
