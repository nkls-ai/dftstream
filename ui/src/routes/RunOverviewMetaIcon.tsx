const META_ICON_PROPS = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className: "meta-strip-icon", "aria-hidden": true as const };

/** Small inline stroke icon for the Overview meta strip / detail grid. */
export function MetaIcon({ name }: { name: string }) {
  const p = META_ICON_PROPS;
  switch (name) {
    case "method":
      return <svg {...p}><path d="M9 3h6M10 3v7.4L4 18a1 1 0 0 0 .87 1.5h14.26A1 1 0 0 0 20 18l-6-7.6V3" /></svg>;
    case "runtype":
      return <svg {...p}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>;
    case "solvent":
      return <svg {...p}><path d="M12 2v6l-4 4a6 6 0 1 0 8 0l-4-4V2" /></svg>;
    case "charge":
      return <svg {...p}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8" /></svg>;
    case "mult":
      return <svg {...p}><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>;
    case "software":
      return <svg {...p}><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>;
    case "cpu":
      return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></svg>;
    case "memory":
      return <svg {...p}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01M6 2v4M10 2v4M14 2v4M18 2v4" /></svg>;
    case "play":
      return <svg {...p}><circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" /></svg>;
    case "check":
      return <svg {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>;
    case "clock":
      return <svg {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
    case "file":
      return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>;
    default:
      return <svg {...p}><circle cx="12" cy="12" r="10" /></svg>;
  }
}
