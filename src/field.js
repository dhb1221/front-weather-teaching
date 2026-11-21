/* ============================================================
 * field.js — 真实模式场数据层：区域网格取数 + 等压线/低压中心/锋面推导
 *
 * 数据来源：Open-Meteo Forecast API（免密钥、开放 CORS、无需代理）
 *   https://api.open-meteo.com/v1/forecast?latitude=a,b,...&longitude=...&current=...&timezone=UTC
 *   按区域（REGIONS）的规则网格生成坐标点，每块 ≤ 80 点**顺序**请求（块间隔 ~150ms，
 *   避免瞬时打满 Open-Meteo 的点数限额（每分钟/每小时配额）；429（超额）时整区退避 60 秒）；
 *   多点响应是数组，与请求坐标**顺序一致**，每个点还带 `elevation`（格点海拔）。
 *   任一块请求失败或解析失败 → 整次失败（绝不编造数值、绝不用默认值填充缺测）。
 *
 * 数据性质（重要）：这是**数值模式网格**（模式当前场/预报场），不是气象站实测，
 *   页面会明确标注“Open-Meteo 模式场”。
 *
 * 推导 derive(grid)（纯函数，不碰 DOM / 网络，缺测 null 一律跳过）：
 *   0) 地形屏蔽（仅用于锋面检测）：海拔 ≥1200 m 的格点**及其相邻 1 圈的格点**
 *      temp 先置 null 再平滑/求梯度，避免青藏高原/天山等地形造成的“假锋面”
 *      （实测高原南麓低海拔格点仍受地形影响）；等压线与低压中心仍用完整海平面气压场；
 *   1) 3x3 平滑：格点取邻域内有效值的平均；**中心缺测保持 null**（不拿邻点编造）；
 *   2) 温度梯度 gx/gy（°C/km），grad = hypot(gx,gy)*100（°C/100km，教材量级）；
 *   3) 锋面候选（种子）：grad ≥ max(0.7, 70 分位)，且沿梯度方向 ±1.5 格处气压都比
 *      中心高 ≥0.6 hPa（两侧高、中间低 = 槽线）；再以全部种子做多源「滞后生长」：
 *      8 邻接、梯度 ≥0.6×阈值、且沿锋线方向（垂直梯度，夹角余弦 ≤0.5）的格点
 *      最多并入 3 圈（补足稀疏种子、使锋线够长，又保持局地且不横向加厚）；
 *      连通域 ≥3 格才成锋面；PCA 主轴排序 → 分箱（≥2 点成线，≥3 点才做平滑）；
 *      按“分量平均风在梯度方向上的投影”分类：> +8 km/h 冷平流 cold，
 *      < −8 km/h 暖平流 warm，其余准静止 stationary；最多 8 条；
 *   4) 等压线：气压先 /4 缩放（等值线落在整数级别，避免 1000+ hPa 的浮点边界抖动），
 *      marching squares 以 4 hPa 间隔取线，线段缝合为折线，最多 12 层；
 *   5) 低压中心：8 邻域严格局部最低且 < 1015 hPa，6° 内去重保留最低，最多 6 个；
 *   6) 所有输出经纬度都限制在网格（= region）范围内，前端可直接绘制。
 *   注：3) 的槽线间隔/余量、连通域门限、滞后生长参数均为文件顶部可配置常量
 *      （TROUGH_SPAN_CELLS / TROUGH_MARGIN_HPA / FRONT_MIN_CELLS /
 *        GROW_GRAD_RATIO / GROW_RINGS），可依据实测场再微调。
 *
 * 缓存与退避：成功缓存 10 分钟（age < 10min 直接返回 'ok'）；普通失败 30 秒内不重试；
 *   HTTP 429（超额）退避 60 秒，文案注明“请求过于频繁（429），稍后自动重试”；
 *   请求进行中重复调用返回 'loading'。**加载本文件时不发任何请求。**
 *
 * API：window.FIELD = {
 *   REGIONS, get(name, opts), derive(grid), clearCache()
 * }
 *   get 返回 Status: { name, state:'idle'|'loading'|'ok'|'error', text,
 *                      updated, source:'Open-Meteo', grid, derived, age }
 *   Grid 在契约字段之外附加 elev[lat][lon]（格点海拔，米，可为 null）：
 *     只用于锋面检测的地形屏蔽，不改变契约字段语义。
 *   opts（可选，调试/测试用）：now —— 注入“当前时间”（epoch ms），用于离线
 *     验证缓存与失败退避；缺省用 Date.now()。
 *
 * 语法：纯 ES5 经典 IIFE，无 import/export、无箭头函数、无 class。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var API_URL = 'https://api.open-meteo.com/v1/forecast';
  var CURRENT_FIELDS = 'temperature_2m,pressure_msl,precipitation,' +
    'wind_speed_10m,wind_direction_10m';
  var SOURCE = 'Open-Meteo';
  var TIMEOUT_MS = 8000;              /* 单块请求超时 8s（AbortController） */
  var CACHE_MS = 10 * 60 * 1000;      /* 成功缓存 10 分钟（小区域） */
  var CACHE_MS_GLOBAL = 30 * 60 * 1000; /* 全球气压场 30 分钟：数据本身按小时更新，减少额度消耗 */
  var RETRY_MS = 30 * 1000;           /* 普通失败后 30 秒内不重试 */
  var RETRY_429_MS = 60 * 1000;       /* HTTP 429（点数超额，分钟/小时配额）退避 60 秒 */
  var CHUNK_GAP_MS = 150;             /* 分块顺序发送，块间隔 ~150ms，避免瞬时打满限额 */
  var MAX_POINTS = 80;                /* 每块最多 80 个坐标（Open-Meteo 多点上限内） */
  var MAX_FRONTS = 8;                 /* 锋面最多 8 条 */
  var MAX_LEVELS = 12;                /* 等压线最多 12 层 */
  var MAX_LOWS = 6;                   /* 低压中心最多 6 个 */
  var ELEV_MASK_M = 1200;             /* 锋面检测海拔屏蔽阈值（米）：高原/山地不算锋面 */
  var ELEV_DILATE_RING = 1;           /* 海拔屏蔽膨胀 1 格：紧贴高原的格点温度同样不可信 */
  var TROUGH_SPAN_CELLS = 1.5;        /* 槽线判据：沿梯度方向采样 ±1.5 格（原 ±2） */
  var TROUGH_MARGIN_HPA = 0.6;        /* 槽线判据：两侧气压比中心高 ≥0.6 hPa（原 1.0） */
  var FRONT_MIN_CELLS = 3;            /* 锋面连通域最少格数（原 4） */
  var GROW_GRAD_RATIO = 0.6;          /* 滞后生长：邻格梯度 ≥ 0.6×阈值 则并入 */
  var GROW_RINGS = 3;                 /* 滞后生长最多向外扩 3 圈（限制范围，见 findFronts 注释） */
  var GROW_COS_MAX = 0.5;             /* 滞后生长只沿锋线方向（垂直梯度）：偏移与梯度方向夹角余弦 ≤0.5 */
  var DEG = Math.PI / 180;
  var KM_PER_DEG = 111.32;            /* 1° 纬度 ≈ 111.32 km */

  /* 区域网格（lat/lon 都是“起点 + 步长”的规则网格，含端点） */
  var REGIONS = {
    eastAsia: { latMin: 12, latMax: 54, lonMin: 76, lonMax: 144, step: 3 },
    north: { latMin: 25, latMax: 70, lonMin: -180, lonMax: 178, step: 7.5 },
    /* 全球气压场：供 ⑦ 三维地球画真实等压线（15° 网格，11×24=264 点，省额度） */
    global: { latMin: -75, latMax: 75, lonMin: -180, lonMax: 165, step: 15 }
  };

  /* ---------------- 0. 小工具 ---------------- */
  function num(v) {
    var x = parseFloat(v);
    return isFinite(x) ? x : null;
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function pad2(v) {
    return (v < 10 ? '0' : '') + v;
  }

  /* 坐标输出保留 4 位小数（约 10 m，教学足够且不产生浮点长尾） */
  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  function clamp(v, lo, hi) {
    if (!isFinite(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function errText(e) {
    if (!e) return '未知错误';
    return (e.message ? e.message : String(e));
  }

  /* 由 min/max/step 生成升序网格轴（含端点；1e-9 容差吸收浮点误差） */
  function axis(min, max, step) {
    var out = [], v = min, guard = 0;
    while (v <= max + 1e-9 && guard < 10000) {
      out.push(Math.round(v * 1e6) / 1e6);
      v += step;
      guard++;
    }
    return out;
  }

  /* 请求坐标串：整数/半度直接输出，避免 12.000000000000002 这种长尾 */
  function fmtCoord(v) {
    return String(Math.round(v * 10000) / 10000);
  }

  function boundsOf(lats, lons) {
    var i, latLo = lats[0], latHi = lats[0], lonLo = lons[0], lonHi = lons[0];
    for (i = 1; i < lats.length; i++) {
      if (lats[i] < latLo) latLo = lats[i];
      if (lats[i] > latHi) latHi = lats[i];
    }
    for (i = 1; i < lons.length; i++) {
      if (lons[i] < lonLo) lonLo = lons[i];
      if (lons[i] > lonHi) lonHi = lons[i];
    }
    return { latLo: latLo, latHi: latHi, lonLo: lonLo, lonHi: lonHi };
  }

  /* 2 维数组：[nlat][nlon]，初值 null（缺测） */
  function mk2(nlat, nlon) {
    var rows = [], i, j;
    for (i = 0; i < nlat; i++) {
      var r = [];
      for (j = 0; j < nlon; j++) r.push(null);
      rows.push(r);
    }
    return rows;
  }

  var emptyDerived = function () {
    return { lows: [], highs: [], fronts: [], isobars: [], levels: [] };
  };

  /* 原始场（可能是稀疏/带缺测的数组）→ 规整的 [nlat][nlon] 数值/缺测矩阵；
     形状不符返回 null（调用方按“无数据”处理，绝不猜） */
  function toField2D(raw, nlat, nlon) {
    if (!raw || typeof raw.length !== 'number' || raw.length !== nlat) return null;
    var out = [], i, j;
    for (i = 0; i < nlat; i++) {
      var row = raw[i];
      if (!row || typeof row.length !== 'number' || row.length !== nlon) return null;
      var r = [];
      for (j = 0; j < nlon; j++) r.push(num(row[j]));
      out.push(r);
    }
    return out;
  }

  /* ---------------- 1. 网络请求（fetch + 8s 超时 + no-store） ---------------- */
  function fetchFn() {
    /* 只认 global（浏览器里就是 window）上的 fetch：这样“无 fetch 环境”
       能被可靠识别（不会误用宿主 Node 的全局 fetch）。 */
    return (global && typeof global.fetch === 'function') ? global.fetch : null;
  }

  function setTimer(fn, ms) {
    if (global && typeof global.setTimeout === 'function') return global.setTimeout(fn, ms);
    if (typeof setTimeout === 'function') return setTimeout(fn, ms);
    return null;
  }

  function clearTimer(t) {
    if (t === null || t === undefined) return;
    if (global && typeof global.clearTimeout === 'function') { global.clearTimeout(t); return; }
    if (typeof clearTimeout === 'function') clearTimeout(t);
  }

  /* 延时 Promise（分块顺序请求之间的间隔；环境无 setTimeout 时直接放行） */
  function delay(ms) {
    return new Promise(function (resolve) {
      var t = setTimer(function () { resolve(); }, ms);
      if (t === null) resolve();
    });
  }

  function fetchJSON(url) {
    return new Promise(function (resolve, reject) {
      var f = fetchFn();
      if (!f) { reject(new Error('当前环境不支持 fetch')); return; }

      var AC = (global && typeof global.AbortController === 'function') ? global.AbortController
        : (typeof AbortController !== 'undefined' ? AbortController : null);
      var ctl = null;
      if (AC) { try { ctl = new AC(); } catch (e0) { ctl = null; } }

      var settled = false;
      function done(ok, value) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        if (ok) resolve(value);
        else reject(value instanceof Error ? value : new Error(errText(value)));
      }

      var timer = setTimer(function () {
        if (settled) return;
        settled = true;
        if (ctl) { try { ctl.abort(); } catch (e1) { } }
        reject(new Error('请求超时（' + Math.round(TIMEOUT_MS / 1000) + ' 秒）'));
      }, TIMEOUT_MS);

      var opt = { cache: 'no-store' };
      if (ctl) opt.signal = ctl.signal;

      var p;
      try {
        p = f(url, opt);
      } catch (e2) {
        done(false, e2);
        return;
      }

      Promise.resolve(p).then(function (r) {
        if (!r) throw new Error('网络无响应');
        if (r.ok === false) {
          /* 把 HTTP 状态与 Retry-After 挂到 Error 上：get() 据此区分 429（分钟/小时/每日额度）与普通失败 */
          var status = (r.status === undefined || r.status === null) ? 0 : r.status;
          var httpErr = new Error('HTTP ' + (status || '?'));
          httpErr.status = status;
          try {
            var ra = r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : null;
            if (ra !== null && ra !== undefined) {
              var raSec = parseInt(ra, 10);
              if (isFinite(raSec) && raSec > 0) httpErr.retryAfter = raSec;
            }
          } catch (eRa) { /* 读不到响应头就按默认退避 */ }
          throw httpErr;
        }
        if (typeof r.json === 'function') return Promise.resolve(r.json());
        if (typeof r.text === 'function') {
          return r.text().then(function (txt) {
            try { return JSON.parse(txt); } catch (e3) { throw new Error('返回数据不是合法 JSON'); }
          });
        }
        throw new Error('响应缺少 json()/text()');
      }).then(function (data) {
        done(true, data);
      }, function (err) {
        if (err && err.name === 'AbortError') {
          done(false, new Error('请求超时（' + Math.round(TIMEOUT_MS / 1000) + ' 秒）'));
        } else {
          done(false, err);
        }
      });
    });
  }

  /* ---------------- 2. 取数：区域网格 → 分块请求 → Grid ---------------- */
  /* UTC ISO（Open-Meteo 在 timezone=UTC 下给的是不带时区的 "YYYY-MM-DDTHH:mm"） */
  function isoUtcMs(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return isFinite(ms) ? ms : null;
  }

  /* 单个点的 current → 网格单元；缺测一律 null（不编造） */
  function parseItem(item) {
    if (!item || typeof item !== 'object') throw new Error('返回数据项不是对象');
    var cur = item.current;
    if (!cur || typeof cur !== 'object') throw new Error('返回数据缺少 current 字段');

    var speed = num(cur.wind_speed_10m);
    var dir = num(cur.wind_direction_10m);
    var u = null, v = null;
    if (speed !== null && dir !== null) {
      /* 气象风向 dir 是“风的来向”：u/v 为风的去向分量，单位 km/h */
      u = -speed * Math.sin(dir * DEG);
      v = -speed * Math.cos(dir * DEG);
    }
    return {
      temp: num(cur.temperature_2m),
      press: num(cur.pressure_msl),
      precip: num(cur.precipitation),
      u: u,
      v: v,
      elev: num(item.elevation),   /* 格点海拔（米）：仅供锋面检测屏蔽高原地形 */
      time: cur.time
    };
  }

  function chunkUrl(list) {
    var lat = [], lon = [], i;
    for (i = 0; i < list.length; i++) {
      lat.push(fmtCoord(list[i][0]));
      lon.push(fmtCoord(list[i][1]));
    }
    return API_URL + '?latitude=' + lat.join(',') + '&longitude=' + lon.join(',') +
      '&current=' + CURRENT_FIELDS + '&timezone=UTC';
  }

  /* 取一块（≤80 点）：响应数组按顺序对应请求坐标 */
  function fetchChunk(list) {
    return fetchJSON(chunkUrl(list)).then(function (json) {
      var arr = json;
      if (!arr || typeof arr.length !== 'number') {
        /* 单点请求时 Open-Meteo 返回对象而不是数组 */
        if (list.length === 1 && arr && typeof arr === 'object' && arr.current) arr = [arr];
        else throw new Error('返回数据不是多点数组');
      }
      if (arr.length !== list.length) {
        throw new Error('返回点数不符（预期 ' + list.length + '，实际 ' + arr.length + '）');
      }
      var out = [], i;
      for (i = 0; i < arr.length; i++) out.push(parseItem(arr[i]));
      return out;
    });
  }

  /* 拉取整个区域网格；任一块失败 → reject（整次失败） */
  function requestRegion(reg) {
    var lats = axis(reg.latMin, reg.latMax, reg.step);
    var lons = axis(reg.lonMin, reg.lonMax, reg.step);
    var nlat = lats.length, nlon = lons.length;
    if (!nlat || !nlon) return Promise.reject(new Error('区域网格为空'));

    /* 点序：行（lat 升序）× 列（lon 升序） */
    var pts = [], i, j;
    for (i = 0; i < nlat; i++) {
      for (j = 0; j < nlon; j++) pts.push([lats[i], lons[j]]);
    }

    var chunks = [], k;
    for (k = 0; k < pts.length; k += MAX_POINTS) chunks.push(pts.slice(k, k + MAX_POINTS));

    /* 分块**顺序**发送（块间隔 ~150ms）：避免一次性并发把所有块打出去，
       瞬时耗尽 Open-Meteo“每分钟点数”额度（实测会返回 HTTP 429）。
       任一块失败 → 后续块不再发送，整次失败（Promise 链 reject）。 */
    var results = [];
    var chain = Promise.resolve();
    for (k = 0; k < chunks.length; k++) {
      (function (idx) {
        chain = chain.then(function () { return fetchChunk(chunks[idx]); })
          .then(function (list) { results.push(list); });
        if (idx < chunks.length - 1) {
          chain = chain.then(function () { return delay(CHUNK_GAP_MS); });
        }
      })(k);
    }

    return chain.then(function () {
      var grid = {
        lats: lats, lons: lons, step: reg.step,
        temp: mk2(nlat, nlon),
        press: mk2(nlat, nlon),
        precip: mk2(nlat, nlon),
        u: mk2(nlat, nlon),
        v: mk2(nlat, nlon),
        /* 附加字段（不破坏契约）：格点海拔，仅供锋面检测屏蔽高原地形 */
        elev: mk2(nlat, nlon)
      };
      var p = 0, firstTime = null, c, m;
      for (c = 0; c < results.length; c++) {
        var list = results[c];
        for (m = 0; m < list.length; m++) {
          i = Math.floor(p / nlon);
          j = p % nlon;
          var it = list[m];
          grid.temp[i][j] = it.temp;
          grid.press[i][j] = it.press;
          grid.precip[i][j] = it.precip;
          grid.u[i][j] = it.u;
          grid.v[i][j] = it.v;
          grid.elev[i][j] = it.elev;
          if (firstTime === null && it.time) firstTime = it.time;
          p++;
        }
      }
      if (p !== pts.length) throw new Error('返回点数不符（预期 ' + pts.length + '，实际 ' + p + '）');

      var ms = isoUtcMs(firstTime);
      return { grid: grid, updated: (ms === null ? Date.now() : ms) };
    });
  }

  /* ---------------- 3. 状态与缓存 ---------------- */
  var cache = {};        /* name -> {grid, derived, updated, fetchedAt} */
  var pending = {};      /* name -> true（请求进行中） */
  var lastFail = {};     /* name -> {until, msg, status}（失败退避用；429 退避更长） */

  function nowOf(opts) {
    var v = opts && opts.now;
    return isFinite(v) ? v : Date.now();
  }

  function hhmm(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function statusOf(name, state, text, entry, now) {
    return {
      name: name,
      state: state,
      text: text,
      updated: entry ? entry.updated : 0,
      source: SOURCE,
      grid: entry ? entry.grid : null,
      derived: entry ? entry.derived : null,
      age: entry ? Math.max(0, now - entry.fetchedAt) : 0
    };
  }

  function statusError(name, reason, entry, now) {
    return statusOf(name, 'error', '全球气压场获取失败：' + reason, entry || null, now);
  }

  /* 失败 → 退避策略：HTTP 429（点数限额耗尽：分钟/小时配额）退避 60 秒并给友好文案，
     其余普通失败仍退避 30 秒。绝不把失败重试做成“每帧狂打接口”。 */
  function failInfo(err) {
    var status = num(err && err.status);
    if (status === 429) {
      var ra = num(err && err.retryAfter);
      /* Retry-After 很长说明是“每日额度”而不是分钟/小时突发限额：直接退避到恢复时刻 */
      if (ra && ra > 3600) {
        return {
          status: 429,
          msg: '今日额度已用完（429），约 ' + Math.round(ra / 3600) + ' 小时后恢复',
          retryMs: Math.min(ra * 1000, 24 * 3600 * 1000)
        };
      }
      return {
        status: 429,
        msg: '请求过于频繁（429），稍后自动重试',
        retryMs: RETRY_429_MS
      };
    }
    return { status: status, msg: errText(err), retryMs: RETRY_MS };
  }

  function startLoad(name, reg, now) {
    pending[name] = true;
    requestRegion(reg).then(function (data) {
      pending[name] = false;
      var derived;
      try {
        derived = derive(data.grid);
      } catch (e) {
        /* 推导失败不应让已经拿到的真实场数据作废：给空结果，不伪造 */
        derived = emptyDerived();
      }
      cache[name] = {
        grid: data.grid,
        derived: derived,
        updated: data.updated,
        fetchedAt: now
      };
      delete lastFail[name];
    }, function (err) {
      pending[name] = false;
      var info = failInfo(err);
      lastFail[name] = {
        until: now + info.retryMs,
        msg: info.msg,
        status: info.status
      };
    });
  }

  /**
   * get(name, opts) → Status（永不抛异常）
   *   name: 'eastAsia' | 'north'
   *   缓存 10 分钟内直接 'ok'；并发中返回 'loading'；
   *   普通失败 30 秒内不重试；HTTP 429 退避 60 秒。
   */
  function get(name, opts) {
    var now = nowOf(opts);
    try {
      if (!name || !REGIONS[name] || !REGIONS.hasOwnProperty(name)) {
        return statusError(String(name), '未知区域「' + String(name) + '」', null, now);
      }
      if (!fetchFn()) {
        return statusError(name, '当前环境不支持 fetch', null, now);
      }

      var reg = REGIONS[name];
      var entry = cache[name];

      /* 命中缓存：小区域 10 分钟、全球气压场 30 分钟内直接返回 */
      var ttl = name === 'global' ? CACHE_MS_GLOBAL : CACHE_MS;
      if (entry && now - entry.fetchedAt < ttl) {
        return statusOf(name, 'ok',
          '全球气压场：字段更新于 ' + hhmm(entry.updated) + '（Open-Meteo 模式场）', entry, now);
      }

      /* 并发中：返回 loading（带上旧数据，前端可继续显示上一帧） */
      if (pending[name]) {
        return statusOf(name, 'loading', '全球气压场：正在获取…', entry || null, now);
      }

      /* 失败退避：普通失败 30 秒内不再打接口；HTTP 429 退避 60 秒（见 failInfo） */
      var fail = lastFail[name];
      if (fail && now < fail.until) {
        return statusError(name, fail.msg, entry || null, now);
      }

      startLoad(name, reg, now);
      return statusOf(name, 'loading', '全球气压场：正在获取…', entry || null, now);
    } catch (err) {
      /* 兜底：get 永远不抛 */
      return {
        name: String(name),
        state: 'error',
        text: '全球气压场获取失败：' + errText(err),
        updated: 0,
        source: SOURCE,
        grid: null,
        derived: null,
        age: 0
      };
    }
  }

  function clearCache() {
    cache = {};
    pending = {};
    lastFail = {};
  }

  /* ============================================================
   * 4. 推导：等压线 / 低压中心 / 锋面（纯函数）
   * ============================================================ */

  /* 4.0 高海拔屏蔽：海拔 ≥ maxM 的格点温度视为缺测（只服务锋面检测，
     不改变等压线/低压中心所用的气压场；也绝不用邻点插值补回）。
     另做 1 圈膨胀：紧贴高原/山地的低海拔格点，温度同样受地形影响
     （实测青藏高原南麓 27°N/85–94°E 一带格点 elevation 恰好 <1200 m 却仍有
     2.4–3.0 ℃/100km 的假梯度），因此邻居海拔 ≥maxM 的格点一并屏蔽。 */
  function maskHighElev(T, E, nlat, nlon, maxM) {
    var hi = mk2(nlat, nlon), i, j, di, dj;
    for (i = 0; i < nlat; i++) {
      for (j = 0; j < nlon; j++) {
        if (E[i][j] !== null && E[i][j] >= maxM) hi[i][j] = 1;
      }
    }
    var out = [], dr = ELEV_DILATE_RING;
    for (i = 0; i < nlat; i++) {
      var r = [];
      for (j = 0; j < nlon; j++) {
        var t = T[i][j];
        var masked = false;
        for (di = -dr; di <= dr && !masked; di++) {
          for (dj = -dr; dj <= dr; dj++) {
            var ii = i + di, jj = j + dj;
            if (ii < 0 || ii >= nlat || jj < 0 || jj >= nlon) continue;
            if (hi[ii][jj]) { masked = true; break; }
          }
        }
        r.push(masked ? null : t);
      }
      out.push(r);
    }
    return out;
  }

  /* 4.1 3x3 平滑：忽略缺测；中心缺测保持 null（不用邻点编造） */
  function smooth3(F, nlat, nlon) {
    if (!F) return null;
    var out = mk2(nlat, nlon), i, j, di, dj;
    for (i = 0; i < nlat; i++) {
      for (j = 0; j < nlon; j++) {
        var c = F[i][j];
        if (c === null) continue;
        var sum = 0, cnt = 0;
        for (di = -1; di <= 1; di++) {
          for (dj = -1; dj <= 1; dj++) {
            var ii = i + di, jj = j + dj;
            if (ii < 0 || ii >= nlat || jj < 0 || jj >= nlon) continue;
            var v = F[ii][jj];
            if (v === null) continue;
            sum += v;
            cnt++;
          }
        }
        if (cnt > 0) out[i][j] = sum / cnt;
      }
    }
    return out;
  }

  /* 4.2 双线性采样（缺测按有效权重归一化；全部缺测返回 null） */
  function bilinear(F, nlat, nlon, fi, fj) {
    if (!isFinite(fi) || !isFinite(fj)) return null;
    if (fi < -1e-9 || fj < -1e-9 || fi > nlat - 1 + 1e-9 || fj > nlon - 1 + 1e-9) return null;
    var i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i0 > nlat - 2) i0 = nlat - 2;
    if (j0 > nlon - 2) j0 = nlon - 2;
    var wi = fi - i0, wj = fj - j0;
    var v00 = F[i0][j0], v01 = F[i0][j0 + 1], v10 = F[i0 + 1][j0], v11 = F[i0 + 1][j0 + 1];
    var w00 = (1 - wi) * (1 - wj), w01 = (1 - wi) * wj;
    var w10 = wi * (1 - wj), w11 = wi * wj;
    var sum = 0, wsum = 0;
    if (v00 !== null) { sum += v00 * w00; wsum += w00; }
    if (v01 !== null) { sum += v01 * w01; wsum += w01; }
    if (v10 !== null) { sum += v10 * w10; wsum += w10; }
    if (v11 !== null) { sum += v11 * w11; wsum += w11; }
    return wsum > 0 ? sum / wsum : null;
  }

  /* 4.3 百分位（线性插值；输入不得为空） */
  function percentile(vals, p) {
    var a = vals.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var pos = p * (a.length - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo < 0) lo = 0;
    if (hi >= a.length) hi = a.length - 1;
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  /* 4.4 低压中心：8 邻域严格局部最低且 < 1015 hPa，6° 内去重保留最低 */
  function findLows(PS, lats, lons, nlat, nlon, bn) {
    var cand = [], i, j, di, dj;
    for (i = 1; i < nlat - 1; i++) {
      for (j = 1; j < nlon - 1; j++) {
        var v = PS[i][j];
        if (v === null || !(v < 1015)) continue;
        var ok = true;
        for (di = -1; di <= 1 && ok; di++) {
          for (dj = -1; dj <= 1; dj++) {
            if (!di && !dj) continue;
            var w = PS[i + di][j + dj];
            /* 邻点缺测 → 无法确认是局部最低，跳过（不猜） */
            if (w === null || !(w > v)) { ok = false; break; }
          }
        }
        if (ok) cand.push({ lat: lats[i], lon: lons[j], press: v });
      }
    }
    cand.sort(function (a, b) { return a.press - b.press; });

    var kept = [], k, q;
    for (k = 0; k < cand.length && kept.length < MAX_LOWS; k++) {
      var c = cand[k], far = true;
      for (q = 0; q < kept.length; q++) {
        var dLat = c.lat - kept[q].lat, dLon = c.lon - kept[q].lon;
        if (Math.sqrt(dLat * dLat + dLon * dLon) <= 6) { far = false; break; }
      }
      if (far) {
        kept.push({
          lat: round4(clamp(c.lat, bn.latLo, bn.latHi)),
          lon: round4(clamp(c.lon, bn.lonLo, bn.lonHi)),
          press: c.press
        });
      }
    }
    return kept;
  }

  /* ---------------- marching squares 等压线 ---------------- */
  /* 网格索引坐标（fi=lat 方向、fj=lon 方向，可含小数）下的等值线段 */
  function marchingSegs(F, nlat, nlon, hpa) {
    /* 气压缩放：p/4，于是 4 hPa 间隔 ⇔ 整数级别，比较更稳 */
    var lev = hpa / 4;
    var segs = [], i, j;

    function frac(p, q) {
      var den = q - p;
      if (!isFinite(den) || den === 0) return 0.5;
      var f = (lev - p) / den;
      if (f < 0) return 0;
      if (f > 1) return 1;
      return f;
    }

    for (i = 0; i < nlat - 1; i++) {
      for (j = 0; j < nlon - 1; j++) {
        var a = F[i][j], b = F[i][j + 1], c = F[i + 1][j + 1], d = F[i + 1][j];
        if (a === null || b === null || c === null || d === null) continue;
        var A = a / 4, B = b / 4, C = c / 4, D = d / 4;
        var idx = (A >= lev ? 1 : 0) | (B >= lev ? 2 : 0) |
          (C >= lev ? 4 : 0) | (D >= lev ? 8 : 0);
        if (idx === 0 || idx === 15) continue;
        var top = { fi: i, fj: j + frac(A, B) };
        var right = { fi: i + frac(B, C), fj: j + 1 };
        var bottom = { fi: i + 1, fj: j + frac(D, C) };
        var left = { fi: i + frac(A, D), fj: j };
        var center = (A + B + C + D) / 4;
        function seg(p1, p2) { segs.push([p1, p2]); }
        switch (idx) {
          case 1: case 14: seg(top, left); break;
          case 2: case 13: seg(top, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(right, bottom); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, bottom); break;
          case 5:
            /* 鞍点：用格心均值判断“高值区是否连通” */
            if (center >= lev) { seg(top, right); seg(left, bottom); }
            else { seg(top, left); seg(right, bottom); }
            break;
          case 10:
            if (center >= lev) { seg(top, left); seg(right, bottom); }
            else { seg(top, right); seg(left, bottom); }
            break;
          default: break;
        }
      }
    }
    return segs;
  }

  /* 线段缝合折线：按量化端点串接，直到两端都接不上 */
  function stitchSegs(segs) {
    var lines = [], used = [], i, m;
    if (!segs.length) return lines;

    function key(p) {
      return Math.round(p.fi * 1000) + ':' + Math.round(p.fj * 1000);
    }
    var adj = {};
    for (i = 0; i < segs.length; i++) {
      var k1 = key(segs[i][0]), k2 = key(segs[i][1]);
      if (!adj[k1]) adj[k1] = [];
      if (!adj[k2]) adj[k2] = [];
      adj[k1].push(i);
      adj[k2].push(i);
    }
    function nextSeg(k) {
      var list = adj[k];
      if (!list) return -1;
      for (var t = 0; t < list.length; t++) {
        if (!used[list[t]]) return list[t];
      }
      return -1;
    }

    for (i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      var line = [segs[i][0], segs[i][1]];

      var guard = 0;
      while (guard++ < segs.length + 2) {
        var tailKey = key(line[line.length - 1]);
        var si = nextSeg(tailKey);
        if (si < 0) break;
        used[si] = 1;
        var s = segs[si], p0 = key(s[0]), p1 = key(s[1]);
        if (p0 === tailKey) line.push(s[1]);
        else if (p1 === tailKey) line.push(s[0]);
        else break;
        if (key(line[line.length - 1]) === key(line[0])) break;   /* 闭合 */
      }

      guard = 0;
      while (guard++ < segs.length + 2) {
        var headKey = key(line[0]);
        var sj = nextSeg(headKey);
        if (sj < 0) break;
        used[sj] = 1;
        var s2 = segs[sj], q0 = key(s2[0]), q1 = key(s2[1]);
        if (q0 === headKey) line.unshift(s2[1]);
        else if (q1 === headKey) line.unshift(s2[0]);
        else break;
        if (key(line[0]) === key(line[line.length - 1])) break;
      }

      /* 去掉相邻重合点 */
      var clean = [];
      for (m = 0; m < line.length; m++) {
        if (clean.length && key(clean[clean.length - 1]) === key(line[m])) continue;
        clean.push(line[m]);
      }
      if (clean.length >= 2) lines.push(clean);
    }
    return lines;
  }

  /* 轴数组上的线性插值（f 为小数下标） */
  function interpAxis(arr, f) {
    var n = arr.length;
    if (n === 1) return arr[0];
    if (f <= 0) return arr[0];
    if (f >= n - 1) return arr[n - 1];
    var i0 = Math.floor(f), w = f - i0;
    return arr[i0] + w * (arr[i0 + 1] - arr[i0]);
  }

  /* 等压线：4 hPa 间隔，最多 12 层；每层可能有多条折线 */
  function findIsobars(PS, lats, lons, nlat, nlon, bn) {
    var vals = [], i, j;
    for (i = 0; i < nlat; i++) {
      for (j = 0; j < nlon; j++) {
        if (PS[i][j] !== null) vals.push(PS[i][j]);
      }
    }
    if (!vals.length) return { isobars: [], levels: [] };

    var minP = Math.min.apply(null, vals), maxP = Math.max.apply(null, vals);
    var all = [], L;
    for (L = Math.ceil(minP / 4) * 4; L <= maxP + 1e-9; L += 4) all.push(L);
    if (!all.length) return { isobars: [], levels: [] };

    var levels = all;
    if (all.length > MAX_LEVELS) {
      /* 层数过多时均匀抽取，保持覆盖整个气压范围 */
      var picked = [], k;
      for (k = 0; k < MAX_LEVELS; k++) {
        var lv = all[Math.round(k * (all.length - 1) / (MAX_LEVELS - 1))];
        if (picked.indexOf(lv) < 0) picked.push(lv);
      }
      picked.sort(function (a, b) { return a - b; });
      levels = picked;
    }

    var out = [], t, m;
    for (t = 0; t < levels.length; t++) {
      var lines = stitchSegs(marchingSegs(PS, nlat, nlon, levels[t]));
      for (m = 0; m < lines.length; m++) {
        var line = lines[m];
        if (line.length < 2) continue;
        var pts = [], q;
        for (q = 0; q < line.length; q++) {
          var la = interpAxis(lats, line[q].fi);
          var lo = interpAxis(lons, line[q].fj);
          pts.push([
            round4(clamp(la, bn.latLo, bn.latHi)),
            round4(clamp(lo, bn.lonLo, bn.lonHi))
          ]);
        }
        out.push({ hpa: levels[t], pts: pts });
      }
    }
    return { isobars: out, levels: levels };
  }

  /* ---------------- 锋面推导 ---------------- */
  /* 「滞后生长」连通域：先取全部通过槽线判据的格点为种子（同为第 0 圈），
     再多源 BFS 把 8 邻接、梯度 ≥ GROW_GRAD_RATIO×thr 的格点并入同一连通域，
     最多向外扩 GROW_RINGS 圈。
     · 为什么要多源 BFS：种子往往稀疏、彼此相隔 2~3 格，若按单源 BFS 各自计圈，
       相邻种子会被拆成多条平行假锋；多源同时播种后沿锋线方向能连成一条。
     · 为什么要限制方向（垂直梯度 ≈ 沿锋线）：真实场实测表明，无方向约束的
       各向同性生长会把锋面横向加厚成“方块”，PCA 主轴退化（东亚洲区会连成
       南北向竖线），限定方向后锋线才会沿真实锋区延伸。
     · 为什么限圈数：无限生长会沿整条大尺度温度梯度带串联（东亚洲区可连成
       15–51°N/79–139°E 的横贯假线）；限 3 圈既补足稀疏种子、让锋线够长，又保持局地。 */
  function growComponents(seed, grad, GX, GY, lats, step, thr, nlat, nlon) {
    var member = mk2(nlat, nlon), queue = [], i, j, di, dj;
    var growMin = GROW_GRAD_RATIO * thr;
    for (i = 0; i < nlat; i++) {
      for (j = 0; j < nlon; j++) {
        if (!seed[i][j]) continue;
        member[i][j] = 0;          /* 种子 = 第 0 圈 */
        queue.push([i, j, 0]);
      }
    }
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      var ci = cur[0], cj = cur[1], cd = cur[2];
      if (cd >= GROW_RINGS) continue;   /* 已到最外圈，不再外扩 */
      var cx = GX[ci][cj], cy = GY[ci][cj];
      var cm = (cx !== null && cy !== null) ? Math.sqrt(cx * cx + cy * cy) : 0;
      if (!(cm > 0)) continue;
      var cosLat = Math.max(0.1, Math.cos(lats[ci] * DEG));
      for (di = -1; di <= 1; di++) {
        for (dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue;
          var ii = ci + di, jj = cj + dj;
          if (ii < 1 || ii >= nlat - 1 || jj < 1 || jj >= nlon - 1) continue;
          if (member[ii][jj] !== null) continue;
          var gv = grad[ii][jj];
          if (gv === null || gv < growMin) continue;
          /* 偏移方向（物理：东向按 cos(lat) 缩）与锋面法向（梯度方向）的夹角：
             只允许沿锋线方向（垂直梯度）扩展 */
          var px = dj * step * cosLat, py = di * step;
          var pl = Math.sqrt(px * px + py * py);
          if (!(pl > 0)) continue;
          var cosAng = Math.abs((px * (cx / cm) + py * (cy / cm)) / pl);
          if (cosAng > GROW_COS_MAX) continue;
          member[ii][jj] = cd + 1;
          queue.push([ii, jj, cd + 1]);
        }
      }
    }

    /* 成员格点的 8 邻接连通域 */
    var visited = mk2(nlat, nlon), comps = [];
    for (i = 0; i < nlat; i++) {
      for (j = 0; j < nlon; j++) {
        if (member[i][j] === null || visited[i][j]) continue;
        var stack = [[i, j]], cells = [];
        visited[i][j] = 1;
        while (stack.length) {
          var c = stack.pop();
          cells.push({ i: c[0], j: c[1] });
          for (di = -1; di <= 1; di++) {
            for (dj = -1; dj <= 1; dj++) {
              if (!di && !dj) continue;
              var i2 = c[0] + di, j2 = c[1] + dj;
              if (i2 < 0 || i2 >= nlat || j2 < 0 || j2 >= nlon) continue;
              if (visited[i2][j2] || member[i2][j2] === null) continue;
              visited[i2][j2] = 1;
              stack.push([i2, j2]);
            }
          }
        }
        comps.push(cells);
      }
    }
    return comps;
  }

  /* 一个连通域 → 一条锋面；点太少/无法定轴时返回 null */
  function buildFront(cells, ctx) {
    var lats = ctx.lats, lons = ctx.lons;
    var US = ctx.US, VS = ctx.VS, GX = ctx.GX, GY = ctx.GY;
    var bn = ctx.bn;
    var n = cells.length, i, j, k, q;

    /* 质心（经纬度）→ 以质心为原点的“东/北”平面坐标（东向按 cos(lat) 缩为实际距离） */
    var sumLat = 0, sumLon = 0;
    for (k = 0; k < n; k++) {
      sumLat += lats[cells[k].i];
      sumLon += lons[cells[k].j];
    }
    var latMean = sumLat / n, lonMean = sumLon / n;
    var cosMean = Math.max(0.1, Math.cos(latMean * DEG));
    var xs = [], ys = [];
    for (k = 0; k < n; k++) {
      xs.push((lons[cells[k].j] - lonMean) * cosMean);
      ys.push(lats[cells[k].i] - latMean);
    }

    /* PCA 主轴：协方差矩阵最大特征向量的方向 */
    var Sxx = 0, Sxy = 0, Syy = 0;
    for (k = 0; k < n; k++) {
      Sxx += xs[k] * xs[k];
      Sxy += xs[k] * ys[k];
      Syy += ys[k] * ys[k];
    }
    Sxx /= n; Sxy /= n; Syy /= n;
    var theta = 0.5 * Math.atan2(2 * Sxy, Sxx - Syy);
    var ax = Math.cos(theta), ay = Math.sin(theta);

    /* 沿主轴排序 → 沿轴分箱取均值（箱宽约 1 格） */
    var proj = [], tMin, tMax;
    for (k = 0; k < n; k++) proj.push({ k: k, t: xs[k] * ax + ys[k] * ay });
    proj.sort(function (p, r) { return p.t - r.t; });
    tMin = proj[0].t;
    tMax = proj[proj.length - 1].t;

    var stepDeg = ctx.step > 0 ? ctx.step : 3;
    var bins = Math.ceil((tMax - tMin) / stepDeg) + 1;
    if (!isFinite(bins) || bins < 2) bins = 2;   /* 稀疏锋面允许 2 点成线 */
    if (bins > 12) bins = 12;

    var acc = [], span = tMax - tMin;
    for (k = 0; k < bins; k++) acc.push({ lat: 0, lon: 0, c: 0 });
    for (q = 0; q < proj.length; q++) {
      var cell = cells[proj[q].k];
      var b = span > 1e-9 ? Math.floor((proj[q].t - tMin) / span * bins) : 0;
      if (b < 0) b = 0;
      if (b >= bins) b = bins - 1;
      acc[b].lat += lats[cell.i];
      acc[b].lon += lons[cell.j];
      acc[b].c++;
    }
    var binPts = [];
    for (k = 0; k < bins; k++) {
      if (!acc[k].c) continue;   /* 空箱不插值，绝不编造 */
      binPts.push([acc[k].lat / acc[k].c, acc[k].lon / acc[k].c]);
    }
    if (binPts.length < 2) return null;   /* 至少 2 点才成线 */

    /* ≥3 点才做 3 点平滑（2 点直接输出，避免把短锋线抹成一个点） */
    var pts = [];
    if (binPts.length < 3) {
      for (k = 0; k < binPts.length; k++) pts.push([binPts[k][0], binPts[k][1]]);
    } else {
      for (k = 0; k < binPts.length; k++) {
        if (k === 0 || k === binPts.length - 1) {
          pts.push([binPts[k][0], binPts[k][1]]);
        } else {
          pts.push([
            0.25 * binPts[k - 1][0] + 0.5 * binPts[k][0] + 0.25 * binPts[k + 1][0],
            0.25 * binPts[k - 1][1] + 0.5 * binPts[k][1] + 0.25 * binPts[k + 1][1]
          ]);
        }
      }
    }

    /* 分类：分量平均风 · 平均梯度单位方向（>8 冷平流，<−8 暖平流） */
    var sumU = 0, cntU = 0, sumV = 0, cntV = 0;
    var dirE = 0, dirN = 0, dirCnt = 0;
    for (k = 0; k < n; k++) {
      i = cells[k].i;
      j = cells[k].j;
      var u = US ? US[i][j] : null;
      var v = VS ? VS[i][j] : null;
      if (u !== null) { sumU += u; cntU++; }
      if (v !== null) { sumV += v; cntV++; }
      var gx = GX[i][j], gy = GY[i][j];
      if (gx !== null && gy !== null) {
        var gm = Math.sqrt(gx * gx + gy * gy);
        if (gm > 0) {
          dirE += gx / gm;
          dirN += gy / gm;
          dirCnt++;
        }
      }
    }
    var kind = 'stationary';
    if (cntU > 0 && cntV > 0 && dirCnt > 0) {
      var meU = sumU / cntU, meV = sumV / cntV;
      var dLen = Math.sqrt(dirE * dirE + dirN * dirN);
      if (dLen > 1e-9) {
        var projWind = meU * (dirE / dLen) + meV * (dirN / dLen);
        if (projWind > 8) kind = 'cold';
        else if (projWind < -8) kind = 'warm';
      }
    }

    /* 输出 [[lat, lon], ...]，全部限制在网格范围内 */
    var outPts = [];
    for (k = 0; k < pts.length; k++) {
      outPts.push([
        round4(clamp(pts[k][0], bn.latLo, bn.latHi)),
        round4(clamp(pts[k][1], bn.lonLo, bn.lonHi))
      ]);
    }
    return { kind: kind, pts: outPts };
  }

  /* 锋面主流程：梯度场 → 候选（强梯度 + 槽线）→ 连通域 → 逐条建线 */
  function findFronts(TS, PS, US, VS, lats, lons, nlat, nlon, step, bn) {
    var i, j, k, di, dj;
    var grad = mk2(nlat, nlon), GX = mk2(nlat, nlon), GY = mk2(nlat, nlon);
    var vals = [];

    /* ① 温度梯度（中心差分）：gx 东向、gy 北向，单位 °C/km */
    for (i = 1; i < nlat - 1; i++) {
      var dLat = Math.abs(lats[i + 1] - lats[i - 1]) / 2;
      var dLatKm = Math.max(1e-6, dLat) * KM_PER_DEG;
      var cosLat = Math.max(0.1, Math.cos(lats[i] * DEG));
      for (j = 1; j < nlon - 1; j++) {
        var tE = TS[i][j + 1], tW = TS[i][j - 1];
        var tN = TS[i + 1][j], tS = TS[i - 1][j];
        if (tE === null || tW === null || tN === null || tS === null) continue;
        var dLon = Math.abs(lons[j + 1] - lons[j - 1]) / 2;
        var dLonKm = Math.max(1e-6, dLon) * KM_PER_DEG * cosLat;
        var gx = (tE - tW) / (2 * dLonKm);
        var gy = (tN - tS) / (2 * dLatKm);
        var mag = Math.sqrt(gx * gx + gy * gy);
        if (!(mag > 0)) continue;
        GX[i][j] = gx;
        GY[i][j] = gy;
        grad[i][j] = mag * 100;   /* °C/100km，教材量级 */
        vals.push(grad[i][j]);
      }
    }
    if (!vals.length) return [];

    /* ② 阈值 = max(0.7, 70 分位) */
    var p70 = percentile(vals, 0.7);
    var thr = Math.max(0.7, p70 === null ? 0 : p70);

    /* ③ 候选（种子）：强梯度 + 沿梯度方向 ±TROUGH_SPAN_CELLS 格处气压都比中心
       高 ≥TROUGH_MARGIN_HPA（两侧高、中间低 = 槽线） */
    var cand = mk2(nlat, nlon);
    for (i = 1; i < nlat - 1; i++) {
      var dLatKm2 = Math.max(1e-6, Math.abs(lats[i + 1] - lats[i - 1]) / 2) * KM_PER_DEG;
      var cosLat2 = Math.max(0.1, Math.cos(lats[i] * DEG));
      for (j = 1; j < nlon - 1; j++) {
        var g = grad[i][j];
        if (g === null || g < thr - 1e-9) continue;
        var pc = PS[i][j];
        if (pc === null) continue;
        var gx2 = GX[i][j], gy2 = GY[i][j];
        if (gx2 === null || gy2 === null) continue;
        var gm = Math.sqrt(gx2 * gx2 + gy2 * gy2);
        if (!(gm > 0)) continue;

        /* 物理单位方向 (gx/gm 东, gy/gm 北) → 网格格数方向，归一化到 TROUGH_SPAN_CELLS 格 */
        var dLonKm2 = Math.max(1e-6, Math.abs(lons[j + 1] - lons[j - 1]) / 2) * KM_PER_DEG * cosLat2;
        var vI = (gy2 / gm) / dLatKm2;
        var vJ = (gx2 / gm) / dLonKm2;
        var vLen = Math.sqrt(vI * vI + vJ * vJ);
        if (!(vLen > 0)) continue;
        vI = TROUGH_SPAN_CELLS * vI / vLen;
        vJ = TROUGH_SPAN_CELLS * vJ / vLen;
        var pPlus = bilinear(PS, nlat, nlon, i + vI, j + vJ);
        var pMinus = bilinear(PS, nlat, nlon, i - vI, j - vJ);
        if (pPlus === null || pMinus === null) continue;
        if (pPlus - pc >= TROUGH_MARGIN_HPA && pMinus - pc >= TROUGH_MARGIN_HPA) {
          cand[i][j] = 1;
        }
      }
    }

    /* ④ 多源「滞后生长」成连通域（沿锋线方向扩圈）；≥FRONT_MIN_CELLS 格才算；
       大的优先，最多 8 条 */
    var comps = growComponents(cand, grad, GX, GY, lats, step, thr, nlat, nlon);
    comps.sort(function (a, b) { return b.length - a.length; });
    var ctx = {
      lats: lats, lons: lons, US: US, VS: VS, GX: GX, GY: GY,
      step: step, bn: bn
    };
    var fronts = [];
    for (k = 0; k < comps.length; k++) {
      if (comps[k].length < FRONT_MIN_CELLS) continue;
      if (fronts.length >= MAX_FRONTS) break;
      var f = buildFront(comps[k], ctx);
      if (f) fronts.push(f);
    }
    return fronts;
  }

  /* 4.5 derive 主入口（纯函数、永不抛异常） */
  function derive(grid) {
    var empty = emptyDerived();
    try {
      if (!grid || typeof grid !== 'object') return empty;
      var lats = grid.lats, lons = grid.lons;
      if (!lats || !lons || typeof lats.length !== 'number' || typeof lons.length !== 'number') {
        return empty;
      }
      var nlat = lats.length, nlon = lons.length;
      if (nlat < 3 || nlon < 3) return empty;

      var i, j;
      for (i = 0; i < nlat; i++) if (!isNum(lats[i])) return empty;
      for (j = 0; j < nlon; j++) if (!isNum(lons[j])) return empty;

      var T = toField2D(grid.temp, nlat, nlon);
      var P = toField2D(grid.press, nlat, nlon);
      if (!T || !P) return empty;

      /* 地形屏蔽（只影响锋面检测）：海拔 ≥1200 m 的格点 temp 置缺测，
         再进平滑/梯度 —— 青藏高原、天山、帕米尔等大地形边缘常有 3~4 ℃/100km
         的“温度梯度”，那是海拔造成的，不是锋面；等压线/低压中心仍用完整气压场。 */
      var Tfront = T;
      var E = grid.elev ? toField2D(grid.elev, nlat, nlon) : null;
      if (E) Tfront = maskHighElev(T, E, nlat, nlon, ELEV_MASK_M);

      var TS = smooth3(Tfront, nlat, nlon);
      var PS = smooth3(P, nlat, nlon);
      var U = toField2D(grid.u, nlat, nlon);
      var V = toField2D(grid.v, nlat, nlon);
      var US = U ? smooth3(U, nlat, nlon) : null;
      var VS = V ? smooth3(V, nlat, nlon) : null;

      var bn = boundsOf(lats, lons);
      var step = num(grid.step);
      if (step === null || step <= 0) {
        step = nlat > 1 ? Math.abs(lats[1] - lats[0]) : 3;
        if (!(step > 0)) step = 3;
      }

      var out = emptyDerived();
      out.lows = findLows(PS, lats, lons, nlat, nlon, bn);
      var iso = findIsobars(PS, lats, lons, nlat, nlon, bn);
      out.isobars = iso.isobars;
      out.levels = iso.levels;
      out.fronts = findFronts(TS, PS, US, VS, lats, lons, nlat, nlon, step, bn);
      return out;
    } catch (e) {
      /* 纯函数兜底：任何异常都退化为“无推导结果”，绝不抛给调用方 */
      return emptyDerived();
    }
  }

  /* ============================================================
   * 5. 导出（加载时只定义 window.FIELD，不发请求）
   * ============================================================ */
  global.FIELD = {
    REGIONS: REGIONS,
    get: get,
    derive: derive,
    clearCache: clearCache
  };
})(typeof window !== 'undefined' ? window : globalThis);
