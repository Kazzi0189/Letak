import { mkdir, writeFile } from "node:fs/promises";

const STORE = {
  chain: "Kaufland",
  storeId: "kaufland-teplice-centrum",
  storeName: "Kaufland Teplice-Centrum",
  storeAddress: "Čs. Dobrovolců 3356, 415 01 Teplice",
  kauflandStoreName: "CZ2450",
  offersUrl: "https://prodejny.kaufland.cz/.kloffers.storeName=CZ2450.json",
  leafletUrl: "https://leaflets.kaufland.com/cz-CZ/CZ_cs_KDZ_2450_CZ20-LFT/ar/2450",
};

const OUTPUT_DIR = "data/kaufland-import";
const RAW_FILE = `${OUTPUT_DIR}/kaufland-teplice-raw.json`;
const OFFERS_FILE = `${OUTPUT_DIR}/kaufland-teplice-offers.json`;
const DEBUG_FILE = `${OUTPUT_DIR}/kaufland-teplice-debug.json`;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectKeys(value, path = "", result = new Map()) {
  if (Array.isArray(value)) {
    result.set(path || "$", {
      type: "array",
      count: value.length,
    });

    for (const item of value.slice(0, 20)) {
      collectKeys(item, `${path || "$"}[]`, result);
    }

    return result;
  }

  if (isObject(value)) {
    const keys = Object.keys(value);

    result.set(path || "$", {
      type: "object",
      keys,
    });

    for (const key of keys) {
      collectKeys(value[key], path ? `${path}.${key}` : key, result);
    }

    return result;
  }

  const type = value === null ? "null" : typeof value;
  const existing = result.get(path || "$");

  if (!existing) {
    result.set(path || "$", {
      type,
      sample: value,
    });
  }

  return result;
}

function flattenSample(value, limit = 10) {
  if (!Array.isArray(value)) return [];

  return value.slice(0, limit).map((item, index) => ({
    index,
    keys: isObject(item) ? Object.keys(item) : [],
    item,
  }));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;

    if (typeof value === "string") {
      const parsed = Number(value.replace(",", ".").replace(/[^\d.]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return null;
}

function normalizeOffer(item, index) {
  if (!isObject(item)) return null;

  const product =
    firstString(
      item.productName,
      item.name,
      item.title,
      item.description,
      item.productTitle,
      item.articleName,
      item.klTitle,
      item.text
    ) || "";

  const price = firstNumber(
    item.price,
    item.currentPrice,
    item.offerPrice,
    item.salesPrice,
    item.finalPrice,
    item.priceValue
  );

  const unitPrice = firstNumber(
    item.unitPrice,
    item.basePrice,
    item.basicPrice,
    item.pricePerUnit,
    item.referencePrice
  );

  const packageSize = firstString(
    item.packageSize,
    item.quantity,
    item.weight,
    item.volume,
    item.content,
    item.amount
  );

  const imageUrl = firstString(
    item.imageUrl,
    item.image,
    item.imageSrc,
    item.picture,
    item.pictureUrl
  );

  const category = firstString(
    item.category,
    item.categoryName,
    item.mainCategory,
    item.klofferCategory
  );

  const klNr = firstString(item.klNr, item.articleId, item.productId, item.id);

  if (!product && !price && !klNr) return null;

  return {
    id: `kaufland-teplice-${klNr || index}`,
    storeId: STORE.storeId,
    chain: STORE.chain,
    storeName: STORE.storeName,
    storeAddress: STORE.storeAddress,
    sourceStoreName: STORE.kauflandStoreName,
    product,
    klNr,
    packageSize,
    price,
    unitPrice: unitPrice ?? price,
    unit: item.unit || item.baseUnit || "",
    category,
    validFrom: firstString(item.dateFrom, item.validFrom, item.startDate),
    validTo: firstString(item.dateTo, item.validTo, item.endDate),
    imageUrl,
    sourceUrl: STORE.offersUrl,
    rawKeys: Object.keys(item),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; LetakovyPorovnavacKauflandImportProbe/0.1; +https://github.com/)",
      accept: "application/json,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return {
      data: JSON.parse(text),
      meta: {
        url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        length: text.length,
      },
    };
  } catch (error) {
    throw new Error(`Response is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`Import/probe Kaufland: ${STORE.storeName}`);
  console.log(STORE.offersUrl);

  const { data, meta } = await fetchJson(STORE.offersUrl);
  const rawArray = Array.isArray(data) ? data : isObject(data) ? Object.values(data).flat().filter(isObject) : [];

  const keyMap = collectKeys(data);
  const keySummary = Array.from(keyMap.entries()).map(([path, info]) => ({
    path,
    ...info,
  }));

  const normalizedOffers = rawArray
    .map((item, index) => normalizeOffer(item, index))
    .filter(Boolean);

  const fields = {
    totalRawItems: rawArray.length,
    normalizedItems: normalizedOffers.length,
    itemsWithProductName: normalizedOffers.filter((item) => item.product).length,
    itemsWithPrice: normalizedOffers.filter((item) => item.price !== null).length,
    itemsWithKlNr: normalizedOffers.filter((item) => item.klNr).length,
  };

  await writeFile(
    RAW_FILE,
    JSON.stringify(
      {
        meta: {
          ...meta,
          checkedAt: new Date().toISOString(),
          store: STORE,
        },
        data,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    OFFERS_FILE,
    JSON.stringify(
      {
        meta: {
          source: STORE.offersUrl,
          leafletUrl: STORE.leafletUrl,
          checkedAt: new Date().toISOString(),
          store: STORE,
          ...fields,
        },
        offers: normalizedOffers,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    DEBUG_FILE,
    JSON.stringify(
      {
        meta: {
          checkedAt: new Date().toISOString(),
          store: STORE,
          ...fields,
        },
        responseMeta: meta,
        topLevelType: Array.isArray(data) ? "array" : typeof data,
        keySummary,
        sampleItems: flattenSample(rawArray, 25),
        recommendation:
          fields.itemsWithProductName > 0 && fields.itemsWithPrice > 0
            ? "JSON obsahuje pravděpodobně kompletní názvy a ceny. Další krok: postavit ostrý Kaufland import."
            : fields.itemsWithKlNr > 0
              ? "JSON zatím vypadá hlavně jako seznam klNr a platnosti. Další krok: najít detail produktu podle klNr nebo využít viewer letáku."
              : "JSON má neznámou strukturu. Další krok: ručně projít sampleItems a keySummary.",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Raw items: ${fields.totalRawItems}`);
  console.log(`Normalized items: ${fields.normalizedItems}`);
  console.log(`Items with product name: ${fields.itemsWithProductName}`);
  console.log(`Items with price: ${fields.itemsWithPrice}`);
  console.log(`Items with klNr: ${fields.itemsWithKlNr}`);
  console.log(`Wrote ${RAW_FILE}`);
  console.log(`Wrote ${OFFERS_FILE}`);
  console.log(`Wrote ${DEBUG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
