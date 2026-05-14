import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/albert-probe";
const URLS = [
  "https://www.albert.cz/aktualni-letaky",
  "https://www.albert.cz/akcni-nabidky",
  "https://www.albert.cz/shop",
  "https://www.albert.cz",
];

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

function normalizeText(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function preview(value = "", max = 1400) {
  return String(value).slice(0, max);
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertProbe/0.1; +https://github.com/)",
        accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
        "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
      },
    });
    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? "",
      length: Number(response.headers.get("content-length") ?? 0),
      text: await response.text(),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      finalUrl: url,
      contentType: "",
      length: 0,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertProbe/0.1; +https://github.com/)",
        accept: "image/*,application/json,text/html,text/plain,*/*",
        range: "bytes=0-1024",
      },
    });
    const contentType = response.headers.get("content-type") ?? "";
    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType,
      contentLength: response.headers.get("content-length") ?? "",
      isImage: response.ok && /image/i.test(contentType),
      isJson: response.ok && /json/i.test(contentType),
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
      isJson: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractUrls(html, baseUrl) {
  const urls = [];
  const decoded = decodeHtml(html);
  let match;

  const attrRegex = /(?:src|href|data-src|data-href|data-url|content)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(decoded))) urls.push(absoluteUrl(match[1], baseUrl));

  const srcsetRegex = /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;
  while ((match = srcsetRegex.exec(decoded))) {
    for (const part of match[1].split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) urls.push(absoluteUrl(url, baseUrl));
    }
  }

  const httpRegex = /https?:\/\/[^"'\\\s)<>]+/gi;
  while ((match = httpRegex.exec(decoded))) urls.push(match[0].replace(/[;,]+$/, ""));

  return unique(urls.map((url) => url.replace(/\\/g, "")));
}

function extractScripts(html, baseUrl) {
  const scripts = [];
  let match;
  const regex = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = regex.exec(html))) scripts.push(absoluteUrl(match[1], baseUrl));
  return unique(scripts);
}

function imageLike(url) {
  return /\.(?:jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(url.split("?")[0]);
}

function dataLike(url) {
  return (
    /api|graphql|json|products|product|offers|offer|letak|leták|leaflet|promotion|promotions|akcni|akční|catalog|catalogue/i.test(url) ||
    /\.json(?:[?#].*)?$/i.test(url.split("?")[0])
  );
}

function priceLineMatches(text) {
  const normalized = normalizeText(text);
  return {
    priceMatches: unique(normalized.match(/\d{1,4}(?:\s?\d{3})*[,.]\d{1,2}\s*Kč/gi) || []).slice(0, 80),
    unitPriceMatches: unique(normalized.match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks)\s+\d{1,4}(?:\s?\d{3})*[,.]\d{1,2}\s*Kč/gi) || []).slice(0, 80),
  };
}

function productWords(text) {
  const normalized = normalizeText(text).toLowerCase();
  return ["máslo", "mléko", "sýr", "jogurt", "kuřecí", "káva", "rohlík", "banán", "brambory", "šunka", "pivo"]
    .filter((word) => normalized.includes(word));
}

function extractJsonLikeBlocks(html) {
  const blocks = [];
  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) blocks.push({ type: "__NEXT_DATA__", length: nextData[1].length, preview: preview(nextData[1], 1000) });

  const nuxtData = html.match(/<script[^>]*>\s*window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/i);
  if (nuxtData) blocks.push({ type: "__NUXT__", length: nuxtData[1].length, preview: preview(nuxtData[1], 1000) });

  for (const block of Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)).slice(0, 10)) {
    blocks.push({ type: "ld+json", length: block[1].length, preview: preview(block[1], 1000) });
  }

  return blocks;
}

