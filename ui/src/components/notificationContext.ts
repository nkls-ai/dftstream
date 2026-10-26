import { createContext, useContext } from "react";
import type { RunNotification } from "../lib/notifications";

export interface NotificationContextValue {
  notifications: RunNotification[];
  unseenCount: number;
  markAllSeen: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

// Defaults are inert no-ops: outside a NotificationProvider there is simply
// nothing to mark, dismiss or clear.
export const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unseenCount: 0,
  markAllSeen: () => {},
  dismiss: () => {},
  clearAll: () => {},
});

export function useNotifications(): NotificationContextValue {
  return useContext(NotificationContext);
}
