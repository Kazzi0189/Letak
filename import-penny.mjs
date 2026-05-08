import { load } from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';
import crypto from 'node:crypto';

const SOURCE_URL = 'https://www.penny.cz/nabidky';
const OUT_FILE = new URL('../data/offers.json', import.meta.url);

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const clean = String(value)
    .replace(/Kč|CZK|,/gi, (match) => (match === ',' ? '.' : ''))
    .replace(/[^0-9.]/g, '');
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}

function idFrom(...parts) {
  return crypto.createHash('sha1').update(parts.map((part) => String(part || '')).join('|')).digest('hex').slice(0, 16);
}

function parsePriceFromText(raw) {
  const value = text(raw);
  const match = value.match(/(\d{1,4})\s*[,.]\s*(\d{1,2})\s*K[cč]/i) || value.match(/(\d{1,4})\s*K[cč]/i);
  if (!match) return null;
  if (match[2]) return Number(`${match[1]}.${match[2].padEnd(2, '0')}`);
  return Number(match[1]);
}

function parseUnitPrice(raw) {
  const value = text(raw);
  const match = value.match(/(?:1\s*)?(kg|g|l|ml|ks)\s*[/ ]?\s*(\d{1,5}[,.]\d{1,2}|\d{1,5})\s*K[cč]/i)
    || value.match(/(\d{1,5}[,.]\d{1,2}|\d{1,5})\s*K[cč]\s*\/\s*(kg|g|l|ml|ks)/i);
  if (!match) return { unitPrice: null, unit: '' };
  if (Number.isNaN(Number(match[1].replace?.(',', '.')))) {
    return { unitPrice: toNumber(match[2]), unit: `Kč/${match[1].toLowerCase()}` };
  }
  return { unitPrice: toNumber(match[1]), unit: `Kč/${match[2].toLowerCase()}` };
}

function parsePackageSize(raw) {
  const value = text(raw);
  const match = value.match(/(?:^|\s)(\d+(?:[,.]\d+)?)\s*(kg|g|l|ml|ks|balení|bal\.)\b/i);
  return match ? `${match[1].replace('.', ',')} ${match[2]}` : '';
}

function parseValidTo(raw) {
  const value = text(raw);
  const range = value.match(/(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})\s*[–\-]\s*(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/);
  if (range) return text(range[2]);
  const until = value.match(/(?:do|platí do)\s*(\d{1,2}\.\s*\d{1,2}\.?\s*(?:\d{4})?)/i);
  return until ? text(until[1]) : '';
}

function cleanProductName(candidate) {
  return text(candidate)
    .replace(/\b\d{1,4}\s*[,.]\s*\d{1,2}\s*K[cč]\b/gi, '')
    .replace(/\b\d{1,4}\s*K[cč]\b/gi, '')
    .replace(/\b\d+(?:[,.]\d+)?\s*(kg|g|l|ml|ks)\b/gi, '')
    .replace(/Platí.*$/i, '')
    .trim();
}

function parseOffersFromHtml(html) {
  const $ = load(html);
  const candidates = [];

  const selectors = [
    '[data-testid*=product]',
    '[class*=product]',
    '[class*=Product]',
    '[class*=offer]',
    '[class*=Offer]',
    'article',
    'li'
  ];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const block = text($(element).text());
      if (!/K[cč]/i.test(block)) return;
      if (block.length < 15 || block.length > 900) return;
      candidates.push({ block, html: $.html(element) });
    });
  }

  const uniqueBlocks = [...new Map(candidates.map((item) => [item.block, item])).values()];

  const offers = uniqueBlocks.map((candidate) => {
    const $$ = load(candidate.html);
    const heading = text($$('h1,h2,h3,h4,[class*=title],[class*=Title],[class*=name],[class*=Name]').first().text());
    const price = parsePriceFromText(candidate.block);
    const packageSize = parsePackageSize(candidate.block);
    const { unitPrice, unit } = parseUnitPrice(candidate.block);
    const validTo = parseValidTo(candidate.block);
    let product = cleanProductName(heading) || cleanProductName(candidate.block.split(/\d{1,4}\s*[,.]?\s*\d{0,2}\s*K[cč]/i)[0]);

    if (!product || product.length < 2 || price === null) return null;
    if (product.length > 90) product = product.slice(0, 90).trim();

    return {
      id: `penny-${idFrom(product, packageSize, price, validTo)}`,
      storeId: 'penny-default',
      chain: 'Penny',
      storeName: 'Penny – aktuální nabídky',
      product,
      brand: '',
      packageSize,
      price,
      unitPrice: unitPrice || null,
      unit: unit || '',
      validTo,
      priceType: /kart|app|aplikac/i.test(candidate.block) ? 'kartová / aplikační cena' : 'akční cena',
      sourceUrl: SOURCE_URL
    };
  }).filter(Boolean);

  return [...new Map(offers.map((offer) => [offer.id, offer])).values()];
}

async function main() {
  console.log(`Stahuji ${SOURCE_URL}`);
  const response = await fetch(SOURCE_URL, {
    headers: {
      'user-agent': 'Mozilla/5.0 letakovy-porovnavac/0.1',
      'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8'
    }
  });

  if (!response.ok) throw new Error(`Penny odpovědělo HTTP ${response.status}`);

  const html = await response.text();
  const offers = parseOffersFromHtml(html);

  if (offers.length === 0) {
    throw new Error('Nepodařilo se najít žádné nabídky. Web Penny pravděpodobně změnil HTML strukturu nebo blokuje import.');
  }

  const payload = {
    meta: {
      source: SOURCE_URL,
      updatedAt: new Date().toISOString(),
      count: offers.length,
      parser: 'scripts/import-penny.mjs'
    },
    offers
  };

  await mkdir(new URL('../data', import.meta.url), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Uloženo ${offers.length} nabídek do data/offers.json`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
