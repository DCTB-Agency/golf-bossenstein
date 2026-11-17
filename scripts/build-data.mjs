// Bouwt de data voor de 3D-viewer uit open data:
//  - raw/tiles/t0..t3.jpg : Orthofoto Vlaanderen (Digitaal Vlaanderen), 2x2 tegels
//  - raw/dtm.tif          : DHMV II DTM 1m (Digitaal Vlaanderen), EPSG:4258
//  - raw/dsm.tif          : DHMV II DSM 1m (Digitaal Vlaanderen) -> boomposities/-hoogtes
//  - raw/osm.json         : OpenStreetMap (water, gebouwen, bos, terreingrens)
// Downloads (bbox lon 4.585–4.606, lat 51.185–51.1985):
//  ortho : https://geo.api.vlaanderen.be/OMWRGBMRVL/wms  (layers=Ortho, crs=CRS:84, 2x2 tegels van 2048 px)
//  dtm   : https://geo.api.vlaanderen.be/el-dtm/wcs  coverageId=EL.GridCoverage.DTM  subset=y(..)&subset=x(..)
//  dsm   : https://geo.api.vlaanderen.be/el-dsm/wcs  coverageId=EL.GridCoverage.DSM
//          (WCS antwoordt multipart: knip het image/tiff-deel eruit)
//  osm   : Overpass – golfterrein way 112447757 / 112449928 + water, gebouwen, bos daarbinnen
import fs from 'node:fs';
import sharp from 'sharp';
import { fromFile } from 'geotiff';

export const BBOX = { west: 4.585, east: 4.606, south: 51.185, north: 51.1985 };
const lat0 = (BBOX.south + BBOX.north) / 2;
const lon0 = (BBOX.west + BBOX.east) / 2;
const MX = 111320 * Math.cos((lat0 * Math.PI) / 180); // meter per graad lengte
const MZ = 110574;                                    // meter per graad breedte
const toLocal = (lon, lat) => [+((lon - lon0) * MX).toFixed(2), +(-(lat - lat0) * MZ).toFixed(2)];

const out = 'public/data';
fs.mkdirSync(out, { recursive: true });

// 1. Luchtfoto stitchen (4096x4096)
const T = 2048;
await sharp({ create: { width: 2 * T, height: 2 * T, channels: 3, background: '#000' } })
  .composite([0, 1, 2, 3].map((i) => ({ input: `raw/tiles/t${i}.jpg`, left: (i % 2) * T, top: Math.floor(i / 2) * T })))
  .jpeg({ quality: 82, mozjpeg: true })
  .toFile(`${out}/ortho.jpg`);
await sharp(`${out}/ortho.jpg`).resize(1024).jpeg({ quality: 80 }).toFile('raw/ortho-preview.jpg');

// 2. Hoogtemodel -> regelmatig raster in lokale meters, opgeslagen als Float32
const tif = await fromFile('raw/dtm.tif');
const img = await tif.getImage();
const [W, H] = [img.getWidth(), img.getHeight()];
const [minX, minY, maxX, maxY] = img.getBoundingBox(); // lon/lat
const ras = (await img.readRasters({ interleave: true }));
const nodata = img.getGDALNoData();
const sample = (lon, lat) => {
  const fx = ((lon - minX) / (maxX - minX)) * (W - 1);
  const fy = ((maxY - lat) / (maxY - minY)) * (H - 1);
  const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)));
  const tx = fx - x0, ty = fy - y0;
  const v = (x, y) => { const z = ras[y * W + x]; return z === nodata || z < -100 ? NaN : z; };
  const a = v(x0, y0), b = v(x0 + 1, y0), c = v(x0, y0 + 1), d = v(x0 + 1, y0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
};
const N = 512; // rasterpunten per zijde
const hgt = new Float32Array(N * N);
let lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const lon = BBOX.west + (i / (N - 1)) * (BBOX.east - BBOX.west);
  const lat = BBOX.north - (j / (N - 1)) * (BBOX.north - BBOX.south);
  const z = sample(lon, lat);
  hgt[j * N + i] = z;
  if (!isNaN(z)) { lo = Math.min(lo, z); hi = Math.max(hi, z); sum += z; cnt++; }
}
const mean = sum / cnt;
for (let k = 0; k < hgt.length; k++) if (isNaN(hgt[k])) hgt[k] = mean; // gaten (water) opvullen
fs.writeFileSync(`${out}/height.bin`, Buffer.from(hgt.buffer));

