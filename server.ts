import express from "express";
import { chromium, devices } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ============ CONFIG ============
const PORT = process.env.PORT || 10000;
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/render/.cache/ms-playwright";
const EXPECTED_CHROMIUM = "chromium_headless_shell-1194/chrome-linux/headless_shell";

const SERPER_API_KEY = process.env.SERPER_API_KEY || ""; // for agent discovery
const MAX_SERPER_PER_ADDR = 6;

const UA_POOL = [
  devices["Desktop Chrome"].userAgent,
  devices["Desktop Firefox"].userAgent,
  devices["Desktop Edge"].userAgent,
];
const randUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

// Domains we allow to fetch for agent validation
const ALLOWED_FETCH_HOSTS = new Set([
  "www.trademe.co.nz", "trademe.co.nz",
  "barfoot.co.nz", "www.barfoot.co.nz",
  "raywhite.co.nz", "www.raywhite.co.nz",
  "bayleys.co.nz", "www.bayleys.co.nz", "auckland.bayleys.co.nz",
  "harcourts.co.nz", "www.harcourts.co.nz",
  "professionals.co.nz", "www.professionals.co.nz",
  "ljhooker.co.nz", "www.ljhooker.co.nz",
  "tallpoppy.co.nz", "www.tallpoppy.co.nz",
  "mikepero.com", "www.mikepero.com",
  "sothebysrealty.co.nz", "www.sothebysrealty.co.nz",
  "eves.co.nz", "www.eves.co.nz",
  "lodge.co.nz", "www.lodge.co.nz",
  "kowhairealty.co.nz", "www.kowhairealty.co.nz",
  "oneroof.co.nz", "www.oneroof.co.nz",
  "realestate.co.nz", "www.realestate.co.nz",
  "homes.co.nz", "www.homes.co.nz",
  "propertyvalue.co.nz", "www.propertyvalue.co.nz",
  "ratemyagent.co.nz", "www.ratemyagent.co.nz",
]);

// ============ BOOTSTRAP BROWSER ============
function ensureBrowsers() {
  try {
    const full = path.join(BROWSERS_PATH, EXPECTED_CHROMIUM);
    if (fs.existsSync(full)) {
      console.log("✓ Chromium present:", full);
      return;
    }
    console.log("⚙ Installing Chromium to:", BROWSERS_PATH);
    execSync("npx playwright install chromium", {
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH },
    });
    if (!fs.existsSync(full)) {
      throw new Error(`Chromium not found after install at ${full}`);
    }
    console.log("✓ Chromium installed.");
  } catch (e) {
    console.error("Playwright install failed at runtime:", e);
    throw e;
  }
}
ensureBrowsers();

// ============ EXPRESS ============
const app = express();
app.use(express.json({ limit: "2mb" }));

// ============ PLAYWRIGHT HELPERS ============
async function withBrowser<T>(fn: (ctx: { browser: any }) => Promise<T>) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try { return await fn({ browser }); }
  finally { await browser.close(); }
}

async function newCtx(browser: any) {
  return browser.newContext({
    userAgent: randUA(),
    locale: "en-NZ",
    timezoneId: "Pacific/Auckland",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" },
  });
}

async function openListAndCollect(browser: any, url: string) {
  const ctx = await newCtx(browser);
  const p = await ctx.newPage();
  await p.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", r => r.abort());

  await p.goto(url, { waitUntil: "networkidle", timeout: 60000 });

  // Trigger lazy load
  await p.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let y = 0, h = document.body.scrollHeight;
      const tick = () => {
        y += 900; window.scrollTo(0, y);
        if (y >= h - innerHeight) resolve(); else setTimeout(tick, 120);
      };
      tick();
    });
  });

  // Wait for anchors to exist
  const sel = 'a[href*="/a/property/insights/profile/"]';
  await p.waitForSelector(sel, { timeout: 15000 }).catch(() => {});

  // Final settle
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const items: string[] = await p.$$eval(sel, (as) => {
    const hrefs = Array.from(as).map(a => (a as HTMLAnchorElement).href).filter(Boolean);
    return Array.from(new Set(hrefs)).filter(u => /\/a\/property\/insights\/profile\//.test(u));
  });

  const html = await p.content();
  await ctx.close();
  return { url, items, html };
}

