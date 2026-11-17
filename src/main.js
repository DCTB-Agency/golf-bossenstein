import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import holesData from './holes.json';
import { createGeo } from './geo.js';
import { buildWorld } from './world.js';
import { makeBriefingData, analyzeHole } from './briefing.js';

const DATA = import.meta.env.BASE_URL + 'data/'; // werkt lokaal (/) en op GitHub Pages (/golf-bossenstein/)

const EXAG = 1.6; // lichte verticale overdrijving: Bossenstein is vlak (8–23 m)
const STORE_KEY = 'bossenstein.holes.v1';

const $ = (id) => document.getElementById(id);
const toast = (msg, ms = 2500) => {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
};

// ---------- data ----------
const meta = await (await fetch(DATA + 'meta.json')).json();
const heights = new Float32Array(await (await fetch(DATA + 'height.bin')).arrayBuffer());
const geo = createGeo(meta);
$('attrib').textContent = meta.attribution;

const { minX, maxX, minZ, maxZ } = meta.extent;
const W = maxX - minX, D = maxZ - minZ, N = meta.height.size, H0 = meta.height.min;

// hoogte (scene-eenheden) op lokale x/z, bilineair
function groundY(x, z) {
  const fx = THREE.MathUtils.clamp(((x - minX) / W) * (N - 1), 0, N - 1.001);
  const fz = THREE.MathUtils.clamp(((z - minZ) / D) * (N - 1), 0, N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const h = (a, b) => heights[b * N + a];
  const v = (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz;
  return (v - H0) * EXAG;
}
const realHeight = (x, z) => groundY(x, z) / EXAG + H0; // echte meters TAW

// hindernissen (water uit OSM, bunkers herkend op de luchtfoto) voor de hole-briefing
const hazards = await (await fetch(DATA + meta.hazards)).json();
const briefingData = makeBriefingData(meta, hazards);

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
$('app').appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
Object.assign(labels.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
document.body.appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 30000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.485;
controls.minDistance = 8;
controls.maxDistance = 2600;

const world = await buildWorld({ scene, renderer, meta, heights, exag: EXAG, groundY });
const terrain = world.terrainMeshes;

// ---------- holes ----------
let holes = loadHoles();
let current = 0;
const holeGroup = new THREE.Group();
scene.add(holeGroup);

// officiële data uit holes.json, posities uit localStorage (als die er zijn) eroverheen
function loadHoles() {
  const holes = structuredClone(holesData.holes);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved?.length === 18) saved.forEach((s, i) => {
      if (s.tee || s.green) Object.assign(holes[i], { tee: s.tee, green: s.green, via: s.via || [] });
    });
  } catch {}
  return holes;
}
const TEES = holesData.tees;
let teeId = (() => { try { return localStorage.getItem('bossenstein.tee') || 'MWH'; } catch { return 'MWH'; } })();
{
  const sel = $('tee-select');
  sel.innerHTML = TEES.map((t) => `<option value="${t.id}">${t.name} — CR ${t.cr} / SR ${t.sr}</option>`).join('');
  sel.value = teeId;
  sel.onchange = () => {
    teeId = sel.value;
    try { localStorage.setItem('bossenstein.tee', teeId); } catch {}
    updatePanel();
  };
}
function saveHoles() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(holes)); } catch {}
}

const v3 = ([lon, lat], lift = 0) => {
  const [x, z] = geo.toLocal(lon, lat);
  return new THREE.Vector3(x, groundY(x, z) + lift, z);
};
const holePath = (h) => (h.tee && h.green ? [h.tee, ...(h.via || []), h.green] : null);
const holeLength = (h) => {
  const p = holePath(h); if (!p) return null;
  let d = 0; for (let i = 1; i < p.length; i++) d += geo.distance(p[i - 1], p[i]);
  return d;
};

function label(text, cls, pos) {
  const el = document.createElement('div');
  el.className = 'label ' + (cls || ''); el.textContent = text;
  const o = new CSS2DObject(el); o.position.copy(pos); return o;
}

function flag(pos, color) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 9, 8), new THREE.MeshStandardMaterial({ color: '#f5f5f5' }));
  pole.position.y = 4.5;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide }));
  cloth.position.set(1.6, 8, 0);
  g.add(pole, cloth); g.position.copy(pos); g.traverse((o) => (o.castShadow = true));
  return g;
}

