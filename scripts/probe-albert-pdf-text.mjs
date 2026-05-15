import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const OUTPUT_DIR = "data/albert-probe";

const PDFS = [
  {
    id: "20sm_akcni_letak",
    type: "supermarket",
    title: "Albert supermarket akční leták",
    pdfUrl:
      "https://view.publitas.com/90263/3054369/pdfs/24c390bb-c750-424c-968d-cd0ba0955889.pdf?response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27Albert%2520-%252020SM_akcni_letak.pdf",
  },
  {
    id: "20hm_akcni_letak",
    type: "hypermarket",
    title: "Albert hypermarket akční leták",
    pdfUrl:
      "https://view.publitas.com/90263/3054366/pdfs/86f6e4f5-04c7-4ba5-a2bd-588266f53987.pdf?response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27Albert%2520-%252020HM_akcni_letak.pdf",
  },
];

async function downloadFile(url, outputPath) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; LetakovyPorovnavacAlbertPdfProbe/0.1; +https://github.com/)",
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
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr}`));
        return;
      }

      resolve({ stdout, stderr });
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

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function toNumber(value) {
  if (!value) return null;

  const text = String(value)
    .replace(/\s+/g, "")
    .replace(/Kč/i, "")
    .replace(",-", ",00")
    .replace(",", ".")
    .replace(/[^\d.]/g, "");

  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function priceExamples(text) {
  return unique(
    normalizeText(text).match(/\b\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč|\b\d{1,4},-|\b\d{1,4}[,.]\d{2}\b/g) || []
  ).slice(0, 160);
}

function unitPriceExamples(text) {
  return unique(
    normalizeText(text).match(/(?:100\s*g|1\s*kg|1\s*l|100\s*ml|1\s*ks|100\s*ks|1\s*role)\s*(?:=|od|za)?\s*\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč/gi) || []
  ).slice(0, 160);
}

function productWords(text) {
  const normalized = normalizeText(text).toLowerCase();

  return [
    "máslo",
    "mléko",
    "sýr",
    "jogurt",
    "kuřecí",
    "káva",
    "rohlík",
    "banán",
    "brambory",
    "šunka",
    "pivo",
    "eidam",
    "tatra",
    "madeta",
    "birell",
    "gambrinus",
    "tchibo",
    "nescafé",
  ].filter((word) => normalized.includes(word));
}

function splitPages(text) {
  // pdftotext obvykle odděluje stránky form feedem.
  return String(text).split("\f").map((page) => normalizeText(page));
}

function snippetsAroundPrices(pageText, limit = 25) {
  const text = normalizeText(pageText);
  const matches = [...text.matchAll(/\b\d{1,4}(?:\s?\d{3})?[,.]\d{2}\s*Kč|\b\d{1,4},-/g)];
  const snippets = [];

  for (const match of matches.slice(0, limit)) {
    const index = match.index ?? 0;
    snippets.push(
      text
        .slice(Math.max(0, index - 160), Math.min(text.length, index + 220))
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  return unique(snippets);
}

function roughOfferCandidates(pageText, pageNumber, leaflet) {
  const text = normalizeText(pageText);
  const lines = text
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 5)).join(" ");
    const price = priceExamples(window).at(-1);
    const unit = unitPriceExamples(window).at(0);
    const packageSize = window.match(/\b\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks|role)\b/i)?.[0] ?? "";

    if (!price || !packageSize) continue;
    if (!/[A-Za-zÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž]/.test(window)) continue;

    candidates.push({
      leafletType: leaflet.type,
      pageNumber,
      priceText: price,
      price: toNumber(price),
      unitText: unit ?? "",
      packageSize,
      rawContext: window.slice(0, 500),
    });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.pageNumber}|${candidate.priceText}|${candidate.packageSize}|${candidate.rawContext.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function inspectPdf(pdf) {
  await mkdir(`${OUTPUT_DIR}/pdf`, { recursive: true });

  const pdfPath = `${OUTPUT_DIR}/pdf/${pdf.id}.pdf`;
  const txtPath = `${OUTPUT_DIR}/pdf/${pdf.id}.txt`;
  const layoutTxtPath = `${OUTPUT_DIR}/pdf/${pdf.id}-layout.txt`;

  const downloadInfo = await downloadFile(pdf.pdfUrl, pdfPath);

  await runCommand("pdftotext", ["-enc", "UTF-8", pdfPath, txtPath]);
  await runCommand("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, layoutTxtPath]);

  const text = await readFile(txtPath, "utf8");
  const layoutText = await readFile(layoutTxtPath, "utf8");
  const pages = splitPages(layoutText);

  const pageSummaries = pages.map((pageText, index) => {
    const pageNumber = index + 1;
    const prices = priceExamples(pageText);
    const unitPrices = unitPriceExamples(pageText);
    const candidates = roughOfferCandidates(pageText, pageNumber, pdf);

    return {
      pageNumber,
      textLength: pageText.length,
      productWords: productWords(pageText),
      priceExamples: prices.slice(0, 40),
      unitPriceExamples: unitPrices.slice(0, 40),
      priceCount: prices.length,
      unitPriceCount: unitPrices.length,
      snippets: snippetsAroundPrices(pageText, 15),
      roughOfferCandidatesCount: candidates.length,
      roughOfferCandidates: candidates.slice(0, 20),
    };
  });

  const allCandidates = pageSummaries.flatMap((page) => page.roughOfferCandidates);

  return {
    pdf,
    downloadInfo,
    summary: {
      pages: pages.length,
      textLength: text.length,
      layoutTextLength: layoutText.length,
      pagesWithPrices: pageSummaries.filter((page) => page.priceCount > 0).length,
      pagesWithUnitPrices: pageSummaries.filter((page) => page.unitPriceCount > 0).length,
      totalPriceExamples: unique(pageSummaries.flatMap((page) => page.priceExamples)).length,
      totalUnitPriceExamples: unique(pageSummaries.flatMap((page) => page.unitPriceExamples)).length,
      roughOfferCandidates: allCandidates.length,
      productWords: unique(pageSummaries.flatMap((page) => page.productWords)),
      recommendedPath:
        allCandidates.length > 80
          ? "build-pdf-text-parser"
          : allCandidates.length > 20
            ? "inspect-pdf-text-debug"
            : "pdf-text-not-enough-or-needs-layout-parser",
    },
    pageSummaries,
    sampleText: normalizeText(text).slice(0, 4000),
    sampleLayoutText: normalizeText(layoutText).slice(0, 4000),
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const results = [];

  for (const pdf of PDFS) {
    results.push(await inspectPdf(pdf));
  }

  const totalCandidates = results.reduce((sum, result) => sum + result.summary.roughOfferCandidates, 0);

  const summary = {
    checkedAt: new Date().toISOString(),
    summary: {
      totalRoughOfferCandidates: totalCandidates,
      recommendedPath:
        totalCandidates > 120
          ? "build-albert-parser-from-pdf-text"
          : totalCandidates > 30
            ? "inspect-pdf-text-debug-before-parser"
            : "pdf-text-not-enough-or-needs-rendering",
      leaflets: results.map((result) => ({
        id: result.pdf.id,
        type: result.pdf.type,
        title: result.pdf.title,
        ...result.summary,
      })),
    },
    samples: results.map((result) => ({
      id: result.pdf.id,
      type: result.pdf.type,
      sampleText: result.sampleText,
      sampleLayoutText: result.sampleLayoutText,
      pages: result.pageSummaries
        .filter((page) => page.priceCount > 0 || page.unitPriceCount > 0)
        .slice(0, 10),
    })),
  };

  await writeFile(`${OUTPUT_DIR}/albert-pdf-text-debug.json`, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/pdf-text-summary.json`, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("Albert PDF text probe finished.");
  console.log(JSON.stringify(summary.summary, null, 2));
  console.log(`Wrote ${OUTPUT_DIR}/pdf-text-summary.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
