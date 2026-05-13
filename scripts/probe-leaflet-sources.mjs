import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/source-probe";

const SOURCES = [
  {
    chain: "Penny",
    url: "https://www.penny.cz/nabidky/letaky",
    dependsOnStore: "unknown",
    note: "Ověřujeme celou sekci letáků, ne jen /nabidky akční položky.",
  },
  {
    chain: "Kaufland",
    url: "https://prodejny.kaufland.cz/letak.html",
    dependsOnStore: "yes",
    note: "Kaufland typicky pracuje s konkrétní prodejnou/lokalitou.",
  },
  {
    chain: "Albert",
    url: "https://www.albert.cz/aktualni-letaky",
    dependsOnStore: "partly",
    note: "Nutné rozlišit minimálně supermarket / hypermarket a případně lokalitu.",
  },
  {
    chain: "Lidl",
    url: "https://www.lidl.cz/c/akcni-letak/s10008644",
    dependsOnStore: "unknown",
    note: "Ověřujeme, zda je k dispozici PDF, online viewer, JSON nebo produktový text.",
  },
];

function decodeHtml(value) {
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

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = regex.exec(html))) {
    const href = absoluteUrl(decodeHtml(match[1].trim()), baseUrl);
    const text = decodeHtml(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

    links.push({ href, text });
  }

  return links;
}

function extractAssetUrls(html, baseUrl) {
  const urls = [];
  const regex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;

  let match;
  while ((match = regex.exec(html))) {
    urls.push(absoluteUrl(decodeHtml(match[1].trim()), baseUrl));
  }

  return unique(urls);
}

function findPdfLinks(links, assets) {
  return unique([...links.map((item) => item.href), ...assets]).filter((url) =>
    /\.pdf(?:[?#].*)?$/i.test(url)
  );
}

function findViewerLinks(links) {
  return links.filter((item) => {
    const haystack = `${item.href} ${item.text}`.toLowerCase();
    return (
      haystack.includes("letak") ||
      haystack.includes("leták") ||
      haystack.includes("leaflet") ||
      haystack.includes("prospekt") ||
      haystack.includes("brozura") ||
      haystack.includes("brožura") ||
      haystack.includes("prohlednout") ||
      haystack.includes("prohlédnout") ||
      haystack.includes("catalog") ||
      haystack.includes("katalog")
    );
  });
}

function findPossibleDataUrls(html, assets) {
  const candidates = assets.filter((url) => /\.(json|js)(?:[?#].*)?$/i.test(url));
  const hasNextData = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>/i.test(html);
  const jsonLdCount = (html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>/gi) || []).length;

  const endpointHints = unique(
    Array.from(
      html.matchAll(/["']([^"']*(?:api|graphql|product|products|offers|leaflet|letak|leták|catalog|brochure)[^"']*)["']/gi)
    )
      .map((match) => match[1])
      .filter((value) => value.length < 300)
  );

  return {
    scriptJsonOrJsAssets: candidates.slice(0, 50),
    hasNextData,
    jsonLdCount,
    endpointHints: endpointHints.slice(0, 50),
  };
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

function findProductLikeLines(lines) {
  return lines
    .filter((line) => {
      const hasPrice = /\d{1,4}(?:\s?\d{3})*,\d{2}\s*Kč/i.test(line);
      const hasUnit = /\b(kg|g|l|ml|ks)\b/i.test(line);
      return hasPrice || (hasUnit && line.length > 6 && line.length < 120);
    })
    .slice(0, 80);
}

function summarizeTechnicalPotential({ pdfLinks, viewerLinks, possibleData, productLikeLines }) {
  const notes = [];

  if (possibleData.hasNextData) notes.push("Stránka obsahuje __NEXT_DATA__, může jít o strukturovaná data.");
  if (possibleData.jsonLdCount > 0) notes.push(`Stránka obsahuje JSON-LD bloky: ${possibleData.jsonLdCount}.`);
  if (possibleData.endpointHints.length > 0) notes.push("Ve stránce jsou náznaky API/datových endpointů.");
  if (pdfLinks.length > 0) notes.push(`Nalezeny PDF odkazy: ${pdfLinks.length}.`);
  if (viewerLinks.length > 0) notes.push(`Nalezeny odkazy na leták/viewer: ${viewerLinks.length}.`);
  if (productLikeLines.length > 0) notes.push(`Nalezeny řádky podobné produktům/cenám: ${productLikeLines.length}.`);

  let rating = "unknown";
  if (possibleData.hasNextData || possibleData.endpointHints.length > 5) rating = "high-for-structured-data";
  else if (pdfLinks.length > 0) rating = "medium-pdf-ocr-needed";
  else if (viewerLinks.length > 0) rating = "medium-viewer-investigation-needed";
  else if (productLikeLines.length > 10) rating = "medium-html-parser-possible";
  else rating = "low-or-needs-manual-investigation";

  return { rating, notes };
}

async function probeSource(source) {
  const result = {
    chain: source.chain,
    sourceUrl: source.url,
    dependsOnStore: source.dependsOnStore,
    sourceNote: source.note,
    checkedAt: new Date().toISOString(),
    ok: false,
    status: null,
    finalUrl: null,
    contentType: null,
    htmlLength: 0,
    pdfLinks: [],
    viewerLinks: [],
    possibleData: {
      scriptJsonOrJsAssets: [],
      hasNextData: false,
      jsonLdCount: 0,
      endpointHints: [],
    },
    productLikeLines: [],
    technicalPotential: {
      rating: "unknown",
      notes: [],
    },
    sampleLinks: [],
    sampleTextLines: [],
    error: null,
  };

  try {
    const response = await fetch(source.url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacProbe/0.1; +https://github.com/)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
      },
    });

    result.status = response.status;
    result.finalUrl = response.url;
    result.contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();

    result.ok = true;
    result.htmlLength = html.length;

    const links = extractLinks(html, response.url);
    const assets = extractAssetUrls(html, response.url);
    const lines = textLines(html);

    result.pdfLinks = findPdfLinks(links, assets);
    result.viewerLinks = findViewerLinks(links).slice(0, 80);
    result.possibleData = findPossibleDataUrls(html, assets);
    result.productLikeLines = findProductLikeLines(lines);
    result.sampleLinks = links.slice(0, 80);
    result.sampleTextLines = lines.slice(0, 120);
    result.technicalPotential = summarizeTechnicalPotential(result);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const results = [];

  for (const source of SOURCES) {
    console.log(`Probing ${source.chain}: ${source.url}`);
    const result = await probeSource(source);
    results.push(result);

    const filename = `${OUTPUT_DIR}/${source.chain.toLowerCase().replace(/\s+/g, "-")}.json`;
    await writeFile(filename, JSON.stringify(result, null, 2) + "\n", "utf8");

    console.log(`${source.chain}: ${result.technicalPotential.rating}`);
  }

  const summary = {
    updatedAt: new Date().toISOString(),
    count: results.length,
    results: results.map((result) => ({
      chain: result.chain,
      sourceUrl: result.sourceUrl,
      ok: result.ok,
      status: result.status,
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      dependsOnStore: result.dependsOnStore,
      htmlLength: result.htmlLength,
      pdfLinksCount: result.pdfLinks.length,
      viewerLinksCount: result.viewerLinks.length,
      hasNextData: result.possibleData.hasNextData,
      jsonLdCount: result.possibleData.jsonLdCount,
      endpointHintsCount: result.possibleData.endpointHints.length,
      productLikeLinesCount: result.productLikeLines.length,
      technicalPotential: result.technicalPotential,
      error: result.error,
    })),
  };

  await writeFile(`${OUTPUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Probe finished.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