function renderHoles() {
  holeGroup.clear();
  holes.forEach((h, idx) => {
    const path = holePath(h);
    const active = idx === current;
    if (h.green) {
      holeGroup.add(flag(v3(h.green), active ? '#e8c547' : '#d23c3c'));
      if (active || !path) holeGroup.add(label(`${h.no}`, 'flag', v3(h.green, 12)));
    }
    if (h.tee) {
      const tee = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.6, 20), new THREE.MeshStandardMaterial({ color: active ? '#ffffff' : '#cfd8d0' }));
      tee.position.copy(v3(h.tee, 0.3)); holeGroup.add(tee);
      holeGroup.add(label(`Tee ${h.no}`, '', v3(h.tee, 5)));
    }
    if (path) {
      const pts = [];
      for (let i = 1; i < path.length; i++) {
        const a = v3(path[i - 1]), b = v3(path[i]);
        const steps = Math.ceil(a.distanceTo(b) / 5);
        for (let s = 0; s <= steps; s++) {
          const p = a.clone().lerp(b, s / steps);
          p.y = groundY(p.x, p.z) + (active ? 1.2 : 0.8);
          pts.push(p);
        }
      }
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, active ? 0.9 : 0.5, 6),
        new THREE.MeshBasicMaterial({ color: active ? '#e8c547' : '#ffffff', transparent: true, opacity: active ? 0.95 : 0.45 })
      );
      holeGroup.add(tube);
      if (active) addBriefingMarkers(h);
    }
    (h.via || []).forEach((p) => {
      if (!active) return;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), new THREE.MeshBasicMaterial({ color: '#e8c547' }));
      dot.position.copy(v3(p, 1.2)); holeGroup.add(dot);
    });
  });
  updatePanel();
}

// afstandspaaltjes langs de lijn + labels bij de hindernissen van de actieve hole
function addBriefingMarkers(h) {
  const a = analyzeHole({ hole: h, geo, data: briefingData, realHeight, me });
  if (!a) return;
  const P = a.path;
  const at = (s) => { // punt op afstand s langs de lijn
    let rest = s;
    for (let i = 1; i < P.length; i++) {
      const [ax, az] = P[i - 1], [bx, bz] = P[i], len = Math.hypot(bx - ax, bz - az);
      if (rest <= len || i === P.length - 1) { const t = Math.min(1, rest / len); return [ax + (bx - ax) * t, az + (bz - az) * t]; }
      rest -= len;
    }
  };
  for (let s = 50; s < a.L - 25; s += 50) {
    const [x, z] = at(s), y = groundY(x, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 2.4, 8), new THREE.MeshStandardMaterial({ color: s % 100 ? '#ffffff' : '#e8c547' }));
    post.position.set(x, y + 1.2, z); holeGroup.add(post);
    if (s % 100 === 0 || a.L < 230) holeGroup.add(label(`${s}`, 'dist', new THREE.Vector3(x, y + 4, z)));
  }
  for (const it of a.items) {
    const [cx, cz] = it.c;
    const near = it.atGreen ? `green ${it.greenPos || ''}`.trim() : it.side === 'dwars' && it.kind === 'water' ? `carry ${Math.round(it.sMax - a.s0)}` : `${Math.round(it.sMin - a.s0)} m`;
    holeGroup.add(label(`${it.kind === 'water' ? '💧' : '⛱'} ${near}`, it.kind === 'water' ? 'hz water' : 'hz sand', new THREE.Vector3(cx, groundY(cx, cz) + 5, cz)));
  }
}

