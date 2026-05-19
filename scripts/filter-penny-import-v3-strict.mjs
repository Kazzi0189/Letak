import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUTPUT_DIR = "data/penny-probe";
const V3_CANDIDATES_PATH = "data/penny-probe/penny-import-v3-probe-candidates.json";
const V3_SUMMARY_PATH = "data/penny-probe/penny-import-v3-probe-summary.json";

const BAD_PRODUCT_PATTERNS = [
  /^(SVĚTOVÝ DEN|KOKTEJLŮ|A VÍCE|ZNAČKA|NOVINKA|EXKLUZIVNĚ)$/iu,
  /^(SALÁM|ŠUNKA|PLÁTKY|KORUNA|KARLOVA|ŘEZNÍKŮV|TALÍŘ|MLÉČNÁ|ZMRZLINA|SANDWICH)$/iu,
  /^(GRILOVACÍ|UHLÍ|BRIKETY|SOLÁRNÍ|ZÁVĚSNÁ|PAPÍROVÉ|PROSTŘEDEK|NA MYTÍ|POVRCHŮ)$/iu,
  /^(MISTROVSKÁ|DUŠENÁ|ŠUNKOVÝ|PRAŽSKÁ|HERKULES|KLADENSKÁ|UZENÁ)$/iu,
  /^(JIHOČESKÝ|SEDLČANSKÝ|GOTHAJSKÝ|BIO SNACK|DRŮBEŽÍ|LÁZEŇSKÝ)$/iu,
  /\bID:\s*\d+/iu,
];

const CATEGORY_MISMATCH_RULES = [
  { category: /ovoce|zelenina|maso/iu, badProduct: /toaletní papír|ooops|káva|marila/iu },
  { category: /sladkosti|snacky/iu, badProduct: /pivo|bažant|relax|víno|veltlínské|frankovka|riesling|müller|nowaco/iu },
  { category: /nápoje|alkohol/iu, badProduct: /koči|pes|pistácie|rozinky|oříšky|kojenecká voda/iu },
  { category: /drogerie/iu, badProduct: /woolite.*299,90|gel na praní$/iu },
];

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadJsonSafe(path) {
  return readFile(path, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
}

function extractCandidates(container) {
  if (Array.isArray(container)) return container;
  if (Array.isArray(container?.offers)) return container.offers;
  if (Array.isArray(container?.candidates)) return container.candidates;
  return [];
}

function actionPriceLooksValid(price) {
  if (price == null) return false;
  const rounded = Math.round(Number(price) * 100);
  if (!Number.isFinite(rounded)) return false;

  const cents = rounded % 100;
  // Penny akční ceny jsou v tomto letáku prakticky vždy xx,90.
  // 00 necháváme pro případ celých korun, 99 pro obecnou kompatibilitu.
  return cents === 90 || cents === 99 || cents === 0;
}

function hasProductQuality(product) {
  const text = String(product ?? "").trim();
  if (text.length < 7 || text.length > 75) return false;

  const normalized = normalize(text);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length < 2) return false;

  if (BAD_PRODUCT_PATTERNS.some((pattern) => pattern.test(text))) return false;

  // Příliš obecné jednoslovné nebo fragmentové názvy.
  const strongTokens = tokens.filter((token) => token.length >= 4);
  if (strongTokens.length < 2 && !/\b\d+(?:[,.]\d+)?\s*(?:g|kg|ml|l|ks)\b/iu.test(text)) {
    return false;
  }

  // Kandidáti obsahující svislítka jsou často slepené s jednotkovou cenou.
  if (/[|<>]/u.test(text)) return false;

  // Podezřelé technické zbytky.
  if (/\b(?:1\s*kg|100\s*g|100\s*ml|1\s*l)\s+\d{1,4}[,.]\d{2}\s*Kč/iu.test(text)) return false;

  return true;
}

function categoryLooksOk(candidate) {
  const category = String(candidate.category ?? "");
  const product = String(candidate.product ?? "");
  const combined = `${product} ${candidate.priceText ?? ""}`;

  for (const rule of CATEGORY_MISMATCH_RULES) {
    if (rule.category.test(category) && rule.badProduct.test(combined)) {
      return false;
    }
  }

  return true;
}

