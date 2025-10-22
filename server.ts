import express from "express";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get("/health", (_req, res) => res.json({ ok: true }));

async function fetchInsights(region: string, suburb: string, rows = 150) {
  const query = `
    query PropertyInsightsSearch($filters: PropertyInsightsSearchFilters, $rows: Int, $page: Int) {
      propertyInsightsSearch(filters: $filters, rows: $rows, page: $page) {
        results {
          id
          title
          address
          bedrooms
          bathrooms
          carparks
          landAreaSqm
          floorAreaSqm
          salePrice
          saleDate
          agency {
            name
            agentName
            agentPhone
          }
          profileUrl
        }
      }
    }
  `;

  const variables = {
    filters: {
      offMarket: false,
      region: region.toLowerCase(),
      suburb: suburb.toLowerCase(),
    },
    rows,
    page: 1,
  };

  const res = await fetch("https://api.trademe.co.nz/graphql/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Origin: "https://www.trademe.co.nz",
      Referer: "https://www.trademe.co.nz/",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  const data = json?.data?.propertyInsightsSearch?.results || [];

  return data.map((x: any) => ({
    id: x.id,
    address: x.address,
    bedrooms: x.bedrooms,
    bathrooms: x.bathrooms,
    carparks: x.carparks,
    landArea: x.landAreaSqm,
    floorArea: x.floorAreaSqm,
    salePrice: x.salePrice,
    saleDate: x.saleDate,
    agent: x.agency?.agentName || null,
    agency: x.agency?.name || null,
    phone: x.agency?.agentPhone || null,
    url: x.profileUrl
      ? `https://www.trademe.co.nz/a/property/insights/profile/${x.profileUrl}`
      : null,
  }));
}

app.get("/insights", async (req, res) => {
  try {
    const suburb = (req.query.suburb as string) || "";
    const region = (req.query.region as string) || "auckland";
    if (!suburb) return res.status(400).json({ error: "suburb required" });

    const results = await fetchInsights(region, suburb);
    res.json({ count: results.length, results });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Fetcher live on :${PORT}`));
