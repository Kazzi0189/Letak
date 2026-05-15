import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_COUNT = 37;

const VALID_TO = "19.05.2026";

const PRODUCT_STOPWORDS = new Set([
  "Kč", "Cena", "Super", "Nabídka", "Platná", "Nejnižší", "Moje", "Penny", "Karta",
  "nízké", "ceny", "hezky", "česky", "od", "do", "úterý", "středy", "pátku", "neděle",
]);

const CATEGORY_RULES = [
  { category: "pivo", terms: ["pivo", "ležák", "výčepní", "braník", "staropramen", "krušovice", "gambrinus", "radegast", "budvar", "kozel", "svijanský", "březňák", "mustang", "zlatý bažant", "zubr", "holba", "staročech", "ostravar"] },
  { category: "alkohol", terms: ["whisky", "brandy", "rum", "vodka", "sekt", "prosecco", "% alk"] },
  { category: "uzeniny", terms: ["šunka", "salám", "klobása", "párek", "slanina", "řezníkův talíř"] },
  { category: "maso", terms: ["kuře", "vepřová", "hovězí", "krkovice", "maso"] },
  { category: "mléčné", terms: ["mléko", "jogurt", "sýr", "gouda", "brie", "máslo"] },
  { category: "mražené", terms: ["mražené", "zmrzlina", "filé"] },
  { category: "drogerie", terms: ["toaletní papír", "osvěžovač", "prací", "aviváž", "šampon", "zubní pasta"] },
  { category: "nápoje", terms: ["limonáda", "minerální voda", "ondrášovka", "relax", "džus"] },
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
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
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

function extractPageDescriptionParagraphs(html) {
  const decoded = decodeURIComponentSafe(decodeHtml(html));
  const paragraphs = [];
  let match;

  const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = pRegex.exec(decoded))) {
    const text = stripTags(match[1]);
    if (!text) continue;
    if (/Made with FlippingBook|publisher|schema\.org/i.test(text)) continue;
    if (text.length < 50) continue;
    paragraphs.push(text);
  }

  // FlippingBook někdy drží produktový text přímo v celém HTML mimo meta description.
  const bodyText = stripTags(decoded)
    .replace(/^.*?FBInit\.ZOOM_STEP\s*=\s*[^;]+;/is, " ")
    .replace(/Made with FlippingBook[\s\S]*$/i, " ")
    .trim();

  if (bodyText.length > 200) paragraphs.push(bodyText);

  return unique(paragraphs);
}

function cleanProductName(value = "") {
  let product = normalizeText(value)
    .replace(/^\d+\s*/, "")
    .replace(/^[<|/,\s]+/, "")
    .replace(/\bNabídka platná\b.*$/iu, "")
    .replace(/\bNejnižší cena za posledních 30 dní\b/giu, " ")
    .replace(/\bnízké ceny hezky česky\b/giu, " ")
    .replace(/\bSuper Cena!?/giu, " ")
    .replace(/\bnabídka Jedinečná\b/giu, " ")
    .replace(/\bMOJE PENNY KARTA\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Odstraň zbytky před skutečným názvem, pokud je před ním stará cenová šňůra.
  product = product.replace(/^.*?\b\d{1,4}[,.]\d{2}\s*Kč\s*/, "").trim();
  product = product.replace(/^.*?\b\d{1,4}[,.]\d{2}\s*\/\s*\d{1,3}%\s*/, "").trim();

  // Názvy často končí hvězdičkou.
  product = product.replace(/\*/g, "").trim();

  return product;
}

function guessCategory(product = "", rawContext = "") {
  const combined = normalizeSearch(`${product} ${rawContext}`);
  for (const rule of CATEGORY_RULES) {
    if (rule.terms.some((term) => combined.includes(normalizeSearch(term)))) return rule.category;
  }
  return "";
}

function packageSizeFromContext(text = "") {
  const match = text.match(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|role|rolí|m)\b/iu);
  return match ? match[0].replace(/\s+/g, " ") : "";
}

function unitPriceFromContext(text = "") {
  const match = text.match(/\b1\s*(?:l|kg|m|ks|100\s*g)\s+(\d{1,4}[,.]\d{1,2})\s*Kč/iu);
  if (!match) return { unitPrice: null, unit: "" };
  return {
    unitPrice: toNumber(match[1]),
    unit: match[0].match(/\b1\s*(l|kg|m|ks|100\s*g)\b/iu)?.[1]?.replace(/\s+/g, " ") ?? "",
  };
}

function searchTermsFor(product = "", category = "") {
  const n = normalizeSearch(product);
  const terms = [category].filter(Boolean);

  if (category === "pivo") terms.push("pivo", "světlé pivo", "ležák", "výčepní pivo");
  if (/nealko/.test(n)) terms.push("nealkoholické");
  if (/cool/.test(n)) terms.push("radler", "míchaný nápoj");
  if (/sekt|prosecco/.test(n)) terms.push("sekt", "šumivé víno");
  if (/máslo|ghí/.test(n)) terms.push("máslo");

  return unique(terms);
}

function hasBadProductName(product = "") {
  if (!product || product.length < 4) return true;
  if (/^\d|^Kč\b|^1\s*(l|kg|m)\b/iu.test(product)) return true;
  if (product.split(/\s+/).filter((word) => !PRODUCT_STOPWORDS.has(word)).length < 1) return true;
  if (/^(Nabídka|Cena|Super|Nejnižší|nízké|Kč|původem|ilustrační foto)$/iu.test(product)) return true;
  return false;
}

