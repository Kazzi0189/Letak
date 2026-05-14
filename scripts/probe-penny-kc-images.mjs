import { mkdir, writeFile } from "node:fs/promises";

const OUTPUT_FILE = "data/product-image-probe/penny-kc-image-candidates.json";

const SOURCE_URLS = [
  "https://www.penny.cz/nabidky",
  "https://www.penny.cz/nabidky/letaky",
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

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyKcImageProbe/0.1; +https://github.com/)",
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
    text: await response.text(),
  };
}

async function testImageUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyKcImageProbe/0.1; +https://github.com/)",
        accept: "image/*,*/*",
        range: "bytes=0-1024",
      },
    });

    return {
      url,
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") ?? "",
      contentLength: response.headers.get("content-length") ?? "",
      isImage: response.ok && /image/i.test(response.headers.get("content-type") ?? ""),
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractKcUrls(text, baseUrl) {
  const decoded = decodeHtml(text);
  const urls = [];

  const httpRegex = /https?:\/\/[^"'\\\s)<>]+/gi;
  let match;
  while ((match = httpRegex.exec(decoded))) {
    const url = match[0].replace(/[;,]+$/, "");
    if (/kc-usercontent\.com/i.test(url)) urls.push(url);
  }

  const attrRegex = /(?:src|href|srcset|data-src|data-image|content)\s*=\s*["']([^"']+)["']/gi;
  while ((match = attrRegex.exec(decoded))) {
    const raw = match[1];
    if (/kc-usercontent\.com/i.test(raw) || /leaflet|page|web|20kw|one/i.test(raw)) {
      urls.push(absoluteUrl(raw.split(/\s+/)[0], baseUrl));
    }
  }

  return unique(urls.map((url) => url.replace(/\\/g, "")));
}

function imageLike(url) {
  return /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url.split("?")[0]);
}

function generatePageCandidates(seedUrls) {
  const candidates = [];

  for (const seed of seedUrls) {
    const clean = seed.replace(/\\/g, "");
    const [baseNoQuery, query = ""] = clean.split("?");
    const suffixQuery = query ? `?${query}` : "";

    const patterns = [
      /(leaflet[_-]page[_-]?)(\d{4})(\.(?:jpg|jpeg|png|webp))$/i,
      /(leaflet[_-]page[_-]?)(\d{3})(\.(?:jpg|jpeg|png|webp))$/i,
      /(page[_-]?)(\d{4})(\.(?:jpg|jpeg|png|webp))$/i,
      /(page[_-]?)(\d{3})(\.(?:jpg|jpeg|png|webp))$/i,
      /(page[_-]?)(\d{1,2})(\.(?:jpg|jpeg|png|webp))$/i,
    ];

    for (const pattern of patterns) {
      const match = baseNoQuery.match(pattern);
      if (!match) continue;

      const before = baseNoQuery.slice(0, match.index);
      const prefix = match[1];
      const digits = match[2];
      const ext = match[3];
      const width = digits.length;

      for (let page = 1; page <= 60; page++) {
        const pageString = String(page).padStart(width, "0");
        candidates.push(`${before}${prefix}${pageString}${ext}${suffixQuery}`);
        candidates.push(`${before}${prefix}${pageString}${ext}`);
      }
    }
  }

  return unique(candidates);
}

async function main() {
  await mkdir("data/product-image-probe", { recursive: true });

  const pages = [];
  const seedUrls = [];

  for (const url of SOURCE_URLS) {
    const page = await fetchText(url);
    const kcUrls = extractKcUrls(page.text, page.finalUrl);
    const imageUrls = kcUrls.filter(imageLike);

    pages.push({
      url,
      ok: page.ok,
      status: page.status,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      kcUrls: kcUrls.slice(0, 120),
      imageUrls: imageUrls.slice(0, 120),
    });

    seedUrls.push(...imageUrls);
  }

  const uniqueSeedUrls = unique(seedUrls);
  const generatedCandidates = generatePageCandidates(uniqueSeedUrls);

  const testedSeeds = [];
  for (const url of uniqueSeedUrls.slice(0, 80)) {
    testedSeeds.push(await testImageUrl(url));
  }

  const testedGenerated = [];
  for (const url of generatedCandidates.slice(0, 180)) {
    const tested = await testImageUrl(url);
    if (tested.ok || tested.isImage) {
      testedGenerated.push(tested);
    }
  }

  const workingSeeds = testedSeeds.filter((item) => item.isImage);
  const workingGenerated = testedGenerated.filter((item) => item.isImage);

  const result = {
    checkedAt: new Date().toISOString(),
    sourceUrls: SOURCE_URLS,
    summary: {
      seedUrls: uniqueSeedUrls.length,
      generatedCandidates: generatedCandidates.length,
      workingSeedImages: workingSeeds.length,
      workingGeneratedImages: workingGenerated.length,
      recommendedPath:
        workingGenerated.length > 5
          ? "use-kc-page-images"
          : workingSeeds.length > 0
            ? "inspect-seed-images-only"
            : "no-kc-images-found",
    },
    pages,
    seedUrls: uniqueSeedUrls,
    generatedCandidates: generatedCandidates.slice(0, 180),
    workingSeedImages: workingSeeds,
    workingGeneratedImages: workingGenerated,
    testedSeeds,
    testedGenerated,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2) + "\n", "utf8");

  console.log("Penny KC image probe finished.");
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`Wrote ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
