import type { PointRole } from "../data/types";

/** Short badge labels (table / chart annotations). */
export const ROLE_LABELS: Record<PointRole, string> = {
  reactant: "Reactant",
  ts: "TS",
  intermediate: "Int",
  product: "Product",
};

/** Full labels for the role <select> in the builder. */
export const ROLE_OPTION_LABELS: Record<PointRole, string> = {
  reactant: "Reactant",
  ts: "TS",
  intermediate: "Intermediate",
  product: "Product",
};

export const ROLE_COLORS: Record<PointRole, { dark: string; light: string }> = {
  reactant: { dark: "#5eead4", light: "#0D9488" },
  ts: { dark: "#fb7185", light: "#E11D48" },
  intermediate: { dark: "#fbbf24", light: "#D97706" },
  product: { dark: "#60a5fa", light: "#2563EB" },
};

export function RoleBadge({ role }: { role: PointRole }) {
  return <span className={`role-badge role-${role}`}>{ROLE_LABELS[role]}</span>;
}
