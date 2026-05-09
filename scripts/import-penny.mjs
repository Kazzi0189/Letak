import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const SOURCE_URL = "https://www.penny.cz/nabidky";
const OUTPUT_FILE = "data/offers.json";
const DEBUG_FILE = "data/penny-debug-lines.json";

function decodeHtml(value) {
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
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n### $1\n")
    .replace(/<li[^>]*>/gi, "\n* ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol|a)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(cleaned)
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/\s+/g, " ")
        .replace(/^[-*]\s*/, "")
        .trim()
    )
    .filter(Boolean);
}

function toNumber(value) {
  if (!value) return null;

  const normalized = value
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function isMainPriceLine(line) {
  return /^\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč$/i.test(line.trim());
}

function parseMainPrice(line) {
  const match = line.match(/^(\d{1,4}(?:\s?\d{3})*,\d{2})\s*Kč$/i);
  return match ? toNumber(match[1]) : null;
}

function parseUnitPrice(line) {
  const match = line.match(
    /^((?:\d+(?:[ ,]\d+)?)\s*(?:kg|g|l|ml|ks))\s+(\d{1,4}(?:\s?\d{3})*,\d{2})\s*Kč$/i
  );

  if (!match) return null;

  return {
    unitPrice: toNumber(match[2]),
    unit: `Kč/${match[1].replace(/\s+/g, " ")}`,
  };
}

function isPackageSize(line) {
  return /^(\d+(?:[ ,]\d+)?\s*(g|kg|ml|l|ks)|\d+\s?pack)$/i.test(line.trim());
}

function cleanTitle(title) {
  return title
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeId(product, price, priceType) {
  return (
    "penny-" +
    createHash("sha1")
      .update(`${product}|${price}|${priceType}`)
      .digest("hex")
      .slice(0, 16)
  );
}

function pickPrice(block) {
  const cardIndex = block.findIndex((line) => /^s PENNY kartou$/i.test(line));

  if (cardIndex >= 0) {
    for (let i = cardIndex + 1; i < block.length; i++) {
      if (isMainPriceLine(block[i])) {
        return {
          index: i,
          price: parseMainPrice(block[i]),
          priceType: "s PENNY kartou",
        };
      }
    }
  }

  for (let i = 0; i < block.length; i++) {
    if (isMainPriceLine(block[i])) {
      return {
        index: i,
        price: parseMainPrice(block[i]),
        priceType: "akční cena",
      };
    }
  }

  return null;
}

function parseOffers(lines) {
  const titleIndexes = [];

  lines.forEach((line, index) => {
    if (line.startsWith("### ")) {
      titleIndexes.push(index);
    }
  });

  const offers = [];

  for (let i = 0; i < titleIndexes.length; i++) {
    const start = titleIndexes[i];
    const end = titleIndexes[i + 1] ?? lines.length;

    const product = cleanTitle(lines[start]);
    const block = lines.slice(start + 1, end);

    if (!product || product.length < 3) continue;
    if (/akční nabídka|chcete nás poznat/i.test(product)) continue;

    const priceInfo = pickPrice(block);
    if (!priceInfo || priceInfo.price == null) continue;

    const packageSize = block.find(isPackageSize) ?? "";
    const validFrom = block.find((line) => /^od\s/i.test(line)) ?? "";
    const validTo = block.find((line) => /^do\s/i.test(line)) ?? "";

    let unitInfo = null;
    for (let j = priceInfo.index + 1; j < block.length; j++) {
      unitInfo = parseUnitPrice(block[j]);
      if (unitInfo) break;
    }

    offers.push({
      id: makeId(product, priceInfo.price, priceInfo.priceType),
      storeId: "penny-default",
      chain: "Penny",
      storeName: "Penny – aktuální nabídky",
      product,
      brand: "",
      packageSize,
      price: priceInfo.price,
      unitPrice: unitInfo?.unitPrice ?? priceInfo.price,
      unit: unitInfo?.unit ?? "Kč/ks",
      validFrom,
      validTo,
      priceType: priceInfo.priceType,
      sourceUrl: SOURCE_URL,
    });
  }

  const unique = new Map();

  for (const offer of offers) {
    const key = `${offer.product}|${offer.price}|${offer.priceType}`;
    unique.set(key, offer);
  }

  return Array.from(unique.values());
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; LetakovyPorovnavac/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Penny import failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const lines = htmlToLines(html);

  await mkdir("data", { recursive: true });

  await writeFile(
    DEBUG_FILE,
    JSON.stringify(
      {
        meta: {
          source: SOURCE_URL,
          updatedAt: new Date().toISOString(),
          totalLines: lines.length,
          parser: "scripts/import-penny.mjs",
        },
        lines: lines.map((line, index) => ({
          index,
          line,
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const offers = parseOffers(lines);

  if (offers.length === 0) {
    throw new Error("Penny import failed: no offers parsed");
  }

  await writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      {
        meta: {
          source: SOURCE_URL,
          updatedAt: new Date().toISOString(),
          count: offers.length,
          parser: "scripts/import-penny.mjs",
        },
        offers,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Imported ${offers.length} Penny offers to ${OUTPUT_FILE}`);
  console.log(`Wrote debug lines to ${DEBUG_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
