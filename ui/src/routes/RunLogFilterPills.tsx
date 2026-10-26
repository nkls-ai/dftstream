export function RunLogFilterPills({
  allLabel,
  values,
  active,
  onSelect,
  pillClass = "scf-pill",
}: {
  allLabel: string;
  values: string[];
  active: string | null;
  onSelect: (value: string | null) => void;
  pillClass?: string;
}) {
  return (
    <div className="scf-pills" style={{ marginTop: 4 }}>
      <button
        type="button"
        className={"scf-pill" + (active == null ? " active" : "")}
        onClick={() => onSelect(null)}
      >
        {allLabel}
      </button>
      {values.map((v) => (
        <button
          type="button"
          key={v}
          className={pillClass + (active === v ? " active" : "")}
          onClick={() => onSelect(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
