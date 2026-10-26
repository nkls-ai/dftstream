import { useState } from "react";
import { Link } from "react-router-dom";
import { routes } from "../lib/routes";
import { useDataSource } from "../data/DataSource";
import { RowMenu } from "../components/RowMenu";
import { useConfirm, usePrompt } from "../components/Confirm";
import type { Pathway } from "../data/types";
import { useGuardedAction } from "../hooks/useGuardedAction";

function PathwayRowMenu({ pw }: { pw: Pathway }) {
  const ds = useDataSource();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const guard = useGuardedAction();
  return (
    <RowMenu
      ariaLabel={`actions for pathway ${pw.name}`}
      items={[
        {
          label: "Rename…",
          onClick: async () => {
            const next = await prompt({
              title: "Rename pathway",
              defaultValue: pw.name,
              placeholder: "Pathway name",
              validate: (v) => (v.trim().length === 0 ? "Name cannot be empty." : null),
            });
            if (next == null) return;
            await guard("rename pathway", () => ds.renamePathway(pw.id, next.trim()));
          },
        },
        {
          label: "Delete…",
          tone: "danger",
          onClick: async () => {
            const ok = await confirm({
              title: `Delete pathway "${pw.name}"?`,
              tone: "danger",
              confirmLabel: "Delete",
              message: "This cannot be undone.",
            });
            if (!ok) return;
            await guard("delete pathway", () => ds.removePathway(pw.id));
          },
        },
      ]}
    />
  );
}

/** "Reaction pathways" card list at the bottom of an experiment page. */
export function PathwaySection({
  expId,
  pathways,
}: {
  expId: string;
  pathways: Pathway[];
}) {
  const [query, setQuery] = useState("");
  // No create affordance lives in this section, so an empty pathway list can
  // safely render nothing.
  if (pathways.length === 0) return null;

  const q = query.trim().toLowerCase();
  const visible = q === "" ? pathways : pathways.filter((pw) => pw.name.toLowerCase().includes(q));

  return (
    <div className="pathway-section">
      <div className="section-heading">
        <h2 className="section-title">Reaction pathways</h2>
        <div className="section-rule" />
      </div>
      {pathways.length > 8 && (
        <div className="table-toolbar">
          <input
            type="search"
            placeholder="Filter pathways…"
            aria-label="Filter pathways"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {q !== "" && (
            <span className="table-toolbar-count">
              {visible.length} of {pathways.length} pathways
            </span>
          )}
        </div>
      )}
      {visible.length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>No pathways match.</div>
      )}
      <div className="pathway-list">
        {visible.map((pw) => (
          <div key={pw.id} className="pathway-card">
            <div className="pathway-card-body">
              <Link
                to={routes.pathway(expId, pw.id)}
                className="pathway-card-name"
              >
                {pw.name}
              </Link>
              <span className="muted" style={{ fontSize: 12 }}>
                {pw.points.length} point{pw.points.length !== 1 ? "s" : ""}
              </span>
            </div>
            <PathwayRowMenu pw={pw} />
          </div>
        ))}
      </div>
    </div>
  );
}
