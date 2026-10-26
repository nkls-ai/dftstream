import { useNavigate } from "react-router-dom";
import { routes } from "../lib/routes";
import { useDataSource } from "../data/DataSource";
import { usePrompt } from "../components/Confirm";
import { useGuardedAction } from "../hooks/useGuardedAction";

/** "+ New batch" / "+ New pathway" buttons in the experiment page header. */
export function RunsPageActions({
  expId,
  onBatchCreated,
}: {
  expId: string;
  onBatchCreated: (batchId: string) => void;
}) {
  const nav = useNavigate();
  const ds = useDataSource();
  const prompt = usePrompt();
  const guard = useGuardedAction();

  const onNewBatch = async () => {
    const name = await prompt({
      title: "New batch",
      placeholder: "e.g. ligand screen",
      confirmLabel: "Create",
      validate: (v) => (v.trim().length === 0 ? "Name cannot be empty." : null),
    });
    if (name == null) return;
    await guard("create batch", async () => {
      onBatchCreated(await ds.createBatch(expId, name.trim()));
    });
  };

  const onNewPathway = async () => {
    const name = await prompt({
      title: "New reaction pathway",
      placeholder: "e.g. Diels-Alder pathway",
      confirmLabel: "Create",
      validate: (v) => (v.trim().length === 0 ? "Name cannot be empty." : null),
    });
    if (name == null) return;
    await guard("create pathway", async () => {
      nav(routes.pathway(expId, await ds.createPathway(expId, name.trim(), [])));
    });
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="button" onClick={onNewBatch}>
        + New batch
      </button>
      <button type="button" className="button" onClick={onNewPathway}>
        + New pathway
      </button>
    </div>
  );
}
