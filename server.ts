import express, { Request, Response } from "express";
import { chromium } from "playwright";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT || 10000);
const BASE = process.env.BASE_PATH || "/tm";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const PW_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/render/.cache/ms-playwright";

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
  $("a[href*='/a/property/insights/profile/'], a[href*='/property/insights/profile/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const fullUrl = href.startsWith("http") ? href : `https://www.trademe.co.nz${href}`;
      urls
