/* ============================================================
 * field-test.mjs — src/field.js 的独立测试（node 直接运行，无依赖）
 *
 * 运行：& 'C:\Users\lenovo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' tools\field-test.mjs
 *
 * 覆盖：
 *   1) 合成场（温度经向线性下降 + 气压槽）→ 至少 1 条锋面、分类合理、等压线非空；
 *   2) 合成场带 995 hPa 局部低点 → lows 含它；
 *   3) 缺测 null / 异常输入不崩，输出坐标有限且在区域范围内；
 *   4) global.fetch 桩：>80 点分多请求、响应顺序配对、成功文案、10 分钟缓存、
 *      10 分钟后刷新、并发 loading；
 *   5) 500 失败 → state='error'、文案前缀正确、30 秒内不重试、之后重试；
 *   6) 未知区域 / 无 fetch / fetch 同步抛异常 → get() 永不抛异常。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'field.js'), 'utf8');

let pass = 0;
const fails = [];

function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fails.push(msg);
  console.error('  ✗ ' + msg);
  return false;
}
function eq(actual, expect, msg) {
  return ok(actual === expect, msg + '（期望 ' + JSON.stringify(expect) + '，实际 ' + JSON.stringify(actual) + '）');
}
function near(actual, expect, eps, msg) {
  return ok(typeof actual === 'number' && isFinite(actual) && Math.abs(actual - expect) <= eps,
    msg + '（期望 ≈' + expect + '，实际 ' + actual + '）');
}
function section(t) { console.log('\n[' + t + ']'); }
function isArr(a) { return Array.isArray(a); }

/* 每个实例独立的 window：field.js 以 IIFE 挂 window.FIELD，便于隔离缓存/退避状态 */
function loadField(win) {
  const w = win || {};
  new Function('window', 'globalThis', SRC)(w, w);
  if (!w.FIELD) throw new Error('field.js 未挂载 window.FIELD');
  return w.FIELD;
}

/* ---------------- 合成网格工具 ---------------- */
function axis(min, max, step) {
  const out = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
function makeGrid(opt) {
  const lats = axis(opt.latMin, opt.latMax, opt.step);
  const lons = axis(opt.lonMin, opt.lonMax, opt.step);
  const grid = { lats, lons, step: opt.step, temp: [], press: [], precip: [], u: [], v: [] };
  for (let i = 0; i < lats.length; i++) {
    const rt = [], rp = [], rr = [], ru = [], rv = [];
    for (let j = 0; j < lons.length; j++) {
      const la = lats[i], lo = lons[j];
      rt.push(opt.temp(la, lo, i, j));
      rp.push(opt.press(la, lo, i, j));
      rr.push(opt.precip ? opt.precip(la, lo, i, j) : 0);
      ru.push(opt.u ? opt.u(la, lo, i, j) : null);
      rv.push(opt.v ? opt.v(la, lo, i, j) : null);
    }
    grid.temp.push(rt); grid.press.push(rp); grid.precip.push(rr);
    grid.u.push(ru); grid.v.push(rv);
  }
  return grid;
}
function cloneGrid(g) { return JSON.parse(JSON.stringify(g)); }

/* 所有输出坐标：有限、在网格（=region）范围内、hpa 是 4 的倍数 */
function checkDerived(derived, grid, tag) {
  const latLo = Math.min.apply(null, grid.lats), latHi = Math.max.apply(null, grid.lats);
  const lonLo = Math.min.apply(null, grid.lons), lonHi = Math.max.apply(null, grid.lons);
  let bad = 0, badLon = 0, badHpa = 0;
  const chk = (la, lo) => {
    if (!isFinite(la) || !isFinite(lo)) { bad++; return; }
    if (la < latLo - 1e-6 || la > latHi + 1e-6) bad++;
    if (lo < lonLo - 1e-6 || lo > lonHi + 1e-6) badLon++;
  };
  derived.fronts.forEach(f => {
    /* 新判据允许稀疏锋面 2 点成线（见契约修订：FRONT_MIN_CELLS=3、bins 下限 2） */
    ok(isArr(f.pts) && f.pts.length >= 2, tag + '：锋面折线 ≥2 点');
    ok(['cold', 'warm', 'stationary'].indexOf(f.kind) >= 0, tag + '：锋面类型合法（' + f.kind + '）');
    f.pts.forEach(p => chk(p[0], p[1]));
  });
  derived.isobars.forEach(l => {
    l.pts.forEach(p => chk(p[0], p[1]));
    if (l.hpa % 4 !== 0) badHpa++;
  });
  derived.lows.forEach(l => {
    chk(l.lat, l.lon);
    ok(isFinite(l.press), tag + '：低压中心 press 有限');
  });
  ok(bad === 0, tag + '：所有输出坐标有限且在区域纬度范围内（越界 ' + bad + '）');
  ok(badLon === 0, tag + '：所有输出坐标在区域经度范围内（越界 ' + badLon + '）');
  ok(badHpa === 0, tag + '：等压线 hpa 都是 4 的倍数');
  (derived.levels || []).forEach(v => ok(v % 4 === 0, tag + '：等压层级 ' + v + ' 是 4 的倍数'));
}

/* 轮询 get() 直到满足条件（不会触发额外请求：缓存/退避都生效） */
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('等待超时：' + what);
}

/* ---------------- 桩 fetch ---------------- */
/* 成功桩：每个点返回 temperature=lat、pressure=1000+lon/10、海拔=3000(高纬)/100(低纬)；
   同时记录请求并发数与时间戳，用于验证“分块顺序发送（块间隔 ~150ms）”。 */
function makeStub(state) {
  state.count = 0;
  state.urls = [];
  state.active = 0;
  state.maxActive = 0;
  state.times = [];
  function respond(body) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active--;
    };
    return {
      ok: true, status: 200,
      json: () => { release(); return Promise.resolve(JSON.parse(body)); },
      text: () => { release(); return Promise.resolve(body); }
    };
  }
  return (url) => {
    state.count++;
    state.urls.push(url);
    state.times.push(Date.now());
    state.active++;
    if (state.active > state.maxActive) state.maxActive = state.active;
    const u = new URL(url);
    const lats = (u.searchParams.get('latitude') || '').split(',').filter(Boolean);
    const lons = (u.searchParams.get('longitude') || '').split(',').filter(Boolean);
    const arr = lats.map((s, k) => {
      const lat = parseFloat(s), lon = parseFloat(lons[k]);
      return {
        latitude: lat, longitude: lon,
        elevation: lat >= 45 ? 3000 : 100,
        current: {
          time: '2026-11-21T09:00',
          temperature_2m: lat,
          pressure_msl: 1000 + lon / 10,
          precipitation: 0,
          wind_speed_10m: 36,
          wind_direction_10m: 90
        }
      };
    });
    return Promise.resolve(respond(JSON.stringify(arr)));
  };
}
/* 错误桩：status 可指定（500 / 429 …） */
function makeErrorStub(state, status) {
  state.count = 0;
  state.urls = [];
  return (url) => {
    state.count++;
    state.urls.push(url);
    return Promise.resolve({ ok: false, status: status || 500, text: () => Promise.resolve('server error') });
  };
}
function makeFailStub(state) { return makeErrorStub(state, 500); }

