import { useCallback } from "react";
import { useAlert } from "../components/Confirm";
import { userErrorMessage } from "../lib/errorReporting";

export interface GuardOptions {
  /** Runs before the alert, e.g. to roll back an optimistic update. */
  onError?: () => void;
}

/**
 * Returns `guard(action, fn, opts?)`: runs a mutation and surfaces any failure
 * to the user as an alert dialog ("Could not <action>", with an incident id)
 * instead of letting the rejection go unhandled. Never rejects itself.
 */
export function useGuardedAction() {
  const alert = useAlert();
  return useCallback(
    async (action: string, fn: () => Promise<unknown>, opts?: GuardOptions) => {
      try {
        await fn();
      } catch (err) {
        opts?.onError?.();
        await alert({ title: `Could not ${action}`, tone: "danger", message: userErrorMessage(err, action) });
      }
    },
    [alert],
  );
}