async function fetchHtml(browser: any, url: string) {
  const host = new URL(url).host;
  if (!ALLOWED_FETCH_HOSTS.has(host)) throw new Error(`host not allowed: ${host}`);

  const ctx = await newCtx(browser);
  const p = await ctx.newPage();
  await p.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}", r => r.abort());
  await p.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await p.waitForTimeout(600);
  const html = await p.content();
  await ctx.close();
  return { url, html, hash: crypto.createHash("md5").update(html).digest("hex") };
}

// ============ PARSERS ============
const MONTHS: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

function parseNZDate(text: string): string | null {
  if (!text) return null;
  const s = text.replace(/,|\u00a0/g, " ").trim();

  // Sold on 15 Oct 2025 / Last sold on 15 Oct 2025 / Sold 15 Sept 2025
  const m1 = s.match(/(?:sold|auctioned|last sold)\s*(?:on\s*)?(\d{1,2})\s*([A-Za-z]+)\s*(\d{2,4})/i);
  if (m1) {
    const d = m1[1].padStart(2, "0");
    const monRaw = m1[2].toLowerCase();
    const mon = MONTHS[monRaw];
    const y = m1[3].length === 2 ? `20${m1[3]}` : m1[3];
    if (mon) return `${y}-${mon}-${d}`;
  }
  // 15/10/2025 or 5/9/25
  const m2 = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m2) {
    const d = m2[1].padStart(2, "0");
    const mon = m2[2].padStart(2, "0");
    const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
    return `${y}-${mon}-${d}`;
  }
  return null;
}

function grabMoneyInt(text: string): number | null {
  if (!text) return null;
  const m = text.replace(/\u00a0/g, " ").match(/\$?\s*([\d,]+)(?:\.\d{2})?/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  if (n < 10000) return null;
  return n;
}

function extractBetween(html: string, label: RegExp): string | null {
  const m = html.match(label);
  return m ? m[0] : null;
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Parse a TM profile/detail page
function parseTmProfile(html: string, url: string) {
  const fullText = textOf(html);

  // Address – TM profile pages usually have <h1>...</h1> with the address
  let address = (html.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1] || "").replace(/<[^>]+>/g, "").trim();
  if (!address) {
    // fallback: og:title
    address = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || "";
  }
  address = address.replace(/\s+/g, " ").trim();

  // Sold date text
  const soldDateRaw =
    fullText.match(/\b(Sold|Last sold|Auctioned)\s*(?:on\s*)?\d{1,2}\s+[A-Za-z]+\.?\s+\d{2,4}\b/i)?.[0] ||
    fullText.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0] ||
    "";
  const sold_date = parseNZDate(soldDateRaw);

  // Sold price
  const soldPriceText =
    fullText.match(/\b(?:SOLD|Sold(?: for)?):?\s*\$[\d,]+(?:\.\d{2})?\b/i)?.[0] ||
    fullText.match(/\bSold(?: for)?\s*\$[\d,]+(?:\.\d{2})?\b/i)?.[0] ||
    "";
  const sold_price_nzd = grabMoneyInt(soldPriceText);

  // CV/RV
  const cvBlock =
    fullText.match(/\b(Capital Value|Rateable Value|RV|CV)[^$]{0,40}\$[\d,]+/i)?.[0] || "";
  const cv_value_nzd = grabMoneyInt(cvBlock);
  const cv_updated =
    fullText.match(/\b(Updated|Update[ds]?:?)\s*:?\s*\d{1,2}\s+[A-Za-z]+\.?\s+\d{2,4}\b/i)?.[0] ||
    fullText.match(/\b(Updated|Update[ds]?:?)\s*:?\s*[A-Za-z]+\s+\d{4}\b/i)?.[0] ||
    "";

  return {
    address,
    sold_date_text: soldDateRaw || (sold_date ? `Sold on ${sold_date}` : ""),
    sold_date: sold_date || "",
    sold_price_text: soldPriceText || "",
    sold_price_nzd: sold_price_nzd || 0,
    cv_value_text: cvBlock || "",
    cv_value_nzd: cv_value_nzd || 0,
    cv_updated: cv_updated.replace(/^(Updated|Updates?:?)\s*:?\s*/i, ""),
    tm_property_url: url,
    source: "trademe" as const,
  };
}