/* 网格最近格点的海拔（统一步长网格；用于检查“假锋是否落在高海拔格点附近”） */
function nearestElev(grid, lat, lon) {
  if (!grid || !grid.elev) return null;
  const lats = grid.lats, lons = grid.lons;
  const si = (lats[lats.length - 1] - lats[0]) / (lats.length - 1);
  const sj = (lons[lons.length - 1] - lons[0]) / (lons.length - 1);
  const i = Math.max(0, Math.min(lats.length - 1, Math.round((lat - lats[0]) / si)));
  const j = Math.max(0, Math.min(lons.length - 1, Math.round((lon - lons[0]) / sj)));
  const row = grid.elev[i];
  return row ? row[j] : null;
}

/* ============================================================
 * 1. 合成场：温度经向线性下降 + 气压槽 → 锋面 / 等压线
 * ============================================================ */
section('1. derive：温度经向梯度 + 气压槽');
const FA = loadField();
const gA = makeGrid({
  latMin: 20, latMax: 50, lonMin: 100, lonMax: 136, step: 3,
  /* 气温向北每度降 1.2℃（≈1.08 ℃/100km，够强） */
  temp: (lat) => 30 - 1.2 * (lat - 20),
  /* 东西向气压槽，槽线在 38°N：两侧气压都比槽中心高 */
  press: (lat) => {
    const d = (lat - 38) / 6;
    return 1015 - 9 * Math.exp(-d * d);
  },
  precip: () => 0,
  u: () => 0,
  v: () => -20          /* 北风（风矢指向南）：沿梯度（指向暖侧=南）投影 +20 → 冷平流 */
});
const dA = FA.derive(gA);
ok(dA.fronts.length >= 1, '至少 1 条锋面（实际 ' + dA.fronts.length + '）');
if (dA.fronts.length) {
  eq(dA.fronts[0].kind, 'cold', '北风 + 气温向北降低 → cold（冷平流）');
  ok(dA.fronts[0].pts.length >= 3, '锋面折线 ≥3 点（实际 ' + dA.fronts[0].pts.length + '）');
}
ok(dA.isobars.length > 0, '等压线非空（实际 ' + dA.isobars.length + ' 条折线）');
ok(dA.levels.length >= 1 && dA.levels.length <= 12, '等压层级数 1..12（实际 ' + dA.levels.length + '）');
eq(dA.highs.length, 0, 'Derived.highs 是空数组');
checkDerived(dA, gA, '合成场 A');
console.log('  · 锋面 ' + dA.fronts.length + ' 条（kind=' +
  (dA.fronts[0] ? dA.fronts[0].kind : '-') + '，' +
  (dA.fronts[0] ? dA.fronts[0].pts.length : 0) + ' 点），等压线 ' +
  dA.isobars.length + ' 条，层 ' + JSON.stringify(dA.levels));

/* 逆向风：南风 → 暖平流 */
const gAw = cloneGrid(gA);
for (let i = 0; i < gAw.v.length; i++) for (let j = 0; j < gAw.v[i].length; j++) gAw.v[i][j] = 20;
const dAw = FA.derive(gAw);
ok(dAw.fronts.length >= 1, '南风场仍有锋面（实际 ' + dAw.fronts.length + '）');
if (dAw.fronts.length) eq(dAw.fronts[0].kind, 'warm', '南风 + 气温向北降低 → warm（暖平流）');

/* 无风数据（u/v 全 null）→ 准静止，不崩 */
const gAs = cloneGrid(gA);
for (let i = 0; i < gAs.u.length; i++) {
  for (let j = 0; j < gAs.u[i].length; j++) { gAs.u[i][j] = null; gAs.v[i][j] = null; }
}
const dAs = FA.derive(gAs);
if (dAs.fronts.length) eq(dAs.fronts[0].kind, 'stationary', '缺风数据 → stationary');

/* ============================================================
 * 1b. 地形屏蔽：高原/山地边缘的强温度梯度不算锋面
 *     （只影响锋面检测；等压线、低压中心仍用完整气压场）
 * ============================================================ */
section('1b. derive：高海拔格点从锋面检测中屏蔽');
const gElev = cloneGrid(gA);
gElev.elev = gElev.lats.map(la => gElev.lons.map(() => (la >= 35 && la <= 41 ? 3000 : 100)));
const dElev = FA.derive(gElev);
eq(dElev.fronts.length, 0, '整条高原带（3000m）屏蔽后不再产生假锋面（实际 ' + dElev.fronts.length + '）');
eq(dElev.isobars.length, dA.isobars.length, '地形屏蔽不影响等压线条数');
eq(JSON.stringify(dElev.lows), JSON.stringify(dA.lows), '地形屏蔽不影响低压中心');

/* 半条锋面被高原覆盖：剩下能识别出的锋面点不得落在海拔 ≥1200m 的格点上 */
const gHalf = cloneGrid(gA);
gHalf.elev = gHalf.lats.map((la, i) => gHalf.lons.map((lo, j) =>
  (la >= 35 && la <= 41 && j < 6) ? 3000 : 100));
const dHalf = FA.derive(gHalf);
let badElevPts = 0;
dHalf.fronts.forEach(f => f.pts.forEach(p => {
  const e = nearestElev(gHalf, p[0], p[1]);
  if (e !== null && e >= 1200) badElevPts++;
}));
eq(badElevPts, 0, '屏蔽后锋面点不落在海拔 ≥1200m 的格点上');
ok(dHalf.fronts.length >= 1, '低海拔一侧仍可识别锋面（实际 ' + dHalf.fronts.length + '）');
checkDerived(dHalf, gHalf, '半屏蔽合成场');

