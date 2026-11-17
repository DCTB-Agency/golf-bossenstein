// Bouwt de data voor de 3D-viewer uit open data.
//
// Bronnen (bbox lon 4.585–4.606, lat 51.185–51.1985):
//  raw/summer/t_J_I.jpg : Orthofoto Vlaanderen zomer 2024 (OMZRGB24VL), 4x4 tegels van 2048 px
//                         https://geo.api.vlaanderen.be/OMZ/wms  layers=OMZRGB24VL crs=CRS:84
//  raw/dtm.tif          : DHMV II DTM 1 m  https://geo.api.vlaanderen.be/el-dtm/wcs  coverageId=EL.GridCoverage.DTM
//  raw/dsm.tif          : DHMV II DSM 1 m  https://geo.api.vlaanderen.be/el-dsm/wcs  coverageId=EL.GridCoverage.DSM
//                         (WCS antwoordt multipart: knip het image/tiff-deel eruit)
//  raw/grb_gbg.json     : GRB gebouwen aan de grond  https://geo.api.vlaanderen.be/GRB/wfs typeNames=GRB:GBG
//  raw/osm.json         : OpenStreetMap (water, terreingrens) via Overpass
import fs from 'node:fs';
import sharp from 'sharp';
import { fromFile } from 'geotiff';

export const BBOX = { west: 4.585, east: 4.606, south: 51.185, north: 51.1985 };
const lat0 = (BBOX.south + BBOX.north) / 2;
const lon0 = (BBOX.west + BBOX.east) / 2;
const MX = 111320 * Math.cos((lat0 * Math.PI) / 180);
const MZ = 110574;
const toLocal = (lon, lat) => [+((lon - lon0) * MX).toFixed(2), +(-(lat - lat0) * MZ).toFixed(2)];
const [EX0, EZ0] = toLocal(BBOX.west, BBOX.north);
const [EX1, EZ1] = toLocal(BBOX.east, BBOX.south);

const out = 'public/data';
fs.mkdirSync(`${out}/ortho/2048`, { recursive: true });
fs.mkdirSync(`${out}/ortho/1024`, { recursive: true });

// ---------- 1. Luchtfoto: zomer 2024, opgefrist en in tegels ----------
const TILES = 4;
const enhance = (img) => img
  .modulate({ saturation: 1.18, brightness: 1.03 })
  .linear(1.14, -14)
  .sharpen({ sigma: 0.9, m1: 0.6, m2: 2.2 });
for (let j = 0; j < TILES; j++) for (let i = 0; i < TILES; i++) {
  const buf = await enhance(sharp(`raw/summer/t_${j}_${i}.jpg`)).toBuffer();
  await sharp(buf).jpeg({ quality: 84, mozjpeg: true }).toFile(`${out}/ortho/2048/t_${j}_${i}.jpg`);
  await sharp(buf).resize(1024).jpeg({ quality: 82, mozjpeg: true }).toFile(`${out}/ortho/1024/t_${j}_${i}.jpg`);
}
// één 4096-mozaïek: voor daken, boomkleuren en als lichte variant
const T = 1024;
const mosaic = await sharp({ create: { width: TILES * T, height: TILES * T, channels: 3, background: '#000' } })
  .composite([...Array(TILES * TILES).keys()].map((k) => ({
    input: `${out}/ortho/1024/t_${Math.floor(k / TILES)}_${k % TILES}.jpg`, left: (k % TILES) * T, top: Math.floor(k / TILES) * T,
  })))
  .jpeg({ quality: 85 }).toBuffer();
await sharp(mosaic).toFile(`${out}/ortho_4k.jpg`);
const orthoRaw = await sharp(mosaic).raw().toBuffer({ resolveWithObject: true });
const OW = orthoRaw.info.width, OH = orthoRaw.info.height, OC = orthoRaw.info.channels;
const pixLocal = (x, z) => {
  const px = Math.min(OW - 1, Math.max(0, Math.round(((x - EX0) / (EX1 - EX0)) * (OW - 1))));
  const py = Math.min(OH - 1, Math.max(0, Math.round(((z - EZ0) / (EZ1 - EZ0)) * (OH - 1))));
  const o = (py * OW + px) * OC; return [orthoRaw.data[o], orthoRaw.data[o + 1], orthoRaw.data[o + 2]];
};

