import { readFile, writeFile, mkdir } from "node:fs/promises";
import crypto from "node:crypto";

const PENNY_INPUT_PATH = "data/penny-leaflet-offers.json";
const CLEAN_CANDIDATES_PATH = "data/penny-probe/penny-hidden-html-clean-candidates-v2.json";
const PENNY_BACKUP_OUTPUT_PATH = "data/penny-leaflet-offers-before-v2-conservative.json";
const PENNY_OUTPUT_PATH = "data/penny-leaflet-offers.json";
const REPORT_OUTPUT_PATH = "data/penny-probe/penny-import-v2-conservative-summary.json";

const FALLBACK_SAFE_PAGE20_OFFERS = [
  {
    product: "SKOTSKÁ WHISKY MC ILLROY 40 % alk.",
    price: 219.9,
    priceText: "219,90 Kč",
    packageSize: "0,7 l",
    unitPrice: 299.86,
    unit: "l",
    category: "alkohol",
    searchTerms: ["alkohol"],
    rawContext: "SKOTSKÁ WHISKY MC ILLROY 40 % alk. 0,7 l 1 l 299,86 Kč < 219,90 Kč",
  },
  {
    product: "OSTRAVAR MUSTANG světlý ležák plech",
    price: 18.9,
    priceText: "18,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 35.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "OSTRAVAR MUSTANG* světlý ležák plech | 0,5 l 1 l 35,80 Kč v limitované nabídce také Černá Barbora 0,5 l za 18,90 Kč",
  },
  {
    product: "BRANÍK světlé výčepní",
    price: 9.9,
    priceText: "9,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 19.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "BRANÍK světlé výčepní 0,5 l 1 l 19,80 Kč záloha na lahev 3 Kč < 9,90 Kč",
  },
  {
    product: "VELKOPOPOVICKÝ KOZEL 10 světlé výčepní",
    price: 11.9,
    priceText: "11,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 25.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "VELKOPOPOVICKÝ KOZEL 10* světlé výčepní 0,5 l 1 l 25,80 Kč záloha na lahev 3 Kč < 11,90 Kč",
  },
  {
    product: "STAROČECH ORIGINAL světlé výčepní",
    price: 11.9,
    priceText: "11,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 15.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "STAROČECH ORIGINAL světlé výčepní 0,5 l | 1 l 15,80 Kč záloha na lahev 3 Kč < 11,90 Kč",
  },
  {
    product: "RADEGAST RATAR hořký ležák plech",
    price: 20.9,
    priceText: "20,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 41.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo", "hořký ležák"],
    rawContext: "RADEGAST RATAR* hořký ležák plech | 0,5 l 1 l 41,80 Kč < 20,90 Kč",
  },
  {
    product: "BUDWEISER BUDVAR světlý ležák",
    price: 19.9,
    priceText: "19,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 39.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "BUDWEISER BUDVAR světlý ležák 0,5 l 1 l 39,80 Kč < 19,90 Kč",
  },
  {
    product: "GAMBRINUS PATRON světlý ležák plech",
    price: 18.9,
    priceText: "18,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 37.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "GAMBRINUS PATRON světlý ležák plech 0,5 l 1 l 37,80 Kč < 18,90 Kč",
  },
  {
    product: "ZUBR GRAND, HOLBA ŠERÁK světlý ležák plech",
    price: 16.9,
    priceText: "16,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 31.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "ZUBR GRAND, HOLBA ŠERÁK světlý ležák plech | 0,5 l 1 l 31,80 Kč < 16,90 Kč",
  },
  {
    product: "STAROČECH nealko",
    price: 6.9,
    priceText: "6,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 13.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo", "nealkoholické", "nealkoholické pivo"],
    rawContext: "STAROČECH nealko | 0,5 l 1 l 13,80 Kč záloha na lahev 3 Kč < 6,90 Kč",
  },
  {
    product: "STAROPRAMEN 12 světlý ležák plech",
    price: 17.9,
    priceText: "17,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 33.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "STAROPRAMEN 12 světlý ležák plech | 0,5 l 1 l 33,80 Kč < 17,90 Kč",
  },
  {
    product: "BRANDY KOBLEVO RESERVE VSOP 40 % alk.",
    price: 229.9,
    priceText: "229,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 439.8,
    unit: "l",
    category: "alkohol",
    searchTerms: ["alkohol"],
    rawContext: "BRANDY KOBLEVO RESERVE VSOP 40 % alk. 0,5 l 1 l 439,80 Kč < 229,90 Kč",
  },
  {
    product: "COOL různé druhy",
    price: 36.9,
    priceText: "36,90 Kč",
    packageSize: "1,5 l",
    unitPrice: 24.6,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo", "radler", "míchaný nápoj"],
    rawContext: "COOL* různé druhy 1,5 l 1 l 24,60 Kč < 36,90 Kč",
  },
  {
    product: "VELKOPOPOVICKÝ KOZEL nealko plech",
    price: 17.9,
    priceText: "17,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 35.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo", "nealkoholické", "nealkoholické pivo"],
    rawContext: "VELKOPOPOVICKÝ KOZEL nealko plech | 0,5 l 1 l 35,80 Kč < 17,90 Kč",
  },
  {
    product: "KRUŠOVICE 10 světlé výčepní",
    price: 9.9,
    priceText: "9,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 21.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "KRUŠOVICE 10 světlé výčepní 0,5 l 1 l 21,80 Kč záloha na lahev 3 Kč < 9,90 Kč",
  },
  {
    product: "BOHEMIA SEKT různé druhy",
    price: 109.9,
    priceText: "109,90 Kč",
    packageSize: "0,75 l",
    unitPrice: 173.2,
    unit: "l",
    category: "alkohol",
    searchTerms: ["alkohol", "sekt", "šumivé víno"],
    rawContext: "BOHEMIA SEKT různé druhy 0,75 l 1 l 173,20 Kč < 109,90 Kč v nabídce také další druhy za 129,90 Kč",
  },
  {
    product: "SVIJANSKÝ MÁZ světlý ležák",
    price: 10.9,
    priceText: "10,90 Kč",
    packageSize: "0,5 l",
    unitPrice: 23.8,
    unit: "l",
    category: "pivo",
    searchTerms: ["pivo", "světlé pivo", "ležák", "výčepní pivo"],
    rawContext: "SVIJANSKÝ MÁZ světlý ležák 0,5 l | 1 l 23,80 Kč < 10,90 Kč záloha na lahev 3 Kč",
  },
  {
    product: "PROSECCO bílé perlivé",
    price: 59.9,
    priceText: "59,90 Kč",
    packageSize: "0,75 l",
    unitPrice: 93.2,
    unit: "l",
    category: "alkohol",
    searchTerms: ["alkohol", "sekt", "šumivé víno", "prosecco"],
    rawContext: "PROSECCO bílé perlivé 0,75 l 1 l 93,20 Kč < 59,90 Kč",
  },
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
  const category = candidate.category ?? "";
  const searchTerms = unique([
    ...(Array.isArray(candidate.searchTerms) ? candidate.searchTerms : []),
    category,
    ...(category === "pivo" ? ["pivo", "světlé pivo", "ležák", "výčepní pivo"] : []),
  ]);

  return {
    id: `penny-v2-conservative-${hashId([product, candidate.price, candidate.pageNumber ?? 20])}`,
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
    pageNumber: Number(candidate.pageNumber ?? 20),
    imageUrl: candidate.imageUrl ?? "",
    pageImageUrl: candidate.pageImageUrl ?? `https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/${Number(candidate.pageNumber ?? 20)}/files/assets/cover300.jpg`,
    imageType: candidate.imageType ?? "penny-page",
    sourceUrl: candidate.sourceUrl ?? `https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/${Number(candidate.pageNumber ?? 20)}/index.html`,
    category,
    searchTerms,
    compareKey: candidate.compareKey ?? (category || normalizeSearch(product)),
    confidence: "penny-v2-conservative",
    source: "penny-hidden-html-page20-conservative",
    suspect: false,
    rawContext: candidate.rawContext ?? "",
  };
}

