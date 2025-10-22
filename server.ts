import express from "express";
import { chromium, devices } from "playwright";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8787;

const UA_POOL = [
  devices["Desktop Chrome"].userAgent,
  devices["Desktop Firefox"].userAgent,
  devices["Desktop Edge"].userAgent
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

async function withBrowser<T>(fn: (ctx: { browser: any }) => Promise<T>) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    return await fn({ browser });
  } finally {
    await browser.close();
  }
}

app.post("/tm/insights", async (req, res) => {
  const { region = "auckland", suburb = "onehunga", district = "auckland", rows = 150, page = 1 } = req.body || {};
  const url = `https://www.trademe.co.nz/a/property/insights/search/${region}/${suburb}?off_market=false&rows=${rows}&page=${page}`;
  const result = await withBrowser(async ({ browser }) => {
    const ctx = await browser.newContext({
      userAgent: randUA(),
      locale: "en-NZ",
      timezoneId: "Pacific/Auckland",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" }
    });
    const p = await ctx.newPage();
    await p.route("**/*.{png,jpg,jpeg,gif,webp,svg}", r => r.abort());
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(1200);
    await p.evaluate(async () => {
      await new Promise<void>(resolve => {
        let y = 0; const h = document.body.scrollHeight;
        const id = setInterval(() => {
          y += 800; window.scrollTo(0, y);
          if (y >= h) { clearInterval(id); resolve(); }
        }, 120);
      });
    });
    const items = await p.$$eval('a[href*="/a/property/insights/profile/"]', as =>
      Array.from(new Set(as.map(a => (a as HTMLAnchorElement).href))).slice(0, 200)
    );
    const html = await p.content();
    await ctx.close();
    return { url, items, html };
  });
  res.json(result);
});

app.post("/fetch", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  const result = await withBrowser(async ({ browser }) => {
    const ctx = await browser.newContext({
      userAgent: randUA(),
      locale: "en-NZ",
      timezoneId: "Pacific/Auckland",
      viewport: { width: 1366, height: 900 }
    });
    const p = await ctx.newPage();
    await p.route("**/*.{png,jpg,jpeg,gif,webp,svg}", r => r.abort());
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(800);
    const html = await p.content();
    await ctx.close();
    return { url, html, hash: crypto.createHash("md5").update(html).digest("hex") };
  });
  res.json(result);
});

app.get("/", (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Fetcher on :${PORT}`));
