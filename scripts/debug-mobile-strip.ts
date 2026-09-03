/**
 * Mobile strip verification (playwright, iPhone-like viewport).
 *
 * 1. opens the demo game at 390x844 (touch)
 * 2. early: tip centered even with only 2 revealed moves
 * 3. auto-advance while analyzing (cursor follows tip)
 * 4. board stays within viewport as strip content grows (regression)
 * 5. after analysis:
 *    - last move centered (2 left / 0 right), green glow, no bg highlight
 *    - first move centered (0 left / 2 right)
 *    - middle move: 5 cells visible, selected centered, outer cells dim+blur
 *    - board horizontally centered in viewport
 *    - drag left 2 / drag right 1 / tap 1 right update selection + board
 *    - classification badge (black circle, symbol) on the board at the moved
 *      piece's square top-right corner
 */
import { chromium, type Page } from "playwright-core";

const EXE =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const PITCH = 64 + 8;

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

// move number lives in the cell's SECOND span — the concatenated textContent
// is ambiguous ("d4" + "5" renders as "d45" → regex would read 45)
const selNumber = async (page: Page) =>
  page.evaluate(() => {
    const sel = document.querySelector('[aria-label^="Move strip"] div[data-current]');
    const num = sel?.querySelector("span:nth-child(2)");
    const m = num?.textContent?.match(/\d+/);
    return m ? Number(m[0]) : null;
  });

const pieceSet = async (page: Page) =>
  page.evaluate(
    () => Array.from(document.querySelectorAll('[id^="chessboard-piece-"]')).map((el) => el.id).sort().join(","),
  );

const boardBox = async (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector("#chessboard-board");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: r.width, left: r.left, right: r.right, cx: r.left + r.width / 2, vw: window.innerWidth };
  });

/** settled geometry of the strip window */
const stripInfo = async (page: Page) =>
  page.evaluate(() => {
    const wrap = document.querySelector('[aria-label^="Move strip"]');
    const rect = wrap!.getBoundingClientRect();
    const cells = Array.from(wrap!.querySelectorAll(":scope > div > div"));
    const vis = cells
      .map((c) => {
        const r = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        return {
          text: (c.textContent ?? "").replace(/\s+/g, " "),
          left: r.left - rect.left,
          right: r.right - rect.left,
          opacity: cs.opacity,
          filter: cs.filter,
        };
      })
      .filter((c) => c.left >= -1 && c.right <= rect.width + 1);
    const sel = cells.find((c) => c.hasAttribute("data-current"));
    const sr = sel?.getBoundingClientRect();
    const selStyle = sel ? getComputedStyle(sel) : null;
    return {
      wrapW: rect.width,
      total: cells.length,
      vis,
      selCenter: sr ? sr.left + sr.width / 2 - rect.left : null,
      selText: sel?.textContent ?? null,
      selShadow: selStyle?.boxShadow ?? null,
      selBg: selStyle?.backgroundColor ?? null,
      outer: vis.filter((v) => v.opacity < 0.99),
    };
  });

const dragBy = async (page: Page, dx: number) => {
  const wrap = await page.locator('[aria-label^="Move strip"]').boundingBox();
  if (!wrap) fail("strip bbox missing");
  const x = wrap.x + wrap.width / 2;
  const y = wrap.y + wrap.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y, { steps: 2 });
  await page.mouse.up();
};

const checkCentered = (st: Awaited<ReturnType<typeof stripInfo>>, label: string) => {
  const err = Math.abs((st.selCenter ?? -999) - st.wrapW / 2);
  if (err > 6) fail(`${label}: selected cell not centered (off ${err.toFixed(1)}px)`);
  if (!st.selShadow?.includes("52, 211, 153")) fail(`${label}: no green glow: ${st.selShadow}`);
  if (st.selBg && st.selBg !== "rgba(0, 0, 0, 0)") fail(`${label}: selection has background ${st.selBg}`);
  console.log(`${label}: "${st.selText?.replace(/\s+/g, " ")}" centered + green glow, no bg ✓`);
};

const s = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const ctx = await s.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
await page.goto("http://localhost:5173/?demo", { waitUntil: "networkidle" });

// 2) early centering: as soon as moves are revealed the tip must be centered
await page.waitForFunction(
  () => {
    const wrap = document.querySelector('[aria-label^="Move strip"]');
    const cells = wrap ? wrap.querySelectorAll(":scope > div > div") : [];
    if (cells.length === 0) return false;
    const sel = wrap.querySelector("div[data-current]");
    if (!sel) return false;
    const wr = wrap.getBoundingClientRect();
    const sr = sel.getBoundingClientRect();
    return Math.abs(sr.left + sr.width / 2 - (wr.left + wr.width / 2)) < 8;
  },
  null,
  { timeout: 90_000 },
);
const earlyN = await page.evaluate(
  () => document.querySelectorAll('[aria-label^="Move strip"] > div > div').length,
);
console.log(`early centering: tip centered with ${earlyN} revealed moves ✓`);

