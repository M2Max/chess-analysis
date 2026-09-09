import { useMemo } from "react";
import { formatEval, flipScore, uciLineToSan, type MultiLine } from "../engine/classify";
import { useI18n } from "../i18n";

interface Props {
  fen: string;
  /** side to move in `fen` */
  stm: "w" | "b";
  /** top-3 lines from the position's MultiPV search (side-to-move view) */
  multi: MultiLine[];
  /** play the first `count` moves of a line from the current position */
  onPlay?: (pv: string[], count: number) => void;
}

/**
 * Engine's best lines for the current position: up to 3 evaluations
 * (white's perspective, like the eval bar) each followed by the first 4
 * moves of that line. Desktop: above the players/accuracy card.
 * Mobile: below it.
 */
export function TopLines({ fen, stm, multi, onPlay }: Props) {
  const { t } = useI18n();
  const lines = useMemo(
    () =>
      multi.slice(0, 3).map((l) => {
        const sans = uciLineToSan(fen, l.pv, 4);
        return {
          // scores are side-to-move; show white's perspective
          eval: formatEval(stm === "w" ? l.score : flipScore(l.score), "w"),
          uci: l.pv.slice(0, sans.length),
          san: sans,
        };
      }),
    [fen, stm, multi],
  );

  return (
    <div className="rounded-lg bg-card p-3 ring-1 ring-line">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">{t("bestLines")}</span>
        {!lines.length && <span className="text-[11px] text-ink-faint">{t("bestLinesWaiting")}</span>}
      </div>
      <div className="space-y-1.5">
        {lines.map((l, i) => (
          <div key={i} className="flex items-baseline gap-2 text-xs">
            <span
              className={`w-14 shrink-0 text-right font-mono font-semibold ${
                i === 0 ? "text-accent-soft-text" : "text-ink-soft"
              }`}
            >
              {l.eval}
            </span>
            {onPlay ? (
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1 font-mono text-ink-soft">
                {l.san.length === 0 && "…"}
                {l.san.map((s, k) => (
                  <button
                    key={k}
                    onClick={() => onPlay(l.uci, k + 1)}
                    title={t("pvPlayTitle", { san: s })}
                    className="rounded px-0.5 text-left transition hover:bg-btn-hover hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </span>
            ) : (
              <span className="min-w-0 truncate font-mono text-ink-soft" title={l.san.join(" ")}>
                {l.san.join(" ") || "…"}
              </span>
            )}
          </div>
        ))}
        {!lines.length && <div className="h-3" />}
      </div>
    </div>
  );
}