function makeOffer({ product, price, pageNumber, rawContext }) {
  const category = guessCategory(product, rawContext);
  const searchTerms = searchTermsFor(product, category);
  const packageSize = packageSizeFromContext(rawContext);
  const unit = unitPriceFromContext(rawContext);

  return {
    id: `penny-html-v2-${hashId([pageNumber, product, price])}`,
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
    pageNumber,
    imageUrl: "",
    pageImageUrl: `${BASE}/${pageNumber}/files/assets/cover300.jpg`,
    imageType: "penny-page",
    sourceUrl: `${BASE}/${pageNumber}/index.html`,
    category,
    searchTerms,
    compareKey: category || normalizeSearch(product),
    confidence: "medium",
    suspect: true,
    suspectReasons: ["candidate z full-html produktu – před ostrým importem zkontrolovat"],
    rawContext: rawContext.slice(0, 900),
  };
}

function extractOffersFromParagraph(paragraph, pageNumber) {
  const text = normalizeText(paragraph);
  const offers = [];

  // Segment: NÁZEV ... 1 l 19,80 Kč < 9,90 Kč
  // Bereme část před akční cenou a poslední cenu za znakem < jako hlavní cenu.
  const markerRegex = /<\s*(\d{1,4}[,.]\d{1,2})\s*Kč/giu;
  const markers = [...text.matchAll(markerRegex)];

  let previousEnd = 0;
  for (const marker of markers) {
    const markerStart = marker.index ?? 0;
    const markerEnd = markerStart + marker[0].length;
    const price = toNumber(marker[1]);
    if (price == null || price <= 0 || price > 9999) continue;

    const before = text.slice(Math.max(0, previousEnd - 80), markerStart).trim();
    previousEnd = markerEnd;

    // Odřízni poslední „staré ceny“ a vezmi produktový blok.
    let candidate = before
      .replace(/^.*(?:\b\d{1,4}[,.]\d{1,2}\s*\/\s*\d{1,3}%|\b\d{1,4}[,.]\d{1,2}\s*Kč)\s*/u, "")
      .trim();

    // Pokud jsou v kandidátovi dvě nabídky slepené, necháme poslední část po poslední hlavní ceně nebo procentu.
    candidate = candidate.replace(/^.*\b\d{1,4}[,.]\d{1,2}\s*Kč\s*/u, "").trim();

    const rawContext = normalizeText(candidate + " < " + marker[1] + " Kč");
    let product = cleanProductName(candidate);

    // Název ukonči u balení/jednotkové ceny.
    product = product
      .replace(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|role|rolí|m)\b.*$/iu, "")
      .replace(/\b1\s*(?:l|kg|m|ks|100\s*g)\b.*$/iu, "")
      .replace(/\bcena za\b.*$/iu, "")
      .replace(/\brůzné druhy\b.*$/iu, "různé druhy")
      .replace(/\s+/g, " ")
      .trim();

    if (hasBadProductName(product)) continue;

    offers.push(makeOffer({ product, price, pageNumber, rawContext }));
  }

  return offers;
}

function dedupeOffers(offers) {
  const best = new Map();

  for (const offer of offers) {
    const key = `${normalizeSearch(offer.product)}|${offer.price}|${offer.pageNumber}`;
    const existing = best.get(key);
    if (!existing || offer.rawContext.length > existing.rawContext.length) best.set(key, offer);
  }

  return Array.from(best.values());
}

async function fetchPage(pageNumber) {
  const url = `${BASE}/${pageNumber}/index.html`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyHiddenHtmlOffersV2/0.1; +https://github.com/)",
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

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pages = [];
  const allOffers = [];

  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
    const page = await fetchPage(pageNumber);
    const paragraphs = extractPageDescriptionParagraphs(page.text);

    const offers = dedupeOffers(
      paragraphs.flatMap((paragraph) => extractOffersFromParagraph(paragraph, pageNumber))
    );

    allOffers.push(...offers);

    pages.push({
      pageNumber,
      ok: page.ok,
      status: page.status,
      paragraphs: paragraphs.map((paragraph) => paragraph.slice(0, 2500)),
      offersCount: offers.length,
      beerOffersCount: offers.filter((offer) => offer.category === "pivo").length,
      offers: offers.slice(0, 80),
    });
  }

  const deduped = dedupeOffers(allOffers);

  const output = {
    meta: {
      source: "Penny full HTML text candidates v2",
      updatedAt: new Date().toISOString(),
      count: deduped.length,
      note: "Průzkumný kandidátní výstup. Položky jsou suspect=true; po kontrole z něj uděláme Penny import V2.",
    },
    offers: deduped,
  };

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      pagesChecked: PAGE_COUNT,
      totalCandidateOffers: deduped.length,
      beerCandidateOffers: deduped.filter((offer) => offer.category === "pivo").length,
      pagesWithCandidates: pages.filter((page) => page.offersCount > 0).map((page) => ({
        pageNumber: page.pageNumber,
        offersCount: page.offersCount,
        beerOffersCount: page.beerOffersCount,
      })),
      page20Candidates: pages.find((page) => page.pageNumber === 20)?.offersCount ?? 0,
      page20BeerCandidates: pages.find((page) => page.pageNumber === 20)?.beerOffersCount ?? 0,
      recommendedPath:
        (pages.find((page) => page.pageNumber === 20)?.beerOffersCount ?? 0) >= 10
          ? "inspect-candidates-then-wire-penny-import-v2"
          : "tighten-segment-parser-for-page-20",
    },
    page20Sample: pages.find((page) => page.pageNumber === 20)?.offers ?? [],
    sampleOffers: deduped.slice(0, 160),
    pages,
  };

  await writeFile(`${OUTPUT_DIR}/penny-hidden-html-offers-v2.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-hidden-html-offers-v2-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny hidden HTML offers v2 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-hidden-html-offers-v2-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
