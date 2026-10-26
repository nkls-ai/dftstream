import { useDataSource } from "../data/DataSource";
import { RowMenu } from "../components/RowMenu";
import { useConfirm, usePrompt } from "../components/Confirm";
import { useGuardedAction } from "../hooks/useGuardedAction";

/** Rename/delete menu for a single row in the runs table. */
export function RunRowMenu({
  runId,
  runName,
  onMarkRemoving,
  onUnmarkRemoving,
  onOptimisticRename,
  onClearOptimisticRename,
}: {
  runId: string;
  runName: string;
  onMarkRemoving: (id: string) => void;
  onUnmarkRemoving: (id: string) => void;
  onOptimisticRename: (id: string, name: string) => void;
  onClearOptimisticRename: (id: string) => void;
}) {
  const ds = useDataSource();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const guard = useGuardedAction();
  const onRename = async () => {
    const next = await prompt({
      title: "Rename run",
      defaultValue: runName,
      placeholder: "Run name",
      validate: (v) =>
        v.trim().length === 0 ? "Name cannot be empty." : null,
    });
    if (next == null) return;
    const trimmed = next.trim();
    if (trimmed === runName) return;
    onOptimisticRename(runId, trimmed);
    await guard(
      "rename run",
      async () => {
        await ds.renameRun(runId, trimmed);
        window.setTimeout(() => onClearOptimisticRename(runId), 1500);
      },
      { onError: () => onClearOptimisticRename(runId) },
    );
  };
  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete run "${runName}"?`,
      tone: "danger",
      confirmLabel: "Delete",
      message:
        "This removes all events, geometries, frequencies and artifacts for the run. Cannot be undone.",
    });
    if (!ok) return;
    onMarkRemoving(runId);
    await guard("delete run", () => ds.removeRun(runId), {
      onError: () => onUnmarkRemoving(runId),
    });
  };
  return (
    <RowMenu
      ariaLabel={`actions for run ${runName}`}
      items={[
        { label: "Rename…", onClick: onRename },
        { label: "Delete…", tone: "danger", onClick: onDelete },
      ]}
    />
  );
}
