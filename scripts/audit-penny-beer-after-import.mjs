import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";

const FILES_TO_CHECK = [
  "data/penny-leaflet-offers.json",
  "data/offers.json",
  "data/penny-probe/penny-import-v2-conservative-summary.json",
];

const SEARCH_TERMS = [
  "pivo",
  "Braník",
  "Krušovice",
  "Staropramen",
  "Gambrinus",
  "Radegast",
  "Kozel",
  "Budvar",
  "Svijanský",
  "Ostravar",
  "Mustang",
  "Cool",
  "ležák",
  "výčepní",
];

const EXPECTED_PAGE20_PRODUCTS = [
  "BRANÍK",
  "OSTRAVAR MUSTANG",
  "VELKOPOPOVICKÝ KOZEL 10",
  "STAROČECH ORIGINAL",
  "RADEGAST RATAR",
  "BUDWEISER BUDVAR",
  "GAMBRINUS PATRON",
  "ZUBR GRAND",
  "STAROČECH nealko",
  "STAROPRAMEN 12",
  "COOL",
  "VELKOPOPOVICKÝ KOZEL nealko",
  "KRUŠOVICE 10",
  "SVIJANSKÝ MÁZ",
];

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesTerm(value, term) {
  return normalizeSearch(value).includes(normalizeSearch(term));
}

async function loadJson(path) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch (error) {
    return {
      __error: error instanceof Error ? error.message : String(error),
    };
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

function offerText(offer) {
  return [
    offer.product,
    offer.name,
    offer.title,
    offer.description,
    offer.category,
    offer.compareKey,
    offer.searchText,
    offer.searchTerms,
    offer.brand,
    offer.storeName,
    offer.storeId,
    offer.chain,
    offer.source,
    offer.rawContext,
  ]
    .flat()
    .filter(Boolean)
    .join(" ");
}

function isPennyOffer(offer) {
  const text = normalizeSearch([
    offer.storeName,
    offer.storeId,
    offer.chain,
    offer.source,
    offer.sourceName,
  ].filter(Boolean).join(" "));

  return text.includes("penny");
}

function isBeerOffer(offer) {
  const text = offerText(offer);
  return SEARCH_TERMS.some((term) => includesTerm(text, term));
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
    searchTerms: offer.searchTerms ?? [],
    compareKey: offer.compareKey ?? "",
    storeName: offer.storeName ?? "",
    storeId: offer.storeId ?? "",
    chain: offer.chain ?? "",
    pageNumber: offer.pageNumber ?? offer.page ?? "",
    confidence: offer.confidence ?? "",
    source: offer.source ?? "",
    sourceUrl: offer.sourceUrl ?? "",
    description: offer.description ?? "",
    rawContext: String(offer.rawContext ?? "").slice(0, 300),
  };
}

function searchTermReport(offers, onlyPenny = false) {
  const sourceOffers = onlyPenny ? offers.filter(isPennyOffer) : offers;

  return SEARCH_TERMS.map((term) => {
    const matches = sourceOffers.filter((offer) => includesTerm(offerText(offer), term));
    return {
      term,
      count: matches.length,
      sample: matches.slice(0, 20).map(simplify),
    };
  });
}

function expectedProductReport(offers) {
  const pennyOffers = offers.filter(isPennyOffer);

  return EXPECTED_PAGE20_PRODUCTS.map((expected) => {
    const matches = pennyOffers.filter((offer) => includesTerm(offerProduct(offer), expected) || includesTerm(offerText(offer), expected));

    return {
      expected,
      found: matches.length,
      matches: matches.slice(0, 10).map(simplify),
    };
  });
}