// ---------- 2. Hoogtemodellen ----------
const dtmImg = await (await fromFile('raw/dtm.tif')).getImage();
const dsmImg = await (await fromFile('raw/dsm.tif')).getImage();
const [W, H] = [dtmImg.getWidth(), dtmImg.getHeight()];
if (dsmImg.getWidth() !== W || dsmImg.getHeight() !== H) throw new Error('DSM/DTM raster verschilt');
const [minX, minY, maxX, maxY] = dtmImg.getBoundingBox();
const dtm = await dtmImg.readRasters({ interleave: true });
const dsm = await dsmImg.readRasters({ interleave: true });
const valid = (v) => v > -100 && v < 500;
const lonOfPx = (x) => minX + ((x + 0.5) / W) * (maxX - minX);
const latOfPy = (y) => maxY - ((y + 0.5) / H) * (maxY - minY);
const pxOfLon = (lon) => ((lon - minX) / (maxX - minX)) * W - 0.5;
const pyOfLat = (lat) => ((maxY - lat) / (maxY - minY)) * H - 0.5;
const bilinear = (ras, lon, lat) => {
  const fx = Math.max(0, Math.min(W - 1.001, pxOfLon(lon))), fy = Math.max(0, Math.min(H - 1.001, pyOfLat(lat)));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const v = (x, y) => { const z = ras[y * W + x]; return valid(z) ? z : NaN; };
  return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
};

const SEG = 256, N = TILES * SEG + 1; // 1025 punten per zijde (~1,4 m)
const hgt = new Float32Array(N * N);
let lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const lon = BBOX.west + (i / (N - 1)) * (BBOX.east - BBOX.west);
  const lat = BBOX.north - (j / (N - 1)) * (BBOX.north - BBOX.south);
  const z = bilinear(dtm, lon, lat);
  hgt[j * N + i] = z;
  if (!isNaN(z)) { lo = Math.min(lo, z); hi = Math.max(hi, z); sum += z; cnt++; }
}
const mean = sum / cnt;
for (let k = 0; k < hgt.length; k++) if (isNaN(hgt[k])) hgt[k] = mean;
fs.writeFileSync(`${out}/height.bin`, Buffer.from(hgt.buffer));

// ---------- 3. Gebouwen: GRB-contour + hoogtes uit DSM ----------
const inPoly = (x, y, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const pct = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((m, n) => m - n); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const hull = (pts) => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
};
const obbOf = (pts) => { // kleinste omsluitende rechthoek
  const h = hull(pts); let best = null;
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i], [bx, bz] = h[(i + 1) % h.length];
    const ang = Math.atan2(bz - az, bx - ax), c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of h) { const u = x * c + z * s, v = -x * s + z * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      best = { area, cx: uc * c - vc * s, cz: uc * s + vc * c, ang, len: u1 - u0, wid: v1 - v0 };
    }
  }
  if (best.wid > best.len) { [best.len, best.wid] = [best.wid, best.len]; best.ang += Math.PI / 2; }
  return best;
};
const polyArea = (p) => Math.abs(p.reduce((s, [x, z], i) => { const [x2, z2] = p[(i + 1) % p.length]; return s + x * z2 - x2 * z; }, 0)) / 2;

