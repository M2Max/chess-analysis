import { expect, test } from "bun:test";
import { CELL, PITCH, stripTransform } from "../src/components/MoveStrip";

const W = 390; // iPhone-like width

/** left edge of cell i given transform t */
const cellLeft = (t: number, i: number) => t + i * PITCH;

/** cells fully inside the container */
const visible = (t: number, n: number) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = cellLeft(t, i);
    if (l >= 0 && l + CELL <= W) out.push(i);
  }
  return out;
};

/** center of cell i given transform t */
const cellCenter = (t: number, i: number) => cellLeft(t, i) + CELL / 2;

test("n=0 → 0", () => {
  expect(stripTransform(W, 0, 0)).toBe(0);
});

test("single move is centered", () => {
  const t = stripTransform(W, 1, 0);
  expect(cellCenter(t, 0)).toBe(W / 2);
});

test("small track (n<5): selected cell still centered (tip case reported on phone)", () => {
  const t = stripTransform(W, 3, 2); // 3 revealed moves, cursor at tip
  expect(cellCenter(t, 2)).toBe(W / 2);
  // cell 0 sits fully to the left of the centered tip
  expect(cellLeft(t, 0) + CELL).toBeLessThanOrEqual(W / 2);
});

test("many moves: middle selection is exactly centered with 5 cells visible", () => {
  const t = stripTransform(W, 40, 20);
  expect(cellCenter(t, 20)).toBe(W / 2);
  expect(visible(t, 40)).toEqual([18, 19, 20, 21, 22]);
});

test("tip: selected (last) move centered - 2 cells left, 0 right", () => {
  const t = stripTransform(W, 40, 39);
  expect(cellCenter(t, 39)).toBe(W / 2);
  expect(visible(t, 40)).toEqual([37, 38, 39]);
});

test("first move: centered - 0 cells left, 2 right", () => {
  const t = stripTransform(W, 40, 0);
  expect(cellCenter(t, 0)).toBe(W / 2);
  expect(visible(t, 40)).toEqual([0, 1, 2]);
});

test("monotonic slide: Δ = PITCH per step, no jumps", () => {
  const n = 40;
  for (let i = 0; i < n - 1; i++) {
    const d = stripTransform(W, n, i + 1) - stripTransform(W, n, i);
    expect(d).toBe(-PITCH); // advancing the cursor slides the track left
  }
});

test("390px screen: window shows 5 moves (center + 2 + 2)", () => {
  const t = stripTransform(W, 20, 10);
  expect(visible(t, 20)).toHaveLength(5);
  expect(visible(t, 20)).toContain(10);
});
