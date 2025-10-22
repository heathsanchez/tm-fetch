import express, { Request, Response } from "express";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 10000);
const BASE = process.env.BASE_PATH || "/tm";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type PropRow = {
  address: string | null;
  sold_date_text: string | null;
  sold_date: string | null;
  sold_price_text: string | null;
  sold_price_nzd: number | null;
  cv_value_text: string | null;
  cv_value_nzd: number | null;
  cv_updated: string | null;
  tm_property_url: string;
  source: "trademe";
};

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

function parseNZDate(text: string): string | null {
  // Accept: "Sold on 15 Oct 2025", "Last sold on 5 Sept 2025", "Sold 01/09/2025"
  const t = text.replace(/,/g, " ").replace(/\s+/g, " ").trim();

  // D/M/YYYY
  const dmy = t.match(/(\b\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3].length === 2 ? ("20" + dmy[3]) : dmy[3]);
    if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d
        .toString()
        .padStart(2, "0")}`;
    }
  }

  // "15 Oct 2025" / "5 Sept 2025"
  const wd = t.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/);
  if (wd) {
    const d = Number(wd[1]);
    const m = monthToNum(wd[2]);
    const y = Number(wd[3]);
    if (m && y >= 1900 && d >= 1 && d <= 31) {
      return `${y}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
    }
  }
  return null;
}

function parseMoneyNZD(text: string): number | null {
  // Handles $1,875,000 or $1.65M style (converts to int)
  const t = text.replace(/\s/g, "");
  const m1 = t.match(/\$?([\d,]+)(?:\.\d+)?/);
  const m2 = t.match(/\$?([\d.]+)\s*[mMkK]\b/);

  if (m2) {
    const val = parseFloat(m2[1]);
    if (!isNaN(val)) {
      const mult = /m/i.test(t) ? 1_000_000 : 1_000;
      return Math.round(val * mult);
    }
  }
  if (m1) {
    const val = Number(m1[1].replace(/,/g, ""));
    if (!isNaN(val)) return val;
  }
  return null;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" }
  });
  if (!res.ok) throw new Error(`GET ${url} => ${res.status}`);
  return await res.text();
}

function withinMonths(isoDate: string | null, months: number): boolean {
  if (!isoDate) return false;
  const d = new Date(isoDate + "T12:00:00+13:00"); // NZT safe-ish
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(now.getMonth() - months);
  return d >= cutoff && d <= now;
}

