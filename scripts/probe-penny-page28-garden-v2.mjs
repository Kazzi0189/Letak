import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_NUMBER = 28;
const VALID_TO = "19.05.2026";

const PAGE28_PRODUCTS_IN_ORDER = [
  { start: "KAPALNÉ HNOJIVO", category: "zahrada", searchTerms: ["zahrada", "hnojivo", "kapalné hnojivo"] },
  { start: "SUBSTRÁT", category: "zahrada", searchTerms: ["zahrada", "substrát"] },
  { start: "HOŠTICKÝ KOMPOST", category: "zahrada", searchTerms: ["zahrada", "kompost"] },
  { start: "TRUHLÍK", category: "zahrada", searchTerms: ["zahrada", "truhlík"] },
  { start: "OPLOCENÍ ZÁHONKU", category: "zahrada", searchTerms: ["zahrada", "oplocení", "záhonek"] },
  { start: "OBAL NA KVĚTNÍK", category: "zahrada", searchTerms: ["zahrada", "obal na květník", "květináč"] },
  { start: "HNOJIVO KRISTALON", category: "zahrada", searchTerms: ["zahrada", "hnojivo", "Kristalon"] },
  { start: "VÁZACÍ PÁSKA", category: "zahrada", searchTerms: ["zahrada", "vázací páska"] },
  { start: "VÁZACÍ DRÁTEK", category: "zahrada", searchTerms: ["zahrada", "vázací drátek"] },
  { start: "ZAHRADNICKÉ NŮŽKY", category: "zahrada", searchTerms: ["zahrada", "zahradnické nůžky", "nůžky"] },
  { start: "STRUNA DO SEKAČKY", category: "zahrada", searchTerms: ["zahrada", "struna do sekačky", "sekačka"] },
  { start: "OPĚRA", category: "zahrada", searchTerms: ["zahrada", "opěra"] },
  { start: "ZAVLAŽOVACÍ KONCOVKA", category: "zahrada", searchTerms: ["zahrada", "zavlažování", "koncovka"] },
  { start: "POSTŘIKOVAČ", category: "zahrada", searchTerms: ["zahrada", "postřikovač"] },
  { start: "TABLETOVÉ HNOJIVO", category: "zahrada", searchTerms: ["zahrada", "hnojivo"] },
  { start: "PENETRAČNÍ NÁTĚR", category: "zahrada", searchTerms: ["zahrada", "penetrační nátěr", "nátěr"] },
  { start: "SADA ŠTĚTCŮ", category: "zahrada", searchTerms: ["zahrada", "štětce", "sada štětců"] },
  { start: "FUNGICID STOP", category: "zahrada", searchTerms: ["zahrada", "fungicid", "postřik"] },
  { start: "INSEKTICID SUBSTRAL NATUREN", category: "zahrada", searchTerms: ["zahrada", "insekticid", "Substral"] },
  { start: "BIOSEPTIK", category: "zahrada", searchTerms: ["zahrada", "bioseptik", "urychlovač kompostu"] },
  { start: "MOLUSKOCID SLIMASTOP", category: "zahrada", searchTerms: ["zahrada", "moluskocid", "slimastop"] },
  { start: "PŘÍPRAVEK BROS", category: "zahrada", searchTerms: ["zahrada", "Bros", "přípravek na hmyz"] },
  { start: "PAST NA SLIMÁKY", category: "zahrada", searchTerms: ["zahrada", "past", "slimáci"] },
];

