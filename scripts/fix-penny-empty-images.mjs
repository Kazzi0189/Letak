import { readFile, writeFile, mkdir } from "node:fs/promises";

const VIEWER_BASE_URL = "https://files.rewe.co.at/PennyIntLeaflet/CZ/13_05_2026_me/";
const PROBE_OUTPUT = "data/product-image-probe/penny-page-image-candidates.json";

async function patchFile(path, patcher) {
  const before = await readFile(path, "utf8");
  const after = patcher(before);

  if (after === before) {
    console.log(`No changes in ${path}`);
    return false;
  }

  await writeFile(path, after, "utf8");
  console.log(`Patched ${path}`);
  return true;
}

function replaceOnce(text, pattern, replacement, label) {
  const next = text.replace(pattern, replacement);

  if (next === text) {
    throw new Error(`Patch failed: ${label}`);
  }

  return next;
}

async function testImageUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacPennyImageFix/0.1; +https://github.com/)",
        accept: "image/*,*/*",
        range: "bytes=0-512",
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

function candidateUrls(pageNumber) {
  const p = String(pageNumber);
  const p2 = p.padStart(2, "0");
  const p3 = p.padStart(3, "0");
  const p4 = p.padStart(4, "0");

  return [
    `${VIEWER_BASE_URL}files/large/${p}.jpg`,
    `${VIEWER_BASE_URL}files/large/${p2}.jpg`,
    `${VIEWER_BASE_URL}files/large/${p3}.jpg`,
    `${VIEWER_BASE_URL}files/large/${p4}.jpg`,
    `${VIEWER_BASE_URL}files/mobile/${p}.jpg`,
    `${VIEWER_BASE_URL}files/mobile/${p2}.jpg`,
    `${VIEWER_BASE_URL}files/mobile/${p3}.jpg`,
    `${VIEWER_BASE_URL}files/mobile/${p4}.jpg`,
    `${VIEWER_BASE_URL}files/pages/${p}.jpg`,
    `${VIEWER_BASE_URL}files/pages/${p2}.jpg`,
    `${VIEWER_BASE_URL}files/pages/${p3}.jpg`,
    `${VIEWER_BASE_URL}files/pages/${p4}.jpg`,
    `${VIEWER_BASE_URL}files/assets/page${p}.jpg`,
    `${VIEWER_BASE_URL}files/assets/page-${p}.jpg`,
    `${VIEWER_BASE_URL}files/assets/page-${p4}.jpg`,
    `${VIEWER_BASE_URL}${p}/files/assets/cover300.jpg`,
    `${VIEWER_BASE_URL}files/assets/cover300.jpg`,
  ];
}

async function probePennyPageImages() {
  const samplePages = [1, 2, 3, 12, 25, 36];
  const tested = [];

  for (const pageNumber of samplePages) {
    for (const url of candidateUrls(pageNumber)) {
      const result = await testImageUrl(url);
      tested.push({
        pageNumber,
        ...result,
      });
    }
  }

  const working = tested.filter((item) => item.isImage);

  await mkdir("data/product-image-probe", { recursive: true });
  await writeFile(
    PROBE_OUTPUT,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        note:
          "Test možných cest k obrázkům stránek Penny. Pokud working obsahuje jen cover300, nejde o produktové obrázky.",
        working,
        tested,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Penny page image candidates tested: ${tested.length}`);
  console.log(`Working image candidates: ${working.length}`);
}

function patchPennyImport(source) {
  let text = source;

  if (text.includes("function pennyPageImageUrl(")) {
    text = text.replace(
      /function pennyPageImageUrl\(pageNumber\) \{[\s\S]*?\n\}/,
      `function pennyPageImageUrl(pageNumber) {
  // Penny zatím nedává samostatné produktové obrázky.
  // Předchozí pokus s cover300 vytvářel v aplikaci prázdné boxy, proto teď vracíme prázdnou hodnotu.
  return "";
}`
    );
  }

  return text;
}

function patchAppJs(source) {
  let text = source;

  if (text.includes("return '<div class=\"offer-image-placeholder\"")) {
    text = text.replace(
      /if \(!url\) \{\s*return '<div class="offer-image-placeholder" aria-hidden="true"><\/div>';\s*\}/,
      `if (!url) {
    return '';
  }`
    );
  }

  // Pokud jsou karty natvrdo označené jako offer-with-image, změníme to na dynamickou třídu.
  if (text.includes('<article class="offer offer-with-image">')) {
    text = text.replace(
      /<article class="offer offer-with-image">/,
      `<article class="offer \${productImageUrl(offer) ? 'offer-with-image' : ''}">`
    );
  }

  // Fallback pro případ, že renderOfferImage je vložený, ale class má trochu jiný zápis.
  if (
    text.includes("${renderOfferImage(offer)}") &&
    !text.includes("productImageUrl(offer) ? 'offer-with-image'")
  ) {
    text = text.replace(
      /<article class="offer">/,
      `<article class="offer \${productImageUrl(offer) ? 'offer-with-image' : ''}">`
    );
  }

  return text;
}

function patchStylesCss(source) {
  let text = source;

  if (!text.includes(".offer:not(.offer-with-image)")) {
    text += `

.offer:not(.offer-with-image) {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 14px;
  align-items: center;
}
`;
  }

  return text;
}

async function main() {
  await probePennyPageImages();

  await patchFile("scripts/import-penny-leaflet-html.mjs", patchPennyImport);
  await patchFile("app.js", patchAppJs);
  await patchFile("styles.css", patchStylesCss);

  console.log("Fixed empty Penny image boxes.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
