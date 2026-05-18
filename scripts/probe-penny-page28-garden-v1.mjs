import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_NUMBER = 28;
const VALID_TO = "19.05.2026";

const PAGE28_PRODUCTS = [
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
  { start: "PAST NA", category: "zahrada", searchTerms: ["zahrada", "past"] },
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

function findAllStarts(sourceText, startText) {
  const normalizedSource = normalizeForIndex(sourceText);
  const normalizedStart = normalizeForIndex(startText);
  const indexes = [];
  let offset = 0;

  while (offset < normalizedSource.length) {
    const index = normalizedSource.indexOf(normalizedStart, offset);
    if (index < 0) break;
    indexes.push(index);
    offset = index + normalizedStart.length;
  }

  return indexes;
}

function packageSizeFromBlock(block) {
  const matches = [...block.matchAll(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|m|cm|mm)\b/giu)];
  if (!matches.length) return "";

  const found = matches.find((match) => !/^\d+(?:[,.]\d+)?\s*(?:cm|mm|m)$/iu.test(match[0]));
  return found ? found[0].replace(/\s+/g, " ") : matches[0][0].replace(/\s+/g, " ");
}

function productNameFromBlock(block) {
  const firstPackageMarker = block.search(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení)\b/iu);
  let product = firstPackageMarker > 0 ? block.slice(0, firstPackageMarker) : block;

  product = product
    .replace(/\*/g, "")
    .replace(/\|\s*$/g, "")
    .replace(/,\s*$/g, "")
    .replace(/\bNabídka platná\b.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  return product;
}

function actionPriceFromBlock(block) {
  const markerMatches = [...block.matchAll(/<\s*(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];
  if (markerMatches.length) return toNumber(markerMatches[0][1]);

  const zaMatches = [...block.matchAll(/\bza\s+(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];
  if (zaMatches.length) return toNumber(zaMatches[0][1]);

  return null;
}

function makeOffer(productDef, block) {
  const price = actionPriceFromBlock(block);
  if (price == null) return null;

  const product = productNameFromBlock(block);
  const packageSize = packageSizeFromBlock(block);
  const searchTerms = unique([productDef.category, ...(productDef.searchTerms ?? [])].filter(Boolean));

  return {
    id: `penny-page28-v1-${hashId([PAGE_NUMBER, product, price])}`,
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
    confidence: "targeted-page28-garden-parser-v1",
    suspect: true,
    suspectReasons: ["candidate z cíleného parseru stránky 28 – ověřit proti letáku"],
    rawContext: block.slice(0, 900),
  };
}

function extractPage28Blocks(pageText) {
  const positions = [];
  const foundStarts = [];

  for (const def of PAGE28_PRODUCTS) {
    const indexes = findAllStarts(pageText, def.start);

    for (const index of indexes) {
      positions.push({
        startIndex: index,
        productDef: def,
      });
      foundStarts.push(def.start);
    }
  }

  positions.sort((a, b) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
    return b.productDef.start.length - a.productDef.start.length;
  });

  const deduped = [];
  const usedIndexes = new Set();
  for (const position of positions) {
    if (usedIndexes.has(position.startIndex)) continue;
    usedIndexes.add(position.startIndex);
    deduped.push(position);
  }

  return {
    blocks: deduped.map((position, index) => {
      const endIndex = index + 1 < deduped.length ? deduped[index + 1].startIndex : pageText.length;
      return {
        productDef: position.productDef,
        block: normalizeText(pageText.slice(position.startIndex, endIndex)),
      };
    }),
    foundStarts: Array.from(new Set(foundStarts)).sort((a, b) => a.localeCompare(b, "cs")),
    missingStarts: PAGE28_PRODUCTS
      .map((def) => def.start)
      .filter((start) => !foundStarts.includes(start)),
  };
}

function classifyOffer(offer) {
  const raw = offer.rawContext ?? "";
  const product = offer.product ?? "";
  const reasons = [];

  if (/ZAVLAŽOVACÍ KONCOVKA.*POSTŘIKOVAČ|SADA ŠTĚTCŮ.*FUNGICID|FUNGICID.*INSEKTICID|BIOSEPTIK.*MOLUSKOCID/iu.test(raw)) {
    reasons.push("blok může obsahovat více položek za jednu cenu nebo přilepené položky");
  }

  if (product.length > 80) reasons.push("dlouhý název – zkontrolovat ručně");
  if (!offer.price) reasons.push("chybí cena");

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
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyPage28GardenProbeV1/0.1; +https://github.com/)",
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

  const extraction = extractPage28Blocks(pageText);
  const offers = extraction.blocks.map(({ productDef, block }) => makeOffer(productDef, block)).filter(Boolean);

  const classifiedOffers = offers.map((offer) => ({
    ...offer,
    candidateClassification: classifyOffer(offer),
  }));

  const output = {
    meta: {
      source: "Penny page 28 targeted garden parser v1",
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
      blocksFound: extraction.blocks.length,
      startsFound: extraction.foundStarts.length,
      totalCandidateOffers: classifiedOffers.length,
      safeCandidates: safeCandidates.length,
      reviewCandidates: reviewCandidates.length,
      missingStarts: extraction.missingStarts,
      missingBlocksWithoutActionPrice: extraction.blocks
        .filter(({ block }) => actionPriceFromBlock(block) == null)
        .map(({ productDef, block }) => ({ start: productDef.start, block })),
      recommendedPath:
        safeCandidates.length >= 3
          ? "inspect-page28-candidates-before-any-import"
          : "adjust-page28-starts-or-price-parser",
    },
    productsFound: classifiedOffers.map((offer) => ({
      product: offer.product,
      priceText: offer.priceText,
      packageSize: offer.packageSize,
      category: offer.category,
      bucket: offer.candidateClassification.bucket,
      reasons: offer.candidateClassification.reasons,
    })),
    offers: classifiedOffers,
    blocks: extraction.blocks.map(({ productDef, block }) => ({
      start: productDef.start,
      category: productDef.category,
      block,
    })),
    pageTextPreview: pageText.slice(0, 8000),
  };

  await writeFile(`${OUTPUT_DIR}/penny-page28-garden-probe-v1.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-page28-garden-probe-v1-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny page28 garden probe v1 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-page28-garden-probe-v1-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
