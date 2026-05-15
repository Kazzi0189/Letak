import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";
const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_COUNT = 37;

const TERMS = [
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
  "ležák",
  "výčepní",
  "Mistrovská dušená šunka",
  "Řezníkův talíř",
  "Aloha Ambi Pur",
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

function decodeURIComponentSafe(value = "") {
  let result = String(value);
  for (let i = 0; i < 6; i++) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) break;
      result = decoded;
    } catch {
      break;
    }
  }
  return result;
}

function normalizeText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function termInText(text, term) {
  return normalizeSearch(text).includes(normalizeSearch(term));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function snippetAround(text, term, radius = 350) {
  const source = normalizeText(text);
  const lowSource = normalizeSearch(source);
  const lowTerm = normalizeSearch(term);
  const index = lowSource.indexOf(lowTerm);
  if (index < 0) return "";
  return source.slice(Math.max(0, index - radius), Math.min(source.length, index + lowTerm.length + radius));
}

function extractAttributes(html) {
  const attrs = [];
  let match;

  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(html))) {
    const name = match[1];
    const rawValue = match[2];
    const htmlDecoded = decodeHtml(rawValue);
    const urlDecoded = decodeURIComponentSafe(htmlDecoded);
    const normalized = normalizeText(urlDecoded);

    attrs.push({
      name,
      rawValue,
      decodedValue: normalized,
    });
  }

  return attrs;
}

function extractLongUrlDecodedFragments(html) {
  const fragments = [];
  const decoded = decodeHtml(html);
  let match;

  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  while ((match = urlRegex.exec(decoded))) {
    const raw = match[0];
    const decodedUrl = decodeURIComponentSafe(raw);
    fragments.push({
      sourceType: "url",
      raw,
      decodedValue: normalizeText(decodedUrl),
    });
  }

  const percentRegex = /((?:[^"'\s<>]*%[0-9A-Fa-f]{2}){4,}[^"'\s<>]*)/g;
  while ((match = percentRegex.exec(decoded))) {
    const raw = match[1];
    fragments.push({
      sourceType: "percent-fragment",
      raw,
      decodedValue: normalizeText(decodeURIComponentSafe(raw)),
    });
  }

  return fragments.filter((fragment) => fragment.decodedValue.length > 30);
}

function extractScriptLikeBlocks(html) {
  const blocks = [];
  let match;

  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = scriptRegex.exec(html))) {
    const raw = match[1] || "";
    const decoded = normalizeText(decodeURIComponentSafe(decodeHtml(raw)));
    if (decoded.length > 30) {
      blocks.push({
        sourceType: "script",
        decodedValue: decoded,
      });
    }
  }

  return blocks;
}

function searchSourcesForTerms(pageNumber, html) {
  const sources = [];

  const decodedHtml = decodeHtml(html);
  const fullyDecodedHtml = decodeURIComponentSafe(decodedHtml);

  sources.push({
    sourceType: "full-html-decoded",
    name: "",
    decodedValue: normalizeText(fullyDecodedHtml),
  });

  for (const attr of extractAttributes(html)) {
    sources.push({
      sourceType: "attribute",
      name: attr.name,
      rawValue: attr.rawValue,
      decodedValue: attr.decodedValue,
    });
  }

  sources.push(...extractLongUrlDecodedFragments(html));
  sources.push(...extractScriptLikeBlocks(html));

  const hits = [];

  for (const source of sources) {
    for (const term of TERMS) {
      if (!termInText(source.decodedValue, term)) continue;

      hits.push({
        pageNumber,
        term,
        sourceType: source.sourceType,
        attributeName: source.name ?? "",
        decodedLength: source.decodedValue.length,
        snippet: snippetAround(source.decodedValue, term),
        decodedValuePreview: source.decodedValue.slice(0, 2500),
      });
    }
  }

  return uniqueBy(hits, (hit) => `${hit.pageNumber}|${hit.term}|${hit.sourceType}|${hit.attributeName}|${hit.snippet}`);
}

async function fetchPage(pageNumber) {
  const url = `${BASE}/${pageNumber}/index.html`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyTermSourcesV2/0.1; +https://github.com/)",
      accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
    },
  });

  return {
    pageNumber,
    url,
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pages = [];
  const allHits = [];

  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
    const page = await fetchPage(pageNumber);
    const hits = searchSourcesForTerms(pageNumber, page.text);
    allHits.push(...hits);

    pages.push({
      pageNumber,
      ok: page.ok,
      status: page.status,
      htmlLength: page.text.length,
      hitsCount: hits.length,
      termsFound: Array.from(new Set(hits.map((hit) => hit.term))).sort(),
      sourceTypes: Array.from(new Set(hits.map((hit) => hit.sourceType))).sort(),
      hits: hits.slice(0, 80),
    });
  }

  const hitsByPage = pages
    .filter((page) => page.hitsCount > 0)
    .map((page) => ({
      pageNumber: page.pageNumber,
      hitsCount: page.hitsCount,
      termsFound: page.termsFound,
      sourceTypes: page.sourceTypes,
    }));

  const hitsBySourceType = {};
  for (const hit of allHits) {
    hitsBySourceType[hit.sourceType] = (hitsBySourceType[hit.sourceType] ?? 0) + 1;
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      pagesChecked: PAGE_COUNT,
      totalHits: allHits.length,
      pagesWithTermHits: hitsByPage,
      hitsBySourceType,
      page20TermsFound: pages.find((page) => page.pageNumber === 20)?.termsFound ?? [],
      recommendedPath:
        (pages.find((page) => page.pageNumber === 20)?.termsFound ?? []).length >= 8
          ? "build-penny-hidden-parser-from-identified-source"
          : "inspect-raw-page-20-html-manually",
    },
    bestPage20Hits: allHits.filter((hit) => hit.pageNumber === 20).slice(0, 120),
    allHits: allHits.slice(0, 1000),
    pages,
  };

  await writeFile(`${OUTPUT_DIR}/penny-term-sources-v2-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny term sources v2 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-term-sources-v2-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
