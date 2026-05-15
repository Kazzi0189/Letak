import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const OUTPUT_DIR = "data/albert-probe";
const IMPORT_OUTPUT = "data/albert-pdf-offers.json";
const CLEAN_IMPORT_OUTPUT = "data/albert-pdf-offers-clean.json";

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

const BAD_PRODUCT_PATTERNS = [
  /\bMASA\b/iu,
  /\bFANDÍME HOKEJI\b/iu,
  /\bBOD NAVÍC\b/iu,
  /\bKREDIT NAVÍC\b/iu,
  /\bNAVÍC\b/iu,
  /\bKTERÉ ZÍSKÁTE\b/iu,
  /\bPŘI KOUPI\b/iu,
  /\bAKCE NEJEN\b/iu,
  /\bNABÍDKA PRO NEJMENŠÍ\b/iu,
  /\bVE ZNAČKOVÉ KVALITĚ\b/iu,
  /\bNOVINKY\b/iu,
  /\bNEPORAZITELNÉ\b/iu,
  /\bBĚŽNÁ CENA\b/iu,
  /\bVÍCE AKCÍ\b/iu,
  /\bEXTRA LETÁK\b/iu,
  /\bSoutěž probíhá\b/iu,
  /\bwww\./iu,
  /\bTato nabídka\b/iu,
  /\bglutamanu sodného\b/iu,
  /\bstejného druhu\b/iu,
  /\bY O D R O K U\b/iu,
  /\bpotraviny\b/iu,
  /\bAKČNÍ NABÍDKA\b/iu,
  /\bSUPER CENA\b/iu,
  /\bHI T MĚSÍCE\b/iu,
  /\bPLATNÉM DO\b/iu,
  /\bNAŠE RECEPTURA\b/iu,
  /\bVYBER SI\b/iu,
  /\bVíce informací\b/iu,
];

const KNOWN_NOISE_PREFIXES = [
  "FANDÍME HOKEJI",
  "Nápoje 90 potraviny 29",
  "Nápoje",
  "NAVÍC 1 BOD",
  "BOD NAVÍC",
  "KREDIT NAVÍC",
  "PŘI KOUPI 2 ks A VÍCE 10990",
  "NABÍDKA PRO NEJMENŠÍ",
  "VE ZNAČKOVÉ KVALITĚ",
  "AKČNÍ NABÍDKA",
  "SUPER CENA",
  "NAŠE RECEPTURA",
];

const PRODUCT_STOPWORDS = new Set([
  "druhy",
  "nápoj",
  "voda",
  "víno",
  "potraviny",
  "svačinka",
  "impuls",
]);

async function downloadFile(url, outputPath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertPdfOffersV3/0.1; +https://github.com/)",
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
    .replace(/^[-•]\s*/, (match) => (match.includes("•") ? "• " : ""))
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
    .replace(/Kč/giu, "")
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

function normalizeComputedPrice(price) {
  if (price == null) return null;

  const rounded = Math.round(price * 100) / 100;
  const cents = Math.round((rounded - Math.floor(rounded)) * 100);

  if ([91, 92, 93, 94].includes(cents)) return Math.floor(rounded) + 0.9;
  if ([96, 97, 98, 99].includes(cents)) return Math.ceil(rounded);
  if ([1, 2, 3, 4].includes(cents)) return Math.floor(rounded);

  return rounded;
}

function extractPriceTexts(text) {
  return unique(
    normalizeText(text).match(/\b\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč|\b\d{1,4},-|\b\d{1,4}[,.]\d{2}\b|\b\d{2,4}\s*Kč\b/giu) || []
  );
}

function extractUnitPrice(text) {
  const match = normalizeText(text).match(
    /(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role|1\s*dávka|0,5\s*l)\s*(?:=|od|za)?\s*\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč/iu
  );

  if (!match) return null;

  const unitName = match[0].match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role|1\s*dávka|0,5\s*l)/iu)?.[0] ?? "";
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

  let price = null;

  if (/100\s*g|100\s*ml/iu.test(unit)) price = unitPrice * (amount / 100);
  else if (/1\s*kg|1\s*l/iu.test(unit)) price = unitPrice * (amount / 1000);
  else if (/0,5\s*l/iu.test(unit)) price = unitPrice * (amount / 500);
  else if (/1\s*ks|1\s*role|1\s*dávka/iu.test(unit)) price = unitPrice * amount;

  return normalizeComputedPrice(price);
}

