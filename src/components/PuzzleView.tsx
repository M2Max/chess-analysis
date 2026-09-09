import { useCallback, useEffect, useRef, useState } from "react";
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
}

const HINT_SECONDS = 30;
const VALIDATION_MOVE_MS = 1500;

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
function SquareRing({ square, wrapRef, orientation }: { square: string; wrapRef: React.RefObject<HTMLDivElement | null>; orientation: "white" | "black" }) {
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

type Phase = "loading" | "empty" | "generating" | "queue";
type PuzzlePhase = "solving" | "solved" | "revealed";
type HintStage = "off" | "count" | "ready";

export function PuzzleView({ username, games, engineKind, threads, onOpenGame, onGoPlayers }: Props) {
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
  const [feedback, setFeedback] = useState<"" | "wrong" | "correct">("");
  const [streak, setStreak] = useState(0);
  const animRef = useRef(0); // invalidates pending pv animations on puzzle change
  const boardWrapRef = useRef<HTMLDivElement | null>(null);

  const puzzle: Puzzle | undefined = puzzles[idx];
  const solvedCount = puzzles.filter((p) => p.status === "solved").length;

  const loadQueue = useCallback(async () => {
    if (!username) return;
    const list = await fetchPuzzles(username, ["ready", "seen", "solved"]);
    setPuzzles(list);
    const firstOpen = list.findIndex((p) => p.status !== "solved");
    setIdx(firstOpen === -1 ? 0 : firstOpen);
    setPhase(list.some((p) => p.status === "ready" || p.status === "seen") ? "queue" : "empty");
  }, [username]);

  useEffect(() => {
    setPhase("loading");
    setPuzzles([]);
    setProgress(null);
    void loadQueue().catch(() => setPhase("empty"));
  }, [loadQueue]);

  // reset per-puzzle state whenever the current puzzle changes
  useEffect(() => {
    animRef.current += 1;
    if (!puzzle) return;
    setFen(puzzle.fen);
    setPuzzlePhase(puzzle.status === "solved" ? "solved" : "solving");
    setHint("off");
    setHintSecs(HINT_SECONDS);
    setFeedback("");
  }, [puzzle?.id, puzzle?.status, puzzle]);

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
      const result = await generatePuzzles({
        username,
        games,
        baseRating,
        analyze: (fenStr) => engine.analyze(fenStr, { movetimeMs: VALIDATION_MOVE_MS }),
        onProgress: setProgress,
        shouldStop: () => stopRef.current,
      });
      await loadQueue();
      if (result.ready === 0 && puzzles.length === 0) setPhase("empty");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await loadQueue().catch(() => setPhase("empty"));
    }
  }, [username, games, engineKind, threads, loadQueue, puzzles.length]);

  const onDrop = useCallback(
    (args: { piece: { pieceType: string }; sourceSquare: string; targetSquare: string | null }): boolean => {
      if (!puzzle || puzzlePhase !== "solving" || !args.targetSquare) return false;
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
      if (uci !== puzzle.solutionUci) {
        void attemptPuzzleApi(puzzle.id, false).catch(() => {});
        setFeedback("wrong");
        return false;
      }
      // solved!
      setPuzzlePhase("solved");
      setFeedback("correct");
      setStreak((s) => s + 1);
      void attemptPuzzleApi(puzzle.id, true).catch(() => {});
      setFen(ch.fen());
      void playLine(ch.fen(), (puzzle.pv?.length ? puzzle.pv.slice(1) : []));
      return true;
    },
    [puzzle, puzzlePhase, fen, playLine],
  );

  const reveal = useCallback(() => {
    if (!puzzle || puzzlePhase === "solved") return;
    setPuzzlePhase("revealed");
    setHint("off");
    setStreak(0);
    void attemptPuzzleApi(puzzle.id, false, true).catch(() => {});
    void playLine(puzzle.fen, puzzle.pv?.length ? puzzle.pv : [puzzle.solutionUci]);
  }, [puzzle, puzzlePhase, playLine]);

  const retryAfterReveal = useCallback(() => {
    if (!puzzle) return;
    animRef.current += 1;
    setFen(puzzle.fen);
    setPuzzlePhase("solving");
    setFeedback("");
  }, [puzzle]);

  const next = useCallback(() => {
    const firstOpen = puzzles.findIndex((p, i) => i > idx && p.status !== "solved");
    if (firstOpen !== -1) setIdx(firstOpen);
    else {
      const anyOpen = puzzles.findIndex((p) => p.status !== "solved");
      if (anyOpen !== -1) setIdx(anyOpen);
    }
  }, [puzzles, idx]);

  const sourceGame = puzzle ? games.find((g) => g.id === puzzle.gameId) : undefined;
  const orientation: "white" | "black" = puzzle?.side === "b" ? "black" : "white";

  const btn =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40";
  const primaryBtn = `${btn} bg-accent-strong text-white hover:bg-accent-strong-hover`;
  const ghostBtn = `${btn} bg-btn text-ink-soft hover:bg-btn-hover`;

  const tierLabel = (p: Puzzle) =>
    tierFor(p.ratingEst) === "easy" ? t("puzzleTierEasy") : tierFor(p.ratingEst) === "hard" ? t("puzzleTierHard") : t("puzzleTierMid");

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

  if (phase === "empty" || !puzzle) {
    const analysed = games.some((g) => g.accuracy != null);
    return (
      <div className="mx-auto max-w-[560px] text-center">
        <h1 className="mb-1 text-lg font-semibold text-ink">{t("titlePuzzles")}</h1>
        <p className="mb-6 text-sm text-ink-mute">{t("puzzlesIntro")}</p>
        <div className="rounded-lg bg-card p-8 ring-1 ring-line">
          {puzzles.length > 0 ? (
            <p className="mb-4 text-sm text-ink-mute">{t("puzzlesQueueEmpty")}</p>
          ) : !analysed && games.length > 0 ? (
            <p className="mb-4 text-sm text-ink-mute">{t("puzzlesNoAnalysed")}</p>
          ) : (
            <p className="mb-4 text-sm text-ink-mute">{t("puzzlesIntro")}</p>
          )}
          {error && <p className="mb-4 text-sm text-danger">{error}</p>}
          <button onClick={() => void generate()} className={primaryBtn}>
            {t("puzzlesGenerate")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[560px]">
      {/* header: counter + stats */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold text-ink">{t("titlePuzzles")}</h1>
        <span className="text-xs text-ink-faint">
          {t("puzzleStatsLine", {
            solved: solvedCount,
            total: puzzles.length,
            streak,
          })}
        </span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md bg-btn px-2 py-0.5 text-ink-soft">
          {t("puzzleCounter", { n: idx + 1, total: puzzles.length })}
        </span>
        <span className="rounded-md bg-btn px-2 py-0.5 text-ink-soft">{tierLabel(puzzle)}</span>
        {puzzle.ratingEst != null && <span className="text-ink-faint">≈ {puzzle.ratingEst}</span>}
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
            animationDurationInMs: 200,
            pieces: STAUNTY_PIECES,
            onPieceDrop: onDrop as never,
          }}
        />
        {hint !== "off" && puzzlePhase === "solving" && (
          <SquareRing square={puzzle.solutionUci.slice(0, 2)} wrapRef={boardWrapRef} orientation={orientation} />
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
          <span
            className={`${btn} bg-amber-500/15 text-cat-opening ring-1 ring-amber-500/40`}
            aria-label={t("puzzleHint")}
          >
            <BulbIcon /> {hintSecs}
          </span>
        )}
        {hint === "ready" && (
          <button onClick={reveal} className={`${btn} bg-amber-500/20 text-cat-opening ring-1 ring-amber-500/50`} disabled={puzzlePhase === "solved"}>
            <BulbIcon /> {t("puzzleShowSolution")}
          </button>
        )}
        {puzzlePhase === "revealed" && (
          <button onClick={retryAfterReveal} className={ghostBtn}>
            {t("puzzleTryAgain")}
          </button>
        )}
        <span className="ml-auto">
          {feedback === "wrong" && <span className="text-sm text-danger">{t("puzzleTryAgain")}…</span>}
          {feedback === "correct" && <span className="text-sm font-medium text-accent-soft-text">{t("puzzleCorrect")}</span>}
        </span>
      </div>

      {/* after solve / reveal */}
      {puzzlePhase !== "solving" && (
        <div className="mt-3 rounded-lg bg-card p-4 ring-1 ring-line">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-faint">{t("puzzleSolutionLabel")}:</span>
            <span className="font-mono font-semibold text-ink">{puzzle.solutionSan ?? puzzle.solutionUci}</span>
            <span className="rounded-md bg-btn px-2 py-0.5 text-xs text-ink-soft">
              {puzzle.theme === "mate" ? t("puzzleThemeMate", { n: puzzle.mateLen ?? 1 }) : t("puzzleThemeWin")}
            </span>
            {sourceGame && (
              <button onClick={() => onOpenGame(sourceGame, puzzle.ply)} className={`${ghostBtn} ml-auto text-xs`}>
                {t("puzzleViewInGame")}
              </button>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button onClick={next} className={primaryBtn}>
              {t("puzzleNext")}
            </button>
            <button onClick={() => void generate()} className={ghostBtn}>
              {t("puzzlesGenerate")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
