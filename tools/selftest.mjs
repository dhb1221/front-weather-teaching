/* ============================================================
 * selftest.mjs — 零依赖自检（node tools/selftest.mjs）
 * 不启动浏览器，直接把所有「经典脚本」放进 vm 沙箱里跑：
 *   1) 共享数据 FRONT：三锋曲线数值合法、阶段边界正确、meta 字段齐全
 *   2) 真实地图数据：政区/九段线/世界国家数量与坐标范围
 *   3) 2D 模型：M2 / M3 / M4 在假 canvas 上跑全组合不抛异常（含真实底图）
 *   4) 题库：≥30 题、每题 4 选项、答案与解析齐全、抽题按类型加权
 *   5) 知识库：≥12 节、术语 ≥12、HTML 只用了允许的标签/类
 *   6) 实况数据层 live.js：WMO 中文映射、风向方位、冷/暖/准静止锋判读、
 *      省名离线映射、load() 双源竞速（成功/单源降级/双源失败，全部用桩 fetch 不联网）
 *   7) 三维地球数据层 live-globe.js：8 城、批量响应按坐标配对、数值映射、
 *      8 分钟缓存、批量+单点双失败报错、buildLayer 依赖守卫
 *   8) 三维地球瓦片 m8-globe.js：window.M8_TILE 离线瓦片 drawTile 在假 canvas 上
 *      画 z0–z3 瓦片、OfflineProvider 层级与缓存（WebGL/THREE 部分不做单测）
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
  /* 默认禁止真实联网：任何漏网的 fetch 立即失败，保证自检离线可跑。
   * 需要网络行为的用例在各自小节里用桩 mockFetch() 覆盖本属性。 */
  fetch(url) { return Promise.reject(new Error('selftest 禁止真实联网：' + url)); },
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
  'src/geo-cities.js',
  'src/geo.js',
  'src/knowledge.js',
  'src/quiz.js',
  'src/helpers.js',
  'src/m2-section.js',
  'src/m4-chart.js',
  'src/m7-cyclone.js',
  'src/field.js',
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

/* 城市索引：保证查询省份准确 */
const CITIES = sandbox.GEO_CITIES;
ok('GEO_CITIES 存在', Array.isArray(CITIES) && CITIES.length >= 300, String(CITIES && CITIES.length));
if (Array.isArray(CITIES)) {
  let bad = 0;
  CITIES.forEach((c) => {
    if (!c || !c.n || !c.p || typeof c.lon !== 'number' || typeof c.lat !== 'number') bad++;
    else if (!(c.lon >= 73 && c.lon <= 136 && c.lat >= 3 && c.lat <= 54)) bad++;
  });
  ok('城市字段齐全且坐标在中国范围', bad === 0, bad + ' 条异常');
  const find = (kw) => CITIES.filter((c) => c.s === kw || c.n === kw || c.n === kw + '市');
  const ly = find('洛阳')[0], cd = find('成都')[0], gy = find('贵阳')[0], bj = find('北京')[0];
  ok('洛阳属于河南', !!ly && ly.p === '河南省', ly && ly.p);
  ok('成都属于四川', !!cd && cd.p === '四川省', cd && cd.p);
  ok('贵阳属于贵州', !!gy && gy.p === '贵州省', gy && gy.p);
  ok('直辖市北京可查', !!bj && bj.ps === '北京', bj && bj.ps);
  ok('含港澳台城市', CITIES.some((c) => c.p === '香港特别行政区') &&
    CITIES.some((c) => c.p === '澳门特别行政区') && CITIES.some((c) => c.p === '台湾省'));
  // 本地搜索必须能命中正确省份（searchCity 返回 Promise，异步校验）
  if (sandbox.LIVE) {
    const hits = await sandbox.LIVE.searchCity('洛阳');
    ok('搜索「洛阳」命中河南', hits.length > 0 && hits[0].prov === '河南',
      hits.length ? hits.map((h) => h.name + '/' + (h.prov || h.admin1)).slice(0, 3).join(' , ') : '无结果');
    const cds = await sandbox.LIVE.searchCity('成都');
    ok('搜索「成都」命中四川', cds.length > 0 && cds[0].prov === '四川',
      cds.length ? cds.map((h) => h.name + '/' + (h.prov || h.admin1)).slice(0, 3).join(' , ') : '无结果');
    const near = sandbox.LIVE.nearestCity(26.65, 106.63);
    ok('定位最近城市命中贵阳', !!near && near.name === '贵阳', near ? near.name + '/' + near.prov : 'null');
  }
}

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
ok('MODELS.M2 / M4 均已注册', !!(MODS.M2 && MODS.M4));

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

