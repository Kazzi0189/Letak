import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUTPUT_DIR = "data/product-image-probe";

const PENNY = {
  name: "Penny",
  offersPath: "data/penny-leaflet-offers.json",
  viewerBaseUrl: "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/",
  pagesFrom: 2,
  pagesTo: 37,
};

const KAUFLAND = {
  name: "Kaufland Teplice",
  offersPath: "data/offers-kaufland-teplice.json",
};

function decodeHtml(value = "") {
  return value
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

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(decodeHtml(href), baseUrl).toString();
  } catch {
    return decodeHtml(href);
  }
}

function preview(value = "", max = 1000) {
  return String(value).slice(0, max);
}

function normalizeText(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function productTokens(product = "") {
  return normalizeText(product)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 4)
    .slice(0, 8);
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) {
    return { exists: false, offers: [], raw: null };
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);

  return {
    exists: true,
    offers: Array.isArray(parsed.offers) ? parsed.offers : [],
    raw: parsed,
  };
}

async function fetchText(url, accept = "text/html,application/json,text/plain,*/*") {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacImageProbe/0.1; +https://github.com/)",
      accept,
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  const text = await response.text();

  return {
    url,
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    contentType: response.headers.get("content-type") ?? "",
    contentLength: response.headers.get("content-length") ?? "",
    length: text.length,
    text,
  };
}

async function testUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacImageProbe/0.1; +https://github.com/)",
        accept: "image/*,text/html,application/json,text/plain,*/*",
        "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
        range: "bytes=0-2048",
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = response.headers.get("content-length") ?? "";
    const text = /json|text|html|xml/i.test(contentType) ? await response.text() : "";

    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType,
      contentLength,
      isImage: response.ok && /image/i.test(contentType),
      textPreview: preview(text, 500),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      finalUrl: null,
      contentType: "",
      contentLength: "",
      isImage: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractImageUrls(html, baseUrl) {
  const urls = [];

  const attrRegex = /(?:src|data-src|data-lazy|data-original|data-image|href)\s*=\s*["']([^"']+)["']/gi;
  let match;

  while ((match = attrRegex.exec(html))) {
    urls.push(absoluteUrl(match[1], baseUrl));
  }

  const srcsetRegex = /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;
  while ((match = srcsetRegex.exec(html))) {
    const parts = decodeHtml(match[1])
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);

    for (const part of parts) {
      urls.push(absoluteUrl(part, baseUrl));
    }
  }

  const httpImageRegex = /https?:\/\/[^"'\\\s)<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s)<>]*)?/gi;
  while ((match = httpImageRegex.exec(decodeHtml(html)))) {
    urls.push(match[0].replace(/[;,]+$/, ""));
  }

  const relativeImageRegex = /["'`](\.?\/?[^"'`]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'`]*)?)["'`]/gi;
  while ((match = relativeImageRegex.exec(decodeHtml(html)))) {
    urls.push(absoluteUrl(match[1], baseUrl));
  }

  return unique(
    urls
      .map((url) => url.trim())
      .filter((url) => /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url.split("?")[0]))
  );
}

function classifyImage(url) {
  const lower = url.toLowerCase();

  if (/logo|icon|sprite|favicon|placeholder|pagestub|fbthumb|cover300|cover/i.test(lower)) {
    return "decorative-or-cover";
  }

  if (/leaflet|page|publication|catalog|letak|leták|brochure|prospekt/i.test(lower)) {
    return "page-or-leaflet-image";
  }

  if (/product|products|media|image|img|asset|cdn|usercontent|kaufland|penny/i.test(lower)) {
    return "possible-product-image";
  }

  return "unknown-image";
}

function extractOfferImageFields(offers) {
  const keys = [
    "imageUrl",
    "image",
    "imageSrc",
    "img",
    "thumbnail",
    "thumbnailUrl",
    "picture",
    "pictureUrl",
    "productImage",
    "productImageUrl",
    "pageImage",
  ];

  return offers
    .map((offer) => {
      const found = {};

      for (const key of keys) {
        if (offer[key]) found[key] = offer[key];
      }

      return {
        product: offer.product,
        storeName: offer.storeName,
        sourceUrl: offer.sourceUrl,
        leafletUrl: offer.leafletUrl,
        pageNumber: offer.pageNumber,
        found,
      };
    })
    .filter((item) => Object.keys(item.found).length > 0);
}

