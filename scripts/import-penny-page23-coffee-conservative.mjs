import { readFile, writeFile, mkdir } from "node:fs/promises";
import crypto from "node:crypto";

const PENNY_INPUT_PATH = "data/penny-leaflet-offers.json";
const PAGE23_PROBE_PATH = "data/penny-probe/penny-page23-coffee-probe-v3.json";
const PENNY_BACKUP_OUTPUT_PATH = "data/penny-leaflet-offers-before-page23-coffee-conservative.json";
const PENNY_OUTPUT_PATH = "data/penny-leaflet-offers.json";
const REPORT_OUTPUT_PATH = "data/penny-probe/penny-import-page23-coffee-conservative-summary.json";

const SAFE_PAGE23_PRODUCTS = [
  "COFFEE WHITENER CASABLANCA",
  "KÁVA CASABLANCA OCHUCENÁ",
  "KÁVA CASABLANCA CLASSIC",
  "KÁVA MARILA STANDARD",
  "EDUSCHO ESPRESSO INTENSO",
  "KÁVA CASABLANCA INTENSO",
  "LAVAZZA CAFFÉ CREMA",
  "KÁVA CASABLANCA CREMA",
  "KÁVA CASABLANCA ESPRESSO MILD",
  "DOLCE GUSTO KÁVOVÉ KAPSLE",
  "NESCAFÉ 3V1, 2V1",
  "CAPPUCCINO CASABLANCA",
  "KÁVA JACOBS VELVET REFILL XXL",
  "JACOBS INTENSE",
  "KÁVA JACOBS VELVET CREMA",
];

const EXCLUDED_PRODUCTS = [
  "KÁVOVÉ KAPSLE TASSIMO",
  "JACOBS ORIGINS",
];

