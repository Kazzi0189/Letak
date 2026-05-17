import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_COUNT = 37;
const PENNY_DATA_PATHS = ["data/penny-leaflet-offers.json", "data/offers.json"];

const KNOWN_NOISE_PRODUCTS = [
  /^záloha na lahev\b/iu, /^tuku$/iu, /^pomeranč$/iu,
  /^cm\s+\d+\s+balení\b/iu, /^různé typy\s+\d+\s+balení\b/iu,
  /^Kč\b/iu, /^Nabídka\b/iu, /^Nejnižší\b/iu, /^ilustrační foto$/iu, /^MAX\./iu,
];

const CATEGORY_RULES = [
  { category: "pivo", terms: ["pivo", "ležák", "výčepní", "braník", "staropramen", "krušovice", "gambrinus", "radegast", "budvar", "kozel", "svijanský", "březňák", "mustang", "zubr", "holba", "staročech", "ostravar", "zlatý bažant"] },
  { category: "alkohol", terms: ["whisky", "brandy", "rum", "vodka", "gin", "sekt", "prosecco", "víno", "frankovka", "veltlin", "rulandské", "% alk"] },
  { category: "uzeniny", terms: ["šunka", "salám", "klobása", "párek", "slanina", "řezníkův talíř", "uzené"] },
  { category: "maso", terms: ["kuře", "kuřecí", "vepřová", "hovězí", "krkovice", "maso", "mleté"] },
  { category: "mléčné", terms: ["mléko", "jogurt", "sýr", "gouda", "brie", "máslo", "tvaroh", "smetana", "mozzarella"] },
  { category: "ovoce zelenina", terms: ["jablka", "banány", "rajčata", "okurka", "brambory", "salát", "paprika", "mrkev"] },
  { category: "pečivo", terms: ["chléb", "rohlík", "bageta", "houska", "koláč"] },
  { category: "mražené", terms: ["mražené", "zmrzlina", "filé", "hranolky", "krokety"] },
  { category: "drogerie", terms: ["toaletní papír", "osvěžovač", "prací", "aviváž", "šampon", "zubní pasta", "jar", "tablety", "cif", "sidolux", "palette"] },
  { category: "nápoje", terms: ["limonáda", "minerální voda", "ondrášovka", "relax", "džus", "sirup", "cola", "kofola", "vinea"] },
  { category: "káva", terms: ["káva", "espresso", "cappuccino", "nescafé", "dolce gusto", "kapsle", "casablanca", "eduscho", "lavazza"] },
];

