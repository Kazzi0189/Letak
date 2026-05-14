import { readFile, writeFile } from "node:fs/promises";

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

function patchPennyImport(source) {
  let text = source;

  if (!text.includes("function pennyPageImageUrl(")) {
    text = replaceOnce(
      text,
      /function makeId\(product, price, pageNumber, packageSize\) \{[\s\S]*?\n\}/,
      (match) => `${match}

function pennyPageImageUrl(pageNumber) {
  if (!pageNumber) return "";
  return \`\${VIEWER_BASE_URL}\${pageNumber}/files/assets/cover300.jpg\`;
}`,
      "insert pennyPageImageUrl"
    );
  }

  if (!text.includes("pageImageUrl: pennyPageImageUrl(pageNumber)")) {
    text = replaceOnce(
      text,
      /sourceUrl,\s*\n\s*pageNumber,\s*\n\s*confidence,/,
      `sourceUrl,
      pageNumber,
      imageUrl: "",
      pageImageUrl: pennyPageImageUrl(pageNumber),
      imageType: "page-thumbnail",
      imageAlt: \`\${product} – stránka letáku \${pageNumber}\`,
      confidence,`,
      "add image fields to Penny offers"
    );
  }

  text = text.replace(
    /note:\s*"([^"]*)"/,
    `note: "$1 Penny má zatím jen miniatury stránky letáku, ne samostatné produktové obrázky."`
  );

  return text;
}

function patchCombineOffers(source) {
  let text = source;

  if (!text.includes("pageImageUrl: offer.pageImageUrl")) {
    // Varianta po předchozím patchi obrázků.
    if (text.includes("imageAlt: offer.imageAlt || offer.product ||")) {
      text = replaceOnce(
        text,
        /imageAlt:\s*offer\.imageAlt\s*\|\|\s*offer\.product\s*\|\|\s*"",/,
        `imageAlt: offer.imageAlt || offer.product || "",
    pageImageUrl: offer.pageImageUrl || "",
    imageType: offer.imageType || (offer.pageImageUrl ? "page-thumbnail" : (offer.imageUrl ? "product" : "")),`,
        "combine preserve pageImageUrl after imageAlt"
      );
      return text;
    }

    // Varianta bez předchozího image patch pole.
    if (text.includes("leafletUrl: offer.leafletUrl ||")) {
      text = replaceOnce(
        text,
        /sourceUrl:\s*offer\.sourceUrl\s*\|\|\s*"",\s*\n\s*leafletUrl:/,
        `sourceUrl: offer.sourceUrl || "",
    imageUrl:
      offer.imageUrl ||
      offer.image ||
      offer.imageSrc ||
      offer.thumbnailUrl ||
      offer.productImageUrl ||
      "",
    imageAlt: offer.imageAlt || offer.product || "",
    pageImageUrl: offer.pageImageUrl || "",
    imageType: offer.imageType || (offer.pageImageUrl ? "page-thumbnail" : (offer.imageUrl ? "product" : "")),
    leafletUrl:`,
        "combine add image fields"
      );
      return text;
    }

    throw new Error("Patch failed: combine pageImageUrl fields");
  }

  console.log("combine-offers.mjs already preserves pageImageUrl");
  return text;
}

