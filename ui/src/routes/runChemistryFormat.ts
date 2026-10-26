/** Recharts tooltip/axis formatters for chemistry widgets. */

export function formatKcalTooltipValue(value: unknown): string {
  return typeof value === "number"
    ? `${value.toFixed(2)} kcal/mol`
    : String(value ?? "—");
}

export function formatAbsorbanceTooltipValue(value: unknown): string {
  return typeof value === "number" ? value.toFixed(1) : String(value ?? "—");
}

export function formatWavenumberLabel(value: unknown): string {
  return typeof value === "number"
    ? `${value.toFixed(0)} cm⁻¹`
    : String(value ?? "—");
}
