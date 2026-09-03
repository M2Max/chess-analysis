import { Chessboard } from "react-chessboard";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Chess } from "chess.js";
import type { Game } from "../api/games";
import { ANALYSIS_MODES, type AnalysisMode, type EngineKind } from "../engine/config";
import { analyzeGame, terminalResult, type PositionResult } from "../engine/analysis";
import { accuracyFromMoves, formatEval, multipvToMultiLines, type Category } from "../engine/classify";
import { parsePgn, uciToSan, type ParsedGame } from "../engine/parse";
import { getEngine } from "../engine/engine";
import {
  accuracyFor,
  buildMainline,
  initialReviewState,
  resultLabel,
  reviewReducer,
  type ReviewMeta,
} from "../state/review";
import { comboRank, fetchAnalysis, putAnalysis, type CachedMove } from "../api/analysisCache";
import { detectOpening, openingIndex, type Opening } from "../api/openings";
import { usePreventPageZoom } from "../hooks/usePreventPageZoom";
import { useI18n } from "../i18n";
import { CategorySymbol } from "./CategorySymbol";
import { BoardSymbol } from "./BoardSymbol";
import { STAUNTY_PIECES } from "./pieces";
import { BackIcon, FirstIcon, FlipIcon, LastIcon, NextIcon, PrevIcon } from "./NavIcons";
import { EvalBar } from "./EvalBar";
import { TopLines } from "./TopLines";
import { timeControlLabel } from "./GameList";
import { MoveList } from "./MoveList";
import { MoveStrip } from "./MoveStrip";
import { Spinner } from "./Spinner";

let genCounter = 0;

