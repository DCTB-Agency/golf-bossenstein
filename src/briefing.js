// Hole-briefing: hindernissen langs de speellijn, greenverdediging en speltips.
// Afstanden in meter langs de lijn tee → knikpunt(en) → green, vanaf de (gele) tee.

const CORRIDOR = 42;     // m links/rechts van de lijn die nog "in het spel" is
const GREEN_ZONE = 32;   // m rond de green voor greenverdediging

export function makeBriefingData(meta, hazards) {
  const inPoly = (x, z, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  // water: rand + raster binnenin (3 m)
  const water = meta.features.water.filter((p) => p.length > 3).map((poly) => {
    const pts = [...poly];
    const xs = poly.map((q) => q[0]), zs = poly.map((q) => q[1]);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 3)
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 3) if (inPoly(x, z, poly)) pts.push([x, z]);
    const c = pts.reduce((a, q) => [a[0] + q[0] / pts.length, a[1] + q[1] / pts.length], [0, 0]);
    return { kind: 'water', pts, c };
  });
  const bunkers = hazards.bunkers.map((b) => ({ kind: 'bunker', pts: b.p.length ? b.p : [b.c], c: b.c, a: b.a }));
  return { water, bunkers };
}

function pathInfo(P) {
  const segs = [];
  let L = 0;
  for (let i = 1; i < P.length; i++) {
    const [ax, az] = P[i - 1], [bx, bz] = P[i];
    const len = Math.hypot(bx - ax, bz - az);
    segs.push({ ax, az, fx: (bx - ax) / len, fz: (bz - az) / len, len, s0: L });
    L += len;
  }
  // projectie: s langs de lijn (ook vóór de tee / voorbij de green), d zijdelings (+ = rechts)
  const project = (x, z) => {
    let best = null;
    segs.forEach((g, k) => {
      let t = (x - g.ax) * g.fx + (z - g.az) * g.fz;
      const tc = k === 0 ? Math.min(t, g.len) : k === segs.length - 1 ? Math.max(t, 0) : Math.max(0, Math.min(t, g.len));
      const px = g.ax + g.fx * tc, pz = g.az + g.fz * tc;
      const dist = Math.hypot(x - px, z - pz);
      if (!best || dist < best.dist) {
        const d = (x - g.ax) * -g.fz + (z - g.az) * g.fx; // rechts = (-fz, fx)
        best = { s: g.s0 + tc, d, dist };
      }
    });
    return best;
  };
  return { segs, L, project };
}

const sideWord = (lo, hi) => (hi < 0 ? 'links' : lo > 0 ? 'rechts' : 'dwars');
const m = (v) => `${Math.round(v)} m`;