async function parsePropertyPage(url: string): Promise<PropRow | null> {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const text = $.root().text().replace(/\s+/g, " ").trim();

  // Address: try page h1, fallback from meta tags or breadcrumb
  const h1 = $("h1, h2").first().text().trim() || "";
  const address =
    h1 ||
    $('meta[property="og:title"]').attr("content") ||
    ($('meta[name="twitter:title"]').attr("content") || "").trim() ||
    null;

  // Sold date text
  const soldMatch =
    text.match(/\b(Sold|Last sold|Auctioned)\s*(on)?\s*\b(\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  const sold_date_text = soldMatch ? soldMatch[0] : null;
  const sold_date = sold_date_text ? parseNZDate(sold_date_text) : null;

  // Sold price text
  const priceChunk =
    (text.match(/\b(Sold for|Sold price|Price|SOLD:)\s*\$[\d,\.]+(?:\s*[mMkK])?/i)?.[0]) ||
    (text.match(/\$\s*[\d,\.]+\s*(m|k)?\b\s*(sold|price)/i)?.[0]) ||
    null;
  const sold_price_text = priceChunk;
  const sold_price_nzd = priceChunk ? parseMoneyNZD(priceChunk) : null;

  // Capital value + update
  let cv_value_text: string | null = null;
  let cv_updated: string | null = null;
  // Look for "Capital value" / "CV" / "Rateable value" / "RV"
  const cvBlock =
    text.match(/(Capital value|CV|Rateable value|RV)[^$]{0,80}\$[0-9,\.mMkK]+/i)?.[0] || null;
  if (cvBlock) {
    cv_value_text = cvBlock;
  } else {
    // Try more generous capture
    const cvLoose = text.match(/\b(Capital value|Rateable value|CV|RV)\b.*?\$[0-9,\.mMkK]+/i)?.[0] || null;
    if (cvLoose) cv_value_text = cvLoose;
  }
  // Updated date (e.g., "Updated: 01 May 2024")
  const updatedMatch = text.match(/Updated:\s*\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}/i);
  cv_updated = updatedMatch ? updatedMatch[0].replace(/Updated:\s*/i, "").trim() : null;

  const cv_value_nzd = cv_value_text ? parseMoneyNZD(cv_value_text) : null;

  // Must have both price and CV to be useful
  if (!sold_price_nzd || !cv_value_nzd) return null;

  return {
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
}

async function parseSearchList(url: string, limit = 150): Promise<string[]> {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const links = new Set<string>();
  $('a[href*="/a/property/insights/profile/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    // Make absolute
    const abs = href.startsWith("http")
      ? href
      : `https://www.trademe.co.nz${href}`;
    // Only keep property profile pages
    if (/\/a\/property\/insights\/profile\//.test(abs)) {
      links.add(abs);
    }
  });

  return Array.from(links).slice(0, limit);
}

function buildSearchUrls(region: string, suburb: string, district?: string, rows = 150) {
  const urls: string[] = [];
  // Region/Suburb
  urls.push(`https://www.trademe.co.nz/a/property/insights/search/${encodeURIComponent(region)}/${encodeURIComponent(suburb)}?off_market=false&rows=${rows}`);
  // District/Suburb (fallback)
  if (district) {
    urls.push(`https://www.trademe.co.nz/a/property/insights/search/${encodeURIComponent(district)}/${encodeURIComponent(suburb)}?off_market=false&rows=${rows}`);
  }
  // Region/District (broad)
  if (district) {
    urls.push(`https://www.trademe.co.nz/a/property/insights/search/${encodeURIComponent(region)}/${encodeURIComponent(district)}?off_market=false&rows=${rows}`);
  }
  return urls;
}

app.get(`${BASE}/health`, (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get(`${BASE}/insights`, async (req: Request, res: Response) => {
  try {
    const region = String(req.query.region || "auckland");
    const suburb = String(req.query.suburb || "");
    const district = req.query.district ? String(req.query.district) : region;
    const rows = Number(req.query.rows ?? 150);
    const months = Number(req.query.months_window ?? 12);

    if (!suburb) return res.status(400).json({ error: "suburb required" });

    const searchUrls = buildSearchUrls(region, suburb, district, rows);

    const seen = new Set<string>();
    const propertyUrls: string[] = [];
    for (const u of searchUrls) {
      try {
        const urls = await parseSearchList(u, rows);
        for (const p of urls) {
          if (!seen.has(p)) {
            seen.add(p);
            propertyUrls.push(p);
          }
        }
      } catch {
        // continue to next source
      }
    }

    const out: PropRow[] = [];
    for (const purl of propertyUrls) {
      try {
        const row = await parsePropertyPage(purl);
        if (!row) continue;
        // filter by months window
        if (row.sold_date && withinMonths(row.sold_date, months)) {
          out.push(row);
        }
      } catch {
        // ignore individual failures
      }
    }

    res.json({
      count: out.length,
      results: out
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "failed" });
  }
});

// Back-compat root routes
app.get("/insights", (req, res) => {
  req.url = `${BASE}/insights${req.url.includes("?") ? "&" : "?"}__=1`;
  app.handle(req, res);
});
app.get("/health", (req, res) => {
  req.url = `${BASE}/health`;
  app.handle(req, res);
});

// 404 JSON
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

app.listen(PORT, () => {
  console.log(`Fetcher live on :${PORT} (base: ${BASE})`);
});
