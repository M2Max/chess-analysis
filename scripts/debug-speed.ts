/**
 * Time a long game (177 plies) with the multi-threaded engine.
 * Run: bun run scripts/debug-speed.ts
 */
import { chromium } from "playwright-core";

const APP = "http://localhost:5173/";
const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const THREADS = process.env.THREADS ?? "0"; // 0 = auto
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 250));
});

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });
await page.fill("input", "Mamox43");
if (THREADS !== "0") {
  await page.locator("select").first().selectOption(THREADS);
}
await page.click("button[type=submit]");
await page.waitForSelector("ul li button", { timeout: 30000 });

// open the 177-ply game (vs MokalapaBTebello28)
const row = page.locator("ul li button", { hasText: "MokalapaBTebello28" }).first();
console.log("found row:", (await row.count()) === 1);
const t0 = Date.now();
await row.click();

let last = 0;
while (Date.now() - t0 < 240000) {
  await page.waitForTimeout(2000);
  const snap = await page.evaluate(() => {
    const t = document.body.innerText;
    const p = t.match(/Analyzing (\d+)\/(\d+)/);
    return { p: p ? `${p[1]}/${p[2]}` : null, failed: t.includes("Review failed") };
  });
  if (snap.p) last = parseInt(snap.p!.split("/")[0]);
  if (snap.failed) {
    console.log("FAILED at", last, "positions");
    break;
  }
  if (snap.p === null && last > 0) break; // done
}
const secs = (Date.now() - t0) / 1000;
console.log(`[threads=${THREADS}] long game (178 positions) finished in ${secs.toFixed(1)}s`);
console.log(`≈ ${(secs / 178 * 1000).toFixed(0)}ms/position`);

const t = await page.evaluate(() => document.body.innerText);
console.log("accuracy:", t.match(/\d+% acc/g));
await browser.close();