function detectPossibleProblems(pennyFileOffers, appFileOffers, importSummary) {
  const problems = [];

  const pennyBeer = pennyFileOffers.filter(isPennyOffer).filter(isBeerOffer);
  const appPennyBeer = appFileOffers.filter(isPennyOffer).filter(isBeerOffer);

  if (pennyBeer.length > 5 && appPennyBeer.length <= 2) {
    problems.push("Pivní položky jsou v data/penny-leaflet-offers.json, ale nedostaly se do data/offers.json. Pravděpodobně neběžel combine nebo používá jiný vstup.");
  }

  if (pennyBeer.length <= 2) {
    problems.push("Pivní položky nejsou ani v data/penny-leaflet-offers.json. Import V2 conservative se pravděpodobně nepropsal nebo byl přepsán.");
  }

  const branikInPenny = pennyFileOffers.filter(isPennyOffer).some((offer) => includesTerm(offerText(offer), "Braník"));
  const branikInApp = appFileOffers.filter(isPennyOffer).some((offer) => includesTerm(offerText(offer), "Braník"));

  if (branikInPenny && !branikInApp) {
    problems.push("Braník je v Penny zdrojových datech, ale není v data/offers.json.");
  }

  if (branikInApp) {
    const branikOffers = appFileOffers.filter(isPennyOffer).filter((offer) => includesTerm(offerText(offer), "Braník"));
    const hasSearchTermPivo = branikOffers.some((offer) => includesTerm(offerText(offer), "pivo"));
    if (!hasSearchTermPivo) {
      problems.push("Braník je v data/offers.json, ale nemusí mít v hledacím textu slovo pivo.");
    }
  }

  if (importSummary?.summary?.addedOffers && importSummary.summary.addedOffers > 0 && pennyBeer.length <= 2) {
    problems.push("Report importu tvrdí, že položky byly přidány, ale aktuální data je neobsahují. Něco je později přepsalo.");
  }

  return problems;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pennyContainer = await loadJson("data/penny-leaflet-offers.json");
  const appContainer = await loadJson("data/offers.json");
  const importSummary = await loadJson("data/penny-probe/penny-import-v2-conservative-summary.json");

  const pennyOffers = extractOffers(pennyContainer);
  const appOffers = extractOffers(appContainer);

  const pennyPennyOffers = pennyOffers.filter(isPennyOffer);
  const appPennyOffers = appOffers.filter(isPennyOffer);

  const pennyBeerOffers = pennyPennyOffers.filter(isBeerOffer);
  const appPennyBeerOffers = appPennyOffers.filter(isBeerOffer);

  const summary = {
    checkedAt: new Date().toISOString(),
    filesChecked: FILES_TO_CHECK,
    summary: {
      pennyLeafletTotalOffers: pennyOffers.length,
      pennyLeafletPennyOffers: pennyPennyOffers.length,
      pennyLeafletPennyBeerOffers: pennyBeerOffers.length,
      appOffersTotalOffers: appOffers.length,
      appOffersPennyOffers: appPennyOffers.length,
      appOffersPennyBeerOffers: appPennyBeerOffers.length,
      branikInPennyLeaflet: pennyPennyOffers.some((offer) => includesTerm(offerText(offer), "Braník")),
      branikInAppOffers: appPennyOffers.some((offer) => includesTerm(offerText(offer), "Braník")),
      importV2ConservativeSummary: importSummary?.summary ?? null,
      likelyProblems: detectPossibleProblems(pennyOffers, appOffers, importSummary),
      recommendedPath: "",
    },
    pennyLeafletBeerOffers: pennyBeerOffers.map(simplify),
    appPennyBeerOffers: appPennyBeerOffers.map(simplify),
    pennyLeafletSearchTermReport: searchTermReport(pennyOffers, true),
    appOffersSearchTermReport: searchTermReport(appOffers, true),
    expectedInPennyLeaflet: expectedProductReport(pennyOffers),
    expectedInAppOffers: expectedProductReport(appOffers),
  };

  const problems = summary.summary.likelyProblems.join(" ");
  if (/nedostaly se do data\/offers\.json|není v data\/offers\.json/i.test(problems)) {
    summary.summary.recommendedPath = "fix-combine-or-app-data-source";
  } else if (/nejsou ani v data\/penny-leaflet-offers\.json|přepsal/i.test(problems)) {
    summary.summary.recommendedPath = "rerun-or-fix-penny-import-v2-conservative";
  } else if (summary.summary.branikInAppOffers) {
    summary.summary.recommendedPath = "inspect-app-search-filter-index";
  } else {
    summary.summary.recommendedPath = "inspect-beer-audit-manually";
  }

  await writeFile(`${OUTPUT_DIR}/penny-beer-after-import-audit-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny beer after import audit finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
