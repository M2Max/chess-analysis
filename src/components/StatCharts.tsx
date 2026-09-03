/**
 * Lightweight charts for the stats view: plain SVG + divs, no chart
 * library. Series colours are fixed data-visualisation colours (readable
 * on both themes); text/track colours use the theme tokens.
 */
import { tabIdKey, useI18n } from "../i18n";
import type { EloPoint } from "../stats/statsData";

const ELO_COLORS: Record<string, string> = {
  bullet: "#f87171", // red-400
  blitz: "#fbbf24", // amber-400
  rapid: "#38bdf8", // sky-400
  long: "#34d399", // emerald-400
};

function fmtDate(t: number, locale: string): string {
  return new Date(t * 1000).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** Elo trajectory per time class (the only true line chart). */
export function EloChart({ series }: { series: Record<string, EloPoint[]> }) {
  const { t, locale } = useI18n();
  const W = 560;
  const H = 230;
  const pad = { l: 40, r: 12, t: 14, b: 26 };
  const points = Object.values(series).flat();
  if (points.length === 0) return null;

  const t0 = Math.min(...points.map((p) => p.t));
  const t1 = Math.max(...points.map((p) => p.t));
  const r0 = Math.min(...points.map((p) => p.rating));
  const r1 = Math.max(...points.map((p) => p.rating));
  const spanR = Math.max(20, r1 - r0);
  const x = (t: number) => pad.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (r: number) => pad.t + (1 - (r - (r0 - spanR * 0.08)) / (spanR * 1.16)) * (H - pad.t - pad.b);

  const yTicks = [0, 1, 2, 3].map((i) => Math.round(r0 - spanR * 0.08 + (spanR * 1.16 * i) / 3));
  const xTicks = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * i) / 3);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t("secElo")}>
      {yTicks.map((r, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={y(r)} y2={y(r)} className="stroke-line-strong" />
          <text x={pad.l - 6} y={y(r) + 3} textAnchor="end" className="fill-ink-faint" fontSize={10}>
            {r}
          </text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text key={i} x={x(t)} y={H - 8} textAnchor="middle" className="fill-ink-faint" fontSize={10}>
          {fmtDate(t, locale)}
        </text>
      ))}
      {Object.entries(series).map(([cls, pts]) =>
        pts.length > 0 ? (
          <g key={cls}>
            <polyline
              fill="none"
              stroke={ELO_COLORS[cls]}
              strokeWidth={1.8}
              strokeLinejoin="round"
              points={pts.map((p) => `${x(p.t)},${y(p.rating)}`).join(" ")}
            />
            {pts.map((p, i) => (
              <circle key={i} cx={x(p.t)} cy={y(p.rating)} r={2.4} fill={ELO_COLORS[cls]} />
            ))}
          </g>
        ) : null,
      )}
      {/* legend */}
      <g fontSize={10}>
        {Object.keys(ELO_COLORS).map((cls, i) => (
          <g key={cls} transform={`translate(${pad.l + i * 64}, 8)`}>
            <rect width={8} height={8} y={-7} fill={ELO_COLORS[cls]} rx={2} />
            <text x={12} className="fill-ink-mute">
              {t(tabIdKey(cls))}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

interface HBarPart {
  value: number;
  cls: string;
  title?: string;
}

/** Horizontal stacked bar row (W/D/L breakdowns, histograms, ...). */
export function HBar({ label, parts, total }: { label: string; parts: HBarPart[]; total?: number }) {
  const t = total ?? parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 truncate text-right text-xs text-ink-mute">{label}</span>
      <div className="flex h-4 min-w-0 flex-1 overflow-hidden rounded bg-card-solid/60">
        {t > 0 &&
          parts.map((p, i) =>
            p.value > 0 ? (
              <div
                key={i}
                className={`${p.cls} h-full`}
                style={{ width: `${(p.value / t) * 100}%` }}
                title={p.title ?? `${p.value}`}
              />
            ) : null,
          )}
      </div>
      <span className="w-16 shrink-0 text-xs tabular-nums text-ink-faint">{t}</span>
    </div>
  );
}

/** 24 mini stacked columns: results by hour of day. */
export function HourBars({ data }: { data: { hour: number; wins: number; draws: number; losses: number }[] }) {
  const { t } = useI18n();
  const max = Math.max(1, ...data.map((d) => d.wins + d.draws + d.losses));
  return (
    <div>
      <div className="flex h-24 items-end gap-[2px]">
        {data.map((d) => {
          const total = d.wins + d.draws + d.losses;
          return (
            <div
              key={d.hour}
              className="group relative flex flex-1 flex-col justify-end overflow-hidden rounded-sm"
              title={`${d.hour}:00 · ${t("winsWord")} ${d.wins} · ${t("drawsWord")} ${d.draws} · ${t("lossesWord")} ${d.losses}`}
            >
              {d.losses > 0 && (
                <div className="bg-red-500/80" style={{ height: `${(d.losses / max) * 96}px` }} />
              )}
              {d.draws > 0 && (
                <div className="bg-neutral-500/80" style={{ height: `${(d.draws / max) * 96}px` }} />
              )}
              {d.wins > 0 && (
                <div className="bg-emerald-500/90" style={{ height: `${(d.wins / max) * 96}px` }} />
              )}
              {total === 0 && <div className="h-px bg-line-strong" />}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-ink-faint">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

/** Simple two-metric bars per row (e.g. mistakes & blunders per game). */
export function MetricBars({
  rows,
  metricA,
  metricB,
}: {
  rows: { label: string; games: number; a: number; b: number }[];
  metricA: { label: string; cls: string };
  metricB: { label: string; cls: string };
}) {
  const { t } = useI18n();
  const max = Math.max(0.1, ...rows.map((r) => Math.max(r.a, r.b)));
  const perGame = t("perGame");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-ink-mute">
        <span className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-sm ${metricA.cls}`} /> {metricA.label} {perGame}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-sm ${metricB.cls}`} /> {metricB.label} {perGame}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-ink-soft">{r.label}</span>
            <span className="text-ink-faint">
              {r.games} {t("thGames").toLowerCase()}
            </span>
          </div>
          <div className="space-y-0.5">
            <div className="h-2 rounded bg-card-solid/60">
              <div className={`h-full rounded ${metricA.cls}`} style={{ width: `${(r.a / max) * 100}%` }} />
            </div>
            <div className="h-2 rounded bg-card-solid/60">
              <div className={`h-full rounded ${metricB.cls}`} style={{ width: `${(r.b / max) * 100}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function fmtPct(x: number | null, digits = 0): string {
  return x == null ? "-" : `${(x * 100).toFixed(digits)}%`;
}
