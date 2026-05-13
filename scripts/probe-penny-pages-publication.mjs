import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-pages-publication-probe";
const VIEWER_URL = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/";
const PUBLICATION_BASE = `${VIEWER_URL}files/publication/`;
const HTML_ASSETS_BASE = `${VIEWER_URL}files/html/assets/`;

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

async function fetchText(url, accept = "text/html,application/json,text/plain,*/*") {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyPagesProbe/0.1; +https://github.com/)",
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
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyPagesProbe/0.1; +https://github.com/)",
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
      textPreview: preview(text, 1200),
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

  const relativeAssetRegex = /["'`](\.?\/?[^"'`]+?\.(?:js|css|json|pdf|jpg|jpeg|png|webp|svg|xml|txt)(?:\?[^"'`]*)?)["'`]/gi;
  while ((match = relativeAssetRegex.exec(text))) {
    urls.push(absoluteUrl(match[1].trim(), baseUrl));
  }

  return unique(urls);
}

function classifyUrls(urls) {
  return {
    htmls: urls.filter((url) => /\.html?(?:[?#].*)?$/i.test(url) || /\/\d+\/?$/.test(url)),
    scripts: urls.filter((url) => /\.js(?:[?#].*)?$/i.test(url)),
    styles: urls.filter((url) => /\.css(?:[?#].*)?$/i.test(url)),
    jsons: urls.filter((url) => /\.json(?:[?#].*)?$/i.test(url) || /manifest|config|data|workspace|toc|search|text|publication/i.test(url)),
    pdfs: urls.filter((url) => /\.pdf(?:[?#].*)?$/i.test(url)),
    images: urls.filter((url) => /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url)),
    textLike: urls.filter((url) => /\.(?:txt|xml)(?:[?#].*)?$/i.test(url)),
    publicationLike: urls.filter((url) => /publication|pages|page|zoom|thumb|substrate|text|toc|search|workspace|assets/i.test(url)),
  };
}

function extractInitialConfig(html, baseUrl) {
  const snippets = [];

  const patterns = [
    /window\.FBPublication[\s\S]{0,8000}?<\/script>/gi,
    /FBInit\.[A-Z0-9_]+\s*=\s*[^;]+;/gi,
    /BASIC_FIRST_PAGE[\s\S]{0,2000}/gi,
    /PUBLICATION[\s\S]{0,3000}/gi,
    /files\/publication\/[^"'\\\s)<>]+/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) {
      snippets.push(decodeHtml(match[0]).replace(/<\/script>$/i, "").trim());
    }
  }

  const publicationUrls = unique(
    Array.from(html.matchAll(/["'`](\.?\/?files\/publication\/[^"'`]+)["'`]/gi))
      .map((match) => absoluteUrl(match[1], baseUrl))
  );

  return {
    snippets: unique(snippets).slice(0, 80),
    publicationUrls,
  };
}

function buildPageUrls() {
  const urls = [];

  for (let i = 1; i <= 60; i++) {
    urls.push(`${VIEWER_URL}${i}/`);
    urls.push(`${VIEWER_URL}${i}/index.html`);
  }

  return unique(urls);
}

function buildPublicationCandidates() {
  const urls = [];

  const topNames = [
    "publication.json",
    "publication.js",
    "publication.xml",
    "config.json",
    "settings.json",
    "workspace.json",
    "toc.json",
    "book.json",
    "pages.json",
    "search.json",
    "text.json",
    "texts.json",
    "map.json",
    "structure.json",
    "manifest.json",
    "meta.json",
    "index.json",
    "publication.pdf",
    "document.pdf",
    "download.pdf",
  ];

  for (const name of topNames) {
    urls.push(`${PUBLICATION_BASE}${name}`);
    urls.push(`${HTML_ASSETS_BASE}${name}`);
  }

  const pageFolders = [
    "pages",
    "page",
    "large",
    "medium",
    "small",
    "thumbs",
    "thumbnails",
    "zoom",
    "text",
    "texts",
    "html",
    "svg",
    "substrate",
  ];

  const filePatterns = [];
  for (let i = 1; i <= 60; i++) {
    const n = String(i);
    const p2 = String(i).padStart(2, "0");
    const p3 = String(i).padStart(3, "0");
    const p4 = String(i).padStart(4, "0");

    for (const token of [n, p2, p3, p4]) {
      filePatterns.push(`${token}.jpg`, `${token}.jpeg`, `${token}.png`, `${token}.webp`);
      filePatterns.push(`page${token}.jpg`, `page${token}.jpeg`, `page${token}.png`, `page${token}.webp`);
      filePatterns.push(`page-${token}.jpg`, `page-${token}.jpeg`, `page-${token}.png`, `page-${token}.webp`);
      filePatterns.push(`page_${token}.jpg`, `page_${token}.jpeg`, `page_${token}.png`, `page_${token}.webp`);
      filePatterns.push(`${token}.json`, `${token}.xml`, `${token}.txt`, `${token}.svg`);
      filePatterns.push(`page${token}.json`, `page-${token}.json`, `page_${token}.json`);
    }
  }

  for (const folder of pageFolders) {
    for (const file of filePatterns) {
      urls.push(`${PUBLICATION_BASE}${folder}/${file}`);
      urls.push(`${HTML_ASSETS_BASE}${folder}/${file}`);
    }
  }

  return unique(urls);
}

async function inspectPageUrl(url) {
  const page = await fetchText(url);

  const assets = extractAssetUrls(page.text, page.finalUrl);
  const classified = classifyUrls(assets);
  const config = extractInitialConfig(page.text, page.finalUrl);

  return {
    url,
    ok: page.ok,
    status: page.status,
    finalUrl: page.finalUrl,
    contentType: page.contentType,
    contentLength: page.contentLength,
    length: page.length,
    assets: classified,
    initialConfig: config,
    preview: preview(page.text, 2000),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const viewer = await fetchText(VIEWER_URL);
  const viewerAssets = extractAssetUrls(viewer.text, viewer.finalUrl);
  const viewerConfig = extractInitialConfig(viewer.text, viewer.finalUrl);

  const pageUrls = buildPageUrls();
  const pageResults = [];

  for (const url of pageUrls) {
    const result = await inspectPageUrl(url);
    // Uložíme hlavně funkční / zajímavé stránky. 404 nechceme nafukovat.
    if (result.ok || result.length > 2000 || result.status === 200) {
      pageResults.push(result);
    }
  }

  const allAssetCandidates = unique([
    ...viewerAssets,
    ...viewerConfig.publicationUrls,
    ...pageResults.flatMap((page) => [
      ...page.assets.images,
      ...page.assets.jsons,
      ...page.assets.pdfs,
      ...page.assets.textLike,
      ...page.assets.publicationLike,
      ...page.initialConfig.publicationUrls,
    ]),
  ]);

  const classifiedAssets = classifyUrls(allAssetCandidates);

  const publicationCandidates = buildPublicationCandidates();
  const priorityCandidates = unique([
    ...classifiedAssets.jsons,
    ...classifiedAssets.pdfs,
    ...classifiedAssets.images,
    ...classifiedAssets.textLike,
    ...classifiedAssets.publicationLike,
    ...publicationCandidates,
  ]);

  const working = {
    images: [],
    jsons: [],
    pdfs: [],
    textLike: [],
    htmlLike: [],
    other: [],
  };

  const testedSamples = [];

  // Limit vyšší, ale pořád rozumný, aby GitHub Action neběžela nekonečně.
  for (const url of priorityCandidates.slice(0, 900)) {
    const tested = await testUrl(url);

    if (testedSamples.length < 250) {
      testedSamples.push(tested);
    }

    if (!tested.ok) continue;

    if (/image/i.test(tested.contentType)) working.images.push(tested);
    else if (/json/i.test(tested.contentType) || /\.json(?:[?#].*)?$/i.test(tested.url)) working.jsons.push(tested);
    else if (/pdf/i.test(tested.contentType)) working.pdfs.push(tested);
    else if (/text|xml/i.test(tested.contentType)) working.textLike.push(tested);
    else if (/html/i.test(tested.contentType)) working.htmlLike.push(tested);
    else working.other.push(tested);
  }

  const result = {
    checkedAt: new Date().toISOString(),
    viewerUrl: VIEWER_URL,
    viewer: {
      ok: viewer.ok,
      status: viewer.status,
      finalUrl: viewer.finalUrl,
      contentType: viewer.contentType,
      contentLength: viewer.contentLength,
      length: viewer.length,
      assets: classifyUrls(viewerAssets),
      initialConfig: viewerConfig,
      preview: preview(viewer.text, 4000),
    },
    pageResults,
    classifiedAssets,
    priorityCandidates: priorityCandidates.slice(0, 900),
    testedSamples,
    working,
  };

  const summary = {
    checkedAt: result.checkedAt,
    viewerUrl: VIEWER_URL,
    summary: {
      recommendedPath:
        working.jsons.length > 0
          ? "analyze-working-jsons"
          : working.images.length > 0
            ? "image-pages-ocr-or-page-image-import"
            : working.htmlLike.length > 0
              ? "analyze-page-html"
              : "inspect-publication-structure",
      counts: {
        viewerAssets: viewerAssets.length,
        viewerPublicationUrls: viewerConfig.publicationUrls.length,
        pageResults: pageResults.length,
        totalPriorityCandidates: priorityCandidates.length,
        testedSamples: testedSamples.length,
        workingImages: working.images.length,
        workingJsons: working.jsons.length,
        workingPdfs: working.pdfs.length,
        workingTextLike: working.textLike.length,
        workingHtmlLike: working.htmlLike.length,
        workingOther: working.other.length,
      },
      notes: [
        "Tento průzkum testuje jednotlivé URL /1/ až /60/ a kandidáty ve files/publication/.",
        "Pokud workingImages > 0, máme konkrétní obrázky stránek letáku.",
        "Pokud workingJsons > 0, nejdřív analyzovat JSON před OCR.",
        "Pokud workingHtmlLike > 0, stránky /2/ až /37/ mohou obsahovat data nebo další asset odkazy.",
      ],
    },
    viewer: {
      ok: result.viewer.ok,
      status: result.viewer.status,
      finalUrl: result.viewer.finalUrl,
      contentType: result.viewer.contentType,
      length: result.viewer.length,
      firstPublicationUrls: result.viewer.initialConfig.publicationUrls.slice(0, 80),
      firstConfigSnippets: result.viewer.initialConfig.snippets.slice(0, 30),
    },
    pages: pageResults.map((page) => ({
      url: page.url,
      ok: page.ok,
      status: page.status,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      contentLength: page.contentLength,
      length: page.length,
      imagesCount: page.assets.images.length,
      jsonsCount: page.assets.jsons.length,
      pdfsCount: page.assets.pdfs.length,
      textLikeCount: page.assets.textLike.length,
      publicationLikeCount: page.assets.publicationLike.length,
      firstImages: page.assets.images.slice(0, 20),
      firstJsons: page.assets.jsons.slice(0, 20),
      firstPdfs: page.assets.pdfs.slice(0, 20),
      firstPublicationLike: page.assets.publicationLike.slice(0, 20),
      firstPublicationUrls: page.initialConfig.publicationUrls.slice(0, 20),
    })).slice(0, 80),
    working: {
      images: working.images.slice(0, 120),
      jsons: working.jsons.slice(0, 80),
      pdfs: working.pdfs.slice(0, 50),
      textLike: working.textLike.slice(0, 80),
      htmlLike: working.htmlLike.slice(0, 80),
      other: working.other.slice(0, 50),
    },
    testedSamples: testedSamples.slice(0, 120),
  };

  await writeFile(`${OUTPUT_DIR}/penny-pages-publication-probe.json`, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny pages/publication probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
