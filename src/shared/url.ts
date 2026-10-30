import type { ProtectionRule } from "./types";

export function parseUrlSafe(url?: string): URL | null {
  if (!url) return null;

  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isHttpUrl(url?: string): boolean {
  const parsed = parseUrlSafe(url);
  return parsed?.protocol === "http:" || parsed?.protocol === "https:";
}

export function getHostname(url?: string): string | null {
  const parsed = parseUrlSafe(url);
  return parsed?.hostname.toLowerCase() ?? null;
}

export function isDomainMatch(hostname: string, ruleDomain: string): boolean {
  const h = hostname.toLowerCase();
  const r = ruleDomain.toLowerCase();

  return h === r || h.endsWith(`.${r}`);
}

export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "");
}

const HOSTNAME_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes a hostname-only value. URLs, ports, paths, wildcards, IPv6
 * literals, and malformed DNS labels are deliberately rejected.
 */
export function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hostname = value.trim().toLowerCase();
  if (!hostname || hostname.length > 253 || !hostname.split(".").every(label => HOSTNAME_LABEL_PATTERN.test(label))) {
    return null;
  }

  if (/^[\d.]+$/.test(hostname)) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
    const octets = hostname.split(".");
    if (octets.some(octet => Number(octet) > 255 || (octet.length > 1 && octet.startsWith("0")))) return null;
  }

  return hostname;
}

export function matchesProtectedDomain(hostname: string, rules: ProtectionRule[]): boolean {
  return rules.some(
    rule => rule.enabled && rule.type === "domain" && isDomainMatch(hostname, normalizeDomain(rule.value))
  );
}

export function matchesProtectedUrlPattern(url: string, rules: ProtectionRule[]): boolean {
  return rules.some(rule => {
    if (!rule.enabled || rule.type !== "urlPattern") return false;
    try {
      return wildcardToRegExp(rule.value).test(url);
    } catch {
      return false;
    }
  });
}

export function exactUrlPattern(url: string): string {
  return url;
}
