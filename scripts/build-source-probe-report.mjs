import { mkdir, readFile, writeFile } from "node:fs/promises";

const INPUT_DIR = "data/source-probe";
const OUTPUT_FILE = "data/source-probe/report.md";
const JSON_OUTPUT_FILE = "data/source-probe/report.json";

const CHAINS = ["penny", "kaufland", "albert", "lidl"];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function limitList(items, limit = 30) {
  return safeArray(items).slice(0, limit);
}

function formatLinkItem(item) {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const text = item.text ? ` — ${item.text}` : "";
    return `${item.href ?? ""}${text}`;
  }
  return String(item);
}

function section(title, lines) {
  return [`## ${title}`, "", ...lines, ""].join("\n");
}

function bulletList(items, emptyText = "Nenalezeno.") {
  if (!items || items.length === 0) return [`- ${emptyText}`];
  return items.map((item) => `- ${formatLinkItem(item)}`);
}

function ratingNote(result) {
  const rating = result?.technicalPotential?.rating ?? "unknown";
  const notes = safeArray(result?.technicalPotential?.notes);
  return [
    `- Technické hodnocení: **${rating}**`,
    `- HTTP stav: **${result?.status ?? "neznámý"}**`,
    `- Finální URL: ${result?.finalUrl ?? result?.sourceUrl ?? "neznámá"}`,
    `- Závislost na prodejně: **${result?.dependsOnStore ?? "unknown"}**`,
    ...notes.map((note) => `- ${note}`),
  ];
}

function buildRecommendedNextStep(result) {
  const chain = result.chain;
  const pdfCount = safeArray(result.pdfLinks).length;
  const viewerCount = safeArray(result.viewerLinks).length;
  const hasNextData = Boolean(result?.possibleData?.hasNextData);
  const endpointCount = safeArray(result?.possibleData?.endpointHints).length;

  if (!result.ok) {
    return `${chain}: Nejdřív opravit načítání stránky. Aktuálně selhalo s chybou: ${result.error ?? "neznámá chyba"}.`;
  }

  if (hasNextData) {
    return `${chain}: Priorita je rozebrat __NEXT_DATA__, protože může obsahovat strukturovaná data letáků nebo odkazy na ně.`;
  }

  if (endpointCount > 0) {
    return `${chain}: Priorita je prověřit endpoint hints, protože mohou vést na JSON/API data.`;
  }

  if (pdfCount > 0) {
    return `${chain}: Priorita je stáhnout PDF letáku a ověřit, zda z něj jde vytěžit text bez OCR.`;
  }

  if (viewerCount > 0) {
    return `${chain}: Priorita je otevřít viewer odkazy a hledat uvnitř datové JSON soubory nebo obrázky/PDF.`;
  }

  return `${chain}: Zatím nejasné. Potřebuje ruční kontrolu stránky nebo jiný zdroj.`;
}

async function main() {
  const details = [];

  for (const chain of CHAINS) {
    const file = `${INPUT_DIR}/${chain}.json`;

    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      details.push(parsed);
    } catch (error) {
      details.push({
        chain,
        ok: false,
        error: `Nelze přečíst ${file}: ${error instanceof Error ? error.message : String(error)}`,
        pdfLinks: [],
        viewerLinks: [],
        possibleData: {
          endpointHints: [],
          scriptJsonOrJsAssets: [],
          hasNextData: false,
          jsonLdCount: 0,
        },
        productLikeLines: [],
        sampleTextLines: [],
        sampleLinks: [],
        technicalPotential: {
          rating: "missing-detail-file",
          notes: [],
        },
      });
    }
  }

  const reportJson = {
    updatedAt: new Date().toISOString(),
    recommendations: details.map(buildRecommendedNextStep),
    chains: details.map((result) => ({
      chain: result.chain,
      ok: result.ok,
      rating: result?.technicalPotential?.rating ?? "unknown",
      status: result.status ?? null,
      sourceUrl: result.sourceUrl ?? null,
      finalUrl: result.finalUrl ?? null,
      dependsOnStore: result.dependsOnStore ?? "unknown",
      pdfLinks: limitList(result.pdfLinks, 20),
      viewerLinks: limitList(result.viewerLinks, 30),
      endpointHints: limitList(result?.possibleData?.endpointHints, 40),
      scriptJsonOrJsAssets: limitList(result?.possibleData?.scriptJsonOrJsAssets, 40),
      hasNextData: Boolean(result?.possibleData?.hasNextData),
      jsonLdCount: result?.possibleData?.jsonLdCount ?? 0,
      productLikeLines: limitList(result.productLikeLines, 40),
      sampleTextLines: limitList(result.sampleTextLines, 80),
      sampleLinks: limitList(result.sampleLinks, 40),
      error: result.error ?? null,
    })),
  };

  const md = [
    "# Přehled zdrojů letáků",
    "",
    `Vygenerováno: ${reportJson.updatedAt}`,
    "",
    "## Doporučený další postup",
    "",
    ...reportJson.recommendations.map((item) => `- ${item}`),
    "",
    ...details.map((result) => {
      const possibleData = result.possibleData ?? {};
      return section(result.chain, [
        ...ratingNote(result),
        "",
        "### PDF odkazy",
        ...bulletList(limitList(result.pdfLinks, 20)),
        "",
        "### Viewer / letákové odkazy",
        ...bulletList(limitList(result.viewerLinks, 30)),
        "",
        "### Možné endpointy / datové odkazy",
        ...bulletList(limitList(possibleData.endpointHints, 40)),
        "",
        "### JSON/JS assety",
        ...bulletList(limitList(possibleData.scriptJsonOrJsAssets, 40)),
        "",
        "### Ukázka produktových/cenových řádků",
        ...bulletList(limitList(result.productLikeLines, 40)),
        "",
        "### Ukázka textových řádků",
        ...bulletList(limitList(result.sampleTextLines, 60)),
      ]);
    }),
  ].join("\n");

  await mkdir(INPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, md + "\n", "utf8");
  await writeFile(JSON_OUTPUT_FILE, JSON.stringify(reportJson, null, 2) + "\n", "utf8");

  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`Wrote ${JSON_OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
