import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { Game } from "../api/games";
import {
  attemptPuzzleApi,
  fetchPlayers,
  fetchPuzzles,
  type Puzzle,
} from "../api/reviewDb";
import type { EngineKind } from "../engine/config";
import { getEngine } from "../engine/engine";
import { useI18n } from "../i18n";
import { generatePuzzles, type GenerateProgress } from "../puzzles/generate";
import { tierFor } from "../puzzles/model";
import { boardDarkSquareStyle, boardLightSquareStyle } from "./boardTheme";
import { useClickMove } from "./clickMove";
import { STAUNTY_PIECES } from "./pieces";
import { Spinner } from "./Spinner";

interface Props {
  /** active player (empty → CTA to pick one, like the stats view) */
  username: string;
  /** the player's game list (needed for generation + "view in game") */
  games: Game[];
  engineKind: EngineKind;
  threads: number;
  onOpenGame: (game: Game, ply?: number) => void;
  onGoPlayers: () => void;
  /** leave the puzzle section (back to the game list) */
  onExit: () => void;
}

const HINT_SECONDS = 30;
const VALIDATION_MOVE_MS = 1500;
/** how long the "wrong move" modal stays up before the board resets */
const WRONG_MS = 1400;
/** how long the green "Correct!" flash shows before the continuation line plays */
const CORRECT_FLASH_MS = 950;
/** pause for a single auto-played move to animate */
const STEP_MS = 480;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** monochrome light-bulb icon */
function BulbIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M9 18h6" />
      <path d="M10 21.5h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
    </svg>
  );
}

/** amber ring drawn ON the board over one square (hint: the piece to move) */
function SquareRing({
  square,
  wrapRef,
  orientation,
}: {
  square: string;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  orientation: "white" | "black";
}) {
  const [pos, setPos] = useState<{ left: number; top: number; size: number } | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const sq = document.getElementById(`chessboard-square-${square}`);
      if (!wrapRect.width || !sq) return;
      const r = sq.getBoundingClientRect();
      setPos({ left: r.left - wrapRect.left, top: r.top - wrapRect.top, size: r.width });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => ro.disconnect();
  }, [square, wrapRef, orientation]);
  if (!pos) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-sm bg-amber-400/30 ring-4 ring-amber-400/90 transition-all duration-200"
      style={{ left: pos.left, top: pos.top, width: pos.size, height: pos.size }}
    />
  );
}

type Phase = "loading" | "hub" | "generating" | "playing";
type PuzzlePhase = "solving" | "solved" | "revealed";
type HintStage = "off" | "count" | "ready";

