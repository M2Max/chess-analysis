/**
 * Lichess "staunty" chess pieces (CC0), embedded as raw SVG so the board is
 * theme-independent (the SVGs carry their own fills and strokes).
 *
 * react-chessboard v5's `pieces` option maps a piece key (wK, bP, ...) to a
 * render function returning an SVG element with the 50x50 viewBox.
 */
import type { PieceRenderObject } from "react-chessboard";

import wK from "../assets/pieces/wK.svg?raw";
import wQ from "../assets/pieces/wQ.svg?raw";
import wR from "../assets/pieces/wR.svg?raw";
import wB from "../assets/pieces/wB.svg?raw";
import wN from "../assets/pieces/wN.svg?raw";
import wP from "../assets/pieces/wP.svg?raw";
import bK from "../assets/pieces/bK.svg?raw";
import bQ from "../assets/pieces/bQ.svg?raw";
import bR from "../assets/pieces/bR.svg?raw";
import bB from "../assets/pieces/bB.svg?raw";
import bN from "../assets/pieces/bN.svg?raw";
import bP from "../assets/pieces/bP.svg?raw";

function piece(raw: string) {
  // strip the outer <svg ...> wrapper: the library renders its own <svg>
  // container and scales the returned element to the square
  const inner = raw.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "").trim();
  return () => (
    <svg viewBox="0 0 50 50" style={{ width: "100%", height: "100%", display: "block" }} dangerouslySetInnerHTML={{ __html: inner }} />
  );
}

export const STAUNTY_PIECES: PieceRenderObject = {
  wK: piece(wK),
  wQ: piece(wQ),
  wR: piece(wR),
  wB: piece(wB),
  wN: piece(wN),
  wP: piece(wP),
  bK: piece(bK),
  bQ: piece(bQ),
  bR: piece(bR),
  bB: piece(bB),
  bN: piece(bN),
  bP: piece(bP),
};