const grb = JSON.parse(fs.readFileSync('raw/grb_gbg.json', 'utf8'));
const buildings = [];
const footprintsLL = [];
for (const f of grb.features) {
  const g = f.geometry; if (!g) continue;
  const type = f.properties?.LBLTYPE || '';
  if (/ondergronds/i.test(type)) continue;
  const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];
  for (const ring of rings) {
    footprintsLL.push(ring);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [lon, lat] of ring) { const px = pxOfLon(lon), py = pyOfLat(lat); x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
    const roof = [];
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, Math.ceil(x1)); x++) {
        if (!inPoly(lonOfPx(x), latOfPy(y), ring)) continue;
        const s = dsm[y * W + x]; if (valid(s)) roof.push(s);
      }
    const pts = ring.slice(0, -1).map(([lon, lat]) => toLocal(lon, lat));
    if (pts.length < 3) continue;
    // grond: laagste maaiveld langs de rand (DTM onder gebouwen is geïnterpoleerd)
    const edgeGround = pts.map(([x, z]) => bilinear(dtm, lon0 + x / MX, lat0 - z / MZ)).filter((v) => !isNaN(v));
    const base = edgeGround.length ? Math.min(...edgeGround) : mean;
    const ridge = pct(roof, 0.95), eaveRaw = pct(roof, 0.3);
    let hR = (isNaN(ridge) ? base + 4 : ridge) - base, hE = (isNaN(eaveRaw) ? base + 3 : eaveRaw) - base;
    hR = Math.min(Math.max(hR, 2.6), 40); hE = Math.min(Math.max(hE, 2.4), hR);
    const area = polyArea(pts), obb = obbOf(pts);
    const rect = area / (obb.len * obb.wid);
    const pitched = hR - hE > 1.3 && rect > 0.82 && obb.wid > 4 && obb.wid < 22;
    const [ccx, ccz] = [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length];
    const role = area > 800 && ccx > -60 && ccx < 60 && ccz > -180 && ccz < -80 ? 'castle'
      : ccx > 90 && ccx < 200 && ccz > -490 && ccz < -400 ? 'club' : undefined;
    // kasteel: binnenplaats drukt het percentiel; goothoogte van de vleugels volgens de gevelfoto's
    if (role === 'castle') hE = Math.max(hE, 10.5);
    // complexe gebouwen met een echt dak: dakvorm als raster uit het DSM (1 m)
    let grid;
    if (!pitched && area > 60 && (hR - hE > 0.8 || role === 'castle')) {
      const STEP = 1;
      const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
      const gx0 = Math.floor(Math.min(...xs)), gz0 = Math.floor(Math.min(...zs));
      const nx = Math.ceil(Math.max(...xs) - gx0) + 1, nz = Math.ceil(Math.max(...zs) - gz0) + 1;
      const hts = [];
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const x = gx0 + i * STEP, z = gz0 + j * STEP;
        if (!inPoly(x, z, pts)) { hts.push(-1); continue; }
        const v = bilinear(dsm, lon0 + x / MX, lat0 - z / MZ) - base;
        hts.push(isNaN(v) ? -1 : +Math.max(role === 'castle' ? 0.5 : hE, Math.min(v, hR + 1)).toFixed(1));
      }
      grid = { x0: gx0, z0: gz0, s: STEP, nx, nz, h: hts };
    }
    buildings.push({
      p: pts.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]),
      b: +base.toFixed(2), e: +(pitched || grid ? hE : (hE + hR) / 2).toFixed(2), r: +hR.toFixed(2),
      roof: pitched ? 'gable' : grid ? 'dsm' : 'flat',
      obb: pitched ? [+obb.cx.toFixed(2), +obb.cz.toFixed(2), +obb.ang.toFixed(4), +obb.len.toFixed(2), +obb.wid.toFixed(2)] : undefined,
      grid, role,
      t: type,
    });
  }
}
fs.writeFileSync(`${out}/buildings.json`, JSON.stringify(buildings));

// ---------- 4. Bomen: toppen in DSM-DTM, kroonbreedte gemeten, kleur uit de zomerfoto ----------
const mask = new Uint8Array(W * H); // gebouwen (+ marge) zodat daken geen bomen worden
for (const ring of footprintsLL) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [lon, lat] of ring) { const px = pxOfLon(lon), py = pyOfLat(lat); x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
  for (let y = Math.max(0, Math.floor(y0) - 2); y <= Math.min(H - 1, Math.ceil(y1) + 2); y++)
    for (let x = Math.max(0, Math.floor(x0) - 2); x <= Math.min(W - 1, Math.ceil(x1) + 2); x++)
      for (const [dx, dy] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]])
        if (inPoly(lonOfPx(x + dx), latOfPy(y + dy), ring)) { mask[y * W + x] = 1; break; }
}
const ndsm = new Float32Array(W * H);
for (let k = 0; k < W * H; k++) ndsm[k] = valid(dsm[k]) && valid(dtm[k]) && !mask[k] ? Math.max(0, dsm[k] - dtm[k]) : 0;

