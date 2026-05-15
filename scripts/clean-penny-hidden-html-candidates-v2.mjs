import { mkdir, readFile, writeFile } from "node:fs/promises";

const INPUT_PATH = "data/penny-probe/penny-hidden-html-all-pages-v1.json";
const SUMMARY_INPUT_PATH = "data/penny-probe/penny-hidden-html-all-pages-v1-summary.json";
const OUTPUT_DIR = "data/penny-probe";

const REJECT_PRODUCT_PATTERNS = [
  /^záloha na lahev\b/iu,
  /^tuku$/iu,
  /^pomeranč$/iu,
  /^cm\s+\d+\s+balení\b/iu,
  /^různé typy\s+\d+\s+balení\b/iu,
  /^Kč\b/iu,
  /^Nabídka\b/iu,
  /^Nejnižší\b/iu,
  /^ilustrační foto$/iu,
];

const REVIEW_PRODUCT_PATTERNS = [
  /\bza posledních 30 dní\b/iu,
  /\bosoba\/nákup\/\s*den\b/iu,
  /\bnabídka Jedinečná\b/iu,
  /\bMAX\.\s*ks\b/iu,
  /\b\d+\s*\/\s*\d+\s*g\b/iu,
];

const GOOD_CATEGORY_TERMS = [
  "pivo",
  "alkohol",
  "mléčné",
  "mražené",
  "uzeniny",
  "drogerie",
  "nápoje",
  "ovoce zelenina",
];

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasRejectPattern(offer) {
  const product = offer.product ?? "";
  return REJECT_PRODUCT_PATTERNS.some((pattern) => pattern.test(product));
}

function hasReviewPattern(offer) {
  const product = offer.product ?? "";
  const rawContext = offer.rawContext ?? "";
  return REVIEW_PRODUCT_PATTERNS.some((pattern) => pattern.test(product) || pattern.test(rawContext));
}

function isTargetedPage20(offer) {
  return Number(offer.pageNumber) === 20 && offer.confidence === "targeted-page20";
}

function isBadPackageForProduct(offer) {
  const product = offer.product ?? "";
  const packageSize = offer.packageSize ?? "";

  if (!packageSize) return false;

  // Typické chyby obecného parseru: produkt je potravina, ale packageSize je převzaté z předchozí položky.
  if (/FIDORKA|KREKRY|SUŠENKY|ČOKOLÁDA|CEREÁLIE|CAPPUCCINO|KÁVA|SIRUP|OLEJ|CUKR|MOUKA/iu.test(product) && /0,75 l|0,5 l|3 kg|500 g|1,1 kg/iu.test(packageSize)) {
    return true;
  }

  if (/FILETY PRO PSY/iu.test(product) && /5 l/iu.test(packageSize)) return true;
  if (/BARVY NA VLASY/iu.test(product) && /10 ks/iu.test(packageSize)) return true;

  return false;
}

function safeGenericCandidate(offer) {
  const product = offer.product ?? "";

  if (offer.confidence !== "generic-hidden-html") return false;
  if (hasRejectPattern(offer)) return false;
  if (hasReviewPattern(offer)) return false;
  if (isBadPackageForProduct(offer)) return false;
  if (product.length < 6 || product.length > 85) return false;

  // Obecný parser zatím pustíme jako safe jen tam, kde produkt vypadá jasně a není v rawContextu slepený s mnoha položkami.
  const priceMarkers = String(offer.rawContext ?? "").match(/<\s*\d{1,4}[,.]\d{1,2}\s*Kč/giu) ?? [];
  if (priceMarkers.length > 3) return false;

  const category = offer.category ?? "";
  if (GOOD_CATEGORY_TERMS.includes(category)) return true;

  // Některé jasné názvy bez kategorie jsou pořád použitelné, ale dáme je do review, ne safe.
  return false;
}

function classifyOffer(offer) {
  const reasons = [];

  if (hasRejectPattern(offer)) {
    reasons.push("zjevný šum v názvu produktu");
    return { bucket: "rejected", reasons };
  }

  if (isTargetedPage20(offer)) {
    // Cílený parser stránky 20 je po V4 nejlepší zdroj. Výjimka: bloky, které pořád obsahují přilepenou další položku, dáme na review.
    if (/STAROČECH polotmavý|MUSTANG HOŘKÝ/iu.test(offer.rawContext ?? "")) {
      reasons.push("blok obsahuje přilepenou další položku, chce ještě rozdělit");
      return { bucket: "review", reasons };
    }

    reasons.push("cílený parser stránky 20");
    return { bucket: "safe", reasons };
  }

  if (isBadPackageForProduct(offer)) {
    reasons.push("pravděpodobně špatně převzaté balení z předchozí položky");
    return { bucket: "review", reasons };
  }

  if (hasReviewPattern(offer)) {
    reasons.push("obsahuje promo/limitní text nebo složený kontext");
    return { bucket: "review", reasons };
  }

  if (safeGenericCandidate(offer)) {
    reasons.push("obecný kandidát prošel základním filtrem");
    return { bucket: "safe", reasons };
  }

  reasons.push("obecný parser zatím nechávám ke kontrole");
  return { bucket: "review", reasons };
}