async function probePage(url) {
  const page = await fetchText(url);
  const urls = extractUrls(page.text, page.finalUrl);
  const scripts = extractScripts(page.text, page.finalUrl);
  const imageUrls = urls.filter(imageLike);
  const dataUrls = unique([...urls, ...scripts]).filter(dataLike);
  const prices = priceLineMatches(page.text);

  const testedDataUrls = [];
  for (const dataUrl of dataUrls.slice(0, 25)) testedDataUrls.push(await testUrl(dataUrl));

  const testedImageUrls = [];
  for (const imageUrl of imageUrls.slice(0, 30)) testedImageUrls.push(await testUrl(imageUrl));

  return {
    url,
    ok: page.ok,
    status: page.status,
    finalUrl: page.finalUrl,
    contentType: page.contentType,
    htmlLength: page.text.length,
    textPreview: preview(normalizeText(page.text), 1600),
    foundProductWords: productWords(page.text),
    priceMatches: prices.priceMatches,
    unitPriceMatches: prices.unitPriceMatches,
    jsonLikeBlocks: extractJsonLikeBlocks(page.text),
    scripts: scripts.slice(0, 50),
    imageUrls: imageUrls.slice(0, 60),
    dataUrls: dataUrls.slice(0, 60),
    testedDataUrls,
    testedImageUrls,
  };
}

function summarize(pages) {
  const allImages = unique(pages.flatMap((page) => page.imageUrls));
  const allData = unique(pages.flatMap((page) => page.dataUrls));
  const allPrices = unique(pages.flatMap((page) => page.priceMatches));
  const allUnits = unique(pages.flatMap((page) => page.unitPriceMatches));
  const allWords = unique(pages.flatMap((page) => page.foundProductWords));
  const workingImages = pages.flatMap((page) => page.testedImageUrls).filter((item) => item.isImage);
  const workingJson = pages.flatMap((page) => page.testedDataUrls).filter((item) => item.isJson);
  const jsonBlocks = pages.flatMap((page) => page.jsonLikeBlocks);

  let recommendedPath = "source-not-obvious";
  if (workingJson.length || jsonBlocks.length) recommendedPath = "inspect-json-or-api-first";
  else if (allPrices.length > 10 && allWords.length > 2) recommendedPath = "html-parser-possible";
  else if (allImages.length) recommendedPath = "image-or-leaflet-probe-needed";

  return {
    recommendedPath,
    counts: {
      pagesChecked: pages.length,
      imageUrls: allImages.length,
      dataUrls: allData.length,
      priceExamples: allPrices.length,
      unitPriceExamples: allUnits.length,
      productWordsFound: allWords.length,
      workingImages: workingImages.length,
      workingJsonEndpoints: workingJson.length,
      jsonLikeBlocks: jsonBlocks.length,
    },
    productWordsFound: allWords,
    priceExamples: allPrices.slice(0, 30),
    unitPriceExamples: allUnits.slice(0, 30),
    workingJsonEndpoints: workingJson.slice(0, 20),
    workingImages: workingImages.slice(0, 20),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pages = [];
  for (const url of URLS) pages.push(await probePage(url));

  const result = {
    checkedAt: new Date().toISOString(),
    sourceUrls: URLS,
    summary: summarize(pages),
    pages,
  };

  await writeFile(`${OUTPUT_DIR}/albert-source-probe.json`, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify({
    checkedAt: result.checkedAt,
    sourceUrls: result.sourceUrls,
    summary: result.summary,
    pages: pages.map((page) => ({
      url: page.url,
      ok: page.ok,
      status: page.status,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      htmlLength: page.htmlLength,
      foundProductWords: page.foundProductWords,
      priceMatches: page.priceMatches.slice(0, 20),
      unitPriceMatches: page.unitPriceMatches.slice(0, 20),
      jsonLikeBlocks: page.jsonLikeBlocks,
      dataUrls: page.dataUrls.slice(0, 40),
      imageUrls: page.imageUrls.slice(0, 40),
      testedDataUrls: page.testedDataUrls.slice(0, 20),
      testedImageUrls: page.testedImageUrls.slice(0, 20),
      textPreview: page.textPreview,
    })),
  }, null, 2) + "\n", "utf8");

  console.log("Albert source probe finished.");
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