if (MODS.M4) {
  const bad = runDraws(MODS.M4, [[1200, 700], [390, 640]], ['cold', 'warm', 'stationary'].map((t) => ({ type: t })));
  ok('M4 三锋 × 两尺寸 × 五时刻 无异常', bad.length === 0, bad.slice(0, 3).join(' | '));
}

/* ---------- 3.5 锋面气旋演示（M7） ---------- */
section('锋面气旋演示 M7');
{
  const MODS = sandbox.MODELS || {};
  const ST = sandbox.CYCLONE_STAGES;
  ok('CYCLONE_STAGES 有 4 个阶段', Array.isArray(ST) && ST.length === 4, String(ST && ST.length));
  if (Array.isArray(ST)) {
    let badStage = 0;
    ST.forEach((st) => {
      if (!st || !st.title || !st.desc) badStage++;
      else if (!st.station || !st.station.A || !st.station.B || !st.station.C) badStage++;
    });
    ok('每阶段都有标题/说明/ABC 三站天气', badStage === 0, badStage + ' 个阶段缺字段');
    const b = ST[1].station.B || {};
    ok('B 站（冷锋过境）天气符合教材', /风/.test(b.wind || '') && /(雨|雷)/.test(b.rain || ''),
      (b.wind || '') + ' / ' + (b.rain || ''));
  }
  ok('window.MODELS.M7 存在', !!(MODS.M7));
  if (MODS.M7) {
    const errs = [];
    try {
      const m7 = MODS.M7({ canvas: { width: 1200, height: 700 }, width: 1200, height: 700 });
      ok('M7 返回 draw/resize/dispose', !!(m7 && m7.draw && m7.resize && m7.dispose));
      const sizes = [[1280, 720], [390, 720], [320, 900]];
      for (const [w, h] of sizes) {
        for (let stage = 0; stage <= 3; stage++) {
          for (const t of [0, 0.5, 1]) {
            try { m7.draw(fakeCtx(w, h), w, h, { t, cycStage: stage, playing: true, show: {} }); }
            catch (e) { errs.push(w + 'x' + h + ' s' + stage + ': ' + e.message); }
          }
        }
      }
    } catch (e) { errs.push('create: ' + e.message); }
    ok('M7 4 阶段 × 3 尺寸 × 3 时间点绘制无异常', errs.length === 0, errs.slice(0, 3).join(' ; '));
  }
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

/* ============================================================
 * 6. 实况数据层 live.js（全部用桩 fetch，离线可跑、不联网）
 * ============================================================ */
section('实况数据层 live.js');
const LIVE = sandbox.LIVE;

/* 桩 fetch：handler 收到 url；返回值会被包成 Promise；handler 抛错 = 请求失败 */
function mockFetch(handler) {
  sandbox.fetch = (url, opt) => Promise.resolve().then(() => handler(url, opt));
}
function jsonRes(obj) {
  return {
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify(obj)),
    json: () => Promise.resolve(obj)
  };
}

ok('window.LIVE API 完整（PRESETS/REFRESH_MS/weatherText/searchCity/load/judge 等）',
  !!(LIVE && LIVE.PRESETS && LIVE.WEATHER_CODES && LIVE.weatherText && LIVE.searchCity &&
    LIVE.nearestCity && LIVE.load && LIVE.judge && LIVE.demoType && LIVE.degToDir));
