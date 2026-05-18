import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_NUMBER = 23;
const VALID_TO = "19.05.2026";

const PAGE23_PRODUCTS = [
  { start: "COFFEE WHITENER CASABLANCA", category: "káva", searchTerms: ["káva", "coffee whitener", "instantní nápoj"] },
  { start: "KÁVA CASABLANCA OCHUCENÁ", category: "káva", searchTerms: ["káva", "instantní káva", "ochucená káva"], allowZaPrice: false },
  { start: "KÁVA CASABLANCA CLASSIC", category: "káva", searchTerms: ["káva", "instantní káva"] },
  { start: "KÁVA MARILA STANDARD", category: "káva", searchTerms: ["káva", "mletá káva"] },
  { start: "EDUSCHO ESPRESSO INTENSO", category: "káva", searchTerms: ["káva", "zrnková káva", "espresso"] },
  { start: "KÁVA CASABLANCA INTENSO", category: "káva", searchTerms: ["káva", "mletá káva"] },
  { start: "LAVAZZA CAFFÉ CREMA", category: "káva", searchTerms: ["káva", "zrnková káva"] },
  { start: "KÁVA CASABLANCA CREMA", category: "káva", searchTerms: ["káva", "zrnková káva"] },
  { start: "KÁVA CASABLANCA ESPRESSO MILD", category: "káva", searchTerms: ["káva", "zrnková káva", "espresso"] },
  { start: "DOLCE GUSTO KÁVOVÉ KAPSLE", category: "káva", searchTerms: ["káva", "kávové kapsle", "Dolce Gusto"] },
  { start: "NESCAFÉ 3V1, 2V1", category: "káva", searchTerms: ["káva", "instantní káva", "3v1", "2v1"] },
  { start: "CAPPUCCINO CASABLANCA", category: "káva", searchTerms: ["káva", "cappuccino", "instantní nápoj"] },
  { start: "KÁVA JACOBS VELVET REFILL XXL", category: "káva", searchTerms: ["káva", "instantní káva"] },
  { start: "KÁVOVÉ KAPSLE TASSIMO", category: "káva", searchTerms: ["káva", "kávové kapsle", "Tassimo"] },
  { start: "JACOBS INTENSE", category: "káva", searchTerms: ["káva", "instantní káva"] },
  { start: "KÁVA JACOBS VELVET CREMA", category: "káva", searchTerms: ["káva", "mletá káva"] },
  { start: "JACOBS ORIGINS", category: "káva", searchTerms: ["káva", "mletá káva"] },
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

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  return unique(paragraphs);
}

function productNameFromBlock(block, productDef) {
  const firstPackageMarker = block.search(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|sáčků|kapslí)\b/iu);
  let product = firstPackageMarker > 0 ? block.slice(0, firstPackageMarker) : block;

  product = product
    .replace(/\*/g, "")
    .replace(/\|\s*$/g, "")
    .replace(/,\s*$/g, "")
    .replace(/\brůzné druhy\s+.*$/iu, "různé druhy")
    .replace(/\bv nabídce také\b.*$/iu, "")
    .replace(/\bNabídka platná\b.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  return product;
}

function packageSizeFromBlock(block) {
  const matches = [...block.matchAll(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|sáčků|kapslí)\b/giu)];
  if (!matches.length) return "";

  const found = matches.find((match) => !/^100\s*g$/iu.test(match[0]) && !/^1\s*kg$/iu.test(match[0]));
  return found ? found[0].replace(/\s+/g, " ") : matches[0][0].replace(/\s+/g, " ");
}

function unitPriceFromBlock(block) {
  const match = block.match(/\b100\s*g\s+(\d{1,4}[,.]\d{1,2})\s*Kč|\b1\s*kg\s+(\d{1,4}[,.]\d{1,2})\s*Kč/iu);
  if (!match) return { unitPrice: null, unit: "" };

  const unit = match[0].match(/\b(100\s*g|1\s*kg)\b/iu)?.[1]?.replace(/\s+/g, " ") ?? "";
  const priceText = match[1] ?? match[2];

  return {
    unitPrice: toNumber(priceText),
    unit,
  };
}

