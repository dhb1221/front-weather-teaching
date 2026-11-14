/* ============================================================
 * m3-map.js — M3 天气图（canvas 2D）
 * 三个子模式（读 state.mapMode）：
 *   'cyclone'  锋面气旋：真实东亚海岸线 + 等压线 + L + 逆时针辐合风 + 左冷锋/右暖锋
 *              + 降水区 + 观测站过境路线 A→B→C
 *   'rainbelt' 我国锋面雨带：真实中国地图（LCC 投影，含南海诸岛插图）+ 按 state.month(4~9)
 *              用真实经纬度画雨带（陆地裁剪）+ 城市 + 月份说明
 *   'symbols'  锋面符号判读：三张对照卡，点击高亮（内部状态，不改 state）
 * 依赖：window.GEO / GEO_CHINA / GEO_WORLD（真实地理底图，缺失时退化为网格 + 提示）
 *       window.FRONT（可选，取 meta 文案/配色；缺失时有内置兜底）
 * API：window.MODELS.M3 = function createM3(ctx) -> { draw, resize, dispose }
 * 性能：底图（海岸/省界/插图/省份高亮）画在离屏 canvas 缓存，仅尺寸/月份变化时重绘，
 *       每帧只 drawImage 贴图 + 绘制动态层（雨带/等压线/锋面/文字）。
 * 说明：c2d 已按 DPR 缩放，坐标一律 CSS 像素。
 * ============================================================ */