let briefingOpen = null;
function renderBriefing(h) {
  const el = $('briefing');
  const a = analyzeHole({ hole: h, geo, data: briefingData, realHeight, me });
  if (!a) { el.innerHTML = '<p class="muted">Teken tee en green in om de briefing te zien.</p>'; return; }
  const row = (r) => `<li class="${r.tone || ''}"><span class="ic">${r.icon}</span><span>${r.text}${r.sub ? `<small>${r.sub}</small>` : ''}</span></li>`;
  // inklapbaar: op gsm standaard dicht zodat de baan zichtbaar blijft; keuze blijft bewaard
  if (briefingOpen === null) briefingOpen = !matchMedia('(max-width: 640px)').matches;
  const count = a.lines.length + a.green.filter((g) => g.tone !== 'ok').length;
  el.innerHTML = `
    <details ${briefingOpen ? 'open' : ''}>
      <summary class="b-head"><strong>Hole-briefing <em>${count} aandachtspunt${count === 1 ? '' : 'en'}</em></strong><span>${a.stars ? '★'.repeat(a.stars) + '☆'.repeat(5 - a.stars) : ''}</span></summary>
      <p class="muted">${a.fromMe ? `Afstanden vanaf jouw positie (nog ${Math.round(a.L - a.s0)} m)` : `Afstanden vanaf de tee · ${Math.round(a.L)} m langs de speellijn`}</p>
      ${a.lines.length ? `<ul>${a.lines.map(row).join('')}</ul>` : '<p class="muted">Geen water of bunkers in de speellijn.</p>'}
      <div class="b-sub">Rond de green</div><ul>${a.green.map(row).join('')}</ul>
      <div class="b-sub">Speltips</div><ul class="tips">${a.tips.map((t) => `<li>${t}</li>`).join('')}</ul>
    </details>`;
  el.querySelector('details').addEventListener('toggle', (e) => { briefingOpen = e.target.open; });
}

function updatePanel() {
  const h = holes[current];
  renderBriefing(h);
  $('hole-no').textContent = h.no;
  $('hole-par').textContent = h.par ?? '–';
  $('hole-si').textContent = h.si ?? '–';
  const official = h.length?.[teeId];
  $('hole-len').textContent = official ? `${official} m` : '–';
  // editor: officiële tekening + gemeten lengte vs scorekaart (witte tee = verste)
  const len = holeLength(h);
  if ($('drawing').dataset.no !== String(h.no)) {
    $('drawing').src = h.drawing; $('drawing').dataset.no = h.no; $('drawing-link').href = h.drawing;
  }
  // posities worden ingetekend vanaf de gele tee
  const m = $('measure'), ref = h.length?.MYE;
  if (!len) { m.textContent = `Nog niet ingetekend · doel ${ref} m (geel)`; m.className = 'measure'; }
  else {
    const diff = Math.round(len - ref);
    m.textContent = `Gemeten ${Math.round(len)} m · scorekaart ${ref} m (geel) · ${diff >= 0 ? '+' : ''}${diff} m`;
    m.className = 'measure ' + (Math.abs(diff) <= Math.max(8, ref * 0.05) ? 'ok' : 'off');
  }
  if (h.status?.includes('controleren')) { m.textContent += ' · ⚠ te controleren'; m.className = 'measure off'; }
  $('hole-togo').textContent = me && h.green ? `${Math.round(geo.distance(me, h.green))} m` : '–';
  const strip = $('hole-strip');
  if (!strip.children.length) {
    holes.forEach((hh, i) => {
      const b = document.createElement('button');
      b.innerHTML = `${hh.no}<small>par ${hh.par}</small>`;
      b.onclick = () => selectHole(i);
      strip.appendChild(b);
    });
  }
  [...strip.children].forEach((b, i) => {
    b.classList.toggle('active', i === current);
    b.classList.toggle('missing', !holePath(holes[i]));
    b.title = holes[i].status || '';
  });
  strip.children[current]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

// ---------- camera ----------
let fly = null;
function flyTo(target, position, ms = 1400) {
  fly = { t0: performance.now(), ms, fromT: controls.target.clone(), toT: target, fromP: camera.position.clone(), toP: position };
}
function overview(instant) {
  const t = new THREE.Vector3(0, 0, -120), p = new THREE.Vector3(-150, 900, 750);
  if (instant) { controls.target.copy(t); camera.position.copy(p); } else flyTo(t, p);
}
function viewHole(h) {
  const path = holePath(h);
  if (!path) {
    toast(`Hole ${h.no} is nog niet ingetekend — gebruik ✎ Intekenen`);
    return;
  }
  const tee = v3(h.tee), green = v3(h.green);
  const dir = green.clone().sub(tee); dir.y = 0;
  const len = dir.length(); dir.normalize();
  const target = tee.clone().lerp(green, 0.55);
  const pos = tee.clone().addScaledVector(dir, -Math.max(60, len * 0.35));
  pos.y += Math.max(70, len * 0.45);
  flyTo(target, pos);
}
function selectHole(i) {
  current = (i + 18) % 18;
  renderHoles();
  viewHole(holes[current]);
}
$('prev').onclick = () => selectHole(current - 1);
$('next').onclick = () => selectHole(current + 1);
$('btn-overview').onclick = () => overview(false);

// ---------- editor: tee / green / knikpunt plaatsen ----------
let placing = null;
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
$('btn-edit').onclick = (e) => {
  const ed = $('editor'); ed.hidden = !ed.hidden;
  e.currentTarget.classList.toggle('active', !ed.hidden);
};
document.querySelectorAll('[data-place]').forEach((b) => {
  b.onclick = () => {
    placing = placing === b.dataset.place ? null : b.dataset.place;
    document.querySelectorAll('[data-place]').forEach((x) => x.classList.toggle('active', x.dataset.place === placing));
    document.body.classList.toggle('placing', !!placing);
    if (placing) toast(`Klik op de kaart om de ${placing === 'dogleg' ? 'knik' : placing} van hole ${holes[current].no} te plaatsen`);
  };
});
$('clear-hole').onclick = () => {
  Object.assign(holes[current], { tee: null, green: null, via: [] });
  saveHoles(); renderHoles();
};
$('export').onclick = async () => {
  const json = JSON.stringify({ ...holesData, holes }, null, 2);
  try { await navigator.clipboard.writeText(json); toast('JSON gekopieerd — plak in src/holes.json'); }
  catch {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([json])), download: 'holes.json' });
    a.click();
  }
};
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!placing || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(terrain, false)[0];
  if (!hit) return;
  const ll = geo.toLonLat(hit.point.x, hit.point.z).map((v) => +v.toFixed(7));
  const h = holes[current];
  if (placing === 'dogleg') (h.via ||= []).push(ll); else h[placing] = ll;
  if (placing !== 'dogleg') {
    placing = null; document.body.classList.remove('placing');
    document.querySelectorAll('[data-place]').forEach((x) => x.classList.remove('active'));
  }
  saveHoles(); renderHoles();
});

