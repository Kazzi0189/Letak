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
];

const OUTPUT_FILE = "data/offers.json";
const BACKUP_FILE = "data/offers-penny-last.json";
const DEBUG_FILE = "data/offers-combined-debug.json";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeOffer(offer, sourceName) {
  const confidence = String(offer.confidence || "high").toLowerCase();
  const suspect =
    offer.suspect === true ||
    String(offer.suspect || "").toLowerCase() === "true";

  return {
    id: offer.id || `${sourceName}-${offer.product}-${offer.price}`,
    storeId: offer.storeId || sourceName.toLowerCase().replace(/\s+/g, "-"),
    chain: offer.chain || sourceName,
    storeName: offer.storeName || sourceName,
    product: offer.product || "",
    brand: offer.brand || "",
    packageSize: offer.packageSize || "",
    price: toNumber(offer.price),
    unitPrice: toNumber(offer.unitPrice ?? offer.price),
    unit: offer.unit || "Kč/ks",
    validFrom: offer.validFrom || "",
    validTo: offer.validTo || "",
    priceType: offer.priceType || "akce",
    sourceUrl: offer.sourceUrl || "",
    leafletUrl: offer.leafletUrl || "",
    confidence: ["high", "medium", "low"].includes(confidence) ? confidence : "high",
    suspect,
    suspectReasons: Array.isArray(offer.suspectReasons) ? offer.suspectReasons : [],
    pageNumber: offer.pageNumber ?? null,
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
    .filter((offer) => offer.product && offer.price !== null);

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
      offer.product,
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
