/**
 * Motif donut: where the lost points come from (mate / time / hanging /
 * capture / fork / pin / positional). Hover a slice for exact values,
 * click to filter the autopsy list (click again to clear).
 */
import { useI18n } from "../i18n";
import { useTip } from "./chartTip";
import type { MotifRow } from "../stats/statsData";
import type { Motif } from "../stats/motifs";

const MOTIF_COLORS: Record<Motif, string> = {
  mateMissed: "#a855f7", // purple
  timePressure: "#f97316", // orange
  missedCapture: "#ef4444", // red
  hang: "#fbbf24", // amber
  fork: "#38bdf8", // sky
  pin: "#34d399", // emerald
  positional: "#8b8b8b", // grey
};

const MOTIF_ICONS: Record<Motif, string> = {
  mateMissed: "♚",
  timePressure: "⏱",
  missedCapture: "✖",
  hang: "⚠",
  fork: "⑂",
  pin: "📌",
  positional: "◎",
};

export function motifColor(m: Motif): string {
  return MOTIF_COLORS[m];
}

export function MotifDonut({
  rows,
  selected,
  onSelect,
}: {
  rows: MotifRow[];
  selected: Motif | null;
  onSelect: (m: Motif | null) => void;
}) {
  const { t } = useI18n();
  const { show, hide } = useTip();
  const totalPts = rows.reduce((s, r) => s + r.points, 0);
  if (totalPts <= 0) return null;

  const R = 60;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const name = (m: Motif) => t(`motif${m.charAt(0).toUpperCase()}${m.slice(1)}` as never, {} as never) as string;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 160 160" className="h-40 w-40 shrink-0 -rotate-90">
        {rows.map((r) => {
          const frac = r.points / totalPts;
          const dash = frac * C;
          const off = -acc * C;
          acc += frac;
          const dim = selected != null && selected !== r.motif;
          return (
            <circle
              key={r.motif}
              cx={80}
              cy={80}
              r={R}
              fill="none"
              stroke={MOTIF_COLORS[r.motif]}
              strokeWidth={selected === r.motif ? 26 : 20}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={off}
              opacity={dim ? 0.25 : 1}
              className="cursor-pointer transition-[stroke-width,opacity]"
              onClick={() => onSelect(selected === r.motif ? null : r.motif)}
              onMouseMove={(e) =>
                show(e.clientX, e.clientY, [
                  `${MOTIF_ICONS[r.motif]} ${name(r.motif)}`,
                  `${t("pointsLost")}: ${r.points.toFixed(1)} · ${Math.round(r.share * 100)}%`,
                  `${t("timesN", { n: r.n })}`,
                ])
              }
              onMouseLeave={hide}
            />
          );
        })}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {rows.map((r) => (
          <li key={r.motif}>
            <button
              onClick={() => onSelect(selected === r.motif ? null : r.motif)}
              className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition ${
                selected === r.motif ? "bg-accent-soft text-accent-soft-text" : "text-ink-soft hover:bg-btn"
              }`}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: MOTIF_COLORS[r.motif] }} />
              <span className="w-4 text-center">{MOTIF_ICONS[r.motif]}</span>
              <span className="min-w-0 flex-1 truncate">{name(r.motif)}</span>
              <span className="tabular-nums text-ink-faint">{Math.round(r.share * 100)}%</span>
              <span className="w-10 text-right tabular-nums text-ink">{r.points.toFixed(1)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
