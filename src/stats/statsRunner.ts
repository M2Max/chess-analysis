/**
 * Full-30-day analysis runner.
 *
 * Runs every game in the list through the standard analysis pipeline with a
 * FIXED combo - lite engine, fast mode, as many threads as the machine has
 * (up to the engine cap; multi-threaded only when cross-origin isolated) -
 * and collects one GameSummary per game. Already-summarised games (from a
 * previous, possibly interrupted, run) are skipped, so a run is always
 * resumable.
 */
import type { Game } from "../api/games";
import { detectOpening, openingIndex, type Opening } from "../api/openings";
import { putAnalysis, type CachedAnalysis, type CachedMove } from "../api/analysisCache";
import type { AnalysisMode, EngineKind } from "../engine/config";
import { ANALYSIS_MODES, ENGINE_CONFIG } from "../engine/config";
import { accuracyFromMoves, moveAccuracy, ratingFor, type AccMove } from "../engine/classify";
import { analyzeGame, type PositionResult } from "../engine/analysis";
import { parsePgn, type ParsedGame } from "../engine/parse";
import { getEngine } from "../engine/engine";
import { timeControlLabel } from "../components/GameList";
import type { TFn } from "../i18n";
import type { GameSummary } from "./statsData";

/**
 * Fold one analysed game into a CachedAnalysis (the same shape ReviewView
 * stores), so a stats run also fills the per-game cache: the list row gets
 * its `lite·fast` label + accuracies + opening, and opening the game
 * hydrates instantly. Returns null when the analysis was incomplete
 * (interrupted mid-game) - a partial mainline must never be hydrated.
 */
export function toCachedAnalysis(args: {
  engine: EngineKind;
  mode: AnalysisMode;
  opening: Opening | null;
  /** the game's moves (san/uci/color), mainline order */
  moves: ParsedGame["moves"];
  /** per-move classification (indexed like moves; gaps = not classified yet) */
  classified: { delta: number; loss: number; category: string }[];
  /** per-position results, index 0 = start (gaps = not analysed yet) */
  positions: (PositionResult | null)[];
  ratings?: { w?: number; b?: number };
  savedAt?: number;
}): CachedAnalysis | null {
  const { moves, classified, positions } = args;
  if (moves.length === 0) return null;
  for (let i = 0; i < moves.length; i++) {
    if (!classified[i] || !positions[i + 1]) return null; // incomplete
  }
  const accs = accuracyFromMoves(
    moves.map((m, i) => ({ color: m.color, delta: classified[i].delta, category: classified[i].category as AccMove["category"] })),
    args.ratings,
  );
  const cachedMoves: CachedMove[] = moves.map((m, i) => {
    const pos = positions[i + 1]!;
    return {
      san: m.san,
      uci: m.uci,
      color: m.color,
      delta: classified[i].delta,
      loss: classified[i].loss,
      category: classified[i].category as CachedMove["category"],
      bestUci: pos.bestUci,
      bestSan: pos.bestSan,
      score: pos.score,
      multi: pos.multi.map((l) => ({ uci: l.uci, score: l.score, pv: l.pv.slice(0, 16) })),
    };
  });
  return {
    v: 2,
    engine: args.engine,
    mode: args.mode,
    savedAt: args.savedAt ?? Date.now(),
    whiteAcc: accs.w.value,
    blackAcc: accs.b.value,
    opening: args.opening,
    moves: cachedMoves,
  };
}

export interface StatsProgress {
  state: "running" | "done" | "stopped" | "error";
  /** 0-based index of the game currently being analysed */
  gameIndex: number;
  gameTotal: number;
  moveDone: number;
  moveTotal: number;
  /** human label of the current game */
  label: string;
  etaMs: number | null;
  error: string | null;
  /** games already done before this run started (resume) */
  preDone: number;
}

export interface RunStatsOptions {
  games: Game[];
  username: string;
  /** UI language, for the progress label */
  t: TFn;
  signal: AbortSignal;
  /** summaries from a previous run (skipped) */
  existing: Record<string, GameSummary>;
  onProgress: (p: StatsProgress) => void;
  onGameSaved: (s: GameSummary) => void;
  /** UCI threads for the run (default: all cores, up to the engine cap) */
  threads?: number;
}

/** Thread count for the stats run: all cores up to the engine cap. */
export function statsThreads(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 4 : 4;
  return Math.max(1, Math.min(cores, ENGINE_CONFIG.maxThreads));
}

