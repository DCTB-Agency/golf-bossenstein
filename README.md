# Bossenstein 3D

3D-weergave van het Championship-parcours van Bossenstein Golf & Polo Club (Broechem), als basis voor een golf-app met GPS-afstanden en scorekaart.

## Online

De app staat op **https://dctb-agency.github.io/golf-bossenstein/**. Elke push naar `main` bouwt en publiceert automatisch (zie `.github/workflows/pages.yml`). GPS werkt daar, want de site draait op HTTPS.

## Starten

```bash
npm install
npm run dev
```

Open http://localhost:5173 (of het netwerkadres dat Vite toont; GPS op een gsm vereist HTTPS).

## Wat zit erin

- **Luchtfoto**: zomeropname 2024 van Digitaal Vlaanderen in 16 tegels van 2048 px (±18 cm/px), opgefrist en verscherpt. Op gsm wordt een lichtere variant (1024 px per tegel) geladen.
- **Terrein**: hoogtemodel DHMV II DTM 1 m, raster van 1025×1025 punten (±1,4 m), 1,6× verticaal overdreven. Van dichtbij komt er een fijne grastextuur bij.
- **Gebouwen**: 489 officiële GRB-contouren. Muren lopen tot de dakgoot en nok- en goothoogte komen uit DSM − DTM. Rechthoekige gebouwen met een hellend dak krijgen een zadeldak. Op de daken ligt de echte luchtfoto.
- **Bomen**: ±3900 bomen op hun echte plek, met hoogte en kroonbreedte uit DSM − DTM en kleur uit de zomerfoto. Naaldbomen (smalle, hoge kronen) staan als kegels, loofbomen als organische kronen.
- **Omgeving**: zonnehemel met omgevingslicht, zachte schaduwen die met de camera meebewegen, en water dat de lucht weerspiegelt.
- **Holes**: par, SI, lengtes van de 4 tees en CR/SR in `src/holes.json`, met de posities van tee, knik en green zoals nagekeken in de editor.
- **GPS**: de knop 📍 toont je positie en de afstand tot de green.

## Holes intekenen

1. Klik op **✎ Intekenen**, kies een hole en klik op **Tee plaatsen** of **Green plaatsen**. Klik daarna op de kaart. Een dogleg geef je aan met **+ Knikpunt**.
2. Je wijzigingen worden in de browser bewaard (localStorage).
3. Met **Exporteer JSON** neem je ze over in `src/holes.json` en commit je ze.

## Data opnieuw opbouwen

Ruwe bronnen staan in `raw/` (tif-bestanden en tegels worden niet in git bewaard). Zie de download-URL's in `scripts/build-data.mjs`. Daarna:

```bash
npm run data
```

Bronnen: Luchtfoto & hoogtemodel © Digitaal Vlaanderen (CC-BY 4.0) · Kaartdata © OpenStreetMap-bijdragers (ODbL).
