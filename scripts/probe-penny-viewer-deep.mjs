import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-viewer-deep-probe";

const VIEWER_URL = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";

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

function preview(text, max = 2000) {
  return text.slice(0, max);
}

async function fetchText(url, accept = "text/html,application/javascript,application/json,text/plain,*/*") {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyViewerDeepProbe/0.1; +https://github.com/)",
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
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyViewerDeepProbe/0.1; +https://github.com/)",
        accept: "application/json,image/*,application/pdf,text/html,text/plain,*/*",
        "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
        range: "bytes=0-4096",
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = response.headers.get("content-length") ?? "";
    const text = /json|text|html|javascript|xml/i.test(contentType) ? await response.text() : "";

    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType,
      contentLength,
      textPreview: preview(text, 1500),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      finalUrl: null,
      contentType: "",
      contentLength: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractAssetUrls(text, baseUrl) {
  const urls = [];

  const attrRegex = /(?:src|href|data-src|data-href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRegex.exec(text))) {
    urls.push(absoluteUrl(match[1].trim(), baseUrl));
  }

  const httpRegex = /https?:\/\/[^"'\\\s)<>]+/gi;
  while ((match = httpRegex.exec(text))) {
    urls.push(decodeHtml(match[0]).replace(/[;,]+$/, ""));
  }

  const relativeAssetRegex = /["'`](\.?\/?[^"'`]+?\.(?:js|css|json|pdf|jpg|jpeg|png|webp|svg|xml)(?:\?[^"'`]*)?)["'`]/gi;
  while ((match = relativeAssetRegex.exec(text))) {
    urls.push(absoluteUrl(match[1].trim(), baseUrl));
  }

  return unique(urls);
}

function classifyUrls(urls) {
  return {
    scripts: urls.filter((url) => /\.js(?:[?#].*)?$/i.test(url)),
    styles: urls.filter((url) => /\.css(?:[?#].*)?$/i.test(url)),
    jsons: urls.filter((url) => /\.json(?:[?#].*)?$/i.test(url) || /manifest|config|data|api/i.test(url)),
    pdfs: urls.filter((url) => /\.pdf(?:[?#].*)?$/i.test(url)),
    images: urls.filter((url) => /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url)),
    leafletLike: urls.filter((url) => /leaflet|letak|brochure|catalog|page|pages|tiles|thumb|penny|rewe/i.test(url)),
  };
}

function extractStringHints(text, baseUrl) {
  const hints = [];

  const patterns = [
    /["'`]([^"'`]*(?:manifest|config|data|pages|page|tiles|tile|json|pdf|jpg|jpeg|png|webp|leaflet|brochure|catalog|products|offers)[^"'`]*)["'`]/gi,
    /(?:url|src|href|path|file|image|pdf|manifest|config)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi,
    /(?:page|pages|images|tiles|manifest|config|brochure|leaflet)[A-Za-z0-9_$]*\s*[:=]\s*(\[[\s\S]{0,2000}?\]|\{[\s\S]{0,2000}?\})/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const raw = match[1]?.trim();
      if (!raw || raw.length > 1000) continue;

      if (/^https?:\/\//i.test(raw) || raw.startsWith("/") || raw.startsWith("./") || raw.includes(".")) {
        hints.push(absoluteUrl(raw, baseUrl));
      } else {
        hints.push(raw);
      }
    }
  }

  return unique(hints).slice(0, 500);
}

function findPageImageUrlsFromText(text, baseUrl) {
  const urls = [];
  const decoded = decodeHtml(text);

  const imageRegex = /(?:https?:\/\/[^"'\\\s)<>]+|\.?\/?[^"'`\s)<>]+)(?:page|strana|leaflet|brochure|catalog|20KW|ONE)[^"'`\s)<>]*\.(?:jpg|jpeg|png|webp)(?:\?[^"'`\s)<>]*)?/gi;
  let match;

  while ((match = imageRegex.exec(decoded))) {
    urls.push(absoluteUrl(match[0], baseUrl).replace(/[;,]+$/, ""));
  }

  const specificRegex = /[^"'`\s)<>]*20KW[^"'`\s)<>]*\.(?:jpg|jpeg|png|webp)(?:\?[^"'`\s)<>]*)?/gi;
  while ((match = specificRegex.exec(decoded))) {
    urls.push(absoluteUrl(match[0], baseUrl).replace(/[;,]+$/, ""));
  }

  return unique(urls);
}

function buildNearbyCandidates(foundImages) {
  const candidates = [];

  for (const imageUrl of foundImages) {
    const clean = imageUrl.split("?")[0];

    const pageNumberMatch = clean.match(/(page[-_]?)(\d{4}|\d{1,2})(\.(?:jpg|jpeg|png|webp))$/i);
    if (!pageNumberMatch) continue;

    const prefix = pageNumberMatch[1];
    const digits = pageNumberMatch[2];
    const ext = pageNumberMatch[3];
    const width = digits.length;
    const base = clean.slice(0, clean.length - `${prefix}${digits}${ext}`.length);

    for (let i = 1; i <= 60; i++) {
      const page = String(i).padStart(width, "0");
      candidates.push(`${base}${prefix}${page}${ext}`);
    }
  }

  return unique(candidates);
}

async function inspectViewer() {
  const htmlResponse = await fetchText(VIEWER_URL);
  const htmlAssets = extractAssetUrls(htmlResponse.text, htmlResponse.finalUrl);
  const htmlClassified = classifyUrls(htmlAssets);
  const htmlHints = extractStringHints(htmlResponse.text, htmlResponse.finalUrl);
  const htmlPageImages = findPageImageUrlsFromText(htmlResponse.text, htmlResponse.finalUrl);

  const scriptUrls = unique([
    ...htmlClassified.scripts,
    ...htmlHints.filter((hint) => /\.js(?:[?#].*)?$/i.test(hint)),
  ]).slice(0, 80);

  const scriptResults = [];

  for (const scriptUrl of scriptUrls) {
    const script = await fetchText(scriptUrl, "application/javascript,text/javascript,text/plain,*/*");
    const assets = extractAssetUrls(script.text, script.finalUrl);
    const hints = extractStringHints(script.text, script.finalUrl);
    const pageImages = findPageImageUrlsFromText(script.text, script.finalUrl);

    scriptResults.push({
      url: scriptUrl,
      ok: script.ok,
      status: script.status,
      finalUrl: script.finalUrl,
      contentType: script.contentType,
      length: script.length,
      assets: classifyUrls(assets),
      hints: hints.slice(0, 120),
      pageImages: pageImages.slice(0, 120),
      interestingTextPreview: preview(
        script.text
          .split(/\n/)
          .filter((line) => /manifest|config|data|pages|page|image|tile|pdf|leaflet|brochure|catalog|json/i.test(line))
          .slice(0, 80)
          .join("\n"),
        6000
      ),
    });
  }

  const allFoundImages = unique([
    ...htmlPageImages,
    ...htmlClassified.images,
    ...scriptResults.flatMap((item) => item.pageImages),
    ...scriptResults.flatMap((item) => item.assets.images),
  ]).filter((url) => /leaflet|page|20KW|ONE|brochure|catalog|PennyIntLeaflet/i.test(url));

  const nearbyCandidates = buildNearbyCandidates(allFoundImages);

  const imageTests = [];
  for (const url of nearbyCandidates.slice(0, 120)) {
    const tested = await testUrl(url);
    if (tested.ok && /image/i.test(tested.contentType)) {
      imageTests.push(tested);
    }
  }

  const jsonCandidates = unique([
    ...htmlClassified.jsons,
    ...htmlHints.filter((hint) => /\.json(?:[?#].*)?$/i.test(hint) || /manifest|config|data|api/i.test(hint)),
    ...scriptResults.flatMap((item) => item.assets.jsons),
    ...scriptResults.flatMap((item) => item.hints.filter((hint) => /\.json(?:[?#].*)?$/i.test(hint) || /manifest|config|data|api/i.test(hint))),
  ])
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 120);

  const jsonTests = [];
  for (const url of jsonCandidates) {
    const tested = await testUrl(url);
    if (tested.ok && /json|text|html|javascript/i.test(tested.contentType)) {
      jsonTests.push(tested);
    }
  }

  const pdfCandidates = unique([
    ...htmlClassified.pdfs,
    ...htmlHints.filter((hint) => /\.pdf(?:[?#].*)?$/i.test(hint)),
    ...scriptResults.flatMap((item) => item.assets.pdfs),
    ...scriptResults.flatMap((item) => item.hints.filter((hint) => /\.pdf(?:[?#].*)?$/i.test(hint))),
  ])
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 80);

  const pdfTests = [];
  for (const url of pdfCandidates) {
    const tested = await testUrl(url);
    if (tested.ok && /pdf/i.test(tested.contentType)) {
      pdfTests.push(tested);
    }
  }

  return {
    viewer: {
      url: VIEWER_URL,
      ok: htmlResponse.ok,
      status: htmlResponse.status,
      finalUrl: htmlResponse.finalUrl,
      contentType: htmlResponse.contentType,
      length: htmlResponse.length,
      preview: preview(htmlResponse.text, 5000),
      assets: htmlClassified,
      hints: htmlHints.slice(0, 300),
      pageImages: htmlPageImages.slice(0, 120),
    },
    scripts: scriptResults,
    foundImages: allFoundImages.slice(0, 300),
    nearbyImageCandidates: nearbyCandidates.slice(0, 300),
    workingImages: imageTests,
    jsonCandidates,
    workingJsons: jsonTests,
    pdfCandidates,
    workingPdfs: pdfTests,
  };
}

function summarize(result) {
  const notes = [];

  if (result.workingJsons.length > 0) {
    notes.push("Nalezen funkční JSON/textový kandidát. Další krok: analyzovat workingJsons.");
  }

  if (result.workingPdfs.length > 0) {
    notes.push("Nalezen funkční PDF kandidát. Další krok: ověřit textovou vrstvu PDF.");
  }

  if (result.workingImages.length > 0) {
    notes.push("Nalezeny funkční obrázky stránek. Pokud nebude datový zdroj, bude další krok OCR/vision extrakce.");
  }

  if (result.scripts.length > 0) {
    notes.push("Viewer používá JS assety. V jejich hints/interestingTextPreview mohou být názvy manifestů nebo patterny stránek.");
  }

  let recommendedPath = "manual-investigation-needed";
  if (result.workingJsons.length > 0) recommendedPath = "analyze-json";
  else if (result.workingPdfs.length > 0) recommendedPath = "analyze-pdf";
  else if (result.workingImages.length > 0) recommendedPath = "image-pages-ocr";
  else if (result.foundImages.length > 0) recommendedPath = "test-found-image-patterns";
  else recommendedPath = "inspect-js-manually";

  return {
    recommendedPath,
    counts: {
      scripts: result.scripts.length,
      viewerImages: result.viewer.assets.images.length,
      viewerJsons: result.viewer.assets.jsons.length,
      viewerPdfs: result.viewer.assets.pdfs.length,
      foundImages: result.foundImages.length,
      nearbyImageCandidates: result.nearbyImageCandidates.length,
      workingImages: result.workingImages.length,
      jsonCandidates: result.jsonCandidates.length,
      workingJsons: result.workingJsons.length,
      pdfCandidates: result.pdfCandidates.length,
      workingPdfs: result.workingPdfs.length,
    },
    notes,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const result = await inspectViewer();
  const summary = {
    checkedAt: new Date().toISOString(),
    viewerUrl: VIEWER_URL,
    summary: summarize(result),
    viewer: {
      ok: result.viewer.ok,
      status: result.viewer.status,
      finalUrl: result.viewer.finalUrl,
      contentType: result.viewer.contentType,
      length: result.viewer.length,
      scriptsCount: result.viewer.assets.scripts.length,
      firstScripts: result.viewer.assets.scripts.slice(0, 40),
      imagesCount: result.viewer.assets.images.length,
      firstImages: result.viewer.assets.images.slice(0, 40),
      jsonsCount: result.viewer.assets.jsons.length,
      firstJsons: result.viewer.assets.jsons.slice(0, 40),
      pdfsCount: result.viewer.assets.pdfs.length,
      firstPdfs: result.viewer.assets.pdfs.slice(0, 40),
      firstHints: result.viewer.hints.slice(0, 80),
      firstPageImages: result.viewer.pageImages.slice(0, 80),
    },
    scripts: result.scripts.map((script) => ({
      url: script.url,
      ok: script.ok,
      status: script.status,
      finalUrl: script.finalUrl,
      contentType: script.contentType,
      length: script.length,
      imagesCount: script.assets.images.length,
      jsonsCount: script.assets.jsons.length,
      pdfsCount: script.assets.pdfs.length,
      pageImagesCount: script.pageImages.length,
      firstImages: script.assets.images.slice(0, 20),
      firstJsons: script.assets.jsons.slice(0, 20),
      firstPdfs: script.assets.pdfs.slice(0, 20),
      firstPageImages: script.pageImages.slice(0, 20),
      hints: script.hints.slice(0, 50),
    })),
    workingImages: result.workingImages.slice(0, 80),
    workingJsons: result.workingJsons.slice(0, 80),
    workingPdfs: result.workingPdfs.slice(0, 80),
    foundImages: result.foundImages.slice(0, 120),
    nearbyImageCandidates: result.nearbyImageCandidates.slice(0, 120),
  };

  await writeFile(`${OUTPUT_DIR}/penny-viewer-deep-probe.json`, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny viewer deep probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
