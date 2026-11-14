/* ============================================================
 * selftest.mjs — 零依赖自检（node tools/selftest.mjs）
 * 不启动浏览器，直接把所有「经典脚本」放进 vm 沙箱里跑：
 *   1) 共享数据 FRONT：三锋曲线数值合法、阶段边界正确、meta 字段齐全
 *   2) 真实地图数据：政区/九段线/世界国家数量与坐标范围
 *   3) 2D 模型：M2 / M3 / M4 在假 canvas 上跑全组合不抛异常（含真实底图）
 *   4) 题库：≥30 题、每题 4 选项、答案与解析齐全、抽题按类型加权
 *   5) 知识库：≥12 节、术语 ≥12、HTML 只用了允许的标签/类
 * 退出码 0 = 全过。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const errors = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; errors.push(name + (extra ? ' — ' + extra : '')); console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

/* ---------- 假 canvas 上下文（记录一切调用，不画） ---------- */
function fakeCtx(w, h) {
  const grad = { addColorStop() {} };
  const base = {
    canvas: { width: w || 1200, height: h || 700 },
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {}, drawImage() {}, setLineDash() {}, save() {}, restore() {}
  };
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'symbol') return undefined;
      return function () { return undefined; };
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

/* ---------- 沙箱 ---------- */
const sandbox = {
  console,
  devicePixelRatio: 2,
  setTimeout, clearTimeout, Date, Math, JSON, Promise, performance: { now: () => Date.now() },
  navigator: { userAgent: 'selftest' },
  location: { search: '' },
  addEventListener() {}, removeEventListener() {},
  document: {
    createElement: () => ({ getContext: () => fakeCtx(), style: {}, appendChild() {}, addEventListener() {} }),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    body: { appendChild() {}, removeChild() {} }, addEventListener() {}
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const FILES = [
  'src/front-data.js',
  'src/geo-china.js',
  'src/geo-world.js',
  'src/geo.js',
  'src/knowledge.js',
  'src/quiz.js',
  'src/helpers.js',
  'src/m2-section.js',
  'src/m3-map.js',
  'src/m4-chart.js',
  'src/live.js'
];

section('加载脚本');
for (const f of FILES) {
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
    ok(f, true);
  } catch (e) {
    ok(f, false, e.message);
  }
}

/* ---------- 1. FRONT ---------- */
section('共享数据 FRONT');
const F = sandbox.FRONT;
ok('window.FRONT 存在', !!F);
if (F) {
  ok('types = 3', F.types.length === 3, String(F.types));
  ok('L = 18', F.L === 18, String(F.L));
  ok('PHASE_EDGE = [0.38,0.62]', JSON.stringify(F.PHASE_EDGE) === '[0.38,0.62]', JSON.stringify(F.PHASE_EDGE));

  const metas = ['cold', 'warm', 'stationary'];
  let curveBad = [], metaBad = [];
  for (const t of metas) {
    const meta = F.meta[t];
    for (const k of ['name', 'glyph', 'color', 'oneLine', 'slope', 'slopeText', 'rainZone', 'rainZoneText',
      'cloudText', 'rainText', 'symbolText', 'phases', 'examples']) {
      if (meta[k] === undefined) metaBad.push(t + '.' + k);
    }
    if (!Array.isArray(meta.phases) || meta.phases.length !== 3) metaBad.push(t + '.phases 长度');
    if (!meta.examples || meta.examples.length < 1) metaBad.push(t + '.examples 为空');
    for (let i = 0; i <= 50; i++) {
      const p = i / 50;
      const c = F.curve(t, p);
      const nums = [c.temp, c.press, c.rain, c.cloud];
      if (nums.some((v) => typeof v !== 'number' || !isFinite(v))) curveBad.push(t + '@' + p + ' 数值');
      if (c.rain < -1e-6 || c.rain > 1 + 1e-6) curveBad.push(t + '@' + p + ' rain 越界 ' + c.rain);
      if (c.cloud < -1e-6 || c.cloud > 1 + 1e-6) curveBad.push(t + '@' + p + ' cloud 越界 ' + c.cloud);
      if (![0, 1, 2].includes(c.phase)) curveBad.push(t + '@' + p + ' phase 非法');
      if (!c.weather || !c.wind || !c.desc) curveBad.push(t + '@' + p + ' 文案缺失');
      const span = F.span(t, p, 'rain');
      if (!(span.x0 < span.x1)) curveBad.push(t + '@' + p + ' rain span 反序');
    }
  }
  ok('三锋 meta 字段齐全', metaBad.length === 0, metaBad.slice(0, 4).join(', '));
  ok('三锋曲线 51 点全部合法', curveBad.length === 0, curveBad.slice(0, 4).join(', '));

  ok('阶段边界：0.2→过境前 / 0.5→过境时 / 0.85→过境后',
    F.phaseName(0.2) === '过境前' && F.phaseName(0.5) === '过境时' && F.phaseName(0.85) === '过境后');
  ok('xFront：冷锋从左到右', F.xFront('cold', 0) < -10 && F.xFront('cold', 1) > 10);
  ok('xFront：暖锋从左到右', F.xFront('warm', 0) < -10 && F.xFront('warm', 1) > 10);
  ok('xFront：准静止锋原地摆动',
    Math.abs(F.xFront('stationary', 0.2) + 1.5) < 5 && Math.abs(F.xFront('stationary', 0.6) + 1.5) < 5);

  const coldPeakAt = (() => {
    let best = 0, bp = 0;
    for (let i = 0; i <= 100; i++) { const p = i / 100; const r = F.curve('cold', p).rain; if (r > best) { best = r; bp = p; } }
    return bp;
  })();
  ok('冷锋降水峰值在过境时(0.38~0.62)', coldPeakAt >= 0.35 && coldPeakAt <= 0.65, String(coldPeakAt));
}

/* ---------- 2. 地图数据 ---------- */
section('真实地图数据');
const GC = sandbox.GEO_CHINA, GW = sandbox.GEO_WORLD, GEO = sandbox.GEO;
ok('GEO_CHINA 存在', !!GC);
if (GC) {
  ok('省级单元 ≥ 33', GC.provinces.length >= 33, String(GC.provinces.length));
  const names = GC.provinces.map((p) => p.name).join(',');
  ok('含台湾/香港/澳门', /台湾/.test(names) && /香港/.test(names) && /澳门/.test(names), names.slice(0, 80));
  ok('南海诸岛 10 段界线', GC.jd && GC.jd.rings && GC.jd.rings.length === 10,
    String(GC.jd && GC.jd.rings && GC.jd.rings.length));
  let badCoord = 0;
  GC.provinces.forEach((p) => p.rings.forEach((r) => r.forEach((c) => {
    if (!(c[0] >= 73 && c[0] <= 136 && c[1] >= 3 && c[1] <= 54)) badCoord++;
  })));
  ok('坐标落在中国范围 73–136E / 3–54N', badCoord === 0, String(badCoord) + ' 个越界点');
}
ok('GEO_WORLD 存在', !!GW);
if (GW) ok('世界国家 ≥ 170', GW.countries.length >= 170, String(GW.countries.length));
ok('GEO 工具集', !!(GEO && GEO.drawChina && GEO.drawWorld && GEO.chinaProjector && GEO.regionProjector));

if (GEO) {
  try {
    const ctx = fakeCtx(1200, 700);
    const r = GEO.drawChina(ctx, 1200, 700, {});
    const pt = r && r.projector && r.projector.project(116.4, 39.9);
    ok('drawChina 可绘制且返回投影器', !!(r && r.projector && pt && isFinite(pt.x) && isFinite(pt.y)));
    if (r && r.projector) {
      const hrb = r.projector.project(126.53, 45.8);
      const bj = r.projector.project(116.41, 39.9);
      const gz = r.projector.project(113.26, 23.13);
      const hk = r.projector.project(114.17, 22.32);
      ok('中国地图北在上：哈尔滨 < 北京 < 广州（y 递增）',
        hrb.y < bj.y && bj.y < gz.y, [hrb.y, bj.y, gz.y].map((v) => v.toFixed(0)).join(' / '));
      ok('港澳台与南海方向正确：香港在广州附近、y 相近',
        Math.abs(hk.y - gz.y) < 40 && Math.abs(hk.x - gz.x) < 80);
    }
    const ctx2 = fakeCtx(1200, 700);
    const w = GEO.drawWorld(ctx2, 1200, 700, { lonMin: 100, lonMax: 140, latMin: 18, latMax: 50 });
    const beijing = w.project(116.4, 39.9), guangzhou = w.project(113.3, 23.1);
    ok('drawWorld 投影：北京在 Guangzhou 北侧且都在画布内',
      beijing.y < guangzhou.y && beijing.x > 0 && guangzhou.x > 0);
  } catch (e) {
    ok('drawChina/drawWorld 运行', false, e.message);
  }
}

/* ---------- 3. 2D 模型 ---------- */
section('2D 模型（假 canvas 全组合）');
const MODS = sandbox.MODELS || {};
ok('MODELS.M2 / M3 / M4 均已注册', !!(MODS.M2 && MODS.M3 && MODS.M4));

function runDraws(which, sizes, combos) {
  const bad = [];
  for (const [w, h] of sizes) {
    const ctx = fakeCtx(w, h);
    let model;
    try {
      model = which({ canvas: { width: w, height: h }, width: w, height: h, state: null, FRONT: F, H: sandbox.H });
    } catch (e) { bad.push(which.name + ' create: ' + e.message); continue; }
    for (const combo of combos) {
      const state = Object.assign({
        t: 0.5, show: { slope: true, air: true, clouds: true, rain: true, labels: true, grid: true }
      }, combo);
      for (const t of [0, 0.22, 0.5, 0.8, 1]) {
        state.t = t;
        try {
          const c2 = fakeCtx(w, h);
          model.draw(c2, w, h, state, F);
        } catch (e) { bad.push((combo.type || '') + '@' + t + ' ' + e.message); }
      }
    }
  }
  return bad;
}

if (MODS.M2) {
  const bad = runDraws(MODS.M2, [[1200, 700], [390, 640]], ['cold', 'warm', 'stationary'].map((t) => ({ type: t })));
  ok('M2 三锋 × 两尺寸 × 五时刻 无异常', bad.length === 0, bad.slice(0, 3).join(' | '));
}

if (MODS.M3) {
  const bad = runDraws(MODS.M3, [[1200, 700], [390, 640]],
    ['cyclone', 'rainbelt', 'symbols'].map((m) => ({ type: 'cold', mapMode: m, month: 6 })));
  ok('M3 三模式 × 两尺寸 无异常', bad.length === 0, bad.slice(0, 3).join(' | '));
  const bad2 = runDraws(MODS.M3, [[1100, 680]],
    [4, 5, 6, 7, 8, 9].map((m) => ({ type: 'cold', mapMode: 'rainbelt', month: m })));
  ok('M3 雨带 4–9 月 无异常', bad2.length === 0, bad2.slice(0, 3).join(' | '));
}

if (MODS.M4) {
  const bad = runDraws(MODS.M4, [[1200, 700], [390, 640]], ['cold', 'warm', 'stationary'].map((t) => ({ type: t })));
  ok('M4 三锋 × 两尺寸 × 五时刻 无异常', bad.length === 0, bad.slice(0, 3).join(' | '));
}

/* ---------- 4. 题库 ---------- */
section('题库');
const Q = sandbox.Quiz;
ok('window.Quiz 存在', !!Q);
if (Q) {
  ok('题目 ≥ 30', Q.bank.length >= 30, String(Q.bank.length));
  const badQ = [];
  Q.bank.forEach((q, i) => {
    if (!q.q) badQ.push(i + ' 题干');
    if (!Array.isArray(q.options) || q.options.length !== 4) badQ.push(i + ' 选项数');
    if (!(q.answer >= 0 && q.answer < 4)) badQ.push(i + ' 答案');
    if (!q.explain) badQ.push(i + ' 解析');
    if (!['cold', 'warm', 'stationary', 'general'].includes(q.type)) badQ.push(i + ' 类型');
  });
  ok('每题结构完整（4 选项 / 答案 / 解析 / 类型）', badQ.length === 0, badQ.slice(0, 4).join(', '));
  const types = new Set(Q.bank.map((q) => q.type));
  ok('覆盖冷锋/暖锋/准静止锋/综合', ['cold', 'warm', 'stationary', 'general'].every((t) => types.has(t)));

  const pick = Q.pick('cold', 10);
  ok('pick 返回 10 题', pick.length === 10, String(pick.length));
  const coldCount = pick.filter((q) => q.type === 'cold').length;
  ok('冷锋抽题中冷锋题占多数', coldCount >= 5, coldCount + '/10');
  ok('抽题不重复', new Set(pick.map((q) => q.q)).size === pick.length);
}

/* ---------- 5. 知识库 ---------- */
section('知识库');
const K = sandbox.KNOWLEDGE;
ok('window.KNOWLEDGE 存在', !!K);
if (K) {
  ok('章节 ≥ 12', K.sections.length >= 12, String(K.sections.length));
  ok('章节 id 唯一', new Set(K.sections.map((s) => s.id)).size === K.sections.length);
  ok('术语 ≥ 12', (K.glossary || []).length >= 12, String((K.glossary || []).length));
  const ALLOWED = new Set(['h4', 'p', 'ul', 'ol', 'li', 'b', 'i', 'table', 'th', 'td', 'tr', 'br', 'div', 'span']);
  const badTags = new Set();
  const allHtml = K.sections.map((s) => s.html).join('\n');
  let mm;
  const tagRe = /<\/?([a-zA-Z0-9]+)/g;
  while ((mm = tagRe.exec(allHtml)) !== null) {
    if (!ALLOWED.has(mm[1].toLowerCase())) badTags.add(mm[1]);
  }
  ok('HTML 只用允许的标签', badTags.size === 0, [...badTags].join(','));
  ok('没有内联 style 属性', !/style\s*=/.test(allHtml));
  ok('没有 script/img', !/<script|<img/i.test(allHtml));
  const cls = new Set();
  (allHtml.match(/class="([^"]+)"/g) || []).forEach((c) => cls.add(c.slice(7, -1)));
  const allowedCls = new Set(['kc-table', 'kc-note', 'kc-warn', 'kc-key', 'kc-chip']);
  const badCls = [...cls].filter((c) => !allowedCls.has(c));
  ok('类名只用约定的 kc-*', badCls.length === 0, badCls.join(','));
  ok('正文总字数 ≥ 4000', (allHtml.replace(/<[^>]+>/g, '')).length >= 4000,
    String((allHtml.replace(/<[^>]+>/g, '')).length));
}

/* ---------- 汇总 ---------- */
console.log('\n══════════════════════════════════');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('  失败项：\n   - ' + errors.join('\n   - '));
  process.exit(1);
}
console.log('  ✅ 全部通过');
