import { readFile, writeFile } from "node:fs/promises";

const APP_FILE = "app.js";

const STORE_CATALOG = `const STORE_CATALOG = [
  {
    id: 'penny-default',
    chain: 'Penny',
    name: 'Penny – aktuální nabídky',
    address: 'celostátní / podle webu Penny',
    type: 'diskont',
    status: 'napojeno přes import Penny'
  },
  {
    id: 'kaufland-teplice-centrum',
    chain: 'Kaufland',
    name: 'Kaufland Teplice-Centrum',
    address: 'Čs. Dobrovolců 3356, 415 01 Teplice',
    type: 'hypermarket',
    status: 'napojeno přes import Kaufland Teplice'
  },
  {
    id: 'albert-supermarket',
    chain: 'Albert',
    name: 'Albert supermarket',
    address: 'aktuální supermarket leták Albert',
    type: 'supermarket',
    status: 'napojeno přes clean PDF import Albert'
  },
  {
    id: 'albert-hypermarket',
    chain: 'Albert',
    name: 'Albert hypermarket',
    address: 'aktuální hypermarket leták Albert',
    type: 'hypermarket',
    status: 'napojeno přes clean PDF import Albert'
  }
];`;

function replaceStoreCatalog(source) {
  const pattern = /const STORE_CATALOG = \[[\s\S]*?\];\s*function getInitialSelectedStoreIds/;

  if (!pattern.test(source)) {
    throw new Error("Nepodařilo se najít blok STORE_CATALOG v app.js");
  }

  return source.replace(pattern, `${STORE_CATALOG} function getInitialSelectedStoreIds`);
}

function patchInitialSelection(source) {
  let patched = source.replace(
    /JSON\.parse\(savedRaw \|\| '[^']*'\)/,
    `JSON.parse(savedRaw || '["penny-default","kaufland-teplice-centrum","albert-supermarket","albert-hypermarket"]')`
  );

  const ensureLines = [
    "if (!migrated.includes('kaufland-teplice-centrum')) { migrated.push('kaufland-teplice-centrum'); }",
    "if (!migrated.includes('albert-supermarket')) { migrated.push('albert-supermarket'); }",
    "if (!migrated.includes('albert-hypermarket')) { migrated.push('albert-hypermarket'); }",
  ].join(" ");

  patched = patched.replace(
    /if \(!migrated\.includes\('kaufland-teplice-centrum'\)\) \{ migrated\.push\('kaufland-teplice-centrum'\); \}/,
    ensureLines
  );

  // Staré demo ID se při načtení tiše převede na reálné zdroje.
  patched = patched.replace(
    ".map((id) => (id === 'kaufland-demo' ? 'kaufland-teplice-centrum' : id))",
    `.map((id) => {
      if (id === 'kaufland-demo') return 'kaufland-teplice-centrum';
      if (id === 'albert-hyper-demo') return 'albert-hypermarket';
      if (id === 'albert-super-demo') return 'albert-supermarket';
      return id;
    })`
  );

  return patched;
}

function patchTexts(source) {
  return source
    .replace(
      "Reálné importy jsou připravené pro Penny a Kaufland Teplice.",
      "Reálné importy jsou připravené pro Penny, Kaufland Teplice a Albert."
    )
    .replace(
      "Kaufland Teplice je napojený podle konkrétní pobočky. Albert zatím čeká na další import.",
      "Kaufland Teplice je napojený podle konkrétní pobočky. Albert je napojený z clean PDF importu supermarket/hypermarket."
    );
}

async function main() {
  const source = await readFile(APP_FILE, "utf8");
  let patched = replaceStoreCatalog(source);
  patched = patchInitialSelection(patched);
  patched = patchTexts(patched);

  await writeFile(APP_FILE, patched, "utf8");
  console.log("Patched app.js for Albert supermarket/hypermarket stores.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