function isMarketingLine(line) {
  return /^(NEPORAZITELNÉ|BĚŽNÁ CENA|BEZ|APLIKACE|NOVINKA|VÍCE AKCÍ|EXTRA LETÁK|PLATÍ|POUZE|www\.albert\.cz|Od \d|A$|▼|Tato nabídka|Nelze garantovat|produktů označených|NEPORA ZITELNÉ produkty|S APLIKACÍ|KUPÓNY|KREDITY|JEŠTĚ NEMÁTE|NABÍDKA PRO NEJMENŠÍ|VE ZNAČKOVÉ KVALITĚ|AKČNÍ NABÍDKA|SUPER CENA|NAŠE RECEPTURA|VYBER SI|HI T MĚSÍCE|PLATNÉM DO)/iu.test(line);
}

function isPriceOnlyLine(line) {
  return /^(\d{1,4}(?:[,.]\d{2})?|\d{1,4},-|[-+]?\d+\s*%|S \d+ BODY|Cena bez bodů:.*|\d{1,2}\s+\d{2})$/iu.test(line.trim());
}

function isBulletLine(line) {
  return /^\s*•/.test(line);
}

function stripNoisePrefixes(text) {
  let result = text;

  for (const prefix of KNOWN_NOISE_PREFIXES) {
    result = result.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "iu"), "");
  }

  return result.trim();
}

function cleanProductName(lines) {
  let text = lines
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .filter((line) => !isMarketingLine(line))
    .filter((line) => !isPriceOnlyLine(line))
    .join(" ")
    .replace(/\b(?:BEZ APLIKACE|APLIKACE|BĚŽNÁ CENA|NEPORAZITELNÉ|NOVINKA|VÍCE AKCÍ|EXTRA LETÁK)\b/giu, " ")
    .replace(/\b\d{1,4}[,.]\d{2}\b/g, " ")
    .replace(/\b\d{1,4},-\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = stripNoisePrefixes(text);

  text = text
    .replace(/^AKČNÍ NABÍDKA\s+/iu, "")
    .replace(/^NAŠE RECEPTURA\s+/iu, "")
    .replace(/^Nápoje\s+/iu, "")
    .replace(/^TR\s+O\s+/iu, "")
    .replace(/^L\s+(?=Hovězí\b)/u, "")
    .trim();

  if (text.length > 90) {
    const words = text.split(" ");
    text = words.slice(-7).join(" ");
  }

  return text.trim();
}

function looksLikeProductName(product) {
  if (!product || product.length < 3) return false;
  if (!/[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]/u.test(product)) return false;
  if (/^(od|do|kg|g|ml|l|ks|role|cena|za|bez|aplikace|vybrané druhy|různé druhy|nápoj|voda|víno|druhy)$/iu.test(product)) return false;
  if (/^\d/.test(product)) return false;
  if (/Kč|=|%/.test(product)) return false;

  const words = product.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length <= 2 && words.some((word) => PRODUCT_STOPWORDS.has(word))) return false;

  return true;
}

function extractDescription(bulletLines) {
  const parts = bulletLines
    .map((line) => normalizeLine(line).replace(/^•\s*/, ""))
    .filter(Boolean)
    .filter((line) => !extractPackageSize(line))
    .filter((line) => !extractUnitPrice(line))
    .filter((line) => extractPriceTexts(line).length === 0)
    .filter((line) => !/^(vybrané druhy|různé druhy|bez Aplikace|od \d|záloha|cena za|limitovaná edice|Francie|Itálie|Moldávie|Chile|Španělsko)$/iu.test(line));

  return parts.slice(0, 2).join("; ");
}

function explicitMainPriceFromBullet(bulletText, unitInfo) {
  const explicitPrices = extractPriceTexts(bulletText)
    .map((price) => ({ text: price, number: toNumber(price) }))
    .filter((item) => item.number != null && item.number > 0 && item.number < 10000)
    .filter((item) => !unitInfo?.unitPrice || Math.abs(item.number - unitInfo.unitPrice) > 0.001);

  if (!explicitPrices.length) return null;

  return normalizeComputedPrice(explicitPrices.at(-1).number);
}

function chooseMainPrice(bulletText, unitInfo, packageSize) {
  const explicit = explicitMainPriceFromBullet(bulletText, unitInfo);
  if (explicit != null) return explicit;

  const calculated = calculateMainPrice(unitInfo?.unitPrice ?? null, unitInfo?.unit ?? "", packageSize);
  if (calculated != null && calculated > 0 && calculated < 10000) return calculated;

  return null;
}

function countBulletMarks(value) {
  return (value.match(/•/g) ?? []).length;
}

