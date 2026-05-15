import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";

const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";

const PAGES_TO_CHECK = [18, 19, 20, 21, 30, 31, 32];

const EXPECTED_TERMS = [
  "Braník",
  "Starobrno",
  "Velkopopovický Kozel",
  "Svijany",
  "Svijanský",
  "Krušovice",
  "Radegast",
  "Staropramen",
  "Mustang",
  "Březňák",
  "Budweiser",
  "Budvar",
  "Cool",
  "Gambrinus",
  "Ostravar",
  "Bohemia Sekt",
  "Prosecco",
  "pivo",
  "ležák",
  "výčepní",
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

function normalizeText(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
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
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyBeerPageProbe/0.1; +https://github.com/)",
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

function extractJsonLikeBlocks(html) {
  const blocks = [];
  let match;

  const scriptJsonRegex = /<script[^>]+type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = scriptJsonRegex.exec(html))) {
    blocks.push({
      type: "script-json",
      preview: normalizeText(match[1]).slice(0, 2500),
    });
  }

  const nextDataRegex = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = nextDataRegex.exec(html))) {
    blocks.push({
      type: "next-data",
      preview: normalizeText(match[1]).slice(0, 2500),
    });
  }

  const stateRegex = /(?:window\.__[^=]+|window\.[A-Z0-9_]+)\s*=\s*({[\s\S]{100,}?});/gi;
  while ((match = stateRegex.exec(html))) {
    blocks.push({
      type: "window-state",
      preview: normalizeText(match[1]).slice(0, 2500),
    });
  }

  return blocks.slice(0, 30);
}

function termHits(text) {
  const normalized = normalizeForSearch(text);
  return EXPECTED_TERMS.filter((term) => normalized.includes(normalizeForSearch(term)));
}

function snippetsForTerms(text) {
  const normalizedText = normalizeText(text);
  const snippets = [];

  for (const term of EXPECTED_TERMS) {
    const lowText = normalizeForSearch(normalizedText);
    const lowTerm = normalizeForSearch(term);
    const index = lowText.indexOf(lowTerm);

    if (index < 0) continue;

    snippets.push({
      term,
      snippet: normalizedText.slice(Math.max(0, index - 180), Math.min(normalizedText.length, index + 260)),
    });
  }

  return snippets;
}

function imageCandidates(urls) {
  return urls.filter((url) => /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url)).slice(0, 80);
}

function maybeDataCandidates(urls) {
  return urls.filter((url) => /\.(?:json|js|txt)(?:[?#].*)?$/i.test(url) || /api|product|offer|leaflet|page|article/i.test(url)).slice(0, 120);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pages = [];

  for (const pageNumber of PAGES_TO_CHECK) {
    const url = `${BASE}/${pageNumber}/index.html`;
    const page = await fetchText(url);
    const urls = extractUrls(page.text, page.finalUrl);
    const visibleText = normalizeText(page.text);
    const fullDecoded = decodeHtml(page.text);

    pages.push({
      pageNumber,
      url,
      ok: page.ok,
      status: page.status,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      htmlLength: page.text.length,
      visibleTextLength: visibleText.length,
      termHitsVisibleText: termHits(visibleText),
      termHitsFullHtml: termHits(fullDecoded),
      snippets: snippetsForTerms(visibleText).slice(0, 40),
      fullHtmlSnippets: snippetsForTerms(fullDecoded).slice(0, 40),
      imageCandidates: imageCandidates(urls),
      dataCandidates: maybeDataCandidates(urls),
      jsonLikeBlocks: extractJsonLikeBlocks(page.text),
      visibleTextPreview: visibleText.slice(0, 3500),
    });

    await writeFile(`${OUTPUT_DIR}/penny-page-${String(pageNumber).padStart(2, "0")}-raw.html`, page.text, "utf8");
    await writeFile(`${OUTPUT_DIR}/penny-page-${String(pageNumber).padStart(2, "0")}-visible.txt`, visibleText + "\n", "utf8");
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    base: BASE,
    pagesChecked: PAGES_TO_CHECK,
    summary: {
      pagesWithBeerTermsInVisibleText: pages.filter((page) => page.termHitsVisibleText.length > 0).map((page) => ({
        pageNumber: page.pageNumber,
        hits: page.termHitsVisibleText,
      })),
      pagesWithBeerTermsInFullHtml: pages.filter((page) => page.termHitsFullHtml.length > 0).map((page) => ({
        pageNumber: page.pageNumber,
        hits: page.termHitsFullHtml,
      })),
      recommendedPath:
        pages.some((page) => page.termHitsVisibleText.length > 5)
          ? "fix-penny-import-text-parser-for-beer-pages"
          : pages.some((page) => page.termHitsFullHtml.length > 5)
            ? "extract-penny-data-from-hidden-html-json"
            : "beer-items-likely-image-only-needs-image-or-layout-source",
    },
    pages,
  };

  await writeFile(`${OUTPUT_DIR}/penny-beer-page-probe-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny beer page probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-beer-page-probe-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
