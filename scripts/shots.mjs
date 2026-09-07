// Fresh README screenshots (regenerate: node scripts/shots.mjs while dev
// servers run). Not part of CI - run manually after visible UI changes.
import { chromium } from "playwright-core";

const EXE =
  "/Users/mmamone/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));

// ---- 1. games list (dark) ----
await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill('input[autocomplete="off"]', "Mamox43");
await page.click('button:has-text("Recupera partite")');
await page.waitForSelector("ul li button", { timeout: 90000 });
await sleep(800);
await page.screenshot({ path: "images/list-dark.png" });
console.log("list-dark done");

// ---- 2. stats (dark): scroll to the results, skip the intro card ----
await page.click('button[aria-label*="Statistiche"]');
await page.waitForSelector("text=Quadro generale", { timeout: 30000 });
await sleep(1200);
await page.evaluate(() =>
  [...document.querySelectorAll("h2")].find((h) => h.textContent?.includes("Quadro generale"))?.scrollIntoView(),
);
await sleep(400);
await page.screenshot({ path: "images/stats-dark.png" });
console.log("stats-dark done");

// ---- 3. review of the Opera Game demo (dark, then light) ----
await page.goto(`${BASE}/?demo`, { waitUntil: "networkidle" });
// wait until the LAST move strip button carries a classification glyph
await page.waitForFunction(
  () => {
    const strip = document.querySelector('[aria-label*="mosse"]');
    if (!strip) return false;
    const cells = [...strip.querySelectorAll(".flex > div")];
    if (cells.length < 10) return false;
    return /[!?★☆✕✓]/.test(cells[cells.length - 1]?.textContent ?? "");
  },
  null,
  { timeout: 300000, polling: 2000 },
);
console.log("demo analysed");
// land on a middlegame position for a nicer shot (the strip is swipe-driven;
// keyboard navigation is the supported programmatic way)
for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowRight");
await sleep(1200);
await page.screenshot({ path: "images/review-dark.png" });
console.log("review-dark done");

await page.click('button[aria-label*="Cambia tema"]');
await sleep(700);
await page.screenshot({ path: "images/review-light.png" });
console.log("review-light done");

await browser.close();
console.log("ALL SHOTS DONE");
