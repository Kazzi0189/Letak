import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const OFFERS_PATH = "data/offers.json";
const PDF_PAGES_PATH = "data/penny-pdf-pages.json";

const TARGETS = [
  {
    label: "Trvanlivé mléko Boni",
    expectedPage: 4,
    queryVariants: [
      "TRVANLIVÉ MLÉKO BONI",
      "TRVANLIVÉ MLÉKO",
      "MLÉKO BONI",
    ],
    productHint: "TRVANLIVÉ MLÉKO BONI",
    category: "mléčné a chlazené",
    searchTerms: ["mléko", "trvanlivé mléko", "Boni"],
  },
  {
    label: "Mléko čerstvé Karlova Koruna",
    expectedPage: 5,
    queryVariants: [
      "MLÉKO ČERSTVÉ 3,5% KARLOVA KORUNA",
      "MLÉKO ČERSTVÉ",
      "ČERSTVÉ 3,5% KARLOVA KORUNA",
    ],
    productHint: "MLÉKO ČERSTVÉ 3,5% KARLOVA KORUNA",
    category: "mléčné a chlazené",
    searchTerms: ["mléko", "čerstvé mléko", "Karlova Koruna"],
  },
  {
    label: "Trvanlivé plnotučné mléko Madeta",
    expectedPage: 32,
    queryVariants: [
      "TRVANLIVÉ PLNOTUČNÉ MLÉKO MADETA",
      "TRVANLIVÉ PLNOTUČNÉ MLÉKO",
      "MLÉKO MADETA",
    ],
    productHint: "TRVANLIVÉ PLNOTUČNÉ MLÉKO MADETA",
    category: "mléčné a chlazené",
    searchTerms: ["mléko", "plnotučné mléko", "Madeta"],
  },
  {
    label: "Woolite page24 context",
    expectedPage: 24,
    queryVariants: [
      "GEL NA PRANÍ WOOLITE",
      "WOOLITE",
    ],
    productHint: "GEL NA PRANÍ WOOLITE",
    category: "drogerie",
    searchTerms: ["drogerie", "praní", "Woolite"],
  },
];

const PAGE_SAMPLE_PAGES = [1, 4, 5, 18, 24, 26, 27, 29, 32];

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\r?\n/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(value) {
  const number = Number(String(value).replace(/\s+/g, "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function moneyText(price) {
  if (price == null || Number.isNaN(price)) return "";
  return price.toLocaleString("cs-CZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " Kč";
}

function packageSizeFromContext(context) {
  const matches = [...String(context).matchAll(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|role)\b/giu)]
    .map((match) => match[0].replace(/\s+/g, " "));
  const preferred = matches.find((value) => /\b(?:ml|l|g|kg|ks)\b/iu.test(value));
  return preferred ?? matches[0] ?? "";
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function extractOffers(container) {
  if (Array.isArray(container)) return container;
  if (Array.isArray(container?.offers)) return container.offers;
  if (Array.isArray(container?.items)) return container.items;
  if (Array.isArray(container?.data)) return container.data;
  return [];
}

function extractPages(container) {
  const rawPages = Array.isArray(container)
    ? container
    : Array.isArray(container?.pages)
      ? container.pages
      : Array.isArray(container?.data)
        ? container.data
        : [];

  return rawPages
    .map((page, index) => {
      const pageNumber = Number(page.pageNumber ?? page.page ?? page.number ?? index + 1);
      const text = String(page.text ?? page.content ?? page.rawText ?? page.pageText ?? "");
      return { pageNumber, text };
    })
    .filter((page) => Number.isFinite(page.pageNumber) && page.text.trim());
}

function offerProduct(offer) {
  return String(offer.product ?? offer.name ?? offer.title ?? "").trim();
}

function isPennyOffer(offer) {
  const text = normalizeSearch([
    offer.chain,
    offer.storeName,
    offer.storeId,
    offer.source,
    offer.sourceName,
  ].filter(Boolean).join(" "));
  return text.includes("penny");
}

function offerPage(offer) {
  const direct = Number(offer.pageNumber ?? offer.page ?? offer.leafletPage ?? "");
  if (Number.isFinite(direct) && direct > 0) return direct;
  const sourceUrl = String(offer.sourceUrl ?? "");
  const match = sourceUrl.match(/\/(\d+)\/index\.html/i);
  return match ? Number(match[1]) : null;
}

function searchableOfferText(offer) {
  return normalizeSearch([
    offer.product,
    offer.name,
    offer.title,
    offer.brand,
    offer.description,
    offer.category,
    offer.searchTerms,
    offer.compareKey,
  ].flat().filter(Boolean).join(" "));
}

function findNormalizedIndex(originalText, normalizedNeedle) {
  // Přesnost převodu indexů není nutná; vracíme nejlepší pozici přes běžné varianty.
  const original = String(originalText);
  const directNeedles = [
    normalizedNeedle,
    normalizedNeedle.replace(/\s+/g, " "),
  ];

  for (const needle of directNeedles) {
    const words = needle.split(" ").filter(Boolean);
    if (!words.length) continue;

    const flexible = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]{0,80}");
    const regex = new RegExp(flexible, "iu");
    const match = original.normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(regex);
    if (match?.index != null) return match.index;
  }

  return -1;
}

function contextAround(text, index, radius = 650) {
  if (index < 0) return "";
  return compactText(text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius)));
}