const CELL = 3, GW = Math.floor(W / CELL), GH = Math.floor(H / CELL);
const cellMax = new Float32Array(GW * GH), cellArg = new Int32Array(GW * GH);
for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
  let mx = -1, arg = -1;
  for (let y = gy * CELL; y < gy * CELL + CELL; y++) for (let x = gx * CELL; x < gx * CELL + CELL; x++) {
    const h = ndsm[y * W + x]; if (h > mx) { mx = h; arg = y * W + x; }
  }
  cellMax[gy * GW + gx] = mx; cellArg[gy * GW + gx] = arg;
}
const pxM = ((maxX - minX) * MX) / W, pyM = ((maxY - minY) * MZ) / H; // meter per DSM-pixel
const trees = [];
let nCon = 0;
for (let gy = 1; gy < GH - 1; gy++) for (let gx = 1; gx < GW - 1; gx++) {
  const c = gy * GW + gx, h = cellMax[c];
  if (h < 3 || h > 40) continue;
  let top = true;
  for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1; dx++)
    if ((dx || dy) && cellMax[c + dy * GW + dx] > h) { top = false; break; }
  if (!top) continue;
  const k = cellArg[c], x = k % W, y = Math.floor(k / W);
  // kroonstraal: in 8 richtingen lopen tot de hoogte onder 55% zakt
  const rs = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
    let r = 0;
    for (let s = 1; s <= 14; s++) {
      const xx = Math.round(x + dx * s), yy = Math.round(y + dy * s);
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || ndsm[yy * W + xx] < 0.55 * h) break;
      r = Math.hypot(dx * s * pxM, dy * s * pyM);
    }
    rs.push(r);
  }
  rs.sort((a, b) => a - b);
  const radius = Math.min(10, Math.max(1.4, rs[4] + 0.8));
  const [lx, lz] = toLocal(lonOfPx(x), latOfPy(y));
  let r = 0, g = 0, b = 0;
  for (let a = 0; a < 9; a++) { // kleur: gemiddelde van de zomerfoto binnen de kroon
    const rr = a ? radius * 0.55 : 0, ang = (a / 8) * Math.PI * 2;
    const [pr, pg, pb] = pixLocal(lx + Math.cos(ang) * rr, lz + Math.sin(ang) * rr);
    r += pr; g += pg; b += pb;
  }
  const conifer = radius / h < 0.2 && h > 6 ? 1 : 0;
  nCon += conifer;
  trees.push(lx, lz, +h.toFixed(1), +radius.toFixed(1), r / 9 / 255, g / 9 / 255, b / 9 / 255, conifer);
}
fs.writeFileSync(`${out}/trees.bin`, Buffer.from(new Float32Array(trees).buffer));

// ---------- 5. OSM: water + terreingrens ----------
const osm = JSON.parse(fs.readFileSync('raw/osm.json', 'utf8'));
const feats = { boundary: [], water: [] };
for (const e of osm.elements) {
  if (!e.geometry) continue;
  const t = e.tags || {};
  const pts = e.geometry.map((p) => toLocal(p.lon, p.lat));
  if (t.leisure === 'golf_course') feats.boundary.push(pts);
  else if (t.natural === 'water') feats.water.push(pts);
}

