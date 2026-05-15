import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/albert-probe";
const IMPORT_OUTPUT = "data/albert-pdf-offers.json";

const PDFS = [
  {
    id: "20sm_akcni_letak",
    type: "supermarket",
    title: "Albert supermarket akční leták",
    storeId: "albert-supermarket",
    storeName: "Albert supermarket",
    pdfUrl:
      "https://view.publitas.com/90263/3054369/pdfs/24c390bb-c750-424c-968d-cd0ba0955889.pdf?response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27Albert%2520-%252020SM_akcni_letak.pdf",
    leafletUrl: "https://letaky.albert.cz/20sm_akcni_letak/",
  },
  {
    id: "20hm_akcni_letak",
    type: "hypermarket",
    title: "Albert hypermarket akční leták",
    storeId: "albert-hypermarket",
    storeName: "Albert hypermarket",
    pdfUrl:
      "https://view.publitas.com/90263/3054366/pdfs/86f6e4f5-04c7-4ba5-a2bd-588266f53987.pdf?response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27Albert%2520-%252020HM_akcni_letak.pdf",
    leafletUrl: "https://letaky.albert.cz/20hm_akcni_letak/",
  },
];

async function downloadFile(url, outputPath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertPdfOffersV1/0.1; +https://github.com/)",
      accept: "application/pdf,application/octet-stream,*/*",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  await pipeline(response.body, createWriteStream(outputPath));

  return {
    finalUrl: response.url,
    contentType: response.headers.get("content-type") ?? "",
    contentLength: response.headers.get("content-length") ?? "",
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function normalizeText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[–—]/g, "–")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .trim();
}

function normalizeLine(value = "") {
  return normalizeText(value)
    .replace(/^[-•]\s*/, (m) => (m.includes("•") ? "• " : ""))
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function hashId(parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function splitPages(text) {
  return String(text).split("\f").map((page) => normalizeText(page));
}

function cleanMoney(value = "") {
  return String(value)
    .replace(/\s+/g, "")
    .replace(/Kč/gi, "")
    .replace(",-", ",00")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");
}

function toNumber(value) {
  const number = Number(cleanMoney(value));
  return Number.isFinite(number) ? number : null;
}

function moneyText(number) {
  if (number == null) return "";
  return number.toLocaleString("cs-CZ", {
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  }) + " Kč";
}

function extractPriceTexts(text) {
  return unique(
    normalizeText(text).match(/\b\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč|\b\d{1,4},-|\b\d{1,4}[,.]\d{2}\b/g) || []
  );
}

function extractUnitPrice(text) {
  const match = normalizeText(text).match(
    /(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role|1\s*dávka)\s*(?:=|od|za)?\s*\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč/iu
  );

  if (!match) return null;

  const unitName = match[0].match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role|1\s*dávka)/iu)?.[0] ?? "";
  const priceText = match[0].match(/\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč/iu)?.[0] ?? "";

  return {
    unit: unitName ? `Kč/${unitName.replace(/\s+/g, " ")}` : "",
    unitPrice: toNumber(priceText),
    unitText: match[0],
  };
}

function extractPackageSize(text) {
  const packagePatterns = [
    /\b\d+\s*[×x]\s*\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks|role|dávek)\b/iu,
    /\b\d+(?:[,.]\d+)?(?:\s*[–-]\s*\d+(?:[,.]\d+)?)?\s*(?:g|kg|ml|l|ks|role|dávek)\b/iu,
  ];

  for (const pattern of packagePatterns) {
    const match = normalizeText(text).match(pattern);
    if (match) return match[0].replace(/\s+/g, " ");
  }

  return "";
}