if (LIVE) {
  ok('REFRESH_MS = 300000（5 分钟自动刷新）且 TIMEOUT = 8000',
    LIVE.REFRESH_MS === 300000 && LIVE.TIMEOUT === 8000,
    LIVE.REFRESH_MS + ' / ' + LIVE.TIMEOUT);
  ok('WMO 天气码 → 中文（晴 / 阴 / 雾凇 / 阵雨 / 雷暴）',
    LIVE.weatherText(0) === '晴' && LIVE.weatherText(3) === '阴' &&
    LIVE.weatherText(48) === '雾凇（冻雾）' && LIVE.weatherText(81) === '阵雨' &&
    LIVE.weatherText(95) === '雷暴');
  ok('风向角度 → 8 方位中文（北/东北/东/南/西）',
    LIVE.degToDir(0) === '北' && LIVE.degToDir(45) === '东北' && LIVE.degToDir(90) === '东' &&
    LIVE.degToDir(180) === '南' && LIVE.degToDir(270) === '西');

  /* ---- 锋面判读：构造数据覆盖冷锋/暖锋/准静止锋/静稳/缺数据/数值模式 ---- */
  function judgeData(dT, dP, extra) {
    extra = extra || {};
    return {
      current: Object.assign({
        windDir: '北', windDeg: 0, windSpeed: 10, press: 1015, cloud: 40, precip: 0
      }, extra.current || {}),
      metrics: Object.assign({
        dT: dT, dP: dP, hours: 8,
        text: '今日已过约 8 小时（非 24h 实测）', forecastBased: false
      }, extra.metrics || {}),
      hourly: extra.hourly || []
    };
  }
  const rainy = [{ precip: 0.6 }, { precip: 1.2 }, { precip: 0.4 }, { precip: 0 }];
  const coldJ = LIVE.judge(judgeData(-6, 5, { current: { press: 1020, cloud: 85, precip: 3.2 } }));
  ok('judge 冷锋：ΔT ≤ −4℃ 且 ΔP ≥ +3hPa → cold',
    coldJ.type === 'cold' && /冷锋/.test(coldJ.title) && LIVE.demoType(coldJ) === 'cold',
    coldJ.type + ' / ' + coldJ.title);
  const warmJ = LIVE.judge(judgeData(5, -5, { hourly: rainy }));
  ok('judge 暖锋：ΔT ≥ +3℃ 且 ΔP ≤ −3hPa → warm',
    warmJ.type === 'warm' && /暖锋/.test(warmJ.title), warmJ.type + ' / ' + warmJ.title);
  const stJ = LIVE.judge(judgeData(0.6, 0.8, { hourly: rainy }));
  ok('judge 准静止锋：ΔT/ΔP 小且降水时段多 → stationary',
    stJ.type === 'stationary' && stJ.confidence === 'medium', stJ.type + ' / ' + stJ.confidence);
  const calmJ = LIVE.judge(judgeData(0.6, 0.8, { hourly: [] }));
  ok('judge 静稳：ΔT/ΔP 小且无降水 → none（天气平稳）',
    calmJ.type === 'none' && /平稳/.test(calmJ.title), calmJ.type + ' / ' + calmJ.title);
  const noTrend = LIVE.judge({ current: {}, metrics: { dT: null, dP: null } });
  ok('judge 缺少 ΔT/ΔP 时给出「无法判定」说明（不硬判）',
    noTrend.type === 'none' && /无法判定/.test(noTrend.reasons.join('')), noTrend.type);
  const fcJ = LIVE.judge(judgeData(-6, 5, { metrics: { forecastBased: true } }));
  ok('judge 数值模式数据自动降置信度并注明来源性质',
    fcJ.type === 'cold' && fcJ.confidence === 'low' && /数值模式/.test(fcJ.reasons.join('')),
    fcJ.confidence);

  /* ---- 搜索：省名 → 省会（纯本地 GEO_CITIES，不联网） ---- */
  const provHits = await LIVE.searchCity('浙江');
  ok('搜索省名「浙江」→ 省会杭州（离线省名映射）',
    provHits.length === 1 && provHits[0].name === '杭州' && provHits[0].prov === '浙江' &&
    provHits[0].viaProvince === '浙江' && provHits[0].local === true,
    JSON.stringify(provHits.slice(0, 1)));
  const provHits2 = await LIVE.searchCity('广西壮族自治区');
  ok('搜索自治区全称「广西壮族自治区」→ 首府南宁（离线）',
    provHits2.length === 1 && provHits2[0].name === '南宁' && provHits2[0].prov === '广西',
    JSON.stringify(provHits2.slice(0, 1)));

  /* ---- load()：双源竞速（成功 / 单源降级 / 双源失败），全部走桩 fetch ---- */
  mockFetch(() => { throw new Error('模拟断网'); });
  let netErr = null;
  try { await LIVE.load({ name: '贵阳', lon: 106.63, lat: 26.65 }); } catch (e) { netErr = e; }
  ok('load() 双源都失败 → reject 明确错误（含两源名，不伪造数据）',
    !!netErr && /实时天气获取失败/.test(netErr.message) &&
    /Open-Meteo/.test(netErr.message) && /MET Norway/.test(netErr.message) &&
    /模拟断网/.test(netErr.message), netErr && netErr.message);

  const missErr = await LIVE.load({ name: '某地' }).then(() => null, (e) => e);
  ok('load() 缺经纬度 → 直接 reject（不发请求）',
    !!missErr && /经纬度缺失/.test(missErr.message), missErr && missErr.message);

  const openFixture = {
    latitude: 26.65, longitude: 106.63, elevation: 1100,
    current: {
      time: '2026-11-21T08:00', interval: 900,
      temperature_2m: 21.5, relative_humidity_2m: 66, apparent_temperature: 21.9,
      surface_pressure: 884.1, pressure_msl: 1013.2,
      wind_speed_10m: 12.3, wind_direction_10m: 225, wind_gusts_10m: 20,
      precipitation: 0, rain: 0, showers: 0, snowfall: 0, weather_code: 0,
      cloud_cover: 12, visibility: 20000, dew_point_2m: 14.5
    },
    daily: {
      time: ['2026-11-21'],
      temperature_2m_max: [24.1], temperature_2m_min: [12.0],
      uv_index_max: [4.2], precipitation_sum: [0]
    },
    hourly: {
      time: ['2026-11-21T00:00', '2026-11-21T04:00', '2026-11-21T08:00'],
      temperature_2m: [18.0, 19.2, 21.5],
      surface_pressure: [886.0, 885.0, 884.1],
      pressure_msl: [1018.0, 1016.0, 1013.2],
      precipitation: [0, 0, 0],
      cloud_cover: [5, 8, 12],
      weather_code: [0, 0, 0],
      wind_speed_10m: [5, 8, 12.3],
      uv_index: [0, 0.4, 1.2]
    }
  };
  mockFetch((url) => {
    if (/met\.no/.test(url)) throw new Error('MET Norway 模拟不可用');
    if (/api\.open-meteo\.com\/v1\/forecast/.test(url)) return jsonRes(openFixture);
    throw new Error('未预期的 URL: ' + url);
  });
  let openData = null, openLoadErr = null;
  try {
    openData = await LIVE.load({ name: '贵阳', prov: '贵州', provFull: '贵州省', lon: 106.63, lat: 26.65, elevation: 1100 });
  } catch (e) { openLoadErr = e; }
  ok('load() Open-Meteo 成功：来源/温度/气压/天气/风向/判读齐备',
    !!openData && openData.source === 'Open-Meteo 数值模式' &&
    openData.current.temp === 21.5 && openData.current.press === 1013.2 &&
    openData.current.desc === '晴' && openData.current.visibility === 20 &&
    openData.current.windDir === '西南' && openData.place.name === '贵阳' &&
    !!openData.judge && openData.judge.type === 'warm',
    openLoadErr ? openLoadErr.message : (openData && JSON.stringify({
      temp: openData.current.temp, press: openData.current.press,
      vis: openData.current.visibility, judge: openData.judge.type
    })));
  ok('load() Open-Meteo 趋势：今日已过 8h、ΔT +3.5℃、ΔP −4.8hPa、标注数值模式',
    !!openData && openData.metrics.dT === 3.5 && openData.metrics.dP === -4.8 &&
    openData.metrics.hours === 8 && /今日已过约 8 小时/.test(openData.metrics.text) &&
    openData.metrics.forecastBased === true &&
    /数值模式/.test(openData.warnings.join('')));
  ok('load() 成功结果带 judge（与 judge() 判据一致：暖锋）',
    !!openData && LIVE.demoType(openData.judge) === 'warm');

  const metFixture = (() => {
    const base = Date.now() + 20 * 60000;
    const iso = (min) => new Date(base + min * 60000).toISOString();
    const det = (temp, press) => ({
      instant: {
        details: {
          air_temperature: temp, air_pressure_at_sea_level: press,
          relative_humidity: 60, wind_speed: 5, wind_from_direction: 270,
          cloud_area_fraction: 90
        }
      },
      next_1_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: 1.2 } }
    });
    return {
      properties: {
        meta: { updated_at: iso(0) },
        timeseries: [
          { time: iso(0), data: det(10, 1005.5) },
          { time: iso(60), data: det(11, 1004) },
          { time: iso(360), data: det(12, 1003) },
          { time: iso(600), data: det(13, 1002) }
        ]
      },
      geometry: { coordinates: [106.63, 26.65, 1100] }
    };
  })();
  mockFetch((url) => {
    if (/api\.open-meteo\.com\/v1\/forecast/.test(url)) throw new Error('Open-Meteo 模拟不可用');
    if (/met\.no/.test(url)) return jsonRes(metFixture);
    throw new Error('未预期的 URL: ' + url);
  });
  let metData = null, metLoadErr = null;
  try { metData = await LIVE.load({ name: '贵阳', lon: 106.63, lat: 26.65 }); } catch (e) { metLoadErr = e; }
  ok('load() Open-Meteo 失败时由 MET Norway 备源接管并标注降级',
    !!metData && metData.source === 'MET Norway' &&
    metData.current.temp === 10 && metData.current.press === 1005.5 &&
    metData.current.windSpeed === 18 && metData.current.windDir === '西' &&
    metData.current.desc === '雨' && metData.metrics.forecastBased === true &&
    /降级/.test(metData.warnings.join('')) &&
    !!metData.judge && metData.judge.type === 'warm',
    metLoadErr ? metLoadErr.message : (metData && JSON.stringify({
      source: metData.source, temp: metData.current.temp,
      wind: metData.current.windSpeed, judge: metData.judge.type
    })));
}

