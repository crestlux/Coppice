export const OPTIONS_SECTION_IDS = [
  "intelligenceHeading",
  "policyHeading",
  "automationHeading",
  "policyLabHeading",
  "windowPolicyHeading",
  "rulesHeading",
  "networkHeading",
  "sessionsHeading",
  "recoveryHeading",
  "backupHeading",
  "syncHeading",
  "logHeading",
  "advancedHeading"
] as const;

export type OptionsSectionId = (typeof OPTIONS_SECTION_IDS)[number];

export const DEFAULT_OPTIONS_SECTION_ID: OptionsSectionId = "intelligenceHeading";

const OPTIONS_SECTION_ID_SET = new Set<string>(OPTIONS_SECTION_IDS);

export function isOptionsSectionId(value: string): value is OptionsSectionId {
  return OPTIONS_SECTION_ID_SET.has(value);
}

export function resolveOptionsSectionId(hash: string): OptionsSectionId {
  const candidate = hash.trim().replace(/^#/, "");
  return isOptionsSectionId(candidate) ? candidate : DEFAULT_OPTIONS_SECTION_ID;
}

export function optionsSectionHash(sectionId: OptionsSectionId): `#${OptionsSectionId}` {
  return `#${sectionId}`;
}
