import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIR = "data/penny-probe";

const BEER_TERMS = [
  "pivo",
  "piv",
  "ležák",
  "světlý",
  "výčepní",
  "braník",
  "budvar",
  "starobrno",
  "staropramen",
  "gambrinus",
  "kozel",
  "velkopopovický",
  "radegast",
  "březňák",
  "krušovice",
  "svijany",
  "svijanský",
  "bernard",
  "mustang",
  "cool",
  "birell",
  "zubr",
  "holba",
  "sládkova",
  "rychtář",
  "bakalář",
];

const EXPECTED_FROM_SCREEN = [
  "Braník",
  "Starobrno",
  "Velkopopovický Kozel 10",
  "Svijany",
  "Krušovice 10",
  "Krušovice 12",
  "Radegast Ratar",
  "Staropramen 12",
  "Mustang Hořký 12",
  "Březňák",
  "Staropramen 10",
  "Budweiser Budvar Original",
  "Cool",
  "Gambrinus Patron",
  "Ostravar Mustang",
  "Velkopopovický Kozel",
  "Bohemia Sekt",
  "Prosecco",
];

const DATA_DIR = "data";

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesAnyBeerTerm(value = "") {
  const normalized = normalize(value);
  return BEER_TERMS.some((term) => normalized.includes(normalize(term)));
}

function offerText(offer) {
  return [
    offer.product,
    offer.name,
    offer.title,
    offer.description,
    offer.brand,
    offer.category,
    offer.searchText,
    offer.searchTerms,
    offer.compareKey,
    offer.rawContext,
    offer.storeName,
    offer.source,
  ]
    .flat()
    .filter(Boolean)
    .join(" ");
}

function isPennyOffer(offer) {
  const text = normalize([
    offer.storeName,
    offer.storeId,
    offer.chain,
    offer.source,
    offer.sourceName,
    offer.leafletType,
    offer.rawContext,
  ].filter(Boolean).join(" "));

  return text.includes("penny");
}

function simplifyOffer(offer, sourceFile) {
  return {
    sourceFile,
    id: offer.id ?? "",
    product: offer.product ?? offer.name ?? offer.title ?? "",
    storeName: offer.storeName ?? "",
    storeId: offer.storeId ?? "",
    chain: offer.chain ?? "",
    price: offer.price ?? null,
    priceText: offer.priceText ?? "",
    unitPrice: offer.unitPrice ?? null,
    unit: offer.unit ?? "",
    packageSize: offer.packageSize ?? offer.quantity ?? "",
    category: offer.category ?? "",
    searchTerms: offer.searchTerms ?? "",
    compareKey: offer.compareKey ?? "",
    pageNumber: offer.pageNumber ?? offer.page ?? "",
    validTo: offer.validTo ?? "",
    sourceUrl: offer.sourceUrl ?? "",
    rawContext: String(offer.rawContext ?? "").slice(0, 260),
  };
}

async function listJsonFiles(dir) {
  const result = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "albert-probe" || entry.name === "albert-page-images") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        result.push(full);
      }
    }
  }

  await walk(dir);
  return result.sort();
}

function extractOffersFromJson(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.offers)) return json.offers;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.products)) return json.products;
  if (Array.isArray(json.data)) return json.data;

  return [];
}

async function readJsonFile(file) {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function matchExpected(expected, offers) {
  const expectedNorm = normalize(expected);
  const words = expectedNorm.split(" ").filter((word) => word.length >= 3);

  return offers.filter((offer) => {
    const text = normalize(offerText(offer));
    if (text.includes(expectedNorm)) return true;
    return words.length > 0 && words.every((word) => text.includes(word));
  });
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const jsonFiles = await listJsonFiles(DATA_DIR);
  const fileReports = [];
  const allOffers = [];

  for (const file of jsonFiles) {
    const json = await readJsonFile(file);
    if (!json) continue;

    const offers = extractOffersFromJson(json);
    if (!offers.length) continue;

    const pennyOffers = offers.filter(isPennyOffer);
    const beerOffers = offers.filter((offer) => includesAnyBeerTerm(offerText(offer)));
    const pennyBeerOffers = pennyOffers.filter((offer) => includesAnyBeerTerm(offerText(offer)));

    fileReports.push({
      file,
      totalOffers: offers.length,
      pennyOffers: pennyOffers.length,
      beerOffers: beerOffers.length,
      pennyBeerOffers: pennyBeerOffers.length,
      pennyBeerSample: pennyBeerOffers.slice(0, 80).map((offer) => simplifyOffer(offer, file)),
    });

    for (const offer of offers) {
      allOffers.push({ ...offer, __sourceFile: file });
    }
  }

  const pennyOffersAll = allOffers.filter(isPennyOffer);
  const pennyBeerOffersAll = pennyOffersAll.filter((offer) => includesAnyBeerTerm(offerText(offer)));

  const expectedReport = EXPECTED_FROM_SCREEN.map((expected) => {
    const inAllPenny = matchExpected(expected, pennyOffersAll);
    const inPennyBeer = matchExpected(expected, pennyBeerOffersAll);
    const inAllData = matchExpected(expected, allOffers);

    return {
      expected,
      foundInPenny: inAllPenny.length,
      foundInPennyBeerSubset: inPennyBeer.length,
      foundInAllData: inAllData.length,
      pennyMatches: inAllPenny.slice(0, 20).map((offer) => simplifyOffer(offer, offer.__sourceFile ?? "")),
      allDataMatches: inAllData.slice(0, 20).map((offer) => simplifyOffer(offer, offer.__sourceFile ?? "")),
    };
  });

  const offersJsonReport = fileReports.find((report) => report.file === "data/offers.json") ?? null;

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      jsonFilesChecked: jsonFiles.length,
      filesWithOffers: fileReports.length,
      totalOffersAcrossFiles: allOffers.length,
      pennyOffersAcrossFiles: pennyOffersAll.length,
      pennyBeerOffersAcrossFiles: pennyBeerOffersAll.length,
      offersJsonPennyBeerOffers: offersJsonReport?.pennyBeerOffers ?? null,
      expectedFoundInPenny: expectedReport.filter((item) => item.foundInPenny > 0).length,
      expectedMissingInPenny: expectedReport.filter((item) => item.foundInPenny === 0).map((item) => item.expected),
      likelyProblem:
        expectedReport.some((item) => item.foundInAllData > 0 && item.foundInPenny === 0)
          ? "combine-or-store-tagging-problem"
          : expectedReport.filter((item) => item.foundInPenny === 0).length > 5
            ? "penny-import-missing-beer-page-items"
            : "search-context-or-filter-problem",
    },
    expectedReport,
    fileReports,
    pennyBeerOffersSample: pennyBeerOffersAll.slice(0, 180).map((offer) => simplifyOffer(offer, offer.__sourceFile ?? "")),
  };

  await writeFile(`${OUTPUT_DIR}/penny-beer-coverage-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny beer coverage probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-beer-coverage-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