/* 膨胀 1 格：锋面候选格自身海拔很低，但紧邻高原格点 → 也要屏蔽 */
const gNearPlateau = cloneGrid(gA);
gNearPlateau.elev = gNearPlateau.lats.map((la, i) =>
  gNearPlateau.lons.map(() => (i === 5 ? 2500 : 100)));   /* 35°N 一行高地，紧邻 38°N 候选带 */
const dNear = FA.derive(gNearPlateau);
eq(dNear.fronts.length, 0, '紧邻高原的候选带被膨胀屏蔽 → 无假锋面（实际 ' + dNear.fronts.length + '）');
/* 注：「远处高地不误伤真实锋面」不放合成场（均匀梯度下 p70 对单行扰动极敏感，
   说明不了问题）；改由第 8 节真实场裁剪回归覆盖 —— 裁剪网格内包含青藏高原
   高海拔格点，真实冷锋仍被识别。 */

console.log('  · 全屏蔽 fronts=' + dElev.fronts.length + '，半屏蔽 fronts=' +
  dHalf.fronts.length + '，紧邻高地 fronts=' + dNear.fronts.length +
  '（海拔 ≥1200m 的锋面点 ' + badElevPts + ' 个）');

/* ============================================================
 * 2. 合成场带 995 hPa 局部低点 → lows 含它
 * ============================================================ */
section('2. derive：低压中心');
const gB = makeGrid({
  latMin: 20, latMax: 50, lonMin: 100, lonMax: 136, step: 3,
  temp: (lat) => 20 - 0.2 * (lat - 20),
  /* 高斯低压：中心 (32°N, 112°E) 原值 995 hPa */
  press: (lat, lon) => {
    const a = (lat - 32) / 4, b = (lon - 112) / 4;
    return 1005 - 10 * Math.exp(-(a * a + b * b));
  },
  precip: () => 0, u: () => 0, v: () => 0
});
const dB = FA.derive(gB);
ok(dB.lows.length >= 1, '识别到低压中心（实际 ' + dB.lows.length + '）');
const nearLow = dB.lows.filter(l => Math.abs(l.lat - 32) < 1e-6 && Math.abs(l.lon - 112) < 1e-6)[0];
ok(!!nearLow, 'lows 含 (32°N,112°E) 的 995 hPa 低点');
if (nearLow) {
  ok(nearLow.press > 995 && nearLow.press < 1002,
    '低点气压接近 995 hPa（平滑后 = ' + nearLow.press.toFixed(2) + '）');
}
checkDerived(dB, gB, '合成场 B');
console.log('  · lows = ' + JSON.stringify(dB.lows));

/* ============================================================
 * 3. derive：缺测 null / 异常输入不崩
 * ============================================================ */
section('3. derive：缺测与异常输入');
const gC = cloneGrid(gA);
for (let j = 0; j < gC.lons.length; j++) { gC.temp[0][j] = null; gC.press[0][j] = null; }
for (let i = 0; i < gC.lats.length; i++) { gC.temp[i][6] = null; gC.press[i][6] = null; }
gC.temp[6][5] = null; gC.press[6][5] = null; gC.u[6][5] = null; gC.v[6][5] = null;
let dC = null, threw = null;
try { dC = FA.derive(gC); } catch (e) { threw = e; }
ok(!threw, '缺测网格 derive 不抛异常');
if (dC) checkDerived(dC, gC, '缺测网格');

/* 所有温度都是 null → 无法算温度梯度，不输出锋面（气压场仍在，等压线可以保留） */
const gAllNull = cloneGrid(gA);
for (let i = 0; i < gAllNull.temp.length; i++) for (let j = 0; j < gAllNull.temp[i].length; j++) gAllNull.temp[i][j] = null;
dC = FA.derive(gAllNull);
ok(dC.fronts.length === 0, '全缺测温度 → 不输出锋面（不编造）');
ok(dC.isobars.every(l => l.pts.length >= 2), '全缺测温度时仍按气压画等压线（若有）');

/* 垃圾输入 */
const junk = [null, undefined, {}, { lats: [], lons: [] }, { lats: [1, 2], lons: [1, 2] },
  { lats: [1, 2, 3], lons: [1, 2, 3] },
  { lats: [1, 2, 3], lons: [1, 2, 3], temp: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] }];
let junkOk = true;
junk.forEach((g, k) => {
  try {
    const d = FA.derive(g);
    if (!d || !isArr(d.fronts) || !isArr(d.isobars) || !isArr(d.lows) ||
      !isArr(d.levels) || !isArr(d.highs)) junkOk = false;
  } catch (e) { junkOk = false; }
});
ok(junkOk, 'derive 对 7 种非法输入返回空 Derived 且不抛异常');

/* ============================================================
 * 4. derive：等压线最多 12 层
 * ============================================================ */
section('4. derive：等压层数上限');
const gLevels = makeGrid({
  latMin: 20, latMax: 50, lonMin: 100, lonMax: 136, step: 3,
  temp: (lat, lon, i, j) => 30 - i - 0.2 * j,
  press: (lat, lon, i, j) => 950 + 5 * i + 3 * j,   /* 气压跨度 ~75 hPa → 原会 >12 层 */
  u: () => 0, v: () => 0
});
const dLevels = FA.derive(gLevels);
ok(dLevels.levels.length <= 12, '等压层级数 ≤12（实际 ' + dLevels.levels.length + '）');
ok(dLevels.levels.length >= 1, '等压层级数 ≥1');
checkDerived(dLevels, gLevels, '大跨度气压场');

/* ============================================================
 * 4b. north 区域尺度：负经度、7.5° 步长、含低压中心
 * ============================================================ */
