import express, { Request, Response } from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT || 10000);
const BASE = process.env.BASE_PATH || "/tm";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// ---------- helpers ----------
async function fetchHtml(url: string, debugBag?: any): Promise<string> {
  const isDev = process.argv.includes('--dev');
  if (isDev) console.log(`[${new Date().toISOString()}] Fetching HTML from ${url}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-NZ,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Site": "none",
      "Referer": "https://www.trademe.co.nz/"
    }
  });
  if (debugBag) debugBag.http = { status: res.status, ok: res.ok, url };
  if (!res.ok) throw new Error(`GET ${url} => ${res.status}`);
  const text = await res.text();
  if (debugBag) debugBag.htmlLen = text.length;
  if (isDev) console.log(`[${new Date().toISOString()}] Fetched ${text.length} bytes from ${url}`);
  return text;
}

function extractProfileUrlsFromHtml(html: string, debugList?: any): string[] {
  const urls = new Set<string>();
  const $ = cheerio.load(html);
  $("a[href*='/a/property/insights/profile/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const fullUrl = href.startsWith("http") ? href : `https://www.trademe.co.nz${href}`;
      urls.add(fullUrl);
    }
  });
  $("script").each((_, s) => {
    const txt = ($(s).html() || "").toString();
    if (!txt) return;
    for (const m of txt.matchAll(/"href":"(\/a\/property\/insights\/profile\/[^"]+)"/g)) {
      urls.add(`https://www.trademe.co.nz${m[1]}`);
    }
    for (const m of txt.matchAll(/https?:\\\/\\\/www\.trademe\.co\.nz\\\/a\\\/property\\\/insights\\\/profile\\\/[^"\\]+/g)) {
      const fixed = m[0].replace(/\\\//g, "/");
      urls.add(fixed);
    }
  });
  const arr = Array.from(urls);
  if (debugList) debugList.extractedCount = arr.length;
  return arr;
}

async function fetchPropertyData(url: string, debugProp?: any): Promise<any | null> {
  const isDev = process.argv.includes('--dev');
  try {
    const html = await fetchHtml(url, debugProp);
    const $ = cheerio.load(html);
    const text = $.root().text().replace(/\s+/g, " ").trim();
    const address =
      $("h1, h2").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      ($('meta[name="twitter:title"]').attr("content") || "").trim() ||
      null;
    const soldMatch =
      text.match(/\b(Sold|Last sold|Auctioned)\s*(on)?\s*\b(\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    const sold_date_text = soldMatch ? soldMatch[0] : null;
    const sold_date = sold_date_text ? parseNZDate(sold_date_text) : null;
    const priceChunk =
      (text.match(/\b(Sold for|Sold price|Price|SOLD:)\s*\$[\d,\.]+(?:\s*[mMkK])?/i)?.[0]) ||
      (text.match(/\$\s*[\d,\.]+\s*(m|k)?\b\s*(sold|price)/i)?.[0]) ||
      null;
    const sold_price_text = priceChunk;
    const sold_price_nzd = priceChunk ? parseMoneyNZD(priceChunk) : null;
    let cv_value_text: string | null = null;
    let cv_updated: string | null = null;
    const cvBlock =
      text.match(/(Capital value|CV|Rateable value|RV)[^$]{0,160}\$[0-9,\.mMkK]+/i)?.[0] || null;
    if (cvBlock) cv_value_text = cvBlock;
    else {
      const cvLoose = text.match(/\b(Capital value|Rateable value|CV|RV)\b.*?\$[0-9,\.mMkK]+/i)?.[0] || null;
      if (cvLoose) cv_value_text = cvLoose;
    }
    const updatedMatch = text.match(/Updated:\s*\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}/i);
    cv_updated = updatedMatch ? updatedMatch[0].replace(/Updated:\s*/i, "").trim() : null;
    const cv_value_nzd = cv_value_text ? parseMoneyNZD(cv_value_text) : null;
    if (!sold_price_nzd || !cv_value_nzd) {
      if (isDev) console.log(`[${new Date().toISOString()}] Skipped ${url}: missing sold_price_nzd or cv_value_nzd`);
      return null;
    }
    const row = {
      address,
      sold_date_text,
      sold_date,
      sold_price_text,
      sold_price_nzd,
      cv_value_text,
      cv_value_nzd,
      cv_updated,
      tm_property_url: url,
      source: "trademe"
    };
    if (isDev) console.log(`[${new Date().toISOString()}] Parsed ${url}: ${JSON.stringify(row)}`);
    return row;
  } catch (e: any) {
    if (isDev) console.error(`[${new Date().toISOString()}] parsePropertyPage failed for ${url}: ${e.message}`);
    return null;
  }
}

function parseNZDate(text: string): string | null {
  const t = text.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const dmy = t.match(/(\b\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3].length === 2 ? ("20" + dmy[3]) : dmy[3]);
    if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)
      return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d
        .toString()
        .padStart(2, "0")}`;
  }
  const wd = t.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/);
  if (wd) {
    const d = Number(wd[1]);
    const m = monthToNum(wd[2]);
    const y = Number(wd[3]);
    if (m && y >= 1900 && d >= 1 && d <= 31)
      return `${y}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  }
  return null;
}

