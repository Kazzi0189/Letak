import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/albert-probe";
const LEAFLETS = [
  { id: "20sm_akcni_letak", type: "supermarket", title: "Albert supermarket akční leták", baseUrl: "https://letaky.albert.cz/20sm_akcni_letak/", maxPages: 42 },
  { id: "20hm_akcni_letak", type: "hypermarket", title: "Albert hypermarket akční leták", baseUrl: "https://letaky.albert.cz/20hm_akcni_letak/", maxPages: 60 },
];

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/g, "=")
    .replace(/\\\//g, "/")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeDecodeURIComponent(value) {
  const fixed = String(value)
    .replace(/%\s*([0-9a-fA-F]{2})/g, "%$1")
    .replace(/\s+/g, " ");

  try {
    return decodeURIComponent(fixed);
  } catch {
    try {
      return decodeURIComponent(fixed.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
    } catch {
      return fixed;
    }
  }
}

function normalizeText(value = "") {
  return safeDecodeURIComponent(decodeHtml(value))
    .replace(/\+/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[•·]/g, " • ")
    .replace(/[–—]/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href, baseUrl) {
  try { return new URL(decodeHtml(href), baseUrl).toString(); }
  catch { return decodeHtml(href); }
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertTextExtractV2/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });
  return { url, ok: response.ok, status: response.status, finalUrl: response.url, contentType: response.headers.get("content-type") ?? "", text: await response.text() };
}

function extractAllUrls(html, baseUrl) {
  const urls = [];
  const decoded = decodeHtml(html);
  let match;

  const attrRegex = /(?:src|href|data-src|data-href|data-url|content|aria-label|title)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(decoded))) {
    urls.push(absoluteUrl(match[1], baseUrl));
    urls.push(match[1]);
  }

  const httpRegex = /https?:\/\/[^"'\\\s)<>]+/gi;
  while ((match = httpRegex.exec(decoded))) urls.push(match[0].replace(/[;,]+$/, ""));

  return unique(urls.map((url) => url.replace(/\\/g, "")));
}

function isUsefulEncodedText(raw) {
  const normalized = normalizeText(raw);
  if (normalized.length < 60) return false;
  if (!/(Kč|,-|\d+,\d{2}|BEZ APLIKACE|NEPORAZITELNÉ|BĚŽNÁ CENA|•)/i.test(normalized)) return false;
  if (/^https?:\/\//i.test(normalized)) return false;
  if (/publitas|favicon|shopping_cart|assets|sentry|stats|website|noindex|charset|width=device|custom-consent/i.test(normalized)) return false;
  return true;
}

function extractTextCandidatesFromUrls(urls, leafletBaseUrl) {
  const basePath = new URL(leafletBaseUrl).pathname.replace(/\/$/, "");
  const candidates = [];

  for (const url of urls) {
    let parsed = null;
    try { parsed = new URL(url); }
    catch {
      const plain = normalizeText(url);
      if (isUsefulEncodedText(plain)) candidates.push(plain);
      continue;
    }

    if (!parsed.hostname.includes("letaky.albert.cz")) continue;
    if (!parsed.pathname.includes(basePath)) continue;

    const segments = parsed.pathname.split("/").map((part) => normalizeText(part)).filter(Boolean);
    for (const segment of segments) if (isUsefulEncodedText(segment)) candidates.push(segment);
  }
  return unique(candidates);
}

function extractPageImageUrls(urls) {
  return unique(urls.filter((url) => /^https:\/\/view\.publitas\.com\/\d+\/\d+\/pages\/.+-at1600\.jpg/i.test(url)));
}

function toNumber(value) {
  if (!value) return null;
  let text = String(value).trim();
  text = text.replace(/\b20(?=\d{2},\d{2}\b)/g, "");
  text = text.replace(/\b0(?=\d{2,3},\d{2}\b)/g, "");
  text = text.replace(/,-/g, ",00").replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, "");
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizePriceText(value = "") {
  const number = toNumber(value);
  if (number == null) return "";
  return number.toLocaleString("cs-CZ", { minimumFractionDigits: Number.isInteger(number) ? 0 : 2, maximumFractionDigits: 2 }) + " Kč";
}

function allPriceMatches(text) {
  const normalized = normalizeText(text);
  const matches = normalized.match(/\b(?:20|0)?\d{1,4}[,.]\d{2}\s*Kč|\b(?:20|0)?\d{1,4}[,.]\d{2}\b|\b\d{1,4},-/gi) || [];
  return unique(matches)
    .map((match) => ({ raw: match, price: toNumber(match), priceText: normalizePriceText(match) }))
    .filter((item) => item.price != null && item.price > 0 && item.price < 10000);
}

function unitPriceMatches(text) {
  const normalized = normalizeText(text);
  const matches = normalized.match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role)\s*(?:=|od|za)?\s*(?:20|0)?\d{1,4}[,.]\d{2}\s*Kč/gi) || [];
  return unique(matches).map((match) => {
    const price = allPriceMatches(match).at(-1);
    const unit = match.match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role)/i)?.[0] ?? "";
    return { raw: match, unit: unit ? `Kč/${unit.replace(/\s+/g, " ")}` : "", unitPrice: price?.price ?? null, unitText: match };
  });
}

