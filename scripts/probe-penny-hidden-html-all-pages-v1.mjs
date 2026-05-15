import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_COUNT = 37;
const VALID_TO = "19.05.2026";
const CURRENT_PENNY_DATA = "data/penny-leaflet-offers.json";

const PAGE20_TARGETS = [
  { start: "SKOTSKÁ WHISKY MC ILLROY", category: "alkohol" },
  { start: "OSTRAVAR MUSTANG", category: "pivo", searchTerms: ["pivo", "světlé pivo", "ležák"], allowPriceWithoutLt: true },
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

const CATEGORY_RULES = [
  { category: "pivo", terms: ["pivo", "ležák", "výčepní", "braník", "staropramen", "krušovice", "gambrinus", "radegast", "budvar", "kozel", "svijanský", "březňák", "mustang", "zubr", "holba", "staročech", "ostravar"] },
  { category: "alkohol", terms: ["whisky", "brandy", "rum", "vodka", "sekt", "prosecco", "% alk"] },
  { category: "uzeniny", terms: ["šunka", "salám", "klobása", "párek", "slanina", "řezníkův talíř", "uzené"] },
  { category: "maso", terms: ["kuře", "kuřecí", "vepřová", "hovězí", "krkovice", "maso", "mleté"] },
  { category: "mléčné", terms: ["mléko", "jogurt", "sýr", "gouda", "brie", "máslo", "tvaroh", "smetana"] },
  { category: "ovoce zelenina", terms: ["jablka", "banány", "rajčata", "okurka", "brambory", "salát", "paprika"] },
  { category: "pečivo", terms: ["chléb", "rohlík", "bageta", "houska", "koláč"] },
  { category: "mražené", terms: ["mražené", "zmrzlina", "filé", "hranolky"] },
  { category: "drogerie", terms: ["toaletní papír", "osvěžovač", "prací", "aviváž", "šampon", "zubní pasta", "jar", "tablety"] },
  { category: "nápoje", terms: ["limonáda", "minerální voda", "ondrášovka", "relax", "džus", "sirup", "cola"] },
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

  const bodyText = stripTags(decoded)
    .replace(/^.*?Nejnižší cena za posledních 30 dní/is, "Nejnižší cena za posledních 30 dní")
    .replace(/Made with FlippingBook[\s\S]*$/i, " ")
    .trim();

  if (bodyText.length > 300) paragraphs.push(bodyText);

  return unique(paragraphs);
}

function guessCategory(product = "", rawContext = "") {
  const combined = normalizeSearch(`${product} ${rawContext}`);
  for (const rule of CATEGORY_RULES) {
    if (rule.terms.some((term) => combined.includes(normalizeSearch(term)))) return rule.category;
  }
  return "";
}

function searchTermsFor(product = "", category = "") {
  const n = normalizeSearch(product);
  const terms = [category].filter(Boolean);

  if (category === "pivo") terms.push("pivo", "světlé pivo", "ležák", "výčepní pivo");
  if (/nealko|nealkohol/.test(n)) terms.push("nealkoholické");
  if (/cool/.test(n)) terms.push("radler", "míchaný nápoj");
  if (/sekt|prosecco/.test(n)) terms.push("sekt", "šumivé víno");
  if (/máslo|ghi|ghí/.test(n)) terms.push("máslo");

  return unique(terms);
}

function productNameFromBlock(block, productDef = null) {
  const firstPackageMarker = block.search(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|plech|sklo|svazek|role|rolí|m)\b/iu);
  let product = firstPackageMarker > 0 ? block.slice(0, firstPackageMarker) : block;

  product = product
    .replace(/\*/g, "")
    .replace(/\|\s*$/g, "")
    .replace(/,\s*$/g, "")
    .replace(/\brůzné druhy\s+.*$/iu, "různé druhy")
    .replace(/\bv nabídce také\b.*$/iu, "")
    .replace(/\bNabídka platná\b.*$/iu, "")
    .replace(/\bNejnižší cena za posledních 30 dní\b.*$/iu, "")
    .replace(/\bMOJE PENNY KARTA\b.*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (productDef && normalizeSearch(productDef.start) === "cool" && /^COOL\b/i.test(product)) return "COOL různé druhy";

  return product;
}

function packageSizeFromBlock(block) {
  const match = block.match(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|plech|sklo|role|rolí|m)\b/iu);
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

function actionPriceFromBlock(block, allowFallback = false) {
  const markerMatches = [...block.matchAll(/<\s*(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];
  if (markerMatches.length) return toNumber(markerMatches[0][1]);

  if (!allowFallback) return null;

  const fallback = [...block.matchAll(/\bza\s+(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];
  if (fallback.length) return toNumber(fallback[fallback.length - 1][1]);

  return null;
}

function makeOffer({ product, price, pageNumber, rawContext, category = "", searchTerms = [], confidence = "candidate" }) {
  const finalCategory = category || guessCategory(product, rawContext);
  const finalTerms = unique([finalCategory, ...searchTermsFor(product, finalCategory), ...searchTerms].filter(Boolean));
  const packageSize = packageSizeFromBlock(rawContext);
  const unit = unitPriceFromBlock(rawContext);

  return {
    id: `penny-hidden-all-v1-${hashId([pageNumber, product, price])}`,
    chain: "Penny",
    storeId: "penny-letak",
    storeName: "Penny – leták",
    product,
    brand: "",
    description: finalTerms.join(" · "),
    packageSize,
    price,
    priceText: moneyText(price),
    unitPrice: unit.unitPrice,
    unit: unit.unit,
    validTo: VALID_TO,
    pageNumber,
    imageUrl: "",
    pageImageUrl: `${BASE}/${pageNumber}/files/assets/cover300.jpg`,
    imageType: "penny-page",
    sourceUrl: `${BASE}/${pageNumber}/index.html`,
    category: finalCategory,
    searchTerms: finalTerms,
    compareKey: finalCategory || normalizeSearch(product),
    confidence,
    suspect: true,
    suspectReasons: ["candidate z komplexního hidden HTML průzkumu – před ostrým importem zkontrolovat"],
    rawContext: rawContext.slice(0, 1000),
  };
}

function hasBadProductName(product) {
  if (!product || product.length < 4) return true;
  if (/^\d|^Kč\b|^1\s*(l|kg|m)\b/iu.test(product)) return true;
  if (/^(Nabídka|Cena|Super|Nejnižší|nízké|Kč|původem|ilustrační foto|strana)$/iu.test(product)) return true;
  if (product.length > 110) return true;
  return false;
}

function genericExtractOffers(pageText, pageNumber) {
  const offers = [];
  const priceMarkers = [...pageText.matchAll(/<\s*(\d{1,4}[,.]\d{1,2})\s*Kč/giu)];

  for (const marker of priceMarkers) {
    const price = toNumber(marker[1]);
    if (price == null || price <= 0 || price > 9999) continue;

    const start = Math.max(0, (marker.index ?? 0) - 220);
    const end = Math.min(pageText.length, (marker.index ?? 0) + marker[0].length + 120);
    const rawContext = normalizeText(pageText.slice(start, end));

    let before = normalizeText(pageText.slice(start, marker.index ?? 0));

    // Zkus vzít poslední produktový segment po předchozí ceně/procentech.
    before = before
      .replace(/^.*\b\d{1,4}[,.]\d{1,2}\s*Kč\s*/u, "")
      .replace(/^.*\b\d{1,4}[,.]\d{1,2}\s*\/\s*\d{1,3}%\s*/u, "")
      .replace(/^.*\b\d{1,3}\s*%\s*/u, "")
      .trim();

    let product = productNameFromBlock(before);
    if (hasBadProductName(product)) continue;

    offers.push(makeOffer({
      product,
      price,
      pageNumber,
      rawContext,
      confidence: "generic-hidden-html",
    }));
  }

  return offers;
}

function targetedPage20Offers(pageText) {
  const productDefs = PAGE20_TARGETS.map((def) => ({
    ...def,
    regex: new RegExp(`\\b${escapeRegex(def.start)}\\b`, "iu"),
  }));

  const positions = [];
  for (const def of productDefs) {
    const match = pageText.match(def.regex);
    if (!match || match.index == null) continue;
    positions.push({ startIndex: match.index, productDef: def });
  }

  positions.sort((a, b) => a.startIndex - b.startIndex);

  const offers = [];
  const blocks = [];

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    const endIndex = i + 1 < positions.length ? positions[i + 1].startIndex : pageText.length;
    const block = normalizeText(pageText.slice(position.startIndex, endIndex));
    const productDef = position.productDef;
    const price = actionPriceFromBlock(block, Boolean(productDef.allowPriceWithoutLt));

    blocks.push({
      start: productDef.start,
      category: productDef.category,
      price,
      block,
    });

    if (price == null) continue;

    const product = productNameFromBlock(block, productDef);
    offers.push(makeOffer({
      product,
      price,
      pageNumber: 20,
      rawContext: block,
      category: productDef.category,
      searchTerms: productDef.searchTerms ?? [],
      confidence: "targeted-page20",
    }));
  }

  return { offers, blocks };
}

function dedupeOffers(offers) {
  const best = new Map();

  for (const offer of offers) {
    const key = `${offer.pageNumber}|${normalizeSearch(offer.product)}|${offer.price}`;
    const existing = best.get(key);
    if (!existing || scoreOffer(offer) > scoreOffer(existing)) best.set(key, offer);
  }

  return Array.from(best.values());
}

function scoreOffer(offer) {
  let score = 0;
  if (offer.confidence === "targeted-page20") score += 100;
  if (offer.category) score += 10;
  if (offer.packageSize) score += 5;
  if (offer.unitPrice != null) score += 3;
  score -= Math.max(0, offer.product.length - 70) / 10;
  return score;
}

async function fetchPage(pageNumber) {
  const url = `${BASE}/${pageNumber}/index.html`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyHiddenHtmlAllPagesV1/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  return {
    pageNumber,
    url,
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

async function loadCurrentPennyOffers() {
  try {
    const text = await readFile(CURRENT_PENNY_DATA, "utf8");
    const json = JSON.parse(text);
    if (Array.isArray(json.offers)) return json.offers;
    if (Array.isArray(json)) return json;
  } catch {
    return [];
  }
  return [];
}

function offerKey(offer) {
  return normalizeSearch([offer.product, offer.name, offer.title].filter(Boolean).join(" "));
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const currentOffers = await loadCurrentPennyOffers();
  const currentKeys = new Set(currentOffers.map(offerKey).filter(Boolean));

  const pages = [];
  const allOffers = [];

  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
    const page = await fetchPage(pageNumber);
    const paragraphs = extractParagraphs(page.text);
    const pageText = paragraphs.join(" ");

    const genericOffers = genericExtractOffers(pageText, pageNumber);
    const targeted = pageNumber === 20 ? targetedPage20Offers(pageText) : { offers: [], blocks: [] };

    const offers = dedupeOffers([...genericOffers, ...targeted.offers]);
    allOffers.push(...offers);

    const probablyNewOffers = offers.filter((offer) => !currentKeys.has(offerKey(offer)));

    pages.push({
      pageNumber,
      ok: page.ok,
      status: page.status,
      paragraphCount: paragraphs.length,
      pageTextLength: pageText.length,
      genericOffersCount: genericOffers.length,
      targetedOffersCount: targeted.offers.length,
      totalOffersCount: offers.length,
      beerOffersCount: offers.filter((offer) => offer.category === "pivo").length,
      probablyNewOffersCount: probablyNewOffers.length,
      probablyNewOfferSample: probablyNewOffers.slice(0, 20).map((offer) => ({
        product: offer.product,
        priceText: offer.priceText,
        category: offer.category,
        confidence: offer.confidence,
      })),
      targetedBlocks: targeted.blocks,
      offers: offers.slice(0, 80),
      pageTextPreview: pageText.slice(0, 2500),
    });
  }

  const deduped = dedupeOffers(allOffers);
  const probablyNew = deduped.filter((offer) => !currentKeys.has(offerKey(offer)));

  const output = {
    meta: {
      source: "Penny hidden HTML all pages v1",
      updatedAt: new Date().toISOString(),
      count: deduped.length,
      probablyNewCount: probablyNew.length,
      note: "Komplexní průzkumný výstup přes všech 37 stran. Položky jsou suspect=true; nejde ještě o ostrý import.",
    },
    offers: deduped,
  };

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      pagesChecked: PAGE_COUNT,
      currentPennyOffersLoaded: currentOffers.length,
      totalCandidateOffers: deduped.length,
      probablyNewCandidateOffers: probablyNew.length,
      beerCandidateOffers: deduped.filter((offer) => offer.category === "pivo").length,
      page20CandidateOffers: pages.find((page) => page.pageNumber === 20)?.totalOffersCount ?? 0,
      page20BeerCandidateOffers: pages.find((page) => page.pageNumber === 20)?.beerOffersCount ?? 0,
      pagesWithManyNewCandidates: pages
        .filter((page) => page.probablyNewOffersCount >= 5)
        .map((page) => ({
          pageNumber: page.pageNumber,
          probablyNewOffersCount: page.probablyNewOffersCount,
          totalOffersCount: page.totalOffersCount,
          beerOffersCount: page.beerOffersCount,
        })),
      recommendedPath:
        probablyNew.length >= 40
          ? "inspect-all-pages-candidates-then-build-penny-import-v2"
          : "improve-generic-parser-before-import-v2",
    },
    page20Summary: pages.find((page) => page.pageNumber === 20),
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      paragraphCount: page.paragraphCount,
      pageTextLength: page.pageTextLength,
      genericOffersCount: page.genericOffersCount,
      targetedOffersCount: page.targetedOffersCount,
      totalOffersCount: page.totalOffersCount,
      beerOffersCount: page.beerOffersCount,
      probablyNewOffersCount: page.probablyNewOffersCount,
      probablyNewOfferSample: page.probablyNewOfferSample,
    })),
    probablyNewSample: probablyNew.slice(0, 200).map((offer) => ({
      pageNumber: offer.pageNumber,
      product: offer.product,
      priceText: offer.priceText,
      packageSize: offer.packageSize,
      category: offer.category,
      confidence: offer.confidence,
      rawContext: offer.rawContext,
    })),
  };

  await writeFile(`${OUTPUT_DIR}/penny-hidden-html-all-pages-v1.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-hidden-html-all-pages-v1-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny hidden HTML all pages v1 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-hidden-html-all-pages-v1-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