// ---------- GPS ----------
let me = null, meMarker = null, watchId = null;
$('btn-gps').onclick = (e) => {
  const btn = e.currentTarget;
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId); watchId = null; btn.classList.remove('active');
    if (meMarker) scene.remove(meMarker); me = null; updatePanel(); return;
  }
  if (!navigator.geolocation) return toast('GPS niet beschikbaar op dit toestel');
  btn.classList.add('active');
  watchId = navigator.geolocation.watchPosition((p) => {
    me = [p.coords.longitude, p.coords.latitude];
    const [x, z] = geo.toLocal(...me);
    if (!geo.inside(x, z)) { toast('Je bent niet op Bossenstein — locatie buiten de kaart'); }
    if (!meMarker) {
      meMarker = new THREE.Group();
      const dot = new THREE.Mesh(new THREE.SphereGeometry(2.2, 20, 12), new THREE.MeshBasicMaterial({ color: '#2f80ed' }));
      dot.position.y = 2.2;
      meMarker.add(dot, label('Jij', 'me', new THREE.Vector3(0, 9, 0)));
    }
    scene.add(meMarker);
    meMarker.position.set(x, groundY(x, z), z);
    updatePanel();
  }, (err) => { toast('GPS: ' + err.message); btn.classList.remove('active'); watchId = null; },
  { enableHighAccuracy: true, maximumAge: 2000 });
};

// ---------- loop ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight);
});
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
renderer.setAnimationLoop((now) => {
  if (fly) {
    const t = Math.min(1, (now - fly.t0) / fly.ms), k = ease(t);
    controls.target.lerpVectors(fly.fromT, fly.toT, k);
    camera.position.lerpVectors(fly.fromP, fly.toP, k);
    if (t >= 1) fly = null;
  }
  controls.update();
  world.update(camera, controls.target, now);
  renderer.render(scene, camera);
  labels.render(scene, camera);
});

overview(true);
renderHoles();
window.__golf = { scene, camera, controls, holes, geo, groundY };