/* ============================================================
 * 7. 三维地球数据层 live-globe.js（桩 fetch，不联网）
 * ============================================================ */
section('三维地球数据层 live-globe.js');
try {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/live-globe.js'), 'utf8'), sandbox,
    { filename: 'src/live-globe.js' });
  ok('加载 src/live-globe.js', true);
} catch (e) {
  ok('加载 src/live-globe.js', false, e.message);
}
const GL = sandbox.GLOBE_LIVE;
ok('window.GLOBE_LIVE API 完整（CITIES/fetchAll/buildLayer/descOf/clearCache）',
  !!(GL && Array.isArray(GL.CITIES) && GL.fetchAll && GL.buildLayer && GL.descOf && GL.clearCache));

if (GL && Array.isArray(GL.CITIES)) {
  const cityNames = GL.CITIES.map((c) => c.name);
  ok('CITIES = 8 个全球城市且名称唯一（含北京/伦敦/纽约）',
    GL.CITIES.length === 8 && new Set(cityNames).size === 8 &&
    cityNames.includes('北京') && cityNames.includes('伦敦') && cityNames.includes('纽约'),
    cityNames.join('/'));
  const badCity = GL.CITIES.filter((c) => !c || !c.name || typeof c.lat !== 'number' ||
    typeof c.lon !== 'number' || !(c.lat >= -90 && c.lat <= 90) || !(c.lon >= -180 && c.lon <= 180));
  const west = GL.CITIES.some((c) => c.lon < 0);
  ok('CITIES 经纬度合法且覆盖东/西经（伦敦/纽约在西经）', badCity.length === 0 && west &&
    GL.CITIES.find((c) => c.name === '纽约').lon < -70,
    badCity.length + ' 条异常 / west=' + west);
  ok('descOf：WMO 码 → 中文（0 晴 / 95 雷暴），未知码兜底、空值给 —',
    GL.descOf(0) === '晴' && GL.descOf(95) === '雷暴' &&
    GL.descOf(null) === '—' && /其它天气/.test(GL.descOf(1234)),
    GL.descOf(1234));

  /* ---- 批量响应：故意乱序 + 坐标网格吸附偏移，验证按坐标就近配对 ---- */
  function globeBatchFixture() {
    const temps = [10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5, 17.5];
    const codes = [0, 1, 2, 3, 45, 61, 71, 95];
    const rows = [];
    GL.CITIES.forEach((c, i) => {
      rows.push({
        latitude: c.lat + 0.03, longitude: c.lon + 0.03, elevation: 10,
        current: {
          time: '2026-11-21T08:00',
          temperature_2m: temps[i], weather_code: codes[i],
          wind_speed_10m: 5 + i, wind_direction_10m: i * 45,
          surface_pressure: 1010 + i
        }
      });
    });
    return rows.reverse();   /* 响应顺序与 CITIES 相反 */
  }
  GL.clearCache();
  let batchCalls = 0;
  mockFetch((url) => {
    if (!/api\.open-meteo\.com\/v1\/forecast/.test(url)) throw new Error('未预期 URL: ' + url);
    batchCalls++;
    if (!/latitude=39\.9,31\.23/.test(url)) throw new Error('批量 URL 未按城市顺序拼接坐标: ' + url);
    if (!/timezone=UTC/.test(url) || !/wind_speed_unit=kmh/.test(url)) {
      throw new Error('批量 URL 缺少 timezone/wind_speed_unit: ' + url);
    }
    return jsonRes(globeBatchFixture());
  });
  let batchData = null, batchErr = null;
  try { batchData = await GL.fetchAll(true); } catch (e) { batchErr = e; }
  ok('fetchAll 批量请求：返回 source=Open-Meteo 的 8 城数据',
    !!batchData && batchData.source === 'Open-Meteo' && batchData.items.length === 8,
    batchErr ? batchErr.message : (batchData && batchData.items.length));
  ok('fetchAll 按坐标就近配对城市（乱序响应不串城）',
    !!batchData && batchData.items[0].name === '北京' && batchData.items[3].name === '东京' &&
    batchData.items[7].name === '纽约',
    batchData ? batchData.items.map((it) => it.name).join('/') : '');
  ok('fetchAll 数值映射：温度/风/风向/气压/天气/时间（含 UTC 补 Z）',
    !!batchData &&
    batchData.items[0].temp === 10.5 && batchData.items[0].wind === 5 &&
    batchData.items[0].windDeg === 0 && batchData.items[0].press === 1010 &&
    batchData.items[0].desc === '晴' && batchData.items[0].time === '2026-11-21T08:00Z' &&
    batchData.items[7].temp === 17.5 && batchData.items[7].press === 1017 &&
    batchData.items[7].desc === '雷暴',
    batchData ? JSON.stringify({ t0: batchData.items[0].temp, t7: batchData.items[7].temp,
      time0: batchData.items[0].time, desc7: batchData.items[7].desc }) : '');

  const callsAfterFirst = batchCalls;
  const cachedData = await GL.fetchAll();
  ok('fetchAll 8 分钟内存缓存：5 分钟内不重复请求',
    cachedData === batchData && batchCalls === callsAfterFirst, 'calls=' + batchCalls);
  await GL.fetchAll(true);
  ok('fetchAll(true) 强制刷新会跳过缓存重新请求',
    batchCalls === callsAfterFirst + 1, 'calls=' + batchCalls);

  GL.clearCache();
  mockFetch(() => { throw new Error('模拟断网'); });
  const gErr = await GL.fetchAll(true).then(() => null, (e) => e);
  ok('fetchAll 批量与 8 个单点都失败 → reject 说明两条链路（不伪造数据）',
    !!gErr && /批量请求/.test(gErr.message) && /单点请求/.test(gErr.message) &&
    /模拟断网/.test(gErr.message), gErr && gErr.message);

  let layerErr = null;
  try { GL.buildLayer({}); } catch (e) { layerErr = e; }
  ok('buildLayer 缺 THREE 时抛明确错误（依赖守卫，不静默失败）',
    !!layerErr && /缺少 THREE/.test(layerErr.message), layerErr && layerErr.message);
  let layerErr2 = null;
  try { GL.buildLayer({ THREE: {}, group: { add() {} } }); } catch (e) { layerErr2 = e; }
  ok('buildLayer 缺 toVec 时抛明确错误（依赖守卫）',
    !!layerErr2 && /toVec/.test(layerErr2.message), layerErr2 && layerErr2.message);
}

