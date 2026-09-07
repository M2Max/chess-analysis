/**
 * Chart tooltips: every chart element on the stats page must reveal its
 * exact values on hover. A tiny context + fixed layer - no portal, no lib.
 * Charts call `show(x, y, lines)` from pointer handlers.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface TipState {
  x: number;
  y: number;
  lines: string[];
}

interface TipApi {
  show: (x: number, y: number, lines: string[]) => void;
  hide: () => void;
}

const TipCtx = createContext<TipApi>({ show: () => {}, hide: () => {} });

export function useTip(): TipApi {
  return useContext(TipCtx);
}

/** Pointer handlers for any chart element: shows `lines` while hovering. */
export function tipHandlers(lines: () => string[]): {
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
} {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { show, hide } = useContext(TipCtx);
  return {
    onMouseMove: (e: React.MouseEvent) => show(e.clientX, e.clientY, lines()),
    onMouseLeave: hide,
  };
}

export function TipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = useCallback((x: number, y: number, lines: string[]) => setTip({ x, y, lines }), []);
  const hide = useCallback(() => setTip(null), []);
  return (
    <TipCtx.Provider value={{ show, hide }}>
      {children}
      {tip && (
        <div
          data-testid="chart-tip"
          className="pointer-events-none fixed z-50 rounded-md bg-card-solid px-2.5 py-1.5 text-[11px] leading-snug text-ink shadow-lg ring-1 ring-line-strong"
          style={{
            left: Math.min(tip.x + 14, window.innerWidth - 210),
            top: Math.max(4, tip.y - 14 - tip.lines.length * 15),
          }}
        >
          {tip.lines.map((l, i) => (
            <div key={i} className={i === 0 ? "font-semibold" : "text-ink-mute"}>
              {l}
            </div>
          ))}
        </div>
      )}
    </TipCtx.Provider>
  );
}
