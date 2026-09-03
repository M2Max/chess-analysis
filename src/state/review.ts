/**
 * Review state: a tree of analysed positions plus a "line" pointer.
 *
 * - Mainline nodes are indices 0..N (node i = position after i played moves;
 *   node 0 = start). Branch nodes are appended after, each with a `parent`.
 * - `line` = node indices from the start to the current line's tip
 *   (mainline + any branch taken).
 * - `cursor` = index into `line` of the position currently displayed.
 *
 * "Back to game" = restore the full mainline and snap the cursor to the
 * mainline node at the current move number (depthFromStart).
 */

import type { Category, MultiLine, Score } from "../engine/classify";
import { accuracyFromMoves, classifyMove, ratingFor, sacrificeValues } from "../engine/classify";
import { cachedMultiToLines, type CachedMove } from "../api/analysisCache";
import type { ParsedGame } from "../engine/parse";
import type { TFn } from "../i18n";

export interface NodeMove {
  san: string;
  uci: string;
  color: "w" | "b";
}

export interface AnalysisNode {
  idx: number;
  parent: number | null;
  fen: string;
  /** plies from the start position */
  depthFromStart: number;
  isMainline: boolean;
  /** the move leading INTO this node (null for the start position) */
  move: NodeMove | null;
  // analysis (null until analysed)
  score: Score | null;
  bestUci: string | null;
  bestSan: string | null;
  pv: string[];
  achievedDepth: number | null;
  /** top-3 lines from this position's side-to-move view (mate-mapped cp) */
  multi: MultiLine[];
  /** classification of `move` */
  category: Category | null;
  /** expected points lost (0..1) by `move` */
  loss: number | null;
  /** centipawns lost versus the best move (mover's view) */
  delta: number | null;
  thinking: boolean;
}

export interface PlayerMeta {
  name: string;
  username: string;
  rating?: number;
  title?: string;
}

export interface ReviewMeta {
  white: PlayerMeta;
  black: PlayerMeta;
  result: string;
  dateLabel: string;
  timeControl: string;
  gameId: string;
}

export type ReviewStatus = "loading" | "analyzing" | "ready" | "error";

export interface ReviewState {
  /** generation counter - drops stale actions after switching games */
  gen: number;
  status: ReviewStatus;
  meta: ReviewMeta | null;
  nodes: AnalysisNode[];
  /** mainline node indices, in order (0..N) */
  mainline: number[];
  /** current line (node indices) from start to tip */
  line: number[];
  /** displayed position = line[cursor] */
  cursor: number;
  progress: { done: number; total: number } | null;
  error: string | null;
}

export type Action =
  | {
      type: "INIT";
      gen: number;
      meta: ReviewMeta;
      nodes: AnalysisNode[];
      mainline: number[];
    }
  | {
      type: "POSITION_DONE";
      gen: number;
      index: number;
      score: Score;
      bestUci: string;
      bestSan: string | null;
      pv: string[];
      depth: number;
      multi: MultiLine[];
    }
  | {
      type: "MOVE_CLASSIFIED";
      gen: number;
      moveIndex: number;
      loss: number;
      /** centipawns lost versus the best move (mover's view) */
      delta: number;
      category: Category;
    }
  | {
      type: "HYDRATE";
      gen: number;
      /** cached mainline moves (moves[i] = mainline index i+1) */
      moves: CachedMove[];
    }
  | { type: "PROGRESS"; gen: number; done: number; total: number }
  | { type: "ANALYSIS_FINISHED"; gen: number }
  | { type: "SET_CURSOR"; cursor: number }
  | { type: "GO_BACK" }
  | { type: "GO_FORWARD" }
  | { type: "GO_FIRST" }
  | { type: "GO_LAST" }
  | { type: "GO_MAINLINE" }
  | { type: "SET_LINE"; line: number[]; cursor: number }
  | { type: "BRANCH_START"; parentIdx: number; move: NodeMove; fen: string }
  | { type: "BRANCH_INFO"; gen: number; nodeIdx: number; score: Score; pv: string[]; depth: number }
  | {
      type: "BRANCH_DONE";
      gen: number;
      nodeIdx: number;
      score: Score | null;
      bestUci: string | null;
      bestSan: string | null;
      pv: string[];
      depth: number;
      /** child position's top-3 lines (opponent's view, mate-mapped cp) */
      multi: MultiLine[];
    }
  | { type: "BRANCH_FAIL"; gen: number; nodeIdx: number }
  | { type: "ERROR"; gen: number; message: string };

export const initialReviewState: ReviewState = {
  gen: 0,
  status: "loading",
  meta: null,
  nodes: [],
  mainline: [],
  line: [],
  cursor: 0,
  progress: null,
  error: null,
};

