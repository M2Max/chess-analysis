import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { Engine, parseBestMoveLine, parseInfoLine } from "../src/engine/stockfish";

// ---------------------------------------------------------------- line parsing

describe("parseInfoLine", () => {
  test("cp score with pv", () => {
    const info = parseInfoLine(
      "info depth 18 seldepth 24 multipv 1 score cp 35 nodes 1234 nps 100000 tbhits 0 time 450 pv e2e4 g8f6 b1c3",
    );
    expect(info).toEqual({
      depth: 18,
      seldepth: 24,
      score: { cp: 35 },
      pv: ["e2e4", "g8f6", "b1c3"],
      multipv: 1,
    });
  });

  test("no multipv field → undefined (single-line engines)", () => {
    const info = parseInfoLine("info depth 10 score cp 5 pv d2d4");
    expect(info?.multipv).toBeUndefined();
  });

  test("mate score", () => {
    const info = parseInfoLine("info depth 30 score mate -4 pv e7e5 g1f3");
    expect(info?.score).toEqual({ mate: -4 });
    expect(info?.pv).toEqual(["e7e5", "g1f3"]);
  });

  test("negative cp", () => {
    const info = parseInfoLine("info depth 10 score cp -123 pv d2d4");
    expect(info?.score).toEqual({ cp: -123 });
  });

  test("no pv → null (not usable)", () => {
    expect(parseInfoLine("info depth 10 score cp 5")).toBeNull();
  });

  test("non-info lines → null", () => {
    expect(parseInfoLine("bestmove e2e4")).toBeNull();
    expect(parseInfoLine("uciok")).toBeNull();
  });
});

describe("parseBestMoveLine", () => {
  test("extracts the move", () => {
    expect(parseBestMoveLine("bestmove e2e4")).toBe("e2e4");
    expect(parseBestMoveLine("bestmove e7e8q depth 12")).toBe("e7e8q");
    expect(parseBestMoveLine("bestmove 0000")).toBe("0000");
  });

  test("missing token → 0000", () => {
    expect(parseBestMoveLine("bestmove")).toBe("0000");
    expect(parseBestMoveLine("")).toBe("0000");
  });
});

// ----------------------------------------------------- fake-worker protocol

/**
 * A fake UCI worker: answers the handshake, echoes an info line per `go`,
 * and finishes searches after a short delay (so stop() is testable).
 */
class FakeWorker {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  goDelayMs = 20;
  pending: { fen: string }[] = [];
  /** when true, `go` emits three multipv lines instead of one */
  emitMultipv = false;
  setoptions: string[] = [];
  searchedFens: string[] = [];
  static last: FakeWorker | null = null;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(cmd: string) {
    const emit = (line: string) => queueMicrotask(() => this.onmessage?.({ data: line }));
    if (cmd === "uci") emit("uciok");
    else if (cmd === "isready") emit("readyok");
    else if (cmd.startsWith("setoption ")) {
      this.setoptions.push(cmd);
    } else if (cmd.startsWith("position fen ")) {
      this.pending.push({ fen: cmd.slice("position fen ".length) });
    } else if (cmd.startsWith("go ")) {
      const fen = this.pending[0]?.fen ?? "?";
      setTimeout(() => {
        if (this.terminated) return;
        if (this.emitMultipv) {
          emit(`info depth 12 seldepth 15 multipv 1 score cp 50 pv a1a2 b8c6`);
          emit(`info depth 12 seldepth 15 multipv 2 score cp 30 pv b1b2 g8f6`);
          emit(`info depth 12 seldepth 15 multipv 3 score cp 10 pv c1c2 d7d5`);
        } else {
          emit(`info depth 12 seldepth 15 score cp 42 pv e2e4 g8f6`);
        }
        emit(`bestmove a1a2`);
        this.searchedFens.push(fen);
      }, this.goDelayMs);
    } else if (cmd === "stop") {
      emit("bestmove h2h3");
    } else if (cmd === "quit") {
      this.terminated = true;
    }
  }

  terminate() {
    this.terminated = true;
  }
}

const realWorker = globalThis.Worker;

beforeAll(() => {
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
});

afterAll(() => {
  globalThis.Worker = realWorker;
});

describe("Engine (fake worker)", () => {
  beforeEach(() => {
    FakeWorker.last = null;
  });

  test("initializes via uci/isready handshake", async () => {
    const e = new Engine("fake://stockfish.js");
    await e.ensureReady();
    await e.ensureReady(); // idempotent
    e.dispose();
  });

  test("multiPv option sends the setoption at init", async () => {
    const e = new Engine("fake://stockfish.js", { multiPv: 3 });
    await e.ensureReady();
    const w = FakeWorker.last;
    expect(w?.setoptions).toContain("setoption name MultiPV value 3");
    e.dispose();
  });

  test("multiPv lines are collected in order; onInfo fires for pv1 only", async () => {
    const e = new Engine("fake://stockfish.js", { multiPv: 3 });
    await e.ensureReady();
    // the instance the engine created; enable multipv output before analyze
    FakeWorker.last!.emitMultipv = true;
    const infos: number[] = [];
    const res = await e.analyze("FEN_X", { movetimeMs: 5 }, (i) => infos.push(i.multipv ?? 1));
    expect(res.bestMove).toBe("a1a2");
    expect(res.multipv.map((m) => m.multipv)).toEqual([1, 2, 3]);
    expect(res.multipv[0].score).toEqual({ cp: 50 });
    expect(res.multipv[2].pv).toEqual(["c1c2", "d7d5"]);
    expect(res.info?.multipv).toBe(1);
    expect(infos).toEqual([1]); // live updates only from the principal line
    e.dispose();
  });

  test("analyze sends position+go and resolves bestmove + info", async () => {
    const e = new Engine("fake://stockfish.js");
    const infos: number[] = [];
    const res = await e.analyze(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      { movetimeMs: 50 },
      (i) => infos.push(i.depth),
    );
    expect(res.bestMove).toBe("a1a2");
    expect(res.info?.score).toEqual({ cp: 42 });
    expect(res.multipv).toHaveLength(1); // single line, treated as multipv 1
    expect(infos).toEqual([12]);
    e.dispose();
  });

  test("analyses are serialised in FIFO order", async () => {
    const e = new Engine("fake://stockfish.js");
    const order: number[] = [];
    const p1 = e.analyze("FEN_A", { movetimeMs: 10 }).then(() => order.push(1));
    const p2 = e.analyze("FEN_B", { movetimeMs: 10 }).then(() => order.push(2));
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
    e.dispose();
  });

  test("stop() resolves the in-flight search early", async () => {
    const e = new Engine("fake://stockfish.js");
    const p = e.analyze("FEN_C", { movetimeMs: 10_000 });
    setTimeout(() => e.stop(), 5);
    const res = await p;
    expect(res.bestMove).toBe("h2h3"); // from the stop handler
    e.dispose();
  });

  test("dispose rejects further use", async () => {
    const e = new Engine("fake://stockfish.js");
    e.dispose();
    await expect(e.ensureReady()).rejects.toThrow(/disposed/);
  });
});