/* ============================================================
 * 8. 三维地球瓦片 m8-globe.js（只测不依赖 THREE/WebGL 的离线瓦片部分）
 * ============================================================ */
section('三维地球瓦片 m8-globe.js');
/* 注入最小 Geo 桩：m8-globe 在加载时执行 class OfflineProvider extends Geo.MapProvider，
 * 但不初始化 THREE/WebGL；瓦片绘制只用 document.createElement('canvas') + 地理数据。 */
sandbox.Geo = { MapProvider: function MapProvider() {} };
try {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/m8-globe.js'), 'utf8'), sandbox,
    { filename: 'src/m8-globe.js' });
  ok('加载 src/m8-globe.js（Geo 桩，无需 THREE/WebGL）', true);
} catch (e) {
  ok('加载 src/m8-globe.js（Geo 桩，无需 THREE/WebGL）', false, e.message);
}
const M8T = sandbox.M8_TILE;
ok('window.M8_TILE = {drawTile, offlineProvider}',
  !!(M8T && typeof M8T.drawTile === 'function' && typeof M8T.offlineProvider === 'function'));

if (M8T && typeof M8T.drawTile === 'function') {
  /* 覆盖全球的瓦片坐标：z0 一张全球 + z2 全 16 张 + z3 西北/东南角 */
  const tileCoords = [[0, 0, 0]];
  for (let gx = 0; gx < 4; gx++) for (let gy = 0; gy < 4; gy++) tileCoords.push([2, gx, gy]);
  tileCoords.push([3, 0, 0], [3, 7, 7]);
  const badTiles = [];
  for (const [z, x, y] of tileCoords) {
    try {
      const cv = M8T.drawTile(z, x, y);
      if (!cv || cv.width !== 256 || cv.height !== 256) badTiles.push(z + '/' + x + '/' + y + ' 尺寸异常');
    } catch (e) { badTiles.push(z + '/' + x + '/' + y + ' ' + e.message); }
  }
  ok('drawTile：z0 全球 + z2 全部 16 张 + z3 角瓦片共 ' + tileCoords.length + ' 张，256×256 且不抛异常',
    badTiles.length === 0, badTiles.slice(0, 3).join(' | '));

  const provider = new M8T.offlineProvider();
  ok('offlineProvider：name=offline-natural-earth、LOD 层级 0–3、继承 Geo.MapProvider',
    provider.name === 'offline-natural-earth' && provider.minZoom === 0 && provider.maxZoom === 3 &&
    typeof provider.fetchTile === 'function' && provider instanceof sandbox.Geo.MapProvider);
  const tileA = await provider.fetchTile(0, 0, 0);
  const tileB = await provider.fetchTile(0, 0, 0);
  ok('offlineProvider.fetchTile 异步返回 256px 瓦片且命中缓存',
    !!tileA && tileA.width === 256 && tileA.height === 256 && tileA === tileB);
}
ok('M8 WebGL 场景未做单测（沙箱无 THREE，MODELS.M8 未注册），仅覆盖离线瓦片绘制',
  typeof (sandbox.MODELS || {}).M8 === 'undefined');

