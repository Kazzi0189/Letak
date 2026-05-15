import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";

const BASE = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me";
const PAGE_COUNT = 37;

const WATCH_TERMS = [
  "máslo", "mléko", "sýr", "jogurt", "kuřecí", "vepřové", "hovězí", "šunka", "salám",
  "chléb", "rohlík", "banán", "jablka", "brambory", "rajčata", "okurka",
  "pivo", "ležák", "výčepní", "Braník", "Krušovice", "Staropramen", "Gambrinus", "Kozel",
  "Radegast", "Budvar", "Birell", "Cool", "Prosecco", "Bohemia Sekt",
  "toaletní papír", "kapesníky", "prací", "aviváž", "jar", "šampon",
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

  for (let i = 0; i < 4; i++) {
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

function priceCount(text = "") {
  return (String(text).match(/\b\d{1,4}[,.]\d{2}\b|\b\d{1,4},-\b/g) ?? []).length;
}

function percentCount(text = "") {
  return (String(text).match(/\b\d{1,3}\s*%/g) ?? []).length;
}

function termHits(text = "") {
  const normalized = normalizeForSearch(text);
  return WATCH_TERMS.filter((term) => normalized.includes(normalizeForSearch(term)));
}

function snippetsForTerms(text = "", limit = 40) {
  const source = normalizeText(text);
  const lowSource = normalizeForSearch(source);
  const snippets = [];

  for (const term of WATCH_TERMS) {
    const lowTerm = normalizeForSearch(term);
    const index = lowSource.indexOf(lowTerm);
    if (index < 0) continue;

    snippets.push({
      term,
      snippet: source.slice(Math.max(0, index - 220), Math.min(source.length, index + 360)),
    });
  }

  return snippets.slice(0, limit);
}

function extractAttributeValues(html) {
  const values = [];
  let match;

  const attrRegex = /(?:content|title|alt|aria-label|href|src|data-[\w-]+)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(html))) {
    values.push(match[1]);
  }

  return values;
}

function extractMetaText(html) {
  const values = extractAttributeValues(html);

  const decodedValues = values
    .map((value) => decodeURIComponentSafe(decodeHtml(value)))
    .map((value) => value.replace(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/\d+\//i, ""))
    .map((value) => value.replace(/\/files\/assets\/.*$/i, ""))
    .map((value) => value.replace(/^[^ ]*\/?/, (prefix) => {
      // Pokud je to běžný URL/technický fragment, necháme ho odstranit jen když obsahuje slash.
      return prefix.includes("/") ? "" : prefix;
    }))
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 12)
    .filter((value) => !/^(IE=edge|text\/html|image\/jpeg|width=device-width|summary_large_image|@flippingbook|article|FlippingBook|yes|EBook)$/i.test(value));

  return unique(decodedValues).join(" ");
}

function extractEncodedLongFragments(html) {
  const fragments = [];
  const decoded = decodeHtml(html);
  let match;

  const encodedRegex = /(?:https?:\/\/[^\s"'<>]+\/)?(\d+\s*%20[^"'<>]{80,})/gi;
  while ((match = encodedRegex.exec(decoded))) {
    fragments.push(decodeURIComponentSafe(match[1]));
  }

  return unique(fragments).map(normalizeText).join(" ");
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyFullHiddenTextProbe/0.1; +https://github.com/)",
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

function classifyPage(visibleText, hiddenText, fullHtmlText) {
  const visiblePrices = priceCount(visibleText);
  const hiddenPrices = priceCount(hiddenText);
  const fullPrices = priceCount(fullHtmlText);

  const visibleHits = termHits(visibleText);
  const hiddenHits = termHits(hiddenText);
  const fullHits = termHits(fullHtmlText);

  const hiddenOnlyHits = hiddenHits.filter((hit) => !visibleHits.includes(hit));

  const hiddenLooksUseful =
    hiddenPrices >= Math.max(4, visiblePrices + 4) ||
    hiddenOnlyHits.length >= 3 ||
    percentCount(hiddenText) >= Math.max(4, percentCount(visibleText) + 3);

  return {
    visiblePrices,
    hiddenPrices,
    fullPrices,
    visibleHits,
    hiddenHits,
    fullHits,
    hiddenOnlyHits,
    hiddenLooksUseful,
    likelyStatus: hiddenLooksUseful ? "hidden-meta-products-likely" : "visible-or-low-product-density",
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pages = [];

  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
    const url = `${BASE}/${pageNumber}/index.html`;
    const page = await fetchText(url);

    const visibleText = normalizeText(page.text);
    const metaText = extractMetaText(page.text);
    const encodedLongText = extractEncodedLongFragments(page.text);
    const hiddenText = normalizeText(`${metaText} ${encodedLongText}`);
    const fullHtmlText = normalizeText(decodeURIComponentSafe(decodeHtml(page.text)));

    const classification = classifyPage(visibleText, hiddenText, fullHtmlText);

    pages.push({
      pageNumber,
      url,
      ok: page.ok,
      status: page.status,
      htmlLength: page.text.length,
      visibleTextLength: visibleText.length,
      hiddenTextLength: hiddenText.length,
      ...classification,
      hiddenSnippets: snippetsForTerms(hiddenText),
      fullHtmlSnippets: snippetsForTerms(fullHtmlText),
      visibleTextPreview: visibleText.slice(0, 1200),
      hiddenTextPreview: hiddenText.slice(0, 2500),
    });

    await writeFile(`${OUTPUT_DIR}/penny-page-${String(pageNumber).padStart(2, "0")}-hidden.txt`, hiddenText + "\n", "utf8");
  }

  const hiddenProductPages = pages.filter((page) => page.hiddenLooksUseful);

  const summary = {
    checkedAt: new Date().toISOString(),
    base: BASE,
    pageCount: PAGE_COUNT,
    summary: {
      pagesChecked: pages.length,
      pagesLikelyUsingHiddenMetaProducts: hiddenProductPages.map((page) => page.pageNumber),
      hiddenProductPagesCount: hiddenProductPages.length,
      pagesWithHiddenOnlyWatchTerms: pages
        .filter((page) => page.hiddenOnlyHits.length > 0)
        .map((page) => ({
          pageNumber: page.pageNumber,
          hiddenOnlyHits: page.hiddenOnlyHits,
          hiddenPrices: page.hiddenPrices,
          visiblePrices: page.visiblePrices,
        })),
      recommendedPath:
        hiddenProductPages.length >= 5
          ? "rebuild-penny-import-from-hidden-meta-text-all-pages"
          : "patch-specific-penny-pages-hidden-meta-text",
    },
    pages,
  };

  await writeFile(`${OUTPUT_DIR}/penny-full-hidden-text-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Penny full hidden text probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/penny-full-hidden-text-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