function sideToMove(fen: string): "w" | "b" {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

interface Props {
  game: Game;
  /** which Stockfish build to analyse with (from the settings view) */
  engineKind: EngineKind;
  /** UCI Threads setting (0 = auto); multi only when cross-origin isolated */
  threads: number;
  /** per-position time budget (fast | deep, from settings) */
  analysisMode: AnalysisMode;
  /** username from settings - games are opened in that player's perspective */
  username: string;
  /** persisted flip preference (inverts the perspective) */
  flip: boolean;
  onFlip: () => void;
  /** show the engine's best-move arrow on the board */
  showArrow: boolean;
  onToggleArrow: () => void;
  onBack: () => void;
  /** fired after a finished analysis was (re)stored in the cache */
  onAnalysisSaved?: () => void;
}

export function ReviewView({
  game,
  engineKind,
  threads,
  analysisMode,
  username,
  flip,
  onFlip,
  showArrow,
  onToggleArrow,
  onBack,
  onAnalysisSaved,
}: Props) {
  const { t, locale } = useI18n();
  const [state, dispatch] = useReducer(reviewReducer, initialReviewState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // debug hook: browser scripts (scripts/debug-*) can read the live state
  ;(window as unknown as { __reviewState?: unknown }).__reviewState = state;
  const rootRef = useRef<HTMLDivElement>(null);
  usePreventPageZoom(rootRef);
  const boardWrapRef = useRef<HTMLDivElement>(null);
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /** recognised opening (book) of the reviewed game */
  const [opening, setOpening] = useState<Opening | null>(null);
  /**
   * a weaker cached analysis is displayed and the engine is NOT run
   * automatically - the user decides when to upgrade it to the current
   * settings ("Analyze with current setting" button)
   */
  const [upgradable, setUpgradable] = useState<{ engine: string; mode: string } | null>(null);

  // ---- full-game analysis (runs once per game) --------------------------
  useEffect(() => {
    const gen = ++genCounter;
    genRef.current = gen;
    const engine = getEngine(engineKind, threads);

    let parsed;
    try {
      parsed = parsePgn(game.pgn);
    } catch (e) {
      dispatch({
        type: "ERROR",
        gen,
        message: e instanceof Error ? e.message : "Could not read this game's PGN.",
      });
      return;
    }

    const { nodes, mainline } = buildMainline(parsed);
    const meta: ReviewMeta = {
      white: { name: game.white.name, username: game.white.username, rating: game.white.rating },
      black: { name: game.black.name, username: game.black.username, rating: game.black.rating },
      result: game.result,
      dateLabel: new Date(game.utc * 1000).toLocaleString(locale),
      timeControl: timeControlLabel(game, t),
      gameId: game.id,
    };
    dispatch({ type: "INIT", gen, meta, nodes, mainline });

    // Stored analysis (server DB): hydrate instantly. When the stored combo
    // is weaker than the one selected now, do NOT re-run the engine silently
    // - show the cached result and offer "Analyze with current setting".
    let cancelled = false;
    void (async () => {
      const cached = await fetchAnalysis(game.id);
      if (cancelled || genRef.current !== gen) return;
      const currentRank = comboRank(engineKind, analysisMode);
      if (cached) {
        setOpening(cached.opening ?? null);
        dispatch({ type: "HYDRATE", gen, moves: cached.moves });
        if (comboRank(cached.engine, cached.mode) >= currentRank) {
          setUpgradable(null);
          dispatch({ type: "ANALYSIS_FINISHED", gen });
          return;
        }
        setUpgradable({ engine: cached.engine, mode: cached.mode });
        return; // engine waits for the upgrade button
      }
      setOpening(null);
      void runAnalysis(gen, engine, parsed);
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      getEngine(engineKind, threads).stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, engineKind, threads, analysisMode]);

  /** Run (or re-run) the full analysis; persists the result when done. */
  const runAnalysis = useCallback(
    (gen: number, engine: ReturnType<typeof getEngine>, parsed: ParsedGame) => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      // Plain accumulators (NOT React state): onDone fires in the same tick
      // as the final MOVE_CLASSIFIED dispatch, so stateRef.current would
      // still lack the last move's category and it would silently drop out
      // of the stored entry. The stats runner uses the same pattern.
      const positions: (PositionResult | null)[] = [];
      const classified: { delta: number; loss: number; category: Category }[] = [];
      void (async () => {
        try {
          // opening book: classify the game's contiguous in-book prefix
          const idx = await openingIndex();
          const gameOpening = detectOpening(parsed.moves.map((m) => m.san), idx);
          setOpening(gameOpening);
          await analyzeGame(engine, parsed, {
            signal: ctrl.signal,
            movetimeMs: ANALYSIS_MODES[analysisMode].game[engine.variant],
            ratings: { w: game.white.rating, b: game.black.rating },
            openingDepth: gameOpening?.depth,
            cb: {
              onPositionDone: (index, res) => {
                positions[index] = res;
                dispatch({
                  type: "POSITION_DONE",
                  gen,
                  index,
                  score: res.score,
                  bestUci: res.bestUci,
                  bestSan: res.bestSan,
                  pv: res.pv,
                  depth: res.depth,
                  multi: res.multi,
                });
              },
              onMoveClassified: (moveIndex, cls) => {
                classified[moveIndex] = { delta: cls.delta, loss: cls.loss, category: cls.category };
                dispatch({
                  type: "MOVE_CLASSIFIED",
                  gen,
                  moveIndex,
                  loss: cls.loss,
                  delta: cls.delta,
                  category: cls.category,
                });
              },
              onProgress: (done, total) => dispatch({ type: "PROGRESS", gen, done, total }),
              onDone: () => {
                dispatch({ type: "ANALYSIS_FINISHED", gen });
                setUpgradable(null);
                // persist for the game list + instant re-open (best combo wins)
                const st = stateRef.current;
                if (st.gen !== gen) return;
                const moves: CachedMove[] = [];
                st.mainline.slice(1).forEach((nodeIdx, i) => {
                  const n = st.nodes[nodeIdx];
                  const cls = classified[i];
                  const pos = positions[i + 1];
                  if (!n.move || !cls || !pos) return;
                  moves[i] = {
                    san: n.move.san,
                    uci: n.move.uci,
                    color: n.move.color,
                    delta: cls.delta,
                    loss: cls.loss,
                    category: cls.category,
                    bestUci: pos.bestUci,
                    bestSan: pos.bestSan,
                    score: pos.score,
                    multi: pos.multi.map((m) => ({ uci: m.uci, score: m.score, pv: m.pv.slice(0, 16) })),
                  };
                });
                if (moves.length > 0) {
                  // same accuracy formula as the stats runner (complete
                  // classified set - stateRef may lack the last move here)
                  const accs = accuracyFromMoves(
                    parsed.moves.flatMap((m, i) => {
                      const cls = classified[i];
                      return cls ? [{ color: m.color, delta: cls.delta, category: cls.category }] : [];
                    }),
                    { w: game.white.rating, b: game.black.rating },
                  );
                  void putAnalysis(game.id, {
                    v: 2,
                    engine: engineKind,
                    mode: analysisMode,
                    savedAt: Date.now(),
                    whiteAcc: accs.w.value,
                    blackAcc: accs.b.value,
                    opening: gameOpening,
                    moves,
                  }).then(() => {
                    // list labels refresh whether or not the server kept it
                    onAnalysisSaved?.();
                  });
                }
              },
            },
          });
        } catch (e) {
          if (ctrl.signal.aborted) dispatch({ type: "ANALYSIS_FINISHED", gen });
          else
            dispatch({
              type: "ERROR",
              gen,
              message: e instanceof Error ? e.message : "Engine failed.",
            });
        }
      })();
    },
    [game, engineKind, analysisMode, onAnalysisSaved],
  );

  /** User clicked "Analyze with current setting" on a weaker cached game. */
  const upgrade = useCallback(() => {
    const st = stateRef.current;
    let parsed: ParsedGame;
    try {
      parsed = parsePgn(game.pgn);
    } catch {
      return;
    }
    const engine = getEngine(engineKind, threads);
    void runAnalysis(st.gen, engine, parsed);
  }, [game, engineKind, threads, runAnalysis]);

  // ---- navigation ---------------------------------------------------------
  const nav = useCallback(
    (dir: "first" | "back" | "forward" | "last" | "mainline") => {
      switch (dir) {
        case "first":
          dispatch({ type: "GO_FIRST" });
          break;
        case "back":
          dispatch({ type: "GO_BACK" });
          break;
        case "forward":
          dispatch({ type: "GO_FORWARD" });
          break;
        case "last":
          dispatch({ type: "GO_LAST" });
          break;
        case "mainline":
          dispatch({ type: "GO_MAINLINE" });
          break;
      }
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nav("back");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nav("forward");
      } else if (e.key === "Home") {
        nav("first");
      } else if (e.key === "End") {
        nav("last");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  const selectMove = useCallback((n: number) => {
    dispatch({ type: "SET_CURSOR", cursor: n });
  }, []);

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
    getEngine(engineKind, threads).stop();
    dispatch({ type: "ANALYSIS_FINISHED", gen: genRef.current });
  }, [engineKind, threads]);

  // ---- board moves (mainline advance or branch) --------------------------
  const handleMove = useCallback(
    (from: string, to: string, promotion?: string): boolean => {
      const st = stateRef.current;
      const curNodeIdx = st.line[st.cursor];
      if (curNodeIdx == null) return false;
      const curNode = st.nodes[curNodeIdx];
      if (!curNode) return false;
      const uci = from + to + (promotion ?? "");

      // known child (mainline or existing branch) → just navigate
      const child = st.nodes.find((n) => n.parent === curNodeIdx && n.move?.uci === uci);
      if (child) {
        dispatch({
          type: "SET_LINE",
          line: [...st.line.slice(0, st.cursor + 1), child.idx],
          cursor: st.cursor + 1,
        });
        return true;
      }

      // new branch: validate with chess.js, then analyse immediately
      const chess = new Chess(curNode.fen);
      let mv;
      try {
        mv = chess.move({ from, to, promotion });
      } catch {
        return false;
      }
      const fen = chess.fen();
      const gen = st.gen;
      const nodeIdx = st.nodes.length; // BRANCH_START appends exactly one node
      dispatch({
        type: "BRANCH_START",
        parentIdx: curNodeIdx,
        move: { san: mv.san, uci, color: mv.color },
        fen,
      });
      void (async () => {
        try {
          const engine = getEngine(engineKind, threads);
          const res = await engine.analyze(fen, { movetimeMs: ANALYSIS_MODES[analysisMode].branch[engine.variant] }, (info) =>
            dispatch({ type: "BRANCH_INFO", gen, nodeIdx, score: info.score, pv: info.pv, depth: info.depth }),
          );
          dispatch({
            type: "BRANCH_DONE",
            gen,
            nodeIdx,
            score: res.info?.score ?? terminalResult(fen, res.bestMove)?.score ?? null,
            bestUci: res.bestMove,
            bestSan: res.info ? uciToSan(fen, res.bestMove) ?? null : null,
            pv: res.info?.pv ?? [],
            depth: res.info?.depth ?? 0,
            multi: multipvToMultiLines(res.multipv),
          });
        } catch {
          dispatch({ type: "BRANCH_FAIL", gen, nodeIdx });
        }
      })();
      return true;
    },
    [engineKind, threads],
  );

  // board orientation: the side the reviewed player played, optionally flipped
  const orientation: "white" | "black" = useMemo(() => {
    const u = username.trim().toLowerCase();
    const playedBlack = u.length > 0 && game.black.username.toLowerCase() === u;
    const base: "white" | "black" = playedBlack ? "black" : "white";
    return flip ? (base === "white" ? "black" : "white") : base;
  }, [game, username, flip]);

  // ---- derived view state -------------------------------------------------
  const curNodeIdx = state.line[state.cursor];
  const curNode = curNodeIdx != null ? state.nodes[curNodeIdx] : null;
  const meta = state.meta;

  if (state.status === "error" || (state.status === "loading" && !curNode)) {
    return (
      <div className="mx-auto mt-16 max-w-lg">
        <div className="rounded-lg bg-card p-8 text-center ring-1 ring-line">
          {state.status === "error" ? (
            <>
              <div className="mb-2 text-sm font-medium text-danger">{t("reviewFailed")}</div>
              <p className="mb-6 text-sm text-ink-mute">{state.error}</p>
              <button
                onClick={onBack}
                className="rounded-md bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong-hover"
              >
                {t("backToGamesFull")}
              </button>
            </>
          ) : (
            <div className="flex items-center justify-center gap-3 py-4 text-ink-mute">
              <Spinner className="h-5 w-5" /> {t("preparing")}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!meta || !curNode) return null;

  const stm = sideToMove(curNode.fen);
  const analyzing = state.status === "analyzing";
  const onBranch = state.line.some((idx) => !state.nodes[idx].isMainline);
  const rawArrow = curNode.bestUci ?? curNode.pv[0] ?? null;
  const arrowUci = showArrow && curNode.score && rawArrow && rawArrow !== "0000" ? rawArrow : null;
  const whiteAcc = accuracyFor(state, "w");
  const blackAcc = accuracyFor(state, "b");

  const navBtn =
    "inline-flex items-center justify-center rounded-md bg-btn px-2.5 py-1.5 text-sm text-ink-soft transition hover:bg-btn-hover disabled:opacity-40 disabled:hover:bg-btn";

  return (
    <div ref={rootRef}>
      {/* header */}
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          onClick={onBack}
          className="rounded-md px-2 py-1 text-sm text-ink-mute transition hover:bg-btn hover:text-ink-soft"
        >
          {t("backToGames")}
        </button>
        <h1 className="text-base font-semibold text-ink">
          {resultLabel(meta.result, meta.white.name, meta.black.name, t)}
        </h1>
        <span className="text-xs text-ink-faint">
          {meta.dateLabel}
          {meta.timeControl && ` · ${meta.timeControl}`}
        </span>
        {opening && (
          <span
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-xs text-cat-opening ring-1 ring-amber-500/40"
            title={t("openingBookTitle", { eco: opening.eco, moves: Math.ceil(opening.depth / 2) })}
          >
            <CategorySymbol category="opening" />
            {opening.name} <span className="text-ink-faint">{opening.eco}</span>
          </span>
        )}
      </div>

      {/* grid-cols-1 (minmax(0,1fr)) on mobile: without an explicit template the
          implicit column is `auto` (max-content) and the move strip's track would
          stretch the whole column - and the board - past the screen width */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* left: board + nav */}
        <div className="mx-auto w-full min-w-0 max-w-[600px]">
          <div className="flex gap-2">
            <EvalBar score={curNode.score} sideToMove={stm} />
            <div className="relative min-w-0 flex-1" ref={boardWrapRef}>
              <Chessboard
                options={{
                  position: curNode.fen,
                  boardOrientation: orientation,
                  animationDurationInMs: 120,
                  pieces: STAUNTY_PIECES,
                  onPieceDrop: ({ piece, sourceSquare, targetSquare }) => {
                    if (!targetSquare) return false;
                    const promotes =
                      piece.pieceType === "p" && (targetSquare[1] === "8" || targetSquare[1] === "1");
                    return handleMove(sourceSquare, targetSquare, promotes ? "q" : undefined);
                  },
                  arrows: arrowUci
                    ? [
                        {
                          startSquare: arrowUci.slice(0, 2),
                          endSquare: arrowUci.slice(2, 4),
                          color: "rgba(52, 211, 153, 0.55)",
                        },
                      ]
                    : [],
                }}
              />
              <BoardSymbol
                square={curNode?.move ? curNode.move.uci.slice(2, 4) : null}
                category={curNode?.category ?? null}
                orientation={orientation}
                boardWrapRef={boardWrapRef}
              />
              {analyzing && (state.progress?.done ?? 0) === 0 && !upgradable && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded bg-neutral-950/70 backdrop-blur-[2px]">
                  <Spinner className="h-8 w-8 text-accent" />
                  <div className="text-sm text-ink-soft">{t("startingEngine")}</div>
                  <button
                    onClick={cancelAnalysis}
                    className="text-xs text-ink-faint underline-offset-2 hover:underline"
                  >
                    {t("cancel")}
                  </button>
                </div>
              )}
            </div>
            {/* mirrors the eval bar so the board stays optically centered */}
            <div className="w-4 shrink-0" aria-hidden />
          </div>

          {/* nav row - history nav is desktop-only (on mobile the move
              strip is swiped with the finger) */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="hidden items-center gap-1 lg:flex">
              <button className={navBtn} onClick={() => nav("first")} disabled={state.cursor === 0} title={t("navFirst")}>
                <FirstIcon />
              </button>
              <button className={navBtn} onClick={() => nav("back")} disabled={state.cursor === 0} title={t("navBack")}>
                <PrevIcon />
              </button>
              <button
                className={navBtn}
                onClick={() => nav("forward")}
                disabled={state.cursor >= state.line.length - 1}
                title={t("navForward")}
              >
                <NextIcon />
              </button>
              <button
                className={navBtn}
                onClick={() => nav("last")}
                disabled={state.cursor >= state.line.length - 1}
                title={t("navLast")}
              >
                <LastIcon />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button className={navBtn} onClick={onFlip} title={t("flipTitle")}>
                <FlipIcon />
              </button>
              <button
                onClick={onToggleArrow}
                title={t("arrowTitle")}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  showArrow
                    ? "bg-btn text-accent hover:bg-btn-hover"
                    : "bg-btn text-ink-faint hover:bg-btn-hover"
                }`}
              >
                ➤
              </button>
            </div>
            {onBranch && (
              <button
                onClick={() => nav("mainline")}
                className="rounded-md bg-branch/20 px-3 py-1.5 text-sm text-branch ring-1 ring-branch/40 transition hover:bg-branch/30"
                title={t("navMainline")}
              >
                <span className="inline-flex items-center gap-1.5">
                  <BackIcon /> {t("backToGame")}
                </span>
              </button>
            )}
            {upgradable && (state.progress?.done ?? 0) === 0 && (
              <button
                onClick={upgrade}
                className="rounded-md bg-accent-strong px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-strong-hover"
                title={t("upgradableTitle", {
                  engine: upgradable.engine,
                  mode: upgradable.mode,
                  curEngine: engineKind,
                  curMode: analysisMode,
                })}
              >
                {t("analyzeCurrent")}
              </button>
            )}
            <div className="ml-auto flex items-center gap-2 text-xs">
              {curNode.score && (
                <span className="rounded bg-score px-2 py-1 font-mono text-ink">
                  {formatEval(curNode.score, stm)}
                </span>
              )}
              {curNode.achievedDepth != null && (
                <span className="text-ink-faint">d{curNode.achievedDepth}</span>
              )}
              {curNode.thinking && (
                <span className="flex items-center gap-1.5 text-ink-mute">
                  <Spinner className="h-3 w-3" /> {t("thinking")}
                </span>
              )}
              {analyzing && (state.progress?.done ?? 0) > 0 && (
                <span className="flex items-center gap-2 rounded bg-accent-soft px-2 py-1 text-accent-soft-text ring-1 ring-accent/30">
                  <Spinner className="h-3 w-3" />
                  {t("analyzingProgress", { done: state.progress?.done ?? 0, total: state.progress?.total ?? 0 })}
                  <button onClick={cancelAnalysis} className="ml-1 underline-offset-2 hover:underline">
                    {t("cancel")}
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* mobile: horizontal move slider (desktop uses the vertical list) */}
          <MoveStrip state={state} onSelectMove={selectMove} />

          <p className="mt-2 text-[11px] text-ink-faint">{t("dragHint")}</p>
        </div>

        {/* right: best lines (desktop) + players + moves */}
        <div className="space-y-4">
          {/* desktop: best lines above the players/accuracy card */}
          <div className="hidden lg:block">
            <TopLines fen={curNode.fen} stm={stm} multi={curNode.multi} />
          </div>
          <div className="rounded-lg bg-card p-4 ring-1 ring-line">
            {(["w", "b"] as const).map((c) => {
              const p = c === "w" ? meta.white : meta.black;
              const acc = c === "w" ? whiteAcc : blackAcc;
              return (
                <div key={c} className="flex items-center gap-3 py-1.5">
                  <span
                    className={`h-3.5 w-3.5 shrink-0 rounded-full ${
                      c === "w" ? "bg-neutral-100 ring-1 ring-neutral-400" : "bg-neutral-950 ring-1 ring-neutral-500"
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                    {p.name}
                    {p.rating != null && <span className="text-ink-faint"> ({p.rating})</span>}
                  </span>
                  <span className="text-xs text-ink-faint">
                    {acc.value != null ? (
                      <>
                        <span className="font-mono text-sm text-ink-soft">{acc.value}%</span> acc
                      </>
                    ) : (
                      "…"
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {/* mobile: best lines below the players/accuracy card */}
          <div className="lg:hidden">
            <TopLines fen={curNode.fen} stm={stm} multi={curNode.multi} />
          </div>

          <MoveList state={state} onSelectMove={selectMove} />
        </div>
      </div>
    </div>
  );
}
