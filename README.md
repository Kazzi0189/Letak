# Letákový porovnávač – čistý GitHub základ

Tento balíček je vyčištěná verze repozitáře.

## Co zůstalo

- `index.html`, `app.js`, `styles.css`, `service-worker.js`, `manifest.webmanifest`
- `icons/`
- `data/offers.json` – aktuální sloučená data pro aplikaci
- `data/penny-pdf-pages.json` – text z Penny PDF letáku pro další kontrolní import
- `scripts/validate-offers.mjs`
- `scripts/audit-penny-pdf-full-import-v1.mjs`
- `.github/workflows/audit-penny-pdf-full-import-v1.yml`

## Co bylo odstraněno

Staré průzkumné workflow, debug JSONy, zálohy, dočasné reporty a staré experimentální importy. Tyto soubory nebyly nutné pro běh aplikace a dělaly v repozitáři zmatek.

## Důležité

`data/offers.json` už obsahuje dosavadní opravy hledání a dat, včetně opravy Prosecca z Penny:
- správná aktuální cena Penny Prosecco je `69,90 Kč`
- hodnota `< 59,90 Kč` z PDF je nejnižší cena za posledních 30 dní, ne aktuální cena

## Další krok

Spusť v GitHub Actions:

`Audit Penny PDF full import v1`

Výstup bude:

`data/penny-probe/penny-pdf-full-import-v1-summary.json`

Tento audit je pouze kontrolní a nic do aplikace neimportuje. Má ukázat, které stránky a položky z Penny PDF nejsou pokryté aktuálním `data/offers.json`, a připravit podklad pro nový kompletní Penny PDF import.
