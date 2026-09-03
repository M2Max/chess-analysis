/**
 * Verify the multi-threaded engine end-to-end. Run: bun run scripts/debug-mt.ts
 */
import { chromium } from "playwright-core";

const APP = "http://localhost:5173/";
const CHROME =
  process.env.HOME +
  "/.cache/puppeteer/chrome/mac_arm-142.0.7444.175/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || m.type() === "warning") console.log(`[console:${m.type()}]`, t.slice(0, 300));
  else if (/thread|worker|stockfish/i.test(t)) console.log(`[console]`, t.slice(0, 200));
});
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("stockfish")) console.log(`[http ${r.status()}]`, u.replace(APP, ""));
});

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector("input", { timeout: 15000 });

const isolated = await page.evaluate(() => ({
  crossOriginIsolated,
  hasSAB: typeof SharedArrayBuffer !== "undefined",
  hw: navigator.hardwareConcurrency,
}));
console.log("isolation:", JSON.stringify(isolated));

// open the demo game (default settings: lite + auto threads)
await page.getByRole("button", { name: /Try demo game/ }).click();

// track progress + timing
const t0 = Date.now();
const samples: string[] = [];
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(2500);
  const snap = await page.evaluate(() => {
    const t = document.body.innerText;
    const p = t.match(/Analyzing (\d+)\/(\d+)/);
    const err = t.match(/Review failed[\s\S]{0,150}/);
    return { p: p ? `${p[1]}/${p[2]}` : null, err: err ? err[0].replace(/\n/g, " ") : null, acc: /acc/.test(t) };
  });
  samples.push(`+${Math.round((Date.now() - t0) / 1000)}s ${snap.p ?? "-"}${snap.err ? " ERR: " + snap.err : ""}${snap.acc ? " [acc]" : ""}`);
  if (snap.acc && snap.p === null) break;
}
console.log(samples.join("\n"));

const t = await page.evaluate(() => document.body.innerText);
console.log("done:", !t.includes("Analyzing"), "| failed:", t.includes("Review failed"));
if (t.includes("Review failed")) console.log(t.match(/Review failed[\s\S]{0,300}/)?.[0]);
console.log("accuracy:", t.match(/\d+% acc/g));

await browser.close();