export function PuzzleView({
  username,
  games,
  engineKind,
  threads,
  onOpenGame,
  onGoPlayers,
  onExit,
}: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [puzzles, setPuzzles] = useState<Puzzle[]>([]);
  const [progress, setProgress] = useState<GenerateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  // per-puzzle state
  const [idx, setIdx] = useState(0);
  const [fen, setFen] = useState("");
  const [puzzlePhase, setPuzzlePhase] = useState<PuzzlePhase>("solving");
  const [hint, setHint] = useState<HintStage>("off");
  const [hintSecs, setHintSecs] = useState(HINT_SECONDS);
  // wrong move: the position AFTER the wrong move; drives the greyed-out
  // modal; after WRONG_MS the board snaps back and the modal disappears
  const [wrongFen, setWrongFen] = useState<string | null>(null);
  const wrongTimerRef = useRef<number | null>(null);
  // correct answer: brief green flash, then the continuation line animates
  const [correctFlash, setCorrectFlash] = useState(false);
  // multi-move puzzles: index of the expected user move + the position the
  // current step starts from (wrong moves revert HERE, not to puzzle.fen)
  const [solvedN, setSolvedN] = useState(0);
  const [baseFen, setBaseFen] = useState("");
  const [streak, setStreak] = useState(0);
  const animRef = useRef(0); // invalidates pending pv animations on puzzle change
  const lastPuzzleIdRef = useRef<number | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);

  const puzzle: Puzzle | undefined = puzzles[idx];
  const solvedCount = puzzles.filter((p) => p.status === "solved").length;
  const unsolvedIdx = puzzles.findIndex((p) => p.status !== "solved");

  const loadQueue = useCallback(async () => {
    if (!username) return;
    const list = await fetchPuzzles(username, ["ready", "seen", "solved"]);
    setPuzzles(list);
    const firstOpen = list.findIndex((p) => p.status !== "solved");
    setIdx(firstOpen === -1 ? 0 : firstOpen);
    setPhase("hub");
  }, [username]);

  useEffect(() => {
    setPhase("loading");
    setPuzzles([]);
    setProgress(null);
    void loadQueue().catch(() => setPhase("hub"));
  }, [loadQueue]);

  // reset per-puzzle state ONLY when the actual puzzle changes.
  // markStatus() optimistically flips puzzle.status (and identity) right after
  // a correct move; resetting on that would rewind the board to the starting
  // position mid-play. Re-entry from the hub is forced via play().
  useEffect(() => {
    const id = puzzle?.id ?? null;
    if (id === lastPuzzleIdRef.current) return;
    lastPuzzleIdRef.current = id;
    animRef.current += 1;
    if (wrongTimerRef.current) window.clearTimeout(wrongTimerRef.current);
    setWrongFen(null);
    setCorrectFlash(false);
    if (!puzzle) return;
    setFen(puzzle.fen);
    setBaseFen(puzzle.fen);
    setSolvedN(0);
    setPuzzlePhase(puzzle.status === "solved" ? "solved" : "solving");
    setHint("off");
    setHintSecs(HINT_SECONDS);
  }, [puzzle?.id, puzzle?.status, puzzle, phase]);

  // hint countdown
  useEffect(() => {
    if (hint !== "count") return;
    const iv = setInterval(() => {
      setHintSecs((s) => {
        if (s <= 1) {
          clearInterval(iv);
          setHint("ready");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [hint]);

  const playLine = useCallback(async (startFen: string, moves: string[]) => {
    const anim = animRef.current;
    const ch = new Chess(startFen);
    for (const u of moves) {
      try {
        ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4, 5) || undefined });
      } catch {
        break;
      }
      setFen(ch.fen());
      await sleep(430);
      if (animRef.current !== anim || ch.isGameOver()) break;
    }
  }, []);

  const generate = useCallback(async () => {
    if (!username) return;
    setError(null);
    stopRef.current = false;
    setPhase("generating");
    setProgress({ phase: "extract", done: 0, total: 0 });
    let baseRating: number | null = null;
    try {
      const cards = await fetchPlayers();
      const card = cards.find((c) => c.username.toLowerCase() === username.toLowerCase());
      baseRating = card?.ratings.blitz ?? card?.ratings.rapid ?? card?.ratings.classical ?? null;
    } catch {
      baseRating = null;
    }
    const engine = getEngine(engineKind, threads);
    try {
      await generatePuzzles({
        username,
        games,
        baseRating,
        analyze: (fenStr) => engine.analyze(fenStr, { movetimeMs: VALIDATION_MOVE_MS }),
        onProgress: setProgress,
        shouldStop: () => stopRef.current,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await loadQueue().catch(() => setPhase("hub"));
  }, [username, games, engineKind, threads, loadQueue]);

  const markStatus = useCallback((id: number, status: Puzzle["status"]) => {
    setPuzzles((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)));
  }, []);

  /** user moves to play in sequence (1..3); replies = odd indices of pv */
  const expected = useMemo(() => {
    if (!puzzle) return [] as string[];
    const list = (puzzle.solutionUcis ?? []).filter((u) => typeof u === "string" && u.length >= 4);
    return list.length > 1 ? list.slice(0, 3) : [puzzle.solutionUci];
  }, [puzzle]);

  const onDrop = useCallback(
    (args: { piece: { pieceType: string }; sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!puzzle || puzzlePhase !== "solving" || wrongFen || correctFlash || !args.targetSquare) return false;
      const uci =
        args.sourceSquare +
        args.targetSquare +
        (args.piece.pieceType === "p" && (args.targetSquare[1] === "8" || args.targetSquare[1] === "1")
          ? "q"
          : "");
      const ch = new Chess(fen);
      let made;
      try {
        made = ch.move({
          from: args.sourceSquare,
          to: args.targetSquare,
          promotion: uci.length > 4 ? "q" : undefined,
        });
      } catch {
        made = null;
      }
      if (!made) return false; // illegal: piece snaps back, not an attempt
      const want = expected[solvedN] ?? puzzle.solutionUci;
      if (uci !== want) {
        // let the move LAND, then grey the board + "retry" modal for a beat;
        // revert to the CURRENT step position (not necessarily puzzle.fen)
        setFen(ch.fen());
        setWrongFen(ch.fen());
        void attemptPuzzleApi(puzzle.id, false).catch(() => {});
        if (wrongTimerRef.current) window.clearTimeout(wrongTimerRef.current);
        wrongTimerRef.current = window.setTimeout(() => {
          setWrongFen(null);
          setFen(baseFen);
        }, WRONG_MS);
        return true;
      }
      // correct move: green flash first — held long to register
      const isFinal = solvedN + 1 >= expected.length;
      setFen(ch.fen());
      setCorrectFlash(true);
      const anim = animRef.current;
      void (async () => {
        await sleep(CORRECT_FLASH_MS);
        if (animRef.current !== anim) return; // puzzle changed underneath: drop it
        if (!isFinal) {
          // intermediate step: play the opponent's forced reply, then demand
          // the next user move
          const reply = (puzzle.pv ?? [])[2 * solvedN + 1];
          let nextFen = ch.fen();
          if (reply) {
            try {
              ch.move({
                from: reply.slice(0, 2),
                to: reply.slice(2, 4),
                promotion: reply.length > 4 ? reply.slice(4, 5) : undefined,
              });
              nextFen = ch.fen();
              setFen(nextFen);
            } catch {
              // stale reply data: keep the position after our move
            }
          }
          await sleep(STEP_MS);
          if (animRef.current !== anim) return;
          setCorrectFlash(false);
          setBaseFen(nextFen);
          setSolvedN((n) => n + 1);
          return; // still solving, next move expected
        }
        // final correct move: solved!
        setPuzzlePhase("solved");
        setStreak((s) => s + 1);
        markStatus(puzzle.id, "solved");
        void attemptPuzzleApi(puzzle.id, true).catch(() => {});
        setCorrectFlash(false);
        const restIdx = 2 * solvedN + 1;
        await playLine(ch.fen(), (puzzle.pv ?? []).length > restIdx ? puzzle.pv.slice(restIdx) : []);
      })();
      return true;
    },
    [puzzle, puzzlePhase, fen, wrongFen, correctFlash, expected, solvedN, baseFen, playLine, markStatus],
  );

  // click-to-move: pick a piece, dots appear, click a dot to play it
  // (onDrop already validates + applies promotion itself)
  const click = useClickMove(
    puzzlePhase === "solving" && !wrongFen && !correctFlash ? fen : null,
    (f, t) => {
      let src: { type: string } | null | undefined = undefined;
      try {
        src = new Chess(fen).get(f as never);
      } catch {
        return;
      }
      onDrop({ piece: { pieceType: src?.type ?? "p" }, sourceSquare: f, targetSquare: t });
    },
    boardWrapRef,
  );

  const reveal = useCallback(() => {
    if (!puzzle || puzzlePhase === "solved") return;
    setPuzzlePhase("revealed");
    setHint("off");
    setStreak(0);
    if (puzzle.status === "ready") markStatus(puzzle.id, "seen");
    void attemptPuzzleApi(puzzle.id, false, true).catch(() => {});
    void playLine(puzzle.fen, puzzle.pv?.length ? puzzle.pv : [puzzle.solutionUci]);
  }, [puzzle, puzzlePhase, playLine, markStatus]);

  const retryAfterReveal = useCallback(() => {
    if (!puzzle) return;
    animRef.current += 1;
    setFen(puzzle.fen);
    setBaseFen(puzzle.fen);
    setSolvedN(0);
    setPuzzlePhase("solving");
  }, [puzzle]);

  /** next unsolved (wrapping); when none is left, return to the hub */
  const next = useCallback(() => {
    const after = puzzles.findIndex((p, i) => i > idx && p.status !== "solved");
    if (after !== -1) {
      setIdx(after);
      return;
    }
    const anyOpen = puzzles.findIndex((p) => p.status !== "solved");
    if (anyOpen !== -1) setIdx(anyOpen);
    else setPhase("hub");
  }, [puzzles, idx]);

  const play = useCallback(() => {
    if (unsolvedIdx === -1) void generate();
    else {
      // force the reset effect to re-init even when idx lands on the same id
      lastPuzzleIdRef.current = null;
      setIdx(unsolvedIdx);
      setPhase("playing");
    }
  }, [unsolvedIdx, generate]);

  const sourceGame = puzzle ? games.find((g) => g.id === puzzle.gameId) : undefined;
  const orientation: "white" | "black" = puzzle?.side === "b" ? "black" : "white";

  const btn =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40";
  const primaryBtn = `${btn} bg-accent-strong text-on-accent hover:bg-accent-strong-hover`;
  const ghostBtn = `${btn} bg-btn text-ink-soft hover:bg-btn-hover`;

  const tierLabel = (p: Puzzle) =>
    tierFor(p.ratingEst) === "easy"
      ? t("puzzleTierEasy")
      : tierFor(p.ratingEst) === "hard"
        ? t("puzzleTierHard")
        : t("puzzleTierMid");

  const statsLine = (
    <span className="text-xs text-ink-faint">
      {t("puzzleStatsLine", { solved: solvedCount, total: puzzles.length, streak })}
    </span>
  );

  // ---------------------------------------------------------------- render

  if (!username) {
    return (
      <div className="mx-auto mt-16 max-w-lg text-center">
        <div className="rounded-lg bg-card p-8 ring-1 ring-line">
          <p className="mb-4 text-sm text-ink-mute">{t("puzzlesNeedUsername")}</p>
          <button onClick={onGoPlayers} className={primaryBtn}>
            {t("goPlayers")}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-ink-mute">
        <Spinner className="h-5 w-5" /> {t("preparing")}
      </div>
    );
  }

  if (phase === "generating") {
    return (
      <div className="mx-auto max-w-[560px] text-center">
        <div className="rounded-lg bg-card p-8 ring-1 ring-line">
          <div className="mb-3 flex items-center justify-center gap-3 text-ink-soft">
            <Spinner className="h-5 w-5" />
            <span className="text-sm">
              {progress?.phase === "validate"
                ? t("puzzlesValidating", { done: progress.done, total: progress.total })
                : t("puzzlesExtracting", { done: progress?.done ?? 0, total: progress?.total ?? 0 })}
            </span>
          </div>
          <button onClick={() => (stopRef.current = true)} className={ghostBtn}>
            {t("cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "hub") {
    return (
      <div className="mx-auto max-w-[560px]">
        <div className="mb-4 flex items-start justify-between gap-3">
          <button
            onClick={onExit}
            className="rounded-md px-2 py-1 text-sm text-ink-mute transition hover:bg-btn hover:text-ink-soft"
          >
            {t("puzzlesBack")}
          </button>
          <h1 className="text-base font-semibold text-ink">{t("titlePuzzles")}</h1>
          <span className="pt-1">{statsLine}</span>
        </div>
        <p className="mb-6 text-sm text-ink-mute">{t("puzzlesIntro")}</p>
        {error && (
          <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
        )}
        <div className="flex flex-col gap-3">
          <button onClick={play} className={`${primaryBtn} justify-center py-2.5`}>
            {unsolvedIdx === -1 && puzzles.length > 0
              ? t("puzzlesGenerate")
              : t("puzzlesPlay")}
          </button>
          {!(unsolvedIdx === -1 && puzzles.length > 0) && (
            <button onClick={() => void generate()} className={`${ghostBtn} justify-center py-2.5`}>
              {t("puzzlesGenerate")}
            </button>
          )}
        </div>
        {puzzles.length === 0 && unsolvedIdx === -1 && (
          <p className="mt-4 text-center text-xs text-ink-faint">{t("puzzlesNoAnalysed")}</p>
        )}
      </div>
    );
  }

  // ---- playing ----
  if (!puzzle) {
    // queue emptied behind our back: go back to the hub
    return (
      <div className="mx-auto max-w-[560px] text-center">
        <p className="mb-4 text-sm text-ink-mute">{t("puzzlesQueueEmpty")}</p>
        <button onClick={() => void loadQueue()} className={ghostBtn}>
          {t("puzzlesBack")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[560px]">
      {/* header: back to hub + counter + stats */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <button
          onClick={() => setPhase("hub")}
          className="rounded-md px-2 py-1 text-sm text-ink-mute transition hover:bg-btn hover:text-ink-soft"
        >
          ← {t("titlePuzzles")}
        </button>
        <span className="text-xs text-ink-faint">
          {t("puzzleCounter", { n: idx + 1, total: puzzles.length })}
        </span>
        {statsLine}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md bg-btn px-2 py-0.5 text-ink-soft">{tierLabel(puzzle)}</span>
        {puzzle.ratingEst != null && <span className="text-ink-faint">≈ {puzzle.ratingEst}</span>}
        {expected.length > 1 && puzzlePhase !== "solved" && (
          <span className="rounded-md bg-accent/15 px-2 py-0.5 font-medium text-accent-soft-text ring-1 ring-accent/40">
            {t("puzzleMoveCounter", { n: Math.min(solvedN + 1, expected.length), total: expected.length })}
          </span>
        )}
        {puzzlePhase !== "solving" && puzzle.punish && (
          <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-cat-opening ring-1 ring-amber-500/40">
            {t("puzzlePunishTag")}
          </span>
        )}
      </div>

      {/* board */}
      <div className="relative" ref={boardWrapRef}>
        <Chessboard
          options={{
            position: fen,
            boardOrientation: orientation,
            animationDurationInMs: 320,
            pieces: STAUNTY_PIECES,
            lightSquareStyle: boardLightSquareStyle,
            darkSquareStyle: boardDarkSquareStyle,
            squareStyles: click.styles,
            onPieceDrop: onDrop as never,
          }}
        />
        {hint !== "off" && puzzlePhase === "solving" && !wrongFen && (
          <SquareRing
            square={(expected[Math.min(solvedN, Math.max(expected.length - 1, 0))] ?? puzzle.solutionUci).slice(0, 2)}
            wrapRef={boardWrapRef}
            orientation={orientation}
          />
        )}
        {wrongFen && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded bg-black/50">
            <div className="rounded-lg bg-card-solid px-5 py-3 text-center shadow-xl ring-1 ring-line-strong">
              <div className="text-sm font-semibold text-danger">{t("puzzleWrongTitle")}</div>
              <div className="mt-0.5 text-xs text-ink-faint">{t("puzzleTryAgain")}</div>
            </div>
          </div>
        )}
        {correctFlash && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded">
            <div className="rounded-xl bg-emerald-600/95 px-7 py-3.5 shadow-2xl ring-1 ring-emerald-300/60">
              <div className="text-base font-bold text-white">✓ {t("puzzleCorrect")}</div>
            </div>
          </div>
        )}
      </div>

      {/* action row */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hint === "off" && (
          <button
            onClick={() => {
              setHint("count");
              setHintSecs(HINT_SECONDS);
            }}
            className={ghostBtn}
            aria-label={t("puzzleHint")}
            title={t("puzzleHint")}
            disabled={puzzlePhase === "solved"}
          >
            <BulbIcon />
          </button>
        )}
        {hint === "count" && (
          <span className={`${btn} bg-amber-500/15 text-cat-opening ring-1 ring-amber-500/40`} aria-label={t("puzzleHint")}>
            <BulbIcon /> {hintSecs}
          </span>
        )}
        {hint === "ready" && (
          <button
            onClick={reveal}
            className={`${btn} bg-amber-500/20 text-cat-opening ring-1 ring-amber-500/50`}
            disabled={puzzlePhase === "solved"}
          >
            <BulbIcon /> {t("puzzleShowSolution")}
          </button>
        )}
        {puzzlePhase === "revealed" && (
          <button onClick={retryAfterReveal} className={ghostBtn}>
            {t("puzzleTryAgain")}
          </button>
        )}
        <span className="ml-auto">
          {puzzlePhase === "solved" && (
            <span className="text-sm font-medium text-accent-soft-text">{t("puzzleCorrect")}</span>
          )}
        </span>
      </div>

      {/* after solve / reveal - no generate button here (hub owns it) */}
      {puzzlePhase !== "solving" && (
        <div className="mt-3 rounded-lg bg-card p-4 ring-1 ring-line">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-faint">{t("puzzleSolutionLabel")}:</span>
            <span className="font-mono font-semibold text-ink">
              {puzzle.solutionSan ?? puzzle.solutionUci}
            </span>
            <span className="rounded-md bg-btn px-2 py-0.5 text-xs text-ink-soft">
              {puzzle.theme === "mate"
                ? t("puzzleThemeMate", { n: puzzle.mateLen ?? 1 })
                : t("puzzleThemeWin")}
            </span>
            {sourceGame && (
              <button onClick={() => onOpenGame(sourceGame, puzzle.ply)} className={`${ghostBtn} ml-auto text-xs`}>
                {t("puzzleViewInGame")}
              </button>
            )}
          </div>
          <div className="mt-3">
            <button onClick={next} className={primaryBtn}>
              {t("puzzleNext")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