function extractPricesFromContext(context) {
  const prices = [];
  const regex = /(?<![<\d])\b(\d{1,4}[,.]\d{2})\b(?!\s*\/)(?!\s*%)/gu;
  let match;
  while ((match = regex.exec(context))) {
    const before = context.slice(Math.max(0, match.index - 35), match.index);
    const after = context.slice(match.index + match[0].length, match.index + match[0].length + 18);
    const price = parsePrice(match[1]);

    if (price == null || price < 1 || price > 9999) continue;

    const isLowest30 = /<\s*$/u.test(before) || /nejnižší cena/iu.test(before);
    const isUnitPrice = /^\s*(Kč\s*)?(\/|za\s*1|1\s*(?:l|kg|g|ks)|Kč\s*\/)/iu.test(after) || /\b(?:100\s*g|1\s*l|1\s*kg|1\s*ks)\s*$/iu.test(before);
    const isDummy = match[1] === "00,00";

    prices.push({
      price,
      priceText: moneyText(price),
      index: match.index,
      isLowest30,
      isUnitPrice,
      isDummy,
      nearby: compactText(context.slice(Math.max(0, match.index - 90), Math.min(context.length, match.index + 90))),
    });
  }

  return prices;
}

function pickCurrentPrice(prices) {
  const usable = prices.filter((item) => !item.isLowest30 && !item.isUnitPrice && !item.isDummy);
  if (!usable.length) return null;

  // U targeted kontextu většinou první použitelná cena odpovídá aktuální ceně bloku.
  return usable[0];
}

function buildTargetCandidate(target, page, context) {
  const prices = extractPricesFromContext(context);
  const picked = pickCurrentPrice(prices);
  const packageSize = packageSizeFromContext(context);

  return {
    id: `penny-pdf-target-v2-${sha1([target.expectedPage, target.productHint, picked?.price ?? ""].join("|"))}`,
    chain: "Penny",
    storeId: "penny-letak",
    storeName: "Penny – leták",
    product: target.productHint,
    price: picked?.price ?? null,
    priceText: picked?.priceText ?? "",
    packageSize,
    category: target.category,
    pageNumber: target.expectedPage,
    searchTerms: Array.from(new Set([target.category, ...target.searchTerms].filter(Boolean))),
    confidence: picked ? "targeted-pdf-context-v2-price-candidate" : "targeted-pdf-context-v2-no-price",
    suspect: true,
    suspectReasons: [
      "kontrolní kandidát z cíleného PDF kontextu – před importem ověřit proti letáku",
      picked ? "" : "nepodařilo se bezpečně určit aktuální cenu",
    ].filter(Boolean),
    priceCandidates: prices,
    rawContext: context,
  };
}