function countPackageMentions(value) {
  return (value.match(/\b\d+(?:[,.]\d+)?(?:\s*[–-]\s*\d+(?:[,.]\d+)?)?\s*(?:g|kg|ml|l|ks|role|dávek)\b/giu) ?? []).length;
}

function countUnitMentions(value) {
  return (value.match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|1\s*role|1\s*dávka)\s*(?:=|od|za)?\s*\d/giu) ?? []).length;
}


function hasKnownMergedProductProblem(product, rawContext) {
  const text = `${product} ${rawContext}`;

  const knownMergedPatterns = [
    /Free From Trvanlivé mléko Albert Meruňky/iu,
    /Gambrinus Patron 12 Tiger Bohemia Chips/iu,
    /Staropramen 11 Havlík Tyčinky/iu,
    /Braník 10 Radegast Ratar Havlík Tyčinky/iu,
    /Mléčný řez Müllermilch Mléčný nápoj/iu,
    /Cornetto Müller Riso Protein/iu,
    /Proteinová tyčinka Ricola/iu,
    /Vodka Baileys Irish Cream/iu,
    /Kojenecká výživa BEBA Comfort Kojenecká výživa/iu,
    /Ovocná svačinka Hami Masozeleninový příkrm/iu,
    /Magnum pinta Míša Tvarohový mls/iu,
    /Milka Sušenky Chupa Chups/iu,
    /Heinz Fazole Knorr Jíška/iu,
    /Staropramen 11 Havlík Tyčinky/iu,
    /Strážnické brambůrky Březňák/iu,
    /Cornetto Müller Riso Protein/iu,
    /Mléčný řez Müllermilch Mléčný nápoj/iu,
    /Free From Trvanlivé mléko Albert Meruňky/iu,
    /Gambrinus Patron 12 Tiger Bohemia Chips/iu,
  ];

  return knownMergedPatterns.some((pattern) => pattern.test(text));
}

function hasHardMarketingNoise(product) {
  return /^(HI T MĚSÍCE|PLATNÉM DO|VYBER SI|AKČNÍ NABÍDKA|SUPER CENA|NAŠE RECEPTURA)|\\b(SUPER CENA|HI T MĚSÍCE|PLATNÉM DO|AKČNÍ NABÍDKA|VYBER SI|Více informací)\\b/iu.test(product);
}

