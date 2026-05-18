import { mkdir, readFile, writeFile } from "node:fs/promises";

const OFFERS_PATH = "data/offers.json";
const OUTPUT_DIR = "data/penny-probe";
const REPORT_PATH = `${OUTPUT_DIR}/penny-beer-search-simulation-summary.json`;

const QUERIES = [
  "pivo",
  "branik",
  "Braník",
  "krušovice",
  "Krušovice",
  "gambrinus",
  "radegast",
  "staropramen",
  "kozel",
  "budvar",
  "ležák",
  "vycepni",
  "výčepní",
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

function searchableTextFull(offer) {
  return [
    offer.product,
    offer.name,
    offer.title,
    offer.description,
    offer.category,
    offer.compareKey,
    offer.searchTerms,
    offer.brand,
    offer.packageSize,
    offer.storeName,
    offer.storeId,
    offer.chain,
    offer.rawContext,
  ]
    .flat()
    .filter(Boolean)
    .join(" ");
}

function searchableTextLikelyFrontendProductOnly(offer) {
  return [
    offer.product,
    offer.name,
    offer.title,
  ]
    .flat()
    .filter(Boolean)
    .join(" ");
}

function searchableTextProductAndDescription(offer) {
  return [
    offer.product,
    offer.name,
    offer.title,
    offer.description,
  ]
    .flat()
    .filter(Boolean)
    .join(" ");
}

function matchesText(offer, query, mode) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return true;

  let text = "";
  if (mode === "full") text = searchableTextFull(offer);
  else if (mode === "productOnly") text = searchableTextLikelyFrontendProductOnly(offer);
  else if (mode === "productDescription") text = searchableTextProductAndDescription(offer);

  return normalizeSearch(text).includes(normalizedQuery);
}

function simplify(offer) {
  return {
    id: offer.id ?? "",
    product: offerProduct(offer),
    price: offer.price ?? null,
    priceText: offer.priceText ?? "",
    packageSize: offer.packageSize ?? "",
    unitPrice: offer.unitPrice ?? null,
    unit: offer.unit ?? "",
    category: offer.category ?? "",
    searchTerms: offer.searchTerms ?? "",
    compareKey: offer.compareKey ?? "",
    storeName: offer.storeName ?? "",
    storeId: offer.storeId ?? "",
    chain: offer.chain ?? "",
    pageNumber: offer.pageNumber ?? offer.page ?? "",
    confidence: offer.confidence ?? "",
    description: offer.description ?? "",
  };
}

function queryReport(offers, query) {
  const pennyOffers = offers.filter(isPennyOffer);

  const fullMatches = pennyOffers.filter((offer) => matchesText(offer, query, "full"));
  const productOnlyMatches = pennyOffers.filter((offer) => matchesText(offer, query, "productOnly"));
  const productDescriptionMatches = pennyOffers.filter((offer) => matchesText(offer, query, "productDescription"));

  return {
    query,
    normalizedQuery: normalizeSearch(query),
    pennyFullMatches: fullMatches.length,
    pennyProductOnlyMatches: productOnlyMatches.length,
    pennyProductDescriptionMatches: productDescriptionMatches.length,
    fullSample: fullMatches.slice(0, 40).map(simplify),
    productOnlySample: productOnlyMatches.slice(0, 40).map(simplify),
    productDescriptionSample: productDescriptionMatches.slice(0, 40).map(simplify),
  };
}

function findLikelyProblem(report) {
  const problems = [];

  for (const item of report.queryReports) {
    if (item.pennyFullMatches > 0 && item.pennyProductOnlyMatches === 0) {
      problems.push({
        query: item.query,
        problem: "full-search-finds-results-but-product-only-does-not",
        explanation: "Dotaz funguje při hledání v category/searchTerms/description, ale ne jen v názvu produktu. Frontend možná hledá jen product/name/title.",
      });
    }

    if (normalizeSearch(item.query) === "pivo" && item.pennyFullMatches > 0 && item.pennyProductOnlyMatches === 0) {
      problems.push({
        query: item.query,
        problem: "pivo-only-in-metadata",
        explanation: "Položky mají pivo v kategorii/searchTerms/description, ale ne vždy v názvu produktu.",
      });
    }
  }

  const branik = report.queryReports.find((item) => normalizeSearch(item.query) === "branik");
  const pivo = report.queryReports.find((item) => normalizeSearch(item.query) === "pivo");

  if (branik && branik.pennyFullMatches > 0 && pivo && pivo.pennyFullMatches > 0) {
    problems.push({
      query: "Braník/pivo",
      problem: "data-search-ok",
      explanation: "Data obsahují Braník i pivo. Pokud aplikace nic neukazuje, problém je pravděpodobně cache, načítání starého souboru nebo odlišný frontend filtr.",
    });
  }

  return problems;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const json = JSON.parse(await readFile(OFFERS_PATH, "utf8"));
  const offers = extractOffers(json);
  const pennyOffers = offers.filter(isPennyOffer);

  const queryReports = QUERIES.map((query) => queryReport(offers, query));

  const beerWords = ["pivo", "branik", "krusovice", "gambrinus", "radegast", "staropramen", "kozel", "budvar", "lezak", "vycepni"];
  const pennyBeerLike = pennyOffers.filter((offer) => {
    const text = normalizeSearch(searchableTextFull(offer));
    return beerWords.some((word) => text.includes(normalizeSearch(word)));
  });

  const report = {
    checkedAt: new Date().toISOString(),
    offersPath: OFFERS_PATH,
    summary: {
      totalOffers: offers.length,
      pennyOffers: pennyOffers.length,
      pennyBeerLikeOffers: pennyBeerLike.length,
      queriesChecked: QUERIES.length,
      recommendedPath: "",
    },
    queryReports,
    pennyBeerLikeSample: pennyBeerLike.slice(0, 80).map(simplify),
  };

  report.detectedProblems = findLikelyProblem(report);

  if (report.detectedProblems.some((p) => p.problem === "data-search-ok")) {
    report.summary.recommendedPath = "inspect-frontend-filter-cache-or-data-loading";
  } else if (report.detectedProblems.some((p) => p.problem === "full-search-finds-results-but-product-only-does-not")) {
    report.summary.recommendedPath = "expand-frontend-search-to-category-description-searchTerms";
  } else {
    report.summary.recommendedPath = "inspect-data-or-query-manually";
  }

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("Penny beer search simulation finished.");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Wrote ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
