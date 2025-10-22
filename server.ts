import express from "express";
import { chromium, devices } from "playwright";
import crypto from "crypto";
import { URL } from "url";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/render/.cache/ms-playwright";
const EXPECTED_CHROMIUM =
  "chromium_headless_shell-1194/chrome-linux/headless_shell"; // Playwright pins revisions; path pattern is stable.

const UA_POOL = [
  devices["Desktop Chrome"].userAgent,
  devices["Desktop Firefox"].userAgent,
  devices["Desktop Edge"].userAgent,
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

function ensureBrowsers() {
  try {
    const full = path.join(BROWSERS_PATH, EXPECTED_CHROMIUM);
    if (fs.existsSync(full)) {
      console.log("✓ Chromium present:", full);
      return;
    }
    console.log("⚙ Installing Chromium to:", BROWSERS_PATH);
    // Make sure env points to Render cache so Playwright installs there
    execSync("npx playwright install chromium", {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH,
      },
    });
    const ok = fs.existsSync(full);
    if (!ok) {
      throw new Error(
        `Chromium not found after install at ${full}. Check build logs.`
      );
    }
    console.log("✓ Chromium installed.");
  } catch (e) {
    console.error("Playwright install failed at runtime:", e);
    throw e;
  }
}

async function withBrowser<T>(fn: (ctx: { browser: any }) => Promise<T>) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    return await fn({ browser });
  } finally {
    await browser.close();
  }
}

// Call once on boot
ensureBrowsers();

// -----------------------------
// POST /tm/insights
// -----------------------------
app.post("/tm/insights", async (req, res) => {
  const {
    region = "auckland",
    suburb = "onehunga",
    district = "auckland",
    rows = 150,
    page = 1,
  } = req.body || {};
  const url = `https://www.trademe.co.nz/a/property/insights/search/${region}/${suburb}?off_market=false&rows=${rows}&page=${page}`;

  const result = await withBrowser(async ({ browser }) => {
    const ctx = await browser.newContext({
      userAgent: randUA(),
      locale: "en-NZ",
      timezoneId: "Pacific/Auckland",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" },
    });
    const p = await ctx.newPage();
    await p.route("**/*.{png,jpg,jpeg,gif,webp,svg}", (r) => r.abort());
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(1200);
    await p.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const h = document.body.scrollHeight;
        const id = setInterval(() => {
          y += 800;
          window.scrollTo(0, y);
          if (y >= h) {
            clearInterval(id);
            resolve();
          }
        }, 120);
      });
    });
    const items = await p.$$eval(
      'a[href*="/a/property/insights/profile/"]',
      (as) =>
        Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).href))).slice(
          0,
          200
        )
    );
    const html = await p.content();
    await ctx.close();
    return { url, items, html };
  });

  res.json(result);
});

// -----------------------------
// GET /tm/insights
// -----------------------------
app.get("/tm/insights", async (req, res) => {
  const region = (req.query.region as string) || "auckland";
  const suburb = (req.query.suburb as string) || "onehunga";
  const district = (req.query.district as string) || "auckland";
  const rows = parseInt((req.query.rows as string) || "150", 10);
  const pageNum = parseInt((req.query.page as string) || "1", 10);

  const url = `https://www.trademe.co.nz/a/property/insights/search/${region}/${suburb}?off_market=false&rows=${rows}&page=${pageNum}`;

  const result = await withBrowser(async ({ browser }) => {
    const ctx = await browser.newContext({
      userAgent: randUA(),
      locale: "en-NZ",
      timezoneId: "Pacific/Auckland",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" },
    });
    const p = await ctx.newPage();
    await p.route("**/*.{png,jpg,jpeg,gif,webp,svg}", (r) => r.abort());
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(1200);
    await p.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const h = document.body.scrollHeight;
        const id = setInterval(() => {
          y += 800;
          window.scrollTo(0, y);
          if (y >= h) {
            clearInterval(id);
            resolve();
          }
        }, 120);
      });
    });
    const items = await p.$$eval(
      'a[href*="/a/property/insights/profile/"]',
      (as) =>
        Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).href))).slice(
          0,
          200
        )
    );
    const html = await p.content();
    await ctx.close();
    return { url, items, html };
  });

  res.json(result);
});

// -----------------------------
// POST /fetch
// -----------------------------
app.post("/fetch", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });

  const result = await withBrowser(async ({ browser }) => {
    const ctx = await browser.newContext({
      userAgent: randUA(),
      locale: "en-NZ",
      timezoneId: "Pacific/Auckland",
      viewport: { width: 1366, height: 900 },
    });
    const p = await ctx.newPage();
    await p.route("**/*.{png,jpg,jpeg,gif,webp,svg}", (r) => r.abort());
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await p.waitForTimeout(800);
    const html = await p.content();
    await ctx.close();
    return {
      url,
      html,
      hash: crypto.createHash("md5").update(html).digest("hex"),
    };
  });

  res.json(result);
});

// -----------------------------
// GET /fetch
// -----------------------------
app.get("/fetch", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).json({ error: "url query param required" });

  try {
    const u = new URL(raw);
    const allowed = [
      "www.trademe.co.nz",
      "trademe.co.nz",
      "barfoot.co.nz",
      "www.barfoot.co.nz",
      "raywhite.co.nz",
      "www.raywhite.co.nz",
      "bayleys.co.nz",
      "www.bayleys.co.nz",
      "auckland.bayleys.co.nz",
      "harcourts.co.nz",
      "www.harcourts.co.nz",
      "oneroof.co.nz",
      "www.oneroof.co.nz",
      "realestate.co.nz",
      "www.realestate.co.nz",
      "homes.co.nz",
      "www.homes.co.nz",
      "propertyvalue.co.nz",
      "www.propertyvalue.co.nz",
    ];
    const hostOk = allowed.some((a) => u.host === a);
    if (!hostOk) {
      return res.status(400).json({ error: `host not allowed: ${u.host}` });
    }

    const result = await withBrowser(async ({ browser }) => {
      const ctx = await browser.newContext({
        userAgent: randUA(),
        locale: "en-NZ",
        timezoneId: "Pacific/Auckland",
        viewport: { width: 1366, height: 900 },
      });
      const p = await ctx.newPage();
      await p.route("**/*.{png,jpg,jpeg,gif,webp,svg}", (r) => r.abort());
      await p.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
      await p.waitForTimeout(800);
      const html = await p.content();
      await ctx.close();
      return {
        url: u.toString(),
        html,
        hash: crypto.createHash("md5").update(html).digest("hex"),
      };
    });

    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "bad url" });
  }
});

app.get("/", (_req, res) => res.json({ ok: true, browsersPath: BROWSERS_PATH }));

app.listen(PORT, () => console.log(`Fetcher on :${PORT}`));