function actionPriceFromBlock(block, productDef) {
  const markerMatches = [...block.matchAll(/<\s*(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];
  if (markerMatches.length) return toNumber(markerMatches[0][1]);

  if (productDef.allowZaPrice) {
    const zaMatches = [...block.matchAll(/\bza\s+(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];
    if (zaMatches.length) return toNumber(zaMatches[0][1]);
  }

  return null;
}

function makeOffer(productDef, block) {
  const price = actionPriceFromBlock(block, productDef);
  if (price == null) return null;

  const product = productNameFromBlock(block, productDef);
  const packageSize = packageSizeFromBlock(block);
  const unit = unitPriceFromBlock(block);
  const searchTerms = unique([productDef.category, ...(productDef.searchTerms ?? [])].filter(Boolean));

  return {
    id: `penny-page23-v2-${hashId([PAGE_NUMBER, product, price])}`,
    chain: "Penny",
    storeId: "penny-letak",
    storeName: "Penny – leták",
    product,
    brand: "",
    description: searchTerms.join(" · "),
    packageSize,
    price,
    priceText: moneyText(price),
    unitPrice: unit.unitPrice,
    unit: unit.unit,
    validTo: VALID_TO,
    pageNumber: PAGE_NUMBER,
    imageUrl: "",
    pageImageUrl: `${BASE}/${PAGE_NUMBER}/files/assets/cover300.jpg`,
    imageType: "penny-page",
    sourceUrl: `${BASE}/${PAGE_NUMBER}/index.html`,
    category: productDef.category,
    searchTerms,
    compareKey: productDef.category || normalizeSearch(product),
    confidence: "targeted-page23-coffee-parser-v2",
    suspect: true,
    suspectReasons: ["candidate z cíleného parseru stránky 23 v2 – ověřit proti letáku"],
    rawContext: block.slice(0, 900),
  };
}

function extractPage23Blocks(pageText) {
  const productDefs = PAGE23_PRODUCTS.map((def) => ({
    ...def,
    regex: new RegExp(`\\b${escapeRegex(def.start)}\\b`, "iu"),
  }));

  const positions = [];

  for (const def of productDefs) {
    const match = pageText.match(def.regex);
    if (!match || match.index == null) continue;
    positions.push({
      startIndex: match.index,
      productDef: def,
    });
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

async function fetchPage() {
  const url = `${BASE}/${PAGE_NUMBER}/index.html`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyPage23CoffeeProbeV2/0.1; +https://github.com/)",
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

  const blocks = extractPage23Blocks(pageText);
  const offers = blocks.map(({ productDef, block }) => makeOffer(productDef, block)).filter(Boolean);

  const output = {
    meta: {
      source: "Penny page 23 targeted coffee parser v2",
      updatedAt: new Date().toISOString(),
      count: offers.length,
      note: "Cílený průzkumný výstup pro kávovou stranu 23. Položky jsou suspect=true.",
    },
    offers,
  };

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      pageNumber: PAGE_NUMBER,
      pageFetchOk: page.ok,
      status: page.status,
      paragraphCount: paragraphs.length,
      blocksFound: blocks.length,
      totalCandidateOffers: offers.length,
      coffeeCandidateOffers: offers.filter((offer) => offer.category === "káva").length,
      productsFound: offers.map((offer) => ({
        product: offer.product,
        priceText: offer.priceText,
        packageSize: offer.packageSize,
        unitPrice: offer.unitPrice,
        unit: offer.unit,
        category: offer.category,
      })),
      missingBlocksWithoutActionPrice: blocks
        .filter(({ productDef, block }) => actionPriceFromBlock(block, productDef) == null)
        .map(({ productDef, block }) => ({ start: productDef.start, block })),
      recommendedPath:
        offers.length >= 15
          ? "inspect-page23-v2-then-import-safe"
          : "adjust-page23-v2-product-starts-or-price-parser",
    },
    offers,
    blocks: blocks.map(({ productDef, block }) => ({
      start: productDef.start,
      category: productDef.category,
      block,
    })),
    pageTextPreview: pageText.slice(0, 7000),
  };

  await writeFile(`${OUTPUT_DIR}/penny-page23-coffee-probe-v2.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-page23-coffee-probe-v2-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny page23 coffee probe v2 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-page23-coffee-probe-v2-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
