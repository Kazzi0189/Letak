import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_COUNT = 37;

const BEER_CANDIDATES = [
  ["Braník světlé výčepní pivo", 9.9],
  ["Starobrno ležák", 6.9],
  ["Starobrno světlý výčepní ležák", 7.9],
  ["Velkopopovický Kozel 10 světlé pivo", 12.9],
  ["Krušovice 10", 11.9],
  ["Krušovice 12", 10.9],
  ["Radegast Ratar hořký ležák", 20.9],
  ["Staropramen 12 světlý ležák", 16.9],
  ["Mustang hořký 12", 17.9],
  ["Březňák světlý ležák", 13.9],
  ["Staropramen 10 světlé výčepní pivo", 14.9],
  ["Budweiser Budvar Original", 19.9],
  ["Cool míchaný nápoj", 36.9],
  ["Gambrinus Patron 12", 18.9],
  ["Ostravar Mustang světlý ležák", 17.9],
  ["Velkopopovický Kozel", 17.9],
  ["Bohemia Sekt nealkoholický", 129.9],
  ["Prosecco", 69.9],
];

const DIRECT_CANDIDATES = [
  [10, "Mistrovská dušená šunka", 12.9],
  [10, "Řezníkův talíř", 21.9],
  [34, "Osvěžovač vzduchu Aloha Ambi Pur", 79.9],
];

function hashId(parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/g, " ").replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\\u002F/g, "/").replace(/\\u0026/g, "&").replace(/\\u003D/g, "=")
    .replace(/\\\//g, "/")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function decodeURIComponentSafe(value = "") {
  let result = String(value);
  for (let i = 0; i < 5; i++) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch {
      break;
    }
  }
  return result;
}

function normalizeText(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearch(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function cleanMoney(value = "") {
  return String(value).replace(/\s+/g, "").replace(/Kč/giu, "").replace(",-", ",00").replace(",", ".").replace(/[^\d.]/g, "");
}

function toNumber(value) {
  const number = Number(cleanMoney(value));
  return Number.isFinite(number) ? number : null;
}

function moneyText(number) {
  return number == null ? "" : number.toLocaleString("cs-CZ", { minimumFractionDigits: Number.isInteger(number) ? 0 : 2, maximumFractionDigits: 2 }) + " Kč";
}

function extractAttributeValues(html) {
  const values = [];
  let match;
  const attrRegex = /(?:content|title|alt|aria-label|href|src|data-[\w-]+)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(html))) values.push(match[1]);
  return values;
}

