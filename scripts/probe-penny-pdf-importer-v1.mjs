import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const OFFERS_PATH = "data/offers.json";
const PDF_PAGES_PATH = "data/penny-pdf-pages.json";

const TARGET_QUERIES = [
  { label: "Trvanlivé mléko Boni", query: "TRVANLIVÉ MLÉKO BONI", expectedPage: 4 },
  { label: "Mléko čerstvé Karlova Koruna", query: "MLÉKO ČERSTVÉ 3,5% KARLOVA KORUNA", expectedPage: 5 },
  { label: "Trvanlivé plnotučné mléko Madeta", query: "TRVANLIVÉ PLNOTUČNÉ MLÉKO MADETA", expectedPage: 32 },
  { label: "Prosecco", query: "PROSECCO bílé perlivé", expectedPage: 20 },
  { label: "Braník", query: "BRANÍK", expectedPage: 20 },
  { label: "Woolite", query: "GEL NA PRANÍ WOOLITE", expectedPage: 35 },
  { label: "Kristalon", query: "HNOJIVO KRISTALON", expectedPage: 28 },
];

const PAGE_CATEGORY_HINTS = [
  { pages: [4, 5, 6, 12, 14, 32], category: "mléčné a chlazené", terms: ["mléko", "jogurt", "sýr", "chlazené"] },
  { pages: [18, 19, 20, 21], category: "nápoje a alkohol", terms: ["nápoje", "alkohol", "pivo", "víno"] },
  { pages: [23], category: "káva", terms: ["káva", "instantní káva", "mletá káva", "zrnková káva"] },
  { pages: [24, 25, 33, 34, 35], category: "drogerie", terms: ["drogerie", "praní", "úklid", "hygiena"] },
  { pages: [26], category: "zvířata", terms: ["zvířata", "pes", "kočka", "krmivo"] },
  { pages: [27, 28, 29], category: "zahrada", terms: ["zahrada", "hnojivo", "substrát"] },
];

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

