import { readFile, writeFile } from "node:fs/promises";

const APP_FILE = "app.js";

const STORE_CATALOG_BLOCK = `const STORE_CATALOG = [
  { id: 'penny-default', chain: 'Penny', name: 'Penny – aktuální nabídky', address: 'celostátní / podle webu Penny', type: 'diskont', status: 'napojeno přes import Penny' },
  { id: 'kaufland-teplice-centrum', chain: 'Kaufland', name: 'Kaufland Teplice-Centrum', address: 'Čs. Dobrovolců 3356, 415 01 Teplice', type: 'hypermarket', status: 'napojeno přes import Kaufland Teplice' },
  { id: 'albert-supermarket', chain: 'Albert', name: 'Albert supermarket', address: 'aktuální supermarket leták Albert', type: 'supermarket', status: 'napojeno přes import Albert PDF V7 clean' },
  { id: 'albert-hypermarket', chain: 'Albert', name: 'Albert hypermarket', address: 'aktuální hypermarket leták Albert', type: 'hypermarket', status: 'napojeno přes import Albert PDF V7 clean' }
];`;

const DEFAULT_SELECTED_STORES_BLOCK = `function getInitialSelectedStoreIds() {
  const savedRaw = localStorage.getItem('selectedStoreIds');
  const saved = JSON.parse(savedRaw || '["penny-default","kaufland-teplice-centrum","albert-supermarket","albert-hypermarket"]');

  const migrated = saved
    .map((id) => (id === 'kaufland-demo' ? 'kaufland-teplice-centrum' : id))
    .map((id) => (id === 'albert-hyper-demo' ? 'albert-hypermarket' : id))
    .map((id) => (id === 'albert-super-demo' ? 'albert-supermarket' : id))
    .filter((id, index, array) => array.indexOf(id) === index);

  for (const requiredId of ['kaufland-teplice-centrum', 'albert-supermarket', 'albert-hypermarket']) {
    if (!migrated.includes(requiredId)) {
      migrated.push(requiredId);
    }
  }

  return migrated;
}`;

function replaceBlock(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Nepodařilo se najít blok pro úpravu: ${label}`);
  }

  return source.replace(pattern, replacement);
}

async function main() {
  let source = await readFile(APP_FILE, "utf8");

  source = replaceBlock(
    source,
    /const STORE_CATALOG = \[[\s\S]*?\];\s*function getInitialSelectedStoreIds\(\) \{[\s\S]*?\}\s*const state = /,
    `${STORE_CATALOG_BLOCK} ${DEFAULT_SELECTED_STORES_BLOCK} const state = `,
    "STORE_CATALOG a getInitialSelectedStoreIds"
  );

  source = source
    .replace(
      "return normalize(`${offer.product} ${offer.brand} ${offer.chain} ${offer.storeName} ${offer.packageSize}`).includes(query);",
      "return normalize(`${offer.product} ${offer.brand} ${offer.description || ''} ${offer.category || ''} ${offer.searchTerms || ''} ${offer.chain} ${offer.storeName} ${offer.packageSize}`).includes(query);"
    )
    .replace(/normalize\(offer\.product\)/g, "normalize(offer.compareKey || offer.product)")
    .replace(
      "Reálné importy jsou připravené pro Penny a Kaufland Teplice.",
      "Reálné importy jsou připravené pro Penny, Kaufland Teplice a Albert."
    )
    .replace(
      "Albert zatím čeká na další import.",
      "Albert je napojený přes supermarket a hypermarket PDF leták."
    );

  await writeFile(APP_FILE, source, "utf8");
  console.log("Patched app.js for Albert V7 clean import.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
