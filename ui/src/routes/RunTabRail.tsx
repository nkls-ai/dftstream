import { ANALYSIS_TAB_IDS, type Tab } from "./runDetailTabs";

const TAB_ICON_PROPS = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "tab-icon", "aria-hidden": true as const };

function TabIcon({ name }: { name: Tab }) {
  const p = TAB_ICON_PROPS;
  switch (name) {
    case "overview":
      return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
    case "structure":
      return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>;
    case "ts":
      return <svg {...p}><path d="M3 20Q8 20 10 10Q12 2 14 10Q16 20 21 20" /><circle cx="12" cy="4" r="2" /><path d="M12 6v3M10 7.5h4" /></svg>;
    case "scf":
      return <svg {...p}><path d="M2 12c2-4 4-8 6-4s4 8 6 4 4-8 6-4" /><line x1="2" y1="20" x2="22" y2="20" /></svg>;
    case "hardware":
      return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></svg>;
    case "goat":
      return <svg {...p}><path d="M12 2l3 7h-6l3-7zM6 14l-2 8h16l-2-8" /><circle cx="12" cy="13" r="3" /></svg>;
    case "scan":
      return <svg {...p}><path d="M3 20Q7 4 12 12Q17 20 21 4" /><line x1="3" y1="20" x2="21" y2="20" /></svg>;
    case "path":
      return <svg {...p}><circle cx="4" cy="18" r="2" /><circle cx="20" cy="18" r="2" /><path d="M6 18Q8 4 12 6Q16 8 18 18" /><circle cx="12" cy="6" r="2" /></svg>;
    case "excited":
      return <svg {...p}><path d="M12 2v4M12 18v4" /><circle cx="12" cy="12" r="4" /><path d="M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M19.07 4.93l-2.83 2.83M7.76 16.24l-2.83 2.83" /></svg>;
    case "nmr":
      return <svg {...p}><path d="M3 12h3l2-8 3 16 2-8h3" /><circle cx="19" cy="12" r="2" /></svg>;
    case "irc":
      return <svg {...p}><path d="M3 18Q8 18 12 4Q16 18 21 18" /><circle cx="3" cy="18" r="1.5" /><circle cx="21" cy="18" r="1.5" /><circle cx="12" cy="4" r="2" /></svg>;
    case "mecp":
      return <svg {...p}><path d="M3 18Q8 6 12 12Q16 18 21 6" /><path d="M3 6Q8 18 12 12Q16 6 21 18" /><circle cx="12" cy="12" r="2.5" /></svg>;
    case "artifacts":
      return <svg {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;
    case "log":
      return <svg {...p}><path d="M12 12H3M16 6H3M21 18H3" /></svg>;
  }
}

/** The vertical tab rail on the run detail page. */
export function RunTabRail({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: Tab; label: string }[];
  active: Tab;
  onSelect: (t: Tab) => void;
}) {
  return (
    <div className="tabs tabs-rail" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={
            "tab" +
            (ANALYSIS_TAB_IDS.includes(t.id) ? " tab-analysis" : "") +
            (t.id === active ? " active" : "")
          }
          onClick={() => onSelect(t.id)}
          role="tab"
          tabIndex={0}
          aria-selected={t.id === active}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(t.id); } }}
        >
          <TabIcon name={t.id} />
          {t.label}
        </div>
      ))}
    </div>
  );
}
