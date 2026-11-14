/* ============================================================
 * m2-section.js — M2 锋面剖面图解（Canvas 2D）
 * 依赖：window.FRONT（统一数据源，必需）；window.H（可选，缺失时用内置实现）
 * API：window.MODELS.M2 = function (ctx) -> { draw, resize, dispose }
 *
 * 坐标约定（与 3D / 天气图一致）：
 *   世界 x ∈ [-L, L]，+x 指向暖气团一侧；观测站固定在 x = 0；
 *   屏幕 y 向下，地面线 y = groundY，天空区域 plotTop..groundY。
 *   冷锋/准静止锋：冷气团在 x < xFront（左侧楔形，向 -x 抬升）；
 *   暖锋：冷气团在 x > xFront（右侧楔形，向 +x 抬升）。
 * 说明：每帧重画、不缓存；c2d 已按 devicePixelRatio 缩放，全部用 CSS 像素。
 * ============================================================ */
(function (global) {
  'use strict';

  var FONT = '"PingFang SC","Microsoft YaHei",sans-serif';

  /* 契约配色 C 表（与全局样式一致） */
  var C = {
    bg: '#05070f',
    panel: 'rgba(16,24,42,0.72)',
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
    warn: '#ffb454'
  };

  /* ---------- 小工具 ---------- */
  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* #rrggbb -> rgba(r,g,b,a) */
  function rgba(hex, a) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var n = parseInt(h, 16);
    if (!isFinite(n)) return 'rgba(78,161,255,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function setFont(g, size, bold) {
    g.font = (bold ? 'bold ' : '') + size.toFixed(1) + 'px ' + FONT;
  }
  /* 带描边黑边的文字（深色画布上保证可读） */
  function haloText(g, text, x, y, color, size, align, bold) {
    setFont(g, size, bold);
    g.textAlign = align || 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(5,7,15,0.88)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }
  /* 圆角矩形（自己实现，避免依赖 ctx.roundRect） */
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r);
    g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h);
    g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.closePath();
  }
  /* 箭头（带三角箭头，颜色随气流） */
  function arrow(g, x0, y0, x1, y1, color, width, head) {
    var ang = Math.atan2(y1 - y0, x1 - x0);
    var dx = x1 - x0, dy = y1 - y0;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 2) return;
    if (head > d * 0.6) head = d * 0.6;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1 - Math.cos(ang) * head * 0.72, y1 - Math.sin(ang) * head * 0.72);
    g.stroke();
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x1 - Math.cos(ang - 0.42) * head, y1 - Math.sin(ang - 0.42) * head);
    g.lineTo(x1 - Math.cos(ang + 0.42) * head, y1 - Math.sin(ang + 0.42) * head);
    g.closePath();
    g.fill();
  }
  /* 稳定伪随机（同一帧内雨滴 / 云朵位置不闪烁） */
  function hash01(i) {
    var x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  global.MODELS = global.MODELS || {};

  global.MODELS.M2 = function createM2(ctx) {
    return {
      draw: function (c2d, w, h, state, FRONT) {
        var F = FRONT || global.FRONT;
        if (!c2d || !F || !F.meta || !(w > 1) || !(h > 1)) return;
        var S = state || {};
        var show = S.show || {};
        var on = function (key) { return show[key] !== false; };
        var type = F.meta[S.type] ? S.type : 'cold';
        var m = F.meta[type];
        var p = F.clamp01(num(S.t, 0));
        var cur = F.curve(type, p);
        var now = Date.now() / 1000;

        var mobile = w < 820;
        var fs = mobile ? 0.85 : 1;      /* 字号缩放 */
        var K = function (v) { return v * fs; };

        /* ---------- 版面 ---------- */
        var padX = mobile ? 10 : 18;
        var headerH = mobile ? 52 : 58;
        var legendH = mobile ? 68 : 78;
        var plotL = padX;
        var plotR = w - padX;
        var plotW = Math.max(60, plotR - plotL);
        var groundY = h - legendH;
        var plotTop = headerH + 6;
        var skyH = Math.max(40, groundY - plotTop);

        /* ---------- 世界坐标 -> 屏幕坐标 ---------- */
        var L = F.L;
        var xf = F.xFront(type, p);
        var pxPerW = plotW / (2 * L);
        var x2s = function (wx) { return plotL + (wx + L) * pxPerW; };
        var s2w = function (px) { return (px - plotL) / pxPerW - L; };
        var sx = x2s(xf);
        var coldLeft = (type !== 'warm');   /* 冷气团是否在锋线左侧 */

        /* 锋面视觉坡度放大系数：把 meta.slope(0.09~0.22) 放大到看得清 */
        var EXAG = 4.2;
        function fracAt(wx) {
          var d = coldLeft ? (xf - wx) : (wx - xf);
          if (d <= 0) return 0;
          return clamp(d / L * m.slope * EXAG, 0, 0.97);
        }
        function yFront(wx) { return groundY - skyH * fracAt(wx); }

        /* 云的底部（雨滴起点） */
        function cloudBaseAt(px) {
          var wx = s2w(px);
          if (type === 'cold') return Math.min(yFront(wx), groundY - skyH * 0.15) - skyH * 0.02;
          return groundY - skyH * 0.33;
        }

        c2d.save();
        c2d.clearRect(0, 0, w, h);
        c2d.lineCap = 'round';
        c2d.lineJoin = 'round';
        c2d.setLineDash([]);

        /* ---------- 1. 暖气团底色（整个天空） ---------- */
        var warmGrad = c2d.createLinearGradient(0, plotTop, 0, groundY);
        warmGrad.addColorStop(0, rgba(C.warm, 0.075));
        warmGrad.addColorStop(1, rgba(C.warm, 0.028));
        c2d.fillStyle = warmGrad;
        c2d.fillRect(plotL, plotTop, plotW, skyH);
        /* 顶部压暗，做出纵深 */
        var skyGrad = c2d.createLinearGradient(0, plotTop, 0, plotTop + skyH * 0.55);
        skyGrad.addColorStop(0, 'rgba(5,7,15,0.55)');
        skyGrad.addColorStop(1, 'rgba(5,7,15,0)');
        c2d.fillStyle = skyGrad;
        c2d.fillRect(plotL, plotTop, plotW, skyH * 0.55);

        /* ---------- 2. 冷气团楔形块 ---------- */
        var coldEdgePx = clamp(sx, plotL, plotR);
        var wedgeTopFrac = 0;
        (function drawColdMass() {
          if (coldLeft) {
            if (sx <= plotL) return;
          } else {
            if (sx >= plotR) return;
          }
          c2d.beginPath();
          c2d.moveTo(coldEdgePx, groundY);
          var px, wx, step = 6;
          if (coldLeft) {
            for (px = coldEdgePx; px > plotL; px -= step) {
              wx = s2w(px);
              c2d.lineTo(px, yFront(wx));
              wedgeTopFrac = Math.max(wedgeTopFrac, fracAt(wx));
            }
            c2d.lineTo(plotL, yFront(-L));
            c2d.lineTo(plotL, groundY);
          } else {
            for (px = coldEdgePx; px < plotR; px += step) {
              wx = s2w(px);
              c2d.lineTo(px, yFront(wx));
              wedgeTopFrac = Math.max(wedgeTopFrac, fracAt(wx));
            }
            c2d.lineTo(plotR, yFront(L));
            c2d.lineTo(plotR, groundY);
          }
          c2d.closePath();
          var cg = c2d.createLinearGradient(0, groundY - skyH * 0.85, 0, groundY);
          cg.addColorStop(0, rgba(C.cold, 0.10));
          cg.addColorStop(0.55, rgba(C.cold, 0.20));
          cg.addColorStop(1, rgba(C.cold, 0.34));
          c2d.fillStyle = cg;
          c2d.fill();
        })();

        /* ---------- 3. 锋面（亮白斜面 + 纹理刻线） ---------- */
        (function drawFrontSurface() {
          var pts = [];
          var px, step = 4;
          if (coldLeft) {
            if (sx <= plotL) return;
            for (px = coldEdgePx; px >= plotL; px -= step) pts.push({ x: px, y: yFront(s2w(px)) });
            if (pts.length && pts[pts.length - 1].x > plotL) pts.push({ x: plotL, y: yFront(-L) });
          } else {
            if (sx >= plotR) return;
            for (px = coldEdgePx; px <= plotR; px += step) pts.push({ x: px, y: yFront(s2w(px)) });
            if (pts.length && pts[pts.length - 1].x < plotR) pts.push({ x: plotR, y: yFront(L) });
          }
          if (pts.length < 2) return;

          /* 斜面上的细刻线（表现"面"而非"线"） */
          c2d.strokeStyle = 'rgba(210,232,255,0.16)';
          c2d.lineWidth = 1;
          for (var i = 0; i < pts.length; i += 9) {
            var q = pts[i];
            c2d.beginPath();
            c2d.moveTo(q.x, q.y);
            c2d.lineTo(q.x, q.y + K(7));
            c2d.stroke();
          }

          /* 主锋面线 */
          c2d.beginPath();
          c2d.moveTo(pts[0].x, pts[0].y);
          for (i = 1; i < pts.length; i++) c2d.lineTo(pts[i].x, pts[i].y);
          c2d.shadowColor = 'rgba(200,228,255,0.55)';
          c2d.shadowBlur = 9;
          c2d.strokeStyle = 'rgba(232,242,255,0.92)';
          c2d.lineWidth = 2.2;
          c2d.stroke();
          c2d.shadowBlur = 0;

          /* 与地面交会处的亮点 */
          c2d.beginPath();
          c2d.arc(coldEdgePx, groundY, K(3.2), 0, Math.PI * 2);
          c2d.fillStyle = 'rgba(232,242,255,0.95)';
          c2d.fill();
        })();

        /* ---------- 4. 云 ---------- */
        if (on('clouds') && (type === 'cold' ? cloudVisible() : true)) {
          drawClouds();
        }
        function cloudVisible() {
          var sp = F.span(type, p, 'cloud');
          return x2s(sp.x1) > plotL && x2s(sp.x0) < plotR;
        }
        function drawClouds() {
          var sp = F.span(type, p, 'cloud');
          var cx0 = clamp(x2s(sp.x0), plotL, plotR);
          var cx1 = clamp(x2s(sp.x1), plotL, plotR);
          if (cx1 - cx0 < 14) return;
          if (type === 'cold') {
            /* 积雨云：沿锋面升起的垂直云柱 + 云砧 */
            var n = 7, i, j;
            for (i = 0; i < n; i++) {
              var t = i / (n - 1);
              var px = cx0 + (cx1 - cx0) * (0.10 + 0.78 * t);
              var base = cloudBaseAt(px);
              var env = Math.sin(Math.PI * (0.16 + 0.66 * t));
              var top = base - skyH * (0.26 + 0.46 * env);
              var colW = (cx1 - cx0) / n * 1.55;
              for (j = 0; j < 5; j++) {
                var u = j / 4;
                var py = base + (top - base) * u;
                var rad = colW * (0.52 + 0.30 * Math.sin(Math.PI * (0.15 + 0.7 * u)));
                var wob = (hash01(i * 13 + j * 7) - 0.5) * colW * 0.45;
                c2d.beginPath();
                c2d.arc(px + wob, py, Math.max(4, rad), 0, Math.PI * 2);
                c2d.fillStyle = rgba(C.cloud, 0.052);
                c2d.fill();
              }
              /* 云砧（顶部平展） */
              if (env > 0.5) {
                for (j = -2; j <= 2; j++) {
                  c2d.beginPath();
                  c2d.ellipse(px + j * colW * 0.55, top - K(2), colW * 0.85, K(5),
                    0, 0, Math.PI * 2);
                  c2d.fillStyle = rgba(C.cloud, 0.05);
                  c2d.fill();
                }
              }
            }
            /* 云体轮廓 */
            c2d.strokeStyle = 'rgba(207,216,234,0.20)';
            c2d.lineWidth = 1;
            c2d.beginPath();
            for (i = 0; i < n; i++) {
              var t2 = i / (n - 1);
              var p2 = cx0 + (cx1 - cx0) * (0.10 + 0.78 * t2);
              var b2 = cloudBaseAt(p2);
              var e2 = Math.sin(Math.PI * (0.16 + 0.66 * t2));
              var tp2 = b2 - skyH * (0.26 + 0.46 * e2);
              if (i === 0) c2d.moveTo(p2, tp2);
              else c2d.lineTo(p2, tp2);
            }
            c2d.stroke();
          } else {
            /* 暖锋 / 准静止锋：层状云，水平铺开、层层叠置 */
            var heavy = (type === 'stationary');
            var levels = heavy ? 7 : 6;
            var baseY = groundY - skyH * (heavy ? 0.30 : 0.33);
            var i2, j2;
            for (i2 = 0; i2 < levels; i2++) {
              var u2 = i2 / (levels - 1);                 /* 0 = 低层（雨层云） */
              var y2 = baseY - u2 * skyH * (heavy ? 0.34 : 0.30);
              var shrink = u2 * 0.24;
              var lx = cx0 + (cx1 - cx0) * (0.04 + shrink * 0.5);
              var rx = cx1 - (cx1 - cx0) * (0.02 + shrink * 0.5);
              if (rx - lx < 8) continue;
              var ry = K(4.5) + (1 - u2) * K(4) * (heavy ? 1.15 : 1);
              var nb = 14;
              for (j2 = 0; j2 < nb; j2++) {
                var tt = j2 / (nb - 1);
                var px2 = lx + (rx - lx) * tt;
                var wob2 = (hash01(i2 * 31 + j2 * 13) - 0.5) * K(2.4);
                c2d.beginPath();
                c2d.ellipse(px2, y2 + wob2, (rx - lx) / nb * 0.92, ry, 0, 0, Math.PI * 2);
                c2d.fillStyle = rgba(C.cloud, 0.042 + 0.030 * (1 - u2));
                c2d.fill();
              }
            }
            /* 云底阴影 */
            c2d.strokeStyle = 'rgba(207,216,234,0.20)';
            c2d.lineWidth = 1.4;
            c2d.beginPath();
            c2d.moveTo(cx0, baseY + K(2));
            c2d.lineTo(cx1, baseY + K(2));
            c2d.stroke();
          }
        }

        /* ---------- 5. 降水（雨 / 雪） ---------- */
        var isSnow = (cur.temp < 0) || (S.snow === true);   /* 曲线温度 <0 时画雪花；也可由外部 state.snow 强制 */
        if (on('rain')) drawRain();

        function drawSnowFlake(x, y, r) {
          c2d.strokeStyle = 'rgba(226,240,255,0.9)';
          c2d.lineWidth = 1;
          c2d.beginPath();
          for (var a = 0; a < 3; a++) {
            var th = a * Math.PI / 3;
            c2d.moveTo(x - Math.cos(th) * r, y - Math.sin(th) * r);
            c2d.lineTo(x + Math.cos(th) * r, y + Math.sin(th) * r);
          }
          c2d.stroke();
        }

        function drawRain() {
          var sp = F.span(type, p, 'rain');
          var rx0 = clamp(x2s(sp.x0), plotL, plotR);
          var rx1 = clamp(x2s(sp.x1), plotL, plotR);
          if (rx1 - rx0 < 8) return;
          var inten = clamp(cur.rain, 0, 1);
          if (inten <= 0.02) return;

          /* 雨幕：一条自上而下的浅蓝光带 */
          var topY = type === 'cold' ? groundY - skyH * 0.30 : groundY - skyH * 0.33;
          var rg = c2d.createLinearGradient(0, topY, 0, groundY);
          rg.addColorStop(0, rgba(C.rain, 0));
          rg.addColorStop(0.55, rgba(C.rain, 0.04 + 0.06 * inten));
          rg.addColorStop(1, rgba(C.rain, 0.09 + 0.08 * inten));
          c2d.fillStyle = rg;
          c2d.fillRect(rx0, topY, rx1 - rx0, groundY - topY);

          var count = Math.round((mobile ? 58 : 88) + (mobile ? 38 : 58) * inten);
          for (var i = 0; i < count; i++) {
            var u = hash01(i * 1.73 + 0.41);
            var px = rx0 + u * (rx1 - rx0);
            var baseY = cloudBaseAt(px);
            var fall = Math.max(14, groundY - baseY);
            var ph = (now * (0.45 + 0.85 * inten) + hash01(i * 5.31)) % 1;
            var py = baseY + ph * fall;
            var fade = 0.28 + 0.5 * inten * (0.55 + 0.45 * hash01(i * 9.17));
            if (isSnow) {
              var sway = Math.sin(now * 1.1 + i * 0.7) * K(3);
              drawSnowFlake(px + sway, py, K(2.4) + K(1.2) * hash01(i * 3.3));
              continue;
            }
            var len = K(6) + K(5) * inten;
            c2d.strokeStyle = rgba(C.rain, fade);
            c2d.lineWidth = 1.2;
            c2d.beginPath();
            c2d.moveTo(px, py);
            c2d.lineTo(px - len * 0.24, py + len);
            c2d.stroke();
            /* 落地涟漪 */
            if (i % 3 === 0 && ph > 0.86) {
              var a2 = (ph - 0.86) / 0.14;
              c2d.strokeStyle = rgba(C.rain, 0.42 * (1 - a2));
              c2d.lineWidth = 1;
              c2d.beginPath();
              c2d.ellipse(px, groundY, K(3.5) + K(6) * a2, K(1.2) + K(1.8) * a2, 0, 0, Math.PI * 2);
              c2d.stroke();
            }
          }
        }

        /* ---------- 6. 地面 ---------- */
        (function drawGround() {
          var gg = c2d.createLinearGradient(0, groundY, 0, h);
          gg.addColorStop(0, 'rgba(12,18,32,0.55)');
          gg.addColorStop(1, 'rgba(6,9,18,0.15)');
          c2d.fillStyle = gg;
          c2d.fillRect(0, groundY, w, Math.max(0, h - groundY));
          /* 土壤斜纹 */
          c2d.strokeStyle = 'rgba(150,180,230,0.10)';
          c2d.lineWidth = 1;
          for (var x = 0; x < w; x += 14) {
            c2d.beginPath();
            c2d.moveTo(x, groundY + K(3));
            c2d.lineTo(x + K(9), groundY + K(13));
            c2d.stroke();
          }
          /* 地面线 */
          var gl = c2d.createLinearGradient(plotL, 0, plotR, 0);
          gl.addColorStop(0, 'rgba(150,180,230,0.12)');
          gl.addColorStop(0.5, 'rgba(185,210,255,0.60)');
          gl.addColorStop(1, 'rgba(150,180,230,0.12)');
          c2d.strokeStyle = gl;
          c2d.lineWidth = 1.6;
          c2d.beginPath();
          c2d.moveTo(plotL, groundY);
          c2d.lineTo(plotR, groundY);
          c2d.stroke();
          if (on('labels')) {
            haloText(c2d, '地面', plotL + K(16), groundY + K(18), C.dim, 9.5 * fs, 'left', false);
          }
        })();

        /* ---------- 7. 观测站（x=0，含风向旗） ---------- */
        (function drawStation() {
          var stX = x2s(0);
          var y = groundY;
          var hs = K(1);

          /* 站点垂直参考虚线（淡） */
          if (on('labels')) {
            c2d.setLineDash([3, 6]);
            c2d.strokeStyle = rgba(C.station, 0.18);
            c2d.lineWidth = 1;
            c2d.beginPath();
            c2d.moveTo(stX, groundY);
            c2d.lineTo(stX, plotTop);
            c2d.stroke();
            c2d.setLineDash([]);
          }

          /* 小屋 */
          c2d.fillStyle = 'rgba(219,230,255,0.92)';
          c2d.strokeStyle = 'rgba(16,24,42,0.95)';
          c2d.lineWidth = 1.4;
          c2d.beginPath();
          c2d.moveTo(stX - 11 * hs, y);
          c2d.lineTo(stX - 11 * hs, y - 13 * hs);
          c2d.lineTo(stX + 11 * hs, y - 13 * hs);
          c2d.lineTo(stX + 11 * hs, y);
          c2d.closePath();
          c2d.fill();
          c2d.stroke();
          /* 屋顶 */
          c2d.beginPath();
          c2d.moveTo(stX - 14 * hs, y - 13 * hs);
          c2d.lineTo(stX, y - 23 * hs);
          c2d.lineTo(stX + 14 * hs, y - 13 * hs);
          c2d.closePath();
          c2d.fillStyle = 'rgba(78,161,255,0.95)';
          c2d.fill();
          c2d.stroke();
          /* 门窗 */
          c2d.fillStyle = 'rgba(16,24,42,0.9)';
          c2d.fillRect(stX - 6 * hs, y - 9 * hs, 5 * hs, 9 * hs);
          c2d.fillRect(stX + 2 * hs, y - 10 * hs, 6 * hs, 4 * hs);

          /* 风向旗杆 */
          var poleX = stX + 19 * hs;
          c2d.strokeStyle = 'rgba(219,230,255,0.85)';
          c2d.lineWidth = 1.4;
          c2d.beginPath();
          c2d.moveTo(poleX, y);
          c2d.lineTo(poleX, y - 34 * hs);
          c2d.stroke();
          /* 旗帜：风向决定飘向（偏南风 -> 飘向 -x；偏北风 -> 飘向 +x） */
          var wd = windDir(cur.wind);
          var flagY = y - 34 * hs;
          var flen = (String(cur.wind || '').indexOf('较小') >= 0 ? 9 : 14) * hs;
          c2d.beginPath();
          c2d.moveTo(poleX, flagY);
          c2d.lineTo(poleX + wd * flen, flagY + 3.5 * hs);
          c2d.lineTo(poleX, flagY + 8 * hs);
          c2d.closePath();
          c2d.fillStyle = 'rgba(255,138,61,0.95)';
          c2d.fill();
          c2d.strokeStyle = 'rgba(16,24,42,0.6)';
          c2d.lineWidth = 1;
          c2d.stroke();

          /* 标注 */
          if (on('labels')) {
            haloText(c2d, '观测站', stX, y + K(18), C.text, 10.5 * fs, 'center', true);
            haloText(c2d, cur.wind, stX, y + K(31), C.dim, 9.5 * fs, 'center', false);
          }
        })();

        function windDir(txt) {
          var s = String(txt || '');
          if (s.indexOf('南') >= 0) return -1;   /* 偏南风：自 +x（暖侧）吹向 -x */
          if (s.indexOf('北') >= 0) return 1;
          return -1;
        }

        /* ---------- 8. 地面锋面符号 ---------- */
        (function drawFrontSymbols() {
          if (sx < plotL - 6 || sx > plotR + 6) return;
          var cx = clamp(sx, plotL + K(14), plotR - K(14));
          var y = groundY;
          var sz = K(15);
          if (type === 'cold') {
            /* 三角形，尖端指向移动方向（+x） */
            c2d.beginPath();
            c2d.moveTo(cx - sz * 0.55, y);
            c2d.lineTo(cx - sz * 0.55, y - sz * 1.05);
            c2d.lineTo(cx + sz * 1.05, y - sz * 0.52);
            c2d.closePath();
            c2d.fillStyle = rgba(C.cold, 0.92);
            c2d.fill();
            c2d.strokeStyle = 'rgba(230,244,255,0.9)';
            c2d.lineWidth = 1.2;
            c2d.stroke();
          } else if (type === 'warm') {
            /* 半圆，凸出方向指向移动方向（+x） */
            c2d.beginPath();
            c2d.arc(cx - sz * 0.3, y - sz * 0.55, sz * 0.62, -Math.PI / 2, Math.PI / 2);
            c2d.closePath();
            c2d.fillStyle = rgba(C.warmLine, 0.92);
            c2d.fill();
            c2d.strokeStyle = 'rgba(255,240,235,0.9)';
            c2d.lineWidth = 1.2;
            c2d.stroke();
          } else {
            /* 准静止锋：三角形（冷）与半圆（暖）交替，方向相反 */
            c2d.beginPath();
            c2d.moveTo(cx - sz * 0.55, y);
            c2d.lineTo(cx - sz * 0.55, y - sz * 0.95);
            c2d.lineTo(cx + sz * 0.95, y - sz * 0.48);
            c2d.closePath();
            c2d.fillStyle = rgba(C.cold, 0.9);
            c2d.fill();
            c2d.strokeStyle = 'rgba(230,244,255,0.85)';
            c2d.lineWidth = 1.1;
            c2d.stroke();

            c2d.beginPath();
            c2d.arc(cx + sz * 0.35, y - sz * 2.05, sz * 0.62, Math.PI / 2, Math.PI * 1.5);
            c2d.closePath();
            c2d.fillStyle = rgba(C.warmLine, 0.9);
            c2d.fill();
            c2d.strokeStyle = 'rgba(255,240,235,0.85)';
            c2d.stroke();
          }
          if (on('labels')) {
            haloText(c2d, '锋线', cx, y - K(46), C.dim, 9.5 * fs, 'center', false);
          }
        })();

        /* ---------- 9. 气流箭头 ---------- */
        if (on('air')) drawAirflow();

        function drawAirflow() {
          var lowY = groundY - K(26);
          var colA = rgba(type === 'warm' ? C.warm : C.cold, 0.9);

          /* 低层推进箭头 */
          if (type === 'stationary') {
            var l0 = Math.max(plotL + K(14), sx - K(150));
            var l1 = sx - K(22);
            if (l1 - l0 > K(26)) arrow(c2d, l0, lowY, l1, lowY, rgba(C.cold, 0.9), 2.2 * fs, 9 * fs);
            var r0 = Math.min(plotR - K(14), sx + K(150));
            var r1 = sx + K(22);
            if (r0 - r1 > K(26)) arrow(c2d, r0, lowY, r1, lowY, rgba(C.warm, 0.9), 2.2 * fs, 9 * fs);
          } else {
            var a0 = Math.max(plotL + K(14), sx - K(155));
            var a1 = Math.max(a0 + K(30), sx - K(24));
            a1 = Math.min(a1, plotR - K(6));
            if (a1 - a0 > K(26)) arrow(c2d, a0, lowY, a1, lowY, colA, 2.3 * fs, 9 * fs);
          }

          /* 沿锋面爬升箭头（暖气团抬升） */
          var maxFrac = Math.max(fracAt(-L), fracAt(L));
          if (maxFrac < 0.10) return;
          function xAtFrac(target) {
            var bestX = null, bestD = 1e9, i, px, fc;
            for (i = 0; i <= 120; i++) {
              px = plotL + plotW * i / 120;
              fc = fracAt(s2w(px));
              if (Math.abs(fc - target) < bestD) { bestD = Math.abs(fc - target); bestX = px; }
            }
            return bestD < 0.09 ? bestX : null;
          }
          var levels = [0.30, 0.52, 0.74];
          var xs = [];
          for (var li = 0; li < levels.length; li++) {
            xs.push(xAtFrac(levels[li] * maxFrac));
          }
          for (li = 0; li < xs.length - 1; li++) {
            if (xs[li] == null || xs[li + 1] == null) continue;
            var ax = xs[li], bx = xs[li + 1];
            var ay = yFront(s2w(ax)) - K(11);
            var by = yFront(s2w(bx)) - K(11);
            if (Math.abs(bx - ax) < K(16)) continue;
            arrow(c2d, ax, ay, bx, by, rgba(C.warm, 0.92), 2.1 * fs, 8 * fs);
          }
          if (xs[0] == null && xs[1] == null) {
            /* 锋面坡度部分在画面外时，退化为竖直抬升箭头 */
            var ux = clamp(sx, plotL + K(30), plotR - K(30));
            var uy = groundY - K(60);
            arrow(c2d, ux, uy + K(22), ux, uy, rgba(C.warm, 0.9), 2.1 * fs, 8 * fs);
          }
        }

        /* ---------- 10. 气团标签 ---------- */
        if (on('labels')) drawAirLabels();

        function airLabel(text, x, y, color) {
          setFont(c2d, 12 * fs, true);
          c2d.textAlign = 'center';
          c2d.textBaseline = 'middle';
          var tw = c2d.measureText(text).width;
          var bw = tw + K(22), bh = K(21);
          roundRect(c2d, x - bw / 2, y - bh / 2, bw, bh, bh / 2);
          c2d.fillStyle = 'rgba(7,11,22,0.62)';
          c2d.fill();
          c2d.strokeStyle = rgba(color, 0.55);
          c2d.lineWidth = 1;
          c2d.stroke();
          c2d.fillStyle = color;
          c2d.fillText(text, x, y + 0.5);
        }

        function drawAirLabels() {
          /* 冷气团标签：楔形里找到有足够竖向空间的位置 */
          var cxLab = null, cyLab = null, d, px, wx, hh;
          if (coldLeft) {
            for (d = K(34); d < plotW * 0.5; d += K(8)) {
              px = sx - d;
              if (px < plotL + K(38)) break;
              wx = s2w(px);
              hh = groundY - yFront(wx);
              if (hh > K(58)) { cxLab = px; cyLab = groundY - Math.min(hh * 0.42, K(60)); break; }
            }
          } else {
            for (d = K(34); d < plotW * 0.5; d += K(8)) {
              px = sx + d;
              if (px > plotR - K(38)) break;
              wx = s2w(px);
              hh = groundY - yFront(wx);
              if (hh > K(58)) { cxLab = px; cyLab = groundY - Math.min(hh * 0.42, K(60)); break; }
            }
          }
          if (cxLab != null) airLabel('冷气团', cxLab, cyLab, C.cold);

          /* 暖气团标签：放在暖气团一侧的天空里 */
          var wxLab, wyLab = groundY - skyH * 0.55;
          if (coldLeft) {
            wxLab = clamp(sx + plotW * 0.2, plotL + K(50), plotR - K(46));
            if (wxLab < sx + K(40)) wxLab = clamp(sx + K(60), plotL + K(50), plotR - K(46));
          } else {
            wxLab = clamp(sx - plotW * 0.2, plotL + K(46), plotR - K(50));
            if (wxLab > sx - K(40)) wxLab = clamp(sx - K(60), plotL + K(46), plotR - K(50));
          }
          if (yFront(s2w(wxLab)) > wyLab - K(14)) wyLab = yFront(s2w(wxLab)) - K(20);
          airLabel('暖气团', wxLab, wyLab, C.warm);
        }

        /* ---------- 11. 顶部信息条 ---------- */
        (function drawHeader() {
          var barX = 6, barY = 5, barW = w - 12, barH = headerH - 5;
          roundRect(c2d, barX, barY, barW, barH, K(10));
          c2d.fillStyle = 'rgba(16,24,42,0.86)';
          c2d.fill();
          c2d.strokeStyle = C.line;
          c2d.lineWidth = 1;
          c2d.stroke();

          /* 标题 */
          var title = (mobile ? '剖面 · ' : '剖面图解 · ') + m.name;
          haloText(c2d, title, barX + K(12), barY + K(19), C.text, 14 * fs, 'left', true);

          /* 过境前 / 时 / 后 胶囊条 */
          var names = [m.phases[0].name, m.phases[1].name, m.phases[2].name];
          var pillH = K(19), gap = K(5);
          var widths = [], total = 0, i;
          setFont(c2d, 10.5 * fs, true);
          for (i = 0; i < 3; i++) {
            var twi = c2d.measureText(names[i]).width + K(16);
            widths.push(twi);
            total += twi;
          }
          total += gap * 2;
          var startX = barX + barW - K(10) - total;
          var cy = barY + K(19);
          for (i = 0; i < 3; i++) {
            var act = (i === cur.phase);
            roundRect(c2d, startX, cy - pillH / 2, widths[i], pillH, pillH / 2);
            c2d.fillStyle = act ? rgba(C.accent, 0.28) : 'rgba(255,255,255,0.03)';
            c2d.fill();
            c2d.strokeStyle = act ? rgba(C.accent, 0.85) : 'rgba(150,180,230,0.20)';
            c2d.lineWidth = 1;
            c2d.stroke();
            haloText(c2d, names[i], startX + widths[i] / 2, cy + 0.5,
              act ? '#eaf4ff' : C.dim, 10.5 * fs, 'center', true);
            startX += widths[i] + gap;
          }

          /* 第二行：气温 / 气压 / 天气 */
          var row2Y = barY + K(41);
          var cellW = (barW - K(24)) / 3;
          var weather = shortWeather(cur.weather);
          var cells = [
            { lab: '气温', val: cur.temp.toFixed(1) + ' ℃', col: C.warm },
            { lab: '气压', val: Math.round(cur.press) + ' hPa', col: C.accent },
            { lab: '天气', val: weather, col: C.text }
          ];
          for (i = 0; i < 3; i++) {
            var cellX = barX + K(12) + cellW * i;
            setFont(c2d, 9.5 * fs, false);
            c2d.textAlign = 'left';
            c2d.textBaseline = 'middle';
            c2d.fillStyle = C.dim;
            c2d.fillText(cells[i].lab, cellX, row2Y);
            var lw = c2d.measureText(cells[i].lab).width;
            setFont(c2d, 12.5 * fs, true);
            c2d.fillStyle = cells[i].col;
            c2d.fillText(cells[i].val, cellX + lw + K(6), row2Y);
          }

          function shortWeather(txt) {
            var s = String(txt || '');
            setFont(c2d, 12.5 * fs, true);
            var maxW = mobile ? K(74) : K(160);
            if (c2d.measureText(s).width <= maxW) return s;
            var parts = s.split('，');
            if (parts.length > 1 && c2d.measureText(parts[0]).width <= maxW) return parts[0];
            return s.slice(0, 3);
          }
        })();

        /* ---------- 12. 图例 + 底部说明 ---------- */
        (function drawLegendFooter() {
          var items = [
            { t: '冷气团', c: C.cold, kind: 'sq' },
            { t: '暖气团', c: C.warm, kind: 'sq' },
            { t: '锋面', c: '#eaf2ff', kind: 'ln' },
            { t: '云系', c: C.cloud, kind: 'cl' },
            { t: isSnow ? '降雪' : '降水', c: C.rain, kind: 'rn' }
          ];
          var y = h - K(38);
          var x = plotL + K(2);
          var gap = mobile ? K(11) : K(22);
          var i, j;
          for (i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.kind === 'sq') {
              c2d.fillStyle = rgba(it.c, 0.5);
              c2d.fillRect(x, y - K(5), K(10), K(10));
              c2d.strokeStyle = rgba(it.c, 0.9);
              c2d.lineWidth = 1;
              c2d.strokeRect(x, y - K(5), K(10), K(10));
            } else if (it.kind === 'ln') {
              c2d.strokeStyle = it.c;
              c2d.lineWidth = 2;
              c2d.beginPath();
              c2d.moveTo(x, y + K(4));
              c2d.lineTo(x + K(12), y - K(6));
              c2d.stroke();
            } else if (it.kind === 'cl') {
              c2d.fillStyle = rgba(C.cloud, 0.35);
              c2d.beginPath();
              c2d.arc(x + K(4), y, K(5), 0, Math.PI * 2);
              c2d.arc(x + K(10), y - K(2), K(4), 0, Math.PI * 2);
              c2d.fill();
            } else {
              c2d.strokeStyle = rgba(C.rain, 0.9);
              c2d.lineWidth = 1.2;
              for (j = 0; j < 3; j++) {
                c2d.beginPath();
                c2d.moveTo(x + j * K(5), y - K(5));
                c2d.lineTo(x + j * K(5) - K(2), y + K(5));
                c2d.stroke();
              }
            }
            setFont(c2d, 10.5 * fs, false);
            c2d.textAlign = 'left';
            c2d.textBaseline = 'middle';
            c2d.fillStyle = C.dim;
            c2d.fillText(it.t, x + K(16), y);
            x += K(16) + c2d.measureText(it.t).width + gap;
            if (x > plotR - K(18)) break;
          }

          /* 底部说明一行 */
          var foot = mobile ? m.slopeText : (m.slopeText + ' · ' + m.rainZoneText);
          setFont(c2d, 10.5 * fs, false);
          if (c2d.measureText(foot).width > plotW) foot = m.slopeText;
          c2d.textAlign = 'left';
          c2d.textBaseline = 'middle';
          c2d.fillStyle = C.dim;
          c2d.fillText(foot, plotL, h - K(13));
        })();

        c2d.restore();
      },

      resize: function (w, h) { /* 每帧按 w/h 自适应，无需缓存尺寸 */ },

      dispose: function () { /* 无外部资源 */ }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
