/* ============================================================
 * live-globe.js — 三维地球「全球 8 城实时天气」数据层 + 标记图层
 *
 * 数据源：Open-Meteo Forecast API（免 Key、开放 CORS、无需代理）
 *   https://api.open-meteo.com/v1/forecast?latitude=a,b,...&longitude=...&current=...
 *   多坐标一次请求 → 返回与坐标顺序一致的数组；若该用法不可用，
 *   自动降级为 8 个单点请求（Promise.all 汇总）。
 *   8 分钟内存缓存；任何一步失败都 reject 明确错误，绝不伪造数据。
 *
 * 渲染：buildLayer({THREE, H, R, group, toVec}) 由 m8-globe 调用，
 *   每城一个标记 =「城市名+气温」文字精灵 + 发光底晕 + 风向短箭头。
 *   风矢方向说明：
 *     气象风向（wind_direction_10m）= 风从哪个方向吹来。
 *     屏幕上的箭头要指向「风的去向」，即 bearing = windDeg + 180°
 *     （自正北顺时针的方位角）。
 *     球面局部切线用 toVec 数值微分求出（对经度 +0.5° 得东向、纬度 +0.5° 得北向），
 *     因此与 toVec 内部 XYZ 轴约定无关；再由
 *         dir = north·cos(θ) + east·sin(θ)
 *     得到去向单位切向量。该式在南北半球都成立（north 恒指地理北），
 *     不会出现南半球反向的问题。
 *
 * API：window.GLOBE_LIVE = {
 *   CITIES, fetchAll(force?), buildLayer(opts), descOf(code), clearCache()
 * }
 *
 * 依赖：加载时不依赖 THREE / H / DOM（只定义 window.GLOBE_LIVE），
 *       函数内部再取；buildLayer 缺依赖时抛明确 Error。
 * 语法：纯 ES5 经典 IIFE，无 import/export、无 class、无箭头函数。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var API_URL = 'https://api.open-meteo.com/v1/forecast';
  var CURRENT_FIELDS = 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure';
  var TIMEOUT_MS = 8000;                 /* 单次请求超时 8s（AbortController） */
  var CACHE_MS = 8 * 60 * 1000;          /* 模块内 8 分钟缓存 */
  var DEG = Math.PI / 180;

  /* ---------------- 城市（8 个全球代表城市） ---------------- */
  var CITIES = [
    { name: '北京', lat: 39.90, lon: 116.41 },
    { name: '上海', lat: 31.23, lon: 121.47 },
    { name: '广州', lat: 23.13, lon: 113.26 },
    { name: '东京', lat: 35.68, lon: 139.69 },
    { name: '新加坡', lat: 1.35, lon: 103.82 },
    { name: '莫斯科', lat: 55.76, lon: 37.62 },
    { name: '伦敦', lat: 51.51, lon: -0.13 },
    { name: '纽约', lat: 40.71, lon: -74.01 }
  ];

  /* ---------------- WMO 天气码 → 中文（Open-Meteo weather_code） ---------------- */
  var WMO_DESC = {
    0: '晴',
    1: '大致晴朗',
    2: '多云',
    3: '阴',
    45: '雾',
    48: '雾凇',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '大毛毛雨',
    56: '冻毛毛雨',
    57: '强冻毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    66: '冻雨',
    67: '强冻雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    77: '米雪',
    80: '小阵雨',
    81: '阵雨',
    82: '强阵雨',
    85: '小阵雪',
    86: '大阵雪',
    95: '雷暴',
    96: '雷暴伴小冰雹',
    99: '强雷暴伴冰雹'
  };

  /* ============================================================
   * 1. 通用小工具
   * ============================================================ */
  function num(v) {
    var x = parseFloat(v);
    return isFinite(x) ? x : null;
  }
  function round1(v) {
    var x = parseFloat(v);
    return isFinite(x) ? Math.round(x * 10) / 10 : null;
  }
  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }
  function errMsg(e) {
    if (!e) return '未知错误';
    return (e.message ? e.message : String(e));
  }
  function descOf(code) {
    if (code === null || code === undefined || code === '') return '—';
    var c = parseInt(code, 10);
    if (!isFinite(c)) return '—';
    return WMO_DESC[c] || ('其它天气(' + c + ')');
  }
  function isoUtc(t) {
    if (!t) return null;
    var s = String(t);
    /* 请求时 timezone=UTC：给不带时区的 "YYYY-MM-DDTHH:mm" 补上 Z，保持标准 ISO */
    if (/Z$/i.test(s) || /[+-]\d\d:?\d\d$/.test(s)) return s;
    return s + 'Z';
  }

  /* ============================================================
   * 2. 网络请求（fetch + AbortController 8s 超时 + no-store）
   * ============================================================ */
  function fetchJSON(url) {
    return new Promise(function (resolve, reject) {
      var f = (typeof global.fetch === 'function') ? global.fetch :
        (typeof fetch === 'function' ? fetch : null);
      if (!f) { reject(new Error('当前环境没有 fetch')); return; }

      var st = (typeof global.setTimeout === 'function') ? global.setTimeout :
        (typeof setTimeout === 'function' ? setTimeout : null);
      var ct = (typeof global.clearTimeout === 'function') ? global.clearTimeout :
        (typeof clearTimeout === 'function' ? clearTimeout : null);
      if (!st) { reject(new Error('当前环境没有 setTimeout')); return; }

      var AC = global.AbortController ||
        (typeof AbortController !== 'undefined' ? AbortController : null);
      var ctl = null;
      if (AC) { try { ctl = new AC(); } catch (e) { ctl = null; } }

      var settled = false;
      var timer = st(function () {
        if (settled) return;
        settled = true;
        if (ctl) { try { ctl.abort(); } catch (e) { } }
        reject(new Error('请求超时（' + (TIMEOUT_MS / 1000) + 's）'));
      }, TIMEOUT_MS);

      function finish(ok, value) {
        if (settled) return;
        settled = true;
        if (ct) ct(timer);
        if (ok) resolve(value); else reject(value);
      }

      var opt = { cache: 'no-store' };
      if (ctl) opt.signal = ctl.signal;

      var p;
      try {
        p = f(url, opt);
      } catch (e) {
        finish(false, e instanceof Error ? e : new Error(errMsg(e)));
        return;
      }

      Promise.resolve(p).then(function (r) {
        if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status !== undefined ? r.status : '?'));
        if (typeof r.json === 'function') return r.json();
        if (typeof r.text === 'function') {
          return r.text().then(function (txt) { return JSON.parse(txt); });
        }
        throw new Error('响应缺少 json()/text()');
      }).then(function (json) {
        finish(true, json);
      }, function (err) {
        if (err && err.name === 'AbortError') finish(false, new Error('请求超时（' + (TIMEOUT_MS / 1000) + 's）'));
        else finish(false, err instanceof Error ? err : new Error(errMsg(err)));
      });
    });
  }

  /* ============================================================
   * 3. 响应解析 → 统一 items
   * ============================================================ */
  function batchUrl() {
    var lat = [], lon = [], i;
    for (i = 0; i < CITIES.length; i++) {
      lat.push(CITIES[i].lat);
      lon.push(CITIES[i].lon);
    }
    return API_URL + '?latitude=' + lat.join(',') + '&longitude=' + lon.join(',') +
      '&current=' + CURRENT_FIELDS + '&timezone=UTC&wind_speed_unit=kmh';
  }
  function cityUrl(c) {
    return API_URL + '?latitude=' + c.lat + '&longitude=' + c.lon +
      '&current=' + CURRENT_FIELDS + '&timezone=UTC&wind_speed_unit=kmh';
  }

  /* 单个地点的响应 → item；temperature_2m 必须存在，其余缺省记 null（不编造） */
  function itemFrom(city, resp) {
    if (!resp || typeof resp !== 'object') return null;
    var cur = resp.current;
    if (!cur || typeof cur !== 'object') return null;
    var temp = num(cur.temperature_2m);
    if (temp === null) return null;
    var code = num(cur.weather_code);
    var wind = num(cur.wind_speed_10m);
    var deg = num(cur.wind_direction_10m);
    var press = num(cur.surface_pressure);
    return {
      name: city.name,
      lat: city.lat,
      lon: city.lon,
      temp: round1(temp),
      code: code === null ? null : Math.round(code),
      desc: descOf(code),
      wind: wind === null ? null : round1(wind),
      windDeg: deg === null ? null : round1(deg),
      press: press === null ? null : round1(press),
      time: isoUtc(cur.time)
    };
  }

  function dataOf(items) {
    return { updated: new Date(), source: 'Open-Meteo', items: items };
  }

  /* 批量响应按「最近坐标」配对到城市（Open-Meteo 会把坐标吸附到 ~0.05° 网格） */
  function nearestResponse(city, list) {
    var best = null, bestD = 1e9, i;
    for (i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || typeof r !== 'object') continue;
      var rlat = num(r.latitude), rlon = num(r.longitude);
      if (rlat === null || rlon === null) continue;
      /* 本组城市都不跨日界线，直接线性距离即可 */
      var d = Math.abs(rlat - city.lat) + Math.abs(rlon - city.lon);
      if (d < bestD) { bestD = d; best = r; }
    }
    return bestD <= 2 ? best : null;
  }

  function parseBatch(json) {
    var list = json;
    if (!list || typeof list.length !== 'number' || list.length !== CITIES.length) return null;
    var withCoords = true, i, r;
    for (i = 0; i < list.length; i++) {
      r = list[i];
      if (!r || num(r.latitude) === null || num(r.longitude) === null) { withCoords = false; break; }
    }
    var items = [];
    for (i = 0; i < CITIES.length; i++) {
      var resp = withCoords ? nearestResponse(CITIES[i], list) : list[i];
      var item = itemFrom(CITIES[i], resp);
      if (!item) return null;
      items.push(item);
    }
    return dataOf(items);
  }

  function parseSingles(list) {
    var items = [], i;
    for (i = 0; i < CITIES.length; i++) {
      var item = itemFrom(CITIES[i], list && list[i]);
      if (!item) throw new Error('单点响应缺少「' + CITIES[i].name + '」的有效实况字段（temperature_2m）');
      items.push(item);
    }
    return dataOf(items);
  }

  /* ============================================================
   * 4. 取数：批量 → 单点降级；模块内 8 分钟缓存
   * ============================================================ */
  function requestBatch() {
    return fetchJSON(batchUrl()).then(function (json) {
      var data = parseBatch(json);
      if (!data) throw new Error('批量响应结构不符（预期 ' + CITIES.length + ' 个带 current 的对象）');
      return data;
    });
  }

  function requestSingles() {
    var ps = [], i;
    for (i = 0; i < CITIES.length; i++) ps.push(fetchJSON(cityUrl(CITIES[i])));
    return Promise.all(ps).then(function (list) {
      return parseSingles(list);
    });
  }

  function requestAll() {
    return requestBatch().then(null, function (batchErr) {
      return requestSingles().then(null, function (singleErr) {
        throw new Error('Open-Meteo 取数失败：批量请求（' + errMsg(batchErr) +
          '）；单点请求（' + errMsg(singleErr) + '）');
      });
    });
  }

  var cache = { at: 0, data: null };
  var pending = null;

  /**
   * fetchAll(force) → Promise<{updated:Date, source:'Open-Meteo', items:[...]}>
   *   items: {name,lat,lon,temp,code,desc,wind,windDeg,press,time}
   * force=true 时跳过 8 分钟缓存（供“刷新”用）；失败 reject(new Error(原因))。
   */
  function fetchAll(force) {
    if (!force && cache.data && (Date.now() - cache.at) < CACHE_MS) {
      return Promise.resolve(cache.data);
    }
    if (pending) return pending;
    pending = requestAll().then(function (data) {
      cache.data = data;
      cache.at = Date.now();
      pending = null;
      return data;
    }, function (err) {
      pending = null;
      throw err;
    });
    return pending;
  }

  function clearCache() {
    cache.data = null;
    cache.at = 0;
    pending = null;
  }

  /* ============================================================
   * 5. 标记图层
   * ============================================================ */
  function buildLayer(opts) {
    opts = opts || {};

    var THREE = opts.THREE || global.THREE;
    var H = opts.H || global.H;
    if (!THREE) throw new Error('GLOBE_LIVE.buildLayer：缺少 THREE');
    if (!H || typeof H.makeLabel !== 'function' || typeof H.setLabelText !== 'function') {
      throw new Error('GLOBE_LIVE.buildLayer：缺少 H.makeLabel / H.setLabelText');
    }
    var group = opts.group;
    if (!group || typeof group.add !== 'function') {
      throw new Error('GLOBE_LIVE.buildLayer：缺少 group（THREE.Group）');
    }
    var toVec = opts.toVec;
    if (typeof toVec !== 'function') {
      throw new Error('GLOBE_LIVE.buildLayer：缺少 toVec(lat, lon, k)');
    }

    /* R 允许省略：取 toVec(0,0,1) 的模长兜底 */
    var R = num(opts.R);
    if (R === null || R <= 0) {
      try { R = toVec(0, 0, 1).length(); } catch (e) { R = 0; }
      if (!isFinite(R) || R <= 0) R = 1;
    }

    /* 尺寸常量（球半径的比例）
     * 标签放大到 R*0.058（手机 390 宽也能读清）：文字高度约 3.3° 弧长。
     * 防重叠：北向抬起做 3 层错位（i%3）+ 每城半径再错层；本组 8 城纬度/经度都
     * 拉开（同纬度带城市经度相距 > 8°，标签宽约 0.15R ≈ 8.8°），不会严重遮挡。 */
    var LABEL_SIZE = 40;                       /* canvas 字号：配合 R*0.058 的精灵高度 */
    var LABEL_SCALE = R * 0.058;
    var LABEL_K = 1.02;                        /* 标签在球面外 2% */
    var LABEL_STAGGER = 0.0022;                /* 每城再沿半径抬升一点，避免精灵共面重叠 */
    var LABEL_NORTH = R * 0.045;               /* 标签沿局部北向抬起，不压住风矢/城市点 */
    var LABEL_TIER = R * 0.013;                /* 北向三层错位（i%3），错开相邻城市标签 */
    var ARROW_K = 1.008;                       /* 风矢略高于球面，避免与地表 z-fighting */
    var ARROW_LEN = R * 0.04;                  /* 风矢长度（加长，更醒目） */

    var disposed = false;
    var lastData = null;

    var root = new THREE.Group();
    root.name = (typeof opts.name === 'string' && opts.name) ? opts.name : 'GLOBE_LIVE_MARKERS';
    group.add(root);

    /* ---------------- 局部工具 ---------------- */
    /* 球面局部正交标架：up=半径方向，east 指向经度增大方向，north 指向纬度增大方向。
     * 用 toVec 中心差分（经/纬各 ±0.5°）得到精确切线，不假设 toVec 内部的 XYZ 约定；
     * 中心差分的截断误差是 O(d²)，不会像单侧差分那样让切线偏转 d/2。 */
    function tangentFrame(lat, lon) {
      var p = toVec(lat, lon, 1);
      var up = p.clone().normalize();
      var pe = toVec(lat, lon + 0.5, 1);
      var pw = toVec(lat, lon - 0.5, 1);
      var pn = toVec(lat + 0.5, lon, 1);
      var ps = toVec(lat - 0.5, lon, 1);
      var east = new THREE.Vector3().subVectors(pe, pw).normalize();
      var north = new THREE.Vector3().subVectors(pn, ps).normalize();
      /* 数值误差下去掉朝法线的分量，保证严格切向 */
      north.addScaledVector(up, -north.dot(up));
      north.addScaledVector(east, -north.dot(east));
      if (north.length() < 1e-6) north.copy(up);
      else north.normalize();
      return { up: up, east: east, north: north };
    }

    /* 风矢几何（8 城共用一份）：本地坐标 X=风的去向、Y=球面法线、Z=切向垂直方向。
     * 平面 y=0 即切平面，因此箭头天然贴球面。 */
    function buildArrowGeometry(len) {
      var x0 = len * 0.16;        /* 尾巴留一点空隙，别戳在城市点上 */
      var x1 = len;               /* 箭头尖 = 风的去向 */
      var half = len * 0.06;      /* 杆半宽：细长但比原来加粗一点 */
      var hw = len * 0.24;        /* 箭头半宽 */
      var hl = len * 0.34;        /* 箭头长 */
      var v = [
        x0, 0, -half, x0, 0, half, x1, 0, half,
        x0, 0, -half, x1, 0, half, x1, 0, -half,
        x1, 0, 0, x1 - hl, 0, hw, x1 - hl, 0, -hw
      ];
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      return geo;
    }

    /* 发光底晕贴图（一层柔光径向渐变；无 document 时跳过） */
    function makeGlowTexture() {
      if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return null;
      var c = document.createElement('canvas');
      c.width = c.height = 128;
      var g = (typeof c.getContext === 'function') ? c.getContext('2d') : null;
      if (!g || typeof g.createRadialGradient !== 'function') return null;
      var rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      rg.addColorStop(0, 'rgba(255,255,255,0.85)');
      rg.addColorStop(0.45, 'rgba(255,255,255,0.28)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, 128, 128);
      var tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      return tex;
    }

    /* 气温 → 颜色（冷蓝 → 暖橙） */
    function tempHex(t) {
      if (!isNum(t)) return 0x9fb8d8;
      if (t <= 0) return 0x7fc4ff;
      if (t <= 10) return 0xa9d6ff;
      if (t <= 18) return 0xdcecff;
      if (t <= 26) return 0xffe0a0;
      if (t <= 32) return 0xffb066;
      return 0xff7a5c;
    }
    /* 风速 → 颜色（越强越暖；整体调亮，深色地球上更清楚） */
    function windHex(w) {
      if (!isNum(w)) return 0x9fe8ff;
      if (w < 20) return 0x9fe8ff;
      if (w < 40) return 0xffe08a;
      return 0xffa06e;
    }
    function hexCss(hex) {
      var s = (hex >>> 0).toString(16);
      while (s.length < 6) s = '0' + s;
      return '#' + s;
    }

    /* 由气象风向求切向单位向量（风的去向），见文件头说明 */
    function windDirVec(frame, windDeg) {
      var th = (num(windDeg) + 180) * DEG;
      var c = Math.cos(th), s = Math.sin(th);
      var dir = new THREE.Vector3(
        frame.north.x * c + frame.east.x * s,
        frame.north.y * c + frame.east.y * s,
        frame.north.z * c + frame.east.z * s
      );
      dir.addScaledVector(frame.up, -dir.dot(frame.up));   /* 再正交化一次，保证严格切向 */
      dir.normalize();
      return dir;
    }

    /* 用正交标架旋转箭头：X=去向，Y=法线，Z=X×Y（右手系） */
    function orientArrow(m, windDeg) {
      var dir = windDirVec(m.frame, windDeg);
      var z = new THREE.Vector3().crossVectors(dir, m.frame.up).normalize();
      m.basis.makeBasis(dir, m.frame.up, z);
      m.arrow.quaternion.setFromRotationMatrix(m.basis);
    }

    var arrowGeo = buildArrowGeometry(ARROW_LEN);
    var glowTex = makeGlowTexture();
    var markers = [];

    /* ---------------- 创建 8 个标记 ---------------- */
    var i;
    for (i = 0; i < CITIES.length; i++) {
      var city = CITIES[i];
      var frame = tangentFrame(city.lat, city.lon);

      /* ① 文字精灵：城市名 + 气温，球面外 k=1.02 + 每城径向错层，沿局部北向抬头（3 层错位防遮挡） */
      var northLift = LABEL_NORTH + (i % 3) * LABEL_TIER;
      var labelPos = toVec(city.lat, city.lon, LABEL_K + i * LABEL_STAGGER).clone();
      labelPos.addScaledVector(frame.north, northLift);
      var label = H.makeLabel(city.name, {
        color: '#dbe6ff', size: LABEL_SIZE, scale: LABEL_SCALE
      });
      label.position.copy(labelPos);
      root.add(label);

      /* ③ 发光底晕（一层柔光精灵，位于文字精灵之后一点，形成描边/光感） */
      var glowMat = null, glow = null;
      if (glowTex) {
        glowMat = new THREE.SpriteMaterial({
          map: glowTex, transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, opacity: 0.8
        });
        glow = new THREE.Sprite(glowMat);
        glow.scale.set(R * 0.16, R * 0.085, 1);
        var glowPos = toVec(city.lat, city.lon, LABEL_K - 0.004 + i * LABEL_STAGGER).clone();
        glowPos.addScaledVector(frame.north, northLift);
        glow.position.copy(glowPos);
        root.add(glow);
      }

      /* ② 风向短箭头：细长 Mesh，贴球面切向，颜色偏亮 */
      var arrowMat = new THREE.MeshBasicMaterial({
        color: 0x9fe8ff, transparent: true, opacity: 0.95,
        side: THREE.DoubleSide, depthWrite: false
      });
      var arrow = new THREE.Mesh(arrowGeo, arrowMat);
      arrow.position.copy(toVec(city.lat, city.lon, ARROW_K));
      arrow.visible = false;    /* 取到数据前不显示风矢，避免误导 */
      root.add(arrow);

      markers.push({
        city: city, index: i, frame: frame,
        label: label, glow: glow, glowMat: glowMat,
        arrow: arrow, arrowMat: arrowMat,
        basis: new THREE.Matrix4(),
        lastText: null, lastColorHex: null, item: null
      });
    }

    /* ---------------- 更新一个标记 ---------------- */
    function setMarker(m, item) {
      var hasTemp = !!(item && isNum(item.temp));
      var text, hex;
      if (hasTemp) {
        text = m.city.name + ' ' + Math.round(item.temp) + '℃';
        hex = tempHex(item.temp);
      } else {
        text = m.city.name + ' —';
        hex = 0x9fb8d8;
      }
      /* 只改写同一 Sprite 的文字贴图（H.setLabelText 内部会释放旧贴图），不新建 Sprite */
      if (text !== m.lastText || hex !== m.lastColorHex) {
        H.setLabelText(m.label, text, {
          color: hexCss(hex), size: LABEL_SIZE, scale: LABEL_SCALE
        });
        m.lastText = text;
        m.lastColorHex = hex;
      }
      if (m.glowMat && m.glowMat.color && m.glowMat.color.setHex) m.glowMat.color.setHex(hex);

      var hasWind = !!(item && isNum(item.windDeg));
      m.arrow.visible = hasWind;
      if (hasWind) {
        orientArrow(m, item.windDeg);
        if (m.arrowMat.color && m.arrowMat.color.setHex) m.arrowMat.color.setHex(windHex(item.wind));
      }
      m.item = item || null;
    }

    /* ---------------- 返回 API ---------------- */
    var api = {
      /** 用 fetchAll() 的结果刷新文字/颜色/风矢方向 */
      update: function (data) {
        if (disposed) return api;
        var items = data && data.items;
        if (!items || typeof items.length !== 'number') {
          throw new Error('GLOBE_LIVE.update：需要 {items:[...]}（先调用 GLOBE_LIVE.fetchAll()）');
        }
        var byName = {}, j;
        for (j = 0; j < items.length; j++) {
          var it = items[j];
          if (it && it.name && !byName[it.name]) byName[it.name] = it;
        }
        for (j = 0; j < markers.length; j++) {
          var m = markers[j];
          var item = byName[m.city.name] || items[m.index] || null;   /* 名称对不上时按顺序兜底 */
          setMarker(m, item);
        }
        lastData = data;
        return api;
      },
      /** 整组显隐（true 显示 / false 隐藏） */
      setVisible: function (v) {
        if (disposed) return api;
        root.visible = !!v;
        return api;
      },
      /** 释放几何/材质/贴图，并从 group 移除 */
      dispose: function () {
        if (disposed) return;
        disposed = true;
        if (group && typeof group.remove === 'function') group.remove(root);
        for (var k = 0; k < markers.length; k++) {
          var m = markers[k];
          if (m.label && m.label.material) {
            var lm = m.label.material;
            if (lm.map && typeof lm.map.dispose === 'function') lm.map.dispose();
            if (typeof lm.dispose === 'function') lm.dispose();
          }
          /* 底晕材质共享同一张 glowTex，贴图在循环外单独释放 */
          if (m.glowMat && typeof m.glowMat.dispose === 'function') m.glowMat.dispose();
          if (m.arrowMat && typeof m.arrowMat.dispose === 'function') m.arrowMat.dispose();
        }
        markers.length = 0;
        if (arrowGeo && typeof arrowGeo.dispose === 'function') arrowGeo.dispose();
        if (glowTex && typeof glowTex.dispose === 'function') glowTex.dispose();
        lastData = null;
      },
      group: root,
      count: markers.length,
      data: function () { return lastData; }
    };
    return api;
  }

  /* ============================================================
   * 6. 导出（加载时只定义 window.GLOBE_LIVE，不碰 THREE/H/DOM）
   * ============================================================ */
  global.GLOBE_LIVE = {
    CITIES: CITIES,
    fetchAll: fetchAll,
    buildLayer: buildLayer,
    descOf: descOf,
    clearCache: clearCache
  };
})(typeof window !== 'undefined' ? window : this);