function patchAppJs(source) {
  let text = source;

  if (text.includes("function productImageUrl(")) {
    if (!text.includes("offer.pageImageUrl")) {
      text = replaceOnce(
        text,
        /offer\.productImageUrl\s*\|\|\s*\n\s*''/,
        `offer.productImageUrl ||
    offer.pageImageUrl ||
    ''`,
        "app productImageUrl pageImageUrl fallback"
      );
    }

    if (!text.includes("offer.imageType === 'page-thumbnail'")) {
      text = replaceOnce(
        text,
        /const alt = \(offer\.imageAlt \|\| offer\.product \|\| 'Obrázek produktu'\)/,
        `const isPageThumbnail = offer.imageType === 'page-thumbnail' && !offer.imageUrl;
  const alt = (offer.imageAlt || offer.product || (isPageThumbnail ? 'Miniatura stránky letáku' : 'Obrázek produktu'))`,
        "app detect page thumbnail"
      );

      text = replaceOnce(
        text,
        /<img class="offer-image" src="\$\{url\}" alt="\$\{alt\}" loading="lazy" referrerpolicy="no-referrer" \/>/,
        `<img class="offer-image \${isPageThumbnail ? 'offer-page-image' : ''}" src="\${url}" alt="\${alt}" loading="lazy" referrerpolicy="no-referrer" />
      \${isPageThumbnail ? '<span class="offer-image-label">leták</span>' : ''}`,
        "app page image class"
      );
    }

    return text;
  }

  // Kdyby app ještě neměla image helper z předchozího kroku, doplníme ho.
  const helper = `

function productImageUrl(offer) {
  return (
    offer.imageUrl ||
    offer.image ||
    offer.imageSrc ||
    offer.thumbnailUrl ||
    offer.productImageUrl ||
    offer.pageImageUrl ||
    ''
  );
}

function renderOfferImage(offer) {
  const url = productImageUrl(offer);

  if (!url) {
    return '<div class="offer-image-placeholder" aria-hidden="true"></div>';
  }

  const isPageThumbnail = offer.imageType === 'page-thumbnail' && !offer.imageUrl;
  const alt = (offer.imageAlt || offer.product || (isPageThumbnail ? 'Miniatura stránky letáku' : 'Obrázek produktu'))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return \`
    <div class="offer-image-wrap">
      <img class="offer-image \${isPageThumbnail ? 'offer-page-image' : ''}" src="\${url}" alt="\${alt}" loading="lazy" referrerpolicy="no-referrer" />
      \${isPageThumbnail ? '<span class="offer-image-label">leták</span>' : ''}
    </div>
  \`;
}
`;

  if (text.includes("function renderQualityBadge(")) {
    text = text.replace(/function renderQualityBadge\(/, `${helper}
function renderQualityBadge(`);
  } else if (text.includes("function visibleOffers(")) {
    text = text.replace(/function visibleOffers\(/, `${helper}
function visibleOffers(`);
  } else {
    throw new Error("Patch failed: insert product image helpers");
  }

  if (!text.includes("${renderOfferImage(offer)}")) {
    text = replaceOnce(
      text,
      /<article class="offer">/,
      `<article class="offer offer-with-image">
      \${renderOfferImage(offer)}`,
      "insert image into offer card"
    );
  }

  return text;
}

function patchStylesCss(source) {
  let text = source;

  if (!text.includes(".offer-image-wrap")) {
    text += `

.offer-with-image {
  display: grid;
  grid-template-columns: 86px 1fr auto;
  gap: 14px;
  align-items: center;
}

.offer-image-wrap,
.offer-image-placeholder {
  width: 78px;
  height: 78px;
  border-radius: 18px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.offer-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  mix-blend-mode: multiply;
}

.offer-image-placeholder {
  opacity: 0.45;
}

@media (max-width: 640px) {
  .offer-with-image {
    grid-template-columns: 64px 1fr;
  }

  .offer-image-wrap,
  .offer-image-placeholder {
    width: 58px;
    height: 58px;
    border-radius: 14px;
  }
}
`;
  }

  if (!text.includes(".offer-page-image")) {
    text += `

.offer-page-image {
  object-fit: cover;
  mix-blend-mode: normal;
}

.offer-image-label {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.82);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
`;
  }

  return text;
}

async function main() {
  await patchFile("scripts/import-penny-leaflet-html.mjs", patchPennyImport);
  await patchFile("scripts/combine-offers.mjs", patchCombineOffers);
  await patchFile("app.js", patchAppJs);
  await patchFile("styles.css", patchStylesCss);

  console.log("Penny page image patch finished.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
