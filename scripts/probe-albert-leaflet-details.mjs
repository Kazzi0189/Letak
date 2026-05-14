import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/albert-probe";

const LEAFLETS = [
  {
    id: "20sm_akcni_letak",
    type: "supermarket",
    title: "Albert supermarket akční leták",
    url: "https://letaky.albert.cz/20sm_akcni_letak/",
    pdfUrl: "https://view.publitas.com/90263/3054369/pdfs/24c390bb-c750-424c-968d-cd0ba0955889.pdf?response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27Albert%2520-%252020SM_akcni_letak.pdf",
  },
  {
    id: "20hm_akcni_letak",
    type: "hypermarket",
    title: "Albert hypermarket akční leták",
    url: "https://letaky.albert.cz/20hm_akcni_letak/",
    pdfUrl: "https://view.publitas.com/90263/3054366/pdfs/86f6e4f5-04c7-4ba5-a2bd-588266f53987.pdf?response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27Albert%2520-%252020HM_akcni_letak.pdf",
  },
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

function preview(value = "", max = 1600) {
  return String(value).slice(0, max);
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertLeafletProbe/0.1; +https://github.com/)",
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
      contentLength: response.headers.get("content-length") ?? "",
      text: await response.text(),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      finalUrl: url,
      contentType: "",
      contentLength: "",
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchBinaryInfo(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertLeafletProbe/0.1; +https://github.com/)",
        accept: "application/pdf,application/octet-stream,*/*",
        range: "bytes=0-4096",
      },
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const asciiPreview = buffer
      .toString("latin1")
      .replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 800);

    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? "",
      contentLength: response.headers.get("content-length") ?? "",
      acceptRanges: response.headers.get("accept-ranges") ?? "",
      firstBytesHex: buffer.subarray(0, 24).toString("hex"),
      asciiPreview,
      looksLikePdf: buffer.subarray(0, 5).toString("latin1") === "%PDF-",
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      finalUrl: null,
      contentType: "",
      contentLength: "",
      looksLikePdf: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertLeafletProbe/0.1; +https://github.com/)",
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

function imageLike(url) {
  return /\.(?:jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(url.split("?")[0]);
}

function dataLike(url) {
  return (
    /api|graphql|json|products|product|offers|offer|letak|leaflet|catalog|publitas|publication|page|pdf/i.test(url) ||
    /\.json(?:[?#].*)?$/i.test(url.split("?")[0])
  );
}

function priceMatches(text) {
  const normalized = normalizeText(text);
  return {
    prices: unique(normalized.match(/\d{1,4}(?:\s?\d{3})*[,.]\d{1,2}\s*Kč/gi) || []).slice(0, 100),
    units: unique(normalized.match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks)\s+\d{1,4}(?:\s?\d{3})*[,.]\d{1,2}\s*Kč/gi) || []).slice(0, 100),
  };
}

function productWords(text) {
  const normalized = normalizeText(text).toLowerCase();
  return [
    "máslo",
    "mléko",
    "sýr",
    "jogurt",
    "kuřecí",
    "káva",
    "rohlík",
    "banán",
    "brambory",
    "šunka",
    "pivo",
    "eidam",
    "tatra",
    "madeta",
  ].filter((word) => normalized.includes(word));
}

function extractJsonLikeBlocks(html) {
  const blocks = [];

  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) blocks.push({ type: "__NEXT_DATA__", length: nextData[1].length, preview: preview(nextData[1], 1200) });

  for (const block of Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)).slice(0, 20)) {
    blocks.push({ type: "ld+json", length: block[1].length, preview: preview(block[1], 1200) });
  }

  const appDataPatterns = [
    /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);<\/script>/i,
    /window\.__DATA__\s*=\s*([\s\S]*?);<\/script>/i,
    /window\.Publitas\s*=\s*([\s\S]*?);/i,
    /publication\s*:\s*({[\s\S]{0,2000}?})/i,
  ];

  for (const pattern of appDataPatterns) {
    const match = html.match(pattern);
    if (match) blocks.push({ type: "app-data-pattern", length: match[1].length, preview: preview(match[1], 1200) });
  }

  return blocks;
}

