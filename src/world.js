// De 3D-wereld: terrein met luchtfoto-tegels, gebouwen, bomen, water, lucht en zon.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const SUN_ELEV = 38, SUN_AZIM = 205; // middag-namiddagzon uit het zuidwesten

export async function buildWorld({ scene, renderer, meta, heights, exag, groundY }) {
  const { minX, maxX, minZ, maxZ } = meta.extent;
  const W = maxX - minX, D = maxZ - minZ, N = meta.height.size, H0 = meta.height.min;
  const { n: TN, seg: SEG, dirs } = meta.tiles;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const lowEnd = matchMedia('(max-width: 800px)').matches || (navigator.deviceMemory ?? 8) < 4;
  const loader = new THREE.TextureLoader();
  const prepTex = (t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };

  // ---------- lucht + omgevingslicht ----------
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - SUN_ELEV), THREE.MathUtils.degToRad(SUN_AZIM));
  const sky = new Sky();
  sky.scale.setScalar(20000);
  const u = sky.material.uniforms;
  u.turbidity.value = 5; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky(); envSky.scale.setScalar(1000);
    envSky.material.uniforms.sunPosition.value.copy(sunDir);
    envSky.material.uniforms.turbidity.value = 5; envSky.material.uniforms.rayleigh.value = 1.2;
    envScene.add(envSky);
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.22; // de hemel-shader is HDR-fel; anders wordt alles flets
  }
  scene.fog = new THREE.Fog('#c9d8e2', 1400, 4200);

  const hemi = new THREE.HemisphereLight('#dbe9f6', '#66784a', 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1d6', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(lowEnd ? 2048 : 4096);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  // ---------- terrein: 4x4 tegels, normalen uit het volledige raster (geen naden) ----------
  const hAt = (i, j) => (heights[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))] - H0) * exag;
  const cellX = W / (N - 1), cellZ = D / (N - 1);
  const tileW = W / TN, tileD = D / TN;
  const terrainMeshes = [];
  const mosaic = prepTex(await loader.loadAsync('/data/' + meta.ortho4k));
  const terrainGroup = new THREE.Group();
  scene.add(terrainGroup);
  // fijne grasdetail (alleen dichtbij zichtbaar) voor extra scherpte boven de luchtfoto-resolutie
  const detailTex = (() => {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const x = c.getContext('2d'), img = x.createImageData(s, s);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < s * s; k++) { const v = 128 + (rnd() - 0.5) * 70; img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = v; img.data[k * 4 + 3] = 255; }
    x.putImageData(img, 0, 0);
    x.globalAlpha = 0.25; // grassprieten
    for (let k = 0; k < 2500; k++) { const px = rnd() * s, py = rnd() * s; x.strokeStyle = rnd() > 0.5 ? '#fff' : '#000'; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (rnd() - 0.5) * 3, py - 2 - rnd() * 4); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso;
    return t;
  })();
  const addDetail = (mat) => {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.detailMap = { value: detailTex };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float dDist = distance(vWPos, cameraPosition);
          float dFade = 1.0 - smoothstep(25.0, 260.0, dDist);
          float dA = texture2D(detailMap, vWPos.xz / 3.0).r;
          float dB = texture2D(detailMap, vWPos.xz / 11.0 + 0.37).r;
          diffuseColor.rgb *= mix(1.0, (dA * 0.6 + dB * 0.4) * 1.9 - 0.0, 0.32 * dFade);`);
    };
    return mat;
  };
  for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
    const g = new THREE.PlaneGeometry(tileW, tileD, SEG, SEG);
    g.rotateX(-Math.PI / 2);
    g.translate(minX + (i + 0.5) * tileW, 0, minZ + (j + 0.5) * tileD);
    const pos = g.attributes.position, nor = g.attributes.normal;
    for (let k = 0; k < pos.count; k++) {
      const ix = k % (SEG + 1), iy = Math.floor(k / (SEG + 1));
      const gi = i * SEG + ix, gj = j * SEG + iy;
      pos.setY(k, hAt(gi, gj));
      const nx = -(hAt(gi + 1, gj) - hAt(gi - 1, gj)) / (2 * cellX);
      const nz = -(hAt(gi, gj + 1) - hAt(gi, gj - 1)) / (2 * cellZ);
      const l = Math.hypot(nx, 1, nz);
      nor.setXYZ(k, nx / l, 1 / l, nz / l);
    }
    g.computeBoundingSphere();
    // eerst het 4k-mozaïek (snel), daarna de scherpe tegel
    const low = mosaic.clone();
    low.repeat.set(1 / TN, 1 / TN); low.offset.set(i / TN, 1 - (j + 1) / TN); low.needsUpdate = true;
    const mat = addDetail(new THREE.MeshStandardMaterial({ map: low, roughness: 0.97, metalness: 0, envMapIntensity: 0.55 }));
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    terrainGroup.add(m); terrainMeshes.push(m);
    loader.loadAsync(`/data/${lowEnd ? dirs.lo : dirs.hi}/t_${j}_${i}.jpg`).then((t) => {
      mat.map = prepTex(t); mat.needsUpdate = true; low.dispose();
    });
  }
  // maquette-rand + omgeving
  {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 2, 30, D + 2), new THREE.MeshStandardMaterial({ color: '#3d3226', roughness: 1 }));
    skirt.position.set((minX + maxX) / 2, -15.2, (minZ + maxZ) / 2);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(9000, 64), new THREE.MeshStandardMaterial({ color: '#6c7f55', roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -30.5;
    scene.add(skirt, ground);
  }

  // ---------- water: rimpelend, spiegelt de lucht ----------
  const waterNormal = (() => {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const ctx = c.getContext('2d'), img = ctx.createImageData(s, s);
    // alleen gehele frequenties: naadloos herhalend
    const hgt = (x, y) => Math.sin((x * 6.283 * 3) / s + Math.sin((y * 6.283 * 2) / s) * 1.3) * 0.5 + Math.sin(((x * 7 + y * 4) * 6.283) / s) * 0.25 + Math.sin(((y * 11 - x * 3) * 6.283) / s) * 0.12;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = hgt(x + 1, y) - hgt(x - 1, y), dy = hgt(x, y + 1) - hgt(x, y - 1);
      const v = new THREE.Vector3(-dx * 2, -dy * 2, 1).normalize(), o = (y * s + x) * 4;
      img.data[o] = (v.x * 0.5 + 0.5) * 255; img.data[o + 1] = (v.y * 0.5 + 0.5) * 255; img.data[o + 2] = (v.z * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(0.05, 0.05);
    return t;
  })();
  const waterMat = new THREE.MeshStandardMaterial({ color: '#1d3234', roughness: 0.18, metalness: 0.1, envMapIntensity: 0.8 });
  const shapeOf = (pts) => new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const pts of meta.features.water) {
    if (pts.length < 4) continue;
    const g = new THREE.ShapeGeometry(shapeOf(pts));
    g.rotateX(-Math.PI / 2);
    // wereld-UV zodat de golfjes over alle vijvers even groot zijn
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let k = 0; k < p.count; k++) uv.setXY(k, p.getX(k), p.getZ(k));
    // waterpeil net boven het hoogste maaiveld binnen de vijver (DTM is over water geïnterpoleerd)
    let level = -Infinity;
    for (let k = 0; k < p.count; k++) level = Math.max(level, groundY(p.getX(k), p.getZ(k)));
    const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
    const inside = (x, z) => { let c = false; for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) { const [xi, zi] = pts[a], [xj, zj] = pts[b]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 2) for (let z = Math.min(...zs); z <= Math.max(...zs); z += 2)
      if (inside(x, z)) level = Math.max(level, groundY(x, z));
    const m = new THREE.Mesh(g, waterMat);
    m.position.y = level + 0.12; m.receiveShadow = true;
    scene.add(m);
  }

  // ---------- gebouwen: GRB-contour, muren tot dakgoot, dak uit DSM, dakfoto uit luchtfoto ----------
  const buildings = await (await fetch('/data/' + meta.buildings)).json();
  const wallTex = (() => { // gevel: baksteen + ramen per travee van 3 m
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 256, 256);
    for (let r = 0; r < 64; r++) for (let k = 0; k < 16; k++) { // voegwerk
      x.fillStyle = `rgba(0,0,0,${0.04 + ((r * 7 + k * 13) % 5) * 0.012})`;
      x.fillRect(((k * 16) + (r % 2) * 8) % 256, r * 4, 15, 3);
    }
    x.fillStyle = '#2b3237'; x.fillRect(84, 70, 88, 110);           // raam
    x.fillStyle = 'rgba(160,190,210,0.35)'; x.fillRect(90, 76, 76, 46); // reflectie
    x.strokeStyle = '#e9e5dc'; x.lineWidth = 6; x.strokeRect(84, 70, 88, 110);
    x.beginPath(); x.moveTo(128, 70); x.lineTo(128, 180); x.moveTo(84, 125); x.lineTo(172, 125); x.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso;
    return t;
  })();
  const roofTex = prepTex(mosaic.clone()); roofTex.needsUpdate = true;
  const palettes = ['#9c5b45', '#a8674e', '#8e4f3c', '#c9b79c', '#e6e0d4', '#b9a58a', '#7d6a5a', '#d8d2c6'];
  const walls = [], roofs = [];
  const uvWorld = (x, z) => [(x - minX) / W, 1 - (z - minZ) / D];
  const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
  for (const [bi, b] of buildings.entries()) {
    const base = (b.b - H0) * exag - 0.6;
    const eave = (b.b - H0) * exag + b.e, ridge = (b.b - H0) * exag + b.r;
    const shed = /bijgebouw|afdak/i.test(b.t);
    const col = new THREE.Color(palettes[hash(bi + b.t) % (shed ? 3 : palettes.length) + (shed ? 5 : 0)] || palettes[0]);
    // muren
    const pos = [], uv = [], colArr = [];
    let run = 0;
    const p = b.p;
    for (let k = 0; k < p.length; k++) {
      const [x1, z1] = p[k], [x2, z2] = p[(k + 1) % p.length];
      const len = Math.hypot(x2 - x1, z2 - z1);
      const u0 = run / 3, u1 = (run + len) / 3, v0 = 0, v1 = (eave - base) / 3;
      pos.push(x1, base, z1, x2, base, z2, x2, eave, z2, x1, base, z1, x2, eave, z2, x1, eave, z1);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
      for (let q = 0; q < 6; q++) colArr.push(col.r, col.g, col.b);
      run += len;
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    wg.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    walls.push(wg);
    // dak
    if (b.roof === 'gable' && b.obb) {
      const [cx, cz, ang, len, wid] = b.obb, o = 0.35;
      const ux = Math.cos(ang), uz = Math.sin(ang), vx = -uz, vz = ux;
      const L = len / 2 + o, Wd = wid / 2 + o;
      const P = (a, c, y) => [cx + ux * a + vx * c, y, cz + uz * a + vz * c];
      const e1 = P(-L, -Wd, eave - 0.15), e2 = P(L, -Wd, eave - 0.15), e3 = P(L, Wd, eave - 0.15), e4 = P(-L, Wd, eave - 0.15);
      const r1 = P(-L, 0, ridge), r2 = P(L, 0, ridge);
      const tri = [e1, e2, r2, e1, r2, r1, e3, e4, r1, e3, r1, r2];
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(tri.flat(), 3));
      rg.setAttribute('uv', new THREE.Float32BufferAttribute(tri.flatMap(([x, , z]) => uvWorld(x, z)), 2));
      roofs.push(rg);
      // topgevels (driehoeken) in muurmateriaal
      const gL = [P(-len / 2, -wid / 2, eave), P(-len / 2, wid / 2, eave), P(-len / 2, 0, ridge)];
      const gR = [P(len / 2, wid / 2, eave), P(len / 2, -wid / 2, eave), P(len / 2, 0, ridge)];
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute([...gL, ...gR].flat(), 3));
      gg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, wid / 3, 0, wid / 6, (ridge - eave) / 3, 0, 0, wid / 3, 0, wid / 6, (ridge - eave) / 3], 2));
      gg.setAttribute('color', new THREE.Float32BufferAttribute(Array(6).fill([col.r, col.g, col.b]).flat(), 3));
      walls.push(gg);
    } else {
      const sg = new THREE.ShapeGeometry(shapeOf(p));
      sg.rotateX(-Math.PI / 2);
      sg.translate(0, eave, 0);
      const sp = sg.attributes.position, su = sg.attributes.uv;
      for (let k = 0; k < sp.count; k++) su.setXY(k, ...uvWorld(sp.getX(k), sp.getZ(k)));
      roofs.push(sg.toNonIndexed());
    }
  }
  const prepMerged = (arr) => {
    const g = mergeGeometries(arr.map((g) => { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute('normal'); return n; }));
    g.computeVertexNormals(); return g;
  };
  const wallMesh = new THREE.Mesh(prepMerged(walls), new THREE.MeshStandardMaterial({ map: wallTex, vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  const roofMesh = new THREE.Mesh(prepMerged(roofs), new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.75, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }));
  for (const m of [wallMesh, roofMesh]) { m.castShadow = m.receiveShadow = true; scene.add(m); }

  // ---------- bomen: echte positie, hoogte, kroonbreedte en fotokleur ----------
  const trees = new Float32Array(await (await fetch('/data/' + meta.trees.file)).arrayBuffer());
  const S = meta.trees.stride, count = trees.length / S;
  const noise3 = (x, y, z) => Math.sin(x * 3.1 + y * 1.7) * Math.cos(z * 2.3 - x * 1.1) * 0.5 + Math.sin(y * 5.3 + z * 4.1) * 0.25;
  const blobCrown = () => { // loofkroon: samengestelde, licht vervormde bollen
    const parts = [[0, 0, 0, 1], [0.45, -0.15, 0.2, 0.7], [-0.4, -0.1, -0.25, 0.72], [0.1, 0.3, -0.35, 0.62], [-0.2, 0.25, 0.4, 0.6]];
    const g = mergeGeometries(parts.map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 2).translate(x, y, z)));
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, k);
      v.multiplyScalar(1 + noise3(v.x * 2, v.y * 2, v.z * 2) * 0.12);
      p.setXYZ(k, v.x * 0.72, v.y * 0.72, v.z * 0.72);
    }
    g.computeVertexNormals();
    return g;
  };
  const coniferCrown = () => {
    const a = new THREE.ConeGeometry(1, 0.62, 9, 1).translate(0, -0.19, 0);
    const b = new THREE.ConeGeometry(0.78, 0.55, 9, 1).translate(0, 0.08, 0);
    const c = new THREE.ConeGeometry(0.52, 0.45, 9, 1).translate(0, 0.32, 0);
    return mergeGeometries([a, b, c].map((g) => g.toNonIndexed()));
  };
  const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, envMapIntensity: 0.12 });
  const nDec = [...Array(count).keys()].filter((i) => !trees[i * S + 7]).length;
  const dec = new THREE.InstancedMesh(blobCrown(), leafMat, nDec);
  const con = new THREE.InstancedMesh(coniferCrown(), leafMat.clone(), count - nDec);
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.16, 1, 7).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: '#4d3c2c', roughness: 1 }), count);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  let di = 0, ci = 0;
  for (let i = 0; i < count; i++) {
    const o = i * S, x = trees[o], z = trees[o + 1], h = trees[o + 2], r = trees[o + 3], isCon = trees[o + 7] > 0.5;
    const y = groundY(x, z);
    q.setFromAxisAngle(up, (i * 2.399) % 6.283);
    // fotokleur, naar bladgroen getrokken (de luchtfoto is wat waziger/blauwer dan de werkelijkheid)
    c.setRGB(trees[o + 4], trees[o + 5], trees[o + 6], THREE.SRGBColorSpace);
    const hsl = {}; c.getHSL(hsl);
    const hue = THREE.MathUtils.lerp(hsl.h > 0.5 ? 0.27 : hsl.h, 0.25 + ((i * 37) % 9) * 0.008, 0.55);
    c.setHSL(hue, THREE.MathUtils.clamp(hsl.s * 1.4 + 0.14, 0.28, 0.62), THREE.MathUtils.clamp(hsl.l * 1.05 + 0.04, 0.2, 0.4), THREE.SRGBColorSpace);
    if (isCon) {
      const ch = h * 0.88;
      mtx.compose(ps.set(x, y + h - ch / 2, z), q, sc.set(r * 1.1, ch, r * 1.1));
      con.setMatrixAt(ci, mtx); con.setColorAt(ci++, c.offsetHSL(0.03, -0.05, -0.02));
      mtx.compose(ps.set(x, y, z), q, sc.set(1.3, h * 0.25, 1.3));
    } else {
      const ch = h * 0.74;
      mtx.compose(ps.set(x, y + h - ch / 2, z), q, sc.set(r * 1.08, ch / 1.45, r * 1.08));
      dec.setMatrixAt(di, mtx); dec.setColorAt(di++, c);
      mtx.compose(ps.set(x, y, z), q, sc.set(1 + r * 0.15, h - ch * 0.8, 1 + r * 0.15));
    }
    trunk.setMatrixAt(i, mtx);
  }
  for (const m of [dec, con, trunk]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }

  // ---------- per frame: schaduwen volgen de camera, water rimpelt ----------
  const tmp = new THREE.Vector3();
  let lastExt = 0;
  function update(camera, target, t) {
    const dist = camera.position.distanceTo(target);
    const ext = THREE.MathUtils.clamp(dist * 0.75, 90, 900);
    sun.target.position.copy(target);
    sun.position.copy(target).add(tmp.copy(sunDir).multiplyScalar(1500));
    if (Math.abs(ext - lastExt) > ext * 0.1) {
      Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 100, far: 3200 });
      sun.shadow.camera.updateProjectionMatrix(); lastExt = ext;
    }
    waterNormal.offset.set(t * 0.000012, t * 0.000008);
  }

  return { terrainMeshes, update, lowEnd };
}
