let suppressionDepth = 0;
const createdByRestore = new Map<number, number>();
const RESTORE_EVENT_GRACE_MS = 30_000;

function rememberCreatedTabs(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const item = value as { id?: number; windowId?: number; tabs?: unknown[] };
  if (Array.isArray(item.tabs)) {
    for (const tab of item.tabs) rememberCreatedTabs(tab);
  } else if (Number.isInteger(item.id) && typeof item.windowId === "number") {
    const now = Date.now();
    for (const [tabId, expiresAt] of createdByRestore) {
      if (expiresAt <= now) createdByRestore.delete(tabId);
    }
    createdByRestore.set(item.id as number, now + RESTORE_EVENT_GRACE_MS);
  }
}

/**
 * Programmatic session/recovery restores may intentionally recreate duplicate
 * URLs. Keep auto-merge from closing those tabs while Chrome emits onCreated.
 */
export async function withAutoMergeSuppressed<T>(operation: () => Promise<T>): Promise<T> {
  suppressionDepth += 1;
  try {
    const result = await operation();
    // Chrome's onCreated delivery can follow the API promise. Retain returned
    // tab IDs briefly so a delayed event cannot auto-merge an intentional restore.
    rememberCreatedTabs(result);
    return result;
  } finally {
    suppressionDepth = Math.max(0, suppressionDepth - 1);
  }
}

export function isAutoMergeSuppressed(tabId?: number): boolean {
  if (suppressionDepth > 0) return true;
  if (tabId == null) return false;
  const expiresAt = createdByRestore.get(tabId);
  if (expiresAt == null) return false;
  if (expiresAt <= Date.now()) {
    createdByRestore.delete(tabId);
    return false;
  }
  return true;
}
