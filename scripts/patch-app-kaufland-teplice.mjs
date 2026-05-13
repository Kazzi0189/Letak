import { readFile, writeFile } from "node:fs/promises";

const APP_FILE = "app.js";

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Nenalezen blok pro úpravu: ${label}`);
  }

  return source.replace(search, replacement);
}

async function main() {
  let app = await readFile(APP_FILE, "utf8");

  app = replaceRequired(
    app,
    `  {
    id: 'kaufland-demo',
    chain: 'Kaufland',
    name: 'Kaufland – demo pobočka',
    address: 'bude napojeno podle konkrétní prodejny',
    type: 'hypermarket',
    status: 'čeká na import konkrétní prodejny'
  },`,
    `  {
    id: 'kaufland-teplice-centrum',
    chain: 'Kaufland',
    name: 'Kaufland Teplice-Centrum',
    address: 'Čs. Dobrovolců 3356, 415 01 Teplice',
    type: 'hypermarket',
    status: 'napojeno přes import Kaufland Teplice'
  },`,
    "Kaufland demo pobočka"
  );

  app = replaceRequired(
    app,
    `];

const state = {`,
    `];

function getInitialSelectedStoreIds() {
  const savedRaw = localStorage.getItem('selectedStoreIds');
  const saved = JSON.parse(savedRaw || '["penny-default","kaufland-teplice-centrum"]');

  const migrated = saved
    .map((id) => (id === 'kaufland-demo' ? 'kaufland-teplice-centrum' : id))
    .filter((id, index, array) => array.indexOf(id) === index);

  if (!migrated.includes('kaufland-teplice-centrum')) {
    migrated.push('kaufland-teplice-centrum');
  }

  return migrated;
}

const state = {`,
    "funkce getInitialSelectedStoreIds"
  );

  app = replaceRequired(
    app,
    `  selectedStoreIds: JSON.parse(localStorage.getItem('selectedStoreIds') || '["penny-default"]'),`,
    `  selectedStoreIds: getInitialSelectedStoreIds(),`,
    "výchozí vybrané prodejny"
  );

  app = app.replace(
    "Vyber prodejny, hledej akční produkty a skládej si košíky podle obchodů. První reálný import je připravený pro Penny.",
    "Vyber prodejny, hledej akční produkty a skládej si košíky podle obchodů. Reálné importy jsou připravené pro Penny a Kaufland Teplice."
  );

  app = app.replace(
    "Kaufland a Albert budeme později tahat podle konkrétní prodejny. Penny je první napojený zdroj.",
    "Kaufland Teplice je napojený podle konkrétní pobočky. Albert zatím čeká na další import."
  );

  await writeFile(APP_FILE, app, "utf8");

  console.log("app.js updated: Kaufland demo replaced by Kaufland Teplice-Centrum.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
