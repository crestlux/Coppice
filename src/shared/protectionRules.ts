import type { ProtectionRule, ProtectionRuleType } from "./types";
import { isHttpUrl, normalizeHostname, parseUrlSafe, wildcardToRegExp } from "./url";

export function normalizeProtectionRuleValue(type: ProtectionRuleType, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Protection rule value is required");
  }

  if (type === "domain") {
    const domain = normalizeHostname(trimmed.startsWith("*.") ? trimmed.slice(2) : trimmed);
    if (!domain) {
      throw new Error("Domain rules must be hostnames like example.com, localhost, or 127.0.0.1");
    }
    return domain;
  }

  const pattern = trimmed;
  const probeUrl = pattern.replace(/\*/g, "example");
  const parsed = parseUrlSafe(probeUrl);

  if (!parsed || !isHttpUrl(probeUrl)) {
    throw new Error("URL pattern rules must start with http:// or https://");
  }

  wildcardToRegExp(pattern);
  return pattern;
}

export function isDuplicateProtectionRule(rules: ProtectionRule[], type: ProtectionRuleType, value: string): boolean {
  return rules.some(rule => rule.type === type && rule.value.toLowerCase() === value.toLowerCase());
}
