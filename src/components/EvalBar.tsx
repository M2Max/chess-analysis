import type React from "react";
import type { Score } from "../engine/classify";
import { evalWhitePct, formatEval } from "../engine/classify";

interface Props {
  score: Score | null;
  sideToMove: "w" | "b";
  /** board seen from Black - White fills from the top */
  flipped?: boolean;
}

/**
 * Chess.com-style vertical evaluation bar: stacked white/black sections
 * (White fills from the bottom, or from the top when the board is flipped)
 * with the evaluation number inside the dominant section.
 */
export function EvalBar({ score, sideToMove, flipped = false }: Props) {
  const pct = evalWhitePct(score, sideToMove);
  const label = formatEval(score, sideToMove);
  const whiteLeads = pct >= 50;
  // White's section is anchored at the bottom (or at the top when flipped);
  // it is >= 50% tall when White leads, so a small inset is always inside it.
  const whiteAlign = flipped ? { top: 0 } : { bottom: 0 };
  // the number sits inside the dominant section, near its outer edge
  const labelStyle: React.CSSProperties = (whiteLeads) !== flipped ? { bottom: 4 } : { top: 4 };

  return (
    <div
      className="relative w-4 shrink-0 self-stretch overflow-hidden rounded-sm bg-neutral-950 ring-1 ring-neutral-600"
      aria-hidden
    >
      {/* White's share */}
      <div
        className="absolute inset-x-0 bg-neutral-100 transition-[height] duration-300 ease-out"
        style={{ height: `${pct}%`, ...whiteAlign }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-neutral-500/60" />
      {/* evaluation number, inside the dominant colour, contrasting text */}
      <div
        className={`pointer-events-none absolute inset-x-0 text-center text-[10px] font-bold leading-none tabular-nums ${
          whiteLeads ? "text-neutral-900" : "text-neutral-100"
        }`}
        style={labelStyle}
      >
        {label}
      </div>
    </div>
  );
}
