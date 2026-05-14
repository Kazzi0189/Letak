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

function patchCombineOffers(source) {
  let text = source;

  if (text.includes("imageUrl: offer.imageUrl")) {
    console.log("combine-offers.mjs already preserves imageUrl");
    return text;
  }

  const sourceUrlPattern = /sourceUrl:\s*offer\.sourceUrl\s*\|\|\s*"",\s*\n\s*leafletUrl:/;

  if (sourceUrlPattern.test(text)) {
    text = text.replace(
      sourceUrlPattern,
      `sourceUrl: offer.sourceUrl || "",
    imageUrl:
      offer.imageUrl ||
      offer.image ||
      offer.imageSrc ||
      offer.thumbnailUrl ||
      offer.productImageUrl ||
      "",
    imageAlt: offer.imageAlt || offer.product || "",
    leafletUrl:`
    );

    return text;
  }

  throw new Error("Patch failed: combine imageUrl fields");
}

function patchAppJs(source) {
  let text = source;

  if (!text.includes("function productImageUrl(")) {
    const helper = `

function productImageUrl(offer) {
  return (
    offer.imageUrl ||
    offer.image ||
    offer.imageSrc ||
    offer.thumbnailUrl ||
    offer.productImageUrl ||
    ''
  );
}

function renderOfferImage(offer) {
  const url = productImageUrl(offer);

  if (!url) {
    return '<div class="offer-image-placeholder" aria-hidden="true"></div>';
  }

  const alt = (offer.imageAlt || offer.product || 'Obrázek produktu')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return \`
    <div class="offer-image-wrap">
      <img class="offer-image" src="\${url}" alt="\${alt}" loading="lazy" referrerpolicy="no-referrer" />
    </div>
  \`;
}
`;

    if (text.includes("function renderQualityBadge(")) {
      text = text.replace(/function renderQualityBadge\(/, `${helper}\nfunction renderQualityBadge(`);
    } else if (text.includes("function visibleOffers(")) {
      text = text.replace(/function visibleOffers\(/, `${helper}\nfunction visibleOffers(`);
    } else {
      throw new Error("Patch failed: insert product image helpers");
    }
  }

  if (!text.includes("${renderOfferImage(offer)}")) {
    const articlePattern = /<article class="offer">/;

    if (articlePattern.test(text)) {
      text = text.replace(
        articlePattern,
        `<article class="offer offer-with-image">
      \${renderOfferImage(offer)}`
      );
    } else {
      // Fallback pro variantu, kde může být class složená jinak.
      const fallbackPattern = /<article class="([^"]*\boffer\b[^"]*)">/;

      if (!fallbackPattern.test(text)) {
        throw new Error("Patch failed: insert offer image into card");
      }

      text = text.replace(
        fallbackPattern,
        `<article class="$1 offer-with-image">
      \${renderOfferImage(offer)}`
      );
    }
  }

  return text;
}

function patchStylesCss(source) {
  let text = source;

  if (text.includes(".offer-image-wrap")) {
    console.log("styles.css already contains product image styles");
    return text;
  }

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

  return text;
}

async function main() {
  await patchFile("scripts/combine-offers.mjs", patchCombineOffers);
  await patchFile("app.js", patchAppJs);
  await patchFile("styles.css", patchStylesCss);

  console.log("Product image display patch finished.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
