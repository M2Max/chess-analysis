/**
 * Browser sanity for the new classifier + MultiPV + arrow toggle.
 *  1. Real engine worker: verify `setoption MultiPV 3` is honored (info lines
 *     carry multipv 1..3).
 *  2. Demo game full analysis: categories use the new labels, symbols show,
 *     no console errors.
 *  3. Arrow toggle: arrow present by default → toggle off → persists.
 */
import { chromium } from "playwright-core";

const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://localhost:5173/?demo", { waitUntil: "networkidle" });

// ---- 1. real worker: MultiPV lines -------------------------------------
const mp = await page.evaluate(async () => {
  return new Promise<string[]>((resolve) => {
    const w = new Worker("/stockfish-lite/stockfish-multi.js");
    const lines: string[] = [];
    let uciOk = false;
    w.onmessage = (e) => {
      const line = String(e.data);
      lines.push(line);
      if (line === "uciok") {
        if (!uciOk) {
          uciOk = true;
          w.postMessage("setoption name Threads value 4");
          w.postMessage("setoption name MultiPV value 3");
          w.postMessage("isready");
          return;
        }
      }
      if (line === "readyok" && uciOk) {
        w.postMessage("position startpos");
        w.postMessage("go movetime 400");
        return;
      }
      if (line.startsWith("bestmove")) {
        w.terminate();
        resolve(lines);
      }
    };
    w.postMessage("uci");
  });
});
const mpLines = mp.filter((l) => l.startsWith("info ") && l.includes(" pv "));
const mpIdx = mpLines
  .map((l) => l.match(/\bmultipv (\d+)/)?.[1])
  .filter(Boolean);
const hasPv1 = mpIdx.includes("1");
const hasPv2 = mpIdx.includes("2");
const hasPv3 = mpIdx.includes("3");
console.log(`[multiPv] info lines: ${mpLines.length}, pv1:${hasPv1} pv2:${hasPv2} pv3:${hasPv3}`);
console.log(
  "[multiPv] sample:",
  mpLines.filter((l) => l.includes("multipv 2"))[0]?.slice(0, 90) ?? "n/a",
);
if (!(hasPv1 && hasPv2 && hasPv3)) throw new Error("MultiPV 3 not honored by real engine");

// ---- 2. demo game full analysis ----------------------------------------
// wait for the analysis to finish: 23 moves revealed, no spinner, terminal M1
console.log("[demo] waiting for full analysis (~30-60s)...");
await page.waitForFunction(
  () => {
    const cells = document.querySelectorAll("table tbody button");
    const spinner = document.querySelector("table tbody svg.animate-spin");
    return cells.length >= 23 && !spinner && (document.body.textContent ?? "").includes("M1");
  },
  { timeout: 180_000 },
);

const moveSyms = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll<HTMLElement>("table tbody button"));
  return btns.map((b) => {
    const san = b.querySelector("span")?.textContent?.trim() ?? "";
    const sym = Array.from(b.querySelectorAll("span"))
      .map((s) => s.textContent?.trim() ?? "")
      .find((t) => t !== san && t.length > 0 && !/^\d+$/.test(t)) ?? "";
    return `${san}${sym ? sym : ""}`;
  });
});
console.log("[demo] moves:", JSON.stringify(moveSyms));

// visual check of the new symbols (mono ★ / 👍 / ✓ / ✕)
await page.locator("table").first().screenshot({ path: "/tmp/moves-symbols.png" });

// accuracy badges present for both players
const acc = await page.evaluate(() =>
  (document.body.textContent?.match(/\d+%/g) ?? []).slice(0, 4),
);
console.log("[demo] accuracies:", acc);

// ---- 3. arrow toggle -----------------------------------------------------
const arrowSel = () =>
  page.evaluate(() => document.querySelectorAll("marker[id*='arrowhead']").length);

// navigate to the first position (cursor ends on the mate position after
// analysis, which has no arrow)
await page.locator("button[title='First position (Home)']").click();
await page.waitForTimeout(300);
let arrows = await arrowSel();
console.log("[arrow] count with showArrow default (true):", arrows);
if (arrows < 1) throw new Error("expected best-move arrow by default");

// find the toggle button (title contains 'best-move arrow')
const toggle = page.locator("button[title*='best-move arrow']");
await toggle.click();
await page.waitForTimeout(300);
arrows = await arrowSel();
console.log("[arrow] count after toggle off:", arrows);
if (arrows > 0) throw new Error("arrow still visible after toggling off");

// persisted?
const stored = await page.evaluate(() => localStorage.getItem("chess-analysis.settings.v2"));
console.log("[arrow] settings now:", stored);
if (!stored?.includes('"showArrow":false')) throw new Error("showArrow=false not persisted");

// reload → still off (wait until analysis has an evaluated position)
await page.reload({ waitUntil: "networkidle" });
await page.waitForFunction(
  () => document.querySelectorAll("table tbody button").length >= 1,
  { timeout: 30_000 },
);
await page.waitForTimeout(500);
arrows = await arrowSel();
console.log("[arrow] count after reload:", arrows);
if (arrows > 0) throw new Error("arrow came back after reload");

// restore for other users/tests
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("chess-analysis.settings.v2") ?? "{}");
  s.showArrow = true;
  localStorage.setItem("chess-analysis.settings.v2", JSON.stringify(s));
});

const realErrors = errors.filter((e) => !e.includes("favicon"));
if (realErrors.length) {
  console.error("[console errors]", realErrors);
  throw new Error("console errors present");
}
console.log("\nOK — MultiPV real-engine lines, new classifier demo run, arrow toggle + persistence");
await browser.close();