function rejectReasons(candidate) {
  const reasons = [];

  if (candidate.confidence !== "high") {
    reasons.push("není high confidence z V3");
  }

  if (!actionPriceLooksValid(candidate.price)) {
    reasons.push("cena nevypadá jako akční cena Penny; pravděpodobně jednotková cena");
  }

  if (!candidate.priceText) {
    reasons.push("chybí priceText");
  }

  if (!candidate.packageSize) {
    reasons.push("chybí balení");
  }

  if (!hasProductQuality(candidate.product)) {
    reasons.push("název produktu je moc obecný, krátký, slepený nebo obsahuje podezřelé znaky");
  }

  if (!categoryLooksOk(candidate)) {
    reasons.push("kategorie neodpovídá produktu nebo jde o známý chybný vzor");
  }

  if (/záloha|nejnižší cena|používejte|před použitím/i.test(String(candidate.rawContext ?? ""))) {
    reasons.push("kontext obsahuje zálohu, nejnižší cenu nebo patičkový text");
  }

  // Woolite: víme, že správně už máme 199,90 na str. 35, kandidát 299,90 ze str. 24 nechceme pustit.
  if (/woolite/iu.test(String(candidate.product ?? "")) && Number(candidate.price) !== 199.9) {
    reasons.push("Woolite má v aktuálních ověřených datech jinou cenu; kandidát nepouštět automaticky");
  }

  // Ceny typu 253,12 / 21,07 / 6,08 jsou jasně jednotkové ceny z předchozího reportu.
  const cents = Math.round(Number(candidate.price ?? 0) * 100) % 100;
  if (![0, 90, 99].includes(cents)) {
    reasons.push("haléře neodpovídají běžné akční ceně, pravděpodobně jednotková cena");
  }

  return [...new Set(reasons)];
}

function simplify(candidate) {
  return {
    product: candidate.product,
    priceText: candidate.priceText,
    price: candidate.price,
    lowest30dPriceText: candidate.lowest30dPriceText ?? "",
    packageSize: candidate.packageSize ?? "",
    pageNumber: candidate.pageNumber,
    category: candidate.category ?? "",
    confidence: candidate.confidence,
  };
}

function groupByPage(items) {
  const map = new Map();
  for (const item of items) {
    const page = item.pageNumber ?? "unknown";
    if (!map.has(page)) map.set(page, []);
    map.get(page).push(item);
  }

  return Array.from(map.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([pageNumber, list]) => ({
      pageNumber,
      count: list.length,
      sample: list.slice(0, 30).map(simplify),
    }));
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const candidatesContainer = await loadJsonSafe(V3_CANDIDATES_PATH);
  const summaryContainer = await loadJsonSafe(V3_SUMMARY_PATH);
  const candidates = extractCandidates(candidatesContainer);

  const accepted = [];
  const rejected = [];

  for (const candidate of candidates) {
    const reasons = rejectReasons(candidate);
    if (reasons.length === 0) {
      accepted.push(candidate);
    } else {
      rejected.push({
        ...candidate,
        strictRejectReasons: reasons,
      });
    }
  }

  const report = {
    checkedAt: new Date().toISOString(),
    type: "JEN KONTROLNÍ REPORT – DO APLIKACE NENAHRÁVAT",
    summary: {
      inputCandidates: candidates.length,
      inputHighConfidence: candidates.filter((candidate) => candidate.confidence === "high").length,
      acceptedStrictCandidates: accepted.length,
      rejectedCandidates: rejected.length,
      rejectedFromHighConfidence: rejected.filter((candidate) => candidate.confidence === "high").length,
      sourceSummary: summaryContainer?.summary ?? null,
      recommendedPath:
        accepted.length > 0
          ? "manual-inspect-strict-accepted-before-any-data-patch"
          : "do-not-import-v3-candidates",
    },
    acceptedByPage: groupByPage(accepted),
    rejectedHighConfidenceSample: rejected
      .filter((candidate) => candidate.confidence === "high")
      .slice(0, 200)
      .map((candidate) => ({
        ...simplify(candidate),
        strictRejectReasons: candidate.strictRejectReasons,
      })),
    acceptedStrictCandidates: accepted,
  };

  await writeFile(`${OUTPUT_DIR}/penny-import-v3-strict-filter-summary.json`, JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(`${OUTPUT_DIR}/penny-import-v3-strict-filter-candidates.json`, JSON.stringify({
    meta: {
      generatedAt: new Date().toISOString(),
      type: "JEN KONTROLNÍ DATA – DO APLIKACE NENAHRÁVAT",
      source: V3_CANDIDATES_PATH,
      count: accepted.length,
      note: "Přísně filtrovaní kandidáti. Před importem je stále nutná ruční kontrola vzorku.",
    },
    offers: accepted,
  }, null, 2) + "\n", "utf8");

  console.log("Penny import V3 strict filter finished.");
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
