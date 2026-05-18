import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";
const OFFERS_PATH = "data/offers.json";
const PENNY_SOURCE_PATH = "data/penny-leaflet-offers.json";

const EXPECTED_CHECKS = [
  { query: "Braník", label: "beer-branik" },
  { query: "pivo", label: "beer-generic" },
  { query: "Krušovice", label: "beer-krusovice" },
  { query: "káva", label: "coffee-generic" },
  { query: "Casablanca", label: "coffee-casablanca" },
  { query: "Dolce Gusto", label: "coffee-dolce-gusto" },
  { query: "Woolite", label: "woolite" },
  { query: "zahrada", label: "garden-generic" },
  { query: "Kristalon", label: "garden-kristalon" },
  { query: "postřikovač", label: "garden-postrikovac" },
  { query: "Bioseptik", label: "garden-bioseptik" },
];

const IMPORTANT_PAGES = [20, 23, 28, 35];

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
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return { __error: error instanceof Error ? error.message : String(error) };
  }
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

function searchableText(offer) {
  return [
    offer.product,
    offer.name,
    offer.title,
    offer.brand,
    offer.description,
    offer.category,
    offer.searchTerms,
    offer.compareKey,
    offer.packageSize,
    offer.storeName,
    offer.storeId,
    offer.chain,
  ].flat().filter(Boolean).join(" ");
}

function matchesQuery(offer, query) {
  return normalizeSearch(searchableText(offer)).includes(normalizeSearch(query));
}

function simplify(offer) {
  return {
    product: offerProduct(offer),
    priceText: offer.priceText ?? "",
    price: offer.price ?? null,
    packageSize: offer.packageSize ?? "",
    category: offer.category ?? "",
    pageNumber: pageNumber(offer),
    storeName: offer.storeName ?? "",
    chain: offer.chain ?? "",
    confidence: offer.confidence ?? "",
    source: offer.source ?? "",
  };
}

function counterByPage(offers) {
  const map = new Map();
  for (const offer of offers) {
    const page = pageNumber(offer);
    if (!page) continue;
    map.set(page, (map.get(page) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([page, count]) => ({ page, count }));
}

function queryReport(pennyOffers) {
  return EXPECTED_CHECKS.map((check) => {
    const matches = pennyOffers.filter((offer) => matchesQuery(offer, check.query));
    return {
      label: check.label,
      query: check.query,
      count: matches.length,
      sample: matches.slice(0, 20).map(simplify),
    };
  });
}

function importantPageReport(pennyOffers) {
  return IMPORTANT_PAGES.map((page) => {
    const offers = pennyOffers.filter((offer) => pageNumber(offer) === page);
    return {
      page,
      count: offers.length,
      sample: offers.slice(0, 80).map(simplify),
    };
  });
}

function detectProblems(report) {
  const problems = [];
  const q = Object.fromEntries(report.queryChecks.map((item) => [item.label, item]));

  if ((q["beer-branik"]?.count ?? 0) < 1) problems.push("Braník se v datech nenašel.");
  if ((q["beer-generic"]?.count ?? 0) < 10) problems.push("Obecné hledání pivo má podezřele málo výsledků.");
  if ((q["coffee-generic"]?.count ?? 0) < 10) problems.push("Obecné hledání káva má podezřele málo výsledků.");
  if ((q["woolite"]?.count ?? 0) < 1) problems.push("Woolite se v datech nenašel.");
  if ((q["garden-generic"]?.count ?? 0) < 20) problems.push("Zahrada má podezřele málo výsledků, strana 28 se možná nepropsala.");
  if ((q["garden-kristalon"]?.count ?? 0) < 1) problems.push("Kristalon se v datech nenašel.");
  if ((q["garden-postrikovac"]?.count ?? 0) < 1) problems.push("Postřikovač se v datech nenašel.");

  const page28 = report.importantPages.find((item) => item.page === 28);
  if (!page28 || page28.count < 20) problems.push("Strana 28 má méně než očekávaných cca 22 položek.");

  return problems;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const offersContainer = await loadJson(OFFERS_PATH);
  const sourceContainer = await loadJson(PENNY_SOURCE_PATH);

  const allOffers = extractOffers(offersContainer);
  const pennyOffers = allOffers.filter(isPennyOffer);

  const sourceOffers = extractOffers(sourceContainer).filter(isPennyOffer);

  const report = {
    checkedAt: new Date().toISOString(),
    type: "JEN KONTROLNÍ REPORT – DO APLIKACE NENAHRÁVAT",
    summary: {
      offersPath: OFFERS_PATH,
      totalOffers: allOffers.length,
      pennyOffers: pennyOffers.length,
      pennySourceOffers: sourceOffers.length,
      pennyPagesInCurrentOffers: counterByPage(pennyOffers).length,
      pennyPagesInSource: counterByPage(sourceOffers).length,
      recommendedPath: "",
    },
    pageCountsCurrentOffers: counterByPage(pennyOffers),
    pageCountsPennySource: counterByPage(sourceOffers),
    importantPages: importantPageReport(pennyOffers),
    queryChecks: queryReport(pennyOffers),
  };

  report.detectedProblems = detectProblems(report);

  if (report.detectedProblems.length) {
    report.summary.recommendedPath = "inspect-detected-problems";
  } else {
    report.summary.recommendedPath = "continue-with-next-risk-pages-or-final-manual-sampling";
  }

  await writeFile(`${OUTPUT_DIR}/penny-post-fixes-audit-v2-summary.json`, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("Penny post fixes audit v2 finished.");
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.detectedProblems.length) {
    console.log("Detected problems:");
    for (const problem of report.detectedProblems) console.log(`- ${problem}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