/** Build the mainline node chain from a parsed game. */
export function buildMainline(parsed: ParsedGame): {
  nodes: AnalysisNode[];
  mainline: number[];
} {
  const nodes: AnalysisNode[] = [];
  const empty = {
    score: null,
    bestUci: null,
    bestSan: null,
    pv: [] as string[],
    achievedDepth: null,
    multi: [] as MultiLine[],
    category: null,
    loss: null,
    delta: null,
    thinking: false,
  };
  const mainline: number[] = [];
  const start: AnalysisNode = {
    idx: 0,
    parent: null,
    fen: parsed.startFen,
    depthFromStart: 0,
    isMainline: true,
    move: null,
    ...empty,
  };
  nodes.push(start);
  mainline.push(0);
  parsed.moves.forEach((m, i) => {
    const idx = nodes.length;
    nodes.push({
      idx,
      parent: mainline[mainline.length - 1],
      fen: m.fenAfter,
      depthFromStart: i + 1,
      isMainline: true,
      move: { san: m.san, uci: m.uci, color: m.color },
      ...empty,
    });
    mainline.push(idx);
  });
  return { nodes, mainline };
}

function clampCursor(state: ReviewState, cursor: number): number {
  return Math.max(0, Math.min(cursor, state.line.length - 1));
}