export function analyzeHole({ hole, geo, data, realHeight, me }) {
  if (!hole.tee || !hole.green) return null;
  const P = [hole.tee, ...(hole.via || []), hole.green].map(([lon, lat]) => geo.toLocal(lon, lat));
  const { segs, L, project } = pathInfo(P);

  // GPS: afstanden vanaf de speler als die (ongeveer) op deze hole staat
  let s0 = 0, fromMe = false;
  if (me) {
    const [mx, mz] = geo.toLocal(me[0], me[1]);
    const pr = project(mx, mz);
    if (pr.dist < 70 && pr.s > -20 && pr.s < L + 10) { s0 = Math.max(0, pr.s); fromMe = true; }
  }

  const items = [];
  for (const hz of [...data.water, ...data.bunkers]) {
    let sMin = Infinity, sMax = -Infinity, dLo = Infinity, dHi = -Infinity, near = Infinity, n = 0, dSum = 0;
    let lineLo = Infinity, lineHi = -Infinity; // stuk waar de hindernis óp de speellijn ligt
    for (const [x, z] of hz.pts) {
      const { s, d } = project(x, z);
      const lim = s > L - GREEN_ZONE ? GREEN_ZONE : CORRIDOR;
      if (s < 15 || s > L + 25 || Math.abs(d) > lim) continue;
      n++; sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); dSum += d;
      dLo = Math.min(dLo, d); dHi = Math.max(dHi, d); near = Math.min(near, Math.abs(d));
      if (Math.abs(d) < 4) { lineLo = Math.min(lineLo, s); lineHi = Math.max(lineHi, s); }
    }
    if (!n) continue;
    const atGreen = sMin > L - GREEN_ZONE;
    if (hz.kind === 'bunker' && !atGreen && (near > 30 || sMax < 50)) continue; // niet in het spel
    if (hz.kind === 'water' && n < 4 && near > 25) continue;                    // randje van een vijver verderop
    // "dwars": de hindernis kruist de lijn over een kort stuk en loopt aan beide kanten door
    const crossesLine = lineHi >= lineLo && lineHi - lineLo < 80 && dLo < -6 && dHi > 6;
    const side = crossesLine ? 'dwars' : dLo < -3 && dHi > 3 ? (dSum / n < 0 ? 'links' : 'rechts') : sideWord(dLo, dHi);
    const carry = crossesLine ? lineHi + 2 : null;
    items.push({ kind: hz.kind, sMin, sMax, dLo, dHi, near, side, carry, lineLo: crossesLine ? lineLo : null, atGreen, c: hz.c });
  }
  // bunkers die dicht bij elkaar liggen aan dezelfde kant samenvoegen
  items.sort((a, b) => a.sMin - b.sMin);
  const merged = [];
  for (const it of items) {
    const prev = merged.findLast?.((q) => q.kind === it.kind && q.side === it.side && q.atGreen === it.atGreen && it.sMin - q.sMax < 12);
    if (prev && it.kind === 'bunker') {
      Object.assign(prev, { sMax: Math.max(prev.sMax, it.sMax), near: Math.min(prev.near, it.near), count: (prev.count || 1) + 1 });
    } else merged.push({ ...it });
  }

  // greenverdediging (positie t.o.v. het greencentrum)
  const lastSeg = segs[segs.length - 1];
  const [gx, gz] = P[P.length - 1];
  const greenSides = new Set();
  for (const it of merged.filter((q) => q.atGreen && q.kind === 'bunker')) {
    const [cx, cz] = it.c;
    const a = (cx - gx) * lastSeg.fx + (cz - gz) * lastSeg.fz;      // + = achter
    const b = (cx - gx) * -lastSeg.fz + (cz - gz) * lastSeg.fx;     // + = rechts
    const pos = Math.abs(a) > Math.abs(b) * 1.2 ? (a < 0 ? 'voor' : 'achter') : b < 0 ? 'links' : 'rechts';
    it.greenPos = pos; greenSides.add(pos);
  }
  // water dat tot in de greenzone reikt (ook als het al eerder begint, zoals een meer langs de fairway)
  const greenWater = merged.filter((q) => q.kind === 'water' && q.sMax > L - GREEN_ZONE);

  // dogleg
  let dogleg = null;
  if (segs.length > 1) {
    const a = segs[0], b = segs[1];
    const turn = Math.atan2(a.fx * b.fz - a.fz * b.fx, a.fx * b.fx + a.fz * b.fz) * 180 / Math.PI;
    if (Math.abs(turn) > 12) dogleg = { dir: turn > 0 ? 'rechts' : 'links', at: a.len, deg: Math.abs(turn) };
  }
  // hoogteverschil (echte meters)
  const dh = realHeight(...P[P.length - 1]) - realHeight(...P[0]);

  // ---------- tekst ----------
  const rel = (s) => s - s0;
  const lines = [];
  for (const it of merged) {
    if (it.atGreen) continue;
    if (it.sMax - s0 < 0) continue; // al voorbij
    const from = Math.max(0, rel(it.sMin)), to = rel(it.sMax);
    if (it.kind === 'water') {
      if (it.side === 'dwars') lines.push({ icon: '💧', tone: 'danger', text: `Water dwars over de lijn op ${m(Math.max(0, rel(it.lineLo)))}`, sub: `carry ${m(rel(it.carry))} om over te zijn`, s: it.lineLo });
      else lines.push({ icon: '💧', tone: 'danger', text: `Water ${it.side} van ${m(from)} tot ${m(to)}`, sub: it.near < 4 ? 'tot tegen de speellijn' : `${m(it.near)} naast de lijn`, s: it.sMin });
    } else {
      const n = it.count > 1 ? `${it.count} bunkers` : 'Bunker';
      lines.push({ icon: '⛱', tone: 'warn', text: `${n} ${it.side === 'dwars' ? 'midden' : it.side} op ${m(from)}${to - from > 12 ? `–${m(to)}` : ''}`, sub: it.near < 4 ? 'in de speellijn' : `${m(it.near)} naast de lijn`, s: it.sMin });
    }
  }
  const green = [];
  if (greenWater.length) green.push({ icon: '💧', tone: 'danger', text: `Water bij de green (${[...new Set(greenWater.map((q) => (q.side === 'dwars' ? 'ervoor' : q.side)))].join(', ')})` });
  if (greenSides.size) green.push({ icon: '⛳', tone: 'warn', text: `Greenbunkers ${[...greenSides].join(', ')}` });
  const allSides = ['voor', 'links', 'rechts', 'achter'];
  const safe = allSides.filter((s) => !greenSides.has(s) && !(s === 'voor' && greenWater.some((q) => q.side === 'dwars')) && !greenWater.some((q) => q.side === s));
  const orList = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} of ${a.at(-1)}` : a[0]);
  if (green.length && safe.length && safe.length < 4) green.push({ icon: '✅', tone: 'ok', text: `Veilige miss: ${orList(safe)}` });
  if (green.length && !safe.length) green.push({ icon: '⚠️', tone: 'warn', text: 'Geen veilige miss: mik op het midden van de green' });
  if (!green.length) green.push({ icon: '✅', tone: 'ok', text: 'Open green, geen bunkers of water' });

  // tips
  const tips = [];
  if (dogleg) tips.push(`↪ Dogleg ${dogleg.dir} na ~${m(dogleg.at)} (${Math.round(dogleg.deg)}°)`);
  if (Math.abs(dh) >= 0.8) tips.push(`${dh > 0 ? '⬆ Green ligt' : '⬇ Green ligt'} ${Math.abs(dh).toFixed(1).replace('.', ',')} m ${dh > 0 ? 'hoger' : 'lager'}: speel ~${Math.round(Math.abs(dh))} m ${dh > 0 ? 'meer' : 'minder'}`);
  if (hole.par >= 4) {
    // landingszone van de afslag (180–250 m vanaf de tee)
    const zone = merged.filter((q) => !q.atGreen && q.sMax > 170 && q.sMin < 255);
    const left = zone.filter((q) => q.side === 'links'), right = zone.filter((q) => q.side === 'rechts'), across = zone.filter((q) => q.side === 'dwars');
    const waterCross = merged.filter((q) => q.kind === 'water' && q.side === 'dwars' && !q.atGreen);
    const driveWater = across.find((q) => q.kind === 'water' && q.carry && q.carry < 270);
    if (driveWater) {
      const w = driveWater;
      tips.push(`🎯 Afslag: carry ${m(w.carry)} over het water, of lay-up op max. ${m(Math.max(0, w.sMin - 10))}`);
    } else if (left.length && !right.length) tips.push(`🎯 Afslag: houd rechts aan, ${left[0].kind === 'water' ? 'water' : 'bunker'} links op ${m(left[0].sMin)}`);
    else if (right.length && !left.length) tips.push(`🎯 Afslag: houd links aan, ${right[0].kind === 'water' ? 'water' : 'bunker'} rechts op ${m(right[0].sMin)}`);
    else if (left.length && right.length) {
      const what = (arr) => (arr.some((q) => q.kind === 'water') ? 'water' : 'bunker');
      const first = Math.min(...zone.map((q) => q.sMin));
      tips.push(`🎯 Afslag: smal tussen ${what(left)} links en ${what(right)} rechts vanaf ~${m(first)}. Mik centraal, of lay-up op ~${m(Math.max(120, first - 10))}`);
    }
    else tips.push('🎯 Afslag: brede, vrije landingszone, driver mag');
    if (waterCross.length && !driveWater) {
      const w = waterCross[0];
      if (w.lineLo > 120) tips.push(`💧 Tweede slag: water dwars op ${m(w.lineLo)}, carry tot ${m(w.carry)} vanaf de tee`);
      else tips.push(`💧 Vanaf de tee meteen over water: carry ${m(w.carry)}`);
    }
  } else {
    tips.push(`🎯 Par 3: neem een club voor ${m(L - s0)}${greenSides.has('voor') || greenWater.length ? ', liever iets te lang dan te kort' : ''}`);
  }

  // moeilijkheid uit de stroke index
  const stars = hole.si ? Math.max(1, Math.min(5, Math.round((19 - hole.si) / 3.6))) : null;
  return { L, s0, fromMe, lines: lines.sort((a, b) => a.s - b.s), green, tips, items: merged, stars, path: P };
}
