# Letákový porovnávač

První rychlá verze jako PWA pro GitHub Pages.

Cíl:

- otevřít aplikaci na telefonu přes URL,
- přidat ji na plochu jako aplikaci,
- načítat akční nabídky z `data/offers.json`,
- první importér je připravený pro Penny.

## Struktura

```text
.
├─ index.html
├─ app.js
├─ styles.css
├─ manifest.webmanifest
├─ service-worker.js
├─ data/
│  └─ offers.json
├─ scripts/
│  ├─ import-penny.mjs
│  └─ validate-offers.mjs
└─ .github/workflows/
   └─ update-penny.yml
```

## Lokální spuštění

```bash
npm install
npm run start
```

Pak otevři:

```text
http://localhost:8080
```

## Import Penny

```bash
npm run import:penny
```

Tím se aktualizuje:

```text
data/offers.json
```

Poznámka: importer čte veřejnou HTML stránku Penny. Když Penny změní strukturu webu, bude potřeba upravit `scripts/import-penny.mjs`.

## Nahrání na GitHub Pages

1. Vytvoř nový GitHub repozitář.
2. Nahraj do něj všechny soubory z této složky.
3. V GitHubu otevři **Settings → Pages**.
4. V části **Build and deployment** zvol:
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. Ulož.
6. Za chvíli GitHub ukáže veřejnou adresu aplikace.

## Automatická aktualizace Penny

V repozitáři je workflow:

```text
.github/workflows/update-penny.yml
```

Umí:

- spustit ručně přes **Actions → Update Penny offers → Run workflow**,
- spustit se automaticky každý den ráno,
- stáhnout data z Penny,
- uložit je do `data/offers.json`,
- commitnout změnu zpět do repozitáře.

## Přidání na plochu telefonu

Android / Chrome:

1. Otevři URL aplikace.
2. Klepni na menu `⋮`.
3. Zvol **Přidat na plochu** nebo **Nainstalovat aplikaci**.

Tím se aplikace bude chovat podobně jako běžná mobilní aplikace.