/* ---------- 实时模式场（field.js）：只测导出与纯函数形状，真实取数见 tools/field-test.mjs ---------- */
section('实时模式场 field.js');
const FIELD = sandbox.FIELD;
ok('window.FIELD = {REGIONS, get, derive, clearCache}',
  !!(FIELD && FIELD.REGIONS && typeof FIELD.get === 'function' &&
    typeof FIELD.derive === 'function' && typeof FIELD.clearCache === 'function'));
ok('REGIONS 含 eastAsia / north / global 且步长合法',
  !!(FIELD && FIELD.REGIONS.eastAsia && FIELD.REGIONS.north && FIELD.REGIONS.global &&
    FIELD.REGIONS.eastAsia.step > 0 && FIELD.REGIONS.north.step > 0 &&
    FIELD.REGIONS.global.step === 15 && FIELD.REGIONS.global.latMin === -75 && FIELD.REGIONS.global.latMax === 75 &&
    FIELD.REGIONS.global.lonMin === -180 && FIELD.REGIONS.global.lonMax === 165));
ok('全球网格点数 = 11×24 = 264（省额度：15° 步长）',
  FIELD && FIELD.REGIONS.global &&
  ((FIELD.REGIONS.global.latMax - FIELD.REGIONS.global.latMin) / FIELD.REGIONS.global.step + 1) === 11 &&
  ((FIELD.REGIONS.global.lonMax - FIELD.REGIONS.global.lonMin) / FIELD.REGIONS.global.step + 1) === 24);

