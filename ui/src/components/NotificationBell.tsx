import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../lib/settings";
import { absoluteTimeTitle, formatTimeAgo } from "../lib/time";
import { routes } from "../lib/routes";
import { useDismiss } from "../hooks/useDismiss";
import { useNotifications } from "./notificationContext";

export function NotificationBell({ collapsed }: { collapsed: boolean }) {
  const { notifications, unseenCount, markAllSeen, clearAll } = useNotifications();
  const [settings] = useSettings();
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "failed">("all");
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  const shown =
    statusFilter === "failed"
      ? notifications.filter((n) => n.status === "failed")
      : notifications;

  // Escape intentionally off — matches the bell's original close behavior.
  useDismiss(open, () => setOpen(false), [ref], { escape: false });

  return (
    <div className="notification-bell" ref={ref}>
      <button
        type="button"
        className="nav-item notification-bell-btn"
        onClick={() => {
          setOpen(!open);
          if (!open) markAllSeen();
        }}
        title="Notifications"
        aria-label={`Notifications${unseenCount > 0 ? ` (${unseenCount} new)` : ""}`}
      >
        <svg
          className="nav-icon"
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
        {!collapsed && <span>Notifications</span>}
        {unseenCount > 0 && (
          // Expanded: an inline pill after the label. Collapsed: a dot-style
          // counter pinned to the icon's corner.
          <span className={"notification-badge" + (collapsed ? "" : " notification-badge-inline")}>
            {unseenCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notification-dropdown">
          {notifications.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 10px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <button
                type="button"
                className={"scf-pill" + (statusFilter === "all" ? " active" : "")}
                onClick={() => setStatusFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={"scf-pill" + (statusFilter === "failed" ? " active" : "")}
                onClick={() => setStatusFilter("failed")}
              >
                Failed
              </button>
              <button
                type="button"
                className="scf-pill"
                style={{ marginLeft: "auto" }}
                onClick={clearAll}
              >
                Clear all
              </button>
            </div>
          )}
          {notifications.length === 0 ? (
            <div className="notification-empty">No notifications yet</div>
          ) : shown.length === 0 ? (
            <div className="notification-empty">No failed runs</div>
          ) : (
            shown.slice(0, 10).map((n) => (
              <button
                key={n.id}
                type="button"
                className={`notification-item notification-item-${n.status}`}
                onClick={() => {
                  if (n.experimentId && n.runId) {
                    navigate(routes.run(n.experimentId, n.runId));
                  }
                  setOpen(false);
                }}
              >
                <span className="notification-item-icon">
                  {n.status === "finished" ? "✓" : "✗"}
                </span>
                <span className="notification-item-text">
                  {n.runName || "Run"} {n.status}
                </span>
                <span
                  className="notification-item-time"
                  title={absoluteTimeTitle(n.ts, settings.timeFormat)}
                >
                  {formatTimeAgo(n.ts)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
