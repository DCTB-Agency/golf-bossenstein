import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import holesData from './holes.json';
import { createGeo } from './geo.js';

const EXAG = 3; // verticale overdrijving: Bossenstein is vlak (8–23 m), dit maakt reliëf leesbaar
const STORE_KEY = 'bossenstein.holes.v1';

const $ = (id) => document.getElementById(id);
const toast = (msg, ms = 2500) => {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
};

// ---------- data ----------
const meta = await (await fetch('/data/meta.json')).json();
const heights = new Float32Array(await (await fetch('/data/height.bin')).arrayBuffer());
const treeBuf = new Float32Array(await (await fetch('/data/trees.bin')).arrayBuffer());
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

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
$('app').appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
Object.assign(labels.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
document.body.appendChild(labels.domElement);

const scene = new THREE.Scene();
const sky = new THREE.Color('#bcd6e8');
scene.background = sky;
scene.fog = new THREE.Fog(sky, 900, 2600);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 6000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 25;
controls.maxDistance = 2200;

scene.add(new THREE.HemisphereLight('#dfefff', '#4b5a33', 1.1));
const sun = new THREE.DirectionalLight('#fff4dc', 2.2);
sun.position.set(-600, 700, 400);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -800, right: 800, top: 800, bottom: -800, near: 10, far: 2500 });
sun.shadow.bias = -0.0005;
scene.add(sun);

// ---------- terrein met luchtfoto ----------
const terrainGeo = new THREE.PlaneGeometry(W, D, N - 1, N - 1);
terrainGeo.rotateX(-Math.PI / 2);
terrainGeo.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
{
  const pos = terrainGeo.attributes.position;
  for (let k = 0; k < pos.count; k++) pos.setY(k, (heights[k] - H0) * EXAG);
  terrainGeo.computeVertexNormals();
}
const ortho = await new THREE.TextureLoader().loadAsync('/data/' + meta.ortho);
ortho.colorSpace = THREE.SRGBColorSpace;
ortho.anisotropy = renderer.capabilities.getMaxAnisotropy();
const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ map: ortho, roughness: 0.95 }));
terrain.receiveShadow = true;
scene.add(terrain);

// rok rond het terrein zodat het als een maquette leest
{
  const skirt = new THREE.Mesh(
    new THREE.BoxGeometry(W + 4, 30, D + 4),
    new THREE.MeshStandardMaterial({ color: '#3b2f22', roughness: 1 })
  );
  skirt.position.set((minX + maxX) / 2, -16, (minZ + maxZ) / 2);
  scene.add(skirt);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(4000, 64), new THREE.MeshStandardMaterial({ color: '#6f8a5a' }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -31;
  scene.add(ground);
}

// ---------- water ----------
const waterMat = new THREE.MeshStandardMaterial({
  color: '#2c5f7a', roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.88,
});
const shape = (pts) => new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
for (const pts of meta.features.water) {
  if (pts.length < 4) continue;
  const g = new THREE.ShapeGeometry(shape(pts));
  g.rotateX(-Math.PI / 2);
  const shore = Math.min(...pts.map(([x, z]) => groundY(x, z)));
  const m = new THREE.Mesh(g, waterMat);
  m.position.y = shore + 0.4;
  m.receiveShadow = true;
  scene.add(m);
}

// ---------- gebouwen (o.a. kasteel & clubhuis) ----------
const bMat = new THREE.MeshStandardMaterial({ color: '#e9e2d4', roughness: 0.8 });
for (const { pts, levels } of meta.features.buildings) {
  const g = new THREE.ExtrudeGeometry(shape(pts), { depth: levels * 3.2 + 1.5, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  const base = Math.min(...pts.map(([x, z]) => groundY(x, z)));
  const m = new THREE.Mesh(g, bMat);
  m.position.y = base - 0.5;
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
}

// ---------- bomen (posities en hoogtes uit DSM-DTM) ----------
{
  const count = treeBuf.length / 3;
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 6).translate(0, 0.5, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), count);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#5a4632', roughness: 1 }), count);
  crowns.castShadow = trunks.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  const palette = ['#3f5f2c', '#4c6b31', '#566f36', '#3a5530', '#6b6a3a', '#5d4e33'];
  for (let i = 0; i < count; i++) {
    const x = treeBuf[i * 3], z = treeBuf[i * 3 + 1], h = treeBuf[i * 3 + 2];
    const y = groundY(x, z);
    const r = THREE.MathUtils.clamp(h * 0.28, 1.5, 6);
    const hh = h * 1.15; // lichte overdrijving zodat bomen bij de reliëfschaal passen
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399) % 6.283);
    m.compose(p.set(x, y + hh - r * 0.9, z), q, s.set(r, r * 1.15, r));
    crowns.setMatrixAt(i, m);
    m.compose(p.set(x, y, z), q, s.set(1.4, hh - r * 1.2, 1.4));
    trunks.setMatrixAt(i, m);
    crowns.setColorAt(i, c.set(palette[i % palette.length]).offsetHSL(0, 0, ((i * 7919) % 100) / 1000 - 0.05));
  }
  scene.add(crowns, trunks);
}

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
      if (active) {
        const mid = pts[Math.floor(pts.length / 2)].clone(); mid.y += 6;
        holeGroup.add(label(`${Math.round(holeLength(h))} m gemeten`, '', mid));
      }
    }
    (h.via || []).forEach((p) => {
      if (!active) return;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), new THREE.MeshBasicMaterial({ color: '#e8c547' }));
      dot.position.copy(v3(p, 1.2)); holeGroup.add(dot);
    });
  });
  updatePanel();
}

function updatePanel() {
  const h = holes[current];
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
  const hit = ray.intersectObject(terrain)[0];
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
  renderer.render(scene, camera);
  labels.render(scene, camera);
});

overview(true);
renderHoles();
window.__golf = { scene, camera, controls, holes, geo, groundY };
