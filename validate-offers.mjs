import { readFile } from 'node:fs/promises';

const file = new URL('../data/offers.json', import.meta.url);
const payload = JSON.parse(await readFile(file, 'utf8'));

if (!payload || !Array.isArray(payload.offers)) {
  throw new Error('data/offers.json musí obsahovat pole offers');
}

for (const [index, offer] of payload.offers.entries()) {
  for (const key of ['id', 'storeId', 'chain', 'storeName', 'product', 'price']) {
    if (offer[key] === undefined || offer[key] === null || offer[key] === '') {
      throw new Error(`Nabídka #${index + 1} nemá povinné pole ${key}`);
    }
  }
}

console.log(`OK: ${payload.offers.length} nabídek`);
