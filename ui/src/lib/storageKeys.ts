// Central registry of every localStorage key the app touches. Add new keys
// here — never inline the literal at the call site — so a rename or an
// audit of persisted state has exactly one place to look.
export const STORAGE_KEYS = {
  /** JSON blob of user settings (lib/settings.ts). */
  settings: "dftstream-settings",
  /** Timestamp (ms) of the last time notifications were marked seen. */
  notificationsSeen: "dftstream-notifications-seen",
  /** "1" once the desktop-notification permission prompt was dismissed. */
  notifPromptDismissed: "dftstream-notif-prompt-dismissed",
  /** Active organization id for org-scoped queries. */
  activeOrg: "dftstream-active-org",
  /** JSON map of tableId -> SortState for user-chosen column sorts. */
  tableSort: "dftstream-table-sort",
  /** JSON map of tableId -> visible-column flags (e.g. GOAT ensemble). */
  tableColumns: "dftstream-table-columns",
  /** JSON array of run ids collected for cross-experiment comparison. */
  compareBasket: "dftstream-compare-basket",
  /** JSON map of sectionKey -> open flag for collapsible detail sections. */
  sectionOpen: "dftstream-section-open",
  /** JSON array of the input builder's user-defined machine profiles. */
  machineProfiles: "dftstream-machine-profiles",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * Keys holding state that belongs to the signed-in USER (their org, the run
 * ids they collected, their notification watermark) rather than to the
 * browser. Cleared on sign-out (auth/perUserState.ts) so the next person on
 * a shared machine does not inherit them. UI preferences stay.
 */
export const PER_USER_STORAGE_KEYS: readonly StorageKey[] = [
  STORAGE_KEYS.activeOrg,
  STORAGE_KEYS.compareBasket,
  STORAGE_KEYS.notificationsSeen,
];
