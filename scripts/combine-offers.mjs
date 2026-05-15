import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const INPUTS = [
  {
    name: "Penny leták",
    path: "data/penny-leaflet-offers.json",
    required: false,
  },
  {
    name: "Kaufland Teplice",
    path: "data/offers-kaufland-teplice.json",
    required: false,
  },
  {
    name: "Albert V7 clean",
    path: "data/albert-pdf-offers-clean.json",
    required: false,
  },
];

const OUTPUT_FILE = "data/offers.json";
const BACKUP_FILE = "data/offers-penny-last.json";
const DEBUG_FILE = "data/offers-combined-debug.json";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanProductNameFinal(product) {
  return String(product || '')
    .replace(/^\s*KUCHYNĚ\s+/iu, '')
    .replace(/^\s*AKČNÍ NABÍDKA\s+/iu, '')
    .replace(/^\s*NASTYLUJTE\s+/iu, '')
    .replace(/^\s*TR\s+O\s+/iu, '')
    .replace(/^\s*L\s+(?=Hovězí\b)/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldRejectFinalOffer(offer) {
  const product = String(offer.product || '');
  const description = String(offer.description || '');
  const context = `${product} ${description} ${offer.rawContext || ''}`;

  const badPatterns = [
    /\bNASTYLUJTE\b/iu,
    /\bVEZMĚTE SI\b/iu,
    /\bZ REGÁLU\b/iu,
    /\bA MUŽEŠ JÍ\(S\)T\b/iu,
    /\bPLATNÉM DO\b/iu,
    /\bHI T MĚSÍCE\b/iu,
    /\bSUPER CENA\b/iu,
    /\bAKČNÍ NABÍDKA\b/iu,
    /\bKREDIT NAVÍC\b/iu,
    /\bCENA BEZ BODŮ\b/iu,
    /\bVíce informací najdete\b/iu,
    /\balbert\.cz\/Freshbistro\b/iu,
  ];

  if (badPatterns.some((pattern) => pattern.test(context))) return true;
  if (/^\s*(NASTYLUJTE|VEZMĚTE SI|VÍCE INFORMACÍ|HI T MĚSÍCE|PLATNÉM DO)\b/iu.test(product)) return true;
  if (product.length < 3) return true;

  return false;
}

const BEER_BRANDS = [
  'Krušovice', 'Gambrinus', 'Kozel', 'Velkopopovický Kozel', 'Staropramen', 'Braník',
  'Budweiser', 'Budvar', 'Radegast', 'Birell', 'Svijany', 'Svijanský', 'Heineken',
  'Pilsner', 'Plzeňský', 'Bernard', 'Litovel', 'Zlatopramen', 'Mustang', 'Hořký'
];

function isBeerOffer(offer) {
  const text = `${offer.product || ''} ${offer.description || ''} ${offer.rawContext || ''}`;
  if (/\b(pivo|ležák|výčepní|nealko\s*pivo|světlý\s*ležák|světlé\s*výčepní)\b/iu.test(text)) return true;
  return BEER_BRANDS.some((brand) => new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu').test(text));
}

function beerDescriptionFor(offer) {
  const text = `${offer.product || ''} ${offer.description || ''} ${offer.rawContext || ''}`;
  if (/\bnealko|nealkoholick/iu.test(text)) return 'nealkoholické pivo';
  if (/\b(11|12|ležák|lezak)\b/iu.test(text)) return 'světlý ležák';
  if (/\b(10|výčepní|vycepni)\b/iu.test(text)) return 'světlé výčepní pivo';
  return 'pivo';
}

function enrichOffer(offer) {
  const product = cleanProductNameFinal(offer.product);
  const enriched = { ...offer, product };

  const searchParts = [product, offer.brand, offer.description, offer.packageSize, offer.chain, offer.storeName];

  if (isBeerOffer(enriched)) {
    const beerDescription = beerDescriptionFor(enriched);
    if (!/\b(pivo|ležák|výčepní)\b/iu.test(String(enriched.description || ''))) {
      enriched.description = [beerDescription, enriched.description].filter(Boolean).join('; ');
    }
    enriched.category = enriched.category || 'pivo';
    searchParts.push('pivo', 'beer', 'ležák', 'výčepní', beerDescription);
  }

  enriched.searchTerms = Array.from(new Set(searchParts.filter(Boolean).join(' ').split(/\s+/))).join(' ');
  enriched.compareKey = deriveCompareKey(enriched);

  return enriched;
}

function deriveCompareKey(offer) {
  let key = normalizeText(`${offer.product || ''} ${offer.packageSize || ''}`);

  key = key
    .replace(/\b(pivo|svetle|svetly|vycepni|lezak|nealkoholicke|nealko|akcni|cena|vybrane|druhy)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return key || normalizeText(offer.product || '');
}

function normalizeOffer(offer, sourceName) {
  const confidence = String(offer.confidence || "high").toLowerCase();
  const suspect = offer.suspect === true || String(offer.suspect || "").toLowerCase() === "true";

  return {
    id: offer.id || `${sourceName}-${offer.product}-${offer.price}`,
    storeId: offer.storeId || sourceName.toLowerCase().replace(/\s+/g, "-"),
    chain: offer.chain || sourceName,
    storeName: offer.storeName || sourceName,
    product: offer.product || "",
    brand: offer.brand || "",
    description: offer.description || "",
    packageSize: offer.packageSize || "",
    price: toNumber(offer.price),
    priceText: offer.priceText || "",
    unitPrice: toNumber(offer.unitPrice ?? offer.price),
    unit: offer.unit || "Kč/ks",
    unitText: offer.unitText || "",
    validFrom: offer.validFrom || "",
    validTo: offer.validTo || "",
    priceType: offer.priceType || "akce",
    sourceUrl: offer.sourceUrl || "",
    imageUrl: offer.imageUrl || offer.image || offer.imageSrc || offer.thumbnailUrl || offer.productImageUrl || "",
    imageAlt: offer.imageAlt || offer.product || "",
    pageImageUrl: offer.pageImageUrl || "",
    imageType: offer.imageType || (offer.pageImageUrl ? "page-thumbnail" : (offer.imageUrl ? "product" : "")),
    leafletUrl: offer.leafletUrl || "",
    confidence: ["high", "medium", "low"].includes(confidence) ? confidence : "high",
    suspect,
    suspectReasons: Array.isArray(offer.suspectReasons) ? offer.suspectReasons : [],
    pageNumber: offer.pageNumber ?? null,
    rawContext: offer.rawContext || '',
    category: offer.category || '',
    searchTerms: offer.searchTerms || '',
    compareKey: offer.compareKey || '',
    sourceFile: sourceName,
  };
}

async function readOffers(input) {
  if (!existsSync(input.path)) {
    if (input.required) {
      throw new Error(`Missing required input: ${input.path}`);
    }

    return {
      input,
      count: 0,
      offers: [],
      missing: true,
    };
  }

  const raw = await readFile(input.path, "utf8");
  const parsed = JSON.parse(raw);
  const sourceOffers = Array.isArray(parsed.offers) ? parsed.offers : [];

  const offers = sourceOffers
    .map((offer) => normalizeOffer(offer, input.name))
    .map(enrichOffer)
    .filter((offer) => offer.product && offer.price !== null)
    // Do běžného společného výstupu nepouštíme suspect položky.
    // Albert je zatím připojen jen přes clean-only soubor, ale tohle chrání i budoucí zdroje.
    .filter((offer) => !offer.suspect)
    // Poslední ochranný filtr pro zjevné reklamní zbytky z PDF parseru.
    .filter((offer) => !shouldRejectFinalOffer(offer));

  return {
    input,
    count: offers.length,
    offers,
    missing: false,
  };
}

async function main() {
  await mkdir("data", { recursive: true });

  if (existsSync(OUTPUT_FILE) && !existsSync(BACKUP_FILE)) {
    await copyFile(OUTPUT_FILE, BACKUP_FILE);
  }

  const loaded = [];
  const allOffers = [];

  for (const input of INPUTS) {
    const result = await readOffers(input);

    loaded.push({
      name: input.name,
      path: input.path,
      count: result.count,
      missing: result.missing,
    });

    allOffers.push(...result.offers);
  }

  const unique = new Map();

  for (const offer of allOffers) {
    const key = [
      offer.storeId,
      offer.compareKey || offer.product,
      offer.packageSize,
      offer.price,
      offer.unitPrice,
      offer.pageNumber ?? "",
    ].join("|");

    unique.set(key, offer);
  }

  const offers = Array.from(unique.values()).sort((a, b) => {
    const byStore = a.storeName.localeCompare(b.storeName, "cs");
    if (byStore !== 0) return byStore;
    return a.product.localeCompare(b.product, "cs");
  });

  const output = {
    meta: {
      source: "combined",
      updatedAt: new Date().toISOString(),
      count: offers.length,
      parser: "scripts/combine-offers.mjs",
      inputs: loaded,
    },
    offers,
  };

  const qualityCounts = offers.reduce(
    (acc, offer) => {
      if (offer.suspect) acc.suspect += 1;
      else if (offer.confidence === "low") acc.low += 1;
      else if (offer.confidence === "medium") acc.medium += 1;
      else acc.high += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0, suspect: 0 }
  );

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(
    DEBUG_FILE,
    JSON.stringify(
      {
        meta: output.meta,
        loaded,
        qualityCounts,
        firstOffers: offers.slice(0, 20),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Combined ${offers.length} offers into ${OUTPUT_FILE}`);
  console.log(JSON.stringify({ loaded, qualityCounts }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
