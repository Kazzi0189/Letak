import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/kaufland-probe";

const STORE = {
  chain: "Kaufland",
  storeNameHuman: "Kaufland Teplice-Centrum",
  address: "Čs. Dobrovolců 3356, 415 01 Teplice",
  officialStorePage: "https://prodejny.kaufland.cz/aktualne/servis/prodejna/teplice-centrum-2450.html",
  genericLeafletPage: "https://prodejny.kaufland.cz/letak.html",
  storeNameCandidates: ["cz5810", "teplice-centrum-2450", "2450", "teplice-centrum"],
};

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function textLines(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
  )
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = regex.exec(html))) {
    links.push({
      href: absoluteUrl(decodeHtml(match[1].trim()), baseUrl),
      text: decodeHtml(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    });
  }

  return links;
}

function extractHints(html, baseUrl) {
  const storeNameHints = unique(
    Array.from(
      html.matchAll(/(?:storeName|storename|store-name|storeId|storeID|market|branch|filiale|store)\s*[:=]\s*["']?([a-z0-9_-]{2,80})/gi)
    ).map((match) => match[1])
  );

  const endpointHints = unique(
    Array.from(
      html.matchAll(/["']([^"']*(?:kloffers|klxtra|offer|offers|leaflet|letak|filiale|storeName|store)[^"']*)["']/gi)
    )
      .map((match) => match[1])
      .filter((value) => value.length < 300)
      .map((value) => (value.startsWith("/") ? absoluteUrl(value, baseUrl) : value))
  );

  const leafletLinks = extractLinks(html, baseUrl).filter((item) => {
    const haystack = `${item.href} ${item.text}`.toLowerCase();
    return (
      haystack.includes("leaflets.kaufland") ||
      haystack.includes("letak") ||
      haystack.includes("leták") ||
      haystack.includes("prolistovat")
    );
  });

  return {
    storeNameHints,
    endpointHints: endpointHints.slice(0, 100),
    leafletLinks: leafletLinks.slice(0, 80),
  };
}

function buildEndpointCandidates(storeName) {
  return [
    `https://prodejny.kaufland.cz/.kloffers.storeName=${storeName}.json`,
    `https://prodejny.kaufland.cz/.klxtraproducts.json`,
    `https://prodejny.kaufland.cz/.klxtraproductscategory.json`,
    `https://prodejny.kaufland.cz/.klxtraproductslegacy.json`,
    `https://prodejny.kaufland.cz/aktualne/servis/prodejna/teplice-centrum-2450.html/.kloffers.storeName=${storeName}.json`,
    `https://prodejny.kaufland.cz/letak.html/.kloffers.storeName=${storeName}.json`,
  ];
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacKauflandProbe/0.1; +https://github.com/)",
      accept: "text/html,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  return {
    url,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    contentType,
    length: text.length,
    text,
  };
}

function previewText(text, maxLength = 1200) {
  return text.slice(0, maxLength);
}

function looksLikeUsefulJson(text) {
  if (!text || text.length < 20) return false;
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  return /price|name|title|product|offer|leaflet|valid|category|article|image/i.test(trimmed);
}

async function testEndpoints(storeNameCandidates) {
  const results = [];
  const testedUrls = new Set();

  for (const storeName of storeNameCandidates) {
    for (const url of buildEndpointCandidates(storeName)) {
      if (testedUrls.has(url)) continue;
      testedUrls.add(url);

      try {
        const response = await fetchText(url);
        const trimmed = response.text.trim();
        const isJson =
          /json/i.test(response.contentType) || trimmed.startsWith("{") || trimmed.startsWith("[");
        const usefulJson = isJson && looksLikeUsefulJson(response.text);

        results.push({
          storeName,
          url,
          ok: response.ok,
          status: response.status,
          finalUrl: response.finalUrl,
          contentType: response.contentType,
          length: response.length,
          isJson,
          usefulJson,
          preview: previewText(response.text),
        });
      } catch (error) {
        results.push({
          storeName,
          url,
          ok: false,
          status: null,
          finalUrl: null,
          contentType: null,
          length: 0,
          isJson: false,
          usefulJson: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`Probing ${STORE.storeNameHuman}`);
  console.log(STORE.address);

  const storePage = await fetchText(STORE.officialStorePage);
  const genericLeafletPage = await fetchText(STORE.genericLeafletPage);

  const storePageHints = storePage.ok ? extractHints(storePage.text, storePage.finalUrl) : null;
  const genericHints = genericLeafletPage.ok ? extractHints(genericLeafletPage.text, genericLeafletPage.finalUrl) : null;

  const extraStoreNames = unique([
    ...STORE.storeNameCandidates,
    ...(storePageHints?.storeNameHints ?? []),
    ...(genericHints?.storeNameHints ?? []),
  ]);

  const endpointTests = await testEndpoints(extraStoreNames);
  const usefulEndpoints = endpointTests.filter((item) => item.usefulJson || (item.ok && item.length > 1000));

  const result = {
    checkedAt: new Date().toISOString(),
    store: STORE,
    derivedStoreNameCandidates: extraStoreNames,
    pages: {
      officialStorePage: {
        url: STORE.officialStorePage,
        ok: storePage.ok,
        status: storePage.status,
        finalUrl: storePage.finalUrl,
        contentType: storePage.contentType,
        length: storePage.length,
        hints: storePageHints,
        sampleTextLines: storePage.ok ? textLines(storePage.text).slice(0, 120) : [],
      },
      genericLeafletPage: {
        url: STORE.genericLeafletPage,
        ok: genericLeafletPage.ok,
        status: genericLeafletPage.status,
        finalUrl: genericLeafletPage.finalUrl,
        contentType: genericLeafletPage.contentType,
        length: genericLeafletPage.length,
        hints: genericHints,
        sampleTextLines: genericLeafletPage.ok ? textLines(genericLeafletPage.text).slice(0, 120) : [],
      },
    },
    endpointTests,
    usefulEndpoints,
    recommendation: {
      nextStep:
        usefulEndpoints.length > 0
          ? "Prověřit usefulEndpoints a zkusit z nich postavit první Kaufland import pro tuto pobočku."
          : "Endpointy zatím nevrátily jasná data. Další krok je otevřít leafletLinks a hledat data přímo ve vieweru.",
    },
  };

  await writeFile(`${OUTPUT_DIR}/teplice-centrum.json`, JSON.stringify(result, null, 2) + "\n", "utf8");

  const summary = {
    checkedAt: result.checkedAt,
    store: STORE,
    derivedStoreNameCandidates: extraStoreNames,
    officialStorePageOk: storePage.ok,
    genericLeafletPageOk: genericLeafletPage.ok,
    leafletLinksFromStorePage: storePageHints?.leafletLinks ?? [],
    leafletLinksFromGenericPage: genericHints?.leafletLinks ?? [],
    endpointTestsCount: endpointTests.length,
    usefulEndpointsCount: usefulEndpoints.length,
    usefulEndpoints: usefulEndpoints.map((item) => ({
      storeName: item.storeName,
      url: item.url,
      status: item.status,
      contentType: item.contentType,
      length: item.length,
      usefulJson: item.usefulJson,
    })),
    recommendation: result.recommendation,
  };

  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(`Endpoint tests: ${endpointTests.length}`);
  console.log(`Useful endpoints: ${usefulEndpoints.length}`);
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
