import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/albert-probe";
const CLEAN_OFFERS_PATH = "data/albert-pdf-offers-clean.json";

const LEAFLETS = [
  {
    id: "20sm_akcni_letak",
    leafletType: "supermarket",
    storeId: "albert-supermarket",
    storeName: "Albert supermarket",
    baseUrl: "https://letaky.albert.cz/20sm_akcni_letak/",
    maxPages: 43,
  },
  {
    id: "20hm_akcni_letak",
    leafletType: "hypermarket",
    storeId: "albert-hypermarket",
    storeName: "Albert hypermarket",
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
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertImagesProbeV1/0.1; +https://github.com/)",
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

async function testImage(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertImagesProbeV1/0.1; +https://github.com/)",
        accept: "image/*,*/*",
        range: "bytes=0-2048",
      },
    });

    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? "",
      contentLength: response.headers.get("content-length") ?? "",
      isImage: response.ok && /image/i.test(response.headers.get("content-type") ?? ""),
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

function extractUrls(html, baseUrl) {
  const urls = [];
  const decoded = decodeHtml(html);
  let match;

  const attrRegex = /(?:src|href|data-src|data-href|data-url|content|poster)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(decoded))) {
    urls.push(absoluteUrl(match[1], baseUrl));
  }

  const srcsetRegex = /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;
  while ((match = srcsetRegex.exec(decoded))) {
    for (const part of match[1].split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) urls.push(absoluteUrl(url, baseUrl));
    }
  }

  const httpRegex = /https?:\/\/[^"'\\\s)<>]+/gi;
  while ((match = httpRegex.exec(decoded))) {
    urls.push(match[0].replace(/[;,]+$/, ""));
  }

  return unique(urls.map((url) => url.replace(/\\/g, "")));
}

function isPageImageUrl(url) {
  return /^https:\/\/view\.publitas\.com\/\d+\/\d+\/pages\/.+-at(?:400|800|1200|1600|2400)\.jpg/i.test(url);
}

function pageImageSize(url) {
  const match = url.match(/-at(\d+)\.jpg/i);
  return match ? Number(match[1]) : 0;
}

function bestPageImageUrl(urls) {
  const pageImages = urls.filter(isPageImageUrl);
  if (!pageImages.length) return "";

  return [...pageImages].sort((a, b) => pageImageSize(b) - pageImageSize(a))[0];
}

async function loadCleanOffers() {
  try {
    const text = await readFile(CLEAN_OFFERS_PATH, "utf8");
    const json = JSON.parse(text);
    return Array.isArray(json.offers) ? json.offers : [];
  } catch {
    return [];
  }
}

function countOffersByPage(offers, leafletType, pageNumber) {
  return offers.filter(
    (offer) => offer.leafletType === leafletType && Number(offer.pageNumber) === Number(pageNumber)
  ).length;
}

async function inspectLeaflet(leaflet, offers) {
  const pages = [];
  let emptyInRow = 0;

  for (let pageNumber = 1; pageNumber <= leaflet.maxPages; pageNumber++) {
    const url = `${leaflet.baseUrl}page/${pageNumber}`;
    const page = await fetchText(url);

    if (!page.ok) {
      emptyInRow += 1;
      pages.push({
        pageNumber,
        url,
        ok: false,
        status: page.status,
        pageImageUrl: "",
        testedImage: null,
        offersOnPage: countOffersByPage(offers, leaflet.leafletType, pageNumber),
      });

      if (emptyInRow >= 5) break;
      continue;
    }

    const urls = extractUrls(page.text, page.finalUrl);
    const pageImageUrl = bestPageImageUrl(urls);
    const testedImage = pageImageUrl ? await testImage(pageImageUrl) : null;

    if (!pageImageUrl) emptyInRow += 1;
    else emptyInRow = 0;

    pages.push({
      pageNumber,
      url,
      ok: page.ok,
      status: page.status,
      finalUrl: page.finalUrl,
      htmlLength: page.text.length,
      pageImageUrl,
      testedImage,
      pageImageCandidates: urls.filter(isPageImageUrl).slice(0, 10),
      offersOnPage: countOffersByPage(offers, leaflet.leafletType, pageNumber),
    });
  }

  return {
    leaflet,
    summary: {
      pagesChecked: pages.length,
      pagesWithImage: pages.filter((page) => page.pageImageUrl).length,
      pagesWithWorkingImage: pages.filter((page) => page.testedImage?.isImage).length,
      offersCoveredByPageImage: pages.reduce((sum, page) => sum + (page.pageImageUrl ? page.offersOnPage : 0), 0),
      offersTotalInCleanData: offers.filter((offer) => offer.leafletType === leaflet.leafletType).length,
      recommendedPath:
        pages.filter((page) => page.testedImage?.isImage).length >= Math.min(leaflet.maxPages - 2, 35)
          ? "attach-page-image-urls-to-albert-offers"
          : "inspect-image-source-before-attach",
    },
    pages,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const offers = await loadCleanOffers();
  const results = [];

  for (const leaflet of LEAFLETS) {
    results.push(await inspectLeaflet(leaflet, offers));
  }

  const pageImageMap = {};
  for (const result of results) {
    pageImageMap[result.leaflet.leafletType] = {};
    for (const page of result.pages) {
      if (page.pageImageUrl) {
        pageImageMap[result.leaflet.leafletType][String(page.pageNumber)] = page.pageImageUrl;
      }
    }
  }

  const totalOffers = offers.length;
  const totalCovered = results.reduce((sum, result) => sum + result.summary.offersCoveredByPageImage, 0);

  const summary = {
    checkedAt: new Date().toISOString(),
    cleanOffersPath: CLEAN_OFFERS_PATH,
    summary: {
      cleanOffersLoaded: totalOffers,
      offersCoveredByPageImage: totalCovered,
      coveragePercent: totalOffers ? Math.round((totalCovered / totalOffers) * 10000) / 100 : 0,
      recommendedPath:
        totalOffers > 0 && totalCovered / totalOffers > 0.9
          ? "attach-page-image-urls-to-albert-offers"
          : "inspect-image-coverage-before-attach",
      leaflets: results.map((result) => ({
        id: result.leaflet.id,
        leafletType: result.leaflet.leafletType,
        storeName: result.leaflet.storeName,
        ...result.summary,
      })),
    },
    pageImageMap,
    sampleOffersWithPageImage: offers.slice(0, 80).map((offer) => ({
      id: offer.id,
      product: offer.product,
      storeName: offer.storeName,
      leafletType: offer.leafletType,
      pageNumber: offer.pageNumber,
      currentImageUrl: offer.imageUrl ?? "",
      pageImageUrl: pageImageMap[offer.leafletType]?.[String(offer.pageNumber)] ?? "",
    })),
  };

  await writeFile(`${OUTPUT_DIR}/albert-images-v1-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/albert-images-v1-debug.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");

  console.log("Albert images v1 probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/albert-images-v1-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
