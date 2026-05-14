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

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeMainPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  const oneDecimal = Math.round(value * 10) / 10;
  if (Math.abs(value - oneDecimal) <= 0.025) return oneDecimal;

  return round2(value);
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

function pennyPageImageUrl(pageNumber) {
  if (!pageNumber) return "";
  return `${VIEWER_BASE_URL}${pageNumber}/files/assets/cover300.jpg`;
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

  for (let i = 0; i < 12; i++) {
    const before = current;

    current = current
      .replace(/^(?:\|\s*)?<\s*\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^v nabídce také\s+.*?\s+(?:za|od)\s+\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^v limitované nabídce také\s+.*?\s+(?:za|od)\s+\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^od\s+\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč\s*/i, "")
      .replace(/^\|\s*/, "")
      .replace(/^(?:Super Cena!|nabídka Jedinečná|NOVINKA)\s*/i, "")
      .trim();

    if (current === before) break;
  }

  return current;
}

function normalizeProductName(name) {
  return name
    .replace(/^[<>\s|]+/g, "")
    .replace(/\*+$/g, "")
    .replace(/\b(Super Cena!|nabídka Jedinečná|NOVINKA)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenProductPrefix(prefix) {
  let value = normalizeProductName(prefix);

  value = value
    .replace(/\s+\|\s*$/g, "")
    .replace(/\s+(různé druhy|různé barvy|chlazené|mražené|balené|volná|volné|krájený|krájená|přírodní|uzený|uzená|neochucené|polotučné|nízkotučné|světlý|s příchutí|ze zmrazeného|cena za).*$/i, "")
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
  const match = segmentAfterUnit.match(/^\s*(?:\|\s*)?<\s*(\d{1,4}(?:\s?\d{3})*,\d{2})\s*Kč/i);
  return match ? toNumber(match[1]) : null;
}

function parseUnitInfo(unitText) {
  const match = unitText.match(/^(.+?)\s+(\d{1,4}(?:\s?\d{3})*(?:,\d{1,2})?(?:\s*[\/–-]\s*\d{1,4}(?:\s?\d{3})*(?:,\d{1,2})?)*)\s*Kč$/i);
  if (!match) return null;

  const unitBase = match[1].replace(/\s+/g, " ").trim();
  const rawPrices = match[2]
    .split(/[\/–-]/)
    .map((part) => toNumber(part))
    .filter((value) => value !== null);

  const unitPrice = rawPrices[0] ?? null;

  return {
    unitBase,
    unitPrice,
    unitPrices: rawPrices,
    unit: `Kč/${unitBase}`,
  };
}

function parsePackageAmount(packageSize) {
  const value = packageSize.replace(/\s+/g, " ").trim().toLowerCase();

  if (/cena za 1 kg/.test(value)) return { variants: [{ amount: 1, unit: "kg" }] };

  const multi = value.match(/^(\d+)\s*x\s*(\d+(?:[,.]\d+)?)\s*(g|kg|ml|l|ks)$/i);
  if (multi) {
    return {
      variants: [{
        amount: Number(multi[1]) * toNumber(multi[2]),
        unit: multi[3].toLowerCase(),
      }],
    };
  }

  const slash = value.match(/^(\d+(?:[,.]\d+)?)\s*\/\s*(\d+(?:[,.]\d+)?)\s*(g|kg|ml|l|ks)$/i);
  if (slash) {
    return {
      variants: [
        { amount: toNumber(slash[1]), unit: slash[3].toLowerCase() },
        { amount: toNumber(slash[2]), unit: slash[3].toLowerCase() },
      ],
    };
  }

  const range = value.match(/^(\d+(?:[,.]\d+)?)\s*[–-]\s*(\d+(?:[,.]\d+)?)\s*(g|kg|ml|l|ks)$/i);
  if (range) {
    return {
      variants: [
        { amount: toNumber(range[1]), unit: range[3].toLowerCase() },
        { amount: toNumber(range[2]), unit: range[3].toLowerCase() },
      ],
    };
  }

  const simple = value.match(/^(\d+(?:[,.]\d+)?)\s*(g|kg|ml|l|ks|m)$/i);
  if (simple) {
    return { variants: [{ amount: toNumber(simple[1]), unit: simple[2].toLowerCase() }] };
  }

  return null;
}

function computeCandidatePrice(packageVariant, unitBase, unitPrice) {
  if (unitPrice === null) return null;

  const base = unitBase.replace(/\s+/g, " ").trim().toLowerCase();
  const pkg = packageVariant;

  let factor = null;

  if (base === "100 g" && pkg.unit === "g") factor = pkg.amount / 100;
  if (base === "1 kg" && pkg.unit === "g") factor = pkg.amount / 1000;
  if (base === "1 kg" && pkg.unit === "kg") factor = pkg.amount;
  if (base === "100 ml" && pkg.unit === "ml") factor = pkg.amount / 100;
  if (base === "1 l" && pkg.unit === "ml") factor = pkg.amount / 1000;
  if (base === "1 l" && pkg.unit === "l") factor = pkg.amount;
  if (base === "1 ks" && pkg.unit === "ks") factor = pkg.amount;
  if (base === "100 ks" && pkg.unit === "ks") factor = pkg.amount / 100;
  if (base === "1 m" && pkg.unit === "m") factor = pkg.amount;

  if (factor === null || !Number.isFinite(factor)) return null;
  return normalizeMainPrice(unitPrice * factor);
}

function nearestLeadPrice(price, leadPrices) {
  if (price === null || !leadPrices?.length) return null;

  let best = null;
  for (const leadPrice of leadPrices) {
    const diff = Math.abs(price - leadPrice);
    if (!best || diff < best.diff) best = { price: leadPrice, diff };
  }

  return best;
}

function getAdjustedUnitPrices(unitBase, unitPrices) {
  const base = String(unitBase || "").replace(/\s+/g, " ").trim().toLowerCase();
  const adjusted = [];

  for (const unitPrice of unitPrices ?? []) {
    adjusted.push({ unitPrice, adjustment: "none" });

    // FlippingBook text občas posune desetinnou čárku u malých tekutých položek:
    // "100 ml 19,80 Kč" má podle cenového bloku odpovídat 1,98 Kč / 100 ml.
    if ((base === "100 ml" || base === "100 g") && unitPrice >= 10) {
      adjusted.push({
        unitPrice: normalizeMainPrice(unitPrice / 10),
        adjustment: "divide-by-10",
      });
    }
  }

  return adjusted;
}

function computeMainPriceFromUnit(packageSize, unitBase, unitPrices, leadPrices) {
  const pkg = parsePackageAmount(packageSize);
  if (!pkg) return null;

  const candidates = [];
  const prices = getAdjustedUnitPrices(unitBase, unitPrices);

  for (const variant of pkg.variants) {
    for (const item of prices) {
      const price = computeCandidatePrice(variant, unitBase, item.unitPrice);
      if (price !== null) {
        const nearest = nearestLeadPrice(price, leadPrices);
        candidates.push({
          price,
          nearestLeadPrice: nearest?.price ?? null,
          leadDiff: nearest?.diff ?? null,
          unitPriceAdjustment: item.adjustment,
          adjustedUnitPrice: item.unitPrice,
        });
      }
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aDiff = a.leadDiff ?? Number.POSITIVE_INFINITY;
    const bDiff = b.leadDiff ?? Number.POSITIVE_INFINITY;
    return aDiff - bDiff || (a.unitPriceAdjustment === "none" ? -1 : 1) || a.price - b.price;
  });

  return candidates[0];
}

function choosePrice({ leadPrice, computed }) {
  if (computed?.price !== null && computed?.price !== undefined) {
    const shouldSnapToLead =
      computed.nearestLeadPrice !== null &&
      computed.nearestLeadPrice !== undefined &&
      computed.leadDiff !== null &&
      computed.leadDiff <= 0.15;

    return {
      price: shouldSnapToLead ? computed.nearestLeadPrice : computed.price,
      source:
        computed.unitPriceAdjustment && computed.unitPriceAdjustment !== "none"
          ? "computed-adjusted-unit-price"
          : "computed",
      nearestLeadPrice: computed.nearestLeadPrice,
      leadDiff: computed.leadDiff,
      rawComputedPrice: computed.price,
      unitPriceAdjustment: computed.unitPriceAdjustment ?? "none",
      adjustedUnitPrice: computed.adjustedUnitPrice ?? null,
      snappedToNearestLeadPrice: shouldSnapToLead && computed.nearestLeadPrice !== computed.price,
    };
  }

  if (leadPrice !== undefined && leadPrice !== null) {
    return {
      price: leadPrice,
      source: "lead",
      nearestLeadPrice: leadPrice,
      leadDiff: 0,
      rawComputedPrice: null,
      unitPriceAdjustment: "none",
      adjustedUnitPrice: null,
      snappedToNearestLeadPrice: false,
    };
  }

  return {
    price: null,
    source: "missing",
    nearestLeadPrice: null,
    leadDiff: null,
    rawComputedPrice: null,
    unitPriceAdjustment: "none",
    adjustedUnitPrice: null,
    snappedToNearestLeadPrice: false,
  };
}

function evaluateSuspectPrice({ price, unitBase, packageSize, leadDiff, nearestLeadPrice }) {
  const reasons = [];

  if (price === null || price === undefined || !Number.isFinite(price)) {
    reasons.push("missing-price");
  }

  if (price !== null && price !== undefined && Number.isFinite(price)) {
    if (price <= 0) reasons.push("non-positive-price");

    // Běžné položky v letáku mohou být drahé, ale extrémní dopočty jsou podezřelé.
    if (price > 999) reasons.push("very-high-price");

    // Nejčastější problém: tekutiny s jednotkovkou v textu jako 100 ml 19,80 Kč,
    // kde výpočet vyrobí 99 Kč, ale v horním cenovém bloku je spíš 9,90 Kč.
    const base = String(unitBase || "").replace(/\s+/g, " ").toLowerCase();
    if ((base === "100 ml" || base === "1 l") && price >= 80 && leadDiff !== null && leadDiff > 20) {
      reasons.push("liquid-price-far-from-leaflet-price");
    }

    // Obecné pravidlo: když výpočet nesedí na žádnou cenu z cenového bloku,
    // necháme položku v datech, ale nedáme jí high confidence.
    if (leadDiff !== null && leadDiff > 20) {
      reasons.push("computed-price-far-from-nearest-lead-price");
    }

    // U malých balení je cena nad 80 Kč skoro vždy podezřelá, pokud nesedí na cenový blok.
    if (/g|ml/.test(String(packageSize || "").toLowerCase()) && price >= 80 && leadDiff !== null && leadDiff > 15) {
      reasons.push("small-package-high-price");
    }
  }

  return {
    suspect: reasons.length > 0,
    reasons,
    nearestLeadPrice: nearestLeadPrice ?? null,
    leadDiff: leadDiff ?? null,
  };
}

function applyPriceSafety({ chosen, unitInfo, packageSize }) {
  const safety = evaluateSuspectPrice({
    price: chosen.price,
    unitBase: unitInfo.unitBase,
    packageSize,
    leadDiff: chosen.leadDiff,
    nearestLeadPrice: chosen.nearestLeadPrice,
  });

  const adjustedByUnitPrice =
    chosen.unitPriceAdjustment && chosen.unitPriceAdjustment !== "none";

  // Když se cena získala z opravené jednotkové ceny a sedí na cenový blok,
  // bereme ji jako bezpečnou.
  if (
    adjustedByUnitPrice &&
    chosen.leadDiff !== null &&
    chosen.leadDiff <= 0.15
  ) {
    return {
      chosen,
      safety: {
        suspect: false,
        reasons: [],
        nearestLeadPrice: chosen.nearestLeadPrice ?? null,
        leadDiff: chosen.leadDiff ?? null,
        unitPriceAdjustment: chosen.unitPriceAdjustment,
        adjustedUnitPrice: chosen.adjustedUnitPrice ?? null,
        snappedToNearestLeadPrice: chosen.snappedToNearestLeadPrice ?? false,
      },
    };
  }

  if (!safety.suspect) {
    return {
      chosen,
      safety: {
        ...safety,
        snappedToNearestLeadPrice: chosen.snappedToNearestLeadPrice ?? false,
      },
    };
  }

  // Neopravujeme na vzdálenou cenu z celé stránky, pouze označíme jako suspect.
  return {
    chosen,
    safety: {
      ...safety,
      correctedToNearestLeadPrice: false,
      snappedToNearestLeadPrice: chosen.snappedToNearestLeadPrice ?? false,
    },
  };
}

function hasUnparsedPriceBeforePackage(productPrefix) {
  return /(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*m)\s+\d{1,4}(?:\s?\d{3})*,\d{1,2}(?:\s*[\/–-]\s*\d{1,4}(?:\s?\d{3})*,\d{1,2})?\s*Kč/i.test(productPrefix);
}

function cleanupProductPrefixBeforePackage(productPrefix) {
  let value = productPrefix.replace(/\s+/g, " ").trim();

  // Když před aktuální položkou stojí položka bez jednotkové ceny typu
  // "BANÁNY cena za 1 kg BRAMBORY ... cena za 1 kg ŽAMPIONY 400 g 1 kg ...",
  // nechceme název před posledním "cena za ...".
  value = value.replace(/^.*\bcena\s+za\s+1\s+(?:kg|ks)\s+/i, "");

  // Když před aktuální položkou stojí jiná položka jen s balením bez jednotkové ceny:
  // "ČERSTVÝ SÝR ... 100 g RYBÍ POMAZÁNKA 135 g 100 g ..."
  // vezmeme text až za posledním hotovým balením.
  value = value.replace(
    /^.*\b(?:\d+\s*x\s*)?\d+(?:[ ,]\d+)?(?:\s*[\/–-]\s*\d+(?:[ ,]\d+)?)?\s*(?:g|kg|ml|l|ks|m|svazek|balení)\s+(?=[A-ZÁ-Ž])/,
    ""
  );

  // Varianta, kde je mezi starým balením a novým názvem ještě značka "< cena Kč":
  // "TAVENÝ SÝR ... 100 g < 11,90 Kč SÝROVÉ TYČINKY ..."
  value = value.replace(
    /^.*\b(?:\d+\s*x\s*)?\d+(?:[ ,]\d+)?(?:\s*[\/–-]\s*\d+(?:[ ,]\d+)?)?\s*(?:g|kg|ml|l|ks|m|svazek|balení)\s*<\s*\d{1,4}(?:\s?\d{3})*,\d{1,2}\s*Kč\s+(?=[A-ZÁ-Ž])/,
    ""
  );

  // Varianta, kde předchozí položka obsahuje jednotkovou cenu bez desetinné čárky:
  // "KOŘENĚNÉ MATJESY ... 100 g 23 Kč SHOT BIO ..."
  value = value.replace(
    /^.*\b(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*m)\s+\d{1,4}(?:\s?\d{3})*(?:,\d{1,2})?(?:\s*[\/–-]\s*\d{1,4}(?:\s?\d{3})*(?:,\d{1,2})?)*\s*Kč\s+(?=[A-ZÁ-Ž])/,
    ""
  );

  // Odstraň přívěsky bodových akcí, které se objevují za poslední položkou.
  value = value
    .replace(/\b\d+\s+bod(?:y|ů)?\s+navíc.*$/i, "")
    .replace(/\bMAX\.\s*osoba\/nákup\/\s*den.*$/i, "")
    .replace(/\bNabídka platná\b.*$/i, "")
    .trim();

  return value;
}

function parsePageProductLine(productLine, pageNumber, sourceUrl) {
  const validFrom = formatDateFromText(productLine, "od");
  let validTo = formatDateFromText(productLine, "do");

  // Některé stránky obsahují text "body můžete získat do 2. 6. 2026" před skutečnou platností letáku.
  const allDoDates = Array.from(productLine.matchAll(/do\s+[^0-9]*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/gi));
  if (allDoDates.length) {
    const last = allDoDates.at(-1);
    validTo = `do ${last[1].padStart(2, "0")}.${last[2].padStart(2, "0")}.${last[3]}`;
  }

  const cleaned = removePageNoise(productLine, pageNumber);
  const productStart = findFirstProductStart(cleaned);
  const body = productStart > 0 ? cleaned.slice(productStart) : cleaned;
  const leadPrices = extractLeadPrices(cleaned);

  const unitPriceRegex =
    /(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*m)\s+\d{1,4}(?:\s?\d{3})*(?:,\d{1,2})?(?:\s*[\/–-]\s*\d{1,4}(?:\s?\d{3})*(?:,\d{1,2})?)*\s*Kč/gi;

  const unitMatches = Array.from(body.matchAll(unitPriceRegex));
  const offers = [];
  let previousEnd = 0;
  let leadPriceIndex = 0;

  for (const unitMatch of unitMatches) {
    const unitStart = unitMatch.index ?? 0;
    let unitEnd = unitStart + unitMatch[0].length;

    const afterUnit = body.slice(unitEnd, unitEnd + 35);
    const explicitPrice = parseExplicitMainPrice(afterUnit);
    const explicitMatch = afterUnit.match(/^\s*(?:\|\s*)?<\s*\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč/i);
    if (explicitMatch) unitEnd += explicitMatch[0].length;

    let segment = body.slice(previousEnd, unitEnd);
    previousEnd = unitEnd;

    segment = trimLeadingJunk(segment);
    const unitLocalMatch = segment.match(unitPriceRegex);
    if (!unitLocalMatch) continue;

    const unitLocalStart = segment.search(unitPriceRegex);
    const beforeUnit = segment.slice(0, unitLocalStart);
    const unitText = unitLocalMatch[0];

    const packageMatch = getLastPackageBeforeUnit(beforeUnit);
    if (!packageMatch) continue;

    const packageSize = packageMatch[1].replace(/\s+/g, " ").trim();
    const rawProductPrefix = beforeUnit.slice(0, packageMatch.index).trim();
    const productPrefix = cleanupProductPrefixBeforePackage(rawProductPrefix);
    const product = shortenProductPrefix(productPrefix);

    if (isBadProductName(product)) continue;

    if (hasUnparsedPriceBeforePackage(productPrefix)) {
      previousEnd = unitEnd;
      leadPriceIndex += 1;
      continue;
    }

    const unitInfo = parseUnitInfo(unitText);
    if (!unitInfo) continue;

    const leadPrice = leadPrices[leadPriceIndex] ?? null;
    const computed = computeMainPriceFromUnit(packageSize, unitInfo.unitBase, unitInfo.unitPrices, leadPrices);
    const chosenRaw = choosePrice({ leadPrice, computed });
    const { chosen, safety } = applyPriceSafety({ chosen: chosenRaw, unitInfo, packageSize });

    // Lead cenu posouváme pro každou nalezenou položku, ale nepovažujeme ji za spolehlivý zdroj hlavní ceny.
    leadPriceIndex += 1;

    const confidence =
      safety.suspect
        ? "medium"
        : chosen.price !== null &&
            product.length > 8 &&
            !/^v nabídce/i.test(product) &&
            chosen.leadDiff !== null &&
            chosen.leadDiff <= 0.15
          ? "high"
          : chosen.price !== null && product.length > 8 && !/^v nabídce/i.test(product)
            ? "medium"
            : "low";

    offers.push({
      id: makeId(product, chosen.price ?? unitInfo.unitPrice ?? 0, pageNumber, packageSize),
      storeId: "penny-default",
      chain: "Penny",
      storeName: "Penny – leták",
      product,
      brand: "",
      packageSize,
      price: chosen.price,
      unitPrice: unitInfo.unitPrice,
      unit: unitInfo.unit,
      validFrom: validFrom || "od st 13.05.2026",
      validTo: validTo || "do 19.05.2026",
      priceType: "leták",
      sourceUrl,
      pageNumber,
      imageUrl: "",
      pageImageUrl: pennyPageImageUrl(pageNumber),
      imageType: "page-thumbnail",
      imageAlt: `${product} – stránka letáku ${pageNumber}`,
      confidence,
      suspect: safety.suspect,
      suspectReasons: safety.reasons,
      debug: {
        priceSource: chosen.source,
        leadPrice,
        computedPrice: computed?.price ?? null,
        rawComputedPrice: chosen.rawComputedPrice ?? null,
        originalComputedPrice: chosen.originalComputedPrice ?? null,
        unitPriceAdjustment: chosen.unitPriceAdjustment ?? "none",
        adjustedUnitPrice: chosen.adjustedUnitPrice ?? null,
        snappedToNearestLeadPrice: chosen.snappedToNearestLeadPrice ?? false,
        nearestLeadPrice: chosen.nearestLeadPrice ?? null,
        leadDiff: chosen.leadDiff ?? null,
        safety,
        ignoredExplicitAfterUnitPrice: explicitPrice,
        rawProductPrefix,
        cleanedProductPrefix: productPrefix,
      },
    });
  }

  return { cleaned, body, leadPrices, offers };
}

async function fetchPage(pageNumber) {
  const url = `${VIEWER_BASE_URL}${pageNumber}/index.html`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyLeafletHtmlImport/0.9; +https://github.com/)",
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

  const publicOffers = offers.map(({ debug, ...offer }) => offer);

  const meta = {
    source: VIEWER_BASE_URL,
    updatedAt: new Date().toISOString(),
    count: publicOffers.length,
    parser: "scripts/import-penny-leaflet-html.mjs",
    parserVersion: "0.9",
    note: "V9: oprava přenosu metadat u dopočtů s upravenou jednotkovou cenou a jemné dorovnání na cenu z letákového cenového bloku, pokud se výpočet liší jen do 15 haléřů. Penny má zatím jen miniatury stránky letáku, ne samostatné produktové obrázky.",
  };

  await writeFile(OUTPUT_FILE, JSON.stringify({ meta, offers: publicOffers }, null, 2) + "\n", "utf8");

  await writeFile(
    DEBUG_FILE,
    JSON.stringify(
      {
        meta,
        summary: {
          pagesChecked: pages.length,
          pagesWithProductLine: pages.filter((page) => page.productLine).length,
          parsedOffers: offers.length,
          highConfidenceOffers: offers.filter((offer) => offer.confidence === "high").length,
          mediumConfidenceOffers: offers.filter((offer) => offer.confidence === "medium").length,
          lowConfidenceOffers: offers.filter((offer) => offer.confidence === "low").length,
          suspectOffers: offers.filter((offer) => offer.suspect).length,
          safetyCorrectedOffers: offers.filter((offer) => offer.debug?.priceSource === "safety-nearest-lead").length,
          adjustedUnitPriceOffers: offers.filter((offer) => offer.debug?.priceSource === "computed-adjusted-unit-price").length,
          computedPriceOffers: offers.filter((offer) => offer.debug?.priceSource === "computed").length,
          explicitPriceOffers: offers.filter((offer) => offer.debug?.priceSource === "explicit").length,
          leadPriceOffers: offers.filter((offer) => offer.debug?.priceSource === "lead").length,
        },
        pages,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Imported ${publicOffers.length} Penny leaflet candidate offers to ${OUTPUT_FILE}`);
  console.log(`Wrote debug to ${DEBUG_FILE}`);

  if (publicOffers.length === 0) {
    throw new Error("Penny leaflet HTML import failed: no candidate offers parsed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
