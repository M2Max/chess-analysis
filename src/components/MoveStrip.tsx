/**
 * Mobile move strip - horizontal slider, mobile-app style.
 *
 * - Shows a window of 5 moves (center + 2 on each side); the selected move
 *   is centered.
 * - Moves are revealed as analysis completes (same `line` model as the
 *   desktop MoveList); while the cursor is at the tip the strip slides
 *   forward on its own until the end of the game.
 * - Touch-drag (or mouse-drag) slides the strip; releasing steps the
 *   selection by however many cells were crossed, updating the board.
 * - Tap selects the move under the finger.
 *
 * Desktop uses the vertical MoveList instead (this strip is `lg:hidden`).
 */

import { useEffect, useRef, useState } from "react";
import { categoryColorClass, hasSymbol } from "../engine/classify";
import { useI18n } from "../i18n";
import { CategorySymbol } from "./CategorySymbol";
import type { ReviewState } from "../state/review";

interface Props {
  state: ReviewState;
  /** select the position after move #n of the current line (1-based) */
  onSelectMove: (n: number) => void;
}

export const CELL = 64; // px
export const GAP = 8; // px
export const PITCH = CELL + GAP;

/**
 * Translate X for the track. The selected cell (`centerIdx`) is ALWAYS
 * centered in the container - including the tip during analysis and the last
 * move at the end of the game (2 cells to its left, 0 to its right). At the
 * start of the game there is simply less content on one side.
 */
export function stripTransform(
  containerW: number,
  n: number,
  centerIdx: number,
): number {
  if (n === 0) return 0;
  return containerW / 2 - (centerIdx * PITCH + CELL / 2);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface DragState {
  startX: number;
  baseT: number;
  dx: number;
  cursor: number;
}

export function MoveStrip({ state, onSelectMove }: Props) {
  const { t } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setContainerW(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lineMoves = state.line.slice(1);
  const n = lineMoves.length;
  const centerIdx = clamp(state.cursor - 1, 0, Math.max(0, n - 1));
  const baseT = stripTransform(containerW, n, centerIdx);
  const tx = drag ? baseT + drag.dx : baseT;
  // fractional center in cell units - follows the finger while dragging so
  // the focus fade/blur slides smoothly instead of snapping
  const floatCenter = containerW > 0 ? (containerW / 2 - tx - CELL / 2) / PITCH : centerIdx;
  const focus = (i: number) => {
    const d = Math.abs(i - floatCenter);
    const fade = Math.min(0.75, Math.max(0, d - 1) * 0.5);
    return {
      opacity: 1 - fade,
      blur: Math.min(2.4, Math.max(0, d - 1) * 1.2),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (n === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ startX: e.clientX, baseT, dx: 0, cursor: state.cursor });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    setDrag((d) => (d ? { ...d, dx: e.clientX - d.startX } : d));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    setDrag((d) => {
      if (!d) return null;
      const dx = e.clientX - d.startX;
      if (Math.abs(dx) > 6) {
        // swipe: step by the number of cells crossed
        const steps = Math.round(-dx / PITCH);
        onSelectMove(clamp(d.cursor + steps, 0, state.line.length - 1));
      } else {
        // tap: select the cell under the pointer
        const rect = wrapRef.current?.getBoundingClientRect();
        if (rect) {
          const idx = Math.floor((e.clientX - rect.left - tx) / PITCH);
          if (idx >= 0 && idx < n) onSelectMove(idx + 1);
        }
      }
      return null;
    });
  };

  return (
    <div
      ref={wrapRef}
      className="relative mt-3 h-[52px] select-none overflow-hidden lg:hidden"
      style={{ touchAction: "pan-y" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label={t("moveStripAria")}
    >
      {n === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-ink-faint">
          {t("noMovesYet")}
        </div>
      ) : (
        <div
          className="flex h-full items-center"
          style={{
            gap: GAP,
            transform: `translateX(${tx}px)`,
            transition: drag ? "none" : "transform 220ms ease-out",
            willChange: "transform",
          }}
        >
          {lineMoves.map((idx, i) => {
            const node = state.nodes[idx];
            // cursor 0 = start position (before any move): highlight move 1,
            // so the centered cell always carries the selection glow
            const isCurrent = state.cursor === i + 1 || (state.cursor === 0 && i === 0);
            const { opacity, blur } = focus(i);
            return (
              <div
                key={idx}
                data-current={isCurrent ? "1" : undefined}
                className={`flex h-11 shrink-0 flex-col items-center justify-center rounded-md text-sm ring-1 ${
                  // selected: green text + glow only - NO background
                  isCurrent
                    ? "bg-transparent text-accent-soft-text ring-transparent"
                    : "bg-card-solid/70 text-ink-soft ring-line"
                }`}
                style={{
                  width: CELL,
                  opacity,
                  filter: blur > 0 ? `blur(${blur}px)` : undefined,
                  // green glow when selected - no highlight background
                  boxShadow: isCurrent
                    ? "0 0 14px rgba(52, 211, 153, 0.55), 0 0 4px rgba(52, 211, 153, 0.35)"
                    : undefined,
                  transition: drag ? "none" : "opacity 200ms ease-out, filter 200ms ease-out, box-shadow 200ms ease-out, color 150ms",
                }}
              >
                <span className={`flex items-center gap-0.5 font-medium ${node.isMainline ? "" : "text-branch"}`}>
                  {node.move?.san}
                  {hasSymbol(node.category) && (
                    <span className={`text-xs font-bold ${categoryColorClass(node.category)}`}>
                      <CategorySymbol category={node.category} />
                    </span>
                  )}
                  {!node.isMainline && <span className="text-[9px] text-branch/70">◦</span>}
                </span>
                <span className="text-[10px] tabular-nums text-ink-faint">
                  {node.thinking ? (
                    <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-ink-faint border-t-transparent align-middle" />
                  ) : (
                    i + 1
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