if (FIELD && typeof FIELD.derive === 'function') {
  /* 合成网格：经向温差 + 中间气压槽，elev 全 0（不触发海拔屏蔽） */
  const lats = [], lons = [];
  for (let la = 20; la <= 40; la += 2) lats.push(la);
  for (let lo = 100; lo <= 130; lo += 2) lons.push(lo);
  const mk = () => lats.map(() => lons.map(() => null));
  const temp = mk(), press = mk(), precip = mk(), u = mk(), v = mk(), elev = mk();
  for (let i = 0; i < lats.length; i++) {
    for (let j = 0; j < lons.length; j++) {
      temp[i][j] = 20 - (lats[i] - 20) * 1.2;
      press[i][j] = 1016 - Math.abs(lons[j] - 115) * 0.6;
      precip[i][j] = 0; u[i][j] = 10; v[i][j] = -5; elev[i][j] = 50;
    }
  }
  let d = null, err = '';
  try { d = FIELD.derive({ lats, lons, step: 2, temp, press, precip, u, v, elev }); }
  catch (e) { err = e.message; }
  ok('derive() 合成场不抛异常且返回 {lows, fronts, isobars, levels}',
    !!d && Array.isArray(d.lows) && Array.isArray(d.fronts) &&
    Array.isArray(d.isobars) && Array.isArray(d.levels), err);
  const allPts = [];
  if (d) {
    for (const f of d.fronts) for (const p of f.pts) allPts.push(p);
    for (const is of d.isobars) for (const p of is.pts) allPts.push(p);
    for (const lo of d.lows) allPts.push([lo.lat, lo.lon]);
  }
  ok('derive() 输出坐标全部有限且落在网格范围内（' + allPts.length + ' 个点）',
    allPts.length > 0 && allPts.every(([la, lo]) =>
      isFinite(la) && isFinite(lo) && la >= 19 && la <= 41 && lo >= 99 && lo <= 131));
}