section('4b. derive：north 区域（负经度 / 7.5° 步长）');
const gN = makeGrid({
  latMin: 25, latMax: 70, lonMin: -180, lonMax: 178, step: 7.5,
  temp: (lat) => 25 - 1.0 * (lat - 25),
  press: (lat, lon) => {
    const trough = 10 * Math.exp(-Math.pow((lat - 45) / 12, 2));
    const low = 12 * Math.exp(-(Math.pow((lat - 55) / 10, 2) + Math.pow((lon + 30) / 10, 2)));
    return 1016 - trough - low;
  },
  u: () => 0, v: () => -25
});
const dN = FA.derive(gN);
ok(dN.fronts.length >= 1, 'north 区域：至少 1 条锋面（实际 ' + dN.fronts.length + '）');
if (dN.fronts.length) eq(dN.fronts[0].kind, 'cold', 'north 区域：冷平流分类');
ok(dN.isobars.length > 0, 'north 区域：等压线非空');
ok(dN.levels.length <= 12, 'north 区域：等压层数 ≤12');
ok(dN.lows.length >= 1, 'north 区域：识别到低压中心（实际 ' + dN.lows.length + '）');
if (dN.lows.length) ok(dN.lows[0].press < 1008, 'north 区域：最低中心 ' + dN.lows[0].press.toFixed(1) + ' hPa < 1008');
/* 负经度（西半球）确实参与了推导与输出 */
const hasNegLon = dN.fronts.some(f => f.pts.some(p => p[1] < 0)) ||
  dN.isobars.some(l => l.pts.some(p => p[1] < 0));
ok(hasNegLon, 'north 区域：输出包含负经度（西半球）坐标点');
checkDerived(dN, gN, 'north 区域合成场');
console.log('  · north：锋面 ' + dN.fronts.length + ' 条，等压线 ' + dN.isobars.length +
  ' 条，层 ' + JSON.stringify(dN.levels) + '，低点 ' + dN.lows.length + ' 个');

/* ============================================================
 * 5. get()：分块 / 成功 / 缓存 / 并发 loading
 * ============================================================ */
section('5. get()：分块请求、成功文案、缓存、并发 loading');
const T0 = Date.UTC(2026, 10, 21, 9, 0);
const stub1 = {};
const win1 = { fetch: makeStub(stub1) };
const F1 = loadField(win1);
eq(stub1.count, 0, '加载 field.js 时不发请求');
ok(win1.FIELD.REGIONS.eastAsia.latMin === 12 && win1.FIELD.REGIONS.north.step === 7.5,
  'REGIONS 与契约一致');

const nLatEA = axis(12, 54, 3).length, nLonEA = axis(76, 144, 3).length;
const totalPts = nLatEA * nLonEA;
const expectChunks = Math.ceil(totalPts / 80);

const st0 = F1.get('eastAsia', { now: T0 });
eq(st0.state, 'loading', '首次调用 state=loading');
eq(st0.text, '全球气压场：正在获取…', 'loading 文案');
eq(st0.updated, 0, 'loading 时 updated=0');
ok(st0.grid === null && st0.derived === null, 'loading 时 grid/derived 为 null');
eq(st0.source, 'Open-Meteo', 'source 固定为 Open-Meteo');
eq(st0.age, 0, 'loading 时 age=0');

const st0b = F1.get('eastAsia', { now: T0 });
eq(st0b.state, 'loading', '请求进行中重复调用 → loading');
await new Promise(r => setTimeout(r, 40));   /* 首块请求在 Promise 微任务链里启动 */
eq(stub1.count, 1, '顺序发送：并发调用不重复发请求（此刻只发出第 1 块）');

const stOk = await waitFor(() => {
  const s = F1.get('eastAsia', { now: T0 + 1000 });
  return s.state === 'ok' ? s : null;
}, 20000, '成功状态');

ok(stOk.text === '全球气压场：字段更新于 09:00（Open-Meteo 模式场）' ||
  /^全球气压场：字段更新于 \d{2}:\d{2}（Open-Meteo 模式场）$/.test(stOk.text),
  '成功文案格式（' + stOk.text + '）');
eq(stOk.updated, Date.UTC(2026, 10, 21, 9, 0), 'updated = 模式场时刻（UTC epoch ms）');
eq(stub1.count, expectChunks, '总请求块数 = ceil(' + totalPts + '/80) = ' + expectChunks);
/* 分块顺序发送：任意时刻最多 1 个请求在飞，相邻块之间约 150ms 间隔 */
eq(stub1.maxActive, 1, '分块顺序发送（最大并发请求数 = ' + stub1.maxActive + '）');
let gapBad = 0, gapMin = Infinity;
for (let i = 1; i < stub1.times.length; i++) {
  const d = stub1.times[i] - stub1.times[i - 1];
  if (d < 120) gapBad++;
  if (d < gapMin) gapMin = d;
}
eq(gapBad, 0, '相邻分块间隔 ≥120ms（最小 ' + gapMin + 'ms，设计值 ~150ms）');
ok(stub1.urls.every(u => u.indexOf('https://api.open-meteo.com/v1/forecast?') === 0), '请求 URL 前缀正确');
ok(stub1.urls.every(u => u.indexOf('timezone=UTC') > 0), '请求带 timezone=UTC');
ok(stub1.urls.every(u => u.indexOf('current=temperature_2m,pressure_msl,precipitation,wind_speed_10m,wind_direction_10m') > 0),
  'current 字段与契约一致');
let chunkSizes = [], totalReq = 0;
stub1.urls.forEach(u => {
  const n = (new URL(u)).searchParams.get('latitude').split(',').length;
  chunkSizes.push(n);
  totalReq += n;
});
ok(Math.max.apply(null, chunkSizes) <= 80, '每块 ≤80 点（最大 ' + Math.max.apply(null, chunkSizes) + '）');
eq(totalReq, totalPts, '请求坐标总数 = 网格点数（' + totalPts + '）');
ok(chunkSizes.length > 1, '>80 点被拆成多块（' + chunkSizes.length + ' 块）');

const grid = stOk.grid;
eq(grid.lats.length, nLatEA, 'grid.lats 行数');
eq(grid.lons.length, nLonEA, 'grid.lons 列数');
eq(grid.step, 3, 'grid.step = region.step');
eq(grid.temp.length, nLatEA, 'temp 行数');
eq(grid.temp[0].length, nLonEA, 'temp 列数');
eq(grid.lats[0], 12, 'lats 升序起点 12');
eq(grid.lons[0], 76, 'lons 升序起点 76');
/* 顺序配对：第 i 行第 j 列应等于该点坐标本身（桩返回 temperature=lat） */
let orderBad = 0;
for (let i = 0; i < nLatEA; i++) {
  for (let j = 0; j < nLonEA; j++) {
    if (grid.temp[i][j] !== grid.lats[i]) orderBad++;
    if (Math.abs(grid.press[i][j] - (1000 + grid.lons[j] / 10)) > 1e-9) orderBad++;
  }
}
eq(orderBad, 0, '响应按顺序配对到 (lat,lon) 网格');
ok(grid.elev && isArr(grid.elev) && grid.elev.length === nLatEA && grid.elev[0].length === nLonEA,
  'grid.elev 附加字段形状正确（不破坏契约）');
