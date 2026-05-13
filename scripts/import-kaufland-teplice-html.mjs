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
  gridPage: "https://prodejny.kaufland.cz/nabidka/prehled.html?kloffer-week=current&kloffer-category=0001_TopArticle",
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

function toNumber(value) {
  if (value == null) return null;
  const normalized = String(value).replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, "");
  if (!/\d/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function makeId(key) {
  return "kaufland-teplice-" + createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function canonicalImageUrl(imageUrl = "") {
  return imageUrl.split("?")[0].trim();
}

function productIdentity(offer) {
  return [offer.product.toLowerCase(), offer.price, canonicalImageUrl(offer.imageUrl)].join("|");
}

function mergeDuplicateOffers(offers) {
  const map = new Map();
  for (const offer of offers) {
    const key = productIdentity(offer);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, offer);
      continue;
    }
    if (!existing.klNr && offer.klNr) {
      map.set(key, { ...offer, category: offer.category || existing.category });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.product.localeCompare(b.product, "cs"));
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacKauflandHtmlImport/0.5; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 300)}`);
  return { url, finalUrl: response.url, contentType: response.headers.get("content-type") ?? "", length: text.length, text };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacKauflandHtmlImport/0.5; +https://github.com/)",
      accept: "application/json,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
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

function getFirstDateRange(rawIndex) {
  const first = rawIndex.find((item) => item?.dateFrom || item?.dateTo) ?? {};
  return { dateFrom: first.dateFrom ?? "", dateTo: first.dateTo ?? "" };
}

function getKlNrFromTile(tile) {
  const match =
    tile.match(/kloffer-articleID=([0-9]+)/i) ||
    tile.match(/articleID["']?\s*[:=]\s*["']?([0-9]+)/i) ||
    tile.match(/klNr["']?\s*[:=]\s*["']?([0-9]+)/i);
  return match ? match[1] : "";
}

function getHrefFromTile(tile, pageUrl) {
  const match = tile.match(/href\s*=\s*["']([^"']*)["']/i);
  return match ? absoluteUrl(match[1], pageUrl).replace(/&amp;/g, "&") : pageUrl;
}

function getImageTag(tile) {
  return (
    tile.match(/<img\b[^>]*(?:k-product-tile__main-image|data-image-fallback|alt=)[^>]*>/i)?.[0] ||
    tile.match(/<img\b[^>]*>/i)?.[0] ||
    ""
  );
}

function categoryNameFromUrl(url) {
  try {
    const parsed = new URL(url.replace(/&amp;/g, "&"));
    const raw = parsed.searchParams.get("kloffer-category") ?? "";
    if (!raw || raw === "0001_TopArticle") return "Akční nabídka";
    return decodeURIComponent(raw).replace(/^\d+_?/, "").replace(/__/g, " / ").replace(/_/g, " ").trim();
  } catch {
    return "Akční nabídka";
  }
}

function parseBasePrice(basePriceText) {
  const match = basePriceText.match(/=?\s*((?:\d+(?:[,.]\d+)?)\s*(?:kg|g|l|ml|ks|m))\s+(\d+(?:[,.]\d+)?)/i);
  if (!match) return null;
  return { unitPrice: toNumber(match[2]), unit: `Kč/${match[1].replace(/\s+/g, " ")}` };
}

function normalizeOfferFromTile(tile, pageUrl, validByKlNr, fallbackValid, fallbackCategory = "Akční nabídka") {
  const klNr = getKlNrFromTile(tile);
  const href = getHrefFromTile(tile, pageUrl);
  const imageTag = getImageTag(tile);

  const imageAlt = cleanText(extractAttr(imageTag, "alt"));
  const title = extractFirst(tile, /<[^>]*class=["'][^"']*k-product-tile__title[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  const subtitle = extractFirst(tile, /<[^>]*class=["'][^"']*k-product-tile__subtitle[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  const product = imageAlt || [title, subtitle].filter(Boolean).join(" ").trim() || cleanText(extractAttr(imageTag, "title"));

  const priceText = extractFirst(tile, /<div[^>]*class=["'][^"']*k-price-tag__price[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const oldPriceText = extractFirst(tile, /<span[^>]*class=["'][^"']*k-price-tag__old-price-line-through[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  const discountText = extractFirst(tile, /<div[^>]*class=["'][^"']*k-price-tag__discount[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const packageSize = extractFirst(tile, /<div[^>]*class=["'][^"']*k-product-tile__unit-price[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const basePriceText = extractFirst(tile, /<div[^>]*class=["'][^"']*k-product-tile__base-price[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

  const price = toNumber(priceText);
  const oldPrice = toNumber(oldPriceText);
  const basePrice = parseBasePrice(basePriceText);
  const imageUrl = canonicalImageUrl(absoluteUrl(extractAttr(imageTag, "src"), pageUrl));
  const category = categoryNameFromUrl(href) || fallbackCategory;
  const valid = klNr ? (validByKlNr.get(klNr) ?? fallbackValid) : fallbackValid;

  if (!product || price == null) return null;
  const stableKey = klNr || `${product}|${price}|${imageUrl}`;

  return {
    id: makeId(stableKey),
    storeId: STORE.storeId,
    chain: STORE.chain,
    storeName: STORE.storeName,
    storeAddress: STORE.storeAddress,
    sourceStoreName: STORE.kauflandStoreName,
    product,
    brand: "",
    packageSize,
    price,
    oldPrice,
    unitPrice: basePrice?.unitPrice ?? price,
    unit: basePrice?.unit ?? "Kč/ks",
    category,
    validFrom: valid.dateFrom ?? "",
    validTo: valid.dateTo ?? "",
    priceType: discountText || "akční cena",
    klNr,
    imageUrl,
    sourceUrl: href,
    leafletUrl: STORE.leafletUrl,
  };
}

function parseProductTilesByAnchor(html, pageUrl, validByKlNr, fallbackValid, fallbackCategory = "Akční nabídka") {
  const offers = [];
  const anchorRegex = /<a\b[^>]*class\s*=\s*["'][^"']*k-product-tile[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html))) {
    const offer = normalizeOfferFromTile(match[0], pageUrl, validByKlNr, fallbackValid, fallbackCategory);
    if (offer) offers.push(offer);
  }

  const byTileIdentity = new Map();
  for (const offer of offers) {
    const key = offer.klNr || productIdentity(offer);
    if (!byTileIdentity.has(key)) byTileIdentity.set(key, offer);
  }
  return Array.from(byTileIdentity.values());
}

function pageDiagnostics(html) {
  const articleMatches = Array.from(html.matchAll(/kloffer-articleID=([0-9]+)/gi)).map((m) => m[1]);
  return {
    articleIdOccurrencesCount: articleMatches.length,
    uniqueArticleIdOccurrencesCount: new Set(articleMatches).size,
    firstArticleIds: Array.from(new Set(articleMatches)).slice(0, 20),
    tileClassCount: (html.match(/k-product-tile/gi) || []).length,
    anchorTileCount: (html.match(/<a\b[^>]*class=["'][^"']*k-product-tile/gi) || []).length,
    priceTagCount: (html.match(/k-price-tag__price/gi) || []).length,
    imgAltCount: (html.match(/<img\b[^>]*alt=/gi) || []).length,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(RAW_HTML_DIR, { recursive: true });

  const rawIndex = await fetchJson(STORE.offersUrl);
  const fallbackValid = getFirstDateRange(rawIndex);
  const validByKlNr = new Map(rawIndex.map((item) => [item.klNr, { dateFrom: item.dateFrom, dateTo: item.dateTo }]));

  const storePage = await fetchText(STORE.storePage);
  const gridPage = await fetchText(STORE.gridPage);

  await writeFile(`${RAW_HTML_DIR}/store-page.html`, storePage.text, "utf8");
  await writeFile(`${RAW_HTML_DIR}/grid-page.html`, gridPage.text, "utf8");

  const pages = [
    { type: "storePage", url: storePage.finalUrl, text: storePage.text, length: storePage.length, category: "Akční nabídka" },
    { type: "gridPage", url: gridPage.finalUrl, text: gridPage.text, length: gridPage.length, category: "Akční nabídka" },
  ];

  const parsedByPage = pages.map((page) => {
    const offers = parseProductTilesByAnchor(page.text, page.url, validByKlNr, fallbackValid, page.category);
    return { ...page, offers, diagnostics: pageDiagnostics(page.text) };
  });

  const allOffers = parsedByPage.flatMap((page) => page.offers);
  const mergedOffers = mergeDuplicateOffers(allOffers);
  const matchedKlNrs = new Set(mergedOffers.map((offer) => offer.klNr).filter(Boolean));
  const withoutKlNr = mergedOffers.filter((offer) => !offer.klNr);

  const result = {
    meta: {
      source: STORE.storePage,
      gridSource: STORE.gridPage,
      offersIndexSource: STORE.offersUrl,
      leafletUrl: STORE.leafletUrl,
      checkedAt: new Date().toISOString(),
      store: STORE,
      count: mergedOffers.length,
      rawIndexCount: rawIndex.length,
      matchedRawIndexCount: matchedKlNrs.size,
      offersWithoutKlNrCount: withoutKlNr.length,
      parser: "scripts/import-kaufland-teplice-html.mjs",
    },
    offers: mergedOffers,
  };

  const debug = {
    meta: result.meta,
    pages: parsedByPage.map((page) => ({
      type: page.type,
      url: page.url,
      category: page.category,
      length: page.length ?? 0,
      parsedOffersCount: page.offers.length,
      offersWithKlNrCount: page.offers.filter((offer) => offer.klNr).length,
      offersWithoutKlNrCount: page.offers.filter((offer) => !offer.klNr).length,
      diagnostics: page.diagnostics,
      sampleProducts: page.offers.slice(0, 10).map((offer) => ({
        klNr: offer.klNr,
        product: offer.product,
        price: offer.price,
        oldPrice: offer.oldPrice,
        packageSize: offer.packageSize,
        unitPrice: offer.unitPrice,
        unit: offer.unit,
        category: offer.category,
      })),
    })),
    firstOffers: mergedOffers.slice(0, 40),
    notes: [
      "Parser v5 bere stránku pobočky + jeden plný grid TopArticle.",
      "Netahejte všechny kategorie: Kaufland pro tyto URL vrací stejný plný grid, takže by vznikaly falešné kategorie.",
      "Duplicitní produkt z gridu a stránky pobočky se sloučí a preferuje se varianta s klNr.",
      "Výsledný count může být nižší než V4, ale měl by být čistší a bez duplicit produktů s/bez klNr.",
    ],
  };

  await writeFile(OFFERS_FILE, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(COMBINED_OFFERS_FILE, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(DEBUG_FILE, JSON.stringify(debug, null, 2) + "\n", "utf8");

  console.log(`Raw index count: ${rawIndex.length}`);
  console.log(`Parsed offers before merge: ${allOffers.length}`);
  console.log(`Merged offers count: ${mergedOffers.length}`);
  console.log(`Matched raw index count: ${matchedKlNrs.size}`);
  console.log(`Offers without klNr count: ${withoutKlNr.length}`);
  console.log(`Wrote ${OFFERS_FILE}`);
  console.log(`Wrote ${DEBUG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
