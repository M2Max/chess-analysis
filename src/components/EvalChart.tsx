import { useMemo, useRef } from "react";
import type { AnalysisNode } from "../state/review";
import { useI18n } from "../i18n";

interface Props {
  /** nodes of the CURRENT line, in order (node 0 = start position) */
  nodes: AnalysisNode[];
  /** index into `nodes` of the displayed position */
  cursor: number;
  onSelect: (cursor: number) => void;
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
function yOf(cp: number): number {
  return 50 - 50 * Math.tanh(cp / SCALE_CP);
}

/**
 * Chess.com-style advantage graph: White fills below the curve, Black above,
 * midline at 0. Grows live while the analysis runs; click to jump to a move.
 * Orientation is FIXED - White's side is always the bottom half and colours
 * always mean what they say, regardless of how the board is oriented.
 */
export function EvalChart({ nodes, cursor, onSelect }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);

  // scored nodes only, keyed by their index in the line (x stays aligned
  // with move numbers). Note: a cached/hydrated game has NO score on node 0
  // (the start position is not a move), so this must not assume a full prefix.
  const pts = useMemo(() => {
    const out: { x: number; cp: number }[] = [];
    nodes.forEach((node, i) => {
      const cp = whiteCp(node);
      if (cp != null) out.push({ x: i, cp });
    });
    return out;
  }, [nodes]);

  const n = Math.max(nodes.length - 1, 1);
  const xLast = n;
  const pairs = pts.map((p) => `${p.x},${yOf(p.cp).toFixed(2)}`);
  const line = pairs.join(" "); // polyline
  const curve = "M" + pairs.join(" L"); // path
  const firstX = pts[0]?.x ?? 0;
  const lastX = pts[pts.length - 1]?.x ?? 0;
  const whiteArea = pts.length >= 2 ? `${curve} L${lastX},100 L${firstX},100 Z` : "";
  const blackArea = pts.length >= 2 ? `${curve} L${lastX},0 L${firstX},0 Z` : "";
  const markerX = Math.min(Math.max(cursor, 0), xLast);

  const handleClick = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el || n < 1) return;
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
