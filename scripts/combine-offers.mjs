import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const INPUTS = [
  {
    name: "Penny leták",
    path: "data/penny-leaflet-offers.json",
    required: false,
    onlyClean: false,
  },
  {
    name: "Kaufland Teplice",
    path: "data/offers-kaufland-teplice.json",
    required: false,
    onlyClean: false,
  },
  {
    name: "Albert clean PDF",
    path: "data/albert-pdf-offers-clean.json",
    required: false,
    onlyClean: true,
  },
];

const OUTPUT_FILE = "data/offers.json";
const DEBUG_FILE = "data/offers-combined-debug.json";
const BACKUP_FILE = "data/offers-before-combine-last.json";

function makeId(parts) {
  return (
    "offer-" +
    createHash("sha1")
      .update(parts.filter(Boolean).join("|"))
      .digest("hex")
      .slice(0, 16)
  );
}

function normalizeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const parsed = Number(value.replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isSuspectValue(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function hasBadProductName(product = "") {
  return /^(VEZMĚTE SI|Z REGÁLU|S BODY|CENA BEZ BODŮ|PLATNÉM DO|HI T MĚSÍCE|AKČNÍ NABÍDKA|SUPER CENA|A MUŽEŠ JÍ\(S\)T)/iu.test(product)
    || /\b(VEZMĚTE SI Z REGÁLU|CENA BEZ BODŮ|A MUŽEŠ JÍ\(S\)T|KREDIT NAVÍC)\b/iu.test(product);
}

function normalizeOffer(offer, sourceName) {
  const chain = offer.chain || sourceName;
  const storeName = offer.storeName || chain;
  const product = String(offer.product || offer.name || offer.title || "").trim();
  const price = normalizeNumber(offer.price);
  const unitPrice = normalizeNumber(offer.unitPrice) ?? price;
  const suspect = isSuspectValue(offer.suspect);
  const confidence = offer.confidence || (suspect ? "low" : "high");

  if (!product || price === null) return null;
  if (hasBadProductName(product)) return null;

  const id = offer.id || makeId([
    chain,
    storeName,
    product,
    price,
    offer.packageSize,
    offer.validFrom,
    offer.validTo,
    offer.imageUrl,
    offer.pageNumber,
  ]);

  return {
    id,
    storeId: offer.storeId || `${chain.toLowerCase().replace(/\s+/g, "-")}-default`,
    chain,
    storeName,
    storeAddress: offer.storeAddress || "",
    product,
    brand: offer.brand || "",
    description: offer.description || "",
    packageSize: offer.packageSize || "",
    price,
    oldPrice: normalizeNumber(offer.oldPrice),
    unitPrice,
    unit: offer.unit || "Kč/ks",
    unitText: offer.unitText || "",
    category: offer.category || "",
    validFrom: offer.validFrom || "",
    validTo: offer.validTo || "",
    priceType: offer.priceType || "akční cena",
    klNr: offer.klNr || "",
    imageUrl: offer.imageUrl || "",
    imageAlt: offer.imageAlt || "",
    pageImageUrl: offer.pageImageUrl || "",
    imageType: offer.imageType || "",
    pageNumber: offer.pageNumber || "",
    confidence,
    suspect,
    suspectReasons: Array.isArray(offer.suspectReasons) ? offer.suspectReasons : [],
    sourceUrl: offer.sourceUrl || "",
    leafletUrl: offer.leafletUrl || "",
    sourceFile: sourceName,
  };
}

function dedupeKey(offer) {
  return [
    offer.chain.toLowerCase(),
    offer.storeName.toLowerCase(),
    offer.product.toLowerCase(),
    offer.price,
    String(offer.packageSize || "").toLowerCase(),
    offer.validFrom,
    offer.validTo,
  ].join("|");
}

function offerScore(offer) {
  return Number(Boolean(offer.imageUrl)) * 8
    + Number(Boolean(offer.pageImageUrl)) * 2
    + Number(Boolean(offer.storeAddress)) * 2
    + Number(Boolean(offer.klNr)) * 3
    + Number(Boolean(offer.oldPrice))
    + Number(offer.confidence === "high") * 2
    + Number(offer.confidence === "medium");
}

async function readOffers(input) {
  if (!existsSync(input.path)) {
    if (input.required) {
      throw new Error(`Missing required input: ${input.path}`);
    }

    return { input, exists: false, meta: null, offers: [] };
  }

  const parsed = JSON.parse(await readFile(input.path, "utf8"));
  const rawOffers = Array.isArray(parsed.offers) ? parsed.offers : [];
  const offers = rawOffers
    .filter((offer) => !input.onlyClean || !isSuspectValue(offer.suspect))
    .map((offer) => normalizeOffer(offer, input.name))
    .filter(Boolean);

  return { input, exists: true, meta: parsed.meta ?? null, offers };
}

async function backupCurrentOffers() {
  if (!existsSync(OUTPUT_FILE)) return;

  const current = JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
  await writeFile(
    BACKUP_FILE,
    JSON.stringify(
      {
        meta: {
          backedUpAt: new Date().toISOString(),
          source: OUTPUT_FILE,
          originalMeta: current.meta ?? null,
          count: Array.isArray(current.offers) ? current.offers.length : 0,
          note: "Backup data/offers.json před vytvořením nového společného souboru.",
        },
        offers: Array.isArray(current.offers) ? current.offers : [],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function main() {
  await mkdir("data", { recursive: true });
  await backupCurrentOffers();

  const loaded = [];
  for (const input of INPUTS) {
    loaded.push(await readOffers(input));
  }

  const all = loaded.flatMap((item) => item.offers);
  const unique = new Map();

  for (const offer of all) {
    const key = dedupeKey(offer);
    const existing = unique.get(key);

    if (!existing || offerScore(offer) > offerScore(existing)) {
      unique.set(key, offer);
    }
  }

  const combined = Array.from(unique.values()).sort((a, b) => {
    const productCompare = a.product.localeCompare(b.product, "cs");
    if (productCompare !== 0) return productCompare;
    return a.price - b.price;
  });

  const byChain = combined.reduce((acc, offer) => {
    acc[offer.chain] = (acc[offer.chain] ?? 0) + 1;
    return acc;
  }, {});

  const byStore = combined.reduce((acc, offer) => {
    acc[offer.storeId] = (acc[offer.storeId] ?? 0) + 1;
    return acc;
  }, {});

  const output = {
    meta: {
      source: "combined",
      updatedAt: new Date().toISOString(),
      count: combined.length,
      parser: "scripts/combine-offers.mjs",
      inputs: loaded.map((item) => ({
        name: item.input.name,
        path: item.input.path,
        exists: item.exists,
        count: item.offers.length,
        onlyClean: item.input.onlyClean,
      })),
      byChain,
      byStore,
      note: "Společný soubor pro aplikaci. Albert se bere jen z data/albert-pdf-offers-clean.json.",
    },
    offers: combined,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(
    DEBUG_FILE,
    JSON.stringify(
      {
        meta: output.meta,
        firstOffers: combined.slice(0, 40),
        notes: [
          "Výstup je zapsán do data/offers.json, protože frontend načítá právě tento soubor.",
          "Albert se do běžného hledání dostává pouze přes clean-only soubor.",
          "data/albert-pdf-offers.json zůstává jako debug / kompletní výstup se suspect položkami.",
        ],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Combined offers: ${combined.length}`);
  console.log(JSON.stringify({ byChain, byStore }, null, 2));
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`Wrote ${DEBUG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
