import { useMemo, useRef } from "react";
import type { AnalysisNode } from "../state/review";
import { useI18n } from "../i18n";

interface Props {
  /** nodes of the CURRENT line, in order (node 0 = start position) */
  nodes: AnalysisNode[];
  /** index into `nodes` of the displayed position */
  cursor: number;
  onSelect: (cursor: number) => void;
  /** board seen from Black - the chart mirrors vertically */
  flipped?: boolean;
}

/** cp at which the curve is ~saturated (tanh(2) ≈ 0.96) */
const SCALE_CP = 300;
/** mate always plots pinned at this value */
const MATE_CP = 600;

/** Evaluation of a node from WHITE's point of view (cp), null if unanalysed. */
function whiteCp(node: AnalysisNode): number | null {
  const s = node.score;
  if (!s) return null;
  const stm = node.move ? (node.move.color === "w" ? "b" : "w") : "w";
  if (s.mate != null) {
    const wm = stm === "w" ? s.mate : -s.mate;
    return wm > 0 ? MATE_CP : -MATE_CP;
  }
  return (s.cp ?? 0) * (stm === "w" ? 1 : -1);
}

/** cp -> y coordinate (0 = top, 100 = bottom; White advantage goes UP) */
function yOf(cp: number, flipped: boolean): number {
  const y = 50 - 50 * Math.tanh(cp / SCALE_CP);
  return flipped ? 100 - y : y;
}

/**
 * Chess.com-style advantage graph: White fills below the curve, Black above,
 * midline at 0. Grows live while the analysis runs; click to jump to a move.
 */
export function EvalChart({ nodes, cursor, onSelect, flipped = false }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);

  // plot up to the last analysed position (the curve grows during analysis)
  const pts = useMemo(() => {
    const out: number[] = [];
    for (const n of nodes) {
      const cp = whiteCp(n);
      if (cp == null) break;
      out.push(cp);
    }
    return out;
  }, [nodes]);

  const n = Math.max(pts.length - 1, 1);
  const xLast = pts.length - 1;
  const pairs = pts.map((cp, i) => `${i},${yOf(cp, flipped).toFixed(2)}`);
  const line = pairs.join(" "); // polyline
  const curve = "M" + pairs.join(" L"); // path
  const whiteArea = pts.length >= 2 ? `${curve} L${xLast},100 L0,100 Z` : "";
  const blackArea = pts.length >= 2 ? `${curve} L${xLast},0 L0,0 Z` : "";
  const markerX = Math.min(Math.max(cursor, 0), xLast);

  const handleClick = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || pts.length < 2) return;
    const rect = el.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    onSelect(Math.min(Math.max(Math.round(frac * xLast), 0), xLast));
  };

  return (
    <div
      ref={ref}
      className="relative mt-3 h-28 w-full cursor-pointer select-none overflow-hidden rounded-md bg-card ring-1 ring-line"
      onClick={handleClick}
      title={t("evalChartTitle")}
      role="img"
      aria-label={t("evalChartTitle")}
    >
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox={`0 0 ${n} 100`}
        preserveAspectRatio="none"
      >
        {whiteArea && <path d={whiteArea} fill="#f5f5f5" stroke="none" />}
        {blackArea && <path d={blackArea} fill="#0a0a0a" stroke="none" />}
        <line x1={0} y1={50} x2={n} y2={50}
          stroke="#737373"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        {pts.length >= 2 && (
          <polyline
            points={line}
            fill="none"
            stroke="#a3a3a3"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* current position marker */}
        <line
          x1={markerX}
          y1={0}
          x2={markerX}
          y2={100}
          stroke="#3f8cfb"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