/* 15° 全球网格（⑦ 三维地球实际使用的规格）：等压线能生成且坐标合法 */
if (FIELD && typeof FIELD.derive === 'function' && FIELD.REGIONS.global) {
  const G = FIELD.REGIONS.global;
  const lats = [], lons = [];
  for (let la = G.latMin; la <= G.latMax; la += G.step) lats.push(la);
  for (let lo = G.lonMin; lo <= G.lonMax; lo += G.step) lons.push(lo);
  const mk = () => lats.map(() => lons.map(() => null));
  const temp = mk(), press = mk(), precip = mk(), u = mk(), v = mk(), elev = mk();
  for (let i = 0; i < lats.length; i++) {
    for (let j = 0; j < lons.length; j++) {
      temp[i][j] = 28 - Math.abs(lats[i]) * 0.45;
      press[i][j] = 1014 + Math.cos(lats[i] * Math.PI / 180) * 8 - Math.sin(lons[j] * Math.PI / 90) * 12;
      precip[i][j] = 0; u[i][j] = 6; v[i][j] = -3; elev[i][j] = 0;
    }
  }
  let dg = null, gerr = '';
  try { dg = FIELD.derive({ lats, lons, step: G.step, temp, press, precip, u, v, elev }); }
  catch (e) { gerr = e.message; }
  const gPts = [];
  if (dg) for (const is of dg.isobars) for (const p of is.pts) gPts.push(p);
  ok('15° 全球网格：等压线非空（' + (dg ? dg.isobars.length : 0) + ' 条 / ' + gPts.length + ' 点）',
    !!dg && dg.isobars.length > 0 && gPts.length > 0 && dg.levels.length > 0, gerr);
  ok('15° 全球网格：等压线坐标有限且在经纬度范围内',
    gPts.length > 0 && gPts.every(([la, lo]) =>
      isFinite(la) && isFinite(lo) && la >= -75.01 && la <= 75.01 && lo >= -180.01 && lo <= 165.01));
}

/* 页面接线：三维地球等压线开关 + field.js 脚本 + 已删除天气图 */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('index.html 引入 src/field.js', /<script src="src\/field\.js"><\/script>/.test(html));
  ok('index.html 含等压线开关（data-gtoggle="isobars"）', /data-gtoggle="isobars"/.test(html));
  ok('index.html 不再包含天气图（③）与旧的实时天气图芯片',
    !/data-map=/.test(html) && !/data-model="M3"/.test(html) && !html.includes('m3-map.js'));
  ok('index.html 未混用 °C（统一 ℃）', !/°C/.test(html));
}

/* ---------- 汇总 ---------- */
console.log('\n══════════════════════════════════');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('  失败项：\n   - ' + errors.join('\n   - '));
  process.exit(1);
}
console.log('  ✅ 全部通过');