function dedupeOffers(offers) {
  const best = new Map();

  for (const offer of offers) {
    const key = `${offer.pageNumber}|${normalizeSearch(offer.product)}|${offer.price}`;
    const existing = best.get(key);

    if (!existing || scoreOffer(offer) > scoreOffer(existing)) {
      best.set(key, offer);
    }
  }

  return Array.from(best.values());
}

function scoreOffer(offer) {
  let score = 0;
  if (offer.confidence === "targeted-page20") score += 100;
  if (offer.category) score += 10;
  if (offer.packageSize) score += 5;
  if (offer.unitPrice != null) score += 3;
  score -= Math.max(0, String(offer.product ?? "").length - 70) / 10;
  return score;
}

async function loadJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const input = await loadJson(INPUT_PATH);
  const inputSummary = await loadJson(SUMMARY_INPUT_PATH).catch(() => null);

  const offers = dedupeOffers(Array.isArray(input.offers) ? input.offers : []);

  const safeCandidates = [];
  const reviewCandidates = [];
  const rejectedCandidates = [];

  for (const offer of offers) {
    const classification = classifyOffer(offer);
    const enriched = {
      ...offer,
      suspect: classification.bucket !== "safe",
      candidateBucket: classification.bucket,
      candidateReasons: classification.reasons,
    };

    if (classification.bucket === "safe") safeCandidates.push(enriched);
    else if (classification.bucket === "review") reviewCandidates.push(enriched);
    else rejectedCandidates.push(enriched);
  }

  const output = {
    meta: {
      source: "Penny hidden HTML clean candidates v2",
      updatedAt: new Date().toISOString(),
      inputPath: INPUT_PATH,
      totalInputOffers: offers.length,
      safeCount: safeCandidates.length,
      reviewCount: reviewCandidates.length,
      rejectedCount: rejectedCandidates.length,
      note: "Mezikrok pro kontrolu. Safe kandidáti nejsou ještě automaticky ostrý import, ale jsou nejbližší k použití.",
    },
    safeCandidates,
    reviewCandidates,
    rejectedCandidates,
  };

  const byPage = {};
  for (const offer of [...safeCandidates, ...reviewCandidates, ...rejectedCandidates]) {
    const page = String(offer.pageNumber ?? "");
    byPage[page] ??= { pageNumber: Number(offer.pageNumber), safe: 0, review: 0, rejected: 0 };
    byPage[page][offer.candidateBucket] += 1;
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    inputSummary: inputSummary?.summary ?? null,
    summary: {
      totalInputOffers: offers.length,
      safeCandidates: safeCandidates.length,
      reviewCandidates: reviewCandidates.length,
      rejectedCandidates: rejectedCandidates.length,
      safePage20: safeCandidates.filter((offer) => Number(offer.pageNumber) === 20).length,
      reviewPage20: reviewCandidates.filter((offer) => Number(offer.pageNumber) === 20).length,
      rejectedPage20: rejectedCandidates.filter((offer) => Number(offer.pageNumber) === 20).length,
      pagesWithSafeCandidates: Object.values(byPage)
        .filter((page) => page.safe > 0)
        .sort((a, b) => a.pageNumber - b.pageNumber),
      recommendedPath:
        safeCandidates.filter((offer) => Number(offer.pageNumber) === 20).length >= 15
          ? "build-conservative-penny-import-v2-from-safe-candidates"
          : "fix-page20-targeted-candidates-before-import",
    },
    safeSample: safeCandidates.slice(0, 120).map((offer) => ({
      pageNumber: offer.pageNumber,
      product: offer.product,
      priceText: offer.priceText,
      packageSize: offer.packageSize,
      category: offer.category,
      confidence: offer.confidence,
      reasons: offer.candidateReasons,
    })),
    reviewSample: reviewCandidates.slice(0, 120).map((offer) => ({
      pageNumber: offer.pageNumber,
      product: offer.product,
      priceText: offer.priceText,
      packageSize: offer.packageSize,
      category: offer.category,
      confidence: offer.confidence,
      reasons: offer.candidateReasons,
      rawContext: offer.rawContext,
    })),
    rejectedSample: rejectedCandidates.slice(0, 80).map((offer) => ({
      pageNumber: offer.pageNumber,
      product: offer.product,
      priceText: offer.priceText,
      category: offer.category,
      confidence: offer.confidence,
      reasons: offer.candidateReasons,
      rawContext: offer.rawContext,
    })),
  };

  await writeFile(`${OUTPUT_DIR}/penny-hidden-html-clean-candidates-v2.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-hidden-html-clean-candidates-v2-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny hidden HTML clean candidates v2 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
