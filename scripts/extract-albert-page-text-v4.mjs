import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/albert-probe";

const LEAFLETS = [
  {
    id: "20sm_akcni_letak",
    type: "supermarket",
    title: "Albert supermarket akční leták",
    baseUrl: "https://letaky.albert.cz/20sm_akcni_letak/",
    maxPages: 42,
  },
  {
    id: "20hm_akcni_letak",
    type: "hypermarket",
    title: "Albert hypermarket akční leták",
    baseUrl: "https://letaky.albert.cz/20hm_akcni_letak/",
    maxPages: 60,
  },
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
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(decodeHtml(href), baseUrl).toString();
  } catch {
    return decodeHtml(href);
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertTextExtractV4/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  return {
    url,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
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
  while ((match = httpRegex.exec(decoded))) {
    urls.push(match[0].replace(/[;,]+$/, ""));
  }

  return unique(urls.map((url) => url.replace(/\\/g, "")));
}

function isUsefulText(raw) {
  const normalized = normalizeText(raw);

  if (normalized.length < 55) return false;
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

    try {
      parsed = new URL(url);
    } catch {
      const plain = normalizeText(url);
      if (isUsefulText(plain)) candidates.push(plain);
      continue;
    }

    if (!parsed.hostname.includes("letaky.albert.cz")) continue;
    if (!parsed.pathname.includes(basePath)) continue;

    const segments = parsed.pathname
      .split("/")
      .map((part) => normalizeText(part))
      .filter(Boolean);

    for (const segment of segments) {
      if (isUsefulText(segment)) candidates.push(segment);
    }
  }

  return unique(candidates);
}

function extractPageImageUrls(urls) {
  return unique(
    urls.filter((url) =>
      /^https:\/\/view\.publitas\.com\/\d+\/\d+\/pages\/.+-at1600\.jpg/i.test(url)
    )
  );
}

