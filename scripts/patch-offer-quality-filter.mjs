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

function patchAppJs(source) {
  let text = source;

  if (text.includes("function offerQuality(")) {
    console.log("app.js already contains offer quality filter");
    return text;
  }

  text = replaceOnce(
    text,
    /sortBy:\s*'unitPrice',\s*dataStatus:/,
    "sortBy: 'unitPrice',\n  qualityMode: localStorage.getItem('qualityMode') || 'trusted',\n  dataStatus:",
    "state.qualityMode"
  );

  text = replaceOnce(
    text,
    /localStorage\.setItem\('cart', JSON\.stringify\(state\.cart\)\);\s*\}/,
    "localStorage.setItem('cart', JSON.stringify(state.cart));\n  localStorage.setItem('qualityMode', state.qualityMode);\n}",
    "saveState qualityMode"
  );

  text = replaceOnce(
    text,
    /function visibleOffers\(\) \{/,
    `function offerQuality(offer) {
  const confidence = String(offer.confidence || '').toLowerCase();
  const suspect =
    offer.suspect === true ||
    String(offer.suspect || '').toLowerCase() === 'true';

  if (suspect) return 'suspect';
  if (confidence === 'low') return 'low';
  if (confidence === 'medium') return 'medium';
  return 'high';
}

function shouldShowOfferByQuality(offer) {
  const quality = offerQuality(offer);

  if (state.qualityMode === 'all') return true;
  if (state.qualityMode === 'high') return quality === 'high';
  if (state.qualityMode === 'review') return quality === 'low' || quality === 'suspect';

  return quality === 'high' || quality === 'medium';
}

function qualityLabel(offer) {
  const quality = offerQuality(offer);

  if (quality === 'high') return 'vysoká jistota';
  if (quality === 'medium') return 'střední jistota';
  if (quality === 'low') return 'nízká jistota';
  return 'ke kontrole';
}

function renderQualityBadge(offer) {
  const quality = offerQuality(offer);

  if (quality === 'high') return '<span class="pill ok">ověřeno</span>';
  if (quality === 'medium') return '<span class="pill warn">střední jistota</span>';
  if (quality === 'low') return '<span class="pill warn">nízká jistota</span>';

  return '<span class="pill danger">ke kontrole</span>';
}

function renderOfferQualityText(offer) {
  const quality = offerQuality(offer);
  const page = offer.pageNumber ? \` · str. \${offer.pageNumber}\` : '';

  if (quality === 'high') return page;

  const reasons = Array.isArray(offer.suspectReasons) && offer.suspectReasons.length
    ? \` · \${offer.suspectReasons.join(', ')}\`
    : '';

  return \` · \${qualityLabel(offer)}\${reasons}\${page}\`;
}

function qualitySummary() {
  const selected = state.offers.filter((offer) => state.selectedStoreIds.includes(offer.storeId));
  const counts = selected.reduce(
    (acc, offer) => {
      acc[offerQuality(offer)] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0, suspect: 0 }
  );

  return \`Jistota dat: vysoká \${counts.high}, střední \${counts.medium}, nízká \${counts.low}, ke kontrole \${counts.suspect}\`;
}

function visibleOffers() {`,
    "insert quality helpers"
  );

  text = replaceOnce(
    text,
    /\.filter\(\(offer\) => state\.selectedStoreIds\.includes\(offer\.storeId\)\)\s*\.filter\(\(offer\) => \{/,
    ".filter((offer) => state.selectedStoreIds.includes(offer.storeId))\n    .filter((offer) => shouldShowOfferByQuality(offer))\n    .filter((offer) => {",
    "visibleOffers quality filter"
  );

  text = replaceOnce(
    text,
    /for \(const offer of state\.offers\.filter\(\(offer\) => state\.selectedStoreIds\.includes\(offer\.storeId\)\)\) \{/,
    "for (const offer of state.offers.filter((offer) => state.selectedStoreIds.includes(offer.storeId) && shouldShowOfferByQuality(offer))) {",
    "cheapestMap quality filter"
  );

  text = replaceOnce(
    text,
    /\$\{isCheapest \? '<span class="pill dark">nejlevnější<\/span>' : ''\}\s*<span class="small">platí do \$\{offer\.validTo \|\| 'neuvedeno'\}<\/span>/,
    "${isCheapest ? '<span class=\"pill dark\">nejlevnější</span>' : ''}\n        ${renderQualityBadge(offer)}\n        <span class=\"small\">platí do ${offer.validTo || 'neuvedeno'}</span>",
    "render quality badge"
  );

  text = replaceOnce(
    text,
    /<p>\$\{offer\.brand \|\| 'značka neuvedena'\} · \$\{offer\.packageSize \|\| 'balení neuvedeno'\} · \$\{offer\.priceType \|\| 'akce'\}<\/p>/,
    "<p>${offer.brand || 'značka neuvedena'} · ${offer.packageSize || 'balení neuvedeno'} · ${offer.priceType || 'akce'}${renderOfferQualityText(offer)}</p>",
    "render offer quality text"
  );

  text = replaceOnce(
    text,
    /<p>Hledej produkt a přidej nejlevnější nabídky do košíku\.<\/p>/,
    "<p>Hledej produkt a přidej nejlevnější nabídky do košíku.</p>\n            <p class=\"quality-note\">${qualitySummary()}</p>",
    "quality summary"
  );

  text = replaceOnce(
    text,
    /<option value="price" \$\{state\.sortBy === 'price' \? 'selected' : ''\}>Cena balení<\/option>\s*<\/select>/,
    `<option value="price" \${state.sortBy === 'price' ? 'selected' : ''}>Cena balení</option>
            </select>

            <select id="quality" class="select">
              <option value="trusted" \${state.qualityMode === 'trusted' ? 'selected' : ''}>Jisté + střední</option>
              <option value="high" \${state.qualityMode === 'high' ? 'selected' : ''}>Jen vysoká jistota</option>
              <option value="review" \${state.qualityMode === 'review' ? 'selected' : ''}>Jen ke kontrole</option>
              <option value="all" \${state.qualityMode === 'all' ? 'selected' : ''}>Vše včetně nízké jistoty</option>
            </select>`,
    "quality select"
  );

  text = replaceOnce(
    text,
    /document\.querySelector\('#sort'\)\?\.addEventListener\('change', \(event\) => \{[\s\S]*?renderDynamic\(\);\s*\}\);/,
    `document.querySelector('#sort')?.addEventListener('change', (event) => {
    state.sortBy = event.target.value;
    renderDynamic();
  });

  document.querySelector('#quality')?.addEventListener('change', (event) => {
    state.qualityMode = event.target.value;
    saveState();
    renderDynamic();
  });`,
    "quality event listener"
  );

  return text;
}

function patchStylesCss(source) {
  let text = source;

  if (text.includes(".pill.ok")) {
    console.log("styles.css already contains quality styles");
    return text;
  }

  text += `

.pill.ok {
  background: #dcfce7;
  color: #166534;
}

.pill.warn {
  background: #fef3c7;
  color: #92400e;
}

.pill.danger {
  background: #fee2e2;
  color: #991b1b;
}

.quality-note {
  margin-top: 8px;
  font-size: 13px;
}

.offer .pill.danger,
.offer .pill.warn {
  font-weight: 800;
}

@media (min-width: 720px) {
  .toolbar {
    grid-template-columns: 1fr 190px 220px;
  }
}
`;

  return text;
}

function patchCombineOffers(source) {
  let text = source;

  text = text.replace(
    /const INPUTS = \[[\s\S]*?\];\s*const OUTPUT_FILE/,
    `const INPUTS = [
  {
    name: "Penny leták",
    path: "data/penny-leaflet-offers.json",
    required: false,
  },
  {
    name: "Kaufland Teplice",
    path: "data/offers-kaufland-teplice.json",
    required: false,
  },
]; const OUTPUT_FILE`
  );

  if (!text.includes("confidence: offer.confidence")) {
    text = replaceOnce(
      text,
      /sourceUrl: offer\.sourceUrl \|\| "", leafletUrl: offer\.leafletUrl \|\| "", sourceFile: sourceName,/,
      `sourceUrl: offer.sourceUrl || "", leafletUrl: offer.leafletUrl || "",
    confidence: offer.confidence || "high",
    suspect: offer.suspect === true || String(offer.suspect || "").toLowerCase() === "true",
    suspectReasons: Array.isArray(offer.suspectReasons) ? offer.suspectReasons : [],
    pageNumber: offer.pageNumber ?? null,
    sourceFile: sourceName,`,
      "combine quality fields"
    );
  }

  text = text.replace(
    /note: "Backup původního Penny data\/offers\.json před vytvořením společného offers\.json\."/,
    `note: "Backup původního data/offers.json před vytvořením společného offers.json."`
  );

  return text;
}

async function main() {
  await patchFile("app.js", patchAppJs);
  await patchFile("styles.css", patchStylesCss);
  await patchFile("scripts/combine-offers.mjs", patchCombineOffers);

  console.log("Quality filter patch finished.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
