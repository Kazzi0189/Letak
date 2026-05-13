import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const VIEWER_BASE_URL = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/";
const OUTPUT_FILE = "data/penny-leaflet-offers.json";
const DEBUG_FILE = "data/penny-leaflet-html-debug.json";

function decodeHtml(value = "") {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function htmlToLines(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|span|a)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function formatDateFromText(text, prefix) {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`${escapedPrefix}\\s+[^\\d]*(\\d{1,2})\\.\\s*(\\d{1,2})\\.\\s*(\\d{4})`, "i"));
  if (!match) return "";
  return `${prefix} ${match[1].padStart(2, "0")}.${match[2].padStart(2, "0")}.${match[3]}`;
}

function makeId(product, price, pageNumber, packageSize) {
  return (
    "penny-leaflet-" +
    createHash("sha1")
      .update(`${product}|${price}|${pageNumber}|${packageSize}`)
      .digest("hex")
      .slice(0, 16)
  );
}

function removePageNoise(text, pageNumber) {
  return text
    .replace(new RegExp(`^\\s*${pageNumber}\\s+`, "i"), "")
    .replace(/nízké ceny hezky česky/gi, " ")
    .replace(/<\s*Nejnižší cena za posledních 30 dní/gi, " ")
    .replace(/Nejnižší cena za posledních 30 dní/gi, " ")
    .replace(/ilustrační foto/gi, " ")
    .replace(/Made with FlippingBook/gi, " ")
    .replace(/RkJQdWJsaXNoZXIy\s*NTcyMjUw/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstProductStart(text) {
  const markers = [
    /KUŘECÍ\s+ZADNÍ/i,
    /ZÁVIN\s+KARLOVA/i,
    /CAMEMBERT/i,
    /SALÁT\s+VLAŠSKÝ/i,
    /OLOMOUCKÝ\s+TVAROH/i,
    /PROTEINOVÝ\s+NÁPOJ/i,
    /ZMRZLINA\s+MINI/i,
    /ZELENINOVÁ\s+SMĚS/i,
    /MISTROVSKÁ\s+DUŠENÁ/i,
    /VEPŘOVÉ\s+MASO/i,
    /BRAMBOROVÉ\s+NOKY/i,
    /OBALOVANÝ\s+SÝR/i,
    /TYČINKA\s+MARGOT/i,
    /MÁSLO\s+82/i,
    /APEROL/i,
  ];

  const indexes = markers
    .map((regex) => text.match(regex)?.index ?? -1)
    .filter((index) => index >= 0);

  if (indexes.length) return Math.min(...indexes);

  const generic = text.search(/[A-ZÁ-Ž][A-ZÁ-Ž0-9 %&.,'’\-]{5,}\s+(?:různé druhy|chlazené|mražené|balené|krájený|krájená|přírodní|uzený|cena za|[\d,]+\s*(?:g|kg|ml|l|ks))/);
  return generic >= 0 ? generic : 0;
}

function extractLeadPrices(text) {
  const start = findFirstProductStart(text);
  const head = start > 0 ? text.slice(0, start) : "";
  const prices = [];
  const regex = /(?:\*\*)?(\d{1,4}(?:\s?\d{3})*,\d{2})/g;
  let match;

  while ((match = regex.exec(head))) {
    const after = head.slice(regex.lastIndex, regex.lastIndex + 12);
    if (/^\s*\/\s*\d+\s*%/.test(after)) continue;

    const price = toNumber(match[1]);
    if (price !== null) prices.push(price);
  }

  return prices;
}

function trimLeadingJunk(segment) {
  let current = segment.trim();

  for (let i = 0; i < 10; i++) {
    const before = current;

    current = current
      .replace(/^(?:\|\s*)?<\s*\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^v nabídce také\s+.*?\s+za\s+\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^v limitované nabídce také\s+.*?\s+za\s+\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^od\s+\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^\|\s*/, "")
      .replace(/^(?:Super Cena!|nabídka Jedinečná)\s*/i, "")
      .trim();

    if (current === before) break;
  }

  return current;
}

function normalizeProductName(name) {
  return name
    .replace(/^[<>\s|]+/g, "")
    .replace(/\*+$/g, "")
    .replace(/\b(Super Cena!|nabídka Jedinečná)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenProductPrefix(prefix) {
  let value = normalizeProductName(prefix);

  value = value
    .replace(/\s+\|\s*$/g, "")
    .replace(/\s+(různé druhy|různé barvy|chlazené|mražené|balené|volná|volné|krájený|krájená|přírodní|uzený|uzená|neochucené|polotučné|nízkotučné|světlý|s příchutí|ze zmrazeného|cena za).*$/i, "")
    .replace(/\s+(s|se|v)\s+[a-zá-ž].*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return value;
}

function isBadProductName(name) {
  return (
    !name ||
    name.length < 4 ||
    name.length > 95 ||
    /^(BIO|NOVINKA|MAX|CENA|ZA|PŘI|KOUPI|BALENÍ|V BALENÍ|A VÍCE|MASA|KČ)$/i.test(name) ||
    /^Kč\s/i.test(name) ||
    !/[A-ZÁ-Ž]{3}/.test(name)
  );
}

function getLastPackageBeforeUnit(textBeforeUnit) {
  const packageRegex =
    /((?:\d+\s*x\s*)?\d+(?:[ ,]\d+)?(?:\s*[\/–-]\s*\d+(?:[ ,]\d+)?)?\s*(?:g|kg|ml|l|ks|m|svazek|balení)|cena za 1 kg)/gi;

  const matches = Array.from(textBeforeUnit.matchAll(packageRegex));
  return matches.at(-1) ?? null;
}

function parseExplicitMainPrice(segmentAfterUnit) {
  const match = segmentAfterUnit.match(/<\s*(\d{1,4}(?:\s?\d{3})*,\d{2})\s*Kč/i);
  return match ? toNumber(match[1]) : null;
}

function parsePageProductLine(productLine, pageNumber, sourceUrl) {
  const validFrom = formatDateFromText(productLine, "od");
  const validTo = formatDateFromText(productLine, "do");

  const cleaned = removePageNoise(productLine, pageNumber);
  const productStart = findFirstProductStart(cleaned);
  const body = productStart > 0 ? cleaned.slice(productStart) : cleaned;
  const leadPrices = extractLeadPrices(cleaned);

  const unitPriceRegex =
    /(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*m)\s+\d{1,4}(?:\s?\d{3})*,\d{1,2}\s*Kč/gi;

  const unitMatches = Array.from(body.matchAll(unitPriceRegex));
  const offers = [];
  let previousEnd = 0;
  let leadPriceIndex = 0;

  for (const unitMatch of unitMatches) {
    const unitStart = unitMatch.index ?? 0;
    let unitEnd = unitStart + unitMatch[0].length;

    const afterUnit = body.slice(unitEnd, unitEnd + 80);
    const explicitPrice = parseExplicitMainPrice(afterUnit);
    const explicitMatch = afterUnit.match(/^\s*(?:\|\s*)?<\s*\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč/i);
    if (explicitMatch) unitEnd += explicitMatch[0].length;

    let segment = body.slice(previousEnd, unitEnd);
    previousEnd = unitEnd;

    segment = trimLeadingJunk(segment);
    const unitLocalStart = segment.search(unitPriceRegex);
    if (unitLocalStart < 0) continue;

    const beforeUnit = segment.slice(0, unitLocalStart);
    const unitText = segment.match(unitPriceRegex)?.[0] ?? "";

    const packageMatch = getLastPackageBeforeUnit(beforeUnit);
    if (!packageMatch) continue;

    const packageSize = packageMatch[1].replace(/\s+/g, " ").trim();
    const productPrefix = beforeUnit.slice(0, packageMatch.index).trim();
    const product = shortenProductPrefix(productPrefix);

    if (isBadProductName(product)) continue;

    const unitMatchParts = unitText.match(/^(.+?)\s+(\d{1,4}(?:\s?\d{3})*,\d{1,2})\s*Kč$/i);
    const unitPrice = unitMatchParts ? toNumber(unitMatchParts[2]) : null;
    const unit = unitMatchParts ? `Kč/${unitMatchParts[1].replace(/\s+/g, " ")}` : "Kč/ks";

    let price = explicitPrice;
    if (price === null) {
      price = leadPrices[leadPriceIndex] ?? null;
      leadPriceIndex += 1;
    }

    const confidence =
      price !== null && product.length > 8 && !/^(ZÁVIN|SUPER|CHLÉB|DORT|TVAROH|JOGURT|MLÉKO|SALÁM|SÝR)$/i.test(product)
        ? "medium"
        : "low";

    offers.push({
      id: makeId(product, price ?? unitPrice ?? 0, pageNumber, packageSize),
      storeId: "penny-default",
      chain: "Penny",
      storeName: "Penny – leták",
      product,
      brand: "",
      packageSize,
      price,
      unitPrice: unitPrice ?? price,
      unit,
      validFrom: validFrom || "od st 13.05.2026",
      validTo: validTo || "do út 19.05.2026",
      priceType: "leták",
      sourceUrl,
      pageNumber,
      confidence,
    });
  }

  return { cleaned, body, leadPrices, offers };
}

async function fetchPage(pageNumber) {
  const url = `${VIEWER_BASE_URL}${pageNumber}/index.html`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyLeafletHtmlImport/0.2; +https://github.com/)",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  const html = await response.text();
  const lines = htmlToLines(html);
  const productLine =
    lines
      .filter((line) => /\d{1,4},\d{2}/.test(line) && /Kč|Nabídka platná|cena za/i.test(line))
      .sort((a, b) => b.length - a.length)[0] ?? "";

  return {
    pageNumber,
    url,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    productLine,
    firstLines: lines.slice(0, 12),
  };
}

async function main() {
  await mkdir("data", { recursive: true });

  const pages = [];
  const allOffers = [];

  for (let pageNumber = 2; pageNumber <= 37; pageNumber++) {
    const page = await fetchPage(pageNumber);
    pages.push(page);

    if (!page.ok || !page.productLine) continue;

    const parsed = parsePageProductLine(page.productLine, page.pageNumber, page.finalUrl);
    page.cleanedPreview = parsed.cleaned.slice(0, 1400);
    page.bodyPreview = parsed.body.slice(0, 1400);
    page.leadPrices = parsed.leadPrices;
    page.offersCount = parsed.offers.length;
    page.firstOffers = parsed.offers.slice(0, 25);

    allOffers.push(...parsed.offers);
  }

  const unique = new Map();
  for (const offer of allOffers) {
    const key = `${offer.product}|${offer.packageSize}|${offer.price}|${offer.pageNumber}`;
    unique.set(key, offer);
  }

  const offers = Array.from(unique.values()).sort(
    (a, b) => a.pageNumber - b.pageNumber || a.product.localeCompare(b.product, "cs")
  );

  const meta = {
    source: VIEWER_BASE_URL,
    updatedAt: new Date().toISOString(),
    count: offers.length,
    parser: "scripts/import-penny-leaflet-html.mjs",
    parserVersion: "0.2",
    note:
      "V2: lepší dělení produktů podle jednotkových cen a lepší zachování víceslovných názvů. Stále testovací parser nad HTML textem FlippingBook.",
  };

  await writeFile(OUTPUT_FILE, JSON.stringify({ meta, offers }, null, 2) + "\n", "utf8");

  await writeFile(
    DEBUG_FILE,
    JSON.stringify(
      {
        meta,
        summary: {
          pagesChecked: pages.length,
          pagesWithProductLine: pages.filter((page) => page.productLine).length,
          parsedOffers: offers.length,
          mediumConfidenceOffers: offers.filter((offer) => offer.confidence === "medium").length,
          lowConfidenceOffers: offers.filter((offer) => offer.confidence === "low").length,
        },
        pages,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Imported ${offers.length} Penny leaflet candidate offers to ${OUTPUT_FILE}`);
  console.log(`Wrote debug to ${DEBUG_FILE}`);

  if (offers.length === 0) {
    throw new Error("Penny leaflet HTML import failed: no candidate offers parsed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
