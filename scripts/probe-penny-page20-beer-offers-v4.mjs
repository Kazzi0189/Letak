import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_NUMBER = 20;
const VALID_TO = "19.05.2026";

const PAGE20_PRODUCTS = [
  { start: "SKOTSKÁ WHISKY MC ILLROY", category: "alkohol" },
  { start: "OSTRAVAR MUSTANG", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "BRANÍK", category: "pivo", searchTerms: ["pivo", "světlé pivo", "výčepní pivo"] },
  { start: "VELKOPOPOVICKÝ KOZEL 10", category: "pivo", searchTerms: ["pivo", "světlé pivo", "výčepní pivo"] },
  { start: "STAROČECH ORIGINAL", category: "pivo", searchTerms: ["pivo", "světlé pivo", "výčepní pivo"] },
  { start: "STAROPRAMEN 10", category: "pivo", searchTerms: ["pivo", "světlé pivo", "výčepní pivo"] },
  { start: "STAROČECH polotmavý", category: "pivo", searchTerms: ["pivo", "polotmavé pivo", "ležák"] },
  { start: "RADEGAST RATAR", category: "pivo", searchTerms: ["pivo", "hořký ležák"] },
  { start: "BUDWEISER BUDVAR", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "GAMBRINUS PATRON", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "ZUBR GRAND, HOLBA ŠERÁK", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "KRUŠOVICE 12", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "MUSTANG HOŘKÝ", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "STAROČECH nealko", category: "pivo", searchTerms: ["pivo", "nealkoholické pivo"] },
  { start: "STAROPRAMEN 12", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "BRANDY KOBLEVO RESERVE VSOP", category: "alkohol" },
  { start: "COOL", category: "pivo", searchTerms: ["pivo", "radler", "míchaný nápoj"] },
  { start: "VELKOPOPOVICKÝ KOZEL nealko", category: "pivo", searchTerms: ["pivo", "nealkoholické pivo"] },
  { start: "KRUŠOVICE 10", category: "pivo", searchTerms: ["pivo", "světlé pivo", "výčepní pivo"] },
  { start: "BOHEMIA SEKT", category: "alkohol", searchTerms: ["sekt", "šumivé víno"] },
  { start: "SVIJANSKÝ MÁZ", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"] },
  { start: "PROSECCO", category: "alkohol", searchTerms: ["prosecco", "šumivé víno"] },
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
    if (/Made with FlippingBook/i.test(text)) continue;
    paragraphs.push(text);
  }

  return unique(paragraphs);
}

function productNameFromBlock(block, productDef) {
  const firstPackageMarker = block.search(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|plech|sklo|svazek)\b/iu);
  let product = firstPackageMarker > 0 ? block.slice(0, firstPackageMarker) : block;

  product = product
    .replace(/\*/g, "")
    .replace(/\|\s*$/g, "")
    .replace(/,\s*$/g, "")
    .replace(/\brůzné druhy\s+.*$/iu, "různé druhy")
    .replace(/\bv nabídce také\b.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalizeSearch(productDef.start) === "cool" && /^COOL\b/i.test(product)) return "COOL různé druhy";

  return product;
}

function packageSizeFromBlock(block) {
  const match = block.match(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|plech|sklo)\b/iu);
  return match ? match[0].replace(/\s+/g, " ") : "";
}

function unitPriceFromBlock(block) {
  const match = block.match(/\b1\s*(?:l|kg|m|ks|100\s*g|100\s*ml)\s+(\d{1,4}[,.]\d{1,2})\s*Kč/iu);
  if (!match) return { unitPrice: null, unit: "" };

  return {
    unitPrice: toNumber(match[1]),
    unit: match[0].match(/\b1\s*(l|kg|m|ks|100\s*g|100\s*ml)\b/iu)?.[1]?.replace(/\s+/g, " ") ?? "",
  };
}

function actionPriceFromBlock(block) {
  const markerMatches = [...block.matchAll(/<\s*(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];
  if (!markerMatches.length) return null;

  // Po rozdělení na samostatné bloky patří položce první cena za znakem <.
  return toNumber(markerMatches[0][1]);
}

function makeOffer(productDef, block) {
  const price = actionPriceFromBlock(block);
  if (price == null) return null;

  const product = productNameFromBlock(block, productDef);
  const packageSize = packageSizeFromBlock(block);
  const unit = unitPriceFromBlock(block);
  const searchTerms = unique([productDef.category, ...(productDef.searchTerms ?? [])].filter(Boolean));

  return {
    id: `penny-page20-v4-${hashId([PAGE_NUMBER, product, price])}`,
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
    confidence: "high-page20-parser",
    suspect: true,
    suspectReasons: ["candidate z cíleného parseru stránky 20 v4 – ověřit proti letáku"],
    rawContext: block.slice(0, 900),
  };
}

function extractPage20Blocks(pageText) {
  const productDefs = PAGE20_PRODUCTS.map((def) => ({
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
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyPage20BeerOffersV4/0.1; +https://github.com/)",
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

  const blocks = extractPage20Blocks(pageText);
  const offers = blocks.map(({ productDef, block }) => makeOffer(productDef, block)).filter(Boolean);

  const output = {
    meta: {
      source: "Penny page 20 targeted parser v4",
      updatedAt: new Date().toISOString(),
      count: offers.length,
      note: "Cílený průzkumný výstup pro pivní/alkoholovou stranu 20. Položky jsou suspect=true.",
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
      beerCandidateOffers: offers.filter((offer) => offer.category === "pivo").length,
      alcoholCandidateOffers: offers.filter((offer) => offer.category === "alkohol").length,
      productsFound: offers.map((offer) => ({
        product: offer.product,
        priceText: offer.priceText,
        packageSize: offer.packageSize,
        unitPrice: offer.unitPrice,
        category: offer.category,
      })),
      missingBlocksWithoutActionPrice: blocks
        .filter(({ block }) => actionPriceFromBlock(block) == null)
        .map(({ productDef, block }) => ({ start: productDef.start, block })),
      recommendedPath:
        offers.filter((offer) => offer.category === "pivo").length >= 16
          ? "merge-page20-targeted-parser-into-penny-import-v2"
          : "inspect-page20-v4-before-merge",
    },
    offers,
    blocks: blocks.map(({ productDef, block }) => ({
      start: productDef.start,
      category: productDef.category,
      block,
    })),
    pageTextPreview: pageText.slice(0, 5000),
  };

  await writeFile(`${OUTPUT_DIR}/penny-page20-beer-offers-v4.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-page20-beer-offers-v4-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny page20 beer offers v4 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-page20-beer-offers-v4-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