function packageMatches(text) {
  const normalized = normalizeText(text);
  return unique(normalized.match(/\b\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks|role)\b|\b\d+\s*[×x]\s*\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks)\b/gi) || []);
}

function looksLikeProductName(value = "") {
  const text = value
    .replace(/\b(?:BEZ APLIKACE|APLIKACE|BĚŽNÁ CENA|NEPORAZITELNÉ|VÍCE AKCÍ|EXTRA LETÁK|SUPER CENA|FANDÍME HOKEJI|Trvanlivé potraviny|Drogerie|Zvířata)\b/gi, " ")
    .replace(/\b\d+[,.]?\d*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 3) return false;
  if (!/[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]/.test(text)) return false;
  if (/^(od|do|www|albert|cz|kč|kg|g|ml|l|ks|cena|za|bez|vybrané druhy)$/i.test(text)) return false;
  return true;
}

function cleanProductName(value = "") {
  let text = normalizeText(value)
    .replace(/\b(?:BEZ APLIKACE|APLIKACE|BĚŽNÁ CENA|NEPORAZITELNÉ|VÍCE AKCÍ|EXTRA LETÁK|SUPER CENA|FANDÍME HOKEJI|NOVINKA|KREDITY NAVÍC)\b/gi, " ")
    .replace(/\bOd\s+\d{1,2}\.\s*\d{1,2}\.\s*do\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\b/gi, " ")
    .replace(/\bwww\.albert\.cz\b/gi, " ")
    .replace(/\b[-+]?\d{1,3}\s*%\b/g, " ")
    .replace(/\b\d{1,4}[,.]\d{2}\s*Kč\b/gi, " ")
    .replace(/\b\d{1,4},-\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = text.split(" ").filter(Boolean);
  while (words.length > 1 && /^(Nature|Trvanlivé|potraviny|Nápoje|Drogerie|Zvířata|Akce|Nabídka)$/i.test(words[0])) words.shift();
  text = words.join(" ").trim();
  if (text.length > 85) text = text.slice(0, 85).replace(/\s+\S*$/, "").trim();
  return text;
}

function findProductBeforeIndex(text, index) {
  const before = text.slice(Math.max(0, index - 160), index);
  const chunks = before.split("•").map((part) => cleanProductName(part)).filter(looksLikeProductName);
  return chunks.at(-1) ?? "";
}

function extractOfferCandidatesFromText(rawText, pageNumber, pageImageUrl, leaflet) {
  const text = normalizeText(rawText);
  const candidates = [];
  const units = unitPriceMatches(text);

  for (const unitInfo of units) {
    const idx = text.indexOf(unitInfo.raw);
    if (idx < 0) continue;
    const windowText = text.slice(Math.max(0, idx - 180), Math.min(text.length, idx + 240));
    const product = findProductBeforeIndex(text, idx);
    const packages = packageMatches(windowText);
    const allPrices = unique([...allPriceMatches(text.slice(idx, Math.min(text.length, idx + 240))), ...allPriceMatches(windowText)].map((item) => JSON.stringify(item))).map((item) => JSON.parse(item));
    const mainPrice = [...allPrices].reverse().find((item) => Math.abs(item.price - (unitInfo.unitPrice ?? -999999)) > 0.001);
    if (!product || !mainPrice) continue;
    candidates.push({ chain: "Albert", storeId: `albert-${leaflet.type}`, storeName: `Albert ${leaflet.type === "hypermarket" ? "hypermarket" : "supermarket"}`, leafletType: leaflet.type, product, brand: "", packageSize: packages[0] ?? "", price: mainPrice.price, priceText: mainPrice.priceText, unitPrice: unitInfo.unitPrice ?? mainPrice.price, unit: unitInfo.unit || "Kč/ks", unitText: unitInfo.unitText, pageNumber, imageUrl: "", pageImageUrl, imageType: pageImageUrl ? "page-thumbnail" : "", sourceUrl: `${leaflet.baseUrl}page/${pageNumber}`, confidence: "hidden-page-text-v2", rawContext: windowText });
  }

  const bulletParts = text.split("•").map((part) => part.trim()).filter(Boolean);
  for (let i = 0; i < bulletParts.length - 1; i++) {
    const product = cleanProductName(bulletParts[i]);
    if (!looksLikeProductName(product)) continue;
    const nearby = bulletParts.slice(i, i + 6).join(" • ");
    const packages = packageMatches(nearby);
    const prices = allPriceMatches(nearby);
    if (!packages.length || !prices.length) continue;
    const mainPrice = prices.at(-1);
    if (!mainPrice || mainPrice.price == null) continue;
    candidates.push({ chain: "Albert", storeId: `albert-${leaflet.type}`, storeName: `Albert ${leaflet.type === "hypermarket" ? "hypermarket" : "supermarket"}`, leafletType: leaflet.type, product, brand: "", packageSize: packages[0] ?? "", price: mainPrice.price, priceText: mainPrice.priceText, unitPrice: mainPrice.price, unit: "Kč/ks", unitText: "", pageNumber, imageUrl: "", pageImageUrl, imageType: pageImageUrl ? "page-thumbnail" : "", sourceUrl: `${leaflet.baseUrl}page/${pageNumber}`, confidence: "hidden-page-text-v2-fallback", rawContext: nearby.slice(0, 300) });
  }

  const seen = new Set();
  return candidates.filter((offer) => {
    const key = `${offer.product}|${offer.price}|${offer.packageSize}|${offer.pageNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return offer.product.length >= 3 && offer.price > 0;
  });
}

async function inspectLeaflet(leaflet) {
  const pages = [];
  const allOfferCandidates = [];

  for (let page = 1; page <= leaflet.maxPages; page++) {
    const url = `${leaflet.baseUrl}page/${page}`;
    const response = await fetchText(url);
    if (!response.ok) continue;

    const urls = extractAllUrls(response.text, response.finalUrl);
    const textCandidates = extractTextCandidatesFromUrls(urls, leaflet.baseUrl);
    const pageImageUrls = extractPageImageUrls(urls);
    const pageImageUrl = pageImageUrls[0] ?? "";
    const joinedText = textCandidates.join(" ");
    const offers = extractOfferCandidatesFromText(joinedText, page, pageImageUrl, leaflet);

    pages.push({ page, url, ok: response.ok, status: response.status, htmlLength: response.text.length, textCandidatesCount: textCandidates.length, textCandidates: textCandidates.slice(0, 8), decodedTextPreview: joinedText.slice(0, 900), textLength: joinedText.length, priceExamples: allPriceMatches(joinedText).slice(0, 30), unitPriceExamples: unitPriceMatches(joinedText).slice(0, 30), packageExamples: packageMatches(joinedText).slice(0, 30), pageImageUrls, offerCandidatesCount: offers.length, offerCandidatesPreview: offers.slice(0, 20) });
    allOfferCandidates.push(...offers);
  }

  const uniqueOfferCandidates = [];
  const seen = new Set();
  for (const offer of allOfferCandidates) {
    const key = `${offer.leafletType}|${offer.product}|${offer.price}|${offer.packageSize}|${offer.pageNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueOfferCandidates.push(offer);
  }

  return { leaflet, summary: { pagesChecked: pages.length, pagesWithText: pages.filter((p) => p.textCandidatesCount > 0).length, pagesWithImages: pages.filter((p) => p.pageImageUrls.length > 0).length, offerCandidates: uniqueOfferCandidates.length, pagesWithOfferCandidates: pages.filter((p) => p.offerCandidatesCount > 0).length, recommendedPath: uniqueOfferCandidates.length > 40 ? "build-albert-parser-from-hidden-page-text-v2" : uniqueOfferCandidates.length > 0 ? "inspect-candidates-and-tighten-parser" : "fallback-to-pdf-or-ocr" }, pages, offerCandidates: uniqueOfferCandidates };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const results = [];
  for (const leaflet of LEAFLETS) results.push(await inspectLeaflet(leaflet));
  const allOfferCandidates = results.flatMap((result) => result.offerCandidates);
  const summary = { checkedAt: new Date().toISOString(), summary: { totalOfferCandidates: allOfferCandidates.length, recommendedPath: allOfferCandidates.length > 80 ? "build-albert-parser-from-hidden-page-text-v2" : allOfferCandidates.length > 0 ? "inspect-candidates-and-tighten-parser" : "fallback-to-pdf-or-ocr", leaflets: results.map((result) => ({ id: result.leaflet.id, type: result.leaflet.type, title: result.leaflet.title, ...result.summary })) }, sampleOffers: allOfferCandidates.slice(0, 120) };
  await writeFile(`${OUTPUT_DIR}/albert-page-text-v2-debug.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/page-text-v2-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log("Albert hidden page text extraction v2 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/page-text-v2-summary.json`);
}

main().catch((error) => { console.error(error); process.exit(1); });
