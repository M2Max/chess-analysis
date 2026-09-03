/**
 * Stockfish WASM wrapper - runs the nmrugg stockfish.js build in a Web Worker,
 * speaking plain UCI over postMessage (string commands in, string lines out).
 *
 * Usage:
 *   const engine = new Engine();
 *   const res = await engine.analyze(fen, { movetimeMs: 500 }, (info) => ...);
 *   engine.stop(); // interrupt current search (its promise resolves with bestmove)
 *
 * Analyses are strictly serial (FIFO). A new analyze() call queues behind the
 * in-flight one. stop() resolves the in-flight analysis early.
 */

import { ENGINE_CONFIG } from "./config";
import type { Score } from "./classify";

export interface ScoreInfo {
  depth: number;
  seldepth: number;
  score: Score;
  /** UCI moves of the principal variation. */
  pv: string[];
  /** MultiPV line index (1 = principal variation). Absent when MultiPV=1. */
  multipv?: number;
}

export interface AnalysisResult {
  /** UCI move (e.g. "e2e4", "e7e8q"). "0000" when no legal move. */
  bestMove: string;
  /** Final (deepest) info line of the principal variation, if any. */
  info: ScoreInfo | null;
  /** Final info lines of all requested MultiPV lines, in multipv order. */
  multipv: ScoreInfo[];
}

// ---------------------------------------------------------------- line parsing

function numAfter(s: string, key: string): number | undefined {
  const m = s.match(new RegExp(`\\b${key} (\\d+)`));
  return m ? Number(m[1]) : undefined;
}

/** Parse a UCI "info ..." line. Returns null for lines without a usable score+pv. */
export function parseInfoLine(line: string): ScoreInfo | null {
  if (!line.startsWith("info ")) return null;
  const pvIdx = line.indexOf(" pv ");
  if (pvIdx < 0) return null;
  const head = line.slice(5, pvIdx);
  const pv = line
    .slice(pvIdx + 4)
    .trim()
    .split(/\s+/);
  const scoreMatch = head.match(/score (cp|mate) (-?\d+)/);
  if (!scoreMatch) return null;
  const score: Score =
    scoreMatch[1] === "cp"
      ? { cp: Number(scoreMatch[2]) }
      : { mate: Number(scoreMatch[2]) };
  return {
    depth: numAfter(head, "depth") ?? 0,
    seldepth: numAfter(head, "seldepth") ?? 0,
    score,
    pv,
    multipv: numAfter(head, "multipv"),
  };
}

/** Parse a UCI "bestmove ..." line → UCI move or "0000". */
export function parseBestMoveLine(line: string): string {
  return line.split(/\s+/)[1] ?? "0000";
}

// ------------------------------------------------------------------- the engine

interface CurrentCtx {
  resolve: (r: AnalysisResult) => void;
  reject: (e: Error) => void;
  onInfo?: (info: ScoreInfo) => void;
  lastInfo: ScoreInfo | null;
  /** last seen info line per multipv index */
  multipv: Map<number, ScoreInfo>;
}

export interface EngineOptions {
  /** UCI `Threads` - >1 only makes sense for the multi-threaded builds. */
  threads?: number;
  /** which build `url` points at (drives per-variant tuning upstream) */
  variant?: "single" | "multi";
  /** UCI `MultiPV` - request N lines per search (default 1). */
  multiPv?: number;
}