(function (global) {
  'use strict';

  var FONT = '"PingFang SC","Microsoft YaHei",sans-serif';
  var TAU = Math.PI * 2;

  /* 配色（与 CONTRACT 一致，内置兜底） */
  var C = {
    bg: '#05070f',
    panel: 'rgba(16,24,42,0.78)',
    panel2: 'rgba(20,32,56,0.92)',
    line: 'rgba(150,180,230,0.22)',
    text: '#dbe6ff',
    dim: 'rgba(219,230,255,0.55)',
    accent: '#4ea1ff',
    cold: '#4ea1ff',
    warm: '#ff8a3d',
    warmLine: '#ff7a6b',
    station: '#b98cff',
    rain: '#8fc8ff',
    cloud: '#cfd8ea',
    ok: '#37d39b',
    warn: '#ffb454',
    route: 'rgba(255,190,140,0.85)'
  };

  /* ---------------- 基础工具 ---------------- */
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function setFont(g, size, bold) {
    g.font = (bold ? 'bold ' : '') + size.toFixed(1) + 'px ' + FONT;
  }

  function textWidth(g, t) {
    if (g.measureText) return g.measureText(t).width;
    return t.length * 11;
  }

  /* 带描边的文字（深色画布上保证可读） */
  function haloText(g, text, x, y, color, size, align, bold) {
    setFont(g, size, bold);
    g.textAlign = align || 'center';
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(2, size * 0.24);
    g.strokeStyle = 'rgba(5,7,15,0.9)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  function roundRectPath(g, x, y, w, h, r) {
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

  /* 半透明面板 */
  function panel(g, x, y, w, h, r, fill, border, lw) {
    roundRectPath(g, x, y, w, h, r);
    g.fillStyle = fill || C.panel;
    g.fill();
    if (border !== null) {
      g.strokeStyle = border || C.line;
      g.lineWidth = lw || 1;
      g.stroke();
    }
  }

  function polyPath(g, pts) {
    if (!pts || !pts.length) return;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
  }

  function polyline(g, pts, close) {
    if (!pts || pts.length < 2) return;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    if (close) g.closePath();
    g.stroke();
  }

  function bboxOf(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      x0 = Math.min(x0, pts[i].x); x1 = Math.max(x1, pts[i].x);
      y0 = Math.min(y0, pts[i].y); y1 = Math.max(y1, pts[i].y);
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /* 多边形斜线阴影填充（雨区/雨带通用） */
  function fillHatchPoly(g, pts, fillColor, hatchColor, gap, lineWidth) {
    if (!pts || pts.length < 3) return;
    polyPath(g, pts);
    g.fillStyle = fillColor;
    g.fill();
    var b = bboxOf(pts);
    g.save();
    polyPath(g, pts);
    g.clip();
    g.strokeStyle = hatchColor;
    g.lineWidth = lineWidth || 1;
    var span = (b.x1 - b.x0) + (b.y1 - b.y0);
    for (var d = 0; d < span; d += gap) {
      g.beginPath();
      g.moveTo(b.x0 + d, b.y0);
      g.lineTo(b.x0 + d - (b.y1 - b.y0), b.y1);
      g.stroke();
    }
    g.restore();
  }

  function drawArrow(g, x0, y0, x1, y1, color, width, head) {
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    var ux = dx / len, uy = dy / len;
    var h = head || 5;
    g.strokeStyle = color;
    g.lineWidth = width || 1.4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1 - ux * h * 0.6, y1 - uy * h * 0.6);
    g.stroke();
    var hx = x1 - ux * h, hy = y1 - uy * h;
    var px = -uy, py = ux;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(hx + px * h * 0.42, hy + py * h * 0.42);
    g.lineTo(hx - px * h * 0.42, hy - py * h * 0.42);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }

  /* ---------------- 折线几何：按弧长取点 + 法线 ---------------- */
  function pathInfo(pts) {
    var segs = [], total = 0, i;
    for (i = 1; i < pts.length; i++) {
      var dx = pts[i].x - pts[i - 1].x;
      var dy = pts[i].y - pts[i - 1].y;
      var l = Math.sqrt(dx * dx + dy * dy);
      segs.push({ x0: pts[i - 1].x, y0: pts[i - 1].y, dx: dx, dy: dy, l: l, s0: total });
      total += l;
    }
    return { segs: segs, total: total };
  }

  /* 在弧长 s 处取点、切向（单位） */
  function pointAt(info, s) {
    s = clamp(s, 0, info.total);
    var segs = info.segs;
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      if (s <= sg.s0 + sg.l || i === segs.length - 1) {
        var t = sg.l > 0.001 ? (s - sg.s0) / sg.l : 0;
        var tx = sg.l > 0.001 ? sg.dx / sg.l : 1;
        var ty = sg.l > 0.001 ? sg.dy / sg.l : 0;
        return { x: sg.x0 + sg.dx * t, y: sg.y0 + sg.dy * t, tx: tx, ty: ty };
      }
    }
    return { x: segs[0].x0, y: segs[0].y0, tx: 1, ty: 0 };
  }

  /* 沿折线画锋面符号：kind = 'tri' 三角形 | 'semi' 半圆 | 'mix' 交替
   * side：法线方向取 (ty,-tx)*side，即符号指向的一侧（= 锋面移动方向） */
  function symbolsAlong(g, pts, kind, size, gap, color, side) {
    var info = pathInfo(pts);
    if (info.total < 2) return;
    var step = gap || size * 2.6;
    var s = step * 0.55;
    var idx = 0;
    while (s < info.total - size * 0.4) {
      var p = pointAt(info, s);
      var n1x = p.ty, n1y = -p.tx;             /* side=+1 的法线 */
      var sd = (kind === 'mix' && (idx % 2 === 1)) ? -1 : 1;
      var sgn = (kind === 'mix') ? sd : (side || 1);
      var nx = n1x * sgn, ny = n1y * sgn;
      if (kind === 'tri' || (kind === 'mix' && idx % 2 === 0)) drawTri(g, p, nx, ny, size, color);
      else drawSemi(g, p, nx, ny, size, color);
      idx++;
      s += step;
    }
  }

  function drawTri(g, p, nx, ny, size, color) {
    var hw = size * 0.86;          /* 三角形底半宽 */
    var dep = size * 1.18;         /* 尖端伸出长度 */
    var bx = p.x, by = p.y;
    var tx = -ny, ty = nx;         /* 沿线方向 */
    g.beginPath();
    g.moveTo(bx + nx * dep, by + ny * dep);
    g.lineTo(bx + tx * hw, by + ty * hw);
    g.lineTo(bx - tx * hw, by - ty * hw);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }

  function drawSemi(g, p, nx, ny, size, color) {
    var r = size * 0.96;
    var ang = Math.atan2(ny, nx);  /* 凸出方向 */
    g.beginPath();
    g.arc(p.x, p.y, r, ang - Math.PI / 2, ang + Math.PI / 2);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  }

  /* 锋线（线 + 符号） */
  function drawFront(g, pts, kind, color, width, size, side) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    polyline(g, pts, false);
    symbolsAlong(g, pts, kind, size, size * 2.9, color, side);
  }

  /* 沿一条锋线做一侧的带（降水区）：外缘 p+n*width，内缘贴线 */
  function offsetBand(pts, side, width) {
    var info = pathInfo(pts);
    var outer = [], inner = [], i, s;
    var n = Math.max(8, Math.ceil(info.total / 14));
    for (i = 0; i <= n; i++) {
      s = info.total * i / n;
      var p = pointAt(info, s);
      var nx = p.ty * side, ny = -p.tx * side;
      outer.push({ x: p.x + nx * width, y: p.y + ny * width });
      inner.push({ x: p.x + nx * width * 0.05, y: p.y + ny * width * 0.05 });
    }
    var poly = outer.slice();
    for (i = inner.length - 1; i >= 0; i--) poly.push(inner[i]);
    return poly;
  }

  /* 文字换行 + 省略号（用于卡片行） */
  function fitText(g, text, maxW, size) {
    text = String(text == null ? '' : text);
    setFont(g, size, false);
    if (textWidth(g, text) <= maxW) return text;
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var test = out + text.charAt(i) + '…';
      if (textWidth(g, test) > maxW) break;
      out += text.charAt(i);
    }
    return out + '…';
  }

  function wrapLines(g, text, maxW) {
    text = String(text == null ? '' : text);
    var out = [], line = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '\n') { out.push(line); line = ''; continue; }
      if (textWidth(g, line + ch) > maxW && line) { out.push(line); line = ch; }
      else line += ch;
    }
    if (line) out.push(line);
    return out;
  }

  /* ---------------- 图例 ---------------- */
  function legendRows(g, items, maxW, sc) {
    var rows = [], cur = [], curW = 0;
    var sw = 18 * sc, gap1 = 5 * sc, padR = 14 * sc;
    for (var i = 0; i < items.length; i++) {
      setFont(g, 10.5 * sc, false);
      var w = sw + gap1 + textWidth(g, items[i].t) + padR;
      if (curW + w > maxW && cur.length) {
        rows.push({ items: cur, w: curW });
        cur = []; curW = 0;
      }
      cur.push({ it: items[i], w: w });
      curW += w;
    }
    if (cur.length) rows.push({ items: cur, w: curW });
    return rows;
  }

  function drawLegend(g, rows, x, y0, sc) {
    var sw = 18 * sc, gap1 = 5 * sc;
    var lh = 19 * sc;
    for (var r = 0; r < rows.length; r++) {
      var acc = 0, y = y0 + r * lh;
      for (var i = 0; i < rows[r].items.length; i++) {
        var it = rows[r].items[i].it;
        var sx = x + acc;
        var cy = y;
        g.lineWidth = 1.5 * sc;
        if (it.k === 'line') {
          g.strokeStyle = it.c;
          g.beginPath(); g.moveTo(sx, cy); g.lineTo(sx + sw, cy); g.stroke();
        } else if (it.k === 'dash') {
          g.save(); g.setLineDash([4 * sc, 3 * sc]);
          g.strokeStyle = it.c;
          g.beginPath(); g.moveTo(sx, cy); g.lineTo(sx + sw, cy); g.stroke();
          g.restore();
        } else if (it.k === 'tri') {
          var p1 = { x: sx + sw * 0.5, y: cy };
          drawTri(g, p1, 0, -1, 4.2 * sc, it.c);
        } else if (it.k === 'semi') {
          drawSemi(g, { x: sx + sw * 0.5, y: cy + 3.4 * sc }, 0, -1, 4.2 * sc, it.c);
        } else if (it.k === 'hatch') {
          g.fillStyle = 'rgba(143,200,255,0.18)';
          g.fillRect(sx, cy - 5 * sc, sw, 10 * sc);
          g.strokeStyle = it.c;
          g.beginPath(); g.moveTo(sx, cy + 5 * sc); g.lineTo(sx + sw, cy - 5 * sc); g.stroke();
        } else if (it.k === 'dot') {
          g.fillStyle = it.c;
          g.beginPath(); g.arc(sx + sw * 0.5, cy, 3.2 * sc, 0, TAU); g.fill();
        } else if (it.k === 'poly') {
          g.fillStyle = 'rgba(26,48,74,0.9)';
          g.fillRect(sx, cy - 5 * sc, sw, 10 * sc);
          g.strokeStyle = it.c;
          g.strokeRect(sx, cy - 5 * sc, sw, 10 * sc);
        } else if (it.k === 'L') {
          haloText(g, 'L', sx + sw * 0.5, cy, '#ff8f86', 12 * sc, 'center', true);
        }
        haloText(g, it.t, sx + sw + gap1, cy, C.dim, 10.5 * sc, 'left', false);
        acc += rows[r].items[i].w;
      }
    }
  }

  /* =================================================================
   * 真实地理底图（GEO / GEO_CHINA / GEO_WORLD）与离屏缓存
   *   · 底图只在画布尺寸 / 月份变化时重绘一次，之后每帧 drawImage 贴图
   *   · 动态层（雨带、等压线、锋面、文字）每帧画在顶层
   *   · 地理数据缺失时画网格 + 提示，不崩溃
   * ================================================================= */

  /* 各月雨带覆盖的省份（用于底图省份高亮片段匹配） */
  var RAIN_HIGHLIGHT = {
    4: ['广东', '广西', '海南', '福建', '台湾'],
    5: ['广东', '广西', '福建', '海南', '江西'],
    6: ['湖北', '湖南', '安徽', '江苏', '江西', '浙江', '上海'],
    7: ['北京', '天津', '河北', '山西', '山东', '辽宁', '吉林', '河南'],
    8: ['北京', '天津', '河北', '辽宁', '吉林', '黑龙江', '内蒙古'],
    9: ['湖北', '湖南', '江西', '安徽', '浙江']
  };

  /* 从 c2d 的变换矩阵取 DPR（c2d 已按 DPR 缩放） */
  function dprOf(c2d) {
    try {
      if (c2d && typeof c2d.getTransform === 'function') {
        var m = c2d.getTransform();
        if (m && isFinite(m.a) && m.a >= 1) return Math.min(2, m.a);
      }
    } catch (e) { /* 忽略 */ }
    return clamp(num(global.devicePixelRatio, 1), 1, 2);
  }

  /* 创建离屏画布（设备像素尺寸，绘图坐标仍为 CSS 像素） */
  function makeOffscreen(pw, ph, dpr) {
    var doc = global.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    try {
      var cv = doc.createElement('canvas');
      cv.width = Math.max(1, Math.round(pw * dpr));
      cv.height = Math.max(1, Math.round(ph * dpr));
      var c = typeof cv.getContext === 'function' ? cv.getContext('2d') : null;
      if (!c) return null;
      if (typeof c.setTransform === 'function') c.setTransform(dpr, 0, 0, dpr, 0, 0);
      else if (typeof c.scale === 'function') c.scale(dpr, dpr);
      return { cv: cv, ctx: c };
    } catch (e) { return null; }
  }

  /* GEO 缺失时的兜底投影（等经纬 + 中纬度经度压缩），保证不崩 */
  function localProj(lonMin, lonMax, latMin, latMax, w, h, pad) {
    pad = pad === undefined ? 8 : pad;
    var kx = Math.cos((latMin + latMax) / 2 * Math.PI / 180);
    var fwd = function (lon, lat) { return { x: (lon - lonMin) * kx, y: -(lat - latMin) }; };
    var i, j, p, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (i = 0; i <= 16; i++) {
      for (j = 0; j <= 16; j++) {
        p = fwd(lonMin + (lonMax - lonMin) * i / 16, latMin + (latMax - latMin) * j / 16);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    var s = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
    var ox = pad + ((w - pad * 2) - (maxX - minX) * s) / 2;
    var oy = pad + ((h - pad * 2) - (maxY - minY) * s) / 2;
    return {
      project: function (lon, lat) {
        var q = fwd(lon, lat);
        return { x: ox + (q.x - minX) * s, y: oy + (q.y - minY) * s };
      }
    };
  }

  /* 兜底底图：网格 + 提示文字 */
  function drawFallbackGrid(g, w, h, sc) {
    g.save();
    g.strokeStyle = 'rgba(120,160,220,0.12)';
    g.lineWidth = 1;
    var x, y;
    for (x = 0; x < w; x += 44 * sc) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (y = 0; y < h; y += 44 * sc) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.restore();
    haloText(g, '地图数据未加载（geo-china.js / geo-world.js 缺失）',
      w / 2, h / 2, 'rgba(255,180,120,0.92)', 12 * sc, 'center', true);
  }

  /* 底图参数：rainbelt 用真实中国图，cyclone 用东亚区域世界图
     注意配色：陆地比海洋亮一档（#12233c vs #070d18），省界/海岸线提亮，
     否则整张图对比度太低、看不清轮廓。 */
  function geoSpec(mode, month) {
    if (mode === 'rainbelt') {
      return {
        opts: {
          ocean: '#081120',
          land: '#17304f',
          border: 'rgba(160,196,246,0.45)',
          borderWidth: 0.9,
          cities: false,
          highlight: RAIN_HIGHLIGHT[month] || [],
          highlightFill: 'rgba(78,161,255,0.22)',
          insetPad: 8
        }
      };
    }
    return {
      opts: {
        lonMin: 100, lonMax: 140, latMin: 18, latMax: 50,
        ocean: '#081120', land: '#17304f',
        border: 'rgba(160,196,246,0.42)', borderWidth: 0.85
      }
    };
  }

  /* GEO 的 LCC 投影 y 轴朝北（数值随纬度增大），而 canvas 的 y 轴向下；
     GEO.drawChina 直接用它绘制会“南海诸岛在上、黑龙江在下”，南北颠倒。
     这里把投影的 y 翻转，得到“北在上、南在下”的正确朝向（不改 geo.js）。 */
  function northUpProj(proj, ph) {
    /* GEO.chinaProjector 现已修正为“北在上”；若检测到投影本身已经北在上，
       则直接复用，避免二次翻转又把地图倒过来。 */
    try {
      var south = proj.project(105, 20), north = proj.project(105, 45);
      if (north.y < south.y) return proj;
    } catch (e) { /* 投影异常时按旧逻辑翻转 */ }
    return {
      project: function (lon, lat) {
        var p = proj.project(lon, lat);
        return { x: p.x, y: ph - p.y };
      }
    };
  }

  /* 北在上的真实中国底图：海岸线 / 省界 / 省份高亮 / 南海诸岛插图。
     数据与投影都取自 GEO / GEO_CHINA，仅把 y 轴翻正；配色沿用 geoSpec。
     返回北向上的投影，供雨带/城市等动态层统一使用。 */
  function paintChinaBase(g, pw, ph, month) {
    var G = global.GEO, CH = global.GEO_CHINA;
    var opts = geoSpec('rainbelt', month).opts;
    var proj = northUpProj(G.chinaProjector(pw, ph, 10), ph);
    var pv, i, j, q, ring;

    g.save();
    g.lineJoin = 'round';
    if (opts.ocean) { g.fillStyle = opts.ocean; g.fillRect(0, 0, pw, ph); }

    /* 省级陆地 + 省界 */
    g.fillStyle = opts.land;
    g.strokeStyle = opts.border;
    g.lineWidth = opts.borderWidth;
    for (i = 0; i < CH.provinces.length; i++) {
      G.pathRings(g, CH.provinces[i].rings, proj.project);
      g.fill();
    }
    for (i = 0; i < CH.provinces.length; i++) {
      G.pathRings(g, CH.provinces[i].rings, proj.project);
      g.stroke();
    }

    /* 高亮当月雨带覆盖的省份 */
    if (opts.highlight && opts.highlight.length) {
      g.fillStyle = opts.highlightFill;
      for (i = 0; i < CH.provinces.length; i++) {
        pv = CH.provinces[i];
        if (opts.highlight.some(function (n) { return pv.name.indexOf(n) >= 0; })) {
          G.pathRings(g, pv.rings, proj.project);
          g.fill();
        }
      }
    }

    /* 南海诸岛插图（右下角，含九段线；插图同样北在上） */
    var iw = Math.max(48, Math.min(pw * 0.2, 96));
    var ih = iw * 1.35;
    var ipd = opts.insetPad === undefined ? 12 : opts.insetPad;
    var ix = pw - iw - ipd, iy = ph - ih - ipd;
    var inProj = northUpProj(
      G.makeProjector(G.lcc(25, 47, 105), 106, 123, 2, 24, iw, ih, 4), ih);
    g.save();
    g.fillStyle = 'rgba(7,13,24,0.82)';
    g.fillRect(ix, iy, iw, ih);
    g.strokeStyle = 'rgba(150,180,230,0.45)';
    g.lineWidth = 1;
    g.strokeRect(ix, iy, iw, ih);
    g.translate(ix, iy);
    /* 插图必须裁剪到小框内：否则超出经度 106—123°E / 纬度 2—24°N 的省份
       （新疆、内蒙古等）会“溢出”到主图上，形成一块多余的小中国轮廓 */
    g.beginPath();
    g.rect(0, 0, iw, ih);
    g.clip();
    g.fillStyle = opts.land;
    g.strokeStyle = opts.border;
    g.lineWidth = 0.5;
    for (i = 0; i < CH.provinces.length; i++) {
      G.pathRings(g, CH.provinces[i].rings, inProj.project);
      g.fill();
      g.stroke();
    }
    if (CH.jd && CH.jd.rings) {
      g.strokeStyle = 'rgba(150,190,240,0.85)';
      g.lineWidth = Math.max(0.8, iw / 60);
      for (i = 0; i < CH.jd.rings.length; i++) {
        ring = CH.jd.rings[i];
        if (!ring || ring.length < 2) continue;
        g.beginPath();
        for (j = 0; j < ring.length; j++) {
          q = inProj.project(ring[j][0], ring[j][1]);
          if (j === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
        }
        g.stroke();
      }
    }
    g.restore();

    /* 插图标签（正立文字） */
    g.fillStyle = 'rgba(219,230,255,0.78)';
    g.font = 'bold 9px ' + FONT;
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    g.fillText('南海诸岛', ix + iw - 3, iy + ih - 3);
    g.restore();
    return proj;
  }

  /* 生成/复用底图缓存。返回 { cv, proj, inset, geoOK, landPath } */
  function ensureBase(c2d, cache, mode, month, pw, ph) {
    pw = Math.max(2, pw); ph = Math.max(2, ph);
    var dpr = dprOf(c2d);
    var hasGeo = mode === 'rainbelt'
      ? !!(global.GEO && global.GEO_CHINA)
      : !!(global.GEO && global.GEO_WORLD);
    var key = mode + '|' + month + '|' + Math.round(pw) + 'x' + Math.round(ph) +
      '|' + dpr.toFixed(2) + '|' + (hasGeo ? 'g' : 'n');
    if (cache.key === key) return cache;

    cache.key = key;
    cache.cv = null;
    cache.proj = null;
    cache.inset = null;
    cache.geoOK = hasGeo;
    cache.landPath = null;

    var off = makeOffscreen(pw, ph, dpr);
    if (!off) return cache;                 /* 无 document：改为逐帧直画 */

    var bg = off.ctx;
    if (mode === 'rainbelt') {
      if (hasGeo) {
        /* 注意：不用 GEO.drawChina 直接画（它的 LCC y 轴朝北会让地图南北颠倒），
           改用同一套 GEO 数据 + 翻正 y 轴的自绘底图。 */
        cache.proj = paintChinaBase(bg, pw, ph, month);
        cache.inset = null;
        /* 陆地裁剪路径（省界多边形）预生成一次，雨带只画在陆地上 */
        if (typeof Path2D !== 'undefined') {
          try {
            var pth = new Path2D();
            global.GEO_CHINA.provinces.forEach(function (pv) {
              (pv.rings || []).forEach(function (ring) {
                for (var i = 0; i < ring.length; i++) {
                  var q = cache.proj.project(ring[i][0], ring[i][1]);
                  if (i === 0) pth.moveTo(q.x, q.y); else pth.lineTo(q.x, q.y);
                }
                pth.closePath();
              });
            });
            cache.landPath = pth;
          } catch (e) { cache.landPath = null; }
        }
      } else {
        drawFallbackGrid(bg, pw, ph, 1);
      }
    } else {
      if (hasGeo) {
        cache.proj = global.GEO.drawWorld(bg, pw, ph, geoSpec(mode, month).opts);
      } else {
        drawFallbackGrid(bg, pw, ph, 1);
      }
    }
    cache.cv = off.cv;
    return cache;
  }

  /* 无法离屏时（如测试桩），直接在当前上下文画底图 */
  function paintBaseDirect(g, mode, month, pw, ph) {
    if (mode === 'rainbelt' && global.GEO && global.GEO_CHINA) {
      return { projector: paintChinaBase(g, pw, ph, month), inset: null };
    }
    if (mode !== 'rainbelt' && global.GEO && global.GEO_WORLD) {
      return {
        projector: global.GEO.drawWorld(g, pw, ph, geoSpec(mode, month).opts),
        inset: null
      };
    }
    drawFallbackGrid(g, pw, ph, 1);
    return { projector: null, inset: null };
  }

  /* 把省级陆地多边形追加进当前路径（Path2D 不可用时的裁剪备选） */
  function addLandPath(g, proj) {
    var CH = global.GEO_CHINA;
    if (!CH || !CH.provinces) return false;
    g.beginPath();
    var pv, ring, i, q;
    for (var k = 0; k < CH.provinces.length; k++) {
      pv = CH.provinces[k];
      for (var r = 0; r < pv.rings.length; r++) {
        ring = pv.rings[r];
        if (!ring || ring.length < 2) continue;
        for (i = 0; i < ring.length; i++) {
          q = proj.project(ring[i][0], ring[i][1]);
          if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
        }
        g.closePath();
      }
    }
    return true;
  }

  /* 经纬网（真实投影下的弧线，浅色；只作参考不抢视线） */
  function graticule(g, proj, sc, lonMin, lonMax, latMin, latMax) {
    var i, lon, lat, pts;
    g.save();
    g.strokeStyle = 'rgba(150,180,230,0.10)';
    g.lineWidth = 1;
    for (lat = 20; lat <= 50; lat += 10) {
      pts = [];
      for (i = 0; i <= 12; i++) {
        pts.push(proj.project(lonMin + (lonMax - lonMin) * i / 12, lat));
      }
      polyline(g, pts, false);
    }
    for (lon = 80; lon <= 120; lon += 20) {
      pts = [];
      for (i = 0; i <= 12; i++) {
        pts.push(proj.project(lon, latMin + (latMax - latMin) * i / 12));
      }
      polyline(g, pts, false);
    }
    g.restore();
  }

  /* ---------------- 各模式文案与图例 ---------------- */
  function modeInfo(mode, S, F) {
    if (mode === 'rainbelt') {
      return {
        sub: '② 我国锋面雨带 · 按月份',
        title: 'M3 天气图 · 我国锋面雨带推移',
        legend: [
          { k: 'poly', c: 'rgba(140,190,255,0.75)', t: '陆地 · 省界' },
          { k: 'hatch', c: 'rgba(143,200,255,0.65)', t: '锋面雨带' },
          { k: 'dash', c: 'rgba(255,210,120,0.9)', t: '588 线（副高）' },
          { k: 'dash', c: 'rgba(255,158,203,0.9)', t: '雨带内锋面' },
          { k: 'dot', c: '#ffd36b', t: '城市（雨带内高亮）' }
        ],
        note: '副热带高压北进则雨带北移、南退则雨带南压：4—5 月华南 → 6 月江淮梅雨 → 7—8 月华北东北 → 9 月南退，规律是“雨带随副高北进南退”。'
      };
    }
    if (mode === 'symbols') {
      return {
        sub: '③ 锋面符号判读 · 点击卡片',
        title: 'M3 天气图 · 锋面符号判读',
        legend: [
          { k: 'tri', c: C.cold, t: '蓝色三角形 = 冷锋' },
          { k: 'semi', c: C.warmLine, t: '红色半圆 = 暖锋' },
          { k: 'semi', c: C.station, t: '紫/褐交替 = 准静止锋' }
        ],
        note: '符号画在锋线哪一侧、凸向哪里，就表示锋面向哪一侧移动、暖空气被抬升在哪一侧；点击卡片可高亮对照。'
      };
    }
    return {
      sub: '① 锋面气旋 · 北半球 · 东亚',
      title: 'M3 天气图 · 锋面气旋（北半球）',
      legend: [
        { k: 'poly', c: 'rgba(140,190,255,0.55)', t: '陆地 · 海岸线' },
        { k: 'line', c: 'rgba(120,170,255,0.75)', t: '等压线' },
        { k: 'L', c: '#ff8f86', t: '低压中心 L' },
        { k: 'tri', c: C.cold, t: '冷锋（三角）' },
        { k: 'semi', c: C.warmLine, t: '暖锋（半圆）' },
        { k: 'hatch', c: 'rgba(143,200,255,0.65)', t: '降水区' },
        { k: 'dash', c: C.route, t: '观测站过境路线 A→B→C' }
      ],
      note: '东亚地面图（100°—140°E）：低压中心气流逆时针辐合上升，左侧冷锋、右侧暖锋；观测站自东南向西北过境 A（暖区）→ B（冷锋）→ C（冷气团）。'
    };
  }

  /* ---------------- meta 兜底文案 ---------------- */
  var TYPE_FALLBACK = {
    cold: {
      name: '冷锋', glyph: '▲', color: '#4ea1ff',
      motion: '冷气团主动移向暖气团，冷楔抬升暖空气',
      rain: '锋后（冷气团一侧）· 阵性、强度大、历时短',
      example: '北方夏季暴雨、寒潮、沙尘暴',
      slope: '锋面坡度较陡'
    },
    warm: {
      name: '暖锋', glyph: '◗', color: '#ff7a6b',
      motion: '暖气团主动移向冷气团，沿锋面缓慢爬升',
      rain: '锋前（冷气团一侧）· 连续性、强度小、历时长',
      example: '一场春雨一场暖、江淮春季连绵阴雨',
      slope: '锋面坡度较缓'
    },
    stationary: {
      name: '准静止锋', glyph: '⛆', color: '#b98cff',
      motion: '冷暖气团势均力敌，锋面原地摆动',
      rain: '锋面附近两侧 · 连续性、持续时间很长',
      example: '江淮梅雨、昆明准静止锋、华南准静止锋',
      slope: '锋面坡度小、位置少动'
    }
  };

  function typeMeta(F, type) {
    var m = F && F.meta && F.meta[type];
    if (!m) return TYPE_FALLBACK[type];
    return {
      name: m.name || TYPE_FALLBACK[type].name,
      glyph: m.glyph || TYPE_FALLBACK[type].glyph,
      color: m.color || TYPE_FALLBACK[type].color,
      motion: type === 'cold' ? '冷气团主动移向暖气团，冷楔抬升暖空气'
        : type === 'warm' ? '暖气团主动移向冷气团，沿锋面缓慢爬升'
          : '冷暖气团势均力敌，锋面原地摆动',
      rain: m.rainZoneText || TYPE_FALLBACK[type].rain,
      example: (m.examples && m.examples.length) ? m.examples[0] : TYPE_FALLBACK[type].example,
      slope: m.slopeText || TYPE_FALLBACK[type].slope
    };
  }

  /* =================================================================
   * ① 锋面气旋
   * ================================================================= */
  function drawCyclone(g, P, w, h, S, F, sc, cache) {
    var labelsOn = !(S.show && S.show.labels === false);
    var pw = Math.max(2, P.x1 - P.x0), ph = Math.max(2, P.y1 - P.y0);
    var base = ensureBase(g, cache, 'cyclone', 0, pw, ph);

    /* 进入绘图区：坐标系平移到 P 左上角，底图与动态层都用底图内坐标 */
    g.save();
    g.translate(P.x0, P.y0);
    g.beginPath();
    g.rect(0, 0, pw, ph);
    g.clip();

    var proj = base.proj;
    if (base.cv) {
      g.drawImage(base.cv, 0, 0, pw, ph);        /* 已缓存的真实海岸线底图 */
    } else {
      var r0 = paintBaseDirect(g, 'cyclone', 0, pw, ph);
      proj = r0.projector;
    }
    if (!proj) proj = localProj(100, 140, 18, 50, pw, ph, 6);

    function pr(lon, lat) { return proj.project(lon, lat); }

    /* 低压中心定在约 (122°E, 32°N)，用投影反推等压线/风场，保证与底图贴合 */
    var LON = 122, LAT = 32;
    var c0 = pr(LON, LAT);
    var e1 = pr(LON + 1, LAT), n1 = pr(LON, LAT + 1);
    var sxp = Math.max(0.001, e1.x - c0.x);      /* 每 1° 经度像素 */
    var syp = Math.max(0.001, c0.y - n1.y);      /* 每 1° 纬度像素（向北为正） */
    var cx = c0.x, cy = c0.y;
    var R = Math.max(70 * sc, Math.min(pw, ph) * 0.40);

    /* 屏幕偏移 → 经纬度 → 再投影：等压线是“经纬度化的椭圆” */
    function isoPoint(k, ang) {
      var basePx = R * (0.22 + 0.18 * k);
      var rr = basePx * (1 + 0.045 * Math.sin(3 * ang + 0.7 * k) +
        0.025 * Math.cos(2 * ang - k));
      return pr(LON + rr * Math.cos(ang) / sxp, LAT - rr * 0.82 * Math.sin(ang) / syp);
    }

    /* 低压中心光晕 */
    if (typeof g.createRadialGradient === 'function') {
      var glow = g.createRadialGradient(cx, cy, 2, cx, cy, R * 0.85);
      glow.addColorStop(0, 'rgba(255,120,110,0.16)');
      glow.addColorStop(0.55, 'rgba(120,90,150,0.07)');
      glow.addColorStop(1, 'rgba(5,7,15,0)');
      g.fillStyle = glow;
      g.beginPath();
      g.arc(cx, cy, R * 0.85, 0, TAU);
      g.fill();
    }

    /* 闭合等压线（越向外气压越高） */
    var k, i, ang;
    for (k = 1; k <= 5; k++) {
      g.beginPath();
      for (i = 0; i <= 96; i++) {
        var q = isoPoint(k, i / 96 * TAU);
        if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
      }
      g.closePath();
      g.strokeStyle = 'rgba(120,170,255,' + (k === 5 ? 0.40 : 0.28) + ')';
      g.lineWidth = k === 5 ? 1.6 : 1.1;
      g.stroke();
      if (labelsOn) {
        /* 数值标签沿西南→西北的弧线错开，避免内圈数值挤在一起 */
        var q2 = isoPoint(k, 2.05 + k * 0.30);
        haloText(g, String(996 + 4 * k), q2.x, q2.y,
          'rgba(150,190,255,0.72)', 9.5 * sc, 'center', false);
      }
    }

    /* 北半球气旋：逆时针辐合的风向箭头（两圈） */
    var ring, rings = [{ r: 0.60, n: 10, l: 0.21, al: 0.58 },
    { r: 1.02, n: 8, l: 0.15, al: 0.34 }];
    for (ring = 0; ring < rings.length; ring++) {
      var rg = rings[ring];
      for (i = 0; i < rg.n; i++) {
        ang = i * TAU / rg.n + 0.32 + ring * 0.2;
        var wx = cx + R * rg.r * Math.cos(ang);
        var wy = cy + R * rg.r * Math.sin(ang) * 0.9;
        /* 逆时针切向（画布 y 向下）+ 向内辐合 */
        var tdx = Math.sin(ang), tdy = -Math.cos(ang);
        var idx2 = -Math.cos(ang), idy = -Math.sin(ang);
        var dx = tdx * 0.86 + idx2 * 0.42;
        var dy = tdy * 0.86 + idy * 0.42;
        var dl = Math.sqrt(dx * dx + dy * dy) || 1;
        dx /= dl; dy /= dl;
        var alen = R * rg.l;
        drawArrow(g, wx, wy, wx + dx * alen, wy + dy * alen,
          'rgba(143,200,255,' + rg.al + ')', 1.4 * sc, 5.2 * sc);
      }
    }

    /* 锋线路径：真实经纬度 → 投影。冷锋向西南、暖锋向东南 */
    var coldGeo = [
      [122, 32], [120.2, 31.3], [118.4, 30.4], [116.6, 29.3],
      [114.6, 27.6], [112.8, 25.9], [112, 24]
    ];
    var warmGeo = [
      [122, 32], [123.6, 31.8], [125.4, 31.4], [127.4, 30.6],
      [129.4, 29.2], [131, 27.6], [132, 26]
    ];
    var coldPts = [], warmPts = [];
    for (i = 0; i < coldGeo.length; i++) coldPts.push(pr(coldGeo[i][0], coldGeo[i][1]));
    for (i = 0; i < warmGeo.length; i++) warmPts.push(pr(warmGeo[i][0], warmGeo[i][1]));

    /* 降水区：冷锋后（西北侧）+ 暖锋前（北侧） */
    var rainCold = offsetBand(coldPts, -1, R * 0.22);
    fillHatchPoly(g, rainCold, 'rgba(143,200,255,0.15)', 'rgba(143,200,255,0.42)', 9 * sc, 1);
    var rainWarm = offsetBand(warmPts, 1, R * 0.20);
    fillHatchPoly(g, rainWarm, 'rgba(143,200,255,0.15)', 'rgba(143,200,255,0.42)', 9 * sc, 1);

    /* 锋线本体 + 符号 */
    drawFront(g, coldPts, 'tri', C.cold, 2.6 * sc, 7.2 * sc, 1);
    drawFront(g, warmPts, 'semi', C.warmLine, 2.6 * sc, 7.2 * sc, 1);

    /* 海陆提示（很淡，不抢视线） */
    var lAsia = pr(107, 43), lPac = pr(136, 44);
    haloText(g, '亚欧大陆', lAsia.x, lAsia.y, 'rgba(200,215,245,0.32)', 10 * sc, 'center', false);
    haloText(g, '太平洋', lPac.x, lPac.y, 'rgba(160,200,255,0.32)', 10 * sc, 'center', false);

    if (!labelsOn) { g.restore(); return; }

    /* 低压中心：L 在上、说明文字移到 L 上方，避免与 B 站“过境时（冷锋）”重叠 */
    haloText(g, 'L', cx, cy - 5 * sc, '#ff8f86', 26 * sc, 'center', true);
    haloText(g, '低压中心 996 hPa', cx, cy - 38 * sc,
      'rgba(255,180,170,0.94)', 10 * sc, 'center', false);

    /* 锋面名称 */
    var iCold = pathInfo(coldPts), iWarm = pathInfo(warmPts);
    var pc = pointAt(iCold, iCold.total * 0.62);
    var nc = { x: pc.ty, y: -pc.tx };            /* 指向暖区一侧 */
    haloText(g, '冷锋', pc.x - nc.x * (20 * sc), pc.y - nc.y * (20 * sc),
      C.cold, 12.5 * sc, 'center', true);
    var pw2 = pointAt(iWarm, iWarm.total * 0.66);
    var nw = { x: pw2.ty, y: -pw2.tx };
    haloText(g, '暖锋', pw2.x + nw.x * (19 * sc), pw2.y + nw.y * (19 * sc),
      C.warmLine, 12.5 * sc, 'center', true);

    /* 降水区标签 */
    var pc2 = pointAt(iCold, iCold.total * 0.42);
    haloText(g, '降水区', pc2.x - nc.x * (R * 0.15), pc2.y - nc.y * (R * 0.15),
      '#bfe0ff', 10 * sc, 'center', true);
    var pw3 = pointAt(iWarm, iWarm.total * 0.5);
    haloText(g, '降水区', pw3.x + nw.x * (R * 0.14), pw3.y + nw.y * (R * 0.14),
      '#bfe0ff', 10 * sc, 'center', true);

    /* 观测站过境路线 A→B→C：自东南（暖区）向西北（冷气团）穿过冷锋 */
    var routeGeo = [[130.5, 25.0], [118.7, 30.0], [110.5, 32.8]];
    var route = [];
    for (i = 0; i < routeGeo.length; i++) route.push(pr(routeGeo[i][0], routeGeo[i][1]));

    g.save();
    g.setLineDash([6 * sc, 4 * sc]);
    g.strokeStyle = C.route;
    g.lineWidth = 1.6 * sc;
    polyline(g, route, false);
    g.restore();
    drawArrow(g, route[0].x, route[0].y, route[1].x, route[1].y, C.route, 1.5 * sc, 5.5 * sc);
    drawArrow(g, route[1].x, route[1].y, route[2].x, route[2].y, C.route, 1.5 * sc, 5.5 * sc);

    var names = ['A', 'B', 'C'];
    var rlabels = ['过境前（暖区）', '过境时（冷锋）', '过境后（冷气团）'];
    for (i = 0; i < route.length; i++) {
      var rp = route[i];
      g.fillStyle = 'rgba(5,7,15,0.85)';
      g.beginPath();
      g.arc(rp.x, rp.y, 7 * sc, 0, TAU);
      g.fill();
      g.strokeStyle = C.route;
      g.lineWidth = 1.6 * sc;
      g.stroke();
      haloText(g, names[i], rp.x, rp.y - 0.5 * sc, '#ffd6aa', 9 * sc, 'center', true);
    }
    haloText(g, rlabels[0], route[0].x + 11 * sc, route[0].y + 6 * sc,
      'rgba(255,214,170,0.95)', 10 * sc, 'left', true);
    haloText(g, rlabels[1], route[1].x + 11 * sc, route[1].y - 10 * sc,
      'rgba(255,214,170,0.95)', 10 * sc, 'left', true);
    haloText(g, rlabels[2], route[2].x + 11 * sc, route[2].y - 12 * sc,
      'rgba(255,214,170,0.95)', 10 * sc, 'left', true);

    /* 指北针 */
    var nax = pw - 24 * sc, nay = 30 * sc;
    drawArrow(g, nax, nay + 16 * sc, nax, nay, 'rgba(219,230,255,0.75)', 1.4 * sc, 5 * sc);
    haloText(g, 'N', nax, nay - 8 * sc, 'rgba(219,230,255,0.8)', 10 * sc, 'center', true);

    g.restore();
  }

  /* =================================================================
   * ② 我国锋面雨带
   * ================================================================= */
  /* 雨带位置：按月给真实经纬度范围（la/lb 为南/北界，lonA/lonB 为西/东界）。
     se 为西太平洋副高 588 线示意椭圆；dry 表示长江中下游同时出现伏旱。 */
  var MONTH_CFG = {
    4: {
      la: 21, lb: 27, lonA: 106, lonB: 120, key: '华南前汛期', name: '华南雨带',
      desc: '华南前汛期：雨带位于华南（21°—27°N），夏季风开始登陆，多暴雨',
      se: { lon: 124, lat: 20, rx: 7, ry: 3.4 }
    },
    5: {
      la: 21.5, lb: 28, lonA: 106, lonB: 121, key: '华南前汛期', name: '华南雨带',
      desc: '华南前汛期：暖湿气流与冷空气在华南交汇，雨带仍在 21°—27°N 一带',
      se: { lon: 126, lat: 21, rx: 7, ry: 3.4 }
    },
    6: {
      la: 28, lb: 33.5, lonA: 108, lonB: 122, key: '江淮梅雨', name: '江淮梅雨带',
      desc: '江淮梅雨：准静止锋在长江中下游摆动，阴雨连绵约一个月（6 月中—7 月上）',
      se: { lon: 127, lat: 23.5, rx: 7, ry: 3.5 }
    },
    7: {
      la: 34, lb: 44, lonA: 110, lonB: 132, key: '华北、东北', name: '华北·东北雨带',
      desc: '副高北跳，雨带北移到华北、东北；长江中下游受副高控制进入伏旱',
      se: { lon: 129, lat: 29, rx: 7.5, ry: 3.6 }, dry: true
    },
    8: {
      la: 36, lb: 48, lonA: 110, lonB: 132, key: '华北、东北', name: '华北·东北雨带',
      desc: '雨带到达东北、华北，北方进入雨季；南方伏旱持续',
      se: { lon: 130, lat: 31, rx: 7.5, ry: 3.6 }, dry: true
    },
    9: {
      la: 30, lb: 35, lonA: 110, lonB: 122, key: '南退（江南）', name: '雨带南退',
      desc: '夏季风减弱、副高南退，雨带迅速南压到江南，10 月退出大陆',
      se: { lon: 126, lat: 28.5, rx: 7, ry: 3.4 }
    }
  };

  /* 雨带多边形：上缘/下缘各加正弦扰动，看起来像一条有宽度的带 */
  function rainBandPoly(proj, cfg) {
    var pts = [], i, lon, wob;
    var steps = 24;
    for (i = 0; i <= steps; i++) {
      lon = cfg.lonA + (cfg.lonB - cfg.lonA) * i / steps;
      wob = 0.8 * Math.sin((lon - cfg.lonA) / (cfg.lonB - cfg.lonA) * Math.PI * 2.1 + 0.6);
      pts.push(proj.project(lon, cfg.lb + wob));
    }
    for (i = steps; i >= 0; i--) {
      lon = cfg.lonA + (cfg.lonB - cfg.lonA) * i / steps;
      wob = 0.6 * Math.sin((lon - cfg.lonA) / (cfg.lonB - cfg.lonA) * Math.PI * 1.7 + 1.9);
      pts.push(proj.project(lon, cfg.la + wob));
    }
    return pts;
  }

  /* 雨带内的小雨滴（斜短线），强化“多雨”观感 */
  function rainDrops(g, proj, cfg, sc) {
    g.strokeStyle = 'rgba(185,228,255,0.80)';
    g.lineWidth = 1.4 * sc;
    g.lineCap = 'round';
    var i, lon, lat, p;
    for (i = 0; i < 10; i++) {
      lon = cfg.lonA + (cfg.lonB - cfg.lonA) * (i + 0.5) / 10;
      lat = cfg.la + (cfg.lb - cfg.la) * (0.32 + 0.34 * ((i * 5) % 3) / 2);
      p = proj.project(lon, lat);
      g.beginPath();
      g.moveTo(p.x - 2.4 * sc, p.y + 3.2 * sc);
      g.lineTo(p.x + 1.6 * sc, p.y - 3.6 * sc);
      g.stroke();
    }
  }

  /* 雨带中部的锋面（亮粉虚线） */
  function dashedFrontLine(g, proj, cfg, sc) {
    var midLat = (cfg.la + cfg.lb) / 2;
    var pts = [], i, lon, wob;
    for (i = 0; i <= 24; i++) {
      lon = cfg.lonA + (cfg.lonB - cfg.lonA) * i / 24;
      wob = 0.55 * Math.sin((lon - cfg.lonA) / (cfg.lonB - cfg.lonA) * Math.PI * 1.8 + 0.4);
      pts.push(proj.project(lon, midLat + wob));
    }
    g.save();
    g.setLineDash([7 * sc, 5 * sc]);
    g.strokeStyle = 'rgba(255,170,210,0.98)';
    g.lineWidth = 2.4 * sc;
    g.lineCap = 'round';
    polyline(g, pts, false);
    g.restore();
  }

  /* 西太平洋副高 588 线示意（金色虚线椭圆） */
  function drawSE588(g, proj, cfg, sc) {
    var se = cfg.se;
    var i, p;
    g.save();
    g.setLineDash([7 * sc, 5 * sc]);
    g.strokeStyle = 'rgba(255,216,132,0.94)';
    g.lineWidth = 1.8 * sc;
    g.beginPath();
    for (i = 0; i <= 48; i++) {
      var a = i / 48 * TAU;
      p = proj.project(se.lon + se.rx * Math.cos(a), se.lat + se.ry * Math.sin(a) * 0.82);
      if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
    }
    g.closePath();
    g.stroke();
    g.restore();
    var lp = proj.project(se.lon + se.rx * 0.72, se.lat + se.ry * 0.98);
    haloText(g, '588 线（西太副高）', lp.x, lp.y - 4 * sc,
      'rgba(255,216,132,0.96)', 10 * sc, 'center', false);
  }

  /* 城市：按月份选 4 个，落在雨带纬度内的金色高亮 */
  function drawRainCities(g, proj, cfg, month, sc, labelsOn) {
    var all = [
      { n: '广州', lon: 113.26, lat: 23.13 },
      { n: '武汉', lon: 114.30, lat: 30.59 },
      { n: '上海', lon: 121.47, lat: 31.23 },
      { n: '北京', lon: 116.41, lat: 39.90 },
      { n: '哈尔滨', lon: 126.53, lat: 45.80 }
    ];
    var want = (month === 7 || month === 8)
      ? ['武汉', '上海', '北京', '哈尔滨']
      : ['广州', '武汉', '上海', '北京'];
    var i;
    for (i = 0; i < all.length; i++) {
      var ct = all[i];
      if (want.indexOf(ct.n) < 0) continue;
      var inBand = ct.lat >= cfg.la - 0.9 && ct.lat <= cfg.lb + 0.9;
      var p = proj.project(ct.lon, ct.lat);
      if (inBand) {
        g.beginPath();
        g.arc(p.x, p.y, 6.2 * sc, 0, TAU);
        g.fillStyle = 'rgba(255,211,107,0.24)';
        g.fill();
        g.strokeStyle = 'rgba(255,211,107,0.95)';
        g.lineWidth = 1.4 * sc;
        g.stroke();
      }
      g.beginPath();
      g.arc(p.x, p.y, 3.2 * sc, 0, TAU);
      g.fillStyle = inBand ? '#ffd36b' : 'rgba(219,230,255,0.92)';
      g.fill();
      if (labelsOn) {
        haloText(g, ct.n, p.x + 8 * sc, p.y - 7 * sc,
          inBand ? '#ffe08a' : 'rgba(219,230,255,0.82)', 10.5 * sc, 'left', inBand);
      }
    }
  }

  /* 左上角月份说明卡：月份 + 雨带位置 + 说明 + 推移规律 */
  function drawMonthCard(g, sc, month, cfg, labelsOn) {
    var cardW = 276 * sc, cardH = 106 * sc;
    panel(g, 8 * sc, 8 * sc, cardW, cardH, 10 * sc,
      'rgba(12,20,38,0.88)', 'rgba(143,200,255,0.30)', 1);
    if (!labelsOn) return;
    haloText(g, month + ' 月', 22 * sc, 30 * sc, C.accent, 21 * sc, 'left', true);
    haloText(g, '雨带：' + cfg.key, 74 * sc, 27 * sc, C.text, 12.5 * sc, 'left', true);
    setFont(g, 10 * sc, false);
    var lines = wrapLines(g, cfg.desc, cardW - 28 * sc);
    if (lines.length > 2) lines = lines.slice(0, 2);
    for (var i = 0; i < lines.length; i++) {
      haloText(g, lines[i], 22 * sc, (54 + i * 16) * sc, C.dim, 10 * sc, 'left', false);
    }
    haloText(g, '规律：雨带随副高北进南退', 22 * sc, 94 * sc,
      'rgba(255,210,120,0.82)', 9.5 * sc, 'left', false);
  }

  function drawRainbelt(g, P, w, h, S, F, sc, cache) {
    var month = clamp(Math.round(num(S.month, 6)), 4, 9);
    var cfg = MONTH_CFG[month];
    var labelsOn = !(S.show && S.show.labels === false);
    var pw = Math.max(2, P.x1 - P.x0), ph = Math.max(2, P.y1 - P.y0);

    /* 进入绘图区：平移到 P 左上角，底图与动态层用底图内坐标 */
    g.save();
    g.translate(P.x0, P.y0);
    g.beginPath();
    g.rect(0, 0, pw, ph);
    g.clip();

    /* 底图：真实中国地图（LCC 投影 + 南海诸岛插图），离屏缓存 */
    var base = ensureBase(g, cache, 'rainbelt', month, pw, ph);
    var proj = base.proj;
    if (base.cv) {
      g.drawImage(base.cv, 0, 0, pw, ph);
    } else {
      var r0 = paintBaseDirect(g, 'rainbelt', month, pw, ph);
      proj = r0.projector;
    }
    if (!proj) proj = localProj(73, 135, 17, 54, pw, ph, 8);

    graticule(g, proj, sc, 74, 136, 18, 52);

    /* 锋面雨带：用省界陆地多边形裁剪，海上不落雨 */
    var bandPts = rainBandPoly(proj, cfg);
    var clipped = false;
    if (base.landPath) {
      g.save();
      g.clip(base.landPath);
      clipped = true;
    } else if (base.geoOK && addLandPath(g, proj)) {
      g.save();
      g.clip();
      clipped = true;
    }
    fillHatchPoly(g, bandPts, 'rgba(143,200,255,0.30)',
      'rgba(170,220,255,0.78)', 8 * sc, 1.1);
    rainDrops(g, proj, cfg, sc);
    dashedFrontLine(g, proj, cfg, sc);
    if (clipped) g.restore();

    /* 西太平洋副高 588 线示意 */
    drawSE588(g, proj, cfg, sc);

    /* 城市（雨带内高亮） */
    drawRainCities(g, proj, cfg, month, sc, labelsOn);

    /* 雨带名称 */
    var lbl = proj.project((cfg.lonA + cfg.lonB) / 2 - (cfg.lonB - cfg.lonA) * 0.12, cfg.lb + 1.6);
    haloText(g, cfg.name, lbl.x, lbl.y - 4 * sc, '#e8f4ff', 11.5 * sc, 'center', true);

    /* 7—8 月：长江中下游受副高控制出现伏旱（标在城市以南，避免压住城市名） */
    if (cfg.dry && labelsOn) {
      var dp = proj.project(115.4, 27.2);
      haloText(g, '长江中下游 · 伏旱', dp.x, dp.y + 4 * sc,
        'rgba(255,200,140,0.95)', 10 * sc, 'center', true);
    }

    /* 左上角月份 + 雨带位置说明卡 */
    drawMonthCard(g, sc, month, cfg, labelsOn);

    g.restore();
  }

  /* =================================================================
   * ③ 锋面符号判读卡
   * ================================================================= */
  function drawSymbolCard(g, box, type, selected, sc, F) {
    var m = typeMeta(F, type);
    var col = m.color;
    var padX = 13 * sc;
    var i;

    g.save();
    if (selected) {
      g.shadowColor = col;
      g.shadowBlur = 14 * sc;
    }
    panel(g, box.x, box.y, box.w, box.h, 12 * sc,
      selected ? 'rgba(30,48,80,0.98)' : 'rgba(16,24,42,0.80)',
      selected ? col : C.line, selected ? 2 : 1);
    g.restore();

    /* 标题行 */
    haloText(g, m.name, box.x + padX, box.y + 21 * sc, col, 16 * sc, 'left', true);
    haloText(g, m.glyph, box.x + box.w - padX, box.y + 20 * sc, col, 17 * sc, 'right', true);
    g.strokeStyle = 'rgba(150,180,230,0.16)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(box.x + padX, box.y + 34 * sc);
    g.lineTo(box.x + box.w - padX, box.y + 34 * sc);
    g.stroke();

    /* 符号行 */
    var sy = box.y + 66 * sc;
    var x0 = box.x + padX, x1 = box.x + box.w - padX;
    if (x1 - x0 > 40) {
      var seg = [{ x: x0, y: sy }, { x: x1, y: sy }];
      g.strokeStyle = col;
      g.lineWidth = 2.2 * sc;
      g.lineCap = 'round';
      polyline(g, seg, false);
      var size = clamp((x1 - x0) * 0.055, 4.5 * sc, 8.5 * sc);
      if (type === 'stationary') symbolsAlong(g, seg, 'mix', size, size * 2.7, col, 1);
      else symbolsAlong(g, seg, type === 'cold' ? 'tri' : 'semi', size, size * 2.7, col, 1);
    }

    /* 移动方向提示（准静止锋除外）：画在符号线上方，避免压住符号 */
    if (type !== 'stationary') {
      var ax2 = x1 - 6 * sc;
      var ay = sy - 19 * sc;
      drawArrow(g, ax2 - 26 * sc, ay, ax2, ay, col, 1.3 * sc, 4.5 * sc);
      haloText(g, '移动方向', ax2 - 30 * sc, ay + 3 * sc, C.dim, 8.5 * sc, 'right', false);
    }

    /* 要点行 */
    var rows = [
      ['移动', m.motion],
      ['降水', m.rain],
      ['实例', m.example]
    ];
    var maxW = box.w - padX * 2;
    var ry = sy + 24 * sc;
    var rowH = 26 * sc;
    for (i = 0; i < rows.length; i++) {
      if (ry + 10 * sc > box.y + box.h - 8 * sc) break;
      haloText(g, rows[i][0], box.x + padX, ry, 'rgba(219,230,255,0.46)', 9.5 * sc, 'left', true);
      haloText(g, fitText(g, rows[i][1], maxW - 26 * sc, 10 * sc),
        box.x + padX + 26 * sc, ry, C.text, 10 * sc, 'left', false);
      ry += rowH;
    }

    if (selected && box.h > 150 * sc) {
      haloText(g, '已选中 · 再点一次取消', box.x + box.w - padX, box.y + box.h - 12 * sc,
        col, 8.5 * sc, 'right', false);
    }
  }

  function drawSymbols(g, P, w, h, S, F, sc, sel, hits) {
    var gap = 12 * sc;
    var pw = P.x1 - P.x0, ph = P.y1 - P.y0;
    var horiz = pw >= 3 * 190 * sc;
    var cards = [], i;
    if (horiz) {
      var cw = (pw - 2 * gap) / 3;
      var ch = Math.min(ph, 212 * sc);
      var y0 = P.y0 + (ph - ch) / 2;
      for (i = 0; i < 3; i++) cards.push({ x: P.x0 + i * (cw + gap), y: y0, w: cw, h: ch });
    } else {
      var ch2 = (ph - 2 * gap) / 3;
      for (i = 0; i < 3; i++) cards.push({ x: P.x0, y: P.y0 + i * (ch2 + gap), w: pw, h: ch2 });
    }
    var types = ['cold', 'warm', 'stationary'];
    for (i = 0; i < 3; i++) {
      drawSymbolCard(g, cards[i], types[i], i === sel, sc, F);
      hits.push({ x: cards[i].x, y: cards[i].y, w: cards[i].w, h: cards[i].h, idx: i });
    }
  }

  /* =================================================================
   * 工厂
   * ================================================================= */
  window.MODELS = window.MODELS || {};
  window.MODELS.M3 = function createM3(ctx) {
    ctx = ctx || {};
    var canvas = ctx.canvas || null;
    var hits = [];
    var sel = -1;
    var lastArgs = null;
    /* 底图离屏缓存：仅当 模式/月份/尺寸/DPR/地图数据就绪 变化时才重绘底图 */
    var baseCache = { key: '' };

    function draw(c2d, w, h, state, FRONT) {
      if (!c2d || !(w > 1) || !(h > 1)) return;
      lastArgs = [c2d, w, h, state, FRONT];
      var S = state || {};
      var F = FRONT || global.FRONT;
      var mode = S.mapMode;
      if (mode !== 'rainbelt' && mode !== 'symbols') mode = 'cyclone';
      var sc = w < 820 ? 0.85 : 1;
      var info = modeInfo(mode, S, F);

      c2d.save();
      c2d.clearRect(0, 0, w, h);
      c2d.lineCap = 'round';
      c2d.lineJoin = 'round';
      c2d.setLineDash([]);

      /* 标题下移：页面顶部有浮层按钮（模式切换/月份滑条/阶段徽标），
         y < 58px 内除背景外不画任何文字；标题放 y≈64–96 左侧，右侧留空。 */
      haloText(c2d, info.title, 16 * sc, 82 * sc, C.text, 15 * sc, 'left', true);
      haloText(c2d, info.sub, 17 * sc, 99 * sc,
        'rgba(219,230,255,0.52)', 10.5 * sc, 'left', false);

      /* 先算底部图例/说明所占高度，再定绘图区 */
      var maxLegendW = w - 64 * sc;
      setFont(c2d, 10.5 * sc, false);
      var rows = legendRows(c2d, info.legend, maxLegendW, sc);
      var noteLines;
      setFont(c2d, 10.5 * sc, false);
      noteLines = wrapLines(c2d, info.note, maxLegendW);
      if (noteLines.length > 2) noteLines = noteLines.slice(0, 2);
      var bh = (14 + rows.length * 19 + noteLines.length * 16 + 8) * sc;
      bh = Math.min(bh, h * 0.4);

      var P = {
        x0: 14 * sc,
        x1: w - 14 * sc,
        y0: Math.min(118 * sc, Math.max(78 * sc, h * 0.17)),
        y1: h - bh - 14 * sc
      };
      if (P.y1 - P.y0 < 40 * sc) P.y0 = Math.max(20 * sc, P.y1 - 40 * sc);

      /* 绘图区裁剪，内容不侵入底部面板 */
      c2d.save();
      c2d.beginPath();
      c2d.rect(P.x0, P.y0, Math.max(1, P.x1 - P.x0), Math.max(1, P.y1 - P.y0));
      c2d.clip();

      hits.length = 0;
      if (mode === 'rainbelt') drawRainbelt(c2d, P, w, h, S, F, sc, baseCache);
      else if (mode === 'symbols') drawSymbols(c2d, P, w, h, S, F, sc, sel, hits);
      else drawCyclone(c2d, P, w, h, S, F, sc, baseCache);
      c2d.restore();

      /* 底部面板：图例 + 说明 */
      var by = h - bh - 10 * sc;
      panel(c2d, 12 * sc, by, w - 24 * sc, bh, 10 * sc,
        'rgba(12,20,38,0.80)', 'rgba(150,180,230,0.18)', 1);
      setFont(c2d, 10.5 * sc, false);
      drawLegend(c2d, rows, 24 * sc, by + 15 * sc, sc);
      var ny = by + (14 + rows.length * 19) * sc + 8 * sc;
      for (var i = 0; i < noteLines.length; i++) {
        haloText(c2d, noteLines[i], 24 * sc, ny + i * 16 * sc,
          'rgba(219,230,255,0.62)', 10.5 * sc, 'left', false);
      }

      c2d.restore();
    }

    /* ---- 符号卡片点击高亮（局部状态，不改 state） ---- */
    function localXY(e) {
      var x = 0, y = 0;
      if (e && typeof e.offsetX === 'number') {
        x = e.offsetX; y = e.offsetY;
      } else if (e && canvas && canvas.getBoundingClientRect) {
        var r = canvas.getBoundingClientRect();
        x = (e.clientX || 0) - r.left;
        y = (e.clientY || 0) - r.top;
      }
      return { x: x, y: y };
    }

    function hitIndex(x, y) {
      for (var i = 0; i < hits.length; i++) {
        var b = hits[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.idx;
      }
      return -1;
    }

    function modeOfLast() {
      if (!lastArgs) return '';
      var st = lastArgs[3] || {};
      return st.mapMode || 'cyclone';
    }

    function onDown(e) {
      if (modeOfLast() !== 'symbols' || !lastArgs) return;
      var p = localXY(e);
      var idx = hitIndex(p.x, p.y);
      if (idx < 0) return;
      sel = (sel === idx) ? -1 : idx;
      try { draw.apply(null, lastArgs); } catch (err) { /* 忽略重绘异常 */ }
      if (e.preventDefault) e.preventDefault();
    }

    function onMove(e) {
      if (!canvas || !canvas.style) return;
      if (modeOfLast() !== 'symbols') {
        canvas.style.cursor = '';
        return;
      }
      var p = localXY(e);
      canvas.style.cursor = hitIndex(p.x, p.y) >= 0 ? 'pointer' : '';
    }

    function onLeave() {
      if (canvas && canvas.style) canvas.style.cursor = '';
    }

    if (canvas && canvas.addEventListener) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerleave', onLeave);
    }

    return {
      draw: draw,
      resize: function (w, h) { /* 每帧自适应，无需缓存 */ },
      dispose: function () {
        if (canvas && canvas.removeEventListener) {
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerleave', onLeave);
        }
        hits.length = 0;
        lastArgs = null;
        sel = -1;
      }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
