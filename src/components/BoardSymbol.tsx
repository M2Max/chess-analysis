import { useLayoutEffect, useState, type RefObject } from "react";
import { categoryBgClass, categoryDarkClass, hasSymbol, type Category } from "../engine/classify";
import { CategorySymbol } from "./CategorySymbol";

interface Props {
  /** the square the analyzed piece moved TO (e.g. "e4"); null → no badge */
  square: string | null;
  category: Category | null;
  /** re-measure when the board orientation flips */
  orientation: "white" | "black";
  /** the `relative` div wrapping the Chessboard */
  boardWrapRef: RefObject<HTMLDivElement | null>;
}

interface BadgePos {
  left: number;
  top: number;
  size: number;
}

/**
 * Classification badge drawn ON the board: a solid circle in
 * a lighter shade of the category color, with the move symbol (`!`, `!?`, `?`,
 * `??`, `???`) in a darker shade, in the top-right corner
 * of the square the analyzed piece moved to. Pure overlay -
 * `pointer-events: none`, never blocks board interaction.
 */
export function BoardSymbol({ square, category, orientation, boardWrapRef }: Props) {
  const [pos, setPos] = useState<BadgePos | null>(null);
  const s = square && category ? hasSymbol(category) : null;

  useLayoutEffect(() => {
    if (!s || !square) {
      setPos(null);
      return;
    }
    const wrap = boardWrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const sqEl = document.getElementById(`chessboard-square-${square}`);
      if (!wrapRect.width || !sqEl) return;
      const r = sqEl.getBoundingClientRect();
      // badge ≈ 75% of a square wide, clamped 24-42px
      const size = Math.min(42, Math.max(24, Math.round(r.width * 0.75)));
      setPos({
        left: r.left - wrapRect.left + r.width - size / 2 - 1,
        top: r.top - wrapRect.top - size / 2 + 1,
        size,
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, [s, square, category, orientation, boardWrapRef]);

  if (!s) return null;
  return (
    <div
      data-board-symbol
      aria-hidden
      className={`pointer-events-none absolute z-10 flex items-center justify-center rounded-full font-bold leading-none ring-1 ring-black/10 ${categoryBgClass(category)} ${categoryDarkClass(category)}`}
      style={{
        width: pos?.size ?? 0,
        height: pos?.size ?? 0,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // no transition: the badge must appear/disappear instantly per move,
        // never glide between squares
        fontSize: Math.round((pos?.size ?? 24) * 0.52),
      }}
    >
      <CategorySymbol category={category!} />
    </div>
  );
}