export class Engine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private inited = false;
  private disposed = false;
  private current: CurrentCtx | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly threads: number;
  readonly variant: "single" | "multi";
  readonly multiPv: number;

  constructor(
    private url: string = ENGINE_CONFIG.workerUrls.lite.single,
    opts: EngineOptions = {},
  ) {
    this.threads = Math.max(1, Math.floor(opts.threads ?? 1));
    this.variant = opts.variant ?? "single";
    this.multiPv = Math.max(1, Math.floor(opts.multiPv ?? 1));
  }

  /** Create + initialize the worker (uci → isready). Reuses an existing worker. */
  ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("engine disposed"));
    if (!this.ready) {
      this.ready = this.doInit().catch((e) => {
        this.reset();
        throw e;
      });
    }
    return this.ready;
  }

  private reset(): void {
    this.ready = null;
    this.inited = false;
    this.current = null;
    try {
      this.worker?.terminate();
    } catch {
      /* noop */
    }
    this.worker = null;
  }

  private doInit(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let uciOk = false;
      const w = new Worker(this.url);
      this.worker = w;
      w.onerror = (e) => {
        const msg = e instanceof ErrorEvent ? e.message : "unknown worker error";
        if (!this.inited) {
          reject(new Error(`Stockfish worker failed to start: ${msg}`));
        } else {
          const cur = this.current;
          this.reset();
          cur?.reject(new Error(`Stockfish worker crashed: ${msg}`));
        }
      };
      // uci → uciok → [setoption Threads] → isready → readyok
      w.onmessage = (e) => {
        const line = typeof e.data === "string" ? e.data : String(e.data);
        if (line === "uciok") {
          if (!this.inited) {
            uciOk = true;
            if (this.threads > 1) w.postMessage(`setoption name Threads value ${this.threads}`);
            if (this.multiPv > 1) w.postMessage(`setoption name MultiPV value ${this.multiPv}`);
            w.postMessage("isready");
          }
          return;
        }
        if (line === "readyok") {
          if (!this.inited && uciOk) {
            this.inited = true;
            resolve();
          }
          return;
        }
        this.handleLine(line);
      };
      w.postMessage("uci");
    });
  }

  private handleLine(line: string): void {
    if (line.startsWith("info ")) {
      const info = parseInfoLine(line);
      const cur = this.current;
      if (info && cur) {
        // With MultiPV>1 only the principal line drives live updates;
        // every line is collected per multipv index for the final result.
        const isPv1 = !info.multipv || info.multipv === 1;
        cur.multipv.set(isPv1 ? 1 : info.multipv!, info);
        if (isPv1) {
          cur.lastInfo = info;
          cur.onInfo?.(info);
        }
      }
      return;
    }
    if (line.startsWith("bestmove")) {
      const cur = this.current;
      if (!cur) return;
      this.current = null;
      const multipv = [...cur.multipv.values()].sort(
        (a, b) => (a.multipv ?? 1) - (b.multipv ?? 1),
      );
      cur.resolve({ bestMove: parseBestMoveLine(line), info: cur.lastInfo, multipv });
    }
  }

  /**
   * Analyse a position. Serialises behind any in-flight analysis.
   * `onInfo` fires on every new principal variation (live eval updates).
   */
  analyze(
    fen: string,
    opts: { movetimeMs?: number; depth?: number },
    onInfo?: (info: ScoreInfo) => void,
  ): Promise<AnalysisResult> {
    const prev = this.queue;
    const job = this.ensureReady()
      .then(() => prev) // wait for the previous job to finish → strict FIFO
      .then(() => this.runOne(fen, opts, onInfo));
    // keep the chain alive even if this job rejects
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private runOne(
    fen: string,
    opts: { movetimeMs?: number; depth?: number },
    onInfo?: (info: ScoreInfo) => void,
  ): Promise<AnalysisResult> {
    return new Promise<AnalysisResult>((resolve, reject) => {
      const w = this.worker;
      if (!w) {
        reject(new Error("engine not ready"));
        return;
      }
      const ctx: CurrentCtx = { resolve, reject, onInfo, lastInfo: null, multipv: new Map() };
      this.current = ctx;
      w.postMessage(`position fen ${fen}`);
      const go =
        opts.movetimeMs != null
          ? `go movetime ${opts.movetimeMs}`
          : `go depth ${opts.depth ?? 20}`;
      w.postMessage(go);
    });
  }

  /** Stop the in-flight search. Its analyze() promise resolves with a bestmove. */
  stop(): void {
    if (this.worker && this.current) this.worker.postMessage("stop");
  }

  /**
   * Terminate the worker. The engine must not be used afterwards.
   * A job in flight is rejected so callers cannot hang forever.
   */
  dispose(): void {
    this.disposed = true;
    const cur = this.current;
    this.current = null;
    this.reset();
    cur?.reject(new Error("engine disposed"));
  }
}
