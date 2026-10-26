import type { ReactNode } from "react";

/** Titled section wrapper for the settings page. */
export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">{title}</h2>
      {children}
    </section>
  );
}

function RowLabel({ label, desc }: { label: string; desc?: string }) {
  if (!desc) return <div className="settings-row-label">{label}</div>;
  return (
    <div>
      <div className="settings-row-label">{label}</div>
      <div className="settings-row-desc">{desc}</div>
    </div>
  );
}

/** A settings row with a toggle switch. */
export function SettingsToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <RowLabel label={label} desc={desc} />
      <label className="settings-toggle">
        <input
          type="checkbox"
          aria-label={label}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="settings-toggle-track" />
      </label>
    </div>
  );
}

/** A settings row with a select. `onChange` receives the raw option value string. */
export function SettingsSelectRow({
  label,
  desc,
  value,
  options,
  onChange,
}: {
  label: string;
  desc?: string;
  value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (raw: string) => void;
}) {
  return (
    <div className="settings-row">
      <RowLabel label={label} desc={desc} />
      <select
        className="settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
