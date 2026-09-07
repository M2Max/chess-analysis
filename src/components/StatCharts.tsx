/**
 * Lightweight charts for the stats view: plain SVG + divs, no chart
 * library. Series colours are fixed data-visualization colours (readable
 * on both themes); text/track colours use the theme tokens.
 * EVERY element is hoverable: pointer handlers reveal exact values in the
 * shared tooltip layer (see chartTip.tsx).
 */
import { useRef } from "react";
import { tabIdKey, useI18n } from "../i18n";
import { useTip } from "./chartTip";
import type { EloPoint, GapBucket, TrendPoint } from "../stats/statsData";

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
  const { show, hide } = useTip();
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
              <circle
                key={i}
                cx={x(p.t)}
                cy={y(p.rating)}
                r={4}
                fill="transparent"
                className="cursor-pointer"
                onMouseMove={(e) =>
                  show(e.clientX, e.clientY, [
                    `${t(tabIdKey(cls))} · ${fmtDate(p.t, locale)}`,
                    `${t("ratingWord")}: ${p.rating}`,
                  ])
                }
                onMouseLeave={hide}
              />
            ))}
            {pts.map((p, i) => (
              <circle key={`d${i}`} cx={x(p.t)} cy={y(p.rating)} r={2.4} fill={ELO_COLORS[cls]} pointerEvents="none" />
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
  /** tooltip lines for this part (exact value + share) */
  lines?: () => string[];
}

/** Horizontal stacked bar row (W/D/L breakdowns, distributions, ...). */
export function HBar({ label, parts, total, unit }: { label: string; parts: HBarPart[]; total?: number; unit?: string }) {
  const { show, hide } = useTip();
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
                className={`${p.cls} h-full cursor-pointer`}
                style={{ width: `${(p.value / t) * 100}%` }}
                onMouseMove={(e) =>
                  show(
                    e.clientX,
                    e.clientY,
                    p.lines
                      ? p.lines()
                      : [label, `${p.value}${unit ? ` ${unit}` : ""} · ${Math.round((p.value / t) * 100)}%`],
                  )
                }
                onMouseLeave={hide}
              />
            ) : null,
          )}
      </div>
      <span className="w-16 shrink-0 text-xs tabular-nums text-ink-faint">{t}</span>
    </div>
  );
}