export async function runStats(opts: RunStatsOptions): Promise<void> {
  const { games, username, signal, t } = opts;
  const preDone = games.filter((g) => opts.existing[g.id] != null).length;
  const pending = games.map((g, i) => ({ g, i })).filter(({ g }) => opts.existing[g.id] == null);

  const progress: StatsProgress = {
    state: "running",
    gameIndex: 0,
    gameTotal: games.length,
    moveDone: 0,
    moveTotal: 0,
    label: "",
    etaMs: null,
    error: null,
    preDone,
  };
  const emit = () => opts.onProgress({ ...progress });
  emit();

  if (pending.length === 0) {
    progress.state = "done";
    emit();
    return;
  }

  const engine = getEngine("lite", opts.threads ?? statsThreads());
  const index = await openingIndex();
  // "fast" budget of the resolved variant (multi when cross-origin isolated)
  const movetime = ANALYSIS_MODES.fast.game[engine.variant];

  let elapsed = 0;
  let doneThisRun = 0;

  try {
    for (const { g, i } of pending) {
      if (signal.aborted) {
        progress.state = "stopped";
        emit();
        return;
      }
      const youWhite = g.white.username.toLowerCase() === username.toLowerCase();
      const opp = youWhite ? g.black : g.white;
      progress.gameIndex = i;
      progress.label = `vs ${opp.name} (${timeControlLabel(g, t)})`;
      emit();

      const started = Date.now();
      const summary = await analyseOne(g, {
        username,
        youWhite,
        oppName: opp.name,
        engine,
        index,
        movetime,
        signal,
        onMoveProgress: (done, total) => {
          progress.moveDone = done;
          progress.moveTotal = total;
          emit();
        },
      });
      if (signal.aborted) {
        progress.state = "stopped";
        emit();
        return;
      }

      elapsed += Date.now() - started;
      doneThisRun++;
      opts.existing[g.id] = summary;
      opts.onGameSaved(summary);
      const remaining = pending.length - doneThisRun;
      progress.etaMs = remaining > 0 ? (elapsed / doneThisRun) * remaining : 0;
      progress.moveDone = 0;
      progress.moveTotal = 0;
      emit();
    }
    progress.state = "done";
    emit();
  } catch (e) {
    progress.state = "error";
    progress.error = e instanceof Error ? e.message : "Analysis failed.";
    emit();
  }
}

interface AnalyseOneOptions {
  username: string;
  youWhite: boolean;
  oppName: string;
  engine: ReturnType<typeof getEngine>;
  index: Awaited<ReturnType<typeof openingIndex>>;
  movetime: number;
  signal: AbortSignal;
  onMoveProgress: (done: number, total: number) => void;
}

/** Analyse one game, fold it into a GameSummary AND fill the per-game
 *  analysis cache (never throws for a single bad game - it degrades to
 *  result-only data; the cache entry is skipped when incomplete). */
async function analyseOne(g: Game, o: AnalyseOneOptions): Promise<GameSummary> {
  const base: GameSummary = {
    id: g.id,
    utc: g.utc,
    timeClass: g.timeClass,
    timeControl: g.timeControl,
    result: g.result,
    youWhite: o.youWhite,
    whiteRating: g.white.rating ?? null,
    blackRating: g.black.rating ?? null,
    oppName: o.oppName,
    moves: 0,
    counts: {},
    userAccs: [],
    userAcc: null,
    opening: null,
  };

  let parsed;
  try {
    parsed = parsePgn(g.pgn);
  } catch {
    return base; // no PGN - result-only summary
  }

  base.moves = parsed.moves.length;
  base.opening = detectOpening(parsed.moves.map((m) => m.san), o.index);

  const moves: AccMove[] = [];
  const classified: { delta: number; loss: number; category: string }[] = [];
  const positions: (PositionResult | null)[] = [null];
  const ratings = { w: g.white.rating, b: g.black.rating };

  try {
    await analyzeGame(o.engine, parsed, {
      signal: o.signal,
      movetimeMs: o.movetime,
      ratings,
      openingDepth: base.opening?.depth,
      cb: {
        onPositionDone: (index, res) => {
          positions[index] = res;
        },
        onMoveClassified: (moveIndex, cls) => {
          const mv = parsed.moves[moveIndex];
          if (!mv) return;
          moves.push({ color: mv.color, delta: cls.delta, category: cls.category });
          classified[moveIndex] = { delta: cls.delta, loss: cls.loss, category: cls.category };
        },
        onProgress: (done, total) => o.onMoveProgress(done, total),
        onDone: () => {},
      },
    });
  } catch {
    // interrupted mid-game - keep whatever was classified so far
  }

  // fill the per-game cache so the game list + review view reuse this
  // compute (stats run = lite·fast; a stronger combo the user opens later
  // replaces it via the usual combo-rank rule)
  const entry = toCachedAnalysis({
    engine: "lite",
    mode: "fast",
    opening: base.opening,
    moves: parsed.moves,
    classified,
    positions,
    ratings,
  });
  if (entry) void putAnalysis(g.id, entry);

  const counts = base.counts;
  for (const m of moves) {
    if (m.category != null) counts[m.category] = (counts[m.category] ?? 0) + 1;
  }
  const userColor = o.youWhite ? "w" : "b";
  const userMoves = moves.filter((m) => m.color === userColor);
  const userRating = ratingFor(ratings, userColor);
  base.userAccs = userMoves.map((m) =>
    m.category === "opening" ? 100 : Math.round(moveAccuracy(m.delta ?? 0, userRating)),
  );
  base.userAcc = accuracyFromMoves(moves, ratings)[userColor].value;
  return base;
}
