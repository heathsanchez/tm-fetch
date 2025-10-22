import express, { Request, Response } from "express";

const app = express();
app.use(express.json());

const PORT: number = Number(process.env.PORT || 10000);

/**
 * Minimal TM GraphQL client.
 * Paginates a few pages to increase yield.
 */
async function fetchInsights(
  region: string,
  suburb: string,
  rows: number = 150,
  pages: number = 3
) {
  const query = `
    query PropertyInsightsSearch($filters: PropertyInsightsSearchFilters, $rows: Int, $page: Int) {
      propertyInsightsSearch(filters: $filters, rows: $rows, page: $page) {
        results {
          id
          address
          bedrooms
          bathrooms
          carparks
          landAreaSqm
          floorAreaSqm
          salePrice
          saleDate
          agency { name agentName agentPhone }
          profileUrl
        }
      }
    }
  `;

  const headers = {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Origin": "https://www.trademe.co.nz",
    "Referer": "https://www.trademe.co.nz/"
  };

  const all: any[] = [];
  for (let page = 1; page <= pages; page++) {
    const variables = {
      filters: {
        offMarket: false,
        region: region.toLowerCase(),
        suburb: suburb.toLowerCase()
      },
      rows,
      page
    };

    const res = await fetch("https://api.trademe.co.nz/graphql/", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`TM GraphQL ${res.status}: ${txt.slice(0, 400)}`);
    }

    const json = (await res.json()) as any;
    const pageResults: any[] =
      json?.data?.propertyInsightsSearch?.results ?? [];
    if (!Array.isArray(pageResults) || pageResults.length === 0) break;
    all.push(...pageResults);
  }

  return all.map((x) => ({
    id: x.id,
    address: x.address ?? null,
    bedrooms: x.bedrooms ?? null,
    bathrooms: x.bathrooms ?? null,
    carparks: x.carparks ?? null,
    landArea: x.landAreaSqm ?? null,
    floorArea: x.floorAreaSqm ?? null,
    salePrice: x.salePrice ?? null,
    saleDate: x.saleDate ?? null,
    agent: x.agency?.agentName ?? null,
    agency: x.agency?.name ?? null,
    phone: x.agency?.agentPhone ?? null,
    url: x.profileUrl
      ? `https://www.trademe.co.nz/a/property/insights/profile/${x.profileUrl}`
      : null
  }));
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/insights", async (req: Request, res: Response) => {
  try {
    const region = (req.query.region as string) || "auckland";
    const suburb = (req.query.suburb as string) || "";
    const rows = Number(req.query.rows ?? 150);
    const pages = Number(req.query.pages ?? 3);

    if (!suburb) return res.status(400).json({ error: "suburb required" });

    const data = await fetchInsights(region, suburb, rows, pages);
    res.json({ count: data.length, results: data });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "fetch_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Fetcher live on :${PORT}`);
});
