import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../lib/settings";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { readJson, writeJson } from "../lib/persistedJson";
import { routes } from "../lib/routes";
import { MAX_NOTIFICATIONS, type RunNotification } from "../lib/notifications";
import { useNotifications } from "./notificationContext";

// The transient UI the NotificationProvider mounts: completion toasts and
// the one-time desktop-notification permission prompt.

const PROMPT_DISMISSED_KEY = STORAGE_KEYS.notifPromptDismissed;

/** Ceiling on the "already toasted" id set before it is trimmed. Comfortably
 *  above MAX_NOTIFICATIONS so trimming can never re-toast a live entry. */
const SHOWN_IDS_LIMIT = MAX_NOTIFICATIONS * 10;

export function NotificationPrompt() {
  const [, update] = useSettings();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    if (readJson(PROMPT_DISMISSED_KEY)) return;
    const timer = setTimeout(() => setShow(true), 4000);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    // Best-effort: if storage refuses, the prompt may simply show again next session.
    writeJson(PROMPT_DISMISSED_KEY, 1);
  }, []);

  const enable = useCallback(async () => {
    setShow(false);
    // Best-effort: if storage refuses, the prompt may simply show again next session.
    writeJson(PROMPT_DISMISSED_KEY, 1);
    try {
      const result = await Notification.requestPermission();
      if (result === "granted") {
        update({ desktopNotifications: true });
      }
    } catch {
      // browser blocked the request
    }
  }, [update]);

  if (!show) return null;

  return (
    <div className="notif-prompt" role="alert">
      <svg
        className="notif-prompt-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      <span className="notif-prompt-text">
        Get notified when your calculations finish?
      </span>
      <button type="button" className="notif-prompt-enable" onClick={enable}>
        Enable
      </button>
      <button type="button" className="notif-prompt-dismiss" onClick={dismiss}>
        Not now
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { notifications, dismiss } = useNotifications();
  const navigate = useNavigate();
  const [visible, setVisible] = useState<RunNotification[]>([]);
  const shownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh = notifications.filter((n) => !shownRef.current.has(n.id));
    if (fresh.length === 0) return;

    for (const n of fresh) {
      shownRef.current.add(n.id);
    }
    // "Already toasted" only has to outlive the notification feed itself,
    // which is capped at MAX_NOTIFICATIONS. Without a bound this Set grew by
    // one id per completed run and never shrank — on a dashboard left open
    // across a batch of thousands of runs it was the session's slow leak.
    if (shownRef.current.size > SHOWN_IDS_LIMIT) {
      shownRef.current = new Set(
        [...shownRef.current].slice(-MAX_NOTIFICATIONS),
      );
    }
    setVisible((prev) => [...fresh, ...prev].slice(0, 5));
  }, [notifications]);

  useEffect(() => {
    if (visible.length === 0) return;
    const timer = setTimeout(() => {
      setVisible((prev) => prev.slice(0, -1));
    }, 8000);
    return () => clearTimeout(timer);
  }, [visible]);

  if (visible.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite">
      {visible.map((n) => (
        <div
          key={n.id}
          className={`toast toast-${n.status}`}
          onClick={() => {
            if (n.experimentId && n.runId) {
              navigate(routes.run(n.experimentId, n.runId));
            }
            setVisible((prev) => prev.filter((x) => x.id !== n.id));
            dismiss(n.id);
          }}
        >
          <span className="toast-icon">
            {n.status === "finished" ? "✓" : "✗"}
          </span>
          <span className="toast-body">
            <strong>{n.runName || "Run"}</strong>{" "}
            {n.status === "finished" ? "finished" : "failed"}
            {n.converged !== undefined && (
              <span className="toast-detail">
                {n.converged ? " (converged)" : " (not converged)"}
              </span>
            )}
          </span>
          <button
            className="toast-close"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setVisible((prev) => prev.filter((x) => x.id !== n.id));
              dismiss(n.id);
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
