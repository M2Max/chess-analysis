/**
 * Engine tuning. All values in milliseconds / plain numbers.
 *
 * Per choice the settings view offers a single-threaded and a multi-threaded
 * build (see scripts/fetch-engine.ts). Multi-threaded needs cross-origin
 * isolation (COOP/COEP) - the app falls back to single-threaded when
 * `crossOriginIsolated` is false.
 */
export type EngineKind = "lite" | "full";

export const ENGINE_CONFIG = {
  /** Worker entry points per engine choice + threading. */
  workerUrls: {
    lite: {
      single: "/stockfish-lite/stockfish.js",
      multi: "/stockfish-lite/stockfish-multi.js",
    },
    full: {
      single: "/stockfish-full/stockfish.js",
      multi: "/stockfish-full/stockfish-multi.js",
    },
  } as Record<EngineKind, { single: string; multi: string }>,
  /**
   * Per-position time budgets. Multi-threaded searches spend the same wall
   * time on N cores, so multi uses shorter budgets - faster review overall
   * at equal or better quality.
   */
  gameMovetimeMs: { single: 450, multi: 200 },
  branchMovetimeMs: { single: 900, multi: 500 },
  /** Upper bound for the user-selectable thread count. */
  maxThreads: 8,
  /**
   * UCI MultiPV: every search returns the top-3 lines. Powers move
   * classification (played move's own eval, Great-move gap, brilliancy
   * "hard to refute" check) at negligible extra search cost.
   */
  multiPv: 3,
} as const;

/**
 * Per-position analysis budgets. "fast" is the current default; "deep"
 * spends exactly 3× as long per position (≈ +110 Elo by the ~70 Elo/doubling
 * time-scaling rule).
 *
 * Estimated strength - Stockfish 18 WASM, MultiPV 3 (which costs ≈ 150 Elo
 * of best-move quality per Stockfish's own measurements), typical laptop
 * CPU. "full" (complete NNUE net) plays ≈ +100 over "lite" (reduced net)
 * at the same time budget:
 *
 *   fast: lite ≈ 3200 · full ≈ 3300
 *   deep: lite ≈ 3350 · full ≈ 3450
 */
export type AnalysisMode = "fast" | "deep";

export const ANALYSIS_MODES: Record<
  AnalysisMode,
  {
    label: string;
    /** rough playing strength per engine build, for the settings UI */
    estElo: Record<EngineKind, number>;
    game: { single: number; multi: number };
    branch: { single: number; multi: number };
  }
> = {
  fast: {
    label: "Fast",
    estElo: { lite: 3200, full: 3300 },
    game: { single: 450, multi: 200 },
    branch: { single: 900, multi: 500 },
  },
  deep: {
    label: "Deep",
    estElo: { lite: 3350, full: 3450 },
    game: { single: 1350, multi: 600 },
    branch: { single: 2700, multi: 1500 },
  },
};