// ============ AGENT DISCOVERY ============
type AgentHit = {
  agent_names: string[];
  agency_name: string;
  agent_source_url: string;
};

const REJECT_HOSTS = new Set(["instagram.com", "www.instagram.com", "facebook.com", "www.facebook.com", "tiktok.com", "www.tiktok.com"]);

// ± tolerance helpers
function withinPct(a: number, b: number, pct = 0.01) { return Math.abs(a - b) <= Math.max(a, b) * pct; }
function withinDays(isoA: string, isoB: string, days = 7) {
  if (!isoA || !isoB) return false;
  const tA = new Date(isoA + "T12:00:00+13:00").getTime();
  const tB = new Date(isoB + "T12:00:00+13:00").getTime();
  const diff = Math.abs(tA - tB) / (1000 * 60 * 60 * 24);
  return diff <= days;
}

function normaliseAgent(name: string) { return name.replace(/\s+/g, " ").trim(); }
function extractAgentsFromText(text: string): string[] {
  // naive; pick up "By X and Y", "Agents: A, B"
  const m = text.match(/\b(?:Agent[s]?:|By)\s*([A-Za-z ,.'-]+)\b/i);
  if (!m) return [];
  const list = m[1].split(/,| and /i).map(s => normaliseAgent(s)).filter(Boolean);
  // also look for typical signature blocks
  const sig = Array.from(text.matchAll(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g)).map(x => x[1]);
  const merged = Array.from(new Set([...list, ...sig])).filter(n => n.split(" ").length >= 2);
  return merged.slice(0, 6);
}

function extractAgencyName(text: string): string {
  const brands = [
    "Barfoot & Thompson", "Ray White", "Bayleys", "Harcourts", "Professionals",
    "LJ Hooker", "Tall Poppy", "Mike Pero", "Sothebys", "Sotheby", "Sotheby's",
    "EVES", "Lodge", "Kowhai Realty"
  ];
  const hit = brands.find(b => new RegExp(b, "i").test(text));
  if (hit) {
    // Branch if present in proximity
    const branch = text.match(new RegExp(`${hit}[^\\n]{0,40}\\(([^)]+)\\)`, "i"))?.[1];
    return branch ? `${hit} (${branch})` : hit;
  }
  return "";
}

async function serperSearch(query: string) {
  if (!SERPER_API_KEY) return { organic: [] as any[] };
  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query }),
  });
  if (!r.ok) return { organic: [] as any[] };
  return r.json();
}