let elevBad = 0;
for (let i = 0; i < nLatEA; i++) {
  for (let j = 0; j < nLonEA; j++) {
    if (grid.elev[i][j] !== (grid.lats[i] >= 45 ? 3000 : 100)) elevBad++;
  }
}
eq(elevBad, 0, 'grid.elev 由多点响应的 elevation 解析而来');
near(grid.u[0][0], -36, 1e-9, 'windU = -speed*sin(dir)（dir=90° → -36）');
near(grid.v[0][0], 0, 1e-9, 'windV = -speed*cos(dir)（dir=90° → 0）');
ok(stOk.derived && isArr(stOk.derived.fronts) && isArr(stOk.derived.isobars) && isArr(stOk.derived.levels),
  'ok 状态附带 derived');
checkDerived(stOk.derived, grid, '取数网格');

/* 缓存：9 分钟内不再请求 */
const cntCache = stub1.count;
const stCache = F1.get('eastAsia', { now: T0 + 9 * 60 * 1000 });
eq(stCache.state, 'ok', '9 分钟内命中缓存 → ok');
eq(stub1.count, cntCache, '缓存命中不发请求');
eq(stCache.updated, stOk.updated, '缓存命中 updated 不变');
ok(stCache.age >= 9 * 60 * 1000 - 1, '缓存命中 age 反映数据龄（' + stCache.age + 'ms）');

/* 10 分钟后过期 → 重新请求；并发仍只发一次 */
const cntExpire = stub1.count;
const stExpire = F1.get('eastAsia', { now: T0 + 10 * 60 * 1000 + 1 });
eq(stExpire.state, 'loading', '10 分钟后重新请求 → loading');
await new Promise(r => setTimeout(r, 40));
eq(stub1.count, cntExpire + 1, '过期刷新：顺序发送，此刻只发出第 1 块');
const stExpire2 = F1.get('eastAsia', { now: T0 + 10 * 60 * 1000 + 2 });
eq(stExpire2.state, 'loading', '刷新进行中重复调用 → loading');
eq(stub1.count, cntExpire + 1, '刷新进行中不重复请求');
await waitFor(() => F1.get('eastAsia', { now: T0 + 10 * 60 * 1000 + 3000 }).state === 'ok', 20000, '刷新完成');
eq(stub1.count, cntExpire + expectChunks, '过期刷新最终分 ' + expectChunks + ' 块');

/* clearCache 后可再次请求 */
F1.clearCache();
const stCleared = F1.get('eastAsia', { now: T0 + 10 * 60 * 1000 + 5000 });
eq(stCleared.state, 'loading', 'clearCache 后重新请求');
await new Promise(r => setTimeout(r, 40));
eq(stub1.count, cntExpire + expectChunks + 1, 'clearCache 后重新请求（首块）');
await waitFor(() => F1.get('eastAsia', { now: T0 + 10 * 60 * 1000 + 6000 }).state === 'ok', 20000, 'clearCache 后完成');
eq(stub1.count, cntExpire + 2 * expectChunks, 'clearCache 后最终分 ' + expectChunks + ' 块');

/* ============================================================
 * 6. get()：失败 500 与 30 秒退避
 * ============================================================ */
section('6. get()：失败状态与 30 秒内不重试');
const TF = Date.UTC(2026, 10, 21, 10, 0);
const stub2 = {};
const F2 = loadField({ fetch: makeFailStub(stub2) });
const stF0 = F2.get('eastAsia', { now: TF });
eq(stF0.state, 'loading', '失败前先返回 loading');
const stErr = await waitFor(() => {
  const s = F2.get('eastAsia', { now: TF });
  return s.state === 'error' ? s : null;
}, 4000, '失败状态');
eq(stErr.state, 'error', 'HTTP 500 → state=error');
ok(stErr.text.indexOf('全球气压场获取失败：') === 0, '失败文案前缀「全球气压场获取失败：」（' + stErr.text + '）');
ok(/500/.test(stErr.text), '失败文案含 HTTP 500');
eq(stErr.updated, 0, '失败且无缓存时 updated=0');
eq(stErr.grid, null, '失败且无缓存时 grid=null');
eq(stErr.derived, null, '失败且无缓存时 derived=null');
eq(stub2.count, 1, '顺序发送：首块失败即整次失败，后续块不再发（实际 ' + stub2.count + ' 块）');

const cntFail = stub2.count;
const stNoRetry = F2.get('eastAsia', { now: TF + 29999 });
eq(stNoRetry.state, 'error', '30 秒内再次调用 → 直接 error');
eq(stub2.count, cntFail, '30 秒内不重试（请求数不变）');
const stRetry = F2.get('eastAsia', { now: TF + 31000 });
eq(stRetry.state, 'loading', '超过 30 秒 → 重新尝试');
await new Promise(r => setTimeout(r, 40));
eq(stub2.count, cntFail + 1, '重试从第 1 块重新开始');
await waitFor(() => F2.get('eastAsia', { now: TF + 31000 }).state === 'error', 20000, '重试失败');
eq(stub2.count, cntFail + 1, '重试失败后请求数稳定');

/* ============================================================
 * 6b. get()：HTTP 429（每分钟额度耗尽）→ 退避 60 秒 + 友好文案
 * ============================================================ */
section('6b. get()：429 超额退避 60 秒');
const T429 = Date.UTC(2026, 10, 21, 11, 0);
const stub429 = {};
const F429 = loadField({ fetch: makeErrorStub(stub429, 429) });
const st429a = F429.get('eastAsia', { now: T429 });
eq(st429a.state, 'loading', '429 场景先返回 loading');
const st429 = await waitFor(() => {
  const s = F429.get('eastAsia', { now: T429 });
  return s.state === 'error' ? s : null;
}, 20000, '429 失败状态');
eq(st429.state, 'error', 'HTTP 429 → state=error');
ok(st429.text.indexOf('全球气压场获取失败：') === 0, '429 文案仍带统一失败前缀');
ok(/请求过于频繁（429）/.test(st429.text), '429 文案注明「请求过于频繁（429）」（' + st429.text + '）');
ok(/稍后自动重试/.test(st429.text), '429 文案注明「稍后自动重试」');
eq(stub429.count, 1, '顺序发送：429 时只发第 1 块');
const cnt429 = stub429.count;
eq(F429.get('eastAsia', { now: T429 + 29999 }).state, 'error', '429 后 30 秒内仍 error');
eq(stub429.count, cnt429, '429 后 30 秒内不重试（不能沿用普通 30s 退避）');
eq(F429.get('eastAsia', { now: T429 + 59999 }).state, 'error', '429 后 60 秒内仍 error');
eq(stub429.count, cnt429, '429 后 60 秒内不重试');
const st429retry = F429.get('eastAsia', { now: T429 + 61000 });
eq(st429retry.state, 'loading', '429 超过 60 秒 → 重新尝试');
await new Promise(r => setTimeout(r, 40));
eq(stub429.count, cnt429 + 1, '429 重试从第 1 块开始');
await waitFor(() => F429.get('eastAsia', { now: T429 + 61000 }).state === 'error', 20000, '429 重试失败');
eq(stub429.count, cnt429 + 1, '429 重试失败后请求数稳定');

