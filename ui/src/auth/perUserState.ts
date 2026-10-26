import { compareBasketClear } from "../lib/compareBasket";
import { PER_USER_STORAGE_KEYS } from "../lib/storageKeys";

/**
 * Forget everything the previous user left behind in this browser: the
 * persisted per-user keys and the in-memory stores that mirror them (the
 * compare basket caches its list in module state, so clearing storage alone
 * would leave it on screen). Called by the sign-out wrapper in AuthSession.
 */
export function clearPerUserState(
  storage: Pick<Storage, "removeItem"> | null = safeLocalStorage(),
): void {
  // Empty the in-memory mirror first; its own write lands in storage and is
  // then removed below with the rest.
  compareBasketClear();
  if (!storage) return;
  for (const key of PER_USER_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch { /* storage disabled/throwing: nothing persisted to leak, and the in-memory state is already reset */ }
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch { /* merely touching localStorage can throw when storage is blocked: treat as unavailable */
    return null;
  }
}
