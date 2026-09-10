import type { CSSProperties } from "react";

/**
 * Chessboard square colours (shared by every board in the app).
 * Light squares = parchment tan, dark squares = walnut brown.
 */
export const BOARD_LIGHT = "#dbc196";
export const BOARD_DARK = "#673728";

export const boardLightSquareStyle: CSSProperties = { backgroundColor: BOARD_LIGHT };
export const boardDarkSquareStyle: CSSProperties = { backgroundColor: BOARD_DARK };
