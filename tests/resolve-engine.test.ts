import { describe, expect, test } from "bun:test";
import { resolveEngine } from "../src/engine/engine";

describe("resolveEngine", () => {
  test("auto threads → hardware concurrency, multi when isolated", () => {
    expect(resolveEngine("lite", 0, { hardwareConcurrency: 8, crossOriginIsolated: true })).toEqual({
      kind: "lite",
      threads: 8,
      variant: "multi",
    });
  });

  test("not isolated → single-threaded even with threads set", () => {
    expect(resolveEngine("full", 4, { hardwareConcurrency: 8, crossOriginIsolated: false })).toEqual({
      kind: "full",
      threads: 1,
      variant: "single",
    });
  });

  test("isolated but 1 thread → single build", () => {
    expect(resolveEngine("full", 1, { crossOriginIsolated: true })).toEqual({
      kind: "full",
      threads: 1,
      variant: "single",
    });
  });

  test("thread count capped at max (explicit and auto)", () => {
    expect(resolveEngine("lite", 64, { hardwareConcurrency: 16, crossOriginIsolated: true }).threads).toBe(8);
    expect(resolveEngine("lite", 0, { hardwareConcurrency: 16, crossOriginIsolated: true }).threads).toBe(8);
  });

  test("defaults when env unknown", () => {
    expect(resolveEngine("lite", 0, {})).toEqual({ kind: "lite", threads: 1, variant: "single" });
    expect(resolveEngine("lite", 2, { crossOriginIsolated: true })).toEqual({
      kind: "lite",
      threads: 2,
      variant: "multi",
    });
  });
});
