NAHRÁT DO GITHUBU / REPOZITÁŘE

Tento ZIP je vyčištěný celý repozitář, ne pouze patch do aplikace.

Doporučený postup:
1. Stáhni a rozbal ZIP.
2. V GitHub repozitáři smaž staré zbytečné soubory, nebo nahraj obsah tohoto ZIPu jako nový čistý základ.
3. Zkontroluj, že v repozitáři zůstaly hlavně:
   - index.html
   - app.js
   - styles.css
   - service-worker.js
   - manifest.webmanifest
   - icons/
   - data/offers.json
   - data/penny-pdf-pages.json
   - scripts/validate-offers.mjs
   - scripts/audit-penny-pdf-full-import-v1.mjs
   - .github/workflows/audit-penny-pdf-full-import-v1.yml

4. Po nahrání spusť:
   Actions → Audit Penny PDF full import v1 → Run workflow

Důležité:
- Tento ZIP nahrazuje současný přeplněný GitHub stav.
- Staré probe/debug/workflow soubory nejsou potřeba.
- data/offers.json je přímo datový soubor pro aplikaci.
- data/penny-pdf-pages.json není pro aplikaci, ale je potřeba pro další kontrolní workflow.
