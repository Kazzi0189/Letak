import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/kaufland-detail-probe";

const STORE = {
  chain: "Kaufland",
  storeId: "kaufland-teplice-centrum",
  storeName: "Kaufland Teplice-Centrum",
  storeAddress: "Čs. Dobrovolců 3356, 415 01 Teplice",
  kauflandStoreName: "CZ2450",
  offersUrl: "https://prodejny.kaufland.cz/.kloffers.storeName=CZ2450.json",
  storePage: "https://prodejny.kaufland.cz/aktualne/servis/prodejna/teplice-centrum-2450.html",
  leafletUrl: "https://leaflets.kaufland.com/cz-CZ/CZ_cs_KDZ_2450_CZ20-LFT/ar/2450",
};

const SAMPLE_LIMIT = 15;

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function isJsonText(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function looksLikeUsefulProductText(text) {
  return /price|preis|cena|product|produkt|title|name|article|artikel|offer|image|thumbnail|kč|czk/i.test(text);
}

function preview(text, max = 2000) {
  return text.slice(0, max);
}

function absoluteUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacKauflandKlNrProbe/0.1; +https://github.com/)",
      accept: options.accept ?? "text/html,application/json,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  const text = await response.text();

  return {
    url,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get("content-type") ?? "",
    length: text.length,
    text,
  };
}

async function loadKlNrs() {
  try {
    const raw = JSON.parse(await readFile("data/kaufland-import/kaufland-teplice-raw.json", "utf8"));
    const data = Array.isArray(raw.data) ? raw.data : [];
    return data.map((item) => item.klNr).filter(Boolean).slice(0, SAMPLE_LIMIT);
  } catch {
    const response = await fetchText(STORE.offersUrl, { accept: "application/json,*/*" });
    const data = JSON.parse(response.text);
    return data.map((item) => item.klNr).filter(Boolean).slice(0, SAMPLE_LIMIT);
  }
}

function extractAssetUrls(html, baseUrl) {
  const urls = [];
  const regex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(html))) {
    urls.push(absoluteUrl(match[1].trim(), baseUrl));
  }

  const stringUrlRegex = /["'](https?:\/\/[^"']+)["']/gi;
  while ((match = stringUrlRegex.exec(html))) {
    urls.push(match[1].trim());
  }

  return unique(urls);
}

function extractJsonLikeScriptBlocks(html) {
  const blocks = [];
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = regex.exec(html))) {
    const content = match[1].trim();
    if (
      content.includes("klNr") ||
      content.includes("product") ||
      content.includes("offer") ||
      content.includes("leaflet") ||
      content.includes("__NEXT_DATA__")
    ) {
      blocks.push(content.slice(0, 5000));
    }
  }

  return blocks.slice(0, 20);
}

function findKlNrOccurrences(text, klNrs) {
  return klNrs
    .map((klNr) => {
      const index = text.indexOf(klNr);
      if (index < 0) return null;

      return {
        klNr,
        index,
        context: text.slice(Math.max(0, index - 500), Math.min(text.length, index + 1000)),
      };
    })
    .filter(Boolean);
}

function buildDetailCandidateUrls(klNr) {
  const bases = [
    "https://prodejny.kaufland.cz",
    "https://leaflets.kaufland.com",
    STORE.leafletUrl,
  ];

  const paths = [
    `/.kloffer.${klNr}.json`,
    `/.kloffers.klNr=${klNr}.json`,
    `/.kloffer.klNr=${klNr}.json`,
    `/.kloffers.article=${klNr}.json`,
    `/.kloffers.product=${klNr}.json`,
    `/.klarticle.${klNr}.json`,
    `/.klproduct.${klNr}.json`,
    `/api/products/${klNr}`,
    `/api/offers/${klNr}`,
    `/api/articles/${klNr}`,
    `/products/${klNr}.json`,
    `/offers/${klNr}.json`,
    `/articles/${klNr}.json`,
  ];

  const urls = [];

  for (const base of bases) {
    for (const path of paths) {
      urls.push(absoluteUrl(path, base));
    }
  }

  return unique(urls);
}

