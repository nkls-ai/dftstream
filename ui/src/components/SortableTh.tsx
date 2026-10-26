import type { ReactNode } from "react";
import type { SortDir } from "../lib/tableSort";
import type { TableSort } from "../hooks/useTableSort";

interface SortableThProps {
  label: ReactNode;
  sortKey: string;
  table: TableSort;
  /** Direction the first click applies; numeric columns often want "desc". */
  defaultDir?: SortDir;
  className?: string;
  title?: string;
}

/**
 * Clickable header cell wired to useTableSort. Shows an arrow on the
 * active column and exposes aria-sort for screen readers.
 */
export function SortableTh({
  label,
  sortKey,
  table,
  defaultDir = "asc",
  className,
  title,
}: SortableThProps) {
  const active = table.sort?.key === sortKey;
  const arrow = !active ? "" : table.sort?.dir === "asc" ? " ▴" : " ▾";
  return (
    <th
      aria-sort={table.ariaSortFor(sortKey)}
      className={className ? `sortable-th ${className}` : "sortable-th"}
      title={title ?? "Click to sort"}
    >
      <button
        type="button"
        className="sortable-th-button"
        onClick={() => table.toggle(sortKey, defaultDir)}
      >
        {label}
        <span className="sortable-th-arrow" aria-hidden="true">{arrow}</span>
      </button>
    </th>
  );
}