/** 24 mini stacked columns: results by hour of day (hover = exact counts). */
export function HourBars({ data }: { data: { hour: number; wins: number; draws: number; losses: number }[] }) {
  const { t } = useI18n();
  const { show, hide } = useTip();
  const max = Math.max(1, ...data.map((d) => d.wins + d.draws + d.losses));
  return (
    <div>
      <div className="flex h-24 items-end gap-[2px]">
        {data.map((d) => {
          const total = d.wins + d.draws + d.losses;
          return (
            <div
              key={d.hour}
              className="relative flex flex-1 cursor-pointer flex-col justify-end overflow-hidden rounded-sm"
              onMouseMove={(e) =>
                show(e.clientX, e.clientY, [
                  `${String(d.hour).padStart(2, "0")}:00`,
                  `${t("winsWord")} ${d.wins} · ${t("drawsWord")} ${d.draws} · ${t("lossesWord")} ${d.losses}`,
                  total > 0 ? `${t("winrateWord")}: ${Math.round((d.wins / total) * 100)}%` : "",
                ].filter(Boolean))
              }
              onMouseLeave={hide}
            >
              {d.losses > 0 && <div className="bg-red-500/80" style={{ height: `${(d.losses / max) * 96}px` }} />}
              {d.draws > 0 && <div className="bg-neutral-500/80" style={{ height: `${(d.draws / max) * 96}px` }} />}
              {d.wins > 0 && <div className="bg-emerald-500/90" style={{ height: `${(d.wins / max) * 96}px` }} />}
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

/** Generic vertical bars row (clock buckets etc.), hover = exact numbers. */
export function VBars({
  rows,
  colorFor,
  format,
}: {
  rows: { label: string; value: number; sub?: string }[];
  colorFor: (r: { label: string; value: number }, i: number) => string;
  format?: (v: number) => string;
}) {
  const { show, hide } = useTip();
  const max = Math.max(0.0001, ...rows.map((r) => r.value));
  const fmt = format ?? ((v: number) => String(Math.round(v * 10) / 10));
  return (
    <div className="flex items-end gap-2">
      {rows.map((r, i) => (
        <div key={r.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="text-xs font-semibold tabular-nums text-ink">{fmt(r.value)}</span>
          <div
            className={`w-full max-w-14 cursor-pointer rounded-t ${colorFor(r, i)}`}
            style={{ height: `${Math.max(2, (r.value / max) * 72)}px` }}
            onMouseMove={(e) => show(e.clientX, e.clientY, [r.label, `${fmt(r.value)}${r.sub ? ` · ${r.sub}` : ""}`])}
            onMouseLeave={hide}
          />
          <span className="truncate text-[10px] text-ink-faint">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Win-expectation sparkline of ONE game (user's view, 0..100).
 * Hover reads any point; the losing move is marked in red.
 */
export function WpSpark({
  wp,
  youWhite,
  dropPly,
  startPly = 0,
  onClick,
}: {
  wp: number[];
  youWhite: boolean;
  dropPly: number | null;
  startPly?: number;
  onClick?: (ply: number) => void;
}) {
  const { t } = useI18n();
  const { show, hide } = useTip();
  const ref = useRef<SVGSVGElement | null>(null);
  const W = 200;
  const H = 40;
  const you = (x: number) => (youWhite ? x : 100 - x);
  if (wp.length < 2) return null;
  const x = (i: number) => (i / (wp.length - 1)) * W;
  const y = (v: number) => H - (v / 100) * H;
  const line = wp.map((v, i) => `${x(i).toFixed(1)},${y(you(v)).toFixed(1)}`).join(" ");
  const area = `M0,${H} L${line.split(" ").join(" L")} L${W},${H} Z`;

  const plyFromEvent = (clientX: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(wp.length - 1, Math.max(0, Math.round(((clientX - r.left) / r.width) * (wp.length - 1))));
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="h-10 w-full cursor-crosshair"
      preserveAspectRatio="none"
      onMouseMove={(e) => {
        const i = plyFromEvent(e.clientX);
        show(e.clientX, e.clientY, [
          `${t("moveNumber", { n: Math.floor(i / 2) + 1 })}${i % 2 ? "…" : ""}`,
          `${t("winExpectation")}: ${Math.round(you(wp[i]))}%`,
        ]);
      }}
      onMouseLeave={hide}
      onClick={(e) => onClick?.(plyFromEvent(e.clientX) + startPly)}
    >
      <path d={area} fill="rgba(52,211,153,0.18)" />
      <polyline points={line} fill="none" stroke="#34d399" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <line x1={0} y1={y(50)} x2={W} y2={y(50)} stroke="#737373" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      {dropPly != null && dropPly >= 0 && dropPly < wp.length && (
        <line
          x1={x(dropPly)}
          y1={0}
          x2={x(dropPly)}
          y2={H}
          stroke="#ef4444"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** Expected-vs-actual score curve against rating gap (with PR per bucket). */
export function GapChart({ buckets }: { buckets: GapBucket[] }) {
  const { t } = useI18n();
  const { show, hide } = useTip();
  const shown = buckets.filter((b) => b.n > 0);
  if (shown.length === 0) return null;
  const W = 560;
  const H = 190;
  const pad = { l: 36, r: 12, t: 12, b: 34 };
  const plotW = W - pad.l - pad.r;
  const x = (i: number) => pad.l + ((i + 0.5) / buckets.length) * plotW;
  const y = (p: number) => pad.t + (1 - p) * (H - pad.t - pad.b);
  const bw = plotW / buckets.length - 8;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t("secGap")}>
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <g key={p}>
          <line x1={pad.l} x2={W - pad.r} y1={y(p)} y2={y(p)} className="stroke-line-strong" />
          <text x={pad.l - 5} y={y(p) + 3} textAnchor="end" className="fill-ink-faint" fontSize={10}>
            {Math.round(p * 100)}%
          </text>
        </g>
      ))}
      {buckets.map((b, i) => {
        // expected curve point
        const act = b.actual;
        return (
          <g key={b.mid}>
            {b.n > 0 && act != null && (
              <rect
                x={x(i) - bw / 2}
                y={Math.min(y(act), y(0.5))}
                width={bw}
                height={Math.max(2, Math.abs(y(act) - y(0.5)))}
                className={act >= b.expected ? "cursor-pointer fill-emerald-500/70" : "cursor-pointer fill-red-500/60"}
                rx={2}
                onMouseMove={(e) =>
                  show(e.clientX, e.clientY, [
                    `${t("gapLabel", { diff: b.mid > 0 ? `+${b.mid}` : `${b.mid}` })} · ${t("thGames").toLowerCase()} ${b.n}`,
                    `${t("actualScore")}: ${Math.round(act * 100)}%`,
                    `${t("expectedScore")}: ${Math.round(b.expected * 100)}%`,
                    b.pr != null ? `${t("performanceRating")}: ${b.pr >= 0 ? "+" : ""}${b.pr}` : "",
                  ].filter(Boolean))
                }
                onMouseLeave={hide}
              />
            )}
          </g>
        );
      })}
      {/* expected line */}
      <polyline
        fill="none"
        stroke="#a3a3a3"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        points={buckets.map((b, i) => `${x(i)},${y(b.expected)}`).join(" ")}
      />
      {buckets.map((b, i) =>
        b.n > 0 ? (
          <text
            key={`l${b.mid}`}
            x={x(i)}
            y={H - 20}
            textAnchor="middle"
            className="fill-ink-mute"
            fontSize={10}
          >
            {b.mid > 0 ? `+${b.mid}` : b.mid}
          </text>
        ) : null,
      )}
      <text x={W / 2} y={H - 5} textAnchor="middle" className="fill-ink-faint" fontSize={10}>
        {t("gapVsOwn")}
      </text>
    </svg>
  );
}

/** Rolling accuracy trend (improvement signal that leads the rating). */
export function TrendChart({ points, window: win }: { points: TrendPoint[]; window: number }) {
  const { t, locale } = useI18n();
  const { show, hide } = useTip();
  if (points.length < 4) return null;
  const W = 560;
  const H = 200;
  const pad = { l: 36, r: 12, t: 12, b: 26 };
  const accs = points.flatMap((p) => [p.acc, p.roll]);
  const a0 = Math.min(...accs) - 3;
  const a1 = Math.max(...accs) + 3;
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - a0) / (a1 - a0)) * (H - pad.t - pad.b);
  const ticks = [0, 1, 2, 3].map((i) => Math.round(a0 + ((a1 - a0) * i) / 3));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t("secTrend")}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="stroke-line-strong" />
          <text x={pad.l - 5} y={y(v) + 3} textAnchor="end" className="fill-ink-faint" fontSize={10}>
            {v}
          </text>
        </g>
      ))}
      {/* raw per-game accuracy dots */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(p.acc)}
          r={4}
          fill="transparent"
          className="cursor-pointer"
          onMouseMove={(e) =>
            show(e.clientX, e.clientY, [
              fmtDate(p.t, locale),
              `${t("accuracy")}: ${p.acc}%`,
              `${t("rollingAvg", { n: win })}: ${p.roll}%`,
            ])
          }
          onMouseLeave={hide}
        />
      ))}
      {points.map((p, i) => (
        <circle key={`d${i}`} cx={x(i)} cy={y(p.acc)} r={1.6} fill="#38bdf8" opacity={0.7} pointerEvents="none" />
      ))}
      <polyline
        fill="none"
        stroke="#f59e0b"
        strokeWidth={2}
        points={points.map((p, i) => `${x(i)},${y(p.roll)}`).join(" ")}
      />
      <text x={W - pad.r} y={pad.t + 2} textAnchor="end" className="fill-ink-faint" fontSize={10}>
        {t("rollingAvg", { n: win })}
      </text>
    </svg>
  );
}

export function fmtPct(x: number | null, digits = 0): string {
  return x == null ? "-" : `${(x * 100).toFixed(digits)}%`;
}
