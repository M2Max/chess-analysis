/**
 * Smoke-test the settings view: persistence, engine switch, gear nav.
 * Run: bun run scripts/debug-settings.ts
 */
import { chromium } from "playwright-core";

const APP = "http://localhost:5173/";
const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200));
});
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("stockfish") && (u.endsWith(".wasm") || u.endsWith(".js"))) {
    console.log(`[engine asset] ${r.status()} ${u.replace(APP, "")}`);
  }
  if (r.status() >= 400) console.log("[http", r.status(), "]", u);
});

// 1. settings screen by default
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });
const hasSettings = await page.locator("h2", { hasText: "Settings" }).count();
console.log("settings screen by default:", hasSettings === 1);
const gear = page.locator('button[aria-label="Settings"]');
console.log("gear visible:", (await gear.count()) === 1);

// 2. fill username + pick full engine, then verify localStorage
await page.fill("input", "Mamox43");
await page.getByLabel(/Full/).click();
const stored = await page.evaluate(() => localStorage.getItem("chess-analysis.settings.v2"));
console.log("stored:", stored);

// 3. reload → persisted
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });
const usernameAfterReload = await page.inputValue("input");
const fullChecked = await page.getByLabel(/Full/).isChecked();
console.log("persisted username:", usernameAfterReload, "| full engine checked:", fullChecked);

// 4. demo game with the FULL engine (113MB wasm fetch)
await page.getByRole("button", { name: /Try demo game/ }).click();
// wait for the accuracy panel — only appears once real evals exist
await page.waitForFunction(() => /acc/.test(document.body.innerText), { timeout: 180000 });
const t = await page.evaluate(() => document.body.innerText);
console.log("demo done:", !t.includes("Analyzing"));
console.log("accuracy:", t.match(/\d+% acc/g));
console.log("eval chip:", t.slice(t.indexOf("⏭") + 2, t.indexOf("⏭") + 12).trim());
console.log("failed:", t.includes("Review failed"));

// 5. gear → back to settings (from the review screen)
await gear.click();
await page.waitForSelector("h2", { hasText: "Settings", timeout: 5000 });
console.log("gear from review → settings: true");

await browser.close();
