import { mkdir, readFile, writeFile } from "node:fs/promises";

const PDF_TEXT_PATH = "data/penny-pdf-pages.json";
const OFFERS_PATH = "data/offers.json";
const OUTPUT_DIR = "data/penny-probe";
const REPORT_PATH = `${OUTPUT_DIR}/penny-pdf-full-import-v1-summary.json`;

const TARGET_CHECKS = [
  {
    label: "Prosecco current price",
    query: "PROSECCO bílé perlivé",
    expectedPage: 20,
    expectedCurrentPrice: 69.90,
    note: "V PDF je aktuální cena 69,90 Kč; < 59,90 Kč je nejnižší cena za posledních 30 dní.",
  },
  { label: "Trvanlivé mléko Boni", query: "TRVANLIVÉ MLÉKO BONI", expectedPage: 4 },
  { label: "Mléko čerstvé Karlova Koruna", query: "MLÉKO ČERSTVÉ 3,5% KARLOVA KORUNA", expectedPage: 5 },
  { label: "Kefírové mléko", query: "KEFÍROVÉ MLÉKO KARLOVA KORUNA", expectedPage: 5 },
  { label: "Acidofilní mléko", query: "MLÉKO ACIDOFILNÍ KARLOVA KORUNA", expectedPage: 5 },
  { label: "Trvanlivé plnotučné mléko Madeta", query: "TRVANLIVÉ PLNOTUČNÉ MLÉKO MADETA", expectedPage: 32 },
  { label: "Braník", query: "BRANÍK", expectedPage: 20 },
  { label: "Káva Casablanca ochucená", query: "KÁVA CASABLANCA OCHUCENÁ", expectedPage: 23 },
  { label: "Woolite", query: "GEL NA PRANÍ WOOLITE", expectedPage: 24 },
  { label: "Woolite additional offer", query: "GEL NA PRANÍ WOOLITE colors", expectedPage: 35 },
  { label: "Zahrada Kristalon", query: "HNOJIVO KRISTALON", expectedPage: 28 },
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

function offerProduct(offer) {
  return String(offer.product ?? offer.name ?? offer.title ?? "").trim();
}

function pageNumber(offer) {
  const n = Number(offer.pageNumber ?? offer.page ?? offer.leafletPage ?? "");
  return Number.isFinite(n) && n > 0 ? n : null;
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

function moneyText(value) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return Number(value).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " Kč";
}

function countPriceLikeMarkers(text) {
  const clean = String(text || "");
  const currentPricePairs = [...clean.matchAll(/\b\d{1,4},\d{2}\s+\d{1,4},\d{2}\s*\/\s*\d{1,3}%/g)];
  const uniqueOfferPrices = new Set(currentPricePairs.map((m) => m[0].split(/\s+/)[0]));
  const uniqueJedinecna = new Set([...clean.matchAll(/nabídka\s+Jedinečná\s+(\d{1,4},\d{2})/giu)].map((m) => m[1]));
  const superCena = new Set([...clean.matchAll(/Super\s+Cena!\s+(\d{1,4},\d{2})/giu)].map((m) => m[1]));
  return {
    pricePairs: currentPricePairs.length,
    uniqueCurrentPriceSamples: Array.from(uniqueOfferPrices).slice(0, 25),
    jedinecnaPrices: uniqueJedinecna.size,
    superCenaPrices: superCena.size,
    roughPriceMarkerCount: currentPricePairs.length + uniqueJedinecna.size + superCena.size,
  };
}

function pageHasProductLikeText(text) {
  const t = normalizeSearch(text);
  if (!t) return false;
  if (t.includes("letakovy") || t.includes("penny karta")) return true;
  return /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]{3,}/u.test(String(text || ""));
}

function roughProductLineCount(text) {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 4) continue;
    if (/^(00|00,00|<|nabídka|Jedinečná|Super|Cena|Nabídka|nízké ceny|Nejnižší cena|MAX\.|osoba|den|ilustrační foto)$/iu.test(line)) continue;
    if (/^\d{1,4},\d{2}$/.test(line)) continue;
    if (/^\d+\s*(g|kg|ml|l|ks|m)$/iu.test(line)) continue;
    if (/[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]{3,}/u.test(line)) count++;
  }
  return count;
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
  };
}