/* ============================================================
 * 7. get()：未知区域 / 无 fetch / fetch 抛异常 → 永不抛
 * ============================================================ */
section('7. get()：异常环境永不抛异常');
const stub4 = {};
const F4 = loadField({ fetch: makeStub(stub4) });
let stUnknown = null, threwUnknown = null;
try { stUnknown = F4.get('mars', { now: T0 }); } catch (e) { threwUnknown = e; }
ok(!threwUnknown, '未知区域调用不抛异常');
if (stUnknown) {
  eq(stUnknown.state, 'error', '未知区域 → error');
  ok(/未知区域/.test(stUnknown.text), '未知区域文案说明原因（' + stUnknown.text + '）');
  ok(stUnknown.grid === null && stUnknown.derived === null, '未知区域无数据');
}
eq(stub4.count, 0, '未知区域不发请求');

const winNoFetch = {};
const FNo = loadField(winNoFetch);
const stNoFetch = FNo.get('north', { now: T0 });
eq(stNoFetch.state, 'error', '无 fetch 环境 → error');
ok(/fetch/.test(stNoFetch.text), '无 fetch 文案说明原因（' + stNoFetch.text + '）');
ok(/全球气压场获取失败：/.test(stNoFetch.text), '无 fetch 文案同样带失败前缀');

let noThrow = true;
try {
  FNo.get();
  FNo.get(null);
  FNo.get('eastAsia', null);
  FNo.get('eastAsia', { now: T0 });
} catch (e) { noThrow = false; }
ok(noThrow, 'get(空参/null/无 opts) 均不抛异常');

/* fetch 同步抛异常 → 失败状态，原因透传 */
const F5 = loadField({ fetch: () => { throw new Error('boom'); } });
const st5 = F5.get('north', { now: T0 });
eq(st5.state, 'loading', 'fetch 同步抛异常时先返回 loading');
const st5e = await waitFor(() => {
  const s = F5.get('north', { now: T0 });
  return s.state === 'error' ? s : null;
}, 4000, '同步异常失败状态');
ok(/boom/.test(st5e.text), '同步 fetch 异常原因透传（' + st5e.text + '）');


/* ============================================================
 * 8. 真实场回归：2026-11-21 10:00 UTC 东亚洲区（裁剪 24–48°N / 79–142°E）
 *    该网格来自一次真实 Open-Meteo 取数（存于 D:\works\_out\grid-eastAsia.json）；
 *    此处只裁剪 + 取整，未改数值关系。回归目标：
 *      · 日本海一带的真实冷锋能被识别，端点落在 33–46°N / 128–145°E；
 *      · 高原屏蔽（含 1 圈膨胀）后，锋面点不贴高海拔格点、不落在青藏高原框内；
 *      · 等压线/低压中心不受地形屏蔽影响。
 * ============================================================ */