export function reviewReducer(state: ReviewState, action: Action): ReviewState {
  switch (action.type) {
    case "INIT":
      return {
        gen: action.gen,
        status: "analyzing",
        meta: action.meta,
        nodes: action.nodes,
        mainline: action.mainline,
        line: [action.mainline[0]],
        cursor: 0,
        progress: { done: 0, total: action.mainline.length },
        error: null,
      };

    case "POSITION_DONE": {
      if (action.gen !== state.gen) return state;
      const node = state.nodes[action.index];
      if (!node) return state;
      const nodes = state.nodes.slice();
      nodes[action.index] = {
        ...node,
        score: action.score,
        bestUci: action.bestUci,
        bestSan: action.bestSan,
        pv: action.pv,
        achievedDepth: action.depth,
        multi: action.multi,
      };
      let { line, cursor } = state;
      // while the user is on the mainline, reveal moves as analysis completes
      const onMainline =
        line.length <= state.mainline.length &&
        line.every((idx, i) => idx === state.mainline[i]);
      const nextMainline = state.mainline[line.length];
      if (onMainline && nextMainline !== undefined && action.index === nextMainline) {
        line = [...line, action.index];
        if (cursor === line.length - 2) cursor = line.length - 1; // follow the tip
      }
      return { ...state, nodes, line, cursor };
    }

    case "MOVE_CLASSIFIED": {
      if (action.gen !== state.gen) return state;
      const nodeIdx = state.mainline[action.moveIndex + 1];
      const node = state.nodes[nodeIdx];
      if (!node) return state;
      const nodes = state.nodes.slice();
      nodes[nodeIdx] = { ...node, category: action.category, loss: action.loss, delta: action.delta };
      return { ...state, nodes };
    }
    case "HYDRATE": {
      // instant restore of a cached analysis: fill every mainline node with
      // the stored score / classification / top-3 lines, reveal the whole
      // mainline (no progressive reveal) and park the cursor on the last
      // position - the end state a finished live analysis reaches
      if (action.gen !== state.gen) return state;
      const nodes = state.nodes.slice();
      action.moves.forEach((m, i) => {
        const idx = state.mainline[i + 1];
        const node = nodes[idx];
        if (!node) return;
        nodes[idx] = {
          ...node,
          score: m.score,
          bestUci: m.bestUci,
          bestSan: m.bestSan,
          category: m.category,
          delta: m.delta,
          loss: m.loss,
          multi: cachedMultiToLines(m.multi),
        };
      });
      return {
        ...state,
        nodes,
        line: [...state.mainline],
        cursor: state.mainline.length - 1,
      };
    }

    case "PROGRESS":
      if (action.gen !== state.gen) return state;
      return { ...state, progress: { done: action.done, total: action.total } };

    case "ANALYSIS_FINISHED":
      if (action.gen !== state.gen) return state;
      return { ...state, status: "ready", progress: null };

    case "SET_CURSOR":
      return { ...state, cursor: clampCursor(state, action.cursor) };

    case "GO_BACK":
      return { ...state, cursor: clampCursor(state, state.cursor - 1) };

    case "GO_FORWARD":
      return { ...state, cursor: clampCursor(state, state.cursor + 1) };

    case "GO_FIRST":
      return { ...state, cursor: 0 };

    case "GO_LAST":
      return { ...state, cursor: clampCursor(state, state.line.length - 1) };

    case "GO_MAINLINE": {
      const cur = state.line[state.cursor];
      const curNode = state.nodes[cur];
      if (!curNode) return state;
      const target = Math.min(curNode.depthFromStart, state.mainline.length - 1);
      return { ...state, line: [...state.mainline], cursor: target };
    }

    case "SET_LINE": {
      if (action.line.length === 0) return state;
      return {
        ...state,
        line: action.line,
        cursor: clampCursor({ ...state, line: action.line }, action.cursor),
      };
    }

    case "BRANCH_START": {
      const parent = state.nodes[action.parentIdx];
      if (!parent) return state;
      // reuse an existing branch with the same move from this parent
      const existing = state.nodes.find(
        (n) => n.parent === action.parentIdx && n.move?.uci === action.move.uci,
      );
      const nodeIdx = existing ? existing.idx : state.nodes.length;
      let nodes = state.nodes;
      if (!existing) {
        const node: AnalysisNode = {
          idx: state.nodes.length,
          parent: action.parentIdx,
          fen: action.fen,
          depthFromStart: parent.depthFromStart + 1,
          isMainline: false,
          move: action.move,
          ...{
            score: null,
            bestUci: null,
            bestSan: null,
            pv: [],
            achievedDepth: null,
            multi: [],
            category: null,
            loss: null,
            delta: null,
            thinking: true,
          },
        };
        nodes = [...state.nodes, node];
      }
      const line = [...state.line.slice(0, state.cursor + 1), nodeIdx];
      return { ...state, nodes, line, cursor: line.length - 1 };
    }

    case "BRANCH_INFO": {
      if (action.gen !== state.gen) return state;
      const node = state.nodes[action.nodeIdx];
      if (!node) return state;
      const nodes = state.nodes.slice();
      nodes[action.nodeIdx] = {
        ...node,
        score: action.score,
        pv: action.pv,
        achievedDepth: action.depth,
      };
      return { ...state, nodes };
    }

    case "BRANCH_DONE": {
      if (action.gen !== state.gen) return state;
      const node = state.nodes[action.nodeIdx];
      if (!node || node.parent == null) return state;
      const parent = state.nodes[node.parent];
      let category: Category | null = null;
      let loss: number | null = null;
      let delta: number | null = null;
      if (parent.score && action.score && node.move) {
        const ratings = state.meta
          ? { w: state.meta.white.rating, b: state.meta.black.rating }
          : null;
        const cls = classifyMove({
          prevMulti: parent.multi,
          playedUci: node.move.uci,
          childBest: action.score,
          childMulti: action.multi,
          prevCategory: parent.category,
          rating: ratingFor(ratings, node.move.color),
          ...sacrificeValues(parent.fen, node.move.uci),
        });
        category = cls.category;
        loss = cls.loss;
        delta = cls.delta;
      }
      const nodes = state.nodes.slice();
      nodes[action.nodeIdx] = {
        ...node,
        score: action.score,
        bestUci: action.bestUci,
        bestSan: action.bestSan,
        pv: action.pv,
        achievedDepth: action.depth,
        multi: action.multi,
        category,
        loss,
        delta,
        thinking: false,
      };
      return { ...state, nodes };
    }

    case "BRANCH_FAIL": {
      if (action.gen !== state.gen) return state;
      const node = state.nodes[action.nodeIdx];
      if (!node) return state;
      const nodes = state.nodes.slice();
      nodes[action.nodeIdx] = { ...node, thinking: false };
      return { ...state, nodes };
    }

    case "ERROR":
      if (action.gen !== state.gen) return state;
      return { ...state, status: "error", error: action.message, progress: null };

    default:
      return state;
  }
}

/**
 * Per-player accuracy: the average of per-move scores (see moveAccuracy -
 * based on the centipawn distance from the engine's best move), with the
 * "multiple blunders" smoothing of the reference implementation. Book moves count 100.
 * (Shared logic with the stats runner - see accuracyFromMoves.)
 */
export function accuracyFor(
  state: ReviewState,
  color: "w" | "b",
): { value: number | null; moves: number } {
  const ratings = state.meta
    ? { w: state.meta.white.rating, b: state.meta.black.rating }
    : null;
  const moves = state.mainline
    .slice(1)
    .map((idx) => state.nodes[idx])
    .filter((n) => n.move && n.delta != null)
    .map((n) => ({ color: n.move!.color, delta: n.delta, category: n.category }));
  const res = accuracyFromMoves(moves, ratings)[color];
  return { value: res.value != null ? Math.max(0, Math.min(100, res.value)) : null, moves: res.moves };
}

export function resultLabel(
  result: string,
  whiteName: string,
  blackName: string,
  t: TFn,
): string {
  switch (result) {
    case "1-0":
      return t("wins", { name: whiteName });
    case "0-1":
      return t("wins", { name: blackName });
    case "1/2-1/2":
      return t("drawResult");
    default:
      return t("inProgress");
  }
}
