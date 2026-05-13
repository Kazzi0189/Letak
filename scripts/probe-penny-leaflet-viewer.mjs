import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-leaflet-probe";

const SOURCES = {
  offersPage: "https://www.penny.cz/nabidky",
  leafletsPage: "https://www.penny.cz/nabidky/letaky",
  knownViewerCandidate: "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me",
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

function textLines(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
  )
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function fetchText(url, accept = "text/html,application/xhtml+xml,application/json,text/plain,*/*") {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyLeafletProbe/0.1; +https://github.com/)",
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
    length: text.length,
    text,
  };
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html))) {
    links.push({
      href: absoluteUrl(match[1].trim(), baseUrl),
      text: decodeHtml(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
    });
  }

  return links;
}

function extractAssetUrls(html, baseUrl) {
  const urls = [];

  const attrRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;

  while ((match = attrRegex.exec(html))) {
    urls.push(absoluteUrl(match[1].trim(), baseUrl));
  }

  const stringUrlRegex = /["'](https?:\/\/[^"']+)["']/gi;
  while ((match = stringUrlRegex.exec(html))) {
    urls.push(match[1].trim());
  }

  const relativeUrlRegex = /["']([^"']+\.(?:json|js|pdf|jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/gi;
  while ((match = relativeUrlRegex.exec(html))) {
    urls.push(absoluteUrl(match[1].trim(), baseUrl));
  }

  return unique(urls);
}

function classifyAssets(urls) {
  return {
    pdfs: urls.filter((url) => /\.pdf(?:[?#].*)?$/i.test(url)),
    images: urls.filter((url) => /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url)),
    jsons: urls.filter((url) => /\.json(?:[?#].*)?$/i.test(url) || /\/api\/|\.api|manifest|data/i.test(url)),
    scripts: urls.filter((url) => /\.js(?:[?#].*)?$/i.test(url)),
    leafletLike: urls.filter((url) =>
      /leaflet|letak|leták|pennyintleaflet|page-|page_|catalog|brochure|prospekt|rewe/i.test(url)
    ),
  };
}

function extractEndpointHints(html, baseUrl) {
  const hints = Array.from(
    html.matchAll(/["']([^"']*(?:api|graphql|product|products|offers|leaflet|letak|leták|catalog|brochure|pages|page|pennyintleaflet|rewe)[^"']*)["']/gi)
  )
    .map((match) => match[1])
    .filter((value) => value.length < 400)
    .map((value) => (value.startsWith("/") ? absoluteUrl(value, baseUrl) : value));

  return unique(hints).slice(0, 200);
}

function findViewerLinks(links, assets) {
  const fromLinks = links.filter((item) => {
    const haystack = `${item.href} ${item.text}`.toLowerCase();
    return (
      haystack.includes("letak") ||
      haystack.includes("leták") ||
      haystack.includes("leaflet") ||
      haystack.includes("pennyintleaflet") ||
      haystack.includes("prohlédnout") ||
      haystack.includes("prolistovat") ||
      haystack.includes("catalog") ||
      haystack.includes("brochure")
    );
  });

  const fromAssets = assets
    .filter((url) => /pennyintleaflet|leaflet|letak|leták|catalog|brochure/i.test(url))
    .map((url) => ({ href: url, text: "" }));

  return unique([...fromLinks, ...fromAssets].map((item) => JSON.stringify(item)))
    .map((value) => JSON.parse(value))
    .slice(0, 100);
}

function findProductLikeLines(lines) {
  return lines.filter((line) => {
    const hasPrice = /\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč/i.test(line);
    const hasUnit = /\b(kg|g|l|ml|ks)\b/i.test(line);
    return hasPrice || (hasUnit && line.length > 6 && line.length < 140);
  }).slice(0, 100);
}

async function inspectPage(name, url) {
  const result = {
    name,
    url,
    ok: false,
    status: null,
    finalUrl: null,
    contentType: "",
    length: 0,
    links: [],
    viewerLinks: [],
    assets: {
      pdfs: [],
      images: [],
      jsons: [],
      scripts: [],
      leafletLike: [],
    },
    endpointHints: [],
    productLikeLines: [],
    sampleTextLines: [],
    preview: "",
    error: null,
  };

  try {
    const response = await fetchText(url);
    result.ok = response.ok;
    result.status = response.status;
    result.finalUrl = response.finalUrl;
    result.contentType = response.contentType;
    result.length = response.length;
    result.preview = preview(response.text, 3000);

    const links = extractLinks(response.text, response.finalUrl);
    const assetUrls = extractAssetUrls(response.text, response.finalUrl);
    const lines = textLines(response.text);

    result.links = links.slice(0, 120);
    result.viewerLinks = findViewerLinks(links, assetUrls);
    result.assets = classifyAssets(assetUrls);
    result.endpointHints = extractEndpointHints(response.text, response.finalUrl);
    result.productLikeLines = findProductLikeLines(lines);
    result.sampleTextLines = lines.slice(0, 150);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

function buildPageCandidateUrls(baseViewerUrl) {
  const urls = [];

  for (let i = 1; i <= 40; i++) {
    const padded = String(i).padStart(4, "0");
    const page = String(i);

    urls.push(`${baseViewerUrl}/page-${padded}.jpeg`);
    urls.push(`${baseViewerUrl}/page-${padded}.jpg`);
    urls.push(`${baseViewerUrl}/page-${padded}.png`);
    urls.push(`${baseViewerUrl}/leaflet_page-${padded}.jpeg`);
    urls.push(`${baseViewerUrl}/20KW_ONE_13_05_2026_WEB_leaflet_page-${padded}.jpeg`);
    urls.push(`${baseViewerUrl}/files/page-${padded}.jpeg`);
    urls.push(`${baseViewerUrl}/pages/${page}.jpg`);
    urls.push(`${baseViewerUrl}/pages/${page}.jpeg`);
  }

  return unique(urls);
}

function buildDataCandidateUrls(baseViewerUrl) {
  return unique([
    `${baseViewerUrl}/manifest.json`,
    `${baseViewerUrl}/data.json`,
    `${baseViewerUrl}/index.json`,
    `${baseViewerUrl}/leaflet.json`,
    `${baseViewerUrl}/pages.json`,
    `${baseViewerUrl}/meta.json`,
    `${baseViewerUrl}/offers.json`,
    `${baseViewerUrl}/products.json`,
    `${baseViewerUrl}/page-data.json`,
    `${baseViewerUrl}/assets/manifest.json`,
    `${baseViewerUrl}/assets/data.json`,
  ]);
}

async function headOrSmallGet(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyLeafletProbe/0.1; +https://github.com/)",
        accept: "application/json,image/*,application/pdf,text/plain,*/*",
        "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
        range: "bytes=0-2048",
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = response.headers.get("content-length") ?? "";
    const text = /json|text|html/i.test(contentType) ? await response.text() : "";

    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType,
      contentLength,
      textPreview: text.slice(0, 1500),
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

async function inspectViewerCandidate(viewerUrl) {
  const page = await inspectPage("knownViewerCandidate", viewerUrl);

  const dataCandidates = buildDataCandidateUrls(viewerUrl);
  const dataTests = [];
  for (const url of dataCandidates) {
    dataTests.push(await headOrSmallGet(url));
  }

  const imageCandidates = buildPageCandidateUrls(viewerUrl);
  const imageTests = [];
  for (const url of imageCandidates.slice(0, 120)) {
    const tested = await headOrSmallGet(url);
    if (tested.ok || /image/i.test(tested.contentType)) {
      imageTests.push(tested);
    }
  }

  return {
    viewerUrl,
    page,
    dataCandidatesTested: dataTests,
    workingDataCandidates: dataTests.filter((item) => item.ok && /json|text|html/i.test(item.contentType)),
    workingImageCandidates: imageTests,
  };
}

function summarize(result) {
  const pages = result.pages;
  const allViewerLinks = pages.flatMap((page) => page.viewerLinks ?? []);
  const allPdfs = pages.flatMap((page) => page.assets?.pdfs ?? []);
  const allImages = pages.flatMap((page) => page.assets?.images ?? []);
  const allJsons = pages.flatMap((page) => page.assets?.jsons ?? []);
  const allEndpointHints = pages.flatMap((page) => page.endpointHints ?? []);

  const viewerWorkingImages = result.viewerProbe?.workingImageCandidates ?? [];
  const viewerWorkingData = result.viewerProbe?.workingDataCandidates ?? [];

  const notes = [];

  if (viewerWorkingData.length > 0 || allJsons.length > 0 || allEndpointHints.length > 0) {
    notes.push("Existují náznaky JSON/datových zdrojů. Priorita: analyzovat workingDataCandidates/jsons/endpointHints.");
  }

  if (allPdfs.length > 0) {
    notes.push("Nalezen PDF odkaz. Priorita: ověřit, zda PDF obsahuje text, nebo jen obrázky.");
  }

  if (viewerWorkingImages.length > 0 || allImages.length > 0) {
    notes.push("Nalezeny obrázky stránek letáku. Pokud nejsou datové zdroje, bude potřeba OCR nebo jiná extrakce.");
  }

  if (allViewerLinks.length > 0) {
    notes.push("Nalezeny viewer odkazy. Priorita: otevřít konkrétní viewer a najít manifest/data/obrázky.");
  }

  let recommendedPath = "unknown";
  if (viewerWorkingData.length > 0 || allJsons.length > 0) recommendedPath = "structured-data-first";
  else if (allPdfs.length > 0) recommendedPath = "pdf-first";
  else if (viewerWorkingImages.length > 0 || allImages.length > 0) recommendedPath = "image-viewer-ocr";
  else if (allViewerLinks.length > 0) recommendedPath = "viewer-deeper-probe";
  else recommendedPath = "manual-investigation-needed";

  return {
    recommendedPath,
    counts: {
      viewerLinks: allViewerLinks.length,
      pdfs: allPdfs.length,
      images: allImages.length,
      jsons: allJsons.length,
      endpointHints: allEndpointHints.length,
      viewerWorkingData: viewerWorkingData.length,
      viewerWorkingImages: viewerWorkingImages.length,
    },
    notes,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pages = [
    await inspectPage("offersPage", SOURCES.offersPage),
    await inspectPage("leafletsPage", SOURCES.leafletsPage),
  ];

  const viewerCandidates = unique([
    SOURCES.knownViewerCandidate,
    ...pages.flatMap((page) => (page.viewerLinks ?? []).map((item) => item.href)),
  ]).filter((url) => /pennyintleaflet|files\.rewe|leaflet|letak|leták/i.test(url));

  const viewerProbe = await inspectViewerCandidate(viewerCandidates[0] ?? SOURCES.knownViewerCandidate);

  const result = {
    checkedAt: new Date().toISOString(),
    sources: SOURCES,
    viewerCandidates,
    pages,
    viewerProbe,
  };

  const summary = {
    checkedAt: result.checkedAt,
    sources: SOURCES,
    viewerCandidates,
    summary: summarize(result),
    pages: pages.map((page) => ({
      name: page.name,
      ok: page.ok,
      status: page.status,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      length: page.length,
      viewerLinksCount: page.viewerLinks.length,
      pdfsCount: page.assets.pdfs.length,
      imagesCount: page.assets.images.length,
      jsonsCount: page.assets.jsons.length,
      endpointHintsCount: page.endpointHints.length,
      productLikeLinesCount: page.productLikeLines.length,
      firstViewerLinks: page.viewerLinks.slice(0, 20),
      firstPdfs: page.assets.pdfs.slice(0, 20),
      firstImages: page.assets.images.slice(0, 20),
      firstJsons: page.assets.jsons.slice(0, 20),
      firstEndpointHints: page.endpointHints.slice(0, 30),
      firstProductLikeLines: page.productLikeLines.slice(0, 30),
    })),
    viewerProbe: {
      viewerUrl: viewerProbe.viewerUrl,
      pageOk: viewerProbe.page.ok,
      pageStatus: viewerProbe.page.status,
      pageContentType: viewerProbe.page.contentType,
      pageLength: viewerProbe.page.length,
      workingDataCandidates: viewerProbe.workingDataCandidates,
      workingImageCandidates: viewerProbe.workingImageCandidates.slice(0, 40),
      dataCandidatesTestedCount: viewerProbe.dataCandidatesTested.length,
      workingDataCandidatesCount: viewerProbe.workingDataCandidates.length,
      workingImageCandidatesCount: viewerProbe.workingImageCandidates.length,
    },
  };

  await writeFile(`${OUTPUT_DIR}/penny-leaflet-probe.json`, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny leaflet probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