function shouldUseCandidate(candidate) {
  if (Number(candidate.pageNumber ?? 20) !== 20) return false;
  if ((candidate.confidence ?? "") !== "targeted-page20") return false;
  if ((candidate.candidateBucket ?? "safe") !== "safe") return false;

  const product = offerName(candidate);
  if (/STAROPRAMEN 10|KRUŠOVICE 12/iu.test(product)) return false;
  if (/STAROČECH polotmavý|MUSTANG HOŘKÝ/iu.test(candidate.rawContext ?? "")) return false;
  if (/záloha na lahev|tuku|pomeranč/iu.test(product)) return false;

  return true;
}

async function loadCandidates() {
  const cleanContainer = await loadJson(CLEAN_CANDIDATES_PATH, null);

  if (cleanContainer && Array.isArray(cleanContainer.safeCandidates)) {
    const candidates = cleanContainer.safeCandidates.filter(shouldUseCandidate);
    if (candidates.length > 0) {
      return {
        source: CLEAN_CANDIDATES_PATH,
        candidates,
      };
    }
  }

  return {
    source: "fallback-hardcoded-page20-safe-list",
    candidates: FALLBACK_SAFE_PAGE20_OFFERS.map((offer) => ({
      ...offer,
      pageNumber: 20,
      confidence: "targeted-page20",
      candidateBucket: "safe",
      validTo: "19.05.2026",
      pageImageUrl: "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/20/files/assets/cover300.jpg",
      sourceUrl: "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/20/index.html",
      imageType: "penny-page",
    })),
  };
}

