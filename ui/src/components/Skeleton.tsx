function Skel({ w, h = 14, r = 4, style }: { w?: string | number; h?: number; r?: number; style?: React.CSSProperties }) {
  return (
    <div
      className="skel"
      style={{ width: w ?? "100%", height: h, borderRadius: r, ...style }}
    />
  );
}

const SKELETON_LINE_WIDTHS = ["82%", "64%", "72%", "48%", "58%"];

function SkeletonLines({
  rows = 5,
  widths,
}: {
  rows?: number;
  widths?: Array<string | number>;
}) {
  return (
    <div className="skel-lines">
      {Array.from({ length: rows }, (_, i) => (
        <Skel key={i} w={widths?.[i] ?? SKELETON_LINE_WIDTHS[i % SKELETON_LINE_WIDTHS.length]} h={12} />
      ))}
    </div>
  );
}

export function SkeletonPanel({
  rows = 5,
  height,
}: {
  rows?: number;
  height?: number;
}) {
  return (
    <div className="skel-panel" style={height ? { minHeight: height } : undefined}>
      <div className="skel-panel-head">
        <Skel w={160} h={18} />
        <Skel w={72} h={18} r={999} />
      </div>
      <SkeletonLines rows={rows} />
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div className="skel-panel skel-chart">
      <div className="skel-chart-grid">
        <Skel w="88%" h={2} />
        <Skel w="76%" h={2} />
        <Skel w="92%" h={2} />
        <Skel w="68%" h={2} />
      </div>
      <Skel w="72%" h={3} style={{ position: "absolute", left: 36, bottom: 54, transform: "rotate(-8deg)", transformOrigin: "left center" }} />
      <Skel w="44%" h={3} style={{ position: "absolute", left: "42%", bottom: 86, transform: "rotate(12deg)", transformOrigin: "left center" }} />
    </div>
  );
}

export function SkeletonArtifactViewer() {
  return (
    <div className="skel-artifact">
      <div className="skel-artifact-tree">
        <Skel w="70%" h={14} />
        <SkeletonLines rows={10} widths={["62%", "78%", "52%", "68%", "46%"]} />
      </div>
      <div className="skel-artifact-body">
        <Skel w={220} h={20} />
        <Skel w="86%" h={12} />
        <div className="skel-code-block">
          <SkeletonLines rows={16} widths={["92%", "64%", "80%", "74%", "88%", "52%"]} />
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="skel-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Skel w={180} h={20} />
        <Skel w={60} h={16} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Skel w={52} h={12} />
        <Skel w={52} h={12} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Skel w={56} h={22} r={6} />
        <Skel w={72} h={22} r={6} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Skel w={100} h={11} />
        <Skel w={120} h={11} />
      </div>
    </div>
  );
}

export function SkeletonCards({ count = 6 }: { count?: number }) {
  return (
    <div className="skel-grid">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

const SKELETON_ROW_WIDTHS = [32, 140, 100, 80, 80, 60, 90];

function SkeletonTableRow({ cols = 5 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }, (_, i) => (
        <td key={i}>
          <Skel w={SKELETON_ROW_WIDTHS[i % SKELETON_ROW_WIDTHS.length]} h={14} />
        </td>
      ))}
    </tr>
  );
}

export function SkeletonTable({ rows = 8, cols = 7 }: { rows?: number; cols?: number }) {
  return (
    <table className="table">
      <thead>
        <tr>
          {Array.from({ length: cols }, (_, i) => (
            <th key={i}><Skel w={60 + (i % 3) * 20} h={12} /></th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonTableRow key={i} cols={cols} />
        ))}
      </tbody>
    </table>
  );
}

export function SkeletonDetail() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Skel w={200} h={28} />
        <Skel w={70} h={22} r={6} />
        <Skel w={110} h={22} r={6} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skel key={i} w={80} h={32} r={6} />
        ))}
      </div>
      <Skel h={200} r={10} />
    </div>
  );
}