// 2b. Bomen uit oppervlaktemodel (DSM - DTM = hoogte boven maaiveld)
const dsmImg = await (await fromFile('raw/dsm.tif')).getImage();
const dsm = await dsmImg.readRasters({ interleave: true });
if (dsmImg.getWidth() !== W || dsmImg.getHeight() !== H) throw new Error('DSM/DTM raster verschilt');
const orthoRaw = await sharp(`${out}/ortho.jpg`).raw().toBuffer({ resolveWithObject: true });
const OW = orthoRaw.info.width, OH = orthoRaw.info.height, OC = orthoRaw.info.channels;
const pix = (lon, lat) => {
  const px = Math.min(OW - 1, Math.max(0, Math.round(((lon - BBOX.west) / (BBOX.east - BBOX.west)) * (OW - 1))));
  const py = Math.min(OH - 1, Math.max(0, Math.round(((BBOX.north - lat) / (BBOX.north - BBOX.south)) * (OH - 1))));
  const o = (py * OW + px) * OC; return [orthoRaw.data[o], orthoRaw.data[o + 1], orthoRaw.data[o + 2]];
};
const CELL = 3; // pixels per cel (~3-4 m)
const GW = Math.floor(W / CELL), GH = Math.floor(H / CELL);
const cellMax = new Float32Array(GW * GH), cellRough = new Float32Array(GW * GH);
const cellArg = new Int32Array(GW * GH);
for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
  let mx = -1, arg = -1, s1 = 0, s2 = 0, n = 0;
  for (let y = gy * CELL; y < gy * CELL + CELL; y++) for (let x = gx * CELL; x < gx * CELL + CELL; x++) {
    const k = y * W + x, g = ras[k], s = dsm[k];
    if (g < -100 || s < -100) continue;
    const h = s - g; if (h > mx) { mx = h; arg = k; } s1 += h; s2 += h * h; n++;
  }
  const c = gy * GW + gx; cellMax[c] = mx; cellArg[c] = arg;
  cellRough[c] = n ? Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2)) : 0;
}
const trees = [];
for (let gy = 1; gy < GH - 1; gy++) for (let gx = 1; gx < GW - 1; gx++) {
  const c = gy * GW + gx, h = cellMax[c];
  if (h < 3 || h > 40) continue;
  let top = true; // lokaal maximum = boomtop
  for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && cellMax[c + dy * GW + dx] > h) { top = false; break; }
  if (!top) continue;
  const k = cellArg[c], x = k % W, y = Math.floor(k / W);
  const lon = minX + (x / (W - 1)) * (maxX - minX), lat = maxY - (y / (H - 1)) * (maxY - minY);
  const [r, g, b] = pix(lon, lat);
  const mxc = Math.max(r, g, b), mnc = Math.min(r, g, b), sat = mxc ? (mxc - mnc) / mxc : 0;
  const roofLike = cellRough[c] < 0.6 && (sat < 0.12 || mxc > 185); // vlak + grijs/licht = dak
  if (roofLike) continue;
  const [lx, lz] = toLocal(lon, lat);
  trees.push(lx, lz, +h.toFixed(1));
}
fs.writeFileSync(`${out}/trees.bin`, Buffer.from(new Float32Array(trees).buffer));

// 3. OSM-objecten naar lokale coördinaten
const osm = JSON.parse(fs.readFileSync('raw/osm.json', 'utf8'));
const feats = { boundary: [], water: [], buildings: [], forest: [] };
for (const e of osm.elements) {
  if (!e.geometry) continue;
  const t = e.tags || {};
  const pts = e.geometry.map((p) => toLocal(p.lon, p.lat));
  if (t.leisure === 'golf_course') feats.boundary.push(pts);
  else if (t.natural === 'water') feats.water.push(pts);
  else if ('building' in t) feats.buildings.push({ pts, levels: +t['building:levels'] || 2 });
  else if (t.natural === 'wood' || t.landuse === 'forest') feats.forest.push(pts);
}

const [x0, z0] = toLocal(BBOX.west, BBOX.north);
const [x1, z1] = toLocal(BBOX.east, BBOX.south);
fs.writeFileSync(`${out}/meta.json`, JSON.stringify({
  bbox: BBOX, origin: { lat: lat0, lon: lon0 }, metersPerDeg: { lon: MX, lat: MZ },
  extent: { minX: x0, maxX: x1, minZ: z0, maxZ: z1 },
  height: { file: 'height.bin', size: N, min: lo, max: hi },
  ortho: 'ortho.jpg',
  trees: { file: 'trees.bin', count: trees.length / 3 },
  features: feats,
  attribution: 'Luchtfoto & hoogtemodel © Digitaal Vlaanderen (CC-BY 4.0) · Kaartdata © OpenStreetMap-bijdragers (ODbL)',
}));
console.log({ W, H, lo, hi, extent: { x0, x1, z0, z1 }, water: feats.water.length, buildings: feats.buildings.length, trees: trees.length / 3 });
