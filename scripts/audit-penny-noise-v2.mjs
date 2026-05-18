import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";
const OFFERS_PATH = "data/offers.json";

const NOISE_PATTERNS = [
  { id: "starts-with-price-fragment", pattern: /^(á|a)\s+\d{1,4}[,.]\d{1,2}\b/iu, severity: "high" },
  { id: "deposit-in-product-name", pattern: /\bzáloha na lahev\b/iu, severity: "high" },
  { id: "product-contains-price-marker", pattern: /<\s*\d{1,4}[,.]\d{1,2}\s*Kč|nabídka\s+Jedinečná\s+\d/iu, severity: "medium" },
  { id: "product-contains-footer", pattern: /Nabídka platná|Používejte biocidy|Před použitím si vždy přečtěte/iu, severity: "high" },
  { id: "empty-price-text-with-known-imported-page", pattern: /^$/u, severity: "low", field: "priceText" },
  { id: "missing-category", pattern: /^$/u, severity: "low", field: "category" },
];

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function pageNumber(offer) {
  const number = Number(offer.pageNumber ?? offer.page ?? offer.leafletPage ?? "");
  if (Number.isFinite(number) && number > 0) return number;
  const sourceUrl = String(offer.sourceUrl ?? "");
  const match = sourceUrl.match(/\/(\d+)\/index\.html/i);
  return match ? Number(match[1]) : null;
}

function simplify(offer) {
  return {
    id: offer.id ?? "",
    product: offerProduct(offer),
    price: offer.price ?? null,
    priceText: offer.priceText ?? "",
    packageSize: offer.packageSize ?? "",
    category: offer.category ?? "",
    pageNumber: pageNumber(offer),
    storeName: offer.storeName ?? "",
    chain: offer.chain ?? "",
    confidence: offer.confidence ?? "",
    source: offer.source ?? "",
    description: offer.description ?? "",
    searchTerms: offer.searchTerms ?? "",
    compareKey: offer.compareKey ?? "",
  };
}

function detectNoise(offer) {
  const findings = [];
  const product = offerProduct(offer);

  for (const rule of NOISE_PATTERNS) {
    const value = rule.field ? String(offer[rule.field] ?? "") : product;

    if (rule.pattern.test(value)) {
      if (rule.id === "empty-price-text-with-known-imported-page") {
        if (offer.price != null && [20, 23, 35].includes(Number(pageNumber(offer)))) {
          findings.push({
            id: rule.id,
            severity: rule.severity,
            message: "Chybí priceText u položky, která má cenu; lze doplnit z price.",
          });
        }
        continue;
      }

      if (rule.id === "missing-category") {
        if ([20, 23, 35].includes(Number(pageNumber(offer)))) {
          findings.push({
            id: rule.id,
            severity: rule.severity,
            message: "Chybí category u položky na opravované stránce.",
          });
        }
        continue;
      }

      findings.push({
        id: rule.id,
        severity: rule.severity,
        message: `Podezřelý název produktu podle pravidla ${rule.id}.`,
      });
    }
  }

  if (product.length > 120) {
    findings.push({
      id: "very-long-product-name",
      severity: "medium",
      message: "Název produktu je podezřele dlouhý.",
    });
  }

  if (product.length < 3) {
    findings.push({
      id: "very-short-product-name",
      severity: "high",
      message: "Název produktu je podezřele krátký.",
    });
  }

  return findings;
}

function duplicateGroups(offers) {
  const groups = new Map();

  for (const offer of offers) {
    const key = [
      pageNumber(offer) ?? "",
      normalizeSearch(offerProduct(offer)),
      String(offer.price ?? ""),
    ].join("|");

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({
      key: [
        pageNumber(group[0]) ?? "",
        normalizeSearch(offerProduct(group[0])),
        String(group[0].price ?? ""),
      ].join("|"),
      count: group.length,
      items: group.map(simplify),
    }));
}

function nearDuplicateGroups(offers) {
  const groups = new Map();

  for (const offer of offers) {
    const productKey = normalizeSearch(offerProduct(offer))
      .replace(/\b(svetly|svetle|lezak|vycepni|plech|ruzne|druhy|instantni|mleta|zrnková|zrnkova)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!productKey || productKey.length < 5) continue;

    const key = [
      pageNumber(offer) ?? "",
      productKey,
    ].join("|");

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group) => ({
      key: `${pageNumber(group[0]) ?? ""}|${normalizeSearch(offerProduct(group[0]))}`,
      count: group.length,
      items: group.map(simplify),
    }));
}

function recommendationForFinding(item) {
  const severityOrder = { high: 3, medium: 2, low: 1 };
  const maxSeverity = item.findings.reduce((max, finding) => Math.max(max, severityOrder[finding.severity] ?? 0), 0);
  const ids = item.findings.map((finding) => finding.id);

  if (ids.includes("deposit-in-product-name") || ids.includes("starts-with-price-fragment") || ids.includes("product-contains-footer")) {
    return "candidate-remove-or-replace-with-clean-existing";
  }

  if (ids.includes("empty-price-text-with-known-imported-page") || ids.includes("missing-category")) {
    return "candidate-fix-fields";
  }

  if (maxSeverity >= 2) return "manual-review";
  return "low-priority-review";
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const container = await loadJson(OFFERS_PATH);
  const offers = extractOffers(container);
  const pennyOffers = offers.filter(isPennyOffer);

  const noisy = [];

  for (const offer of pennyOffers) {
    const findings = detectNoise(offer);
    if (!findings.length) continue;

    const item = {
      ...simplify(offer),
      findings,
    };
    item.recommendation = recommendationForFinding(item);
    noisy.push(item);
  }

  const exactDuplicates = duplicateGroups(pennyOffers);
  const nearDuplicates = nearDuplicateGroups(pennyOffers);

  const highRisk = noisy.filter((item) => item.findings.some((finding) => finding.severity === "high"));
  const fixFields = noisy.filter((item) => item.recommendation === "candidate-fix-fields");
  const removeCandidates = noisy.filter((item) => item.recommendation === "candidate-remove-or-replace-with-clean-existing");

  const report = {
    checkedAt: new Date().toISOString(),
    type: "JEN KONTROLNÍ REPORT – DO APLIKACE NENAHRÁVAT",
    summary: {
      offersPath: OFFERS_PATH,
      totalOffers: offers.length,
      pennyOffers: pennyOffers.length,
      noisyPennyOffers: noisy.length,
      highRiskNoisyOffers: highRisk.length,
      removeOrReplaceCandidates: removeCandidates.length,
      fixFieldCandidates: fixFields.length,
      exactDuplicateGroups: exactDuplicates.length,
      nearDuplicateGroups: nearDuplicates.length,
      recommendedPath:
        removeCandidates.length > 0
          ? "inspect-remove-candidates-then-build-cleanup-patch"
          : fixFields.length > 0
            ? "build-field-fix-patch"
            : "no-critical-noise-found",
    },
    removeOrReplaceCandidates: removeCandidates,
    fixFieldCandidates: fixFields,
    highRiskNoisyOffers: highRisk,
    noisyPennyOffers: noisy,
    exactDuplicateGroups: exactDuplicates,
    nearDuplicateGroups: nearDuplicates.slice(0, 100),
  };

  await writeFile(`${OUTPUT_DIR}/penny-noise-audit-v2-summary.json`, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("Penny noise audit v2 finished.");
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