async function testDetailEndpoints(klNrs) {
  const results = [];
  const tested = new Set();

  for (const klNr of klNrs.slice(0, 5)) {
    for (const url of buildDetailCandidateUrls(klNr)) {
      if (tested.has(url)) continue;
      tested.add(url);

      try {
        const response = await fetchText(url, { accept: "application/json,text/html,*/*" });
        const isJson = /json/i.test(response.contentType) || isJsonText(response.text);
        const useful = response.ok && (looksLikeUsefulProductText(response.text) || response.text.includes(klNr));

        results.push({
          klNr,
          url,
          ok: response.ok,
          status: response.status,
          finalUrl: response.finalUrl,
          contentType: response.contentType,
          length: response.length,
          isJson,
          useful,
          preview: preview(response.text, 1000),
        });
      } catch (error) {
        results.push({
          klNr,
          url,
          ok: false,
          status: null,
          finalUrl: null,
          contentType: "",
          length: 0,
          isJson: false,
          useful: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const klNrs = await loadKlNrs();

  console.log(`Loaded ${klNrs.length} sample klNr values`);
  console.log(klNrs.join(", "));

  const pagesToInspect = [
    { name: "storePage", url: STORE.storePage },
    { name: "leafletUrl", url: STORE.leafletUrl },
    { name: "offersUrl", url: STORE.offersUrl },
  ];

  const pageResults = [];

  for (const page of pagesToInspect) {
    console.log(`Fetching ${page.name}: ${page.url}`);

    try {
      const response = await fetchText(page.url);
      const occurrences = findKlNrOccurrences(response.text, klNrs);
      const assets = extractAssetUrls(response.text, response.finalUrl);
      const interestingAssets = assets.filter((url) =>
        /json|js|api|product|offer|article|leaflet|catalog|data|pages|page|manifest/i.test(url)
      );

      pageResults.push({
        name: page.name,
        url: page.url,
        ok: response.ok,
        status: response.status,
        finalUrl: response.finalUrl,
        contentType: response.contentType,
        length: response.length,
        occurrences,
        occurrencesCount: occurrences.length,
        interestingAssets: interestingAssets.slice(0, 100),
        scriptBlocks: extractJsonLikeScriptBlocks(response.text),
        preview: preview(response.text, 1500),
      });
    } catch (error) {
      pageResults.push({
        name: page.name,
        url: page.url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const endpointTests = await testDetailEndpoints(klNrs);
  const usefulEndpointTests = endpointTests.filter((item) => item.useful);

  const result = {
    checkedAt: new Date().toISOString(),
    store: STORE,
    sampleKlNrs: klNrs,
    pageResults,
    endpointTests,
    usefulEndpointTests,
    recommendation:
      usefulEndpointTests.length > 0
        ? "Nalezeny kandidátní detail endpointy. Další krok: analyzovat preview usefulEndpointTests."
        : pageResults.some((page) => page.name === "leafletUrl" && page.interestingAssets?.length)
          ? "Detail endpoint zatím nenalezen. Další krok: otevřít zajímavé assety z leaflet vieweru a hledat produktová data tam."
          : "Detail endpoint zatím nenalezen. Další krok: hlubší analýza JS assetů nebo obrázkového vieweru.",
  };

  await writeFile(`${OUTPUT_DIR}/kaufland-klnr-detail-probe.json`, JSON.stringify(result, null, 2) + "\n", "utf8");

  const summary = {
    checkedAt: result.checkedAt,
    store: STORE,
    sampleKlNrs: klNrs,
    pageSummary: pageResults.map((page) => ({
      name: page.name,
      ok: page.ok,
      status: page.status,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      length: page.length,
      occurrencesCount: page.occurrencesCount ?? 0,
      interestingAssetsCount: page.interestingAssets?.length ?? 0,
      firstInterestingAssets: page.interestingAssets?.slice(0, 20) ?? [],
    })),
    endpointTestsCount: endpointTests.length,
    usefulEndpointTestsCount: usefulEndpointTests.length,
    usefulEndpointTests: usefulEndpointTests.slice(0, 20).map((item) => ({
      klNr: item.klNr,
      url: item.url,
      status: item.status,
      contentType: item.contentType,
      length: item.length,
      isJson: item.isJson,
    })),
    recommendation: result.recommendation,
  };

  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(`Endpoint tests: ${endpointTests.length}`);
  console.log(`Useful endpoint tests: ${usefulEndpointTests.length}`);
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
