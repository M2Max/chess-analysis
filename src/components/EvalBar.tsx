import type { Score } from "../engine/classify";
import { evalWhitePct } from "../engine/classify";

interface Props {
  score: Score | null;
  sideToMove: "w" | "b";
}

/** Vertical evaluation bar. White fills from the bottom. */
export function EvalBar({ score, sideToMove }: Props) {
  const pct = evalWhitePct(score, sideToMove);
  return (
    <div className="relative h-full w-4 shrink-0 overflow-hidden rounded-sm bg-neutral-950 ring-1 ring-neutral-700">
      <div
        className="absolute bottom-0 left-0 right-0 bg-neutral-100 transition-[height] duration-300 ease-out"
        style={{ height: `${pct}%` }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-neutral-500/60" />
    </div>
  );
}
