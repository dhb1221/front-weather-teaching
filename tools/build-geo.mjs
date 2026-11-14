/* ============================================================
 * tools/build-geo.mjs — 生成离线地图数据
 *   node tools/build-geo.mjs
 * 输入：tools/raw/china-100000_full.json（DataV.GeoAtlas 中国省级边界，含南海诸岛九段线）
 *       tools/raw/world-110m.json（Natural Earth 1:110m 国家边界，TopoJSON，公有领域）
 * 输出：src/geo-china.js  window.GEO_CHINA  { provinces, jd }
 *       src/geo-world.js  window.GEO_WORLD  { countries }
 * 坐标一律为 [经度, 纬度]，保留 2 位小数；绘制时由 src/geo.js 投影。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const RAW = path.join(ROOT, 'tools/raw');

/* ---------- Ramer-Douglas-Peucker 简化 ---------- */
function dist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (!l2) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}
function rdp(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = dist2(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
function ringArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s / 2);
}
function simplifyRing(ring, tol, minArea) {
  let pts = rdp(ring, tol);
  if (pts.length < 4) return null;
  if (ringArea(pts) < minArea) return null;
  // 闭合
  if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) pts.push(pts[0]);
  return pts.map(p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
}

/* ---------- 中国省级边界 ---------- */
const china = JSON.parse(fs.readFileSync(path.join(RAW, 'china-100000_full.json'), 'utf8'));
const provinces = [];
let jd = null;

/* 界线要素（JD：南海诸岛九段线 + 台湾以东界段）单独提取，不做面积过滤 */
const jdFeature0 = china.features.find(f => String(f.properties.adcode) === '100000_JD');
if (jdFeature0) {
  const polys = jdFeature0.geometry.type === 'Polygon' ? [jdFeature0.geometry.coordinates] : jdFeature0.geometry.coordinates;
  const rings = [];
  for (const poly of polys) for (const ring of poly) {
    let s = simplifyRing(ring, 0.02, 0);
    if (!s) {
      /* 短小的界段（九段线里的短线）直接圆整保留 */
      s = ring.map(p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    }
    if (s.length >= 2) rings.push(s);
  }
  jd = { name: '南海诸岛', rings };
}

for (const f of china.features) {
  if (String(f.properties.adcode) === '100000_JD') continue;
  const name = (f.properties && f.properties.name) || '';
  const adcode = String(f.properties.adcode);
  /* 面积特别小的省级单元（澳门、香港、台湾）必须保留全部多边形，否则会被面积阈值滤掉 */
  const tiny = adcode === '810000' || adcode === '820000' || adcode === '710000';
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let rings = [];
  for (const poly of polys) {
    for (let ri = 0; ri < poly.length; ri++) {
      const ring = poly[ri];
      const tol = tiny ? 0.008 : (ri === 0 ? 0.02 : 0.015);
      const minArea = tiny ? 0 : (ri === 0 ? 0.004 : 0.002);
      const s = simplifyRing(ring, tol, minArea);
      if (s) rings.push(s);
    }
  }
  /* 兜底：过滤后没有环时，不再做面积过滤，原始坐标圆整保留 */
  if (!rings.length) {
    for (const poly of polys) for (const ring of poly) {
      const s = ring.map(p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
      if (s.length >= 2) rings.push(s);
    }
  }
  if (!rings.length) continue;
  if (name === '南海诸岛' || String(f.properties.adcode) === '100000_JD') {
    jd = { name: '南海诸岛', rings };
  } else {
    provinces.push({ name, adcode: f.properties.adcode, rings });
  }
}

const chinaOut = { provinces, jd };
fs.writeFileSync(path.join(ROOT, 'src/geo-china.js'),
  '/* ============================================================\n' +
  ' * geo-china.js — 中国省级边界（离线数据，自动生成，勿手改）\n' +
  ' * 来源：DataV.GeoAtlas 中国省级边界（自然资源部标准地图服务体系下的公开数据）\n' +
  ' * 含台湾省、香港、澳门与南海诸岛（九段线），坐标系 WGS84，坐标 [经度,纬度]。\n' +
  ' * 生成：node tools/build-geo.mjs\n' +
  ' * ============================================================ */\n' +
  '(function (global) {\n  \'use strict\';\n  global.GEO_CHINA = ' +
  JSON.stringify(chinaOut) + ';\n})(typeof window !== \'undefined\' ? window : globalThis);\n');

/* ---------- 世界国家边界（TopoJSON → 经纬度） ---------- */
const topo = JSON.parse(fs.readFileSync(path.join(RAW, 'world-110m.json'), 'utf8'));
const tr = topo.transform;
const arcs = topo.arcs.map(arc => {
  let x = 0, y = 0;
  return arc.map(p => {
    if (tr) { x += p[0]; y += p[1]; return [tr.translate[0] + x * tr.scale[0], tr.translate[1] + y * tr.scale[1]]; }
    return p;
  });
});
function arcPoints(i) {
  if (i < 0) {
    const a = arcs[~i];
    return a.slice().reverse();
  }
  return arcs[i];
}
function multiPolygons(geom) {
  // 返回 polygon 数组，每个 polygon = 孔洞环数组
  const src = geom.type === 'Polygon' ? [geom.arcs] : geom.arcs;
  return src.map(poly => poly.map(ringArcs => {
    let pts = [];
    for (const ai of ringArcs) pts = pts.concat(arcPoints(ai));
    return pts;
  }));
}

const objs = topo.objects.countries.geometries;
const countries = [];
for (const g of objs) {
  if (!g.type) continue;
  const name = (g.properties && g.properties.name) || '';
  const polys = multiPolygons(g);
  const rings = [];
  for (const poly of polys) {
    for (let ri = 0; ri < poly.length; ri++) {
      const s = simplifyRing(poly[ri], ri === 0 ? 0.08 : 0.05, ri === 0 ? 0.02 : 0.01);
      if (s) rings.push(s);
    }
  }
  if (rings.length) countries.push({ name, rings });
}

fs.writeFileSync(path.join(ROOT, 'src/geo-world.js'),
  '/* ============================================================\n' +
  ' * geo-world.js — 世界国家边界（离线数据，自动生成，勿手改）\n' +
  ' * 来源：Natural Earth 1:110m 国家边界（公有领域，world-atlas TopoJSON）\n' +
  ' * 坐标 WGS84，[经度,纬度]；仅用于示意性底图。\n' +
  ' * 生成：node tools/build-geo.mjs\n' +
  ' * ============================================================ */\n' +
  '(function (global) {\n  \'use strict\';\n  global.GEO_WORLD = ' +
  JSON.stringify({ countries }) + ';\n})(typeof window !== \'undefined\' ? window : globalThis);\n');

const b1 = fs.statSync(path.join(ROOT, 'src/geo-china.js')).size;
const b2 = fs.statSync(path.join(ROOT, 'src/geo-world.js')).size;
console.log('✔ geo-china.js ' + (b1 / 1024).toFixed(0) + ' KB（' + provinces.length + ' 个省级单元，' +
  (jd ? jd.rings.length : 0) + ' 段南海诸岛线）');
console.log('✔ geo-world.js ' + (b2 / 1024).toFixed(0) + ' KB（' + countries.length + ' 个国家/地区）');