// 3) auto-advance while analyzing
const n1 = await selNumber(page);
let advanced = false;
try {
  await page.waitForFunction(
    (start) => {
      const sel = document.querySelector('[aria-label^="Move strip"] div[data-current]');
      const num = sel?.querySelector("span:nth-child(2)");
      const m = num?.textContent?.match(/\d+/);
      return m ? Number(m[0]) > start : false;
    },
    n1,
    { timeout: 90_000 },
  );
  advanced = true;
} catch {
  const dump = await page.evaluate(() => ({
    cells: document.querySelectorAll('[aria-label^="Move strip"] > div > div').length,
    analyzing: document.body.textContent?.includes("Analyzing"),
    selText: document.querySelector('[aria-label^="Move strip"] div[data-current]')?.textContent ?? null,
  }));
  fail(`auto-advance stalled (n1=${n1}) state=${JSON.stringify(dump)}`);
}
const n2 = await selNumber(page);
if (n2 == null || n1 == null || n2 <= n1) fail(`strip did not auto-advance (${n1} → ${n2})`);
console.log(`auto-advance: selected move ${n1} → ${n2} (follows analysis tip) ✓`);
void advanced;

// 4) board stays within the viewport while the strip content grows
await page.waitForFunction(
  () => document.querySelectorAll('[aria-label^="Move strip"] > div > div').length >= 6,
  null,
  { timeout: 90_000 },
);
const bw1 = await boardBox(page);
await page.waitForFunction(
  () => document.querySelectorAll('[aria-label^="Move strip"] > div > div').length >= 14,
  null,
  { timeout: 90_000 },
);
const bw2 = await boardBox(page);
if (!bw1 || !bw2) fail("board not found");
console.log(
  `board: ${bw1.w.toFixed(0)}px (6 moves) → ${bw2.w.toFixed(0)}px (14+ moves), viewport ${bw2.vw}px, right ${bw2.right.toFixed(0)}px`,
);
if (Math.abs(bw2.w - bw1.w) > 2) fail(`board width changed with strip growth: ${bw1.w} → ${bw2.w}`);
if (bw2.right > bw2.vw + 1) fail(`board overflows viewport right: ${bw2.right} > ${bw2.vw}`);
if (bw2.left < -1) fail(`board overflows viewport left: ${bw2.left}`);
console.log("board stays within the screen as the strip grows ✓");

// 5) wait for analysis to finish → settled states
await page.waitForFunction(
  () => !document.body.textContent?.includes("Analyzing"),
  null,
  { timeout: 180_000, polling: 1000 },
);
await page.waitForTimeout(500);

// 5a) first move: centered, 0 left / 2 right
await page.getByTitle("First position (Home)").click();
await page.waitForTimeout(450);
const first = await stripInfo(page);
checkCentered(first, "first move");
console.log(`  start window: [${first.vis.map((c) => c.text).join(" ")}]`);
if (first.vis.length !== 3) fail(`first move window: expected 3 visible (center + 2 right), got ${first.vis.length}`);

// 5b) last move: centered, 2 left / 0 right
await page.getByTitle("Last position (End)").click();
await page.waitForTimeout(450);
const end = await stripInfo(page);
checkCentered(end, "last move");
console.log(`  end window: [${end.vis.map((c) => `${c.text}(op ${c.opacity})`).join(" ")}]`);
if (end.vis.length !== 3) fail(`last move window: expected 3 visible (2 left + center), got ${end.vis.length}`);

// 5c) middle move (drag 7 from start): 5 visible, centered, outer dim+blur
await page.getByTitle("First position (Home)").click();
await page.waitForTimeout(450);
await dragBy(page, -7 * PITCH);
await page.waitForTimeout(450);
const mid = await stripInfo(page);
if ((await selNumber(page)) !== 7) fail(`drag 7 from start: expected move 7, got ${await selNumber(page)}`);
checkCentered(mid, "middle move");
console.log(`  mid window: [${mid.vis.map((c) => `${c.text}(op ${c.opacity})`).join(" ")}]`);
if (mid.vis.length !== 5) fail(`middle window: expected 5 visible, got ${mid.vis.length}`);
if (mid.outer.length < 2) fail(`expected >=2 dimmed outer cells, got ${mid.outer.length}`);
if (!mid.outer[0]?.filter?.includes("blur")) fail(`outer cells not blurred: ${mid.outer[0]?.filter}`);
console.log(`  outer cells dimmed + blurred ✓ (ops: ${mid.outer.map((o) => o.opacity).join(", ")})`);