async function findAgentForAddress(browser: any, payload: {
  address: string, sold_price_nzd: number, sold_date: string
}): Promise<AgentHit | null> {
  const { address, sold_price_nzd, sold_date } = payload;
  const queries: string[] = [];
  const quoted = `"${address}"`;

  // Brand-first exact
  const brandDomains = [
    "site:barfoot.co.nz", "site:raywhite.co.nz", "site:bayleys.co.nz", "site:harcourts.co.nz",
    "site:professionals.co.nz", "site:ljhooker.co.nz", "site:tallpoppy.co.nz", "site:mikepero.com",
    "site:sothebysrealty.co.nz"
  ];
  for (const d of brandDomains) queries.push(`${d} ${quoted}`);

  // Portals fallback
  const portals = ["site:oneroof.co.nz", "site:realestate.co.nz", "site:homes.co.nz", "site:ratemyagent.co.nz", "site:trademe.co.nz"];
  for (const d of portals) queries.push(`${d} ${quoted}`);

  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const q of queries.slice(0, MAX_SERPER_PER_ADDR)) {
    const resp = await serperSearch(q);
    const org = (resp as any)?.organic || [];
    for (const o of org) {
      const link: string = o.link;
      if (!link) continue;
      try {
        const u = new URL(link);
        if (REJECT_HOSTS.has(u.host)) continue;
        if (!ALLOWED_FETCH_HOSTS.has(u.host)) continue;
        if (seen.has(link)) continue;
        seen.add(link);
        candidates.push(link);
      } catch { /* ignore */ }
    }
  }

  for (const link of candidates.slice(0, 10)) {
    try {
      const { html } = await fetchHtml(browser, link);
      const t = textOf(html);
      // Address must appear
      if (!new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(t)) continue;

      const agency = extractAgencyName(t);
      const agents = extractAgentsFromText(t);

      const priceTxt = t.match(/\$\s*[\d,]+(?:\.\d{2})?/)?.[0] || "";
      const dateTxt = t.match(/\b\d{1,2}\s+[A-Za-z]+\.?\s+\d{2,4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0] || "";
      const price = grabMoneyInt(priceTxt);
      const iso = parseNZDate(dateTxt);

      // PASS A: address + agency + agent + price≈ + date≈
      if (agency && agents.length && price && iso && withinPct(price, sold_price_nzd) && withinDays(iso, sold_date)) {
        return { agent_names: agents, agency_name: agency, agent_source_url: link };
      }
      // PASS B: address + agency + agent + one of price≈ or date≈ or SOLD marker
      const soldMarker = /(?:SOLD|Sold|Past sale|Sale history)/i.test(t);
      const priceOk = price ? withinPct(price, sold_price_nzd) : false;
      const dateOk = iso ? withinDays(iso, sold_date) : false;
      if (agency && agents.length && (priceOk || dateOk || soldMarker)) {
        return { agent_names: agents, agency_name: agency, agent_source_url: link };
      }
    } catch { /* try next */ }
  }
  return null;
}

// ============ METRIC / AGGREGATION ============
function overCvPct(price: number, cv: number) {
  if (!price || !cv) return 0;
  return Math.round(((price - cv) / cv) * 10000) / 100;
}

type PropertyRow = {
  address: string;
  sold_date_text: string;
  sold_date: string;
  sold_price_text: string;
  sold_price_nzd: number;
  cv_value_text: string;
  cv_value_nzd: number;
  cv_updated: string;
  tm_property_url: string;
  agent_names: string[];
  agency_name: string;
  agent_source_url: string;
  source: "trademe" | "oneroof" | "realestate";
  over_cv_pct: number;
};

function rankAgents(rows: PropertyRow[], minAgentsForRanking: number) {
  const map = new Map<string, {
    agent_name: string, agency_name: string, sales_count: number,
    sum: number, max: number, most_recent_sale_date: string, example_sale_address: string, example_sale_url: string
  }>();

  for (const row of rows) {
    for (const agent of row.agent_names) {
      const key = `${agent.toLowerCase()}||${row.agency_name}`;
      const prev = map.get(key);
      const curr = {
        agent_name: agent,
        agency_name: row.agency_name,
        sales_count: (prev?.sales_count || 0) + 1,
        sum: (prev?.sum || 0) + row.over_cv_pct,
        max: Math.max(prev?.max ?? -Infinity, row.over_cv_pct),
        most_recent_sale_date: [prev?.most_recent_sale_date || "", row.sold_date].sort().slice(-1)[0],
        example_sale_address: prev?.example_sale_address || row.address,
        example_sale_url: prev?.example_sale_url || row.tm_property_url,
      };
      map.set(key, curr);
    }
  }

  const all = Array.from(map.values()).map(x => ({
    agent_name: x.agent_name,
    agency_name: x.agency_name,
    sales_count: x.sales_count,
    avg_over_cv_pct: Math.round((x.sum / x.sales_count) * 100) / 100,
    max_over_cv_pct: x.max,
    most_recent_sale_date: x.most_recent_sale_date,
    example_sale_address: x.example_sale_address,
    example_sale_url: x.example_sale_url,
  }));

  let ranked = all.filter(a => a.sales_count >= minAgentsForRanking);
  if (!ranked.length) ranked = all.filter(a => a.sales_count >= 1);

  ranked.sort((a, b) =>
    b.avg_over_cv_pct - a.avg_over_cv_pct ||
    b.sales_count - a.sales_count ||
    (b.most_recent_sale_date > a.most_recent_sale_date ? 1 : -1)
  );

  return ranked;
}

