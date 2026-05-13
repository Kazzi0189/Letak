import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const INPUTS = [
  {
    name: "Penny",
    path: "data/offers.json",
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

function normalizeOffer(offer, sourceName) {
  const chain = offer.chain || sourceName;
  const storeName = offer.storeName || chain;
  const product = String(offer.product || offer.name || offer.title || "").trim();

  const price = normalizeNumber(offer.price);
  const unitPrice = normalizeNumber(offer.unitPrice) ?? price;

  if (!product || price === null) return null;

  const id =
    offer.id ||
    makeId([
      chain,
      storeName,
      product,
      price,
      offer.packageSize,
      offer.validFrom,
      offer.validTo,
      offer.imageUrl,
    ]);

  return {
    id,
    storeId: offer.storeId || `${chain.toLowerCase().replace(/\s+/g, "-")}-default`,
    chain,
    storeName,
    storeAddress: offer.storeAddress || "",
    product,
    brand: offer.brand || "",
    packageSize: offer.packageSize || "",
    price,
    oldPrice: normalizeNumber(offer.oldPrice),
    unitPrice,
    unit: offer.unit || "Kč/ks",
    category: offer.category || "",
    validFrom: offer.validFrom || "",
    validTo: offer.validTo || "",
    priceType: offer.priceType || "akční cena",
    klNr: offer.klNr || "",
    imageUrl: offer.imageUrl || "",
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
    offer.packageSize.toLowerCase(),
    offer.validFrom,
    offer.validTo,
  ].join("|");
}

async function readOffers(input) {
  if (!existsSync(input.path)) {
    if (input.required) {
      throw new Error(`Missing required input: ${input.path}`);
    }

    return {
      input,
      exists: false,
      meta: null,
      offers: [],
    };
  }

  const parsed = JSON.parse(await readFile(input.path, "utf8"));
  const offers = Array.isArray(parsed.offers) ? parsed.offers : [];

  return {
    input,
    exists: true,
    meta: parsed.meta ?? null,
    offers: offers
      .map((offer) => normalizeOffer(offer, input.name))
      .filter(Boolean),
  };
}

async function main() {
  await mkdir("data", { recursive: true });

  const loaded = [];
  for (const input of INPUTS) {
    loaded.push(await readOffers(input));
  }

  const penny = loaded.find((item) => item.input.name === "Penny");
  if (penny?.exists) {
    await writeFile(
      BACKUP_FILE,
      JSON.stringify(
        {
          meta: {
            backedUpAt: new Date().toISOString(),
            source: penny.input.path,
            note: "Backup původního Penny data/offers.json před vytvořením společného offers.json.",
            originalMeta: penny.meta,
            count: penny.offers.length,
          },
          offers: penny.offers,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  const all = loaded.flatMap((item) => item.offers);
  const unique = new Map();

  for (const offer of all) {
    const key = dedupeKey(offer);
    const existing = unique.get(key);

    if (!existing) {
      unique.set(key, offer);
      continue;
    }

    const existingScore =
      Number(Boolean(existing.imageUrl)) +
      Number(Boolean(existing.storeAddress)) +
      Number(Boolean(existing.klNr)) +
      Number(Boolean(existing.oldPrice));

    const newScore =
      Number(Boolean(offer.imageUrl)) +
      Number(Boolean(offer.storeAddress)) +
      Number(Boolean(offer.klNr)) +
      Number(Boolean(offer.oldPrice));

    if (newScore > existingScore) {
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
      })),
      byChain,
      note: "Společný soubor pro aplikaci. Obsahuje nabídky z dostupných importů.",
    },
    offers: combined,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");

  await writeFile(
    DEBUG_FILE,
    JSON.stringify(
      {
        meta: output.meta,
        firstOffers: combined.slice(0, 30),
        notes: [
          "Výstup je záměrně zapsán do data/offers.json, aby frontend nemusel být zatím upraven.",
          "Původní Penny data/offers.json se uloží jako data/offers-penny-last.json.",
          "Když znovu spustíš Penny import, data/offers.json se přepíše jen na Penny; potom stačí znovu spustit Combine offers.",
        ],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Combined offers: ${combined.length}`);
  console.log(JSON.stringify(byChain, null, 2));
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`Wrote ${DEBUG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