async function main() {
  await mkdir("data/penny-probe", { recursive: true });

  const originalContainer = await loadJson(PENNY_INPUT_PATH, { meta: {}, offers: [] });
  const originalOffers = extractOffers(originalContainer);

  if (!originalOffers.length) {
    throw new Error(`No offers found in ${PENNY_INPUT_PATH}`);
  }

  const existingLooseKeys = new Set(originalOffers.map(productLooseKey).filter(Boolean));
  const existingExactKeys = new Set(originalOffers.map(offerKey).filter(Boolean));

  const { source, candidates } = await loadCandidates();

  const normalizedCandidates = candidates.map(cleanCandidateOffer);

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
    pennyImportV2Conservative: {
      updatedAt: new Date().toISOString(),
      source,
      originalCount: originalOffers.length,
      addedCount: added.length,
      skippedCount: skipped.length,
      outputCount: outputOffers.length,
      strategy: "append-safe-targeted-page20-only",
      excluded: [
        "generic-hidden-html mimo page 20",
        "reviewCandidates",
        "rejectedCandidates",
        "STAROPRAMEN 10 přilepený na STAROČECH polotmavý",
        "KRUŠOVICE 12 přilepený na MUSTANG HOŘKÝ",
      ],
    },
  });

  await writeFile(PENNY_BACKUP_OUTPUT_PATH, JSON.stringify(originalContainer, null, 2) + "\n", "utf8");
  await writeFile(PENNY_OUTPUT_PATH, JSON.stringify(outputContainer, null, 2) + "\n", "utf8");

  const report = {
    checkedAt: new Date().toISOString(),
    source,
    summary: {
      inputPennyOffers: originalOffers.length,
      candidateOffersLoaded: candidates.length,
      normalizedCandidates: normalizedCandidates.length,
      addedOffers: added.length,
      skippedOffers: skipped.length,
      outputPennyOffers: outputOffers.length,
      recommendedNextStep: "run-combine-offers-and-test-search-pivo-branik-krusovice",
    },
    added: added.map((offer) => ({
      product: offer.product,
      priceText: offer.priceText,
      packageSize: offer.packageSize,
      category: offer.category,
      searchTerms: offer.searchTerms,
      pageNumber: offer.pageNumber,
    })),
    skipped,
  };

  await writeFile(REPORT_OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("Penny import v2 conservative finished.");
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