async function inspectHtmlUrl(url) {
  const page = await fetchText(url);
  const urls = extractUrls(page.text, page.finalUrl);
  const imageUrls = urls.filter(imageLike);
  const dataUrls = urls.filter(dataLike);
  const prices = priceMatches(page.text);

  const testedDataUrls = [];
  for (const dataUrl of dataUrls.slice(0, 35)) {
    testedDataUrls.push(await testUrl(dataUrl));
  }

  const testedImageUrls = [];
  for (const imageUrl of imageUrls.slice(0, 50)) {
    testedImageUrls.push(await testUrl(imageUrl));
  }

  return {
    url,
    ok: page.ok,
    status: page.status,
    finalUrl: page.finalUrl,
    contentType: page.contentType,
    contentLength: page.contentLength,
    htmlLength: page.text.length,
    textPreview: preview(normalizeText(page.text), 2200),
    productWords: productWords(page.text),
    priceMatches: prices.prices,
    unitPriceMatches: prices.units,
    jsonLikeBlocks: extractJsonLikeBlocks(page.text),
    dataUrls: dataUrls.slice(0, 100),
    imageUrls: imageUrls.slice(0, 100),
    testedDataUrls,
    testedImageUrls,
  };
}

async function inspectLeaflet(leaflet) {
  const pageUrls = [
    leaflet.url,
    `${leaflet.url.replace(/\/$/, "")}/page/1`,
    `${leaflet.url.replace(/\/$/, "")}/page/2-3`,
    `${leaflet.url.replace(/\/$/, "")}/page/4-5`,
  ];

  const pages = [];
  for (const url of pageUrls) {
    pages.push(await inspectHtmlUrl(url));
  }

  const pdf = await fetchBinaryInfo(leaflet.pdfUrl);

  const allDataUrls = unique(pages.flatMap((page) => page.dataUrls));
  const allImageUrls = unique(pages.flatMap((page) => page.imageUrls));
  const allPrices = unique(pages.flatMap((page) => page.priceMatches));
  const allUnitPrices = unique(pages.flatMap((page) => page.unitPriceMatches));
  const allWords = unique(pages.flatMap((page) => page.productWords));
  const jsonBlocks = pages.flatMap((page) => page.jsonLikeBlocks);
  const workingImages = pages.flatMap((page) => page.testedImageUrls).filter((item) => item.isImage);
  const workingJson = pages.flatMap((page) => page.testedDataUrls).filter((item) => item.isJson);

  let recommendedPath = "unknown";
  if (allPrices.length > 10 && allWords.length > 2) recommendedPath = "parse-leaflet-html";
  else if (workingJson.length || jsonBlocks.length) recommendedPath = "inspect-leaflet-json";
  else if (pdf.looksLikePdf) recommendedPath = "parse-pdf-text-or-render-pages";
  else if (workingImages.length) recommendedPath = "image-rendering-or-crops";
  else recommendedPath = "not-enough-data";

  return {
    leaflet,
    summary: {
      recommendedPath,
      dataUrls: allDataUrls.length,
      imageUrls: allImageUrls.length,
      priceExamples: allPrices.length,
      unitPriceExamples: allUnitPrices.length,
      productWords: allWords,
      jsonLikeBlocks: jsonBlocks.length,
      workingImages: workingImages.length,
      workingJson: workingJson.length,
      pdfLooksLikePdf: pdf.looksLikePdf,
      pdfContentType: pdf.contentType,
      pdfContentLength: pdf.contentLength,
    },
    pages,
    pdf,
  };
}

function summarize(results) {
  return {
    checkedAt: new Date().toISOString(),
    leaflets: results.map((result) => ({
      id: result.leaflet.id,
      type: result.leaflet.type,
      title: result.leaflet.title,
      recommendedPath: result.summary.recommendedPath,
      dataUrls: result.summary.dataUrls,
      imageUrls: result.summary.imageUrls,
      priceExamples: result.summary.priceExamples,
      unitPriceExamples: result.summary.unitPriceExamples,
      productWords: result.summary.productWords,
      jsonLikeBlocks: result.summary.jsonLikeBlocks,
      workingImages: result.summary.workingImages,
      workingJson: result.summary.workingJson,
      pdfLooksLikePdf: result.summary.pdfLooksLikePdf,
      pdfContentType: result.summary.pdfContentType,
      pdfContentLength: result.summary.pdfContentLength,
    })),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const results = [];
  for (const leaflet of LEAFLETS) {
    results.push(await inspectLeaflet(leaflet));
  }

  const summary = summarize(results);

  await writeFile(`${OUTPUT_DIR}/albert-leaflet-details.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/leaflet-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Albert leaflet details probe finished.");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/leaflet-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