function inspectTarget(target, pages, pennyOffers) {
  const expectedPage = pages.find((page) => page.pageNumber === target.expectedPage);
  const allFoundPages = [];

  for (const page of pages) {
    const pageNorm = normalizeSearch(page.text);
    if (target.queryVariants.some((variant) => pageNorm.includes(normalizeSearch(variant)))) {
      allFoundPages.push(page.pageNumber);
    }
  }

  const currentMatches = pennyOffers.filter((offer) =>
    offerPage(offer) === target.expectedPage &&
    target.queryVariants.some((variant) => searchableOfferText(offer).includes(normalizeSearch(variant)))
  );

  let bestVariant = "";
  let bestIndex = -1;
  let context = "";

  if (expectedPage) {
    for (const variant of target.queryVariants) {
      const index = findNormalizedIndex(expectedPage.text, normalizeSearch(variant));
      if (index >= 0) {
        bestVariant = variant;
        bestIndex = index;
        context = contextAround(expectedPage.text, index);
        break;
      }
    }
  }

  const candidate = context ? buildTargetCandidate(target, expectedPage, context) : null;

  return {
    label: target.label,
    expectedPage: target.expectedPage,
    queryVariants: target.queryVariants,
    foundPages: allFoundPages,
    foundInExpectedPage: allFoundPages.includes(target.expectedPage),
    currentMatches: currentMatches.length,
    currentSamples: currentMatches.slice(0, 5).map((offer) => ({
      product: offerProduct(offer),
      price: offer.price ?? null,
      priceText: offer.priceText ?? "",
      packageSize: offer.packageSize ?? "",
      category: offer.category ?? "",
      pageNumber: offerPage(offer),
    })),
    bestVariant,
    contextFound: Boolean(context),
    context,
    candidate,
    status: currentMatches.length
      ? "already-in-current-offers"
      : candidate?.price != null
        ? "targeted-candidate-with-price"
        : candidate
          ? "targeted-candidate-needs-price-review"
          : "target-not-found-by-v2",
  };
}

function suspiciousLine(line) {
  const clean = compactText(line);
  if (!clean) return true;
  if (/^<?\s*\d{1,4}[,.]\d{2}\s*Kč?$/iu.test(clean)) return true;
  if (/^\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks|%)\b/iu.test(clean)) return true;
  if (/^1\s*(?:l|kg|ks|g)\s+\d/iu.test(clean)) return true;
  if (/nejnižší cena|info@penny|800 202 220|nízké ceny|moje penny karta/iu.test(clean)) return true;
  if (/^<\s*\d/iu.test(clean)) return true;
  return false;
}

function pageSample(page) {
  const lines = page.text
    .split(/\r?\n/)
    .map(compactText)
    .filter(Boolean);

  const interesting = lines
    .filter((line) => !suspiciousLine(line))
    .filter((line) => /\p{Lu}/u.test(line))
    .slice(0, 80);

  return {
    pageNumber: page.pageNumber,
    textLength: page.text.length,
    lineCount: lines.length,
    interestingLineCount: interesting.length,
    firstInterestingLines: interesting.slice(0, 40),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const offersContainer = await loadJson(OFFERS_PATH);
  const pdfPagesContainer = await loadJson(PDF_PAGES_PATH);

  const offers = extractOffers(offersContainer);
  const pennyOffers = offers.filter(isPennyOffer);
  const pages = extractPages(pdfPagesContainer);

  const targetInspections = TARGETS.map((target) => inspectTarget(target, pages, pennyOffers));
  const pageSamples = pages
    .filter((page) => PAGE_SAMPLE_PAGES.includes(page.pageNumber))
    .map(pageSample);

  const candidateWithPrice = targetInspections.filter((item) => item.status === "targeted-candidate-with-price");
  const candidateNeedsReview = targetInspections.filter((item) => item.status === "targeted-candidate-needs-price-review");
  const alreadyInOffers = targetInspections.filter((item) => item.status === "already-in-current-offers");

  const report = {
    checkedAt: new Date().toISOString(),
    type: "JEN KONTROLNÍ REPORT – DO APLIKACE NENAHRÁVAT",
    summary: {
      pdfPages: pages.length,
      totalOffers: offers.length,
      pennyOffers: pennyOffers.length,
      targetCount: TARGETS.length,
      alreadyInOffers: alreadyInOffers.length,
      targetedCandidatesWithPrice: candidateWithPrice.length,
      targetedCandidatesNeedReview: candidateNeedsReview.length,
      targetNotFoundByV2: targetInspections.filter((item) => item.status === "target-not-found-by-v2").length,
      recommendedPath:
        candidateWithPrice.length >= 1
          ? "inspect-targeted-candidates-then-build-small-safe-patch"
          : "inspect-contexts-and-improve-normalized-context-matching",
    },
    targetInspections,
    pageSamples,
    safePatchCandidatePreview: candidateWithPrice.map((item) => item.candidate),
  };

  await writeFile(`${OUTPUT_DIR}/penny-pdf-target-gaps-v2-summary.json`, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("Penny PDF target gaps v2 finished.");
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