function classifyQuality(product, price, unitInfo, packageSize, rawContext, bulletText) {
  const reasons = [];

  if (!unitInfo) reasons.push("chybí jednotková cena");
  if (!packageSize) reasons.push("chybí balení");
  if (product.length > 70) reasons.push("dlouhý název");
  if (BAD_PRODUCT_PATTERNS.some((pattern) => pattern.test(product))) reasons.push("šum v názvu");
  if (hasHardMarketingNoise(product)) reasons.push("marketingová fráze v názvu");
  if (hasKnownMergedProductProblem(product, rawContext)) reasons.push("známý slitý název/blok");
  if (/^&/u.test(product)) reasons.push("název začíná spojkou/znakem");
  if (/\b\d{1,2}\.\s*\d{1,2}\.\s*\d{4}\b/u.test(product)) reasons.push("datum v názvu");
  if (/\b(Maxi\+?\s+\d+\s*ks|Junior\s+\d+\s*ks)\b/iu.test(product)) reasons.push("parametry plen místo názvu");
  if (/^L\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/u.test(product)) reasons.push("zbytkové písmeno před názvem");
  if (/^TR\s+O\s+/iu.test(product)) reasons.push("zbytkový text před názvem");
  if (/^POŽITEK\b/iu.test(product)) reasons.push("reklamní slogan místo názvu");
  if (/^&/u.test(product)) reasons.push("neúplný název produktu");
  if (/\b(SUPER CENA|AKČNÍ NABÍDKA|NAŠE RECEPTURA|PLATNÉM DO|HI T MĚSÍCE|VYBER SI)\b/iu.test(product)) reasons.push("marketingová fráze v názvu");
  if (/Kč|=|%/.test(product)) reasons.push("cena v názvu");
  if (/\b\d{1,4}[,.]\d{2}\b/.test(product)) reasons.push("číslo/cena v názvu");
  if (/^[a-záčďéěíňóřšťúůýž]/u.test(product)) reasons.push("název nezačíná velkým písmenem");
  if (price == null || price <= 0) reasons.push("chybí cena");
  if (price != null && price < 2) reasons.push("podezřele nízká cena");
  if (product.split(/\s+/).length > 7) reasons.push("moc dlouhý/slitý název");
  if (countBulletMarks(rawContext) >= 5 && (countPackageMentions(rawContext) >= 2 || countUnitMentions(rawContext) >= 2)) reasons.push("možné sloučení více produktů");
  if (countPackageMentions(bulletText) >= 2 && countUnitMentions(bulletText) >= 2) reasons.push("více balení/jednotkových cen v jednom bloku");

  // Specifický signál pro alkohol/víno, kde PDF často vezme 0,75 l jako cenu, pokud chybí hlavní cena.
  if (price != null && price <= 1 && /0,75\s*l|víno|prosecco|sekt|frizzante/iu.test(rawContext)) {
    reasons.push("záměna objemu za cenu");
  }

  if (reasons.length) {
    return { confidence: "low", suspect: true, suspectReasons: unique(reasons) };
  }

  return { confidence: "medium", suspect: false, suspectReasons: [] };
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

    const nameLines = [];
    for (let j = bulletStart - 1; j >= 0 && nameLines.length < 5; j--) {
      const line = lines[j];

      if (!line || isBulletLine(line)) break;
      if (isMarketingLine(line) || isPriceOnlyLine(line)) continue;

      nameLines.unshift(line);

      if (nameLines.length >= 3) break;
    }

    const product = cleanProductName(nameLines);
    if (!looksLikeProductName(product)) continue;

    const price = chooseMainPrice(bulletText, unitInfo, packageSize);
    if (price == null || price <= 0 || price > 10000) continue;

    const description = extractDescription(bulletLines);
    const rawContext = [...nameLines, ...bulletLines].join(" ").slice(0, 650);
    const quality = classifyQuality(product, price, unitInfo, packageSize, rawContext, bulletText);

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
      unitPrice: unitInfo?.unitPrice ?? null,
      unit: unitInfo?.unit ?? "",
      unitText: unitInfo?.unitText ?? "",
      validFrom: "od st 13.05.2026",
      validTo: "do út 19.05.2026",
      priceType: /aplikace/iu.test(bulletText) ? "s aplikací / kartou" : "akční cena",
      pageNumber,
      imageUrl: "",
      pageImageUrl: "",
      imageType: "",
      sourceUrl: `${pdf.leafletUrl}page/${pageNumber}`,
      confidence: quality.confidence,
      suspect: quality.suspect,
      suspectReasons: quality.suspectReasons,
      rawContext,
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
        deduped.filter((offer) => !offer.suspect).length > 120
          ? "build-import-albert-from-pdf-v5-clean-only"
          : deduped.length > 60
            ? "inspect-pdf-offers-v3"
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
  const cleanOnly = combined.filter((offer) => !offer.suspect);

  const output = {
    meta: {
      source: "Albert PDF text via Publitas",
      updatedAt: new Date().toISOString(),
      count: combined.length,
      cleanCount: cleanOnly.length,
      suspectCount: combined.length - cleanOnly.length,
      parser: "scripts/extract-albert-pdf-offers-v5.mjs",
      note: "Průzkumný parser z PDF textu. V5 dál čistí clean-only výstup, přesouvá další marketingové a slité názvy do suspect a opravuje známé falešné názvy.",
    },
    offers: combined,
  };

  const cleanOutput = {
    meta: {
      ...output.meta,
      count: cleanOnly.length,
      cleanCount: cleanOnly.length,
      suspectCount: 0,
      note: "Jen položky bez suspect=true. Tento soubor je určený jako bezpečnější kandidát pro první napojení Alberta.",
    },
    offers: cleanOnly,
  };

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      totalOffers: combined.length,
      totalCleanOffers: cleanOnly.length,
      totalSuspectOffers: combined.length - cleanOnly.length,
      cleanOnlyOutput: CLEAN_IMPORT_OUTPUT,
      recommendedPath:
        cleanOnly.length > 180
          ? "turn-v5-clean-only-into-import-albert"
          : cleanOnly.length > 100
            ? "inspect-v5-clean-and-then-import-clean-only"
            : "needs-parser-improvement",
      leaflets: results.map((result) => ({
        id: result.pdf.id,
        type: result.pdf.type,
        title: result.pdf.title,
        ...result.summary,
      })),
    },
    cleanSampleOffers: cleanOnly.slice(0, 120),
    suspectSampleOffers: combined.filter((offer) => offer.suspect).slice(0, 160),
  };

  await writeFile(IMPORT_OUTPUT, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(CLEAN_IMPORT_OUTPUT, JSON.stringify(cleanOutput, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/albert-pdf-offers-v5-debug.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/pdf-offers-v5-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Albert PDF offers extraction v5 finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/pdf-offers-v5-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
