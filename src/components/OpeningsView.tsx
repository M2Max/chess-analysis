/**
 * Openings study (docs/FEATURE-OPENINGS.md).
 *
 * Two phases in one view:
 *  LIST  - every MAIN opening (deep sub-lines are hidden inside their
 *          first-tier variant, see src/openings/studyData.ts) as a card with
 *          per-opening progress ("3/12"); click opens the drill.
 *  DRILL - board + the variation description above it; the user plays the
 *          whole line move by move (both colours). Hint = puzzle-style bulb
 *          (origin ring + countdown → show the move). "Show" replays the
 *          entire variation once at 1 move/second, then resets the board and
 *          greys itself out so the user must try. Completing the line marks
 *          progress server-side and reveals "Next".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { completeOpeningVariantApi, fetchOpeningProgress } from "../api/reviewDb";
import { useI18n } from "../i18n";
import { stepsFromLine, type StudyOpening } from "../openings/studyData";
import { boardDarkSquareStyle, boardLightSquareStyle } from "./boardTheme";
import { useClickMove } from "./clickMove";
import { FlipIcon } from "./NavIcons";
import { STAUNTY_PIECES } from "./pieces";
import { Spinner } from "./Spinner";

interface Props {
  username: string;
  /** opening being drilled (null = list phase); lives in App for history */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** leave the study section (back to the game list) */
  onExit: () => void;
}

const HINT_SECONDS = 30;
/** how long the "wrong move" modal stays up before the board resets */
const WRONG_MS = 1200;
/** pacing of the "Show" demo playback */
const SHOW_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- dataset (static, built by scripts/fetch-openings.ts) -------------------
let studyCache: StudyOpening[] | null = null;
async function loadStudy(): Promise<StudyOpening[]> {
  if (studyCache) return studyCache;
  const res = await fetch("/opening-study.json");
  if (!res.ok) throw new Error(`opening-study.json failed (${res.status})`);
  const body = (await res.json()) as { openings: StudyOpening[] };
  studyCache = body.openings ?? [];
  return studyCache;
}

/** monochrome light-bulb icon (same as the puzzle hint) */
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

/** one study item = main line (index 0) or a first-tier variant */
interface DrillItem {
  name: string;
  eco: string;
  moves: string[];
}
function itemsFor(o: StudyOpening): DrillItem[] {
  return [{ name: "__main__", eco: o.eco, moves: o.moves }, ...o.variants];
}

// ============================================================================
// LIST phase
// ============================================================================

/** progress entry per opening: completed variation indices + last activity */
export interface OpeningProgressEntry {
  set: Set<number>;
  last: number;
}