function toPriceNumber(value) {
  if (!value) return null;

  let text = String(value)
    .replace(/\s+/g, "")
    .replace(/Kč/i, "")
    .replace(",-", ",00")
    .replace(/^20(?=\d{2},\d{2}$)/, "")
    .replace(/^0(?=\d{2,3},\d{2}$)/, "")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function priceText(number) {
  if (number == null) return "";
  return number.toLocaleString("cs-CZ", {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  }) + " Kč";
}

function packageAmountForUnit(packageSize = "") {
  const text = packageSize.toLowerCase().replace(",", ".");
  const multi = text.match(/(\d+)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(?:[–-]\s*(\d+(?:\.\d+)?))?\s*(g|kg|ml|l|ks|role)/i);
  if (multi) {
    const count = Number(multi[1]);
    const amount = Number(multi[3] || multi[2]);
    const unit = multi[4];

    if (unit === "kg" || unit === "l") return count * amount * 1000;
    return count * amount;
  }

  const single = text.match(/(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?\s*(g|kg|ml|l|ks|role)/i);
  if (!single) return null;

  const amount = Number(single[2] || single[1]);
  const unit = single[3];

  if (unit === "kg" || unit === "l") return amount * 1000;
  return amount;
}

function calculateMainPrice(unitPrice, unit, packageSize) {
  if (unitPrice == null || !unit || !packageSize) return null;

  const amount = packageAmountForUnit(packageSize);
  if (!amount) return null;

  if (/100\s*g|100\s*ml/i.test(unit)) return Math.round(unitPrice * (amount / 100) * 100) / 100;
  if (/1\s*kg|1\s*l/i.test(unit)) return Math.round(unitPrice * (amount / 1000) * 100) / 100;
  if (/1\s*ks|1\s*role/i.test(unit)) return Math.round(unitPrice * amount * 100) / 100;

  return null;
}

function stripNoiseWords(text = "") {
  return normalizeText(text)
    .replace(/\b(?:BEZ APLIKACE|APLIKACE|BĚŽNÁ CENA|NEPORAZITELNÉ|VÍCE AKCÍ|EXTRA LETÁK|SUPER CENA|FANDÍME HOKEJI|NOVINKA|KREDITY NAVÍC|AKČNÍ NABÍDKA)\b/gi, " ")
    .replace(/\b(?:Trvanlivé|potraviny|Nápoje|Drogerie|Zvířata|Nature|Akce|Nabídka)\b/gi, " ")
    .replace(/\bOd\s+\d{1,2}\.\s*\d{1,2}\.\s*do\s+\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\b/gi, " ")
    .replace(/\bwww\.albert\.cz\b/gi, " ")
    .replace(/\b[-+]?\d{1,3}\s*%\b/g, " ")
    .replace(/\bKč\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanProductName(value = "", description = "") {
  let text = stripNoiseWords(value)
    .replace(/\b\d{1,4}[,.]\d{2}\s*Kč\b/gi, " ")
    .replace(/\b\d{1,4},-\b/g, " ")
    .replace(/\b\d{1,4}[,.]\d{2}\b/g, " ")
    .replace(/\b\d{3,6}\b/g, " ")
    .replace(/\b\d{1,2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Když před produktem zůstane jiný produkt/cena, často je správný produkt až poslední 1–4 slova.
  const words = text.split(" ").filter(Boolean);

  const stopPrefixes = new Set(["Fanta", "Coca-Cola/Fanta"]);
  if (words.length > 1 && stopPrefixes.has(words[0])) {
    words.shift();
    text = words.join(" ");
  }

  // Speciální, ale bezpečné zkrácení pro běžné popisy, kde produkt bývá poslední značka před odrážkou.
  if (/energetický nápoj/i.test(description) && /\bSemtex\b/i.test(text)) return "Semtex";
  if (/energetický nápoj/i.test(description) && /\bTiger\b/i.test(text)) return "Tiger";
  if (/nealkoholické pivo/i.test(description) && /\bBirell\b/i.test(text)) return "Birell";
  if (/nealkoholické pivo/i.test(description) && /\bCool\b/i.test(text)) return "Cool";

  if (words.length > 6) text = words.slice(-6).join(" ");

  return text.trim();
}

function isBadProductName(product = "") {
  const text = product.trim();

  if (text.length < 3) return true;
  if (!/[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]/.test(text)) return true;
  if (/^(od|do|www|albert|cz|kč|kg|g|ml|l|ks|cena|za|bez|vybrané druhy|různé druhy|chlazené|chlazená|balené|balená)$/i.test(text)) return true;
  if (/^(100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks)\b/i.test(text)) return true;
  if (/=/.test(text)) return true;
  if (/^\d/.test(text)) return true;
  if (/\bKč\b/i.test(text)) return true;

  return false;
}

function extractCandidatePrice(afterText, computedPrice, unitPrice) {
  const after = normalizeText(afterText);
  const explicitPrices = [...after.matchAll(/\b(?:20|0)?\d{1,4}[,.]\d{2}\s*Kč|\b\d{1,4},-/gi)]
    .map((match) => toPriceNumber(match[0]))
    .filter((price) => price != null && price > 0 && price < 10000);

  // Jestli máme jednotkovou cenu a balení, dopočet je často čistší než bordel v okolním OCR textu.
  if (computedPrice != null && computedPrice > 0) {
    const closeExplicit = explicitPrices.find((price) => Math.abs(price - computedPrice) / Math.max(computedPrice, 1) < 0.08);
    return closeExplicit ?? computedPrice;
  }

  return explicitPrices.at(-1) ?? null;
}

function classifyQuality(product, price, rawContext) {
  const reasons = [];

  if (/VÍCE AKCÍ|BĚŽNÁ CENA|BEZ APLIKACE|NEPORAZITELNÉ/i.test(product)) reasons.push("šum v názvu");
  if (/\b\d{3,6}\b/.test(product)) reasons.push("čísla v názvu");
  if (/Kč|%|=/.test(product)) reasons.push("cena v názvu");
  if (price == null || price <= 0) reasons.push("chybí cena");
  if (/BĚŽNÁ CENA/i.test(rawContext)) reasons.push("v okolí běžná cena");

  if (reasons.length === 0) return { confidence: "medium", suspect: false, suspectReasons: [] };
  return { confidence: "low", suspect: true, suspectReasons: reasons };
}

function offerKey(offer) {
  return `${offer.leafletType}|${offer.product.toLowerCase()}|${offer.packageSize.toLowerCase()}|${offer.price}|${offer.pageNumber}`;
}

function extractOffers(text, pageNumber, pageImageUrl, leaflet) {
  const normalized = normalizeText(text);
  const offers = [];

  const regex =
    /(?<product>[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9][^•]{2,100})\s*•\s*(?<desc>[^•]{0,90})\s*•\s*(?<package>(?:\d+\s*[×x]\s*)?\d+(?:[,.]\d+)?(?:\s*[–-]\s*\d+(?:[,.]\d+)?)?\s*(?:g|kg|ml|l|ks|role))\s*•\s*(?<unit>(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role)\s*(?:=|od|za)?\s*(?:20|0)?\d{1,4}[,.]\d{2}\s*Kč)(?<after>[^•]{0,140})/gi;

  let match;
  while ((match = regex.exec(normalized))) {
    const groups = match.groups ?? {};
    const description = stripNoiseWords(groups.desc)
      .replace(/\bvybrané druhy\b/gi, "")
      .trim();

    const product = cleanProductName(groups.product, description);
    const packageSize = normalizeText(groups.package);
    const unitText = normalizeText(groups.unit);
    const unitMatch = unitText.match(/^(100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role)/i);
    const unit = unitMatch ? `Kč/${unitMatch[1].replace(/\s+/g, " ")}` : "";
    const unitPrice = toPriceNumber(unitText.match(/(?:20|0)?\d{1,4}[,.]\d{2}/)?.[0] ?? "");
    const calculatedPrice = calculateMainPrice(unitPrice, unit, packageSize);
    const price = extractCandidatePrice(groups.after ?? "", calculatedPrice, unitPrice);
    const rawContext = normalizeText(match[0]).slice(0, 420);

    if (isBadProductName(product)) continue;
    if (price == null || price <= 0 || price > 10000) continue;

    const quality = classifyQuality(product, price, rawContext);

    offers.push({
      id: `albert-${leaflet.type}-${pageNumber}-${offers.length + 1}`,
      chain: "Albert",
      storeId: `albert-${leaflet.type}`,
      storeName: `Albert ${leaflet.type === "hypermarket" ? "hypermarket" : "supermarket"}`,
      leafletType: leaflet.type,
      product,
      brand: "",
      description,
      packageSize,
      price,
      priceText: priceText(price),
      unitPrice,
      unit,
      unitText,
      pageNumber,
      imageUrl: "",
      pageImageUrl,
      imageType: pageImageUrl ? "page-thumbnail" : "",
      sourceUrl: `${leaflet.baseUrl}page/${pageNumber}`,
      confidence: quality.confidence,
      suspect: quality.suspect,
      suspectReasons: quality.suspectReasons,
      rawContext,
    });
  }

  return offers;
}

async function inspectLeaflet(leaflet) {
  const pages = [];
  const allOffers = [];
  let emptyInRow = 0;

  for (let page = 1; page <= leaflet.maxPages; page++) {
    const url = `${leaflet.baseUrl}page/${page}`;
    const response = await fetchText(url);

    if (!response.ok) {
      emptyInRow += 1;
      if (emptyInRow >= 5) break;
      continue;
    }

    const urls = extractAllUrls(response.text, response.finalUrl);
    const textCandidates = extractTextCandidatesFromUrls(urls, leaflet.baseUrl);
    const pageImageUrls = extractPageImageUrls(urls);
    const pageImageUrl = pageImageUrls[0] ?? "";
    const joinedText = textCandidates.join(" ");
    const offers = extractOffers(joinedText, page, pageImageUrl, leaflet);

    if (textCandidates.length === 0 && pageImageUrls.length === 0) emptyInRow += 1;
    else emptyInRow = 0;

    pages.push({
      page,
      url,
      ok: response.ok,
      status: response.status,
      htmlLength: response.text.length,
      textCandidatesCount: textCandidates.length,
      decodedTextPreview: joinedText.slice(0, 900),
      pageImageUrl,
      offerCandidatesCount: offers.length,
      cleanOfferCandidatesCount: offers.filter((offer) => !offer.suspect).length,
      offerCandidatesPreview: offers.slice(0, 12),
    });

    allOffers.push(...offers);
  }

  const deduped = [];
  const seen = new Set();

  for (const offer of allOffers) {
    const key = offerKey(offer);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(offer);
  }

  return {
    leaflet,
    summary: {
      pagesChecked: pages.length,
      pagesWithText: pages.filter((page) => page.textCandidatesCount > 0).length,
      pagesWithImages: pages.filter((page) => page.pageImageUrl).length,
      offerCandidates: deduped.length,
      cleanOfferCandidates: deduped.filter((offer) => !offer.suspect).length,
      suspectOfferCandidates: deduped.filter((offer) => offer.suspect).length,
      pagesWithOffers: pages.filter((page) => page.offerCandidatesCount > 0).length,
      recommendedPath:
        deduped.filter((offer) => !offer.suspect).length > 30
          ? "build-albert-importer-from-v4-clean-candidates"
          : deduped.length > 0
            ? "inspect-v4-candidates-before-import"
            : "fallback-to-pdf-or-more-parser-work",
    },
    pages,
    offers: deduped,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const results = [];
  for (const leaflet of LEAFLETS) {
    results.push(await inspectLeaflet(leaflet));
  }

  const allOffers = results.flatMap((result) => result.offers);

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      totalOfferCandidates: allOffers.length,
      totalCleanOfferCandidates: allOffers.filter((offer) => !offer.suspect).length,
      totalSuspectOfferCandidates: allOffers.filter((offer) => offer.suspect).length,
      recommendedPath:
        allOffers.filter((offer) => !offer.suspect).length > 60
          ? "build-albert-importer-from-v4-clean-candidates"
          : allOffers.length > 0
            ? "inspect-v4-candidates-before-import"
            : "fallback-to-pdf-or-more-parser-work",
      leaflets: results.map((result) => ({
        id: result.leaflet.id,
        type: result.leaflet.type,
        title: result.leaflet.title,
        ...result.summary,
      })),
    },
    cleanSampleOffers: allOffers.filter((offer) => !offer.suspect).slice(0, 120),
    suspectSampleOffers: allOffers.filter((offer) => offer.suspect).slice(0, 60),
  };

  await writeFile(`${OUTPUT_DIR}/albert-page-text-v4-debug.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/page-text-v4-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Albert hidden page text extraction v4 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/page-text-v4-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