function findNearbyImageCandidates(html, baseUrl, offers, limit = 60) {
  const candidates = [];

  const imageTags = Array.from(html.matchAll(/<img\b[^>]*>/gi)).map((match) => ({
    index: match.index ?? 0,
    tag: match[0],
    src:
      match[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ||
      match[0].match(/\bdata-src\s*=\s*["']([^"']+)["']/i)?.[1] ||
      match[0].match(/\bdata-original\s*=\s*["']([^"']+)["']/i)?.[1] ||
      "",
  }));

  const normalizedHtml = decodeHtml(html)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  for (const offer of offers.slice(0, 120)) {
    const tokens = productTokens(offer.product);
    if (!tokens.length) continue;

    let bestIndex = -1;
    for (const token of tokens) {
      const idx = normalizedHtml.indexOf(token);
      if (idx >= 0) {
        bestIndex = idx;
        break;
      }
    }

    if (bestIndex < 0) continue;

    const nearby = imageTags
      .map((img) => ({
        ...img,
        distance: Math.abs(img.index - bestIndex),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);

    for (const img of nearby) {
      if (!img.src) continue;
      const imageUrl = absoluteUrl(img.src, baseUrl);

      candidates.push({
        product: offer.product,
        pageNumber: offer.pageNumber,
        imageUrl,
        distance: img.distance,
        imageClass: classifyImage(imageUrl),
      });
    }
  }

  return unique(candidates.map((item) => JSON.stringify(item)))
    .map((item) => JSON.parse(item))
    .slice(0, limit);
}

async function probePenny() {
  const data = await readJsonIfExists(PENNY.offersPath);
  const offers = data.offers;

  const existingImageFields = extractOfferImageFields(offers);
  const pages = [];
  const allImages = [];
  const nearbyCandidates = [];

  for (let page = PENNY.pagesFrom; page <= PENNY.pagesTo; page++) {
    const url = `${PENNY.viewerBaseUrl}${page}/index.html`;
    const response = await fetchText(url);
    const pageOffers = offers.filter((offer) => Number(offer.pageNumber) === page);
    const images = extractImageUrls(response.text, response.finalUrl);
    const nearby = findNearbyImageCandidates(response.text, response.finalUrl, pageOffers, 30);

    pages.push({
      page,
      url,
      ok: response.ok,
      status: response.status,
      contentType: response.contentType,
      length: response.length,
      offersOnPage: pageOffers.length,
      images: images.map((imageUrl) => ({ imageUrl, imageClass: classifyImage(imageUrl) })),
      nearbyCandidates: nearby,
      textPreview: preview(normalizeText(response.text), 900),
    });

    allImages.push(...images);
    nearbyCandidates.push(...nearby);
  }

  const uniqueImages = unique(allImages);
  const testedImages = [];

  for (const url of uniqueImages.slice(0, 120)) {
    const tested = await testUrl(url);
    if (tested.ok) testedImages.push({ ...tested, imageClass: classifyImage(url) });
  }

  return {
    name: PENNY.name,
    offersFileExists: data.exists,
    offersCount: offers.length,
    existingImageFields,
    pages,
    uniqueImages: uniqueImages.map((imageUrl) => ({ imageUrl, imageClass: classifyImage(imageUrl) })),
    testedImages,
    nearbyCandidates,
  };
}

function sourceUrlsFromOffers(offers) {
  return unique(
    offers.flatMap((offer) => [
      offer.sourceUrl,
      offer.leafletUrl,
      offer.url,
      offer.productUrl,
    ])
      .filter(Boolean)
      .filter((url) => /^https?:\/\//i.test(url))
  );
}

async function probeKaufland() {
  const data = await readJsonIfExists(KAUFLAND.offersPath);
  const offers = data.offers;
  const existingImageFields = extractOfferImageFields(offers);
  const urls = sourceUrlsFromOffers(offers);

  const pages = [];
  const allImages = [];
  const nearbyCandidates = [];

  for (const url of urls.slice(0, 12)) {
    const response = await fetchText(url);
    const images = extractImageUrls(response.text, response.finalUrl);
    const nearby = findNearbyImageCandidates(response.text, response.finalUrl, offers, 40);

    pages.push({
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.finalUrl,
      contentType: response.contentType,
      length: response.length,
      images: images.map((imageUrl) => ({ imageUrl, imageClass: classifyImage(imageUrl) })),
      nearbyCandidates: nearby,
      textPreview: preview(normalizeText(response.text), 900),
    });

    allImages.push(...images);
    nearbyCandidates.push(...nearby);
  }

  const uniqueImages = unique(allImages);
  const testedImages = [];

  for (const url of uniqueImages.slice(0, 120)) {
    const tested = await testUrl(url);
    if (tested.ok) testedImages.push({ ...tested, imageClass: classifyImage(url) });
  }

  return {
    name: KAUFLAND.name,
    offersFileExists: data.exists,
    offersCount: offers.length,
    sourceUrls: urls.slice(0, 50),
    existingImageFields,
    pages,
    uniqueImages: uniqueImages.map((imageUrl) => ({ imageUrl, imageClass: classifyImage(imageUrl) })),
    testedImages,
    nearbyCandidates,
  };
}

function summarizeChain(result) {
  const existing = result.existingImageFields.length;
  const possibleProduct = result.testedImages.filter((item) => item.imageClass === "possible-product-image").length;
  const pageImages = result.testedImages.filter((item) => item.imageClass === "page-or-leaflet-image").length;
  const decorative = result.testedImages.filter((item) => item.imageClass === "decorative-or-cover").length;
  const nearby = result.nearbyCandidates.filter((item) => item.imageClass === "possible-product-image").length;

  let recommendedPath = "unknown";

  if (existing > 0) recommendedPath = "use-existing-offer-image-fields";
  else if (possibleProduct > 0 || nearby > 0) recommendedPath = "map-product-images-from-html";
  else if (pageImages > 0) recommendedPath = "page-image-crops-or-no-product-images";
  else recommendedPath = "no-direct-product-images-found";

  return {
    recommendedPath,
    counts: {
      offers: result.offersCount,
      existingImageFields: existing,
      testedImages: result.testedImages.length,
      possibleProductImages: possibleProduct,
      pageOrLeafletImages: pageImages,
      decorativeOrCoverImages: decorative,
      nearbyPossibleProductCandidates: nearby,
    },
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const penny = await probePenny();
  const kaufland = await probeKaufland();

  const result = {
    checkedAt: new Date().toISOString(),
    penny,
    kaufland,
  };

  const summary = {
    checkedAt: result.checkedAt,
    summary: {
      penny: summarizeChain(penny),
      kaufland: summarizeChain(kaufland),
      notes: [
        "existingImageFields znamená, že JSON nabídky už obsahuje imageUrl nebo podobné pole.",
        "possibleProductImages znamená, že HTML zdroj obsahuje obrázky, které nevypadají jako logo/cover/page.",
        "pageOrLeafletImages znamená spíš obrázky celé stránky letáku, ne samostatný produkt.",
        "nearbyCandidates je pokus najít img tag blízko textu konkrétního produktu.",
      ],
    },
    penny: {
      offersCount: penny.offersCount,
      existingImageFields: penny.existingImageFields.slice(0, 30),
      uniqueImages: penny.uniqueImages.slice(0, 80),
      testedImages: penny.testedImages.slice(0, 80),
      nearbyCandidates: penny.nearbyCandidates.slice(0, 80),
      pages: penny.pages.map((page) => ({
        page: page.page,
        offersOnPage: page.offersOnPage,
        imagesCount: page.images.length,
        possibleProductImages: page.images.filter((img) => img.imageClass === "possible-product-image").slice(0, 20),
        pageImages: page.images.filter((img) => img.imageClass === "page-or-leaflet-image").slice(0, 20),
        nearbyCandidates: page.nearbyCandidates.slice(0, 20),
      })),
    },
    kaufland: {
      offersCount: kaufland.offersCount,
      sourceUrls: kaufland.sourceUrls,
      existingImageFields: kaufland.existingImageFields.slice(0, 30),
      uniqueImages: kaufland.uniqueImages.slice(0, 80),
      testedImages: kaufland.testedImages.slice(0, 80),
      nearbyCandidates: kaufland.nearbyCandidates.slice(0, 80),
      pages: kaufland.pages.map((page) => ({
        url: page.url,
        finalUrl: page.finalUrl,
        status: page.status,
        imagesCount: page.images.length,
        possibleProductImages: page.images.filter((img) => img.imageClass === "possible-product-image").slice(0, 20),
        pageImages: page.images.filter((img) => img.imageClass === "page-or-leaflet-image").slice(0, 20),
        nearbyCandidates: page.nearbyCandidates.slice(0, 20),
      })),
    },
  };

  await writeFile(`${OUTPUT_DIR}/product-image-probe.json`, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Product image probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