function monthToNum(m: string): number | null {
  const t = m.toLowerCase();
  const map: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };
  return map[t] ?? null;
}

function parseMoneyNZD(text: string): number | null {
  const t = text.replace(/\s/g, "");
  const m2 = t.match(/\$?([\d.]+)\s*[mMkK]\b/);
  if (m2) {
    const val = parseFloat(m2[1]);
    if (!isNaN(val)) {
      const mult = /m/i.test(t) ? 1_000_000 : 1_000;
      return Math.round(val * mult);
    }
  }
  const m1 = t.match(/\$?([\d,]+)(?:\.\d+)?/);
  if (m1) {
    const val = Number(m1[1].replace(/,/g, ""));
    if (!isNaN(val)) return val;
  }
  return null;
}

function withinMonths(isoDate: string | null, months: number): boolean {
  if (!isoDate) return false;
  const d = new Date(isoDate + "T12:00:00+13:00");
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(now.getMonth() - months);
  return d >= cutoff && d <= now;
}

function buildSearchUrls(region: string, suburb: string, district?: string, rows = 150, pages = 3): string[] {
  const isTest = process.argv.includes('--test');
  const bases = new Set<string>();
  bases.add(`https://www.trademe.co.nz/a/property/insights/search/${encodeURIComponent(region)}/${encodeURIComponent(suburb)}?off_market=false&rows=${rows}`);
  if (district && !isTest) {
    bases.add(`https://www.trademe.co.nz/a/property/insights/search/${encodeURIComponent(district)}/${encodeURIComponent(suburb)}?off_market=false&rows=${rows}`);
    bases.add(`https://www.trademe.co.nz/a/property/insights/search/${encodeURIComponent(region)}/${encodeURIComponent(district)}?off_market=false&rows=${rows}`);
  }
  const withPages: string[] = [];
  for (const b of bases) for (let p = 1; p <= (isTest ? 1 : pages); p++) withPages.push(`${b}&page=${p}`);
  return withPages;
}

// ---------- routes ----------
app.get(`${BASE}/health`, (_req, res) =>
  res.json({ ok: true, ua: UA })
);

app.get(`/health`, (_req, res) =>
  res.json({ ok: true, ua: UA })
);

app.get([`${BASE}/insights`, `/insights`], async (req: Request, res: Response) => {
  const debug = String(req.query.debug || "") === "1";
  const region = String(req.query.region || "auckland");
  const suburb = String(req.query.suburb || "");
  const district = String(req.query.district || region);
  const rows = Number(req.query.rows || 150);
  const pages = process.argv.includes('--test') ? 1 : Number(req.query.pages || 3);
  const months = Number(req.query.months_window || 12);
  if (!suburb) return res.status(400).json({ error: "suburb required" });
  const isDev = process.argv.includes('--dev');
  const searchUrls = buildSearchUrls(region, suburb, district, rows, pages);
  if (isDev) console.log(`[${new Date().toISOString()}] Fetching ${searchUrls.length} search URLs: ${JSON.stringify(searchUrls)}`);
  const listsDbg: any[] = [];
  const seen = new Set<string>();
  const propertyUrls: string[] = [];
  for (const u of searchUrls) {
    const ldbg: any = { url: u };
    try {
      const html = await fetchHtml(u, ldbg);
      const urls = extractProfileUrlsFromHtml(html, ldbg);
      listsDbg.push(ldbg);
      for (const p of urls) if (!seen.has(p)) { seen.add(p); propertyUrls.push(p); }
      if (isDev) console.log(`[${new Date().toISOString()}] Extracted ${urls.length} URLs from ${u}`);
    } catch (e: any) {
      ldbg.error = e.message;
      listsDbg.push(ldbg);
      if (isDev) console.error(`[${new Date().toISOString()}] Failed to fetch ${u}: ${e.message}`);
    }
  }
  const out: any[] = [];
  const propsDbg: any[] = [];
  for (const purl of propertyUrls) {
    const pdbg: any = { url: purl };
    const row = await fetchPropertyData(purl, pdbg);
    propsDbg.push(pdbg);
    if (row && row.sold_date && withinMonths(row.sold_date, months)) out.push(row);
    if (isDev) console.log(`[${new Date().toISOString()}] Processed ${purl}: ${row ? 'success' : 'failed'}`);
  }
  const payload: any = { count: out.length, results: out };
  if (debug) payload.debug = { searchUrls, lists: listsDbg, propertyUrlsCount: propertyUrls.length, properties: propsDbg };
  res.json(payload);
});

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

app.listen(PORT, () => {
  console.log(`Fetcher running on port ${PORT} base=${BASE}`);
});
