/* ============================================================
 * m7-cyclone.js — 「锋面气旋」俯视演示动画（Canvas 2D）
 *
 * 视图：东亚天气图俯视示意。低压中心 L 随阶段向东北移动，
 *       等压线、北半球逆时针辐合风、冷锋/暖锋/准静止锋、
 *       暖区与冷区、降水区、A/B/C 三站过境天气。
 *
 * 数据：window.CYCLONE_STAGES（本文件导出，4 个阶段）
 *       window.GEO / window.GEO_WORLD（可选，用真实底图；缺失则画经纬网兜底）
 *
 * 约定：c2d 已按 devicePixelRatio 缩放，坐标一律用 CSS 像素；
 *       w < 820 视为手机（字号 ×0.85，下限 10px）；
 *       每帧重画、不依赖上一帧状态（draw 幂等）。
 * ============================================================ */
(function (global) {
  'use strict';

  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;
  var FONT = '"PingFang SC","Microsoft YaHei",sans-serif';

  /* 底图经纬范围（东亚） */
  var LON_MIN = 100, LON_MAX = 140, LAT_MIN = 18, LAT_MAX = 50;

  /* ---------- 配色（与项目契约 C 表一致） ---------- */
  var C = {
    text: '#dbe6ff',
    dim: 'rgba(219,230,255,0.60)',
    faint: 'rgba(219,230,255,0.36)',
    line: 'rgba(150,180,230,0.22)',
    panel: 'rgba(16,24,42,0.88)',
    cold: '#4ea1ff',
    warm: '#ff8a3d',
    warmLine: '#ff7a6b',
    station: '#b98cff',
    rain: '#8fc8ff',
    cloud: '#cfd8ea',
    ok: '#37d39b',
    warn: '#ffb454',
    isobar: 'rgba(160,192,240,0.55)'
  };

  /* ---------- 各阶段几何参数 ---------- */
  /* 低压中心（经度, 纬度）：初生偏西 → 消亡偏东 */
  var LC = [[117.5, 33.0], [119.5, 34.2], [122.0, 35.2], [124.5, 36.4]];
  /* 中心气压 hPa */
  var LPRESS = [1002, 998, 992, 1000];
  /* 等压线条数 / 等压线间隔 */
  var ISOBAR_N = [4, 5, 6, 4];
  var HPA_STEP = [4, 4, 4, 5];

  /* 冷锋相对 L 的经纬偏移：发展 / 成熟 / 消亡 */
  var COLD_REL = [
    [[0, 0], [-0.8, -1.0], [-1.8, -2.6], [-3.0, -4.6], [-4.2, -6.8]],
    [[0, 0], [-0.6, -1.2], [-1.4, -3.0], [-2.2, -5.2], [-3.0, -7.6]],
    [[0, 0], [-0.3, -1.3], [-0.7, -3.0], [-1.1, -5.2], [-1.5, -7.6]]
  ];
  /* 暖锋相对 L 的经纬偏移：发展 / 成熟 / 消亡 */
  var WARM_REL = [
    [[0, 0], [1.4, -0.6], [3.0, -1.2], [4.6, -1.8], [6.2, -2.8]],
    [[0, 0], [1.2, -0.8], [2.6, -1.6], [4.0, -2.6], [5.4, -3.8]],
    [[0, 0], [1.0, -0.9], [2.2, -1.8], [3.4, -2.8], [4.6, -4.0]]
  ];
  /* 初生阶段：准静止锋（带一个波动） */
  var STAT_LINE = [
    [103.5, 31.2], [106.5, 31.1], [109.5, 31.2], [112.4, 31.2],
    [114.6, 31.3], [116.4, 32.3], [118.4, 31.3], [120.6, 31.1],
    [122.8, 30.8], [124.8, 30.4]
  ];

  /* 观测站（固定坐标） */
  var STATIONS = {
    A: { lon: 122.5, lat: 29.5, name: '暖区' },
    B: { lon: 120.5, lat: 32.0, name: '锋面附近' },
    C: { lon: 116.0, lat: 36.0, name: '冷气团' }
  };
  var STATION_KEYS = ['A', 'B', 'C'];

  /* 图例项 */
  var LEGEND_ITEMS = [
    ['L', '低压中心'],
    ['isobar', '等压线'],
    ['wind', '风'],
    ['cold', '冷锋'],
    ['warm', '暖锋'],
    ['rain', '降水区'],
    ['station', '观测站']
  ];

  /* ---------- 通用小工具 ---------- */
  function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  function lerp(a, b, f) {
    return a + (b - a) * f;
  }
  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function rgba(hex, a) {
    if (!hex || hex.charAt(0) !== '#') return 'rgba(150,180,230,' + a + ')';
    var r = parseInt(hex.substr(1, 2), 16);
    var g = parseInt(hex.substr(3, 2), 16);
    var b = parseInt(hex.substr(5, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* ---------- 文字：字体 / 测量 / 自适应 ---------- */
  function setFont(g, px, bold) {
    g.font = (bold ? 'bold ' : '') + px.toFixed(1) + 'px ' + FONT;
  }
  function measure(g, str, px, bold) {
    setFont(g, px, bold);
    var m = g.measureText(str);
    return m && m.width ? m.width : px * str.length * 0.6;
  }
  function drawText(g, str, x, y, opt) {
    opt = opt || {};
    setFont(g, opt.px || 11, !!opt.bold);
    g.fillStyle = opt.color || C.text;
    g.textAlign = opt.align || 'left';
    g.textBaseline = opt.baseline || 'middle';
    g.fillText(str, x, y);
  }
  /* 缩字号直到放下；仍放不下则截断加省略号 */
  function fitText(g, str, maxW, px, minPx, bold) {
    if (maxW <= 0) return '';
    var p = px;
    if (measure(g, str, p, bold) <= maxW) return str;
    while (p > minPx && measure(g, str, p, bold) > maxW) p -= 0.5;
    if (measure(g, str, p, bold) <= maxW) return str;
    var s = str, ell = '…';
    while (s.length > 1 && measure(g, s + ell, p, bold) > maxW) s = s.slice(0, -1);
    return s + ell;
  }
  function wrapLines(g, str, maxW, px, bold) {
    var lines = [], cur = '', i;
    for (i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (cur && measure(g, cur + ch, px, bold) > maxW) {
        lines.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  /* 取前 n 行，最后一行超长时加省略号 */
  function takeLines(g, str, maxW, px, bold, n) {
    var lines = wrapLines(g, str, maxW, px, bold);
    if (lines.length <= n) return lines;
    var out = lines.slice(0, n);
    var last = out[n - 1];
    while (last.length > 1 && measure(g, last + '…', px, bold) > maxW) last = last.slice(0, -1);
    out[n - 1] = last + '…';
    return out;
  }

  /* ---------- 面板 / 圆角矩形 ---------- */
  function roundRect(g, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y);
    g.quadraticCurveTo(x + w, y, x + w, y + rr);
    g.lineTo(x + w, y + h - rr);
    g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    g.lineTo(x + rr, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - rr);
    g.lineTo(x, y + rr);
    g.quadraticCurveTo(x, y, x + rr, y);
    g.closePath();
  }
  function panel(g, x, y, w, h, r, alpha) {
    g.save();
    roundRect(g, x, y, w, h, r);
    g.fillStyle = 'rgba(16,24,42,' + (alpha == null ? 0.88 : alpha) + ')';
    g.fill();
    g.strokeStyle = 'rgba(150,180,230,0.26)';
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }

  /* 两个矩形是否会压在一起（用于标签避让） */
  function rectsHit(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }
  /* 把矩形放进已占用列表；若与已有矩形相交返回 false */
  function occupy(list, r) {
    for (var i = 0; i < list.length; i++) {
      if (rectsHit(list[i], r)) return false;
    }
    list.push(r);
    return true;
  }

  /* ---------- 曲线 / 折线 ---------- */
  function catmullPts(pts, seg) {
    if (!pts || !pts.length) return [];
    if (pts.length < 3) return pts.slice();
    var out = [], i, j, p0, p1, p2, p3, t, tt, ttt;
    for (i = 0; i < pts.length - 1; i++) {
      p0 = pts[i > 0 ? i - 1 : 0];
      p1 = pts[i];
      p2 = pts[i + 1];
      p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1];
      for (j = 0; j < seg; j++) {
        t = j / seg;
        tt = t * t;
        ttt = tt * t;
        out.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * ttt),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * ttt)
        });
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function polyPath(g, pts, close) {
    if (!pts || !pts.length) return;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    if (close) g.closePath();
  }
  /* 把折线沿法线偏移：sideSign = +1 取切向量逆时针 90°（俯视图中为前进方向左侧） */
  function offsetPolyline(pts, d, sideSign) {
    var out = [], i, a, b, tx, ty, l;
    for (i = 0; i < pts.length; i++) {
      a = pts[i > 0 ? i - 1 : 0];
      b = pts[i < pts.length - 1 ? i + 1 : pts.length - 1];
      tx = b.x - a.x;
      ty = b.y - a.y;
      l = Math.sqrt(tx * tx + ty * ty);
      if (l < 0.0001) { l = 1; tx = 0; ty = 0; }
      out.push({
        x: pts[i].x + (ty / l) * d * sideSign,
        y: pts[i].y + (-tx / l) * d * sideSign
      });
    }
    return out;
  }
  function pointsBBox(pts) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, i;
    for (i = 0; i < pts.length; i++) {
      if (pts[i].x < b.x0) b.x0 = pts[i].x;
      if (pts[i].y < b.y0) b.y0 = pts[i].y;
      if (pts[i].x > b.x1) b.x1 = pts[i].x;
      if (pts[i].y > b.y1) b.y1 = pts[i].y;
    }
    return b;
  }
  /* 在裁剪到多边形内部的前提下画斜线阴影 */
  function hatchPoly(g, poly, step, color, alpha) {
    if (!poly || poly.length < 3) return;
    var b = pointsBBox(poly);
    if (!isFinite(b.x0) || !isFinite(b.y0)) return;
    g.save();
    polyPath(g, poly, true);
    g.clip();
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.globalAlpha = alpha;
    var hgt = b.y1 - b.y0, x;
    for (x = b.x0 - hgt; x <= b.x1; x += step) {
      g.beginPath();
      g.moveTo(x, b.y1 + 2);
      g.lineTo(x + hgt + 2, b.y0 - 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();
  }
  /* 沿折线等距回调：cb(x, y, tx, ty)（tx,ty 为单位切向） */
  function eachAlong(pts, step, cb) {
    if (!pts || pts.length < 2) return;
    var acc = 0, next = step * 0.55, i, a, b, d;
    for (i = 1; i < pts.length; i++) {
      a = pts[i - 1];
      b = pts[i];
      d = dist(a, b);
      if (d < 0.001) continue;
      while (acc + d >= next) {
        var f = (next - acc) / d;
        cb(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, (b.x - a.x) / d, (b.y - a.y) / d);
        next += step;
      }
      acc += d;
    }
  }
  /* 箭头头部 */
  function arrowHead(g, x, y, ux, uy, size, color) {
    var px = -uy, py = ux;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - ux * size + px * size * 0.55, y - uy * size + py * size * 0.55);
    g.lineTo(x - ux * size - px * size * 0.55, y - uy * size - py * size * 0.55);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }

  /* ---------- 底图投影与绘制 ---------- */
  /* 无 GEO 时的等经纬兜底投影（与 geo.js 的 regionProjector 同一思路） */
  function makeProjector(w, h) {
    var kx = Math.cos(((LAT_MIN + LAT_MAX) / 2) * DEG);
    var ww = (LON_MAX - LON_MIN) * kx;
    var wh = LAT_MAX - LAT_MIN;
    var s = Math.min(w / ww, h / wh);
    var ox = (w - ww * s) / 2;
    var oy = (h - wh * s) / 2;
    return {
      scale: s,
      project: function (lon, lat) {
        return { x: ox + (lon - LON_MIN) * kx * s, y: oy + (LAT_MAX - lat) * s };
      }
    };
  }
  /* 兜底经纬网 */
  function drawGrid(g, w, h, proj) {
    var lon, lat, p, p2;
    g.save();
    g.strokeStyle = 'rgba(150,180,230,0.13)';
    g.lineWidth = 1;
    for (lon = LON_MIN; lon <= LON_MAX; lon += 5) {
      p = proj.project(lon, LAT_MIN);
      p2 = proj.project(lon, LAT_MAX);
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p2.x, p2.y);
      g.stroke();
    }
    for (lat = LAT_MIN; lat <= LAT_MAX; lat += 5) {
      p = proj.project(LON_MIN, lat);
      p2 = proj.project(LON_MAX, lat);
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p2.x, p2.y);
      g.stroke();
    }
    /* 海陆轮廓缺失时用一层斜向暗纹表示海洋，避免纯色发闷 */
    g.globalAlpha = 0.10;
    g.strokeStyle = 'rgba(120,170,240,0.5)';
    for (var x = -h; x < w + h; x += 14) {
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x + h, 0);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();
  }
  /* 有真实底图时叠一层很淡的经纬网，让海面不至于发闷 */
  function drawGraticule(g, w, h, proj) {
    var lon, lat, p, p2, i;
    g.save();
    g.lineWidth = 1;
    for (i = 0; i < 2; i++) {
      g.strokeStyle = i === 0 ? 'rgba(150,180,230,0.07)' : 'rgba(150,180,230,0.13)';
      var step = i === 0 ? 5 : 10;
      for (lon = LON_MIN; lon <= LON_MAX; lon += step) {
        p = proj.project(lon, LAT_MIN);
        p2 = proj.project(lon, LAT_MAX);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p2.x, p2.y);
        g.stroke();
      }
      for (lat = LAT_MIN; lat <= LAT_MAX; lat += step) {
        p = proj.project(LON_MIN, lat);
        p2 = proj.project(LON_MAX, lat);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p2.x, p2.y);
        g.stroke();
      }
    }
    g.restore();
  }
  /* 画底图，返回投影器 */
  function paintBase(g, w, h) {
    g.save();
    g.fillStyle = '#081120';
    g.fillRect(0, 0, w, h);
    var proj = null;
    var geo = global.GEO;
    var world = global.GEO_WORLD;
    var hasGeo = !!(geo && typeof geo.drawWorld === 'function' && world && world.countries && world.countries.length);
    if (hasGeo) {
      try {
        proj = geo.drawWorld(g, w, h, {
          lonMin: LON_MIN, lonMax: LON_MAX, latMin: LAT_MIN, latMax: LAT_MAX,
          ocean: '#081120', land: '#17304f',
          border: 'rgba(160,196,246,0.42)', borderWidth: 0.85, pad: 0
        });
      } catch (err) {
        proj = null;
      }
      if (!proj || typeof proj.project !== 'function') proj = null;
    }
    if (!proj) {
      proj = makeProjector(w, h);
      drawGrid(g, w, h, proj);
    } else {
      drawGraticule(g, w, h, proj);
    }
    /* 图框 */
    g.strokeStyle = 'rgba(150,180,230,0.20)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    g.restore();
    return proj;
  }

  /* ---------- 阶段数据（对外导出） ---------- */
  function mkStation(tag, temp, press, wind, rain) {
    return {
      tag: tag, temp: temp, press: press, wind: wind, rain: rain,
      text: temp + '℃ · ' + press + ' hPa · ' + wind + ' · ' + rain
    };
  }

  var CYCLONE_STAGES = [
    {
      key: 'birth', number: '①', name: '初生',
      title: '初生：准静止锋出现波动',
      nameShort: '初生',
      desc: '暖湿气流沿准静止锋北上，锋线出现小波动，低压环流初步形成，气旋尚未明显加深。',
      station: {
        A: mkStation('暖区', 22, 1006, '西南风 3~4 级', '阴有小雨'),
        B: mkStation('锋面附近', 18, 1005, '偏南风 4 级', '中雨'),
        C: mkStation('冷气团', 9, 1012, '偏北风 3 级', '晴')
      }
    },
    {
      key: 'develop', number: '②', name: '发展',
      title: '发展：冷、暖锋形成并推进',
      nameShort: '发展',
      desc: '低压继续加深并东移，冷锋出现在西南侧、暖锋出现在东南侧，暖区被两锋夹持并逐步扩大。',
      station: {
        A: mkStation('暖区', 23, 1002, '西南风 4 级', '小雨'),
        B: mkStation('冷锋逼近', 16, 1004, '西北风 6 级', '阵雨'),
        C: mkStation('冷气团', 7, 1010, '偏北风 4 级', '晴')
      }
    },
    {
      key: 'mature', number: '③', name: '成熟',
      title: '成熟：气旋最强、降水最强',
      nameShort: '成熟',
      desc: '气旋发展最强，等压线最密；冷锋逼近暖区，暖湿气流被迫强烈抬升，降水达到最强。',
      station: {
        A: mkStation('暖区', 23, 996, '西南风 5 级', '阵雨'),
        B: mkStation('冷锋过境', 12, 1000, '西北风 7 级', '雷阵雨'),
        C: mkStation('冷气团', 5, 1008, '偏北风 5 级', '晴')
      }
    },
    {
      key: 'decay', number: '④', name: '消亡',
      title: '消亡：冷锋追上暖锋开始锢囚',
      nameShort: '消亡',
      desc: '冷锋追上暖锋，气旋开始锢囚并逐渐减弱东移，暖区被挤压缩小，天气逐步转好。',
      station: {
        A: mkStation('暖区（缩小）', 21, 998, '西南风 3 级', '小雨'),
        B: mkStation('冷锋已过', 11, 1002, '西北风 5 级', '小雨转晴'),
        C: mkStation('冷气团', 6, 1006, '偏北风 3 级', '晴')
      }
    }
  ];

  /* 对外导出阶段数据（页面信息卡、答题解析等共用） */
  global.CYCLONE_STAGES = CYCLONE_STAGES;

  /* ---------- 阶段几何：低压中心与锋线 ---------- */
  function buildGeometry(proj, stage, t) {
    var lc = LC[stage];
    /* L 随阶段内动画进度轻微漂移，让动画有持续感 */
    var L = { lon: lc[0] + 0.22 * (t - 0.5), lat: lc[1] + 0.12 * (t - 0.5) };
    var geo = { L: L, cold: null, warm: null, stat: null, occluded: false };
    var lonlatToPts = function (lonlat) {
      var raw = [], i;
      for (i = 0; i < lonlat.length; i++) {
        raw.push(proj.project(lonlat[i][0], lonlat[i][1]));
      }
      return catmullPts(raw, 8);
    };
    if (stage === 0) {
      geo.statLine = STAT_LINE;
      geo.stat = lonlatToPts(STAT_LINE);
    } else {
      var drift = 0.25 * t;
      var coldRel = COLD_REL[stage - 1];
      var warmRel = WARM_REL[stage - 1];
      var coldLL = [], warmLL = [], i;
      for (i = 0; i < coldRel.length; i++) {
        coldLL.push([L.lon + coldRel[i][0] + drift, L.lat + coldRel[i][1]]);
      }
      for (i = 0; i < warmRel.length; i++) {
        warmLL.push([L.lon + warmRel[i][0] + drift, L.lat + warmRel[i][1]]);
      }
      geo.coldLL = coldLL;
      geo.warmLL = warmLL;
      geo.cold = lonlatToPts(coldLL);
      geo.warm = lonlatToPts(warmLL);
      geo.occluded = stage === 3;
    }
    geo.corners = {
      nw: proj.project(LON_MIN, LAT_MAX),
      ne: proj.project(LON_MAX, LAT_MAX),
      sw: proj.project(LON_MIN, LAT_MIN),
      se: proj.project(LON_MAX, LAT_MIN)
    };
    geo.center = proj.project(L.lon, L.lat);
    return geo;
  }

  /* ---------- 暖区 / 冷区填充 ---------- */
  function drawFills(G) {
    var g = G.g, geo = G.geo, p;
    if (G.stage === 0 || !geo.cold || !geo.warm) return;
    /* 暖区：两锋之间的楔形（L → 暖锋 → 暖锋端 → 冷锋端 → 冷锋回 L） */
    var warmPoly = geo.warm.concat([geo.cold[geo.cold.length - 1]]).concat(geo.cold.slice().reverse());
    g.save();
    polyPath(g, warmPoly, true);
    p = g.createLinearGradient(geo.center.x, geo.center.y - 60, geo.center.x + 40, geo.corners.se.y);
    if (p && p.addColorStop) {
      p.addColorStop(0, rgba(C.warm, 0.085 + 0.008 * G.stage));
      p.addColorStop(1, rgba(C.warm, 0.115 + 0.010 * G.stage));
      g.fillStyle = p;
    } else {
      g.fillStyle = rgba(C.warm, 0.11);
    }
    g.fill();
    /* 冷区：锋面以西北的冷气团一侧 */
    var coldPoly = [geo.corners.nw, geo.corners.ne]
      .concat(geo.warm.slice().reverse())
      .concat(geo.cold)
      .concat([geo.corners.sw]);
    polyPath(g, coldPoly, true);
    g.fillStyle = rgba(C.cold, 0.065 + 0.008 * G.stage);
    g.fill();
    g.restore();
  }

  /* ---------- 降水区斜线 ---------- */
  function drawPrecip(G) {
    var g = G.g, geo = G.geo;
    if (G.show.rain === false) return;
    var inten = [0.35, 0.60, 1.00, 0.55][G.stage];
    var base = Math.min(G.w, G.mapH);
    var d0 = Math.max(5, base * 0.014);
    var d1 = d0 + (G.mobile ? 12 : 20) * (0.6 + 0.6 * inten);
    var band, i;
    g.save();
    if (G.stage === 0) {
      /* 准静止锋两侧：北侧冷区降水带 */
      band = offsetPolyline(geo.stat, d0, 1).concat(offsetPolyline(geo.stat, d1, 1).reverse());
      hatchPoly(g, band, 7, rgba(C.rain, 1), 0.14 + 0.18 * inten);
      /* 锋面沿线少量雨滴点 */
      eachAlong(geo.stat, 26, function (x, y) {
        g.beginPath();
        g.moveTo(x, y + 4);
        g.lineTo(x - 1.5, y + 10);
        g.strokeStyle = rgba(C.rain, 0.5);
        g.lineWidth = 1.2;
        g.stroke();
      });
    } else {
      /* 冷锋后（冷气团一侧） */
      band = offsetPolyline(geo.cold, -d0, 1).concat(offsetPolyline(geo.cold, -d1, 1).reverse());
      hatchPoly(g, band, 7, rgba(C.rain, 1), 0.15 + 0.22 * inten);
      /* 暖锋前（冷气团一侧） */
      band = offsetPolyline(geo.warm, d0, 1).concat(offsetPolyline(geo.warm, d1, 1).reverse());
      hatchPoly(g, band, 7, rgba(C.rain, 1), 0.12 + 0.20 * inten);
      /* 锋线附近雨滴（越强越密） */
      var step = inten > 0.8 ? 18 : 26;
      var drip = function (x, y, tx, ty) {
        g.beginPath();
        g.moveTo(x, y + 4);
        g.lineTo(x - 1.6, y + 10);
        g.strokeStyle = rgba(C.rain, 0.45 * inten + 0.15);
        g.lineWidth = 1.2;
        g.stroke();
      };
      eachAlong(geo.cold, step, drip);
      eachAlong(geo.warm, step, drip);
    }
    g.restore();
  }

  /* ---------- 等压线 ---------- */
  function drawIsobars(G) {
    var g = G.g, geo = G.geo, cx = geo.center.x, cy = geo.center.y;
    if (G.show.isobar === false) return;
    var n = ISOBAR_N[G.stage];
    var step = Math.min(G.w, G.mapH) * 0.058;
    var hpa = HPA_STEP[G.stage];
    var press = LPRESS[G.stage];
    var i, k, a, r, rx, ry, pts, face, tilt = -0.22, ca = Math.cos(tilt), sa = Math.sin(tilt);
    g.save();
    for (i = 0; i < n; i++) {
      r = step * (1.0 + i * 0.82);
      rx = r * (1.0 + 0.06 * i);
      ry = r * (0.78 + 0.03 * i);
      pts = [];
      for (k = 0; k <= 56; k++) {
        a = (k / 56) * TAU;
        var rr = 1 + 0.05 * Math.sin(3 * a + G.stage * 0.8 + i * 0.7);
        var ex = Math.cos(a) * rx * rr, ey = Math.sin(a) * ry * rr;
        pts.push({ x: cx + ex * ca - ey * sa, y: cy + ex * sa + ey * ca });
      }
      polyPath(g, pts, true);
      g.strokeStyle = i === 0 ? 'rgba(186,210,248,0.72)' : C.isobar;
      g.lineWidth = i === 0 ? 1.5 : 1.1;
      g.stroke();
      /* 数值标注：标 2~3 条 */
      if (G.show.labels !== false && (i === 0 || i === Math.floor((n - 1) / 2) || i === n - 1)) {
        var ang = -0.95;
        var lx = cx + Math.cos(ang) * rx * 1.0;
        var ly = cy + Math.sin(ang) * ry * 1.0;
        var val = press + hpa * (i + 1);
        var tx = Math.max(6, Math.min(G.w - 34, lx));
        var ty = Math.max(74, Math.min(G.mapH - 10, ly));
        g.save();
        g.fillStyle = 'rgba(6,12,24,0.85)';
        roundRect(g, tx - 3, ty - 8, 32, 16, 4);
        g.fill();
        g.strokeStyle = 'rgba(160,192,240,0.28)';
        g.lineWidth = 1;
        g.stroke();
        g.restore();
        drawText(g, String(val), tx, ty, { px: G.fs(9.5), color: 'rgba(200,220,250,0.92)' });
      }
    }
    /* 等压线示意箭头（低压中心向外的气压梯度） */
    g.restore();
  }

  /* ---------- 风场：北半球逆时针辐合 ---------- */
  function spiralArrow(g, cx, cy, r, a0, swirl, inward, lenPx, color, width) {
    var K = 12, i, ang, rad, pts = [];
    for (i = 0; i <= K; i++) {
      ang = a0 - swirl * (i / K);
      rad = r * (1 - inward * (i / K));
      pts.push({ x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad });
    }
    polyPath(g, pts, false);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
    var a = pts[K - 1], b = pts[K];
    var dx = b.x - a.x, dy = b.y - a.y;
    var l = Math.sqrt(dx * dx + dy * dy) || 1;
    arrowHead(g, b.x, b.y, dx / l, dy / l, lenPx, color);
  }
  function drawWind(G) {
    var g = G.g, geo = G.geo;
    if (G.show.wind === false) return;
    var cx = geo.center.x, cy = geo.center.y;
    var base = Math.min(G.w, G.mapH) * 0.058;
    var color = 'rgba(205,228,255,0.68)';
    var i, n, r, speed;
    /* 内圈 6 支：靠近中心更长、旋转更快 */
    n = 6;
    for (i = 0; i < n; i++) {
      r = base * 1.35;
      speed = 1.35;
      spiralArrow(g, cx, cy, r, (i / n) * TAU + G.t * speed + 0.3, 1.05, 0.26, 7, color, 1.9);
    }
    /* 外圈 7 支 */
    n = 7;
    for (i = 0; i < n; i++) {
      r = base * 2.35;
      speed = 0.65;
      spiralArrow(g, cx, cy, r, (i / n) * TAU + G.t * speed + 0.1, 0.72, 0.20, 6, color, 1.7);
    }
  }

  /* ---------- 锋线符号 ---------- */
  function frontTriangle(g, x, y, ux, uy, side, size, color) {
    /* 尖角指向 side 一侧 */
    var nx = uy * side, ny = -ux * side;
    var bx1 = x - ux * size * 0.75, by1 = y - uy * size * 0.75;
    var bx2 = x + ux * size * 0.75, by2 = y + uy * size * 0.75;
    g.beginPath();
    g.moveTo(bx1, by1);
    g.lineTo(bx2, by2);
    g.lineTo(x + nx * size * 1.25, y + ny * size * 1.25);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }
  function frontSemicircle(g, x, y, ux, uy, side, r, color) {
    /* 半圆鼓向 side 一侧 */
    var ang = Math.atan2(uy, ux);
    var a0 = ang - Math.PI;
    var a1 = ang;
    if (side < 0) { a0 = ang; a1 = ang + Math.PI; }
    g.beginPath();
    g.arc(x, y, r, a0, a1, false);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }
  function drawFrontSymbols(G, pts, kind) {
    var g = G.g;
    var step = G.mobile ? 24 : 28;
    var size = G.mobile ? 6.0 : 6.8;
    var idx = 0;
    eachAlong(pts, step, function (x, y, ux, uy) {
      if (y < 72) return;
      if (kind === 'cold') {
        frontTriangle(g, x, y, ux, uy, 1, size, rgba(C.cold, 0.95));
      } else if (kind === 'warm') {
        frontSemicircle(g, x, y, ux, uy, 1, size * 0.92, rgba(C.warmLine, 0.95));
      } else {
        /* 准静止锋：一半三角（冷，指向暖侧）、一半半圆（暖，鼓向冷侧） */
        if (idx % 2 === 0) {
          frontTriangle(g, x, y, ux, uy, -1, size, rgba(C.station, 0.92));
        } else {
          frontSemicircle(g, x, y, ux, uy, 1, size * 0.88, 'rgba(201,139,94,0.92)');
        }
      }
      idx++;
    });
  }
  function drawFrontLine(G, pts, kind) {
    var g = G.g;
    if (!pts || pts.length < 2) return;
    var col = kind === 'cold' ? C.cold : (kind === 'warm' ? C.warmLine : C.station);
    g.save();
    /* 外发光 */
    polyPath(g, pts, false);
    g.strokeStyle = rgba(col, 0.16);
    g.lineWidth = 7;
    g.stroke();
    polyPath(g, pts, false);
    g.strokeStyle = rgba(col, 0.95);
    g.lineWidth = 2.3;
    g.stroke();
    drawFrontSymbols(G, pts, kind);
    g.restore();
  }
  function drawFronts(G) {
    var g = G.g, geo = G.geo;
    if (G.stage === 0) {
      drawFrontLine(G, geo.stat, 'stationary');
    } else {
      drawFrontLine(G, geo.cold, 'cold');
      drawFrontLine(G, geo.warm, 'warm');
      if (geo.occluded) {
        /* 锢囚：L 附近一小段紫色锋线 */
        var p1 = geo.cold[0], p2 = geo.cold[Math.min(8, geo.cold.length - 1)];
        g.save();
        g.beginPath();
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.setLineDash([4, 4]);
        g.strokeStyle = rgba(C.station, 0.9);
        g.lineWidth = 2.6;
        g.stroke();
        g.setLineDash([]);
        g.restore();
      }
    }
  }
  /* 锋面文字标签：在观测站之后画，保证不被站标盖住（见 draw()） */
  function drawFrontLabels(G) {
    var g = G.g, geo = G.geo, i, p;
    function put(txt, pts, frac, off, hex) {
      /* 按「离低压中心由近到远」的比例取点，避免锋线点序方向不一致导致标签跑到 L 旁边 */
      var idx, q, dd, dmax = 0, dists = [], best = 1e9, target, dif;
      if (pts.length > 4 && geo.center) {
        for (q = 0; q < pts.length; q++) {
          dd = dist(pts[q], geo.center);
          dists.push(dd);
          if (dd > dmax) dmax = dd;
        }
        target = dmax * Math.min(0.92, frac);
        idx = 1;
        for (q = 1; q < pts.length - 1; q++) {
          dif = Math.abs(dists[q] - target);
          if (dif < best) { best = dif; idx = q; }
        }
      } else {
        idx = Math.max(1, Math.min(pts.length - 2, Math.round(frac * (pts.length - 1))));
      }
      var a = pts[idx - 1], b = pts[idx + 1] || pts[idx];
      var dx = b.x - a.x, dy = b.y - a.y;
      var l = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dy / l, ny = -dx / l;
      var px = G.fs(11);
      var tw = measure(g, txt, px, true);
      var x = Math.max(10, Math.min(G.w - tw - 12, pts[idx].x + nx * off));
      var y = Math.max(76, Math.min(G.mapH - 12, pts[idx].y + ny * off));
      /* 与站标/其它锋面标签避让：不行就向下平移 */
      var k, rect2, okLabel = false;
      for (k = 0; k < 3; k++) {
        rect2 = { x: x - 4, y: y - 8, w: tw + 8, h: 16 };
        if (occupy(G.tagRects, rect2)) { okLabel = true; break; }
        y += 15;
        if (y > G.mapH - 12) break;
      }
      if (!okLabel) G.tagRects.push(rect2);
      y = Math.max(76, Math.min(G.mapH - 12, y));
      /* 深色底板，避免压在雨区斜线/锋线上看不清 */
      g.save();
      g.fillStyle = 'rgba(6,12,24,0.74)';
      roundRect(g, x - 4, y - 8, tw + 8, 16, 4);
      g.fill();
      g.strokeStyle = rgba(hex, 0.38);
      g.lineWidth = 1;
      g.stroke();
      g.restore();
      drawText(g, txt, x, y, { px: px, bold: true, color: rgba(hex, 0.98) });
    }
    if (G.stage === 0) {
      put('准静止锋', geo.stat, 0.62, -26, C.station);
    } else {
      /* 锢囚提示先占位，锋面标签再避让（手机屏窄，只用虚线示意不写文字） */
      if (geo.occluded && !G.mobile) {
        p = geo.center;
        var ocPx = G.fs(10);
        var ocTxt = '开始锢囚';
        var ocW = measure(g, ocTxt, ocPx, false);
        var ocX = Math.max(10, Math.min(G.w - ocW - 12, p.x - ocW / 2));
        var ocY = Math.max(76, Math.min(G.mapH - 12, p.y + (G.mobile ? 34 : 42)));
        var ock, okO = false, ocRect;
        for (ock = 0; ock < 3; ock++) {
          ocRect = { x: ocX - 4, y: ocY - 7, w: ocW + 8, h: 14 };
          if (occupy(G.tagRects, ocRect)) { okO = true; break; }
          ocY += 15;
          if (ocY > G.mapH - 12) break;
        }
        if (!okO) G.tagRects.push(ocRect);
        ocY = Math.max(76, Math.min(G.mapH - 12, ocY));
        g.save();
        g.fillStyle = 'rgba(6,12,24,0.74)';
        roundRect(g, ocX - 4, ocY - 7, ocW + 8, 14, 4);
        g.fill();
        g.strokeStyle = rgba(C.station, 0.38);
        g.lineWidth = 1;
        g.stroke();
        g.restore();
        drawText(g, ocTxt, ocX, ocY, { px: ocPx, color: rgba(C.station, 0.95) });
      }
      put('冷锋', geo.cold, G.mobile ? 0.86 : 0.78, -16, C.cold);
      put('暖锋', geo.warm, 0.62, 16, C.warmLine);
    }
  }

  /* ---------- 低压中心 L ---------- */
  function drawLMarker(G) {
    var g = G.g, geo = G.geo, cx = geo.center.x, cy = geo.center.y;
    var press = LPRESS[G.stage];
    var pulse = 0.5 + 0.5 * Math.sin(G.t * TAU * 1.4);
    g.save();
    g.beginPath();
    g.arc(cx, cy, 15 + pulse * 3, 0, TAU);
    g.strokeStyle = rgba(C.warmLine, 0.18 + pulse * 0.12);
    g.lineWidth = 1.4;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, 11, 0, TAU);
    g.fillStyle = 'rgba(255,122,107,0.16)';
    g.fill();
    g.strokeStyle = rgba(C.warmLine, 0.9);
    g.lineWidth = 1.6;
    g.stroke();
    drawText(g, 'L', cx, cy + 0.5, { px: G.fs(13.5), bold: true, align: 'center', color: '#ffd9d3' });
    /* 中心气压 */
    var label = press + ' hPa';
    var tw = measure(g, label, G.fs(9.6), false);
    var ty = Math.max(76, cy + 24);
    g.save();
    g.fillStyle = 'rgba(8,17,32,0.78)';
    roundRect(g, cx - tw / 2 - 4, ty - 8, tw + 8, 16, 4);
    g.fill();
    g.restore();
    if (G.tagRects) G.tagRects.push({ x: cx - tw / 2 - 4, y: ty - 8, w: tw + 8, h: 16 });
    drawText(g, label, cx, ty, { px: G.fs(9.6), align: 'center', color: C.text });
    g.restore();
  }

  /* ---------- 观测站 A / B / C ---------- */
  function drawStations(G) {
    var g = G.g, geo = G.geo, st = CYCLONE_STAGES[G.stage].station;
    var keys = STATION_KEYS, i, def, pos, col, tag, tx;
    var r = G.mobile ? 8 : 9;
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      def = STATIONS[k];
      pos = geo.proj.project(def.lon, def.lat);
      if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) continue;
      col = k === 'A' ? C.warm : (k === 'B' ? C.warn : C.cold);
      g.save();
      g.beginPath();
      g.arc(pos.x, pos.y, r + 3, 0, TAU);
      g.strokeStyle = rgba(col, 0.30);
      g.lineWidth = 1;
      g.stroke();
      g.beginPath();
      g.arc(pos.x, pos.y, r, 0, TAU);
      g.fillStyle = 'rgba(8,17,32,0.92)';
      g.fill();
      g.strokeStyle = rgba(col, 0.95);
      g.lineWidth = 1.8;
      g.stroke();
      drawText(g, k, pos.x, pos.y + 0.5, { px: G.fs(10.5), bold: true, align: 'center', color: C.text });
      g.restore();
      if (G.show.labels !== false) {
        tag = st[k].tag || def.name;
        var tagPx = G.fs(9.8);
        var tagW = measure(g, tag, tagPx, false);
        /* 依次尝试右 / 左 / 下 / 上，避开已占用的标签与锋线区域 */
        var cands = [
          { x: pos.x + r + 5, y: pos.y },
          { x: pos.x - r - 5 - tagW, y: pos.y },
          { x: pos.x - tagW / 2, y: pos.y + r + 13 },
          { x: pos.x - tagW / 2, y: pos.y - r - 13 }
        ];
        var placed = null, ci, cx2, cy2, cr;
        for (ci = 0; ci < cands.length; ci++) {
          cx2 = Math.max(6, Math.min(G.w - tagW - 10, cands[ci].x));
          cy2 = Math.max(76, Math.min(G.mapH - 12, cands[ci].y));
          cr = { x: cx2 - 3, y: cy2 - 7, w: tagW + 6, h: 14 };
          if (occupy(G.tagRects, cr)) { placed = { x: cx2, y: cy2 }; break; }
        }
        if (!placed) {
          cx2 = Math.max(6, Math.min(G.w - tagW - 10, cands[0].x));
          cy2 = Math.max(76, Math.min(G.mapH - 12, cands[0].y));
          placed = { x: cx2, y: cy2 };
          G.tagRects.push({ x: cx2 - 3, y: cy2 - 7, w: tagW + 6, h: 14 });
        }
        tx = placed.x;
        var ty = placed.y;
        g.save();
        g.fillStyle = 'rgba(6,12,24,0.72)';
        roundRect(g, tx - 3, ty - 7, tagW + 6, 14, 4);
        g.fill();
        g.strokeStyle = rgba(col, 0.34);
        g.lineWidth = 1;
        g.stroke();
        g.restore();
        drawText(g, tag, tx, ty, { px: tagPx, color: rgba(col, 0.95) });
      }
    }
  }

  /* ---------- 左上角阶段信息卡 ---------- */
  function drawStageCard(G) {
    var g = G.g, st = CYCLONE_STAGES[G.stage];
    var pad = G.pad;
    var maxW = G.mobile ? G.w - pad * 2 : Math.min(440, G.w * 0.44);
    var titlePx = G.fs(13.5);
    var descPx = G.fs(10.6);
    var descLines = takeLines(g, st.desc, maxW - 22, descPx, false, 3);
    var lineH = descPx * 1.5;
    var boxH = 10 + titlePx + 6 + descLines.length * lineH + 9;
    var x = pad, y = 72;
    panel(g, x, y, maxW, boxH, 10, 0.86);
    /* 左侧强调条 */
    g.save();
    g.fillStyle = rgba(C.warm, 0.85);
    roundRect(g, x, y + 8, 3, boxH - 16, 2);
    g.fill();
    g.restore();
    var titleStr = st.number + ' ' + st.title;
    titleStr = fitText(g, titleStr, maxW - 26, titlePx, G.mobile ? 10 : 9.5, true);
    drawText(g, titleStr, x + 12, y + 10 + titlePx * 0.62, { px: titlePx, bold: true, color: C.text });
    for (var i = 0; i < descLines.length; i++) {
      drawText(g, descLines[i], x + 12, y + 10 + titlePx + 6 + lineH * (i + 0.62), { px: descPx, color: C.dim });
    }
  }

  /* ---------- 地图右上标题（桌面端） ---------- */
  function drawMapTitle(G) {
    if (G.mobile || G.show.labels === false) return;
    drawText(G.g, '锋面气旋 · 北半球俯视', G.w - G.pad, 86, {
      px: G.fs(12), bold: true, align: 'right', color: C.dim
    });
  }

  /* ---------- 底栏：三站天气卡 + 过境提示 + 图例 ---------- */
  function planLegend(g, w, fs, pad) {
    var iconW = fs(15), gap = fs(4), itemGap = fs(12);
    var widths = [], labels = [], i;
    for (i = 0; i < LEGEND_ITEMS.length; i++) {
      labels.push(LEGEND_ITEMS[i][1]);
      widths.push(iconW + gap + measure(g, LEGEND_ITEMS[i][1], fs(10.2), false));
    }
    var maxW = w - pad * 2;
    var rows = [], cur = [], curW = 0;
    for (i = 0; i < LEGEND_ITEMS.length; i++) {
      if (cur.length && curW + widths[i] > maxW) {
        rows.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push(i);
      curW += widths[i] + itemGap;
    }
    if (cur.length) rows.push(cur);
    return { rows: rows, widths: widths, iconW: iconW, gap: gap, itemGap: itemGap };
  }

  function drawLegendItem(g, kind, x, y, size, fs) {
    g.save();
    if (kind === 'L') {
      g.beginPath();
      g.arc(x + size / 2, y, size * 0.42, 0, TAU);
      g.strokeStyle = 'rgba(255,122,107,0.95)';
      g.lineWidth = 1.4;
      g.stroke();
      drawText(g, 'L', x + size / 2, y + 0.5, { px: fs(8.6), bold: true, align: 'center', color: '#ffd9d3' });
    } else if (kind === 'isobar') {
      g.beginPath();
      g.ellipse ? g.ellipse(x + size / 2, y, size * 0.42, size * 0.26, -0.3, 0, TAU) : g.arc(x + size / 2, y, size * 0.3, 0, TAU);
      g.strokeStyle = C.isobar;
      g.lineWidth = 1;
      g.stroke();
      g.beginPath();
      g.ellipse ? g.ellipse(x + size / 2, y, size * 0.26, size * 0.15, -0.3, 0, TAU) : g.arc(x + size / 2, y, size * 0.17, 0, TAU);
      g.stroke();
    } else if (kind === 'wind') {
      g.beginPath();
      g.moveTo(x + 1, y + 3);
      g.quadraticCurveTo(x + size * 0.5, y - 4, x + size * 0.8, y - 2);
      g.strokeStyle = 'rgba(205,228,255,0.75)';
      g.lineWidth = 1.3;
      g.stroke();
      arrowHead(g, x + size * 0.8, y - 2, 1, -0.2, 4, 'rgba(205,228,255,0.75)');
    } else if (kind === 'cold') {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + size * 0.85, y);
      g.strokeStyle = rgba(C.cold, 0.95);
      g.lineWidth = 1.6;
      g.stroke();
      frontTriangle(g, x + size * 0.45, y, 1, 0, 1, size * 0.24, rgba(C.cold, 0.95));
    } else if (kind === 'warm') {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + size * 0.85, y);
      g.strokeStyle = rgba(C.warmLine, 0.95);
      g.lineWidth = 1.6;
      g.stroke();
      frontSemicircle(g, x + size * 0.45, y, 1, 0, 1, size * 0.2, rgba(C.warmLine, 0.95));
    } else if (kind === 'rain') {
      g.save();
      g.fillStyle = 'rgba(143,200,255,0.14)';
      g.fillRect(x, y - 5, size * 0.9, 10);
      g.strokeStyle = rgba(C.rain, 0.75);
      g.lineWidth = 1;
      for (var i = 0; i < 4; i++) {
        g.beginPath();
        g.moveTo(x + 2 + i * 3, y + 5);
        g.lineTo(x + 6 + i * 3, y - 5);
        g.stroke();
      }
      g.restore();
    } else if (kind === 'station') {
      g.beginPath();
      g.arc(x + size / 2, y, size * 0.3, 0, TAU);
      g.strokeStyle = rgba(C.warn, 0.95);
      g.lineWidth = 1.5;
      g.stroke();
      g.beginPath();
      g.arc(x + size / 2, y, 1.6, 0, TAU);
      g.fillStyle = C.text;
      g.fill();
    }
    g.restore();
  }

  function drawBottom(G) {
    var g = G.g, w = G.w, h = G.h, pad = G.pad;
    var st = CYCLONE_STAGES[G.stage].station;
    var plan = G.legendPlan;
    var rowH = G.fs(13) + 3;
    var rowsN = plan.rows.length;
    var legendTop = h - pad - rowsN * rowH;
    var hintY = legendTop - G.fs(11);
    var cardH = G.cardH;
    var cardY = hintY - G.fs(12) - cardH;
    var gap = G.mobile ? 6 : 12;
    var cw = (w - pad * 2 - gap * 2) / 3;
    var i, k, stt, x, dotCol;
    var fs11 = G.fs(11);
    var fs10 = G.fs(10);

    /* 底栏背景 */
    g.save();
    var grd = g.createLinearGradient(0, cardY - 14, 0, h);
    if (grd && grd.addColorStop) {
      grd.addColorStop(0, 'rgba(8,12,24,0.55)');
      grd.addColorStop(0.35, 'rgba(8,12,24,0.88)');
      grd.addColorStop(1, 'rgba(8,12,24,0.96)');
      g.fillStyle = grd;
    } else {
      g.fillStyle = 'rgba(8,12,24,0.9)';
    }
    g.fillRect(0, cardY - 14, w, h - cardY + 14);
    g.beginPath();
    g.moveTo(0, cardY - 14);
    g.lineTo(w, cardY - 14);
    g.strokeStyle = 'rgba(150,180,230,0.20)';
    g.lineWidth = 1;
    g.stroke();
    g.restore();

    /* 三站天气卡 */
    for (i = 0; i < STATION_KEYS.length; i++) {
      k = STATION_KEYS[i];
      stt = st[k];
      x = pad + i * (cw + gap);
      dotCol = k === 'A' ? C.warm : (k === 'B' ? C.warn : C.cold);
      panel(g, x, cardY, cw, cardH, 8, 0.86);
      g.save();
      g.beginPath();
      g.arc(x + 11, cardY + 16, 3.4, 0, TAU);
      g.fillStyle = rgba(dotCol, 0.95);
      g.fill();
      g.restore();
      var titleStr = k + ' · ' + stt.tag;
      titleStr = fitText(g, titleStr, cw - 26, fs11, G.mobile ? 10 : 9, true);
      drawText(g, titleStr, x + 19, cardY + 16, { px: fs11, bold: true, color: C.text });
      var lineH = (cardH - 22) / 4;
      var v1 = stt.temp + '℃ · ' + stt.press + ' hPa';
      drawText(g, fitText(g, v1, cw - 14, fs10, G.mobile ? 10 : 9, true), x + 8, cardY + 24 + lineH * 0.9, {
        px: fs10, bold: true, color: k === 'B' ? rgba(C.warn, 1) : C.text
      });
      drawText(g, fitText(g, stt.wind, cw - 14, fs10, G.mobile ? 10 : 9, false), x + 8, cardY + 24 + lineH * 2.05, {
        px: fs10, color: C.dim
      });
      drawText(g, fitText(g, stt.rain, cw - 14, fs10, G.mobile ? 10 : 9, false), x + 8, cardY + 24 + lineH * 3.2, {
        px: fs10, color: rgba(C.rain, 0.92)
      });
    }

    /* 过境提示 */
    var hint = '过境顺序：冷锋 → 暖区 → 冷气团';
    drawText(g, hint, pad, hintY, { px: G.fs(10.4), color: C.dim });

    /* 图例 */
    var row, idx, ix, iy, item, itemW, curX;
    for (row = 0; row < plan.rows.length; row++) {
      curX = pad;
      iy = legendTop + rowH * row + rowH / 2;
      for (idx = 0; idx < plan.rows[row].length; idx++) {
        item = LEGEND_ITEMS[plan.rows[row][idx]];
        itemW = plan.widths[plan.rows[row][idx]];
        drawLegendItem(g, item[0], curX, iy, plan.iconW, G.fs);
        drawText(g, item[1], curX + plan.iconW + plan.gap, iy, { px: G.fs(10.2), color: C.dim });
        curX += itemW + plan.itemGap;
      }
    }
  }

  /* ---------- 模块工厂 ---------- */
  function create(ctx) {
    var offCanvas = null;
    var offKey = '';
    var offProj = null;
    var offCtx = null;

    function dispose() {
      offCanvas = null;
      offCtx = null;
      offProj = null;
      offKey = '';
    }

    function resize() {
      /* 缓存键含尺寸，尺寸变化时自动重画底图，这里无需处理 */
    }

    /* 生成 / 复用离屏底图，返回投影器 */
    function ensureBase(gMain, w, mapH) {
      var dpr = (global.devicePixelRatio || 1);
      var key = Math.round(w) + 'x' + Math.round(mapH) + '@' + (Math.round(dpr * 100) / 100);
      if (offCanvas && offKey === key && offProj) return offProj;
      offCanvas = null;
      offCtx = null;
      offProj = null;
      offKey = key;
      var doc = global.document;
      if (doc && typeof doc.createElement === 'function') {
        try {
          var cv = doc.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * dpr));
          cv.height = Math.max(1, Math.round(mapH * dpr));
          var g2 = cv.getContext && cv.getContext('2d');
          if (g2) {
            if (g2.setTransform) g2.setTransform(dpr, 0, 0, dpr, 0, 0);
            offProj = paintBase(g2, w, mapH);
            offCanvas = cv;
            offCtx = g2;
          }
        } catch (err) {
          offCanvas = null;
          offCtx = null;
          offProj = null;
        }
      }
      if (!offProj) {
        /* 无离屏画布：直接画到主画布（等价效果，只是每帧重画） */
        offProj = paintBase(gMain, w, mapH);
      }
      return offProj;
    }

    function draw(c2d, w, h, state, FRONT) {
      if (!c2d || !w || !h) return;
      w = Math.max(1, Math.round(w));
      h = Math.max(1, Math.round(h));
      var S = state || {};
      var t = clamp01(S.t == null ? 0 : S.t);
      var stage = Math.max(0, Math.min(3, Math.round(S.cycStage == null ? 0 : S.cycStage)));
      var show = S.show || {};
      var mobile = w < 820;
      var fs = function (v) { return Math.max(mobile ? 10 : 9, v * (mobile ? 0.85 : 1)); };
      var pad = mobile ? 10 : 16;

      /* 先测量图例行数，再确定底栏高度，保证 390 宽不重叠 */
      var legendPlan = planLegend(c2d, w, fs, pad);
      var rowH = fs(13) + 3;
      var cardH = mobile ? 76 : 72;
      var hintH = mobile ? 16 : 18;
      var bottomH = pad + cardH + 8 + hintH + 4 + legendPlan.rows.length * rowH + pad;
      var mapH = Math.max(120, h - bottomH);

      var G = {
        g: c2d, w: w, h: h, mapH: mapH, t: t, stage: stage,
        show: show, mobile: mobile, fs: fs, pad: pad,
        cardH: cardH, legendPlan: legendPlan, tagRects: []
      };

      c2d.clearRect(0, 0, w, h);
      var proj = ensureBase(c2d, w, mapH);
      if (offCanvas) {
        c2d.drawImage(offCanvas, 0, 0, offCanvas.width, offCanvas.height, 0, 0, w, mapH);
      }
      G.proj = proj;

      /* 计算本帧几何 */
      G.geo = buildGeometry(proj, stage, t);
      /* 观测站位置在几何里补上，供 drawStations 使用 */
      G.geo.proj = proj;

      c2d.save();
      c2d.beginPath();
      c2d.rect(0, 0, w, mapH);
      c2d.clip();

      drawFills(G);
      drawPrecip(G);
      drawIsobars(G);
      drawFronts(G);
      drawWind(G);
      drawLMarker(G);
      drawStations(G);
      if (G.show.labels !== false) drawFrontLabels(G);
      drawMapTitle(G);
      drawStageCard(G);

      c2d.restore();

      drawBottom(G);
    }

    return { draw: draw, resize: resize, dispose: dispose };
  }

  /* ---------- 导出 ---------- */
  global.MODELS = global.MODELS || {};
  global.MODELS.M7 = create;

  /* 兼容 CommonJS 环境的语法检查（不依赖 window） */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { create: create, STAGES: CYCLONE_STAGES };
  }
})(typeof window !== 'undefined' ? window : globalThis);
