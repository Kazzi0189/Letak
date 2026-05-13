import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-page-text-image-probe";

const SOURCES = {
  offersPage: "https://www.penny.cz/nabidky",
  leafletsPage: "https://www.penny.cz/nabidky/letaky",
  viewerUrl: "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/",
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

function cleanText(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function textLines(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|span|a)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractAttrs(html, attrName, baseUrl) {
  const urls = [];
  const regex = new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, "gi");
  let match;

  while ((match = regex.exec(html))) {
    urls.push(absoluteUrl(match[1], baseUrl));
  }

  return urls;
}

function extractUrlsFromText(text, baseUrl) {
  const decoded = decodeHtml(text);
  const urls = [];

  const httpRegex = /https?:\/\/[^"'\\\s)<>]+/gi;
  let match;
  while ((match = httpRegex.exec(decoded))) {
    urls.push(match[0].replace(/[;,]+$/, ""));
  }

  const encodedUrlRegex = /https?:\\?\/\\?\/[^"'\\\s)<>]+/gi;
  while ((match = encodedUrlRegex.exec(text))) {
    urls.push(decodeHtml(match[0]).replace(/\\/g, "").replace(/[;,]+$/, ""));
  }

  const relativeAssetRegex = /["'`](\.?\/?[^"'`]+?\.(?:jpg|jpeg|png|webp|json|pdf|html)(?:\?[^"'`]*)?)["'`]/gi;
  while ((match = relativeAssetRegex.exec(decoded))) {
    urls.push(absoluteUrl(match[1], baseUrl));
  }

  return unique(urls);
}

function getProductLikeLines(lines) {
  return lines.filter((line) => {
    const hasPrice = /\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč/i.test(line);
    const hasUnit = /\b(?:kg|g|l|ml|ks|m)\b/i.test(line);
    const looksProduct = line.length >= 4 && line.length <= 160 && /[A-Za-zÁ-ž]/.test(line);

    return hasPrice || (looksProduct && hasUnit);
  });
}

async function fetchText(url, accept = "text/html,application/json,text/plain,*/*") {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyTextImageProbe/0.1; +https://github.com/)",
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
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyTextImageProbe/0.1; +https://github.com/)",
        accept: "image/*,application/json,text/html,text/plain,*/*",
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
      textPreview: text.slice(0, 800),
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

function extractKcLeafletImages(html, baseUrl) {
  const urls = [
    ...extractAttrs(html, "src", baseUrl),
    ...extractAttrs(html, "href", baseUrl),
    ...extractUrlsFromText(html, baseUrl),
  ];

  return unique(
    urls
      .map((url) => decodeHtml(url))
      .filter((url) =>
        /assets-eu-01\.kc-usercontent\.com|kc-usercontent\.com/i.test(url) &&
        /leaflet|letak|page|20KW|ONE|WEB/i.test(url) &&
        /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url.split("?")[0])
      )
  );
}

function generatePageImageCandidates(seedUrls) {
  const candidates = [];

  for (const seed of seedUrls) {
    const decoded = decodeHtml(seed);
    const [baseNoQuery, query = ""] = decoded.split("?");

    const patterns = [
      /(leaflet[_-]page[_-]?)(\d{4})(\.(?:jpg|jpeg|png|webp))$/i,
      /(page[_-]?)(\d{4})(\.(?:jpg|jpeg|png|webp))$/i,
      /(page[_-]?)(\d{1,2})(\.(?:jpg|jpeg|png|webp))$/i,
    ];

    for (const pattern of patterns) {
      const match = baseNoQuery.match(pattern);
      if (!match) continue;

      const prefix = match[1];
      const originalDigits = match[2];
      const ext = match[3];
      const width = originalDigits.length;
      const before = baseNoQuery.slice(0, match.index);
      const suffixQuery = query ? `?${query}` : "";

      for (let i = 1; i <= 60; i++) {
        const page = String(i).padStart(width, "0");
        candidates.push(`${before}${prefix}${page}${ext}${suffixQuery}`);
        candidates.push(`${before}${prefix}${page}${ext}`);
      }
    }
  }

  return unique(candidates);
}

async function inspectViewerPages() {
  const results = [];

  for (let i = 1; i <= 60; i++) {
    const urls = [
      `${SOURCES.viewerUrl}${i}/`,
      `${SOURCES.viewerUrl}${i}/index.html`,
    ];

    for (const url of urls) {
      const page = await fetchText(url);
      if (!page.ok && page.status !== 200) continue;

      const lines = textLines(page.text);
      const productLikeLines = getProductLikeLines(lines);
      const attrs = [
        ...extractAttrs(page.text, "src", page.finalUrl),
        ...extractAttrs(page.text, "href", page.finalUrl),
      ];

      results.push({
        pageNumber: i,
        url,
        ok: page.ok,
        status: page.status,
        finalUrl: page.finalUrl,
        contentType: page.contentType,
        length: page.length,
        title:
          cleanText(page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") ||
          cleanText(page.text.match(/title\s*=\s*["']([^"']+)["']/i)?.[1] ?? ""),
        linesCount: lines.length,
        firstLines: lines.slice(0, 80),
        productLikeLines,
        attrs: unique(attrs).slice(0, 80),
        kcLeafletImages: extractKcLeafletImages(page.text, page.finalUrl),
      });
    }
  }

  return results;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const offersPage = await fetchText(SOURCES.offersPage);
  const leafletsPage = await fetchText(SOURCES.leafletsPage);

  const sourceKcImages = unique([
    ...extractKcLeafletImages(offersPage.text, offersPage.finalUrl),
    ...extractKcLeafletImages(leafletsPage.text, leafletsPage.finalUrl),
  ]);

  const generatedImageCandidates = generatePageImageCandidates(sourceKcImages);

  const testedImages = [];
  for (const url of generatedImageCandidates.slice(0, 180)) {
    const tested = await testUrl(url);
    if (tested.ok && /image/i.test(tested.contentType)) {
      testedImages.push(tested);
    }
  }

  const viewerPages = await inspectViewerPages();

  const viewerProductLikeLines = viewerPages.flatMap((page) =>
    page.productLikeLines.map((line) => ({
      pageNumber: page.pageNumber,
      sourceUrl: page.finalUrl,
      line,
    }))
  );

  const viewerKcImages = unique(viewerPages.flatMap((page) => page.kcLeafletImages));
  const allKcImages = unique([...sourceKcImages, ...viewerKcImages]);

  const result = {
    checkedAt: new Date().toISOString(),
    sources: SOURCES,
    sourcePages: {
      offersPage: {
        ok: offersPage.ok,
        status: offersPage.status,
        finalUrl: offersPage.finalUrl,
        contentType: offersPage.contentType,
        length: offersPage.length,
        kcLeafletImages: extractKcLeafletImages(offersPage.text, offersPage.finalUrl),
        productLikeLines: getProductLikeLines(textLines(offersPage.text)).slice(0, 200),
      },
      leafletsPage: {
        ok: leafletsPage.ok,
        status: leafletsPage.status,
        finalUrl: leafletsPage.finalUrl,
        contentType: leafletsPage.contentType,
        length: leafletsPage.length,
        kcLeafletImages: extractKcLeafletImages(leafletsPage.text, leafletsPage.finalUrl),
        productLikeLines: getProductLikeLines(textLines(leafletsPage.text)).slice(0, 200),
      },
    },
    sourceKcImages,
    allKcImages,
    generatedImageCandidates: generatedImageCandidates.slice(0, 180),
    workingPageImages: testedImages,
    viewerPages,
    viewerProductLikeLines,
  };

  const summary = {
    checkedAt: result.checkedAt,
    summary: {
      recommendedPath:
        testedImages.length > 5
          ? "use-kc-page-images"
          : viewerProductLikeLines.length > 20
            ? "parse-viewer-page-html-text"
            : allKcImages.length > 0
              ? "refine-kc-image-pattern"
              : "fallback-current-penny-html-grid",
      counts: {
        sourceKcImages: sourceKcImages.length,
        allKcImages: allKcImages.length,
        generatedImageCandidates: generatedImageCandidates.length,
        workingPageImages: testedImages.length,
        viewerPages: viewerPages.length,
        viewerProductLikeLines: viewerProductLikeLines.length,
        offersPageProductLikeLines: result.sourcePages.offersPage.productLikeLines.length,
        leafletsPageProductLikeLines: result.sourcePages.leafletsPage.productLikeLines.length,
      },
      notes: [
        "Pokud workingPageImages obsahuje mnoho položek, máme skutečné obrázky stránek letáku z kc-usercontent.",
        "Pokud viewerProductLikeLines obsahuje produktové řádky, můžeme zkusit parser bez OCR.",
        "Pokud workingPageImages jsou jen page-0001, musí se upravit generování názvů stránek.",
      ],
    },
    sourceKcImages: sourceKcImages.slice(0, 80),
    workingPageImages: testedImages.slice(0, 80),
    viewerPages: viewerPages.map((page) => ({
      pageNumber: page.pageNumber,
      finalUrl: page.finalUrl,
      status: page.status,
      length: page.length,
      title: page.title,
      linesCount: page.linesCount,
      productLikeLinesCount: page.productLikeLines.length,
      firstProductLikeLines: page.productLikeLines.slice(0, 30),
      firstLines: page.firstLines.slice(0, 30),
      kcLeafletImages: page.kcLeafletImages,
    })),
    viewerProductLikeLines: viewerProductLikeLines.slice(0, 300),
    offersPageProductLikeLines: result.sourcePages.offersPage.productLikeLines.slice(0, 120),
    leafletsPageProductLikeLines: result.sourcePages.leafletsPage.productLikeLines.slice(0, 120),
  };

  await writeFile(`${OUTPUT_DIR}/penny-page-text-image-probe.json`, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny page text/image probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
