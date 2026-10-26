import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDataSource } from "../data/DataSource";
import { useSettings } from "../lib/settings";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { readJson, writeJson } from "../lib/persistedJson";
import {
  MAX_NOTIFICATIONS,
  completionNotification,
  diffDisappeared,
  snapshotRunning,
  type RunNotification,
  type RunSnapshot,
} from "../lib/notifications";
import { orgQueryArg, useOrg } from "../auth/OrgContext";
import { NotificationContext } from "./notificationContext";
import { NotificationPrompt, ToastContainer } from "./NotificationToasts";

export { useNotifications } from "./notificationContext";

const STORAGE_KEY = STORAGE_KEYS.notificationsSeen;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const ds = useDataSource();
  const org = useOrg();
  const orgArg = orgQueryArg(org);
  const runningRuns = ds.useRunningRuns(orgArg).data;
  const [settings] = useSettings();
  const [notifications, setNotifications] = useState<RunNotification[]>([]);
  // Unavailable storage or a bad value: start with everything unseen.
  const [lastSeenTs, setLastSeenTs] = useState(() => {
    const stored = readJson(STORAGE_KEY);
    return typeof stored === "number" && Number.isFinite(stored) ? stored : 0;
  });

  const prevRunning = useRef<Map<string, RunSnapshot>>(new Map());
  const initialized = useRef(false);
  const orgScopeRef = useRef<string | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // The running set is scoped to the active org. Switching orgs swaps the whole
  // set, so any run from the previous org would look "disappeared" and fire a
  // bogus completion toast. Track which org the snapshot belongs to.
  const orgScope = typeof orgArg === "string" ? orgArg : null;

  useEffect(() => {
    if (!runningRuns) return;

    const currentMap = snapshotRunning(runningRuns);

    // First load, or the org scope changed: re-baseline without diffing.
    if (!initialized.current || orgScopeRef.current !== orgScope) {
      prevRunning.current = currentMap;
      initialized.current = true;
      orgScopeRef.current = orgScope;
      return;
    }

    const disappeared = diffDisappeared(prevRunning.current, currentMap);

    // The resolve loop awaits one fetchRun per finished run, so it easily
    // outlives the effect that started it. Without this flag an org switch (or
    // an unmount) still lets the in-flight fetches land: setNotifications
    // writes into a provider that no longer owns this scope, and desktop
    // toasts fire for runs belonging to the org the user just left.
    let cancelled = false;

    if (disappeared.length > 0) {
      const resolveAndNotify = async () => {
        const added: RunNotification[] = [];
        for (const snap of disappeared) {
          if (cancelled) return;
          let resolved: Awaited<ReturnType<typeof ds.fetchRun>> = null;
          try {
            resolved = await ds.fetchRun(snap.id);
          } catch {
            // run may have been deleted; default to "finished"
          }
          added.push(completionNotification(snap, resolved));
        }
        if (cancelled) return;
        setNotifications((prev) => [...added, ...prev].slice(0, MAX_NOTIFICATIONS));

        if (
          typeof Notification !== "undefined" &&
          settingsRef.current.desktopNotifications &&
          document.hidden &&
          Notification.permission === "granted"
        ) {
          for (const n of added) {
            try {
              new window.Notification("DFTStream", {
                body: `${n.runName} ${n.status === "failed" ? "failed" : "has completed"}.`,
                icon: "/logo.png",
              });
            } catch {
              // permission revoked or restricted context
            }
          }
        }
      };
      resolveAndNotify().catch(console.error);
    }

    prevRunning.current = currentMap;
    return () => {
      cancelled = true;
    };
  }, [runningRuns, ds, orgScope]);

  const unseenCount = notifications.filter((n) => n.ts > lastSeenTs).length;

  const markAllSeen = useCallback(() => {
    const now = Date.now();
    setLastSeenTs(now);
    // Best-effort: if storage refuses, "seen" only lasts for this session.
    writeJson(STORAGE_KEY, now);
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    markAllSeen();
  }, [markAllSeen]);

  return (
    <NotificationContext.Provider
      value={{ notifications, unseenCount, markAllSeen, dismiss, clearAll }}
    >
      {children}
      <ToastContainer />
      <NotificationPrompt />
    </NotificationContext.Provider>
  );
}