section('8. 真实场回归：日本海冷锋 + 高原假锋屏蔽');
const REAL_EA_CROP = {
  /* 来源：10:00 UTC eastAsia 真实模式场（grid-eastAsia.json）裁剪 24–48°N / 79–142°E；
     仅裁剪 + 取整：temp/press 0.1，precip/u/v 0.01，elev 整数；未改数值关系。 */
  lats: [24, 27, 30, 33, 36, 39, 42, 45, 48],
  lons: [79, 82, 85, 88, 91, 94, 97, 100, 103, 106, 109, 112, 115, 118, 121, 124, 127, 130, 133, 136, 139, 142],
  step: 3,
  temp: [
      [18.2, 19.5, 18.3, 21.7, 22.5, 15.9, 19.3, 13.8, 9.6, 15, 16.5, 15.6, 13.9, 17.6, 17.2, 20.7, 21.6, 23.4, 24.3, 24.5, 25.4, 25.1],
      [16.8, 16.6, 16.7, 13.6, 13.6, 19.2, 15.2, 8.6, 2.7, 10, 13.8, 14.6, 13.8, 12.6, 15.4, 16.9, 18.3, 20, 20.7, 22.4, 22.6, 22.8],
      [7.6, -7.6, -12.5, -5.9, 0.4, -4.1, -1.2, -4.5, 10.9, 10.4, 11.7, 12.6, 14.4, 11.5, 12.5, 14.6, 15.7, 17, 17.7, 18.5, 19.5, 22.9],
      [-12.9, -6.5, -11.9, -7.3, -8.8, -7.8, -0.5, -3.1, 1.3, 9, 6.8, 9.9, 8.3, 10.6, 10.9, 11.8, 12.9, 7.8, 11.8, 12.9, 15.7, 17.3],
      [-18.4, -9.3, -15.7, -16.2, -20.6, -8.4, -4.9, -3.2, 0.9, 3.5, 2.6, 2.8, 3.8, 2.7, 5.9, 7.3, 2.6, 5.8, 9.9, 7.5, 9.4, 13.2],
      [-4, -5.6, -6, 0.3, -4.5, -9.1, -6.7, 0.9, -1.5, -4.3, -3.7, -3.4, 1.8, 2.8, 1.1, 1, -9.7, 3.3, 3.5, 5.1, 7.6, 6.8],
      [-14, -2.5, -0.8, -4.8, -1.9, -1.9, -4.1, -8.1, -4, -6.4, -6.8, -10.1, -11.8, -9, -5.7, -8, -12.6, -3.5, -4.4, -0.4, 3.5, 5.2],
      [-1.5, -4.2, -1.7, -4.1, -1.2, -5.9, -8, -10.3, -14.6, -13, -10.7, -9.9, -12.8, -11.2, -6.6, -8.8, -11.9, -12.4, -11.7, -11.3, -0.7, -0.3],
      [0.5, -3.5, -2.2, -12.2, -15.2, -18, -17.9, -14.5, -10.4, -12.5, -13.4, -10.1, -8.6, -11.6, -13.6, -9.1, -18.2, -13.3, -13.7, -11, -8.9, -2.8]
    ],
  press: [
      [1018, 1017.4, 1018.1, 1018.3, 1018.4, 1022.6, 1020.9, 1023.6, 1027.1, 1028.2, 1028.2, 1028.2, 1028.3, 1027.4, 1024.6, 1025.7, 1024.4, 1023.1, 1021.9, 1021, 1020.3, 1019.8],
      [1018.8, 1018.8, 1018.9, 1022.6, 1021.9, 1020.2, 1022.6, 1025.8, 1025.3, 1027.7, 1028.4, 1029.6, 1030.7, 1030.4, 1029.8, 1028.2, 1025.8, 1024, 1022.3, 1021, 1020.3, 1020.2],
      [1022.3, 1025.3, 1030.1, 1028, 1024.8, 1038, 1028.4, 1025.2, 1028, 1028, 1028.2, 1028.5, 1029.7, 1030.7, 1030.5, 1028.2, 1026.7, 1024.5, 1023, 1021.5, 1020, 1018.7],
      [1026, 1025.9, 1027.9, 1026.3, 1028, 1027.8, 1025.9, 1024.1, 1021.3, 1028.8, 1028.2, 1029.3, 1030, 1029.3, 1029.8, 1027.2, 1024.8, 1024.5, 1023.4, 1022.3, 1020, 1018.6],
      [1025.9, 1022.7, 1028.6, 1030.7, 1026.6, 1025.3, 1020.6, 1024.5, 1026.6, 1024.8, 1030.7, 1030.4, 1033.2, 1031.8, 1029.8, 1026.6, 1026.6, 1024.3, 1021.1, 1019.6, 1015.3, 1015.9],
      [1027, 1028.2, 1029.1, 1030.3, 1022.1, 1032.2, 1022.7, 1025.9, 1027.3, 1025.6, 1032.4, 1031.6, 1033.2, 1032.4, 1030.4, 1027.9, 1026.1, 1020.6, 1018.2, 1017.2, 1015.8, 1015.6],
      [1030.6, 1025.5, 1030.1, 1029.9, 1028.8, 1030.5, 1028.1, 1031.2, 1030.2, 1031.6, 1031.8, 1034.5, 1036.3, 1033, 1031.8, 1030.2, 1029.7, 1023.1, 1020.1, 1016.8, 1013.8, 1011.5],
      [1019.2, 1028.7, 1029.3, 1028.7, 1025.4, 1026.5, 1028.9, 1026.5, 1029.2, 1030.6, 1031.5, 1032, 1032.8, 1033.8, 1029.4, 1028.9, 1028.1, 1024.4, 1022.3, 1015.9, 1012.2, 1009.3],
      [1022.6, 1026.6, 1027.1, 1025.6, 1022.6, 1035.8, 1027.4, 1021.7, 1021.6, 1025.6, 1026.6, 1027.3, 1027.6, 1030, 1028.1, 1025, 1025.2, 1020.6, 1016.6, 1016.2, 1010.7, 1008.2]
    ],
  precip: [
      [0, 0, 0, 0.1, 0, 0.1, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0, 0.5, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ],
  u: [
      [-4.21, -8.98, -8.97, -2.15, -7.94, -1.06, -3.6, 1.08, -4.1, -1.82, -6.6, -0.54, -4.86, -12.1, 0.71, -14.54, -4.79, -1.02, 3.15, -6.16, -3.86, -5.66],
      [-6.88, -6.17, -5.8, -0.88, -2.37, -2.13, -0.5, -1.43, 6.68, 1.61, -1.43, -0.53, -1.47, -1.95, -1.51, 1.65, 8.41, 12.45, 15.02, 25.38, 17.63, 6.47],
      [-1.21, -3.23, 6.28, 0.76, 1.3, -0.76, -0.54, 2.29, 2.51, 0, -2.16, 0.92, -2.88, 4.31, 6.09, 20.49, 21.58, 18.81, 12.91, 9.17, 12.06, 32.71],
      [-3.12, 0.88, -2.7, 6.43, 9.95, 2.36, 3.28, 0.75, -0.92, -0.72, -1.26, -7.43, 1.33, -1.39, 8.09, 20.69, 27.34, 6.51, 12.18, 36, 42.94, 38.13],
      [2.5, -3.6, 10.32, 12.57, 12.63, 1.93, 6.35, 3.42, 0.92, 8.34, -1.82, 8.64, -2.31, -5.2, 5.36, 14.65, -4.31, 40.61, 54.69, 28.76, -1.05, 18.39],
      [5.8, 1.08, -1.39, 2.72, 3.6, -3.09, 5.96, 2.91, 6.3, 3.96, 0.88, 8.27, 7.89, -2.4, -1.97, 6.34, 7.57, 23.4, -5.14, 14.62, 34.63, 25.98],
      [0.19, 2.32, -0.57, 10.46, 7.41, 7.89, 18.57, 0.54, -7.2, -3.56, 8.39, 9.17, 5.93, 3.55, 3.45, -2.32, 2.86, 15.55, 25.33, 11.43, 34.17, 29.56],
      [-1.64, 1.8, -8.3, -9.74, -4.31, 3.85, 0.19, 3.2, 9.23, 1.4, 10.86, 4.05, 13.82, 10.89, 12.99, 9, 7.78, 15.09, 14.72, 13.16, 9.39, 2.55],
      [-3.95, -0.18, -16.36, -1.04, 5.4, -3.26, -1.25, 6.23, 4.18, -8.65, 9.4, 11.18, 8.17, 7.7, 19.63, 8.97, 5.22, 13.83, 10.97, 11.73, 8.27, 21.32]
    ],
  v: [
      [-8.63, -7.02, 0.78, -5.06, -2.73, 1.58, -2.52, -1.44, -0.14, 0.56, -6.83, 2.54, -9.53, -17.28, 5.76, -26.24, -24.64, -19.47, -16.2, -11.11, -12.62, -14.75],
      [-4.64, -5.55, 0, -2.87, 0.38, -6.98, 0.34, 1.25, 3.4, 5.26, 1.25, 2.13, 1.63, -4.82, -21.55, -23.54, -29.32, -25.53, -19.23, -4.02, -3.11, -3.59],
      [-0.88, -5.17, 1.22, -0.93, 0, -0.93, -2.34, 7.04, -1.82, -1.8, 1.45, 4.71, 3.96, 3.25, -1.63, -16.01, -18.76, -25.89, -18.43, -25.18, -24.72, 18.13],
      [1.8, 0.17, -3.22, 7.4, -3.04, 8.79, -0.34, 5.35, 2.54, -0.54, -1.8, -1.04, -10.82, 7.17, -3.95, -26.48, -11.6, -6.07, -6.48, -30.21, -13.13, -9.51],
      [7.7, 2.16, 10.32, 2.9, -1.33, -6.31, 11.46, 1.11, -0.92, 13.89, 2.51, 1.06, -13.1, -13.54, -27.58, -25.37, -11.84, -13.2, -6.72, 1.51, -3.23, -7.06],
      [10.05, 10.24, 9.9, 2.2, 2.52, -1.64, 5.18, 0.73, -2.55, 0.56, 0.17, 4.03, 6.62, -22.87, -28.23, -27.48, -0.66, -14.06, -29.15, -31.36, -25.16, 4.11],
      [-0.57, -5.21, 0.57, -0.92, 10.19, 14.83, -2.94, -2.54, 5.23, -1.82, 5.45, 9.5, -1.81, -5.91, -16.24, -10.04, -5.39, -17.89, -34.87, -15.17, -5.41, -7.92],
      [5.04, 0, -7.22, 2.25, -3.25, -15.43, -0.57, 2.88, -3, 5.22, 8.18, 12.46, 1.45, 7.63, -14.94, -0.16, 4.31, 4.33, -2.33, -12.71, -24.46, -6.3],
      [-1.44, -1.29, -5.32, -3.03, 1.05, 8.5, 1.43, 4.53, -3.26, 5.41, 0, 8.43, 7.36, 13.34, -1.72, -0.78, -0.92, -10.05, 6.59, 9.5, -5.79, -35.49]
    ],
  elev: [
      [491, 499, 540, 23, 5, 1075, 137, 1965, 1748, 429, 173, 70, 309, 0, 1133, 0, 0, 0, 0, 0, 0, 0],
      [153, 101, 88, 1922, 1915, 82, 1676, 2588, 3310, 1235, 655, 281, 68, 377, 0, 0, 0, 0, 0, 0, 0, 0],
      [1806, 3657, 5663, 5174, 4437, 3593, 3886, 4823, 589, 219, 911, 32, 106, 383, 35, 0, 0, 0, 0, 0, 0, 0],
      [5306, 4736, 4829, 5075, 5213, 4792, 3732, 4191, 3501, 632, 1226, 177, 38, 41, 0, 0, 0, 484, 32, 0, 0, 0],
      [5495, 4357, 5114, 4864, 5222, 4387, 4306, 3263, 2101, 2115, 1081, 1258, 51, 385, 0, 0, 22, 0, 0, 470, 447, 0],
      [1148, 1118, 1122, 873, 3280, 3044, 3735, 1870, 1406, 2484, 1335, 1540, 293, 0, 0, 0, 896, 0, 0, 0, 0, 0],
      [3242, 1819, 977, 1363, 1187, 990, 1729, 955, 1208, 967, 1513, 1554, 1426, 1121, 219, 352, 755, 0, 0, 0, 0, 0],
      [1818, 677, 299, 622, 1296, 1748, 1544, 2013, 1276, 1196, 1006, 1086, 1363, 966, 472, 158, 167, 452, 69, 667, 0, 163],
      [655, 765, 414, 1886, 2963, 1208, 2499, 2403, 1740, 1360, 1549, 1014, 809, 596, 1033, 169, 285, 483, 65, 145, 594, 0]
    ]
};

const dReal = FA.derive(REAL_EA_CROP);
ok(dReal.fronts.length >= 1, '真实场：识别出锋面 ≥1 条（实际 ' + dReal.fronts.length + '）');
const realFront = dReal.fronts[0];
if (realFront) {
  eq(realFront.kind, 'cold', '真实场：日本海冷锋分类为 cold（冷平流）');
  ok(realFront.pts.length >= 2 && realFront.pts.length <= 12,
    '真实场：锋面点数 2..12（实际 ' + realFront.pts.length + '）');
  const inBand = (p) => p[0] >= 33 && p[0] <= 46 && p[1] >= 128 && p[1] <= 145;
  ok(inBand(realFront.pts[0]) && inBand(realFront.pts[realFront.pts.length - 1]),
    '真实场：锋面首尾端点在 33–46°N/128–145°E（' +
    JSON.stringify(realFront.pts[0]) + ' → ' + JSON.stringify(realFront.pts[realFront.pts.length - 1]) + '）');
  let badElev = 0, plateauPts = 0;
  realFront.pts.forEach(p => {
    const e = nearestElev(REAL_EA_CROP, p[0], p[1]);
    if (e !== null && e >= 1200) badElev++;
    if (p[0] >= 27 && p[0] <= 33 && p[1] >= 80 && p[1] <= 96) plateauPts++;
  });
  eq(badElev, 0, '真实场：锋面点最近格点海拔 <1200m（不贴高原）');
  eq(plateauPts, 0, '真实场：锋面点不落在 27–33°N/80–96°E 高原框内（无地形假锋）');
}
eq(dReal.highs.length, 0, '真实场：highs 仍为空数组');
ok(dReal.isobars.length > 0, '真实场：等压线非空（实际 ' + dReal.isobars.length + ' 条）');
ok(dReal.levels.length >= 1 && dReal.levels.length <= 12,
  '真实场：等压层数 1..12（实际 ' + dReal.levels.length + '）');
checkDerived(dReal, REAL_EA_CROP, '真实场裁剪');
console.log('  · 真实场：fronts=' + dReal.fronts.length +
  (realFront ? ' kind=' + realFront.kind + ' pts=' + JSON.stringify(realFront.pts) : '') +
  '，levels=' + JSON.stringify(dReal.levels) + '，lows=' + dReal.lows.length);

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n' + '='.repeat(56));
if (fails.length) {
  console.log('FAIL：' + pass + ' 项通过，' + fails.length + ' 项失败');
  fails.forEach(m => console.log('  - ' + m));
  process.exitCode = 1;
} else {
  console.log('PASS：' + pass + ' 项断言全部通过');
}