function decodeHtml(value = "") {
  return String(value)
    .replace(/&nbsp;/g, " ").replace(/&#160;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\\u002F/g, "/").replace(/\\u0026/g, "&").replace(/\\u003D/g, "=").replace(/\\\//g, "/")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function decodeURIComponentSafe(value = "") {
  let result = String(value);
  for (let i = 0; i < 6; i++) {
    try { const decoded = decodeURIComponent(result); if (decoded === result) break; result = decoded; }
    catch { break; }
  }
  return result;
}

function normalizeText(value = "") {
  return decodeHtml(value).replace(/\u00a0/g, " ").replace(/[–—]/g, "–").replace(/\s+/g, " ").trim();
}
function stripTags(value = "") {
  return normalizeText(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}
function normalizeSearch(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
function unique(values) { return Array.from(new Set(values.filter(Boolean))); }
function toNumber(value) {
  const normalized = String(value).replace(/\s+/g, "").replace(/Kč/giu, "").replace(",-", ",00").replace(",", ".").replace(/[^\d.]/g, "");
  const number = Number(normalized); return Number.isFinite(number) ? number : null;
}
function moneyText(number) { return number == null ? "" : number.toLocaleString("cs-CZ", { minimumFractionDigits: Number.isInteger(number) ? 0 : 2, maximumFractionDigits: 2 }) + " Kč"; }
function offerProduct(offer) { return String(offer.product ?? offer.name ?? offer.title ?? "").trim(); }
function isPennyOffer(offer) {
  const haystack = normalizeSearch([offer.storeName, offer.storeId, offer.chain, offer.source, offer.sourceName].filter(Boolean).join(" "));
  return haystack.includes("penny");
}
function offerPageNumber(offer) {
  for (const candidate of [offer.pageNumber, offer.page, offer.leafletPage]) {
    const number = Number(candidate); if (Number.isFinite(number) && number > 0) return number;
  }
  const match = String(offer.sourceUrl ?? offer.rawContext ?? "").match(/\/(\d+)\/index\.html/i);
  return match ? Number(match[1]) : null;
}
async function loadJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
function extractOffers(container) {
  if (Array.isArray(container)) return container;
  if (Array.isArray(container?.offers)) return container.offers;
  if (Array.isArray(container?.items)) return container.items;
  if (Array.isArray(container?.data)) return container.data;
  return [];
}
async function loadPennyOffers() {
  const results = [];
  for (const path of PENNY_DATA_PATHS) {
    const json = await loadJson(path);
    const offers = extractOffers(json).filter(isPennyOffer);
    if (offers.length) results.push({ path, offers });
  }
  const primary = results.find((item) => item.path === "data/penny-leaflet-offers.json") ?? results[0] ?? { path: "", offers: [] };
  return { loadedSources: results.map((item) => ({ path: item.path, count: item.offers.length })), primaryPath: primary.path, offers: primary.offers };
}
function extractParagraphs(html) {
  const decoded = decodeURIComponentSafe(decodeHtml(html));
  const paragraphs = [];
  let match;
  const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = pRegex.exec(decoded))) {
    const text = stripTags(match[1]);
    if (!text || text.length < 50) continue;
    if (/Made with FlippingBook|schema\.org/i.test(text)) continue;
    paragraphs.push(text);
  }
  const bodyText = stripTags(decoded).replace(/Made with FlippingBook[\s\S]*$/i, " ").trim();
  if (bodyText.length > 300) paragraphs.push(bodyText);
  return unique(paragraphs);
}
function extractPriceMarkers(text = "") {
  const markers = [];
  let match;
  const actionRegex = /<\s*(\d{1,4}[,.]\d{1,2})\s*Kč/giu;
  while ((match = actionRegex.exec(text))) {
    const price = toNumber(match[1]); if (price != null) markers.push({ index: match.index ?? 0, price, priceText: moneyText(price), kind: "action-lt" });
  }
  const zaRegex = /\bza\s+(\d{1,4}[,.]\d{1,2})\s*Kč/giu;
  while ((match = zaRegex.exec(text))) {
    const price = toNumber(match[1]); if (price != null) markers.push({ index: match.index ?? 0, price, priceText: moneyText(price), kind: "za-price" });
  }
  return markers.sort((a, b) => a.index - b.index);
}
function cleanProductName(value = "") {
  let product = normalizeText(value)
    .replace(/\*/g, "").replace(/^[<|/,\s]+/, "").replace(/\|\s*$/g, "").replace(/,\s*$/g, "")
    .replace(/\bNabídka platná\b.*$/iu, "").replace(/\bNejnižší cena za posledních 30 dní\b.*$/iu, "")
    .replace(/\bMOJE PENNY KARTA\b.*$/iu, "").replace(/\bosoba\/nákup\/\s*den\b.*$/iu, "").replace(/\s+/g, " ").trim();
  product = product.replace(/^.*\b\d{1,4}[,.]\d{1,2}\s*Kč\s*/u, "").replace(/^.*\b\d{1,4}[,.]\d{1,2}\s*\/\s*\d{1,3}%\s*/u, "").replace(/^.*\b\d{1,3}\s*%\s*/u, "").trim();
  const firstPackageMarker = product.search(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|plech|sklo|svazek|role|rolí|m)\b/iu);
  if (firstPackageMarker > 3) product = product.slice(0, firstPackageMarker).trim();
  return product.replace(/\brůzné druhy\s+.*$/iu, "různé druhy").replace(/\bv nabídce také\b.*$/iu, "").replace(/\s+/g, " ").trim();
}
function badCandidateName(product = "") {
  if (!product || product.length < 4 || product.length > 120) return true;
  if (KNOWN_NOISE_PRODUCTS.some((pattern) => pattern.test(product))) return true;
  if (/^\d|^Kč\b|^1\s*(l|kg|m)\b/iu.test(product)) return true;
  if (/^(Cena|Super|Nejnižší|nízké|původem)$/iu.test(product)) return true;
  return false;
}
function guessCategory(product = "", rawContext = "") {
  const combined = normalizeSearch(`${product} ${rawContext}`);
  for (const rule of CATEGORY_RULES) if (rule.terms.some((term) => combined.includes(normalizeSearch(term)))) return rule.category;
  return "";
}
function packageSizeFromContext(text = "") {
  const match = text.match(/\b\d+(?:[,.]\d+)?\s*(?:ml|l|g|kg|ks|balení|plech|sklo|role|rolí|m)\b/iu);
  return match ? match[0].replace(/\s+/g, " ") : "";
}
function candidateQuality(candidate) {
  let score = 0;
  if (candidate.category) score += 3;
  if (candidate.packageSize) score += 2;
  if (candidate.kind === "action-lt") score += 2;
  if (candidate.product.length >= 8 && candidate.product.length <= 70) score += 2;
  if (/Nabídka platná|Nejnižší cena za posledních 30 dní|osoba\/nákup\/\s*den/iu.test(candidate.rawContext)) score -= 2;
  if (/v nabídce také|limitované nabídce/iu.test(candidate.rawContext)) score -= 1;
  if (/\/\s*\d+\s*g|;|\bMAX\./iu.test(candidate.product)) score -= 2;
  return score;
}
function extractCandidatesFromPageText(pageText, pageNumber) {
  const markers = extractPriceMarkers(pageText);
  const candidates = [];
  for (const marker of markers) {
    const start = Math.max(0, marker.index - 260);
    const end = Math.min(pageText.length, marker.index + 160);
    const rawContext = normalizeText(pageText.slice(start, end));
    const before = normalizeText(pageText.slice(start, marker.index));
    const product = cleanProductName(before);
    if (badCandidateName(product)) continue;
    const candidate = { pageNumber, product, price: marker.price, priceText: marker.priceText, packageSize: packageSizeFromContext(rawContext), category: guessCategory(product, rawContext), kind: marker.kind, rawContext };
    candidate.qualityScore = candidateQuality(candidate);
    candidates.push(candidate);
  }
  return dedupeCandidates(candidates);
}
function dedupeCandidates(candidates) {
  const best = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.pageNumber}|${normalizeSearch(candidate.product)}|${candidate.price}`;
    const existing = best.get(key);
    if (!existing || candidate.qualityScore > existing.qualityScore) best.set(key, candidate);
  }
  return Array.from(best.values()).sort((a, b) => b.qualityScore - a.qualityScore || a.product.localeCompare(b.product, "cs"));
}
function isAlreadyInOffers(candidate, offersOnPage, allOffers) {
  const productKey = normalizeSearch(candidate.product);
  const productWords = productKey.split(/\s+/).filter((word) => word.length >= 4).slice(0, 3);
  const comparable = offersOnPage.length ? offersOnPage : allOffers;
  return comparable.some((offer) => {
    const offerText = normalizeSearch([offerProduct(offer), offer.description, offer.searchTerms, offer.category].flat().filter(Boolean).join(" "));
    if (!offerText) return false;
    if (offerText.includes(productKey) || productKey.includes(offerText)) return true;
    return productWords.length >= 2 && productWords.every((word) => offerText.includes(word));
  });
}
function riskLevel({ hiddenActionPriceCount, currentOfferCount, probablyMissingCount, goodCandidatesCount, pageNumber }) {
  if (pageNumber === 1 || hiddenActionPriceCount === 0) return "none";
  if (probablyMissingCount >= 8 || hiddenActionPriceCount >= currentOfferCount + 10) return "high";
  if (probablyMissingCount >= 4 || hiddenActionPriceCount >= currentOfferCount + 5) return "medium";
  if (probablyMissingCount >= 1 || goodCandidatesCount >= 3) return "low";
  return "none";
}
async function fetchPage(pageNumber) {
  const url = `${BASE}/${pageNumber}/index.html`;
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyCoverageAuditV1/0.1; +https://github.com/)", accept: "text/html,application/xhtml+xml,text/plain,*/*", "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8" } });
  return { pageNumber, url, ok: response.ok, status: response.status, text: await response.text() };
}
async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const pennyData = await loadPennyOffers();
  const offersByPage = new Map();
  for (const offer of pennyData.offers) {
    const page = offerPageNumber(offer); if (!page) continue;
    if (!offersByPage.has(page)) offersByPage.set(page, []);
    offersByPage.get(page).push(offer);
  }
  const pages = [];
  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
    const page = await fetchPage(pageNumber);
    const paragraphs = extractParagraphs(page.text);
    const pageText = paragraphs.join(" ");
    const markers = extractPriceMarkers(pageText);
    const candidates = extractCandidatesFromPageText(pageText, pageNumber);
    const currentOffersOnPage = offersByPage.get(pageNumber) ?? [];
    const usefulCandidates = candidates.filter((candidate) => candidate.qualityScore >= 3);
    const probablyMissing = usefulCandidates.filter((candidate) => !isAlreadyInOffers(candidate, currentOffersOnPage, pennyData.offers));
    const pageRisk = riskLevel({ hiddenActionPriceCount: markers.filter((marker) => marker.kind === "action-lt").length, currentOfferCount: currentOffersOnPage.length, probablyMissingCount: probablyMissing.length, goodCandidatesCount: usefulCandidates.length, pageNumber });
    pages.push({ pageNumber, ok: page.ok, status: page.status, currentOfferCount: currentOffersOnPage.length, currentOfferSample: currentOffersOnPage.slice(0, 30).map((offer) => ({ product: offerProduct(offer), priceText: offer.priceText ?? "", category: offer.category ?? "" })), paragraphCount: paragraphs.length, pageTextLength: pageText.length, hiddenPriceMarkers: markers.length, hiddenActionPriceMarkers: markers.filter((marker) => marker.kind === "action-lt").length, extractedCandidates: candidates.length, usefulCandidates: usefulCandidates.length, probablyMissingCount: probablyMissing.length, risk: pageRisk, probablyMissingSample: probablyMissing.slice(0, 40), usefulCandidateSample: usefulCandidates.slice(0, 40), pageTextPreview: pageText.slice(0, 3000) });
  }
  const suspiciousPages = pages.filter((page) => page.risk !== "none").sort((a, b) => ({ high: 3, medium: 2, low: 1, none: 0 }[b.risk] - { high: 3, medium: 2, low: 1, none: 0 }[a.risk] || b.probablyMissingCount - a.probablyMissingCount));
  const summary = { checkedAt: new Date().toISOString(), sourceBase: BASE, pennyDataSources: pennyData.loadedSources, primaryPennyDataPath: pennyData.primaryPath, summary: { pagesChecked: PAGE_COUNT, currentPennyOffersLoaded: pennyData.offers.length, pagesWithPageNumberInCurrentData: Array.from(offersByPage.keys()).sort((a, b) => a - b).length, suspiciousPagesCount: suspiciousPages.length, highRiskPages: suspiciousPages.filter((page) => page.risk === "high").map((page) => page.pageNumber), mediumRiskPages: suspiciousPages.filter((page) => page.risk === "medium").map((page) => page.pageNumber), lowRiskPages: suspiciousPages.filter((page) => page.risk === "low").map((page) => page.pageNumber), totalProbablyMissingCandidates: pages.reduce((sum, page) => sum + page.probablyMissingCount, 0), recommendedPath: suspiciousPages.some((page) => page.risk === "high" || page.risk === "medium") ? "inspect-high-and-medium-risk-pages-before-next-penny-import" : "no-large-missing-page-detected" }, suspiciousPages: suspiciousPages.map((page) => ({ pageNumber: page.pageNumber, risk: page.risk, currentOfferCount: page.currentOfferCount, hiddenActionPriceMarkers: page.hiddenActionPriceMarkers, extractedCandidates: page.extractedCandidates, usefulCandidates: page.usefulCandidates, probablyMissingCount: page.probablyMissingCount, probablyMissingSample: page.probablyMissingSample.slice(0, 20).map((candidate) => ({ product: candidate.product, priceText: candidate.priceText, packageSize: candidate.packageSize, category: candidate.category, qualityScore: candidate.qualityScore, rawContext: candidate.rawContext })) })), pages };
  await writeFile(`${OUTPUT_DIR}/penny-missing-coverage-audit-v1-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log("Penny missing coverage audit v1 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
}
main().catch((error) => { console.error(error); process.exit(1); });