// ============ ENDPOINTS ============

// Root
app.get("/", (_req, res) => res.json({ ok: true, browsersPath: BROWSERS_PATH }));

// Raw list collector (GET)
app.get("/tm/insights", async (req, res) => {
  const region = (req.query.region as string) || "auckland";
  const suburb = (req.query.suburb as string) || "onehunga";
  const rows = parseInt((req.query.rows as string) || "150", 10);
  const page = parseInt((req.query.page as string) || "1", 10);
  const url = `https://www.trademe.co.nz/a/property/insights/search/${region}/${suburb}?off_market=false&rows=${rows}&page=${page}`;

  try {
    const result = await withBrowser(async ({ browser }) => openListAndCollect(browser, url));
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ url, error: e?.message || String(e), items: [], html: "" });
  }
});

// Raw fetcher (GET/POST)
app.get("/fetch", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).json({ error: "url query param required" });
  try {
    const result = await withBrowser(async ({ browser }) => fetchHtml(browser, raw));
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "bad url" });
  }
});
app.post("/fetch", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const result = await withBrowser(async ({ browser }) => fetchHtml(browser, url));
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "bad url" });
  }
});

// FULL PIPELINE (one-shot prompt as API)
// Body accepts the same knobs you’ve been using.
app.post("/pipeline", async (req, res) => {
  const {
    suburb = "onehunga",
    district = "auckland",
    region = "auckland",
    months_window = 12,
    rows_per_page = 150,
    target_agent_rows = 60,
    min_properties_after_filter = 120,
    min_agents_for_ranking = 2,
    adjacent_suburbs = ["royal oak", "hillsborough", "greenlane", "one tree hill", "mangere bridge"],
    hard_stop_max_sources = 5,
    debug = false,
  } = req.body || {};

  const sourcesTried: { source: string; pages_fetched: number; rows_seen: number; }[] = [];
  const dropCounts: Record<string, number> = {
    no_price: 0, no_cv: 0, parse_fail_date: 0, parse_fail_price: 0,
    outside_window: 0, dup_address: 0, no_url: 0, agent_not_found: 0, agent_page_no_address: 0
  };
  const agentSearchLog: any[] = [];

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months_window);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const seenAddr = new Set<string>();
  const properties: PropertyRow[] = [];
  let pipeline_warning = "";

  const listUrls: string[] = [];
  // Base suburb (region + district fallbacks + adjacent until we meet volume)
  listUrls.push(`https://www.trademe.co.nz/a/property/insights/search/${region}/${suburb}?off_market=false&rows=${rows_per_page}`);
  listUrls.push(`https://www.trademe.co.nz/a/property/insights/search/${district}/${suburb}?off_market=false&rows=${rows_per_page}`);
  listUrls.push(`https://www.trademe.co.nz/a/property/insights/search/${region}/${district}?off_market=false&rows=${rows_per_page}`);
  for (const s of adjacent_suburbs) listUrls.push(`https://www.trademe.co.nz/a/property/insights/search/${region}/${encodeURIComponent(s)}?off_market=false&rows=${rows_per_page}`);

  try {
    await withBrowser(async ({ browser }) => {
      for (const baseUrl of listUrls) {
        if (properties.length >= min_properties_after_filter) break;
        if (sourcesTried.length >= hard_stop_max_sources) break;

        let rowsSeen = 0;
        let pagesFetched = 0;

        for (let page = 1; page <= 3; page++) {
          const url = `${baseUrl}&page=${page}`;
          const { items } = await openListAndCollect(browser, url);
          pagesFetched++;
          rowsSeen += items.length;

          // For each profile, fetch & parse
          for (const profileUrl of items) {
            if (!/^https?:\/\//i.test(profileUrl)) { dropCounts.no_url++; continue; }

            const { html } = await fetchHtml(browser, profileUrl);
            const parsed = parseTmProfile(html, profileUrl);

            // Filters: price + CV + date within window
            if (!parsed.sold_price_nzd) { dropCounts.no_price++; continue; }
            if (!parsed.cv_value_nzd) { dropCounts.no_cv++; continue; }
            if (!parsed.sold_date) { dropCounts.parse_fail_date++; continue; }
            if (parsed.sold_date < cutoffISO) { dropCounts.outside_window++; continue; }

            const key = parsed.address.toLowerCase();
            if (!key) continue;
            if (seenAddr.has(key)) { dropCounts.dup_address++; continue; }
            seenAddr.add(key);

            const row: PropertyRow = {
              address: parsed.address,
              sold_date_text: parsed.sold_date_text,
              sold_date: parsed.sold_date,
              sold_price_text: parsed.sold_price_text || `SOLD: $${parsed.sold_price_nzd.toLocaleString("en-NZ")}`,
              sold_price_nzd: parsed.sold_price_nzd,
              cv_value_text: parsed.cv_value_text || `Capital Value $${parsed.cv_value_nzd.toLocaleString("en-NZ")}`,
              cv_value_nzd: parsed.cv_value_nzd,
              cv_updated: parsed.cv_updated || "",
              tm_property_url: parsed.tm_property_url,
              agent_names: [],
              agency_name: "",
              agent_source_url: "",
              source: parsed.source,
              over_cv_pct: overCvPct(parsed.sold_price_nzd, parsed.cv_value_nzd),
            };

            properties.push(row);
            if (properties.length >= min_properties_after_filter) break;
          }

          if (properties.length >= min_properties_after_filter) break;
        }

        sourcesTried.push({ source: "trademe", pages_fetched: pagesFetched, rows_seen: rowsSeen });
        if (sourcesTried.length >= hard_stop_max_sources) break;
      }

      // Agent attribution — stop when we hit target_agent_rows with agents found
      let withAgents = 0;
      for (const row of properties) {
        if (withAgents >= target_agent_rows) break;
        const hit = await findAgentForAddress(browser, {
          address: row.address,
          sold_price_nzd: row.sold_price_nzd,
          sold_date: row.sold_date,
        });
        if (!hit) {
          dropCounts.agent_not_found++;
          agentSearchLog.push({ address: row.address, status: "not_found" });
          continue;
        }
        // Minimum: the page must contain address (already validated inside)
        if (!hit.agent_source_url) { dropCounts.agent_page_no_address++; continue; }

        row.agent_names = hit.agent_names.slice(0, 3);
        row.agency_name = hit.agency_name;
        row.agent_source_url = hit.agent_source_url;
        withAgents++;
      }
    });
  } catch (e: any) {
    return res.status(500).json({
      agent_rankings: [],
      properties: [],
      pipeline_warning: `pipeline_error: ${e?.message || String(e)}`
    });
  }

  // Ranking
  let minForRank = min_agents_for_ranking;
  let rankings = rankAgents(properties.filter(p => p.agent_names?.length), minForRank);
  if (!rankings.length) {
    minForRank = 1;
    rankings = rankAgents(properties.filter(p => p.agent_names?.length), 1);
    pipeline_warning = pipeline_warning
      ? pipeline_warning + " | threshold_relaxed_to_1_due_to_low_volume"
      : "threshold_relaxed_to_1_due_to_low_volume";
  }

  if (properties.length < min_properties_after_filter) {
    pipeline_warning = pipeline_warning
      ? pipeline_warning + " | hard_stop_max_sources_reached_before_min_properties_after_filter_or_no_qualifying_rows_found"
      : "hard_stop_max_sources_reached_before_min_properties_after_filter_or_no_qualifying_rows_found";
  }

  const payload: any = {
    agent_rankings: rankings,
    properties,
  };
  if (pipeline_warning) payload.pipeline_warning = pipeline_warning;
  if (debug) {
    payload.debug = {
      sources_used: sourcesTried,
      intake_months_used: months_window,
      properties_raw_count: properties.length,
      properties_kept_count: properties.length,
      drop_counts: dropCounts,
      sample_drops: [],
      agent_search_log: agentSearchLog.slice(-10),
    };
  }
  return res.json(payload);
});

// ============ START ============
app.listen(PORT, () => console.log(`Fetcher on :${PORT}`));