function hashId(parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function offerName(offer) {
  return String(offer.product ?? offer.name ?? offer.title ?? "").trim();
}

function offerKey(offer) {
  return normalizeSearch([offerName(offer), offer.price ?? "", offer.storeId ?? offer.storeName ?? ""].join("|"));
}

function productLooseKey(offer) {
  return normalizeSearch(offerName(offer));
}

function startsWithSafeProduct(product) {
  const normalized = normalizeSearch(product);
  return SAFE_PAGE23_PRODUCTS.some((safe) => normalized.startsWith(normalizeSearch(safe)));
}

function startsWithExcludedProduct(product) {
  const normalized = normalizeSearch(product);
  return EXCLUDED_PRODUCTS.some((excluded) => normalized.startsWith(normalizeSearch(excluded)));
}

async function loadJson(path, fallback = null) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function extractOffers(container) {
  if (Array.isArray(container)) return container;
  if (Array.isArray(container?.offers)) return container.offers;
  if (Array.isArray(container?.items)) return container.items;
  if (Array.isArray(container?.data)) return container.data;
  return [];
}

function wrapLikeOriginal(originalContainer, offers, extraMeta = {}) {
  if (Array.isArray(originalContainer)) return offers;

  return {
    ...originalContainer,
    meta: {
      ...(originalContainer?.meta ?? {}),
      ...extraMeta,
    },
    offers,
  };
}

function cleanCandidateOffer(candidate) {
  const product = offerName(candidate);
  const category = candidate.category ?? "káva";
  const searchTerms = unique([
    "káva",
    ...(Array.isArray(candidate.searchTerms) ? candidate.searchTerms : []),
    category,
  ]);

  return {
    id: `penny-page23-coffee-${hashId([product, candidate.price, candidate.pageNumber ?? 23])}`,
    chain: "Penny",
    storeId: "penny-letak",
    storeName: "Penny – leták",
    product,
    brand: candidate.brand ?? "",
    description: searchTerms.join(" · "),
    packageSize: candidate.packageSize ?? "",
    price: candidate.price,
    priceText: candidate.priceText ?? "",
    unitPrice: candidate.unitPrice ?? null,
    unit: candidate.unit ?? "",
    validTo: candidate.validTo ?? "19.05.2026",
    pageNumber: Number(candidate.pageNumber ?? 23),
    imageUrl: candidate.imageUrl ?? "",
    pageImageUrl:
      candidate.pageImageUrl ??
      `https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/${Number(candidate.pageNumber ?? 23)}/files/assets/cover300.jpg`,
    imageType: candidate.imageType ?? "penny-page",
    sourceUrl:
      candidate.sourceUrl ??
      `https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/${Number(candidate.pageNumber ?? 23)}/index.html`,
    category,
    searchTerms,
    compareKey: candidate.compareKey ?? category,
    confidence: "penny-page23-coffee-conservative",
    source: "penny-hidden-html-page23-coffee-conservative",
    suspect: false,
    rawContext: candidate.rawContext ?? "",
  };
}

function shouldUseCandidate(candidate) {
  const product = offerName(candidate);

  if (Number(candidate.pageNumber ?? 23) !== 23) return false;
  if (!String(candidate.confidence ?? "").includes("targeted-page23-coffee-parser")) return false;
  if (startsWithExcludedProduct(product)) return false;
  if (!startsWithSafeProduct(product)) return false;
  if (candidate.price == null || Number(candidate.price) <= 0) return false;

  return true;
}

async function main() {
  await mkdir("data/penny-probe", { recursive: true });

  const originalContainer = await loadJson(PENNY_INPUT_PATH, { meta: {}, offers: [] });
  const originalOffers = extractOffers(originalContainer);

  if (!originalOffers.length) {
    throw new Error(`No offers found in ${PENNY_INPUT_PATH}`);
  }

  const probe = await loadJson(PAGE23_PROBE_PATH, null);
  if (!probe || !Array.isArray(probe.offers)) {
    throw new Error(`No offers found in ${PAGE23_PROBE_PATH}. Run Probe Penny page23 coffee v3 first.`);
  }

  const candidates = probe.offers.filter(shouldUseCandidate);
  const normalizedCandidates = candidates.map(cleanCandidateOffer);

  const existingLooseKeys = new Set(originalOffers.map(productLooseKey).filter(Boolean));
  const existingExactKeys = new Set(originalOffers.map(offerKey).filter(Boolean));

  const added = [];
  const skipped = [];

  for (const candidate of normalizedCandidates) {
    const exactKey = offerKey(candidate);
    const looseKey = productLooseKey(candidate);

    if (existingExactKeys.has(exactKey) || existingLooseKeys.has(looseKey)) {
      skipped.push({
        product: candidate.product,
        priceText: candidate.priceText,
        reason: "already-present",
      });
      continue;
    }

    added.push(candidate);
    existingExactKeys.add(exactKey);
    existingLooseKeys.add(looseKey);
  }

  const outputOffers = [...originalOffers, ...added];

  const outputContainer = wrapLikeOriginal(originalContainer, outputOffers, {
    pennyPage23CoffeeConservative: {
      updatedAt: new Date().toISOString(),
      source: PAGE23_PROBE_PATH,
      originalCount: originalOffers.length,
      candidateCount: candidates.length,
      addedCount: added.length,
      skippedCount: skipped.length,
      outputCount: outputOffers.length,
      strategy: "append-safe-targeted-page23-coffee-only",
      excluded: [
        "KÁVOVÉ KAPSLE TASSIMO bez klasické akční ceny",
        "JACOBS ORIGINS bez klasické akční ceny",
      ],
    },
  });

  await writeFile(PENNY_BACKUP_OUTPUT_PATH, JSON.stringify(originalContainer, null, 2) + "\n", "utf8");
  await writeFile(PENNY_OUTPUT_PATH, JSON.stringify(outputContainer, null, 2) + "\n", "utf8");

  const report = {
    checkedAt: new Date().toISOString(),
    source: PAGE23_PROBE_PATH,
    summary: {
      inputPennyOffers: originalOffers.length,
      candidateOffersLoaded: candidates.length,
      normalizedCandidates: normalizedCandidates.length,
      addedOffers: added.length,
      skippedOffers: skipped.length,
      outputPennyOffers: outputOffers.length,
      recommendedNextStep: "run-combine-offers-and-test-search-kava-casablanca-dolce-gusto-nescafe",
    },
    added: added.map((offer) => ({
      product: offer.product,
      priceText: offer.priceText,
      packageSize: offer.packageSize,
      unitPrice: offer.unitPrice,
      unit: offer.unit,
      category: offer.category,
      searchTerms: offer.searchTerms,
      pageNumber: offer.pageNumber,
    })),
    skipped,
    excluded: EXCLUDED_PRODUCTS,
  };

  await writeFile(REPORT_OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("Penny page23 coffee conservative import finished.");
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