// ---------- 6. Bunkers: zandkleur op de zomerfoto → samenhangende vlekken ----------
const osmB = JSON.parse(fs.readFileSync('raw/osm.json', 'utf8'));
const courseLocal = [], waterLocal = [];
for (const e of osmB.elements) {
  if (!e.geometry) continue;
  const poly = e.geometry.map((p) => toLocal(p.lon, p.lat));
  if (e.tags?.leisure === 'golf_course') courseLocal.push(poly);
  else if (e.tags?.natural === 'water') waterLocal.push(poly);
}
const sandMask = new Uint8Array(OW * OH);
for (let k = 0; k < OW * OH; k++) {
  const r = orthoRaw.data[k * OC], g = orthoRaw.data[k * OC + 1], b = orthoRaw.data[k * OC + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const warmSand = r > 145 && g > 132 && b > 98 && r - b >= 18 && r - g >= 5 && b / r < 0.89;
  const whiteSand = r + g + b > 520 && mx - mn < 62 && b <= r + 6 && g >= b - 6;
  sandMask[k] = warmSand || whiteSand ? 1 : 0;
}
// sluiten (3x3) zodat harken en schaduwranden geen gaten maken
const closed = new Uint8Array(OW * OH);
for (let y = 1; y < OH - 1; y++) for (let x = 1; x < OW - 1; x++) {
  let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += sandMask[(y + dy) * OW + x + dx];
  closed[y * OW + x] = n >= 3 ? 1 : 0;
}
const pxM2 = ((EX1 - EX0) / OW) * ((EZ1 - EZ0) / OH);
const lxOf = (x) => EX0 + ((x + 0.5) / OW) * (EX1 - EX0), lzOf = (y) => EZ0 + ((y + 0.5) / OH) * (EZ1 - EZ0);
const NOT_BUNKER = [[35, 112, -485, -405], [95, 140, -432, -400], [0, 45, -125, -85]];
const seen = new Uint8Array(OW * OH), bunkers = [];
for (let s = 0; s < OW * OH; s++) {
  if (!closed[s] || seen[s]) continue;
  const stack = [s], cells = []; seen[s] = 1; let perim = 0;
  while (stack.length) {
    const k = stack.pop(); cells.push(k);
    const x = k % OW, y = (k - x) / OW;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= OW || yy >= OH) { perim++; continue; }
      const kk = yy * OW + xx;
      if (!closed[kk]) { perim++; continue; }
      if (!seen[kk]) { seen[kk] = 1; stack.push(kk); }
    }
  }
  const area = cells.length * pxM2;
  if (area < 5 || area > 1800) continue;                      // te klein / parking, manege
  const width = (2 * area) / (perim * Math.sqrt(pxM2));         // gemiddelde breedte (m)
  if (width < 1.6) continue;                                    // paden en randen
  let cx = 0, cz = 0; for (const k of cells) { cx += lxOf(k % OW); cz += lzOf(Math.floor(k / OW)); }
  cx /= cells.length; cz /= cells.length;
  if (buildings.some((b) => inPoly(cx, cz, b.p))) continue;     // lichte daken
  if (!courseLocal.some((poly) => inPoly(cx, cz, poly))) continue; // buiten de golfbaan (tuinen, manege)
  if (waterLocal.some((poly) => inPoly(cx, cz, poly))) continue;   // troebele vijvers
  let sb = 0, sb2 = 0; // egaliteit: zand is egaal, een parking met auto's niet
  for (const k of cells) { const v = orthoRaw.data[k * OC] + orthoRaw.data[k * OC + 1] + orthoRaw.data[k * OC + 2]; sb += v; sb2 += v * v; }
  const std = Math.sqrt(Math.max(0, sb2 / cells.length - (sb / cells.length) ** 2)) / 3;
  if (std > 30) continue;
  // vaste uitsluitingen (Bossenstein): parking en terras bij het clubhuis
  if (NOT_BUNKER.some(([x0, x1, z0, z1]) => cx > x0 && cx < x1 && cz > z0 && cz < z1)) continue;
  const pts = []; // punten om de ~1,4 m voor de analyse in de app
  for (const k of cells) { const x = k % OW, y = Math.floor(k / OW); if (x % 4 === 0 && y % 4 === 0) pts.push([+lxOf(x).toFixed(1), +lzOf(y).toFixed(1)]); }
  if (!pts.length) pts.push([+cx.toFixed(1), +cz.toFixed(1)]);
  bunkers.push({ c: [+cx.toFixed(1), +cz.toFixed(1)], a: Math.round(area), p: pts });
}
fs.writeFileSync(`${out}/hazards.json`, JSON.stringify({ bunkers }));

fs.writeFileSync(`${out}/meta.json`, JSON.stringify({
  hazards: 'hazards.json',
  bbox: BBOX, origin: { lat: lat0, lon: lon0 }, metersPerDeg: { lon: MX, lat: MZ },
  extent: { minX: EX0, maxX: EX1, minZ: EZ0, maxZ: EZ1 },
  height: { file: 'height.bin', size: N, min: lo, max: hi },
  tiles: { n: TILES, seg: SEG, dirs: { hi: 'ortho/2048', lo: 'ortho/1024' } },
  ortho4k: 'ortho_4k.jpg',
  buildings: 'buildings.json',
  trees: { file: 'trees.bin', stride: 8, count: trees.length / 8 },
  features: feats,
  attribution: 'Luchtfoto (zomer 2024), hoogtemodel & GRB © Digitaal Vlaanderen (CC-BY 4.0) · Kaartdata © OpenStreetMap-bijdragers (ODbL) · Kasteelgevels: Zairon, CC BY-SA 4.0 (Wikimedia Commons)',
}));
console.log({ N, lo: lo.toFixed(1), hi: hi.toFixed(1), buildings: buildings.length, gable: buildings.filter((b) => b.roof === 'gable').length, trees: trees.length / 8, conifers: nCon, bunkers: bunkers.length });
