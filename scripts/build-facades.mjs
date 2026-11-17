// Gevelfoto's rechttrekken (perspectiefcorrectie) tot muurtexturen.
//
// Bronnen in raw/photos:
//  castle_c01/c06/c08/c10_*.jpg : Wikimedia Commons, "Broechem Kasteel Bossenstein 02/07/09/11"
//                                 door Zairon, CC BY-SA 4.0
//  club_D2A7382.jpg             : bossenstein.be (foto van de club) – enkel voor gebruik met toestemming van de club
import fs from 'node:fs';
import sharp from 'sharp';

const out = 'public/data/facades';
fs.mkdirSync(out, { recursive: true });

// homografie die het eenheidsvierkant (u,v) ∈ [0,1]² afbeeldt op een vierhoek (TL, TR, BR, BL)
function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
}

async function rectify(src, quad, W, H, { mirrorRightHalf = false } = {}) {
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const map = squareToQuad(quad), C = info.channels, out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let u = (x + 0.5) / W;
    if (mirrorRightHalf && u < 0.5) u = 1 - u; // symmetrische gevel: linkerhelft = gespiegelde rechterhelft
    const [sx, sy] = map(u, (y + 0.5) / H);
    const fx = Math.min(info.width - 1.001, Math.max(0, sx)), fy = Math.min(info.height - 1.001, Math.max(0, sy));
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    for (let ch = 0; ch < 3; ch++) {
      const p = (xx, yy) => data[(yy * info.width + xx) * C + ch];
      out[(y * W + x) * 3 + ch] = (p(ix, iy) * (1 - tx) + p(ix + 1, iy) * tx) * (1 - ty) + (p(ix, iy + 1) * (1 - tx) + p(ix + 1, iy + 1) * tx) * ty;
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } });
}

const R = 'raw/photos/';
const jobs = [
  // hoofdgevel met toren (noordzijde, vanaf de golfbaan): waterlijn → dakgoot van de vleugels
  ['castle_n', R + 'castle_c01_Broechem_Kasteel_Bossenstein_02.jpg', [[170, 745], [1745, 745], [1745, 1262], [170, 1262]], 2048, 672],
  // poortvleugel (zuidzijde, ingang); linkerhelft gespiegeld omdat er een auto voor staat
  ['castle_s', R + 'castle_c10_Broechem_Kasteel_Bossenstein_11.jpg', [[169, 612], [1770, 612], [1770, 945], [169, 945]], 2048, 440, { mirrorRightHalf: true }],
  // zijgevels (schuin gefotografeerd → rechtgetrokken)
  ['castle_e', R + 'castle_c06_Broechem_Kasteel_Bossenstein_07.jpg', [[207, 797], [1200, 716], [1200, 1046], [207, 973]], 1536, 440],
  ['castle_w', R + 'castle_c08_Broechem_Kasteel_Bossenstein_09.jpg', [[240, 700], [1738, 710], [1738, 960], [240, 1018]], 2048, 420],
  // algemene gevel: baksteen met witte ramen (clubhuis), herhaalbaar
  ['wall_house', R + 'club_D2A7382.jpg', [[985, 900], [1430, 900], [1430, 1100], [985, 1100]], 512, 230],
];
for (const [name, src, quad, W, H, opt] of jobs) {
  const img = await rectify(src, quad, W, H, opt);
  await img.modulate({ saturation: 1.05 }).jpeg({ quality: 86, mozjpeg: true }).toFile(`${out}/${name}.jpg`);
  console.log(name, W + 'x' + H);
}