function OpeningCard({
  opening,
  done,
  onOpen,
}: {
  opening: StudyOpening;
  done: number;
  onOpen: (key: string) => void;
}) {
  const { t } = useI18n();
  const total = 1 + opening.variants.length;
  const pct = Math.round((done / total) * 100);
  return (
    <button
      onClick={() => onOpen(opening.key)}
      className="group rounded-lg bg-card p-3 text-left ring-1 ring-line transition hover:ring-accent/60"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{opening.key}</span>
        <span className="rounded bg-btn px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">{opening.eco}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-btn">
          <span
            className={`block h-full rounded-full transition-all ${done === total ? "bg-emerald-500" : "bg-accent"}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="text-xs tabular-nums text-ink-mute">
          {done}/{total}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-ink-faint">
        {t("openingsVariantsCount", { n: opening.variants.length })}
      </div>
    </button>
  );
}

function OpeningsList({
  openings,
  doneMap,
  onOpen,
}: {
  openings: StudyOpening[];
  doneMap: Map<string, OpeningProgressEntry>;
  onOpen: (key: string) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return openings;
    return openings.filter((o) => o.key.toLowerCase().includes(needle) || o.eco.toLowerCase() === needle);
  }, [openings, q]);

  // "Ongoing": trainings that were started but not finished yet, most
  // recently played first; everything else stays in the full list below.
  const { ongoing, rest } = useMemo(() => {
    const og: { o: StudyOpening; last: number }[] = [];
    const other: StudyOpening[] = [];
    for (const o of filtered) {
      const e = doneMap.get(o.key);
      if (e && e.set.size > 0 && e.set.size < 1 + o.variants.length) og.push({ o, last: e.last });
      else other.push(o);
    }
    og.sort((a, b) => b.last - a.last);
    return { ongoing: og, rest: other };
  }, [filtered, doneMap]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("openingsSearchPlaceholder")}
        aria-label={t("openingsSearchPlaceholder")}
        className="mb-4 w-full max-w-md rounded-lg bg-card px-3 py-2 text-sm text-ink ring-1 ring-line outline-none placeholder:text-ink-faint focus:ring-accent"
      />
      {ongoing.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-accent-soft-text">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            {t("openingsOngoing")}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ongoing.map(({ o }) => (
              <OpeningCard key={o.key} opening={o} done={doneMap.get(o.key)!.set.size} onOpen={onOpen} />
            ))}
          </div>
        </div>
      )}
      {filtered.length === 0 && (
        <div className="rounded-lg bg-card p-8 text-center text-sm text-ink-mute ring-1 ring-line">
          {t("openingsNotFound")}
        </div>
      )}
      {rest.length > 0 && ongoing.length > 0 && (
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-faint">{t("openingsAll")}</h2>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rest.map((o) => (
          <OpeningCard key={o.key} opening={o} done={doneMap.get(o.key)?.set.size ?? 0} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// DRILL phase
// ============================================================================

function OpeningDrill({
  username,
  opening,
  doneSet,
  onMarkDone,
  flipped,
  onFlip,
}: {
  username: string;
  opening: StudyOpening;
  doneSet: Set<number>;
  onMarkDone: (index: number) => void;
  /** study boards start from White's side; the double-arrow flips them */
  flipped: boolean;
  onFlip: () => void;
}) {
  const { t } = useI18n();
  const items = useMemo(() => itemsFor(opening), [opening]);

  const [idx, setIdx] = useState(0);
  const item = items[Math.min(idx, items.length - 1)];

  // steps + fens of the current variation (index i = position AFTER move i)
  const line = useMemo(() => {
    const steps = stepsFromLine(item.moves);
    const ch = new Chess();
    const fens = [ch.fen()];
    for (const s of steps) {
      try {
        ch.move(s.san);
        fens.push(ch.fen());
      } catch {
        break;
      }
    }
    return { steps, fens };
  }, [item]);

  const [ply, setPly] = useState(0); // correct moves played so far
  const [fen, setFen] = useState(line.fens[0]);
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false); // demo playback / pending revert
  const [revealed, setRevealed] = useState(false); // hint fully revealed the move
  const [hint, setHint] = useState<"off" | "count">("off");
  const [hintSecs, setHintSecs] = useState(HINT_SECONDS);
  /** variations whose demo was already shown (grey out "Show" this session) */
  const [shownSet, setShownSet] = useState<Set<number>>(new Set());
  const animRef = useRef(0);
  const wrongTimerRef = useRef<number | null>(null);
  const boardWrapRef = useRef<HTMLDivElement>(null);

  // reset everything when the opening or the variation changes
  useEffect(() => {
    animRef.current += 1;
    setIdx(0);
  }, [opening.key]);
  useEffect(() => {
    animRef.current += 1;
    if (wrongTimerRef.current) window.clearTimeout(wrongTimerRef.current);
    setPly(0);
    setFen(line.fens[0]);
    setWrong(false);
    setBusy(false);
    setRevealed(false);
    setHint("off");
  }, [line]);

  // hint countdown (same UX as puzzles)
  useEffect(() => {
    if (hint !== "count") return;
    const iv = setInterval(() => {
      setHintSecs((s) => {
        if (s <= 1) {
          clearInterval(iv);
          setRevealed(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [hint]);

  const complete = ply >= line.steps.length;

  // MUST stay synchronous: react-chessboard snaps the piece back unless
  // onPieceDrop returns true in the same tick (an async handler made every
  // correct move bounce to its origin and then re-animate).
  const onDrop = useCallback(
    (args: { sourceSquare: string; targetSquare: string | null }): boolean => {
      if (busy || wrong || complete || !args.targetSquare) return false;
      const want = line.steps[ply];
      const attempt = `${args.sourceSquare}${args.targetSquare}`;
      if (want && attempt === want.uci.slice(0, 4)) {
        // correct: advance one step of the memorised line
        setFen(line.fens[ply + 1] ?? line.fens[line.fens.length - 1]);
        const nextPly = ply + 1;
        setPly(nextPly);
        setRevealed(false);
        if (nextPly >= line.steps.length) {
          onMarkDone(idx);
          void completeOpeningVariantApi(username, opening.key, idx).catch(() => {});
        }
        return true;
      }
      // wrong: let the move LAND, flash the modal, snap back to the current
      // step after a beat (illegal moves just snap back - not an attempt)
      try {
        const ch = new Chess(fen);
        if (!ch.move({ from: args.sourceSquare as never, to: args.targetSquare as never, promotion: "q" })) {
          return false;
        }
        setFen(ch.fen());
      } catch {
        return false;
      }
      setWrong(true);
      setBusy(true);
      if (wrongTimerRef.current) window.clearTimeout(wrongTimerRef.current);
      wrongTimerRef.current = window.setTimeout(() => {
        setFen(line.fens[ply]);
        setWrong(false);
        setBusy(false);
      }, WRONG_MS);
      return true;
    },
    [busy, wrong, complete, line, ply, fen, idx, opening.key, username, onMarkDone],
  );

  // click-to-move (same mechanism as puzzles)
  const click = useClickMove(
    !busy && !wrong && !complete ? fen : null,
    (f, tt) => {
      onDrop({ sourceSquare: f, targetSquare: tt });
    },
    boardWrapRef,
  );

  /** "Show": play the whole variation once at 1 move/second, then reset */
  const show = useCallback(async () => {
    if (busy || shownSet.has(idx)) return;
    const my = ++animRef.current;
    setBusy(true);
    setHint("off");
    setRevealed(false);
    for (let i = 1; i <= line.steps.length; i++) {
      await sleep(SHOW_MS);
      if (animRef.current !== my) return;
      setFen(line.fens[i] ?? line.fens[line.fens.length - 1]);
    }
    await sleep(900);
    if (animRef.current !== my) return;
    setFen(line.fens[0]); // reset: the user must try it themselves
    setShownSet((s) => new Set(s).add(idx));
    setBusy(false);
  }, [busy, shownSet, idx, line]);

  const next = useCallback(() => {
    if (idx < items.length - 1) setIdx(idx + 1);
  }, [idx, items.length]);

  const btn =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40";
  const primaryBtn = `${btn} bg-accent-strong text-on-accent hover:bg-accent-strong-hover`;
  const ghostBtn = `${btn} bg-btn text-ink-soft hover:bg-btn-hover`;

  const label = item.name === "__main__" ? t("openingsMainLine") : item.name;
  const isLast = idx >= items.length - 1;
  const orientation: "white" | "black" = flipped ? "black" : "white";

  return (
    <div className="mx-auto max-w-xl">
      {/* variation selector chips */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {items.map((it, i) => {
          const d = doneSet.has(i);
          return (
            <button
              key={i}
              onClick={() => setIdx(i)}
              title={it.name === "__main__" ? t("openingsMainLine") : it.name}
              className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                i === idx
                  ? "bg-accent-strong text-on-accent"
                  : d
                    ? "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/40 dark:text-emerald-300"
                    : "bg-btn text-ink-mute hover:bg-btn-hover"
              }`}
            >
              {i === 0 ? "★" : i}
              {d && i !== 0 ? " ✓" : ""}
            </button>
          );
        })}
      </div>

      {/* the variation being studied - above the board */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-base font-bold text-ink">{opening.key}</span>
        <span className="rounded bg-btn px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">{item.eco}</span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-ink-soft">{label}</span>
        {!complete && (
          <span className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent-soft-text ring-1 ring-accent/40">
            {t("puzzleMoveCounter", { n: ply + 1, total: line.steps.length })}
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
        {(hint === "count" || revealed) && !complete && !wrong && line.steps[ply] && (
          <SquareRing square={line.steps[ply].from} wrapRef={boardWrapRef} orientation={orientation} />
        )}
        {wrong && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded bg-black/50">
            <div className="rounded-lg bg-card-solid px-5 py-3 text-center shadow-xl ring-1 ring-line-strong">
              <div className="text-sm font-semibold text-danger">{t("puzzleWrongTitle")}</div>
              <div className="mt-0.5 text-xs text-ink-faint">{t("puzzleTryAgain")}</div>
            </div>
          </div>
        )}
      </div>

      {/* action row: hint + Show */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hint === "off" && !revealed && (
          <button
            onClick={() => setHint("count")}
            className={ghostBtn}
            aria-label={t("puzzleHint")}
            title={t("puzzleHint")}
            disabled={complete || busy}
          >
            <BulbIcon />
          </button>
        )}
        {hint === "count" && (
          <span className={`${btn} bg-amber-500/15 text-cat-opening ring-1 ring-amber-500/40`} aria-label={t("puzzleHint")}>
            <BulbIcon /> {hintSecs}
          </span>
        )}
        {revealed && !complete && line.steps[ply] && (
          <span className={`${btn} bg-amber-500/20 text-cat-opening ring-1 ring-amber-500/50`}>
            <BulbIcon /> {line.steps[ply].san.replace(/[+#]$/, "")}
          </span>
        )}
        <button
          onClick={() => void show()}
          className={ghostBtn}
          disabled={busy || shownSet.has(idx) || complete}
          title={t("openingsShow")}
        >
          {t("openingsShow")}
        </button>
        <button onClick={onFlip} className={ghostBtn} title={t("openingsFlip")} aria-label={t("openingsFlip")}>
          <FlipIcon />
        </button>

        {complete && (
          <div className="mt-3 w-full rounded-lg bg-emerald-500/10 p-4 ring-1 ring-emerald-500/40">
            <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-300">
              ✓ {t("openingsCompletedVariation")}
            </div>
            <div className="mt-2 flex items-center gap-2">
              {!isLast ? (
                <button onClick={next} className={primaryBtn}>
                  {t("openingsNextVar")} →
                </button>
              ) : (
                <div className="text-sm text-ink-soft">{t("openingsAllDone")}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Container
// ============================================================================

export function OpeningsView({ username, selectedKey, onSelect, onExit }: Props) {
  const { t } = useI18n();
  const [openings, setOpenings] = useState<StudyOpening[] | null>(studyCache);
  const [error, setError] = useState<string | null>(null);
  const [doneMap, setDoneMap] = useState<Map<string, OpeningProgressEntry>>(new Map());
  /** board side for the drill (session-long, survives opening changes) */
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    let live = true;
    loadStudy()
      .then((o) => live && setOpenings(o))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!username) return;
    let live = true;
    fetchOpeningProgress(username)
      .then((rows) => {
        if (!live) return;
        const m = new Map<string, OpeningProgressEntry>();
        for (const r of rows) {
          const cur = m.get(r.opening);
          const s = cur?.set ?? new Set<number>();
          s.add(r.variantIndex);
          m.set(r.opening, { set: s, last: Math.max(cur?.last ?? 0, r.completedAt) });
        }
        setDoneMap(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [username]);

  const markDone = useCallback((index: number) => {
    setDoneMap((m) => {
      if (!selectedKey) return m;
      const next = new Map(m);
      const cur = next.get(selectedKey);
      const s = new Set(cur?.set ?? []);
      s.add(index);
      next.set(selectedKey, { set: s, last: Date.now() });
      return next;
    });
  }, [selectedKey]);

  const btn =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40";
  const ghostBtn = `${btn} bg-btn text-ink-soft hover:bg-btn-hover`;

  const selected = selectedKey ? (openings ?? []).find((o) => o.key === selectedKey) : undefined;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button onClick={selectedKey ? () => onSelect(null) : onExit} className={ghostBtn}>
          {t("backArrow")}
        </button>
        <h1 className="text-lg font-bold text-ink">{t("titleOpenings")}</h1>
      </div>
      {!selected && (
        <p className="mb-4 -mt-2 text-sm text-ink-mute">{t("openingsSubtitle")}</p>
      )}

      {!username ? (
        <div className="mx-auto mt-16 max-w-lg text-center">
          <div className="rounded-lg bg-card p-8 ring-1 ring-line">
            <p className="mb-4 text-sm text-ink-mute">{t("statsNeedUsername")}</p>
            <button
              onClick={onExit}
              className="rounded-md bg-accent-strong px-4 py-2 text-sm font-medium text-on-accent transition hover:bg-accent-strong-hover"
            >
              {t("goPlayers")}
            </button>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500 ring-1 ring-red-500/30">{error}</div>
      ) : !openings ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : selected ? (
        <OpeningDrill
          key={selected.key}
          username={username}
          opening={selected}
          doneSet={doneMap.get(selected.key)?.set ?? new Set()}
          onMarkDone={markDone}
          flipped={flipped}
          onFlip={() => setFlipped((f) => !f)}
        />
      ) : (
        <OpeningsList openings={openings} doneMap={doneMap} onOpen={(k) => onSelect(k)} />
      )}
    </div>
  );
}