function byPage(offers) {
  const map = new Map();
  for (const offer of offers) {
    const page = pageNumber(offer);
    if (!page) continue;
    if (!map.has(page)) map.set(page, []);
    map.get(page).push(offer);
  }
  return map;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pdf = JSON.parse(await readFile(PDF_TEXT_PATH, "utf8"));
  const offersContainer = JSON.parse(await readFile(OFFERS_PATH, "utf8"));
  const offers = extractOffers(offersContainer);
  const pennyOffers = offers.filter(isPennyOffer);
  const pennyByPage = byPage(pennyOffers);

  const pages = Array.isArray(pdf.pages) ? pdf.pages : [];
  const pageReports = pages.map((page) => {
    const text = page.text || "";
    const prices = countPriceLikeMarkers(text);
    const currentOffers = pennyByPage.get(page.pageNumber) ?? [];
    return {
      pageNumber: page.pageNumber,
      pdfTextLength: text.length,
      roughPdfProductLineCount: roughProductLineCount(text),
      roughPriceMarkerCount: prices.roughPriceMarkerCount,
      pricePairs: prices.pricePairs,
      jedinecnaPrices: prices.jedinecnaPrices,
      superCenaPrices: prices.superCenaPrices,
      currentPennyOffers: currentOffers.length,
      currentPennyOfferSamples: currentOffers.slice(0, 12).map(simplify),
    };
  });

  const targetChecks = TARGET_CHECKS.map((check) => {
    const q = normalizeSearch(check.query);
    const pdfPages = pages
      .filter((page) => normalizeSearch(page.text || "").includes(q))
      .map((page) => page.pageNumber);

    const currentMatches = pennyOffers.filter((offer) => normalizeSearch(searchableText(offer)).includes(q));
    const priceProblems = [];

    if (check.expectedCurrentPrice != null) {
      const expected = Number(check.expectedCurrentPrice);
      const samePageMatches = currentMatches.filter((offer) => pageNumber(offer) === check.expectedPage);
      for (const offer of samePageMatches) {
        if (Math.abs(Number(offer.price ?? 0) - expected) > 0.001) {
          priceProblems.push({
            product: offerProduct(offer),
            actualPrice: offer.price ?? null,
            expectedPrice: expected,
            actualPriceText: offer.priceText ?? "",
            expectedPriceText: moneyText(expected),
          });
        }
      }
    }

    return {
      ...check,
      foundInPdfPages: pdfPages,
      currentMatches: currentMatches.length,
      currentMatchSamples: currentMatches.slice(0, 10).map(simplify),
      status:
        pdfPages.length === 0
          ? "missing-in-pdf-text"
          : currentMatches.length === 0
            ? "missing-in-current-offers"
            : priceProblems.length
              ? "price-mismatch"
              : "ok",
      priceProblems,
    };
  });

  const suspiciousPages = pageReports
    .filter((page) => page.roughPriceMarkerCount > 0)
    .map((page) => ({
      ...page,
      gapScore: Math.max(0, page.roughPriceMarkerCount - page.currentPennyOffers),
    }))
    .filter((page) => page.gapScore >= 5 || page.currentPennyOffers === 0)
    .sort((a, b) => b.gapScore - a.gapScore);

  const report = {
    checkedAt: new Date().toISOString(),
    type: "JEN KONTROLNÍ REPORT – DO APLIKACE NENAHRÁVAT",
    summary: {
      pdfPages: pages.length,
      totalOffers: offers.length,
      pennyOffers: pennyOffers.length,
      pagesWithCurrentPennyOffers: pennyByPage.size,
      targetChecksOk: targetChecks.filter((x) => x.status === "ok").length,
      targetChecksProblems: targetChecks.filter((x) => x.status !== "ok").length,
      suspiciousPages: suspiciousPages.length,
      recommendedPath: "build-penny-pdf-importer-from-page-text-and-confirm-with-samples",
    },
    targetChecks,
    suspiciousPages: suspiciousPages.slice(0, 37),
    pageReports,
    notes: [
      "Tento audit je záměrně kontrolní. Neimportuje data do aplikace.",
      "Ceny za znakem < jsou v Penny PDF nejnižší cena za posledních 30 dní, ne aktuální akční cena.",
      "Další krok je vytvořit nový Penny import, který bude používat pořadí/pozice cen a produktů napříč všemi stránkami PDF.",
    ],
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("Penny PDF full import v1 audit finished.");
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