function hashId(parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function decodeHtml(value = "") {
  return String(value)
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

function decodeURIComponentSafe(value = "") {
  let result = String(value);
  for (let i = 0; i < 6; i++) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch {
      break;
    }
  }
  return result;
}

function normalizeText(value = "") {
  return decodeHtml(value)
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value = "") {
  return normalizeText(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function normalizeForIndex(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[–—]/g, "-");
}

function normalizeSearch(value = "") {
  return normalizeForIndex(value).replace(/\s+/g, " ").trim();
}

function toNumber(value) {
  const normalized = String(value)
    .replace(/\s+/g, "")
    .replace(/Kč/giu, "")
    .replace(",-", ",00")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function moneyText(number) {
  if (number == null) return "";
  return number.toLocaleString("cs-CZ", {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  }) + " Kč";
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractParagraphs(html) {
  const decoded = decodeURIComponentSafe(decodeHtml(html));
  const paragraphs = [];
  let match;

  const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = pRegex.exec(decoded))) {
    const text = stripTags(match[1]);
    if (!text || text.length < 80) continue;
    if (/Made with FlippingBook|schema\.org/i.test(text)) continue;
    paragraphs.push(text);
  }

  const bodyText = stripTags(decoded)
    .replace(/Made with FlippingBook[\s\S]*$/i, " ")
    .trim();

  if (bodyText.length > 300) paragraphs.push(bodyText);

  return unique(paragraphs);
}

function findStartIndex(sourceText, startText) {
  return normalizeForIndex(sourceText).indexOf(normalizeForIndex(startText));
}

function extractPriceList(pageText) {
  const beforeProducts = pageText.split(/KAPALNÉ HNOJIVO\*/iu)[0] ?? pageText;
  const matches = [...beforeProducts.matchAll(/nabídka\s+Jedinečná\s+(\d{1,4}[,.]\d{1,2})/giu)];
  return matches.map((match) => toNumber(match[1])).filter((price) => price != null);
}

function extractProductBlocks(pageText) {
  const positions = [];

  for (const def of PAGE28_PRODUCTS_IN_ORDER) {
    const index = findStartIndex(pageText, def.start);
    if (index >= 0) {
      positions.push({ startIndex: index, productDef: def });
    }
  }

  positions.sort((a, b) => a.startIndex - b.startIndex);

  return positions.map((position, index) => {
    const endIndex = index + 1 < positions.length ? positions[index + 1].startIndex : pageText.length;
    return {
      productDef: position.productDef,
      block: normalizeText(pageText.slice(position.startIndex, endIndex)),
    };
  });
}

function packageSizeFromBlock(block) {
  const matches = [...block.matchAll(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|m|cm|mm)\b/giu)];
  if (!matches.length) return "";

  // Délky/průměry u zahradních věcí často nejsou balení; u nich necháme raději 1 ks / 1 balení.
  const preferred = matches.find((match) => /\b(?:ks|balení|ml|l|g|kg)\b/iu.test(match[0]));
  return preferred ? preferred[0].replace(/\s+/g, " ") : matches[0][0].replace(/\s+/g, " ");
}

function productNameFromBlock(block) {
  let product = block
    .replace(/\*/g, "")
    .replace(/\|\s*<\s*\d{1,4}[,.]\d{1,2}\s*Kč/giu, "")
    .replace(/<\s*\d{1,4}[,.]\d{1,2}\s*Kč/giu, "")
    .replace(/\bza\s+\d{1,4}[,.]\d{1,2}\s*Kč/giu, "")
    .replace(/\bNabídka platná\b.*$/iu, "")
    .replace(/\bPoužívejte\b.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  const firstPackageMarker = product.search(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení)\b/iu);
  if (firstPackageMarker > 0) product = product.slice(0, firstPackageMarker).trim();

  return product;
}

function makeOffer(productDef, block, price, index) {
  const product = productNameFromBlock(block);
  const packageSize = packageSizeFromBlock(block);
  const searchTerms = unique([productDef.category, ...(productDef.searchTerms ?? [])].filter(Boolean));

  return {
    id: `penny-page28-v2-${hashId([PAGE_NUMBER, index, product, price])}`,
    chain: "Penny",
    storeId: "penny-letak",
    storeName: "Penny – leták",
    product,
    brand: "",
    description: searchTerms.join(" · "),
    packageSize,
    price,
    priceText: moneyText(price),
    unitPrice: null,
    unit: "",
    validTo: VALID_TO,
    pageNumber: PAGE_NUMBER,
    imageUrl: "",
    pageImageUrl: `${BASE}/${PAGE_NUMBER}/files/assets/cover300.jpg`,
    imageType: "penny-page",
    sourceUrl: `${BASE}/${PAGE_NUMBER}/index.html`,
    category: productDef.category,
    searchTerms,
    compareKey: productDef.category || normalizeSearch(product),
    confidence: "targeted-page28-garden-parser-v2-price-order-match",
    suspect: true,
    suspectReasons: ["candidate ze spárování pořadí cen a produktů stránky 28 – ověřit proti letáku"],
    rawContext: block.slice(0, 900),
  };
}

function classifyOffer(offer, index) {
  const reasons = [];
  const product = offer.product ?? "";

  if (!offer.price) reasons.push("chybí cena");
  if (product.length < 4) reasons.push("krátký název");
  if (product.length > 90) reasons.push("dlouhý název");
  if (/Používejte|Nabídka platná/iu.test(offer.rawContext ?? "")) reasons.push("obsahuje bezpečnostní nebo patičkový text");
  if (index >= 0 && PAGE28_PRODUCTS_IN_ORDER[index] && !normalizeSearch(product).includes(normalizeSearch(PAGE28_PRODUCTS_IN_ORDER[index].start).slice(0, 8))) {
    reasons.push("název nemusí odpovídat očekávanému pořadí");
  }

  return {
    bucket: reasons.length ? "review" : "safe-candidate",
    reasons,
  };
}

async function fetchPage() {
  const url = `${BASE}/${PAGE_NUMBER}/index.html`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyPage28GardenProbeV2/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const page = await fetchPage();
  const paragraphs = extractParagraphs(page.text);
  const pageText = paragraphs.join(" ");

  const priceList = extractPriceList(pageText);
  const blocks = extractProductBlocks(pageText);

  const paired = blocks.map(({ productDef, block }, index) => ({
    productDef,
    block,
    price: priceList[index] ?? null,
    priceIndex: index,
  }));

  const offers = paired
    .filter((item) => item.price != null)
    .map((item) => makeOffer(item.productDef, item.block, item.price, item.priceIndex));

  const classifiedOffers = offers.map((offer, index) => ({
    ...offer,
    candidateClassification: classifyOffer(offer, index),
  }));

  const output = {
    meta: {
      source: "Penny page 28 targeted garden parser v2 price order match",
      updatedAt: new Date().toISOString(),
      count: classifiedOffers.length,
      note: "Kontrolní výstup pro zahradní stranu 28. Není určený k přímému importu do aplikace.",
    },
    offers: classifiedOffers,
  };

  const safeCandidates = classifiedOffers.filter((offer) => offer.candidateClassification.bucket === "safe-candidate");
  const reviewCandidates = classifiedOffers.filter((offer) => offer.candidateClassification.bucket === "review");

  const summary = {
    checkedAt: new Date().toISOString(),
    type: "JEN KONTROLNÍ REPORT – DO APLIKACE NENAHRÁVAT",
    summary: {
      pageNumber: PAGE_NUMBER,
      pageFetchOk: page.ok,
      status: page.status,
      paragraphCount: paragraphs.length,
      priceListCount: priceList.length,
      blocksFound: blocks.length,
      totalCandidateOffers: classifiedOffers.length,
      safeCandidates: safeCandidates.length,
      reviewCandidates: reviewCandidates.length,
      priceProductCountMismatch: priceList.length !== blocks.length,
      recommendedPath:
        priceList.length === blocks.length && safeCandidates.length >= 15
          ? "inspect-page28-v2-then-import-safe"
          : "inspect-pairing-before-import",
    },
    priceList: priceList.map((price, index) => ({ index, priceText: moneyText(price), price })),
    productsFound: classifiedOffers.map((offer, index) => ({
      index,
      expectedStart: PAGE28_PRODUCTS_IN_ORDER[index]?.start ?? "",
      product: offer.product,
      priceText: offer.priceText,
      packageSize: offer.packageSize,
      category: offer.category,
      bucket: offer.candidateClassification.bucket,
      reasons: offer.candidateClassification.reasons,
    })),
    offers: classifiedOffers,
    pairedBlocks: paired.map((item) => ({
      index: item.priceIndex,
      expectedStart: item.productDef.start,
      priceText: item.price != null ? moneyText(item.price) : "",
      block: item.block,
    })),
    pageTextPreview: pageText.slice(0, 8000),
  };

  await writeFile(`${OUTPUT_DIR}/penny-page28-garden-probe-v2.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-page28-garden-probe-v2-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny page28 garden probe v2 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-page28-garden-probe-v2-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
