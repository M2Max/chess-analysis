/**
 * Opening recognition (Lichess opening names dataset, CC0).
 *
 * `scripts/fetch-openings.ts` builds public/openings.json: a map from
 * "<placement> <sideToMove>" (FEN minus castling/en-passant/counters) to
 * [eco, name, shortestLineDepth]. This module loads it lazily and classifies
 * a game by walking its positions forward from move 1: the last position
 * still in the book names the opening, and every move up to it is a book
 * ("opening") move. That is the full-game form of the dataset's suggested
 * "play moves backwards until a named position is found".
 */
import { Chess } from "chess.js";

export interface Opening {
  eco: string;
  name: string;
  /** plies of the game covered by the book (moves classified "opening") */
  depth: number;
}

export type OpeningIndex = Record<string, [string, string, number]>;

let indexPromise: Promise<OpeningIndex | null> | null = null;

/** Load the opening index once (null when the file is missing/offline). */
export function openingIndex(): Promise<OpeningIndex | null> {
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}openings.json`);
        if (!res.ok) return null;
        const data = (await res.json()) as OpeningIndex;
        return data && typeof data === "object" ? data : null;
      } catch {
        return null;
      }
    })();
  }
  return indexPromise;
}

/** Test hook / offline use: bypass the fetch. */
export function setOpeningIndexForTests(index: OpeningIndex | null): void {
  indexPromise = Promise.resolve(index);
}

/**
 * Recognise the opening of a move sequence (SAN). Returns the book entry at
 * the end of the game's contiguous in-book prefix, or null when the game
 * leaves the book immediately (or the index is unavailable).
 */
export function detectOpening(sans: string[], index: OpeningIndex | null): Opening | null {
  if (!index || sans.length === 0) return null;
  const chess = new Chess();
  let last: Opening | null = null;
  for (let i = 0; i < sans.length; i++) {
    let mv: { san: string } | null = null;
    try {
      mv = chess.move(sans[i]);
    } catch {
      break; // illegal SAN - stop
    }
    if (!mv) break;
    const key = chess.fen().split(" ").slice(0, 2).join(" ");
    const hit = index[key];
    if (hit) {
      // depth = the game's own ply count here (transpositions may reach the
      // position longer than the book's shortest line)
      last = { eco: hit[0], name: hit[1], depth: i + 1 };
    } else {
      break; // the contiguous book prefix ends at this move
    }
  }
  return last;
}