function amountForUnit(packageSize = "") {
  const text = packageSize.toLowerCase().replace(",", ".");
  const multi = text.match(/(\d+)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(?:[–-]\s*(\d+(?:\.\d+)?))?\s*(g|kg|ml|l|ks|role|dávek)/iu);
  if (multi) {
    const count = Number(multi[1]);
    const amount = Number(multi[3] || multi[2]);
    const unit = multi[4];

    if (unit === "kg" || unit === "l") return count * amount * 1000;
    return count * amount;
  }

  const single = text.match(/(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?\s*(g|kg|ml|l|ks|role|dávek)/iu);
  if (!single) return null;

  const amount = Number(single[2] || single[1]);
  const unit = single[3];

  if (unit === "kg" || unit === "l") return amount * 1000;
  return amount;
}

function calculateMainPrice(unitPrice, unit, packageSize) {
  if (unitPrice == null || !unit || !packageSize) return null;

  const amount = amountForUnit(packageSize);
  if (!amount) return null;

  if (/100\s*g|100\s*ml/iu.test(unit)) return Math.round(unitPrice * (amount / 100) * 100) / 100;
  if (/1\s*kg|1\s*l/iu.test(unit)) return Math.round(unitPrice * (amount / 1000) * 100) / 100;
  if (/1\s*ks|1\s*role|1\s*dávka/iu.test(unit)) return Math.round(unitPrice * amount * 100) / 100;

  return null;
}

function isMarketingLine(line) {
  return /^(NEPORAZITELNÉ|BĚŽNÁ CENA|BEZ|APLIKACE|NOVINKA|VÍCE AKCÍ|EXTRA LETÁK|PLATÍ|POUZE|www\.albert\.cz|Od \d|A$|▼|Tato nabídka|Nelze garantovat|produktů označených|NEPORA ZITELNÉ produkty)/iu.test(line);
}

function isPriceOnlyLine(line) {
  return /^(\d{1,4}(?:[,.]\d{2})?|\d{1,4},-|[-+]?\d+\s*%|S \d+ BODY|Cena bez bodů:.*)$/iu.test(line.trim());
}

function isBulletLine(line) {
  return /^\s*•/.test(line);
}

function cleanProductName(lines) {
  let text = lines
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .filter((line) => !isMarketingLine(line))
    .filter((line) => !isPriceOnlyLine(line))
    .join(" ")
    .replace(/\b(?:BEZ APLIKACE|APLIKACE|BĚŽNÁ CENA|NEPORAZITELNÉ|NOVINKA|VÍCE AKCÍ|EXTRA LETÁK)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // U víceslovných názvů ponecháme rozumný rozsah, ale ne usekneme značku.
  if (text.length > 90) {
    const words = text.split(" ");
    text = words.slice(-8).join(" ");
  }

  return text;
}

function looksLikeProductName(product) {
  if (!product || product.length < 3) return false;
  if (!/[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]/u.test(product)) return false;
  if (/^(od|do|kg|g|ml|l|ks|role|cena|za|bez|aplikace|vybrané druhy|různé druhy)$/iu.test(product)) return false;
  if (/^\d/.test(product)) return false;
  if (/Kč|=|%/.test(product)) return false;
  return true;
}

function extractDescription(bulletLines) {
  const parts = bulletLines
    .map((line) => normalizeLine(line).replace(/^•\s*/, ""))
    .filter(Boolean)
    .filter((line) => !extractPackageSize(line))
    .filter((line) => !extractUnitPrice(line))
    .filter((line) => extractPriceTexts(line).length === 0)
    .filter((line) => !/^(vybrané druhy|různé druhy|bez Aplikace|od \d|záloha|cena za)/iu.test(line));

  return parts.slice(0, 2).join("; ");
}

function chooseMainPrice(bulletText, unitInfo, packageSize) {
  const explicitPrices = extractPriceTexts(bulletText)
    .map((price) => ({ text: price, number: toNumber(price) }))
    .filter((item) => item.number != null && item.number > 0 && item.number < 10000);

  // Ceny v řádcích s jednotkovou cenou jsou jen jednotkové ceny.
  const nonUnitPrices = explicitPrices.filter((item) => {
    if (!unitInfo?.unitPrice) return true;
    return Math.abs(item.number - unitInfo.unitPrice) > 0.001;
  });

  // Preferujeme cenu uvedenou jako samostatná cena produktu v bulletu.
  const finalExplicit = nonUnitPrices.at(-1);
  if (finalExplicit) return finalExplicit.number;

  // Jinak dopočet z jednotkové ceny a balení.
  const calculated = calculateMainPrice(unitInfo?.unitPrice ?? null, unitInfo?.unit ?? "", packageSize);
  if (calculated != null && calculated > 0 && calculated < 10000) return calculated;

  return null;
}

function parsePage(pageText, pageNumber, pdf) {
  const lines = normalizeText(pageText)
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean);

  const offers = [];

  for (let i = 0; i < lines.length; i++) {
    if (!isBulletLine(lines[i])) continue;

    const bulletStart = i;
    const bulletLines = [];

    while (i < lines.length && isBulletLine(lines[i])) {
      bulletLines.push(lines[i]);
      i += 1;
    }

    const bulletText = bulletLines.join(" ");
    const packageSize = extractPackageSize(bulletText);
    const unitInfo = extractUnitPrice(bulletText);

    if (!packageSize && !unitInfo) continue;

    // Název bývá 1–4 řádky před první odrážkou.
    const nameLines = [];
    for (let j = bulletStart - 1; j >= 0 && nameLines.length < 5; j--) {
      const line = lines[j];

      if (!line || isBulletLine(line)) break;
      if (isMarketingLine(line) || isPriceOnlyLine(line)) continue;

      nameLines.unshift(line);

      // U většiny produktů stačí 1–3 řádky; když narazíme na slovo začínající velkým písmenem, můžeme skončit.
      if (nameLines.length >= 3) break;
    }

    const product = cleanProductName(nameLines);
    if (!looksLikeProductName(product)) continue;

    const price = chooseMainPrice(bulletText, unitInfo, packageSize);
    if (price == null || price <= 0 || price > 10000) continue;

    const description = extractDescription(bulletLines);
    const unitPrice = unitInfo?.unitPrice ?? null;
    const unit = unitInfo?.unit ?? "";
    const unitText = unitInfo?.unitText ?? "";
    const sourceUrl = `${pdf.leafletUrl}page/${pageNumber}`;

    const suspectReasons = [];
    if (!unitInfo) suspectReasons.push("chybí jednotková cena");
    if (!packageSize) suspectReasons.push("chybí balení");
    if (product.length > 70) suspectReasons.push("dlouhý název");
    if (/NEPORAZITELNÉ|BĚŽNÁ CENA|APLIKACE|Kč|%/.test(product)) suspectReasons.push("šum v názvu");

    offers.push({
      id: `albert-${pdf.type}-${hashId([pdf.type, pageNumber, product, packageSize, price])}`,
      chain: "Albert",
      storeId: pdf.storeId,
      storeName: pdf.storeName,
      leafletType: pdf.type,
      product,
      brand: "",
      description,
      packageSize,
      price,
      priceText: moneyText(price),
      unitPrice,
      unit,
      unitText,
      validFrom: "od st 13.05.2026",
      validTo: "do út 19.05.2026",
      priceType: /aplikace/iu.test(bulletText) ? "s aplikací / kartou" : "akční cena",
      pageNumber,
      imageUrl: "",
      pageImageUrl: "",
      imageType: "",
      sourceUrl,
      confidence: suspectReasons.length ? "low" : "medium",
      suspect: suspectReasons.length > 0,
      suspectReasons,
      rawContext: [...nameLines, ...bulletLines].join(" ").slice(0, 500),
    });
  }

  return offers;
}

function dedupeOffers(offers) {
  const seen = new Set();
  const result = [];

  for (const offer of offers) {
    const key = `${offer.storeId}|${offer.product.toLowerCase()}|${offer.packageSize.toLowerCase()}|${offer.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(offer);
  }

  return result;
}

async function inspectPdf(pdf) {
  await mkdir(`${OUTPUT_DIR}/pdf`, { recursive: true });

  const pdfPath = `${OUTPUT_DIR}/pdf/${pdf.id}.pdf`;
  const txtPath = `${OUTPUT_DIR}/pdf/${pdf.id}.txt`;

  const downloadInfo = await downloadFile(pdf.pdfUrl, pdfPath);

  await runCommand("pdftotext", ["-enc", "UTF-8", pdfPath, txtPath]);

  const text = await readFile(txtPath, "utf8");
  const pages = splitPages(text);

  const pageResults = [];
  const allOffers = [];

  for (let index = 0; index < pages.length; index++) {
    const pageNumber = index + 1;
    const pageText = pages[index];
    const offers = parsePage(pageText, pageNumber, pdf);

    pageResults.push({
      pageNumber,
      textLength: pageText.length,
      offersCount: offers.length,
      cleanOffersCount: offers.filter((offer) => !offer.suspect).length,
      suspectOffersCount: offers.filter((offer) => offer.suspect).length,
      offersPreview: offers.slice(0, 20),
    });

    allOffers.push(...offers);
  }

  const deduped = dedupeOffers(allOffers);

  return {
    pdf,
    downloadInfo,
    summary: {
      pages: pages.length,
      offersBeforeDedupe: allOffers.length,
      offersAfterDedupe: deduped.length,
      cleanOffers: deduped.filter((offer) => !offer.suspect).length,
      suspectOffers: deduped.filter((offer) => offer.suspect).length,
      pagesWithOffers: pageResults.filter((page) => page.offersCount > 0).length,
      recommendedPath:
        deduped.filter((offer) => !offer.suspect).length > 50
          ? "build-import-albert-from-pdf-v1"
          : deduped.length > 30
            ? "inspect-pdf-offers-v1"
            : "needs-parser-improvement",
    },
    pages: pageResults,
    offers: deduped,
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const results = [];

  for (const pdf of PDFS) {
    results.push(await inspectPdf(pdf));
  }

  const allOffers = results.flatMap((result) => result.offers);
  const combined = dedupeOffers(allOffers);

  const output = {
    meta: {
      source: "Albert PDF text via Publitas",
      updatedAt: new Date().toISOString(),
      count: combined.length,
      parser: "scripts/extract-albert-pdf-offers-v1.mjs",
      note: "Průzkumný parser z PDF textu. Před ostrým napojením zkontrolovat clean/suspect ukázky.",
    },
    offers: combined,
  };

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      totalOffers: combined.length,
      totalCleanOffers: combined.filter((offer) => !offer.suspect).length,
      totalSuspectOffers: combined.filter((offer) => offer.suspect).length,
      recommendedPath:
        combined.filter((offer) => !offer.suspect).length > 80
          ? "turn-v1-into-import-albert"
          : combined.length > 40
            ? "inspect-and-tighten-v1"
            : "needs-parser-improvement",
      leaflets: results.map((result) => ({
        id: result.pdf.id,
        type: result.pdf.type,
        title: result.pdf.title,
        ...result.summary,
      })),
    },
    cleanSampleOffers: combined.filter((offer) => !offer.suspect).slice(0, 120),
    suspectSampleOffers: combined.filter((offer) => offer.suspect).slice(0, 80),
  };

  await writeFile(IMPORT_OUTPUT, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/albert-pdf-offers-v1-debug.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/pdf-offers-v1-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Albert PDF offers extraction v1 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/pdf-offers-v1-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
