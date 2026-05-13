import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

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

const OUTPUT_DIR = "data/kaufland-html-import";
const RAW_HTML_DIR = `${OUTPUT_DIR}/raw-html`;
const OFFERS_FILE = `${OUTPUT_DIR}/kaufland-teplice-offers.json`;
const DEBUG_FILE = `${OUTPUT_DIR}/kaufland-teplice-debug.json`;
const COMBINED_OFFERS_FILE = "data/offers-kaufland-teplice.json";

function decodeHtml(value = "") {
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

function cleanText(value = "") {
  return decodeHtml(value)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(decodeHtml(href), baseUrl).toString();
  } catch {
    return decodeHtml(href);
  }
}

function uniqueBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}

function toNumber(value) {
  if (value == null) return null;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");

  if (!/\d/.test(normalized)) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function makeId(klNr, product, price) {
  return (
    "kaufland-teplice-" +
    createHash("sha1")
      .update(`${klNr}|${product}|${price}`)
      .digest("hex")
      .slice(0, 16)
  );
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacKauflandHtmlImport/0.3; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 300)}`);
  }

  return {
    url,
    finalUrl: response.url,
    contentType: response.headers.get("content-type") ?? "",
    length: text.length,
    text,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacKauflandHtmlImport/0.3; +https://github.com/)",
      accept: "application/json,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text);
}

function extractCategoryLinks(html, baseUrl) {
  const links = [];
  const regex = /href\s*=\s*["']([^"']*\/nabidka\/prehled\.html\?[^"']*kloffer-category=[^"']+)["']/gi;
  let match;

  while ((match = regex.exec(html))) {
    const url = absoluteUrl(match[1], baseUrl).replace(/&amp;/g, "&");

    try {
      const parsed = new URL(url);
      parsed.searchParams.set("kloffer-week", parsed.searchParams.get("kloffer-week") || "current");
      parsed.searchParams.delete("kloffer-articleID");
      links.push(parsed.toString());
    } catch {
      links.push(url);
    }
  }

  return uniqueBy(links, (url) => url)
    .filter((url) => url.includes("kloffer-category="))
    .slice(0, 20);
}

function categoryNameFromUrl(url) {
  try {
    const parsed = new URL(url.replace(/&amp;/g, "&"));
    const raw = parsed.searchParams.get("kloffer-category") ?? "";
    return decodeURIComponent(raw)
      .replace(/^\d+_?/, "")
      .replace(/__/g, " / ")
      .replace(/_/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function extractAttr(fragment, attr) {
  const regex = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i");
  const match = fragment.match(regex);
  return match ? decodeHtml(match[1]) : "";
}

function extractFirst(fragment, regex) {
  const match = fragment.match(regex);
  return match ? cleanText(match[1]) : "";
}

function findAnchorStart(html, index) {
  const start = html.lastIndexOf("<a ", index);
  if (start < 0) return -1;

  // Bezpečnost: produktová dlaždice nemá být obrovský blok.
  if (index - start > 3000) return -1;

  return start;
}

function findAnchorEnd(html, start) {
  const end = html.indexOf("</a>", start);
  if (end < 0) return -1;

  if (end - start > 10000) return -1;

  return end + "</a>".length;
}

function parseProductTiles(html, pageUrl, validByKlNr, pageCategory = "") {
  const offers = [];
  const articleRegex = /kloffer-articleID=([0-9]+)/gi;

  let match;
  while ((match = articleRegex.exec(html))) {
    const klNr = match[1];

    const start = findAnchorStart(html, match.index);
    if (start < 0) continue;

    const end = findAnchorEnd(html, start);
    if (end < 0) continue;

    const tile = html.slice(start, end);

    // Důležité: vyříznutá dlaždice musí obsahovat právě tento articleID, jinak ji přeskočíme.
    if (!tile.includes(`kloffer-articleID=${klNr}`)) continue;

    const hrefMatch = tile.match(/href\s*=\s*["']([^"']*kloffer-articleID=[^"']*)["']/i);
    const href = hrefMatch ? absoluteUrl(hrefMatch[1], pageUrl).replace(/&amp;/g, "&") : pageUrl;

    const imageTag =
      tile.match(/<img\b[^>]*(?:k-product-tile__main-image|data-image-fallback|alt=)[^>]*>/i)?.[0] ??
      tile.match(/<img\b[^>]*>/i)?.[0] ??
      "";

    const product =
      cleanText(extractAttr(imageTag, "alt")) ||
      cleanText(extractAttr(imageTag, "title")) ||
      extractFirst(tile, /<[^>]*class=["'][^"']*(?:product|tile).*?(?:title|name)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);

    const priceText = extractFirst(tile, /<div[^>]*class=["'][^"']*k-price-tag__price[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const oldPriceText = extractFirst(tile, /<span[^>]*class=["'][^"']*k-price-tag__old-price-line-through[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const discountText = extractFirst(tile, /<div[^>]*class=["'][^"']*k-price-tag__discount[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

    const price = toNumber(priceText);
    const oldPrice = toNumber(oldPriceText);
    const imageUrl = absoluteUrl(extractAttr(imageTag, "src"), pageUrl);
    const category = categoryNameFromUrl(href) || pageCategory;
    const valid = validByKlNr.get(klNr) ?? {};

    if (!klNr || !product || price == null) continue;

    offers.push({
      id: makeId(klNr, product, price),
      storeId: STORE.storeId,
      chain: STORE.chain,
      storeName: STORE.storeName,
      storeAddress: STORE.storeAddress,
      sourceStoreName: STORE.kauflandStoreName,
      product,
      brand: "",
      packageSize: "",
      price,
      oldPrice,
      unitPrice: price,
      unit: "Kč/ks",
      category,
      validFrom: valid.dateFrom ?? "",
      validTo: valid.dateTo ?? "",
      priceType: discountText || "akční cena",
      klNr,
      imageUrl,
      sourceUrl: href,
      leafletUrl: STORE.leafletUrl,
    });
  }

  return uniqueBy(offers, (offer) => offer.klNr);
}

function pageDiagnostics(html) {
  const articleMatches = Array.from(html.matchAll(/kloffer-articleID=([0-9]+)/gi)).map((m) => m[1]);
  const tileClassCount = (html.match(/k-product-tile/gi) || []).length;
  const priceTagCount = (html.match(/k-price-tag__price/gi) || []).length;
  const imgAltCount = (html.match(/<img\b[^>]*alt=/gi) || []).length;

  const firstArticleIndex = html.search(/kloffer-articleID=[0-9]+/i);
  const firstArticleContext =
    firstArticleIndex >= 0
      ? html.slice(Math.max(0, firstArticleIndex - 700), Math.min(html.length, firstArticleIndex + 1500))
      : "";

  return {
    articleIdOccurrencesCount: articleMatches.length,
    uniqueArticleIdOccurrencesCount: new Set(articleMatches).size,
    firstArticleIds: Array.from(new Set(articleMatches)).slice(0, 20),
    tileClassCount,
    priceTagCount,
    imgAltCount,
    firstArticleContext: firstArticleContext.slice(0, 2500),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(RAW_HTML_DIR, { recursive: true });

  const rawIndex = await fetchJson(STORE.offersUrl);
  const validByKlNr = new Map(
    rawIndex.map((item) => [
      item.klNr,
      {
        dateFrom: item.dateFrom,
        dateTo: item.dateTo,
      },
    ])
  );

  const storePage = await fetchText(STORE.storePage);
  const categoryLinks = extractCategoryLinks(storePage.text, storePage.finalUrl);

  const pages = [
    {
      type: "storePage",
      url: storePage.finalUrl,
      text: storePage.text,
      length: storePage.length,
      category: "",
    },
  ];

  let categoryIndex = 0;
  for (const url of categoryLinks) {
    categoryIndex += 1;

    try {
      const page = await fetchText(url);
      pages.push({
        type: "category",
        url: page.finalUrl,
        text: page.text,
        length: page.length,
        category: categoryNameFromUrl(url),
      });

      await writeFile(`${RAW_HTML_DIR}/category-${String(categoryIndex).padStart(2, "0")}.html`, page.text, "utf8");
    } catch (error) {
      pages.push({
        type: "category",
        url,
        error: error instanceof Error ? error.message : String(error),
        category: categoryNameFromUrl(url),
      });
    }
  }

  await writeFile(`${RAW_HTML_DIR}/store-page.html`, storePage.text, "utf8");

  const parsedByPage = pages.map((page) => {
    const offers = page.text ? parseProductTiles(page.text, page.url, validByKlNr, page.category) : [];
    return {
      ...page,
      offers,
      diagnostics: page.text ? pageDiagnostics(page.text) : null,
    };
  });

  const allOffers = parsedByPage.flatMap((page) => page.offers);
  const uniqueOffers = uniqueBy(allOffers, (offer) => offer.klNr).sort((a, b) =>
    a.product.localeCompare(b.product, "cs")
  );

  const matchedKlNrs = new Set(uniqueOffers.map((offer) => offer.klNr));
  const missingFromHtml = rawIndex
    .filter((item) => !matchedKlNrs.has(item.klNr))
    .slice(0, 200);

  const result = {
    meta: {
      source: STORE.storePage,
      offersIndexSource: STORE.offersUrl,
      leafletUrl: STORE.leafletUrl,
      checkedAt: new Date().toISOString(),
      store: STORE,
      count: uniqueOffers.length,
      rawIndexCount: rawIndex.length,
      matchedRawIndexCount: uniqueOffers.filter((offer) => offer.validFrom || offer.validTo).length,
      parser: "scripts/import-kaufland-teplice-html.mjs",
    },
    offers: uniqueOffers,
  };

  const debug = {
    meta: result.meta,
    categoryLinks,
    pages: parsedByPage.map((page) => ({
      type: page.type,
      url: page.url,
      category: page.category,
      length: page.length ?? 0,
      error: page.error ?? null,
      parsedOffersCount: page.offers.length,
      diagnostics: page.diagnostics,
      sampleProducts: page.offers.slice(0, 8).map((offer) => ({
        klNr: offer.klNr,
        product: offer.product,
        price: offer.price,
        oldPrice: offer.oldPrice,
        category: offer.category,
      })),
    })),
    firstOffers: uniqueOffers.slice(0, 30),
    missingFromHtml,
    missingFromHtmlCount: rawIndex.length - matchedKlNrs.size,
    notes: [
      "Parser v3 vyřezává pouze nejbližší <a> kolem konkrétního kloffer-articleID, aby se nemíchal první produkt do dalších položek.",
      "Diagnostika kategorií ukazuje, jestli kategorie obsahují articleID, produktové dlaždice a cenové tagy.",
      "Pokud kategorie stále mají parsedOffersCount 0, další krok je analyzovat firstArticleContext a případné JS datové zdroje.",
    ],
  };

  await writeFile(OFFERS_FILE, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(COMBINED_OFFERS_FILE, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(DEBUG_FILE, JSON.stringify(debug, null, 2) + "\n", "utf8");

  console.log(`Raw index count: ${rawIndex.length}`);
  console.log(`Parsed offers count: ${uniqueOffers.length}`);
  console.log(`Missing from HTML count: ${debug.missingFromHtmlCount}`);
  console.log(`Wrote ${OFFERS_FILE}`);
  console.log(`Wrote ${DEBUG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
