import { useEffect, useRef } from "react";
import { categoryColorClass, hasSymbol } from "../engine/classify";
import { useI18n } from "../i18n";
import { CategorySymbol } from "./CategorySymbol";
import type { ReviewState } from "../state/review";

interface Props {
  state: ReviewState;
  /** select the position after move #n of the current line (1-based) */
  onSelectMove: (n: number) => void;
}

interface Row {
  number: number;
  white: { n: number; idx: number } | null;
  black: { n: number; idx: number } | null;
}

export function MoveList({ state, onSelectMove }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLButtonElement>(null);
  const cursor = state.cursor;

  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, state.line.length]);

  // moves of the current line: line[0] is the start, line[i] = after move i
  const lineMoves = state.line.slice(1).map((idx, i) => ({ n: i + 1, idx }));
  const rows: Row[] = [];
  for (let i = 0; i < lineMoves.length; i += 2) {
    rows.push({
      number: i / 2 + 1,
      white: lineMoves[i] ?? null,
      black: lineMoves[i + 1] ?? null,
    });
  }

  const cell = (m: { n: number; idx: number }) => {
    const node = state.nodes[m.idx];
    const isCurrent = state.cursor === m.n;
    return (
      <button
        key={m.idx}
        ref={isCurrent ? cursorRef : undefined}
        onClick={() => onSelectMove(m.n)}
        className={`flex min-w-0 flex-1 items-center gap-1 rounded px-1.5 py-1 text-left text-sm transition ${
          isCurrent
            ? "bg-sel text-sel-text ring-1 ring-sel-ring"
            : "text-ink-soft hover:bg-btn"
        }`}
        title={
          node.bestSan
            ? t("engineMove", { san: node.bestSan, depth: node.achievedDepth ? ` (d${node.achievedDepth})` : "" })
            : undefined
        }
      >
        <span className={`truncate font-medium ${node.isMainline ? "" : "text-branch"}`}>
          {node.move?.san}
        </span>
        {hasSymbol(node.category) && (
          <span className={`text-xs font-bold ${categoryColorClass(node.category)}`}>
            <CategorySymbol category={node.category} />
          </span>
        )}
        {node.thinking && (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-ink-faint border-t-transparent" />
        )}
        {!node.isMainline && <span className="text-[9px] text-branch/70">◦</span>}
      </button>
    );
  };

  return (
    <div
      ref={containerRef}
      className="hidden max-h-[420px] min-h-[120px] overflow-y-auto rounded-md bg-card-solid/60 p-2 ring-1 ring-line lg:block"
    >
      {rows.length === 0 && (
        <div className="p-2 text-center text-sm text-ink-faint">{t("noMovesYet")}</div>
      )}
      <table className="w-full border-separate border-spacing-y-0.5">
        <tbody>
          {rows.map((r) => (
            <tr key={r.number} className="align-middle">
              <td className="w-8 pr-1 text-right text-xs tabular-nums text-ink-faint">
                {r.number}.
              </td>
              <td className="w-1/2 pr-1">{r.white ? cell(r.white) : null}</td>
              <td className="w-1/2">{r.black ? cell(r.black) : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