function titleLike(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function moneyText(price) {
  if (price == null || Number.isNaN(price)) return "";
  return price.toLocaleString("cs-CZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " Kč";
}

function parsePrice(value) {
  const number = Number(String(value).replace(/\s+/g, "").replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function packageSizeFromText(text) {
  const matches = [...String(text).matchAll(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|role|m)\b/giu)]
    .map((match) => match[0].replace(/\s+/g, " "));
  const preferred = matches.find((value) => /\b(?:ml|l|g|kg|ks|balení)\b/iu.test(value));
  return preferred ?? matches[0] ?? "";
}

function getCategoryForPage(pageNumber, productText = "") {
  for (const hint of PAGE_CATEGORY_HINTS) {
    if (hint.pages.includes(pageNumber)) {
      return hint;
    }
  }

  const text = normalizeSearch(productText);
  if (/pivo|lezak|výcepni|vycepni|alk|vino|sekt|prosecco|whisky|rum|fernet/.test(text)) {
    return { category: "nápoje a alkohol", terms: ["nápoje", "alkohol", "pivo", "víno"] };
  }
  if (/kava|cappuccino|espresso|casablanca|jacobs|nescafe|jihlavanka/.test(text)) {
    return { category: "káva", terms: ["káva"] };
  }
  if (/prani|praci|gel|prasek|avivaz|jar|tablety do mycky|ubrousky|sprchovy|sampon/.test(text)) {
    return { category: "drogerie", terms: ["drogerie"] };
  }
  if (/mleko|jogurt|syr|tvaroh|smetan/.test(text)) {
    return { category: "mléčné a chlazené", terms: ["mléko", "jogurt", "sýr"] };
  }
  return { category: "", terms: [] };
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

function matchesExistingOffer(offer, productText, pageNumber) {
  const productNorm = normalizeSearch(productText);
  if (!productNorm) return false;

  return offerPage(offer) === pageNumber && (
    searchableOfferText(offer).includes(productNorm) ||
    productNorm.includes(normalizeSearch(offerProduct(offer)))
  );
}

function lineClean(line) {
  return String(line)
    .replace(/\u00a0/g, " ")
    .replace(/[•●]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLines(pageText) {
  return String(pageText)
    .split(/\r?\n|(?<=Kč)\s+(?=[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9])/gu)
    .map(lineClean)
    .filter(Boolean);
}

function isLikelyProductLine(line) {
  const clean = lineClean(line);
  if (clean.length < 4 || clean.length > 180) return false;
  if (/^(nabídka|jedinečná|super cena|nejnižší cena|platí|www\.|cena za|běžně za)/iu.test(clean)) return false;
  if (/^\d{1,4}[,.]\d{2}\s*(Kč|\/|$)/iu.test(clean)) return false;
  if (/^\d+\s*%$/u.test(clean)) return false;

  const letters = clean.match(/\p{L}/gu) ?? [];
  const uppercaseLetters = clean.match(/\p{Lu}/gu) ?? [];
  const uppercaseRatio = letters.length ? uppercaseLetters.length / letters.length : 0;

  return uppercaseRatio > 0.45 || /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9][A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9\s,./&+\-%()]+/u.test(clean);
}

function currentPricesFromText(text) {
  const prices = [];
  const regex = /(?:^|[^\d<])(\d{1,4}[,.]\d{2})(?!\s*\/)(?!\s*%)/gu;
  let match;
  while ((match = regex.exec(text))) {
    const before = text.slice(Math.max(0, match.index - 25), match.index + match[0].length);
    if (/<\s*$/.test(before) || /nejnižší cena|běžně za/iu.test(before)) continue;
    const price = parsePrice(match[1]);
    if (price != null && price >= 1 && price <= 9999) {
      prices.push({ price, priceText: moneyText(price), index: match.index });
    }
  }
  return prices;
}

function makeCandidate(product, pageNumber, price = null, context = "") {
  const categoryHint = getCategoryForPage(pageNumber, product);
  const packageSize = packageSizeFromText(product + " " + context);
  const cleanProduct = titleLike(product)
    .replace(/^\d{1,4}[,.]\d{2}\s+/, "")
    .replace(/\s*\|\s*$/, "")
    .replace(/\s+<\s*\d{1,4}[,.]\d{2}\s*Kč.*$/iu, "")
    .trim();

  return {
    id: `penny-pdf-probe-v1-${sha1([pageNumber, cleanProduct, price ?? ""].join("|"))}`,
    chain: "Penny",
    storeId: "penny-letak",
    storeName: "Penny – leták",
    product: cleanProduct,
    price,
    priceText: price != null ? moneyText(price) : "",
    packageSize,
    category: categoryHint.category,
    pageNumber,
    searchTerms: Array.from(new Set([categoryHint.category, ...categoryHint.terms, ...cleanProduct.split(/\s+/).slice(0, 4)].filter(Boolean))),
    confidence: price != null ? "pdf-text-probe-v1-with-nearby-price" : "pdf-text-probe-v1-product-only",
    suspect: true,
    suspectReasons: [
      "kontrolní kandidát z PDF textu – před importem ověřit vzorek proti letáku",
      price == null ? "cena nebyla spárována" : "",
    ].filter(Boolean),
    rawContext: context.slice(0, 700),
  };
}

function extractCandidatesFromPage(page) {
  const lines = getLines(page.text);
  const priceList = currentPricesFromText(page.text);

  const productLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isLikelyProductLine(line)) continue;

    const maybeNext = lines[i + 1] ?? "";
    const joined = /,$|\b(různé|vybrané|mletá|instantní|plech|mražená)$/iu.test(line)
      ? `${line} ${maybeNext}`
      : line;

    productLines.push({
      product: joined,
      lineIndex: i,
      context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 4)).join(" | "),
    });
  }

  // Konzervativně spárujeme pořadím. U stránek typu „jedinečná“ to nebude vždy přesné,
  // proto je celý výstup zatím pouze kontrolní.
  const paired = productLines.map((item, index) => {
    const price = priceList[index]?.price ?? null;
    return makeCandidate(item.product, page.pageNumber, price, item.context);
  });

  // Odstranění hrubých duplicit podle stránky a názvu.
  const seen = new Set();
  const unique = [];
  for (const candidate of paired) {
    const key = `${candidate.pageNumber}|${normalizeSearch(candidate.product)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

function findTargetsInPdf(pages) {
  return TARGET_QUERIES.map((target) => {
    const targetNorm = normalizeSearch(target.query);
    const foundPages = pages
      .filter((page) => normalizeSearch(page.text).includes(targetNorm))
      .map((page) => page.pageNumber);

    return {
      ...target,
      foundPages,
      foundInExpectedPage: foundPages.includes(target.expectedPage),
    };
  });
}

function pageCountMap(offers) {
  const map = new Map();
  for (const offer of offers) {
    const page = offerPage(offer);
    if (!page) continue;
    map.set(page, (map.get(page) ?? 0) + 1);
  }
  return Object.fromEntries(Array.from(map.entries()).sort((a, b) => a[0] - b[0]));
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const offersContainer = await loadJson(OFFERS_PATH);
  const pdfPagesContainer = await loadJson(PDF_PAGES_PATH);

  const offers = extractOffers(offersContainer);
  const pennyOffers = offers.filter(isPennyOffer);
  const pages = extractPages(pdfPagesContainer);

  const allCandidates = pages.flatMap(extractCandidatesFromPage);

  const newCandidateSuggestions = [];
  const existingCandidateSuggestions = [];

  for (const candidate of allCandidates) {
    const exists = pennyOffers.some((offer) => matchesExistingOffer(offer, candidate.product, candidate.pageNumber));
    if (exists) {
      existingCandidateSuggestions.push(candidate);
    } else {
      newCandidateSuggestions.push(candidate);
    }
  }

  const targetResults = findTargetsInPdf(pages).map((target) => {
    const currentMatches = pennyOffers.filter((offer) => normalizeSearch(searchableOfferText(offer)).includes(normalizeSearch(target.query)));
    const candidateMatches = allCandidates.filter((candidate) => normalizeSearch(candidate.product).includes(normalizeSearch(target.query)));

    return {
      ...target,
      currentMatches: currentMatches.length,
      candidateMatches: candidateMatches.length,
      currentSamples: currentMatches.slice(0, 5).map((offer) => ({
        product: offerProduct(offer),
        price: offer.price ?? null,
        priceText: offer.priceText ?? "",
        packageSize: offer.packageSize ?? "",
        category: offer.category ?? "",
        pageNumber: offerPage(offer),
      })),
      candidateSamples: candidateMatches.slice(0, 10),
      status: currentMatches.length ? "already-in-current-offers" : candidateMatches.length ? "candidate-found-in-pdf-extraction" : "pdf-target-not-extracted-yet",
    };
  });

  const candidatesByPage = {};
  for (const candidate of newCandidateSuggestions) {
    const key = String(candidate.pageNumber);
    if (!candidatesByPage[key]) candidatesByPage[key] = [];
    candidatesByPage[key].push(candidate);
  }

  const pageReports = pages.map((page) => {
    const pageCandidates = allCandidates.filter((candidate) => candidate.pageNumber === page.pageNumber);
    const newCandidates = newCandidateSuggestions.filter((candidate) => candidate.pageNumber === page.pageNumber);
    const currentCount = pennyOffers.filter((offer) => offerPage(offer) === page.pageNumber).length;
    return {
      pageNumber: page.pageNumber,
      pdfTextLength: page.text.length,
      extractedCandidates: pageCandidates.length,
      newCandidateSuggestions: newCandidates.length,
      currentPennyOffers: currentCount,
      sampleNewCandidates: newCandidates.slice(0, 12),
    };
  });

  const output = {
    checkedAt: new Date().toISOString(),
    type: "JEN KONTROLNÍ REPORT – DO APLIKACE NENAHRÁVAT",
    summary: {
      pdfPages: pages.length,
      totalOffers: offers.length,
      pennyOffers: pennyOffers.length,
      extractedPdfCandidates: allCandidates.length,
      existingCandidateSuggestions: existingCandidateSuggestions.length,
      newCandidateSuggestions: newCandidateSuggestions.length,
      targetAlreadyInOffers: targetResults.filter((item) => item.status === "already-in-current-offers").length,
      targetCandidateFound: targetResults.filter((item) => item.status === "candidate-found-in-pdf-extraction").length,
      targetNotExtractedYet: targetResults.filter((item) => item.status === "pdf-target-not-extracted-yet").length,
      recommendedPath: "inspect-targets-and-top-missing-pages-before-import",
    },
    currentPennyOffersByPage: pageCountMap(pennyOffers),
    targetResults,
    topMissingPages: pageReports
      .filter((page) => page.newCandidateSuggestions > 0)
      .sort((a, b) => b.newCandidateSuggestions - a.newCandidateSuggestions)
      .slice(0, 15),
    pageReports,
    newCandidateSuggestions: newCandidateSuggestions.slice(0, 500),
  };

  await writeFile(`${OUTPUT_DIR}/penny-pdf-importer-probe-v1-summary.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-pdf-importer-probe-v1-candidates.json`, JSON.stringify({
    meta: {
      generatedAt: new Date().toISOString(),
      note: "Kontrolní kandidáti z PDF textu. Není určeno k přímému importu do aplikace.",
      count: newCandidateSuggestions.length,
    },
    offers: newCandidateSuggestions,
  }, null, 2) + "\n", "utf8");

  console.log("Penny PDF importer probe v1 finished.");
  console.log(JSON.stringify(output.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