// 5d) board horizontally centered in the viewport
const bb = await boardBox(page);
if (!bb) fail("board not found");
const boardOff = Math.abs(bb.cx - bb.vw / 2);
if (boardOff > 4) fail(`board not centered: off by ${boardOff.toFixed(1)}px`);
console.log(`board centered in viewport (off ${boardOff.toFixed(1)}px) ✓`);

// 5e) drag / tap navigation
await page.getByTitle("First position (Home)").click();
await page.waitForTimeout(450);
const before = await pieceSet(page);
await dragBy(page, -2 * PITCH);
await page.waitForTimeout(450);
const n3 = await selNumber(page);
if (n3 !== 2) fail(`drag left 2 from first: expected move 2, got ${n3}`);
const after = await pieceSet(page);
if (before === after) fail("board pieces did not change after drag selection");
console.log(`drag left 2 cells: → move ${n3}, board pieces changed ✓`);
await dragBy(page, 1 * PITCH);
await page.waitForTimeout(450);
const n4 = await selNumber(page);
if (n4 !== 1) fail(`drag right 1: expected move 1, got ${n4}`);
const tapPos = await page.evaluate(() => {
  const wrap = document.querySelector('[aria-label^="Move strip"]')!;
  const cells = Array.from(wrap.querySelectorAll(":scope > div > div"));
  const sel = cells.find((c) => c.hasAttribute("data-current"))!;
  const r = cells[cells.indexOf(sel) + 1].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.click(tapPos.x, tapPos.y);
await page.waitForTimeout(450);
const n5 = await selNumber(page);
if (n5 !== 2) fail(`tap cell 1 right: expected move 2, got ${n5}`);
console.log(`drag right 1: → move ${n4}; tap 1 right: → move ${n5} ✓`);

// 5f) classification badge on the board: select the LAST symbol move
const k = await page.evaluate(() => {
  const wrap = document.querySelector('[aria-label^="Move strip"]')!;
  const cells = Array.from(wrap.querySelectorAll(":scope > div > div"));
  for (let i = cells.length - 1; i >= 0; i--) {
    if (/[!?]/.test(cells[i].querySelector("span")?.textContent ?? "")) return i;
  }
  return -1;
});
if (k < 0) fail("no symbol moves found in strip");
const cur = (await selNumber(page))!;
const delta = k + 1 - cur;
if (delta !== 0) await dragBy(page, -delta * PITCH);
await page.waitForTimeout(600);
const badgeMove = await selNumber(page);
if (badgeMove !== k + 1) fail(`badge nav: expected move ${k + 1}, got ${badgeMove}`);
const b = await page.evaluate(() => {
  const el = document.querySelector("[data-board-symbol]");
  if (!el) return { error: "no board symbol badge" };
  const er = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const cx = er.left + er.width / 2;
  const cy = er.top + er.height / 2;
  let hit: string | null = null;
  for (const sq of document.querySelectorAll('[id^="chessboard-square-"]')) {
    const r = sq.getBoundingClientRect();
    // badge must sit in the top-right quadrant of the moved-to square
    if (cx >= r.left + r.width * 0.35 && cx <= r.right + 6 && cy >= r.top - 6 && cy <= r.top + r.height * 0.65) {
      hit = sq.id;
      break;
    }
  }
  return {
    text: el.textContent,
    bg: cs.backgroundColor,
    square: hit,
    size: +er.width.toFixed(1),
  };
});
if ("error" in b) fail(b.error);
// opaque light category color — no alpha, not grayscale, not black
if (/\/ 0\.\d+\)/.test(b.bg)) fail(`badge bg must be opaque (no alpha): ${b.bg}`);
if (/oklab\([\d.]+ 0 0/.test(b.bg)) fail(`badge bg is grayscale (expected category color): ${b.bg}`);
if (b.size < 30) fail(`badge too small (expected ~2x of old 19px): ${b.size}px`);
if (!b.square) fail("badge not in any square's top-right quadrant");
console.log(`board badge "${b.text}" at ${b.square} top-right (${b.size}px, solid light color circle ${b.bg}) ✓ on move ${badgeMove}`);

console.log("\nALL MOBILE STRIP CHECKS PASSED");
await s.close();
process.exit(0);
