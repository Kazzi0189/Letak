import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/albert-probe";
const LEAFLETS = [
  { id: "20sm_akcni_letak", type: "supermarket", title: "Albert supermarket akční leták", baseUrl: "https://letaky.albert.cz/20sm_akcni_letak/", maxPages: 42 },
  { id: "20hm_akcni_letak", type: "hypermarket", title: "Albert hypermarket akční leták", baseUrl: "https://letaky.albert.cz/20hm_akcni_letak/", maxPages: 60 },
];

function decodeHtml(value = "") {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/g, "=")
    .replace(/\\\//g, "/")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeText(value = "") {
  return decodeHtml(safeDecodeURIComponent(value))
    .replace(/\+/g, " ")
    .replace(/%/g, " % ")
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

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertTextExtract/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  return {
    url,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

function extractAllUrls(html, baseUrl) {
  const urls = [];
  const decoded = decodeHtml(html);
  let match;

  const attrRegex = /(?:src|href|data-src|data-href|data-url|content)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(decoded))) urls.push(absoluteUrl(match[1], baseUrl));

  const httpRegex = /https?:\/\/[^"'\\\s)<>]+/gi;
  while ((match = httpRegex.exec(decoded))) urls.push(match[0].replace(/[;,]+$/, ""));

  return unique(urls.map((url) => url.replace(/\\/g, "")));
}

function isUsefulEncodedText(text) {
  const normalized = normalizeText(text);
  if (normalized.length < 80) return false;
  if (!/[0-9],[0-9]{2}|[0-9]\s*Kč|Kč|BEZ APLIKACE|NEPORAZITELNÉ/i.test(normalized)) return false;
  if (/^https?:\/\//i.test(normalized)) return false;
  if (/publitas|favicon|shopping_cart|assets|sentry|stats|website|noindex|charset|width=device/i.test(normalized)) return false;
  return true;
}

function extractTextCandidatesFromUrls(urls, leafletBaseUrl) {
  const basePath = new URL(leafletBaseUrl).pathname.replace(/\/$/, "");
  const candidates = [];

  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    if (!parsed.hostname.includes("letaky.albert.cz")) continue;
    if (!parsed.pathname.includes(basePath)) continue;

    const decodedPath = normalizeText(parsed.pathname);
    const segments = decodedPath.split("/").map((part) => normalizeText(part)).filter(Boolean);

    for (const segment of segments) {
      if (isUsefulEncodedText(segment)) candidates.push(segment);
    }
  }

  return unique(candidates);
}

function extractPageImageUrls(urls) {
  return unique(urls.filter((url) => /^https:\/\/view\.publitas\.com\/\d+\/\d+\/pages\/.+-at1600\.jpg/i.test(url)));
}

function toNumber(value) {
  if (!value) return null;
  const number = Number(String(value).replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function priceExamples(text) {
  const normalized = normalizeText(text);
  return unique(normalized.match(/\d{1,4}(?:\s?\d{3})*[,.]\d{2}\s*Kč|\d{1,4}\s*[,.]\s*\d{2}|\d{1,4},-/gi) || []);
}

function unitPriceExamples(text) {
  const normalized = normalizeText(text);
  return unique(normalized.match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks)\s*(?:=|od)?\s*\d{1,4}(?:\s?\d{3})*[,.]\d{2}\s*Kč/gi) || []);
}

function extractBasicOfferCandidates(text, pageNumber, pageImageUrl, leaflet) {
  const normalized = normalizeText(text).replace(/\s+•\s+/g, " • ").replace(/\s+/g, " ");
  const candidates = [];

  const productPattern =
    /((?:[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž0-9’'.%/-]+|[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž0-9’'.%/-]{3,})(?:\s+[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž0-9’'.%/-]{2,}){0,5})\s+•\s+([^•]{0,140}?(?:\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks)|100\s*g|1\s*kg|1\s*l)[^•]{0,180}?Kč)/gi;

  let match;
  while ((match = productPattern.exec(normalized))) {
    const product = match[1]
      .replace(/^(BEZ APLIKACE|NEPORAZITELNÉ|BĚŽNÁ CENA|Nature|www\.albert\.cz)$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    const context = match[2].replace(/\s+/g, " ").trim();
    const prices = priceExamples(context);

    if (product.length < 3 || prices.length === 0) continue;
    if (/^(od|do|www|albert|bez|aplikace|neporazitelné|běžná cena)$/i.test(product)) continue;

    const packageMatch = context.match(/\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks)/i);
    const unitMatch = context.match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks)\s*(?:=|od)?\s*\d{1,4}(?:\s?\d{3})*[,.]\d{2}\s*Kč/i);

    candidates.push({
      chain: "Albert",
      storeId: `albert-${leaflet.type}`,
      storeName: `Albert ${leaflet.type === "hypermarket" ? "hypermarket" : "supermarket"}`,
      leafletType: leaflet.type,
      product,
      packageSize: packageMatch?.[0] ?? "",
      priceText: prices[prices.length - 1],
      price: toNumber(prices[prices.length - 1]),
      unitText: unitMatch?.[0] ?? "",
      pageNumber,
      pageImageUrl,
      sourceUrl: `${leaflet.baseUrl}page/${pageNumber}`,
      confidence: "rough-text-candidate",
      rawContext: context.slice(0, 260),
    });
  }

  return candidates;
}

async function inspectLeaflet(leaflet) {
  const pages = [];
  const allOfferCandidates = [];
  let emptyInRow = 0;

  for (let page = 1; page <= leaflet.maxPages; page++) {
    const url = `${leaflet.baseUrl}page/${page}`;
    const response = await fetchText(url);

    if (!response.ok) {
      emptyInRow += 1;
      if (emptyInRow >= 5) break;
      continue;
    }

    const urls = extractAllUrls(response.text, response.finalUrl);
    const textCandidates = extractTextCandidatesFromUrls(urls, leaflet.baseUrl);
    const pageImageUrls = extractPageImageUrls(urls);
    const pageImageUrl = pageImageUrls[0] ?? "";
    const joinedText = textCandidates.join(" ");
    const offers = extractBasicOfferCandidates(joinedText, page, pageImageUrl, leaflet);

    if (textCandidates.length === 0 && pageImageUrls.length === 0) emptyInRow += 1;
    else emptyInRow = 0;

    pages.push({
      page,
      url,
      ok: response.ok,
      status: response.status,
      htmlLength: response.text.length,
      textCandidatesCount: textCandidates.length,
      textCandidates: textCandidates.slice(0, 5),
      textLength: joinedText.length,
      priceExamples: priceExamples(joinedText).slice(0, 40),
      unitPriceExamples: unitPriceExamples(joinedText).slice(0, 40),
      pageImageUrls,
      offerCandidatesCount: offers.length,
      offerCandidatesPreview: offers.slice(0, 20),
    });

    allOfferCandidates.push(...offers);
  }

  const uniqueOfferCandidates = [];
  const seen = new Set();
  for (const offer of allOfferCandidates) {
    const key = `${offer.leafletType}|${offer.product}|${offer.priceText}|${offer.pageNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueOfferCandidates.push(offer);
  }

  return {
    leaflet,
    summary: {
      pagesChecked: pages.length,
      pagesWithText: pages.filter((page) => page.textCandidatesCount > 0).length,
      pagesWithImages: pages.filter((page) => page.pageImageUrls.length > 0).length,
      offerCandidates: uniqueOfferCandidates.length,
      priceExamples: unique(pages.flatMap((page) => page.priceExamples)).slice(0, 60),
      unitPriceExamples: unique(pages.flatMap((page) => page.unitPriceExamples)).slice(0, 60),
      recommendedPath: uniqueOfferCandidates.length > 30 ? "build-albert-parser-from-hidden-page-text" : pages.some((page) => page.textCandidatesCount > 0) ? "improve-hidden-text-parser" : "fallback-to-pdf",
    },
    pages,
    offerCandidates: uniqueOfferCandidates,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const results = [];
  for (const leaflet of LEAFLETS) results.push(await inspectLeaflet(leaflet));

  const allOfferCandidates = results.flatMap((result) => result.offerCandidates);

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      totalOfferCandidates: allOfferCandidates.length,
      recommendedPath: allOfferCandidates.length > 60 ? "build-albert-parser-from-hidden-page-text" : "inspect-debug-before-parser",
      leaflets: results.map((result) => ({
        id: result.leaflet.id,
        type: result.leaflet.type,
        title: result.leaflet.title,
        ...result.summary,
      })),
    },
    sampleOffers: allOfferCandidates.slice(0, 80),
  };

  await writeFile(`${OUTPUT_DIR}/albert-page-text-debug.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/page-text-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Albert hidden page text extraction finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/page-text-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