function extractDecodedFragments(html) {
  const decoded = decodeHtml(html);
  const values = extractAttributeValues(decoded).map((v) => normalizeText(decodeURIComponentSafe(v)));
  let match;
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  while ((match = urlRegex.exec(decoded))) values.push(normalizeText(decodeURIComponentSafe(match[0])));
  const percentRegex = /((?:[^"'\s<>]*%[0-9A-Fa-f]{2}){4,}[^"'\s<>]*)/g;
  while ((match = percentRegex.exec(decoded))) values.push(normalizeText(decodeURIComponentSafe(match[1])));
  return unique(values.filter((v) => v.length > 20));
}

function extractHiddenText(html) {
  const fragments = extractDecodedFragments(html)
    .map((text) => text
      .replace(/^https?:\/\/[^/]+/i, " ")
      .replace(/\/files\/assets\/.*$/i, " ")
      .replace(/\b(files|assets|html|skin|images|article|FlippingBook|EBook|summary_large_image)\b/giu, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter((text) => text.length > 25);

  const scored = fragments.map((text) => {
    const priceCount = (text.match(/\b\d{1,4}[,.]\d{2}\b/g) ?? []).length;
    const beerHit = BEER_CANDIDATES.some(([name]) => normalizeSearch(text).includes(normalizeSearch(name.split(" ")[0])));
    return { text, score: priceCount * 2 + (beerHit ? 10 : 0) };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.text.length - a.text.length);

  return {
    hiddenText: unique(scored.map((item) => item.text)).join(" "),
    fragments: scored.slice(0, 12),
  };
}

function extractPrices(text = "") {
  return unique(text.match(/\b\d{1,4}[,.]\d{2}\b|\b\d{1,4},-\b/g) ?? [])
    .map((priceText) => ({ priceText, price: toNumber(priceText) }))
    .filter((item) => item.price != null && item.price > 0 && item.price < 10000);
}

function includesLoose(text, product) {
  const source = normalizeSearch(text);
  const words = normalizeSearch(product).split(/\s+/).filter((w) => w.length >= 4);
  return words.length > 0 && words.slice(0, 2).every((word) => source.includes(word));
}

function categoryFor(product) {
  const n = normalizeSearch(product);
  if (/(pivo|lezak|vycepni|branik|staropramen|krusovice|gambrinus|radegast|budvar|kozel|svijany|breznak|mustang|cool)/i.test(n)) return "pivo";
  if (/bohemia|prosecco|sekt/i.test(n)) return "alkohol";
  if (/sunka|talir/i.test(n)) return "uzeniny";
  if (/osvezovac|ambi/i.test(n)) return "drogerie";
  return "";
}

function makeOffer(product, price, pageNumber, rawContext, reason) {
  const category = categoryFor(product);
  const searchTerms = category === "pivo" ? ["pivo", "světlé pivo", "ležák", "výčepní pivo"] : [category].filter(Boolean);
  return {
    id: `penny-hidden-${hashId([pageNumber, product, price])}`,
    chain: "Penny",
    storeId: "penny-letak",
    storeName: "Penny – leták",
    product,
    brand: "",
    description: searchTerms.join(" · "),
    packageSize: "",
    price,
    priceText: moneyText(price),
    unitPrice: null,
    unit: "",
    validTo: "19.05.2026",
    pageNumber,
    imageUrl: "",
    pageImageUrl: `${BASE}/${pageNumber}/files/assets/cover300.jpg`,
    imageType: "penny-page",
    sourceUrl: `${BASE}/${pageNumber}/index.html`,
    category,
    searchTerms,
    compareKey: category || normalizeSearch(product),
    confidence: "low",
    suspect: true,
    suspectReasons: [reason],
    rawContext: rawContext.slice(0, 700),
  };
}

async function fetchPage(pageNumber) {
  const url = `${BASE}/${pageNumber}/index.html`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyHiddenCandidatesV1/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pages = [];
  const candidateOffers = [];

  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
    const page = await fetchPage(pageNumber);
    const { hiddenText, fragments } = extractHiddenText(page.text);
    const prices = extractPrices(hiddenText);
    const pageCandidates = [];

    if (pageNumber === 20) {
      for (const [product, price] of BEER_CANDIDATES) {
        const hasProduct = includesLoose(hiddenText, product);
        const hasPrice = prices.some((p) => Math.abs(p.price - price) < 0.01);
        if (hasProduct && hasPrice) {
          pageCandidates.push(makeOffer(product, price, pageNumber, hiddenText, "candidate z hidden HTML pivní stránky – vyžaduje kontrolu"));
        }
      }
    }

    for (const [targetPage, product, price] of DIRECT_CANDIDATES) {
      if (pageNumber !== targetPage) continue;
      const hasProduct = includesLoose(hiddenText, product);
      const hasPrice = prices.some((p) => Math.abs(p.price - price) < 0.01);
      if (hasProduct && hasPrice) {
        pageCandidates.push(makeOffer(product, price, pageNumber, hiddenText, "candidate z hidden HTML – vyžaduje kontrolu"));
      }
    }

    candidateOffers.push(...pageCandidates);
    pages.push({
      pageNumber,
      ok: page.ok,
      status: page.status,
      htmlLength: page.text.length,
      hiddenTextLength: hiddenText.length,
      hiddenPricesCount: prices.length,
      hiddenPrices: prices.slice(0, 30),
      candidatesCount: pageCandidates.length,
      candidates: pageCandidates,
      bestFragments: fragments,
      hiddenTextPreview: hiddenText.slice(0, 3000),
    });
  }

  const output = {
    meta: {
      source: "Penny hidden/meta HTML candidates",
      updatedAt: new Date().toISOString(),
      count: candidateOffers.length,
      note: "Průzkumný kandidátní výstup. Položky jsou suspect=true a nejsou určené k ostrému importu bez další validace.",
    },
    offers: candidateOffers,
  };

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      pagesChecked: pages.length,
      pagesWithHiddenPrices: pages.filter((p) => p.hiddenPricesCount > 0).map((p) => p.pageNumber),
      totalCandidateOffers: candidateOffers.length,
      candidatePages: pages.filter((p) => p.candidatesCount > 0).map((p) => ({ pageNumber: p.pageNumber, candidatesCount: p.candidatesCount })),
      recommendedPath: candidateOffers.length >= 15 ? "inspect-penny-hidden-candidates-and-build-import-v2" : "improve-hidden-meta-parser-before-import-v2",
    },
    candidateOffers,
    pages,
  };

  await writeFile(`${OUTPUT_DIR}/penny-hidden-candidates-v1.json`, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-hidden-candidates-v1-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny hidden candidates v1 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
