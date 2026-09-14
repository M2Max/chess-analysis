import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Chess } from "chess.js";

// Click-to-move support: pick a piece, show dots on legal destinations,
// click a dot to play the move (same commit path as drag&drop).
//
// The wooden board keeps the same square colours in both themes, so dot
// colours are chosen per TARGET SQUARE colour (dark ink on light squares,
// cream on dark ones) - always visible.

const DOT_LIGHT = "rgba(38, 19, 10, 0.42)";
const DOT_DARK = "rgba(255, 236, 210, 0.55)";
const SEL_BG = "rgba(245, 200, 80, 0.45)";

export function isLightSquare(sq: string): boolean {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]);
  return (f + r) % 2 === 0; // a1 dark, h1 light
}

/** Legal destinations for the piece on `sq` -> Map<square, isCapture>. */
export function legalTargets(fen: string, sq: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  try {
    const ch = new Chess(fen);
    for (const m of ch.moves({ square: sq as never, verbose: true })) {
      out.set(m.to, m.captured != null);
    }
  } catch {
    // bad fen / bad square: no dots
  }
  return out;
}

export function pieceAt(
  ch: Chess,
  sq: string,
): { type: string; color: "w" | "b" } | null {
  try {
    const p = ch.get(sq as never);
    return p ?? null;
  } catch {
    return null;
  }
}

/** Queen auto-promotion when a pawn of `fen`'s side-to-move reaches the back rank. */
export function promoFor(chessLike: Chess, from: string, to: string): string | undefined {
  const p = pieceAt(chessLike, from);
  return p?.type === "p" && (to[1] === "8" || to[1] === "1") ? "q" : undefined;
}

/** squareStyles map for react-chessboard: selection tint + dots / capture rings. */
export function clickMoveStyles(fen: string, sel: string | null): Record<string, CSSProperties> {
  if (!sel) return {};
  const styles: Record<string, CSSProperties> = { [sel]: { backgroundColor: SEL_BG } };
  for (const [to, capture] of legalTargets(fen, sel)) {
    const c = isLightSquare(to) ? DOT_LIGHT : DOT_DARK;
    styles[to] = {
      backgroundImage: capture
        ? `radial-gradient(circle, transparent 56%, ${c} 58%)`
        : `radial-gradient(circle, ${c} 17%, transparent 19%)`,
    };
  }
  return styles;
}

/** Resolve the chess square under a pointer event (react-chessboard v5 marks
 *  every square with id `chessboard-square-<sq>` / data-square). */
function squareFromPointer(e: PointerEvent, container: HTMLElement): string | null {
  const stack =
    typeof document.elementFromPoint === "function"
      ? document.elementFromPoint(e.clientX, e.clientY)
      : (e.target as HTMLElement | null);
  let node: Element | null = stack;
  if (node && !node.closest("[id^='chessboard-square-'], [data-square]")) {
    // elementFromPoint may miss the board layer: fall back to e.target chain
    node = (e.target as Element | null) ?? null;
  }
  const sq = node?.closest?.("[id^='chessboard-square-'], [data-square]");
  if (!sq || !container.contains(sq)) return null;
  const id = sq.id || "";
  if (id.startsWith("chessboard-square-")) return id.slice("chessboard-square-".length);
  return sq.getAttribute("data-square");
}

/**
 * Click-to-move hook for react-chessboard v5.
 *
 * IMPORTANT: the library's own square click/mouse callbacks are unreliable -
 * dnd-kit swallows `click` on occupied squares, and its touch preventDefault
 * kills the compat mouse events on mobile. So we listen to POINTER events
 * (mouse + touch + pen) in CAPTURE phase directly on the board wrapper and
 * resolve squares from coordinates. A tap = pointerdown and pointerup on the
 * SAME square; real drags end elsewhere and are ignored (onPieceDrop rules).
 *
 * Pass fen=null to disable (locked board): no dots, no selection.
 */
export function useClickMove(
  fen: string | null,
  commit: (from: string, to: string, promotion?: string) => void,
  wrapRef: RefObject<HTMLElement | null>,
) {
  const [clickSel, setClickSel] = useState<string | null>(null);
  const downRef = useRef<string | null>(null);

  // any position change deselects
  useEffect(() => setClickSel(null), [fen]);

  const styles = useMemo(
    () => clickMoveStyles(fen ?? "", fen ? clickSel : null),
    [fen, clickSel],
  );

  // keep latest values for the (stable) native listeners
  const stateRef = useRef({ fen, clickSel, commit });
  stateRef.current = { fen, clickSel, commit };

  // listeners live on WINDOW (capture) so board mount timing never matters;
  // at event time we check the square belongs to OUR board wrapper
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      downRef.current = wrapRef.current ? squareFromPointer(e, wrapRef.current) : null;
    };
    const onUp = (e: PointerEvent) => {
      const { fen: f, clickSel: sel, commit: doCommit } = stateRef.current;
      const square = wrapRef.current ? squareFromPointer(e, wrapRef.current) : null;
      const down = downRef.current;
      downRef.current = null;
      if (!square || !f || down !== square) return; // drag / stray release / outside
      let ch: Chess;
      try {
        ch = new Chess(f);
      } catch {
        return;
      }
      if (sel && square !== sel && legalTargets(f, sel).has(square)) {
        doCommit(sel, square, promoFor(ch, sel, square));
        setClickSel(null);
        return;
      }
      const p = pieceAt(ch, square);
      setClickSel(p && p.color === ch.turn() && square !== sel ? square : null);
    };
    const onCancel = () => {
      downRef.current = null;
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
    };
  }, [wrapRef]);

  return { styles };
}
