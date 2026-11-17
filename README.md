# Bossenstein 3D

3D-weergave van het Championship-parcours van Bossenstein Golf & Polo Club (Broechem), als basis voor een golf-app met GPS-afstanden en scorekaart.

## Starten

```bash
npm install
npm run dev
```

Open http://localhost:5173 (of het netwerkadres dat Vite toont; GPS op een gsm vereist HTTPS).

## Wat zit erin

- **Terrein**: hoogtemodel DHMV II DTM 1 m van Digitaal Vlaanderen, 3× verticaal overdreven (het parcours loopt van 8 tot 23 m).
- **Luchtfoto**: orthofoto van Digitaal Vlaanderen (winteropname, 4096 px over ~1,5 km).
- **Bomen**: ongeveer 4.350 bomen op hun echte positie en hoogte, berekend als DSM − DTM.
- **Water, gebouwen en terreingrens**: OpenStreetMap.
- **Holes**: par per hole staat in `src/holes.json`. Tee- en greenposities staan nog **niet** in OpenStreetMap en moeten nog ingetekend worden.
- **GPS**: knop 📍 toont je positie en de afstand tot de green van de gekozen hole.

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
