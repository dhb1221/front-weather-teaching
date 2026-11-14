/* ============================================================
 * m4-chart.js — M4 气象要素曲线（Canvas 2D）
 * 依赖：window.FRONT（统一数据源，必需）；window.H（可选，缺失时用内置实现）
 * API：window.MODELS.M4 = function (ctx) -> { draw, resize, dispose }
 *
 * 图面：横轴 = 时间进程 0..1（过境前 / 过境时 / 过境后 三段背景分区）；
 *       左轴气温（℃），右轴气压（hPa），底部蓝色柱条 = 降水强度 0..1；
 *       曲线用 FRONT.curve(type,p) 采样 120 点；播放头跟随 state.t。
 * 说明：每帧重画、不缓存；c2d 已按 devicePixelRatio 缩放，全部用 CSS 像素。
 * ============================================================ */
(function (global) {
  'use strict';

  var FONT = '"PingFang SC","Microsoft YaHei",sans-serif';

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

  /* 固定量程：三种锋共用同一把尺子，"形态差异"才看得出来 */
  var TMIN = 0, TMAX = 30;        /* 气温 ℃ */
  var PMIN = 1000, PMAX = 1024;   /* 气压 hPa */
  var SAMPLES = 120;

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function setFont(g, size, bold) {
    g.font = (bold ? 'bold ' : '') + size.toFixed(1) + 'px ' + FONT;
  }
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

  global.MODELS = global.MODELS || {};

  global.MODELS.M4 = function createM4(ctx) {
    return {
      draw: function (c2d, w, h, state, FRONT) {
        var F = FRONT || global.FRONT;
        if (!c2d || !F || !F.meta || !(w > 1) || !(h > 1)) return;
        var S = state || {};
        var type = F.meta[S.type] ? S.type : 'cold';
        var m = F.meta[type];
        var p = F.clamp01(num(S.t, 0));
        var cur = F.curve(type, p);

        var mobile = w < 820;
        var fs = mobile ? 0.85 : 1;
        var K = function (v) { return v * fs; };

        /* ---------- 版面 ---------- */
        var padL = mobile ? 40 : 54;
        var padR = mobile ? 44 : 58;
        var padT = mobile ? 78 : 88;
        var padB = mobile ? 34 : 38;
        var x0 = padL, x1 = w - padR;
        var y0 = padT, y1 = h - padB;
        var plotW = x1 - x0, plotH = y1 - y0;
        if (plotW < 70 || plotH < 90) return;

        var curveTop = y0;
        var curveBot = y0 + plotH * 0.70;                 /* 曲线区底部 */
        var barTop = y0 + plotH * 0.745;                  /* 降水柱上限 */
        var barBot = y1;                                  /* 降水柱基线 */

        function xP(pp) { return x0 + clamp(pp, 0, 1) * plotW; }
        function yT(v) {
          return curveBot - (clamp(v, TMIN, TMAX) - TMIN) / (TMAX - TMIN) * (curveBot - curveTop);
        }
        function yP(v) {
          return curveBot - (clamp(v, PMIN, PMAX) - PMIN) / (PMAX - PMIN) * (curveBot - curveTop);
        }

        /* ---------- 采样 120 点 ---------- */
        var samples = [];
        var i;
        for (i = 0; i < SAMPLES; i++) {
          var pp = i / (SAMPLES - 1);
          samples.push({ p: pp, c: F.curve(type, pp) });
        }

        c2d.save();
        c2d.clearRect(0, 0, w, h);
        c2d.lineCap = 'round';
        c2d.lineJoin = 'round';
        c2d.setLineDash([]);

        var edges = [0, F.PHASE_EDGE[0], F.PHASE_EDGE[1], 1];

        /* ---------- 1. 三段背景分区 ---------- */
        for (i = 0; i < 3; i++) {
          var bx0 = xP(edges[i]), bx1 = xP(edges[i + 1]);
          var active = (i === cur.phase);
          c2d.fillStyle = active ? 'rgba(78,161,255,0.085)' : 'rgba(120,150,220,0.032)';
          c2d.fillRect(bx0, y0, bx1 - bx0, y1 - y0);
        }
        /* 当前阶段的浅色描边 */
        c2d.strokeStyle = 'rgba(78,161,255,0.22)';
        c2d.lineWidth = 1;
        c2d.strokeRect(xP(edges[cur.phase]), y0, xP(edges[cur.phase + 1]) - xP(edges[cur.phase]), y1 - y0);

        /* ---------- 2. 网格 ---------- */
        var tempTicks = [0, 10, 20, 30];
        var pressTicks = [1000, 1008, 1016, 1024];
        c2d.strokeStyle = 'rgba(150,180,230,0.13)';
        c2d.lineWidth = 1;
        for (i = 0; i < tempTicks.length; i++) {
          var gy = yT(tempTicks[i]);
          c2d.beginPath();
          c2d.moveTo(x0, gy);
          c2d.lineTo(x1, gy);
          c2d.stroke();
        }
        /* 竖向四分网格 */
        c2d.strokeStyle = 'rgba(150,180,230,0.075)';
        for (i = 1; i <= 3; i++) {
          var gx = xP(i / 4);
          c2d.beginPath();
          c2d.moveTo(gx, y0);
          c2d.lineTo(gx, y1);
          c2d.stroke();
        }
        /* 阶段分界虚线 */
        c2d.setLineDash([4, 5]);
        c2d.strokeStyle = 'rgba(150,180,230,0.32)';
        for (i = 1; i <= 2; i++) {
          var ex = xP(F.PHASE_EDGE[i - 1]);
          c2d.beginPath();
          c2d.moveTo(ex, y0);
          c2d.lineTo(ex, y1);
          c2d.stroke();
        }
        c2d.setLineDash([]);

        /* 降水区上边界 */
        c2d.strokeStyle = 'rgba(143,200,255,0.20)';
        c2d.lineWidth = 1;
        c2d.beginPath();
        c2d.moveTo(x0, barTop);
        c2d.lineTo(x1, barTop);
        c2d.stroke();

        /* ---------- 3. 坐标轴 + 刻度 + 单位 ---------- */
        c2d.strokeStyle = 'rgba(185,210,255,0.42)';
        c2d.lineWidth = 1.2;
        c2d.beginPath();
        c2d.moveTo(x0, y0);
        c2d.lineTo(x0, y1);
        c2d.stroke();
        c2d.beginPath();
        c2d.moveTo(x1, y0);
        c2d.lineTo(x1, y1);
        c2d.stroke();
        c2d.beginPath();
        c2d.moveTo(x0, y1);
        c2d.lineTo(x1, y1);
        c2d.stroke();

        /* 左轴：气温 */
        for (i = 0; i < tempTicks.length; i++) {
          var ty = yT(tempTicks[i]);
          c2d.strokeStyle = 'rgba(255,138,61,0.55)';
          c2d.lineWidth = 1.2;
          c2d.beginPath();
          c2d.moveTo(x0 - K(4), ty);
          c2d.lineTo(x0, ty);
          c2d.stroke();
          setFont(c2d, 10 * fs, false);
          c2d.textAlign = 'right';
          c2d.textBaseline = 'middle';
          c2d.fillStyle = rgbaText(C.warm, 0.85);
          c2d.fillText(String(tempTicks[i]), x0 - K(7), ty);
        }
        /* 右轴：气压 */
        for (i = 0; i < pressTicks.length; i++) {
          var py = yP(pressTicks[i]);
          c2d.strokeStyle = 'rgba(78,161,255,0.55)';
          c2d.lineWidth = 1.2;
          c2d.beginPath();
          c2d.moveTo(x1, py);
          c2d.lineTo(x1 + K(4), py);
          c2d.stroke();
          setFont(c2d, 9.5 * fs, false);
          c2d.textAlign = 'left';
          c2d.textBaseline = 'middle';
          c2d.fillStyle = rgbaText(C.accent, 0.85);
          c2d.fillText(String(pressTicks[i]), x1 + K(7), py);
        }

        /* 轴标题（竖排） */
        c2d.save();
        c2d.translate(x0 - K(30), (curveTop + curveBot) / 2);
        c2d.rotate(-Math.PI / 2);
        setFont(c2d, 10.5 * fs, true);
        c2d.textAlign = 'center';
        c2d.textBaseline = 'middle';
        c2d.fillStyle = rgbaText(C.warm, 0.85);
        c2d.fillText('气温 (℃)', 0, 0);
        c2d.restore();

        c2d.save();
        c2d.translate(x1 + K(32), (curveTop + curveBot) / 2);
        c2d.rotate(Math.PI / 2);
        setFont(c2d, 10.5 * fs, true);
        c2d.textAlign = 'center';
        c2d.textBaseline = 'middle';
        c2d.fillStyle = rgbaText(C.accent, 0.85);
        c2d.fillText('气压 (hPa)', 0, 0);
        c2d.restore();

        /* 横轴刻度（仅刻度线，阶段名称在上方标签里） */
        c2d.strokeStyle = 'rgba(150,180,230,0.30)';
        c2d.lineWidth = 1;
        for (i = 0; i <= 4; i++) {
          var tx = xP(i / 4);
          c2d.beginPath();
          c2d.moveTo(tx, y1);
          c2d.lineTo(tx, y1 + K(4));
          c2d.stroke();
        }

        /* ---------- 4. 降水柱条 ---------- */
        var bw = Math.max(2, plotW / SAMPLES * 0.72);
        for (i = 0; i < SAMPLES; i++) {
          var rv = samples[i].c.rain;
          if (rv <= 0.008) continue;
          var bxx = xP(samples[i].p);
          var bh = rv * (barBot - barTop);
          c2d.fillStyle = 'rgba(143,200,255,' + (0.30 + 0.50 * rv).toFixed(2) + ')';
          c2d.fillRect(bxx - bw / 2, barBot - bh, bw, bh);
        }
        /* 降水区小标签 */
        haloText(c2d, '降水强度', x0 + K(4), barTop - K(9), C.dim, 9.5 * fs, 'left', false);

        /* ---------- 5. 气温曲线（含渐变填充） ---------- */
        (function drawTemp() {
          /* 曲线下方面积 */
          c2d.beginPath();
          for (var k = 0; k < SAMPLES; k++) {
            var xx = xP(samples[k].p), yy = yT(samples[k].c.temp);
            if (k === 0) c2d.moveTo(xx, yy);
            else c2d.lineTo(xx, yy);
          }
          c2d.lineTo(x1, curveBot);
          c2d.lineTo(x0, curveBot);
          c2d.closePath();
          var ag = c2d.createLinearGradient(0, curveTop, 0, curveBot);
          ag.addColorStop(0, 'rgba(255,138,61,0.16)');
          ag.addColorStop(1, 'rgba(255,138,61,0)');
          c2d.fillStyle = ag;
          c2d.fill();

          /* 曲线 */
          c2d.beginPath();
          for (k = 0; k < SAMPLES; k++) {
            var x2 = xP(samples[k].p), y2 = yT(samples[k].c.temp);
            if (k === 0) c2d.moveTo(x2, y2);
            else c2d.lineTo(x2, y2);
          }
          c2d.shadowColor = 'rgba(255,138,61,0.55)';
          c2d.shadowBlur = 9;
          c2d.strokeStyle = C.warm;
          c2d.lineWidth = 2.4;
          c2d.stroke();
          c2d.shadowBlur = 0;
        })();

        /* ---------- 6. 气压曲线 ---------- */
        (function drawPress() {
          c2d.beginPath();
          for (var k = 0; k < SAMPLES; k++) {
            var xx = xP(samples[k].p), yy = yP(samples[k].c.press);
            if (k === 0) c2d.moveTo(xx, yy);
            else c2d.lineTo(xx, yy);
          }
          c2d.shadowColor = 'rgba(78,161,255,0.55)';
          c2d.shadowBlur = 9;
          c2d.strokeStyle = C.accent;
          c2d.lineWidth = 2.4;
          c2d.stroke();
          c2d.shadowBlur = 0;
        })();

        /* ---------- 7. 播放头 ---------- */
        (function drawPlayhead() {
          var phx = xP(p);
          /* 竖线 */
          c2d.strokeStyle = 'rgba(219,230,255,0.22)';
          c2d.lineWidth = 5;
          c2d.beginPath();
          c2d.moveTo(phx, y0);
          c2d.lineTo(phx, y1);
          c2d.stroke();
          c2d.strokeStyle = 'rgba(232,242,255,0.78)';
          c2d.lineWidth = 1.4;
          c2d.beginPath();
          c2d.moveTo(phx, y0);
          c2d.lineTo(phx, y1);
          c2d.stroke();

          /* 顶部小三角 */
          c2d.fillStyle = '#e8f2ff';
          c2d.beginPath();
          c2d.moveTo(phx - K(5), y0 - K(2));
          c2d.lineTo(phx + K(5), y0 - K(2));
          c2d.lineTo(phx, y0 + K(7));
          c2d.closePath();
          c2d.fill();

          /* 交点圆点 */
          var tY = yT(cur.temp), pY = yP(cur.press);
          c2d.beginPath();
          c2d.arc(phx, tY, K(4.6), 0, Math.PI * 2);
          c2d.fillStyle = C.warm;
          c2d.fill();
          c2d.strokeStyle = 'rgba(255,246,236,0.95)';
          c2d.lineWidth = 1.4;
          c2d.stroke();

          c2d.beginPath();
          c2d.arc(phx, pY, K(4.6), 0, Math.PI * 2);
          c2d.fillStyle = C.accent;
          c2d.fill();
          c2d.strokeStyle = 'rgba(236,246,255,0.95)';
          c2d.lineWidth = 1.4;
          c2d.stroke();
        })();

        /* ---------- 8. 顶部阶段标签（横轴分段名） ---------- */
        (function drawPhaseChips() {
          var names = [m.phases[0].name, m.phases[1].name, m.phases[2].name];
          for (var k = 0; k < 3; k++) {
            var cxx = (xP(edges[k]) + xP(edges[k + 1])) / 2;
            var act = (k === cur.phase);
            setFont(c2d, 10.5 * fs, true);
            var tw = c2d.measureText(names[k]).width + K(16);
            var chy = y0 - K(16);
            roundRect(c2d, cxx - tw / 2, chy - K(9), tw, K(18), K(9));
            c2d.fillStyle = act ? 'rgba(78,161,255,0.26)' : 'rgba(255,255,255,0.03)';
            c2d.fill();
            c2d.strokeStyle = act ? 'rgba(78,161,255,0.80)' : 'rgba(150,180,230,0.20)';
            c2d.lineWidth = 1;
            c2d.stroke();
            haloText(c2d, names[k], cxx, chy + 0.5, act ? '#eaf4ff' : C.dim, 10.5 * fs, 'center', true);
          }
        })();

        /* ---------- 9. 标题 + 右上角实时读数 ---------- */
        (function drawTitle() {
          haloText(c2d, (mobile ? '要素曲线 · ' : '要素曲线 · ') + m.name,
            14, K(21), C.text, 14 * fs, 'left', true);
          var sub = '气温 ' + m.temp0 + ' → ' + m.temp1 + ' ℃ · 气压 ' + m.press0 + ' → ' + m.press1 + ' hPa';
          haloText(c2d, sub, 14, K(40), C.dim, 10.5 * fs, 'left', false);
        })();

        (function drawReadout() {
          var pw = mobile ? K(124) : K(152);
          var phh = mobile ? K(46) : K(52);
          var px = w - K(8) - pw, py = K(6);
          roundRect(c2d, px, py, pw, phh, K(9));
          c2d.fillStyle = 'rgba(16,24,42,0.88)';
          c2d.fill();
          c2d.strokeStyle = C.line;
          c2d.lineWidth = 1;
          c2d.stroke();

          var weather = String(cur.weather || '');
          if (weather.length > 4) weather = weather.split('，')[0].slice(0, 4);

          var cells = [
            { lab: '气温', val: cur.temp.toFixed(1) + '℃', col: C.warm },
            { lab: '气压', val: Math.round(cur.press) + 'hPa', col: C.accent },
            { lab: '降水', val: Math.round(cur.rain * 100) + '%', col: C.rain },
            { lab: '天气', val: weather, col: C.text }
          ];
          var cw = pw / 2;
          var rowH = phh / 2;
          for (var k = 0; k < 4; k++) {
            var cx = px + K(9) + (k % 2) * cw;
            var cy = py + rowH * (k < 2 ? 0.5 : 1.5);
            setFont(c2d, 9 * fs, false);
            c2d.textAlign = 'left';
            c2d.textBaseline = 'middle';
            c2d.fillStyle = C.dim;
            c2d.fillText(cells[k].lab, cx, cy);
            var lw = c2d.measureText(cells[k].lab).width;
            setFont(c2d, 11.5 * fs, true);
            c2d.fillStyle = cells[k].col;
            c2d.fillText(cells[k].val, cx + lw + K(4), cy);
          }
        })();

        /* ---------- 10. 图例 + 说明 ---------- */
        (function drawLegend() {
          var y = h - K(14);
          var x = x0;
          var items = [
            { t: '气温', c: C.warm, kind: 'ln' },
            { t: '气压', c: C.accent, kind: 'ln' },
            { t: '降水', c: C.rain, kind: 'bar' }
          ];
          for (var k = 0; k < items.length; k++) {
            var it = items[k];
            if (it.kind === 'ln') {
              c2d.strokeStyle = it.c;
              c2d.lineWidth = 2.6;
              c2d.beginPath();
              c2d.moveTo(x, y);
              c2d.lineTo(x + K(13), y);
              c2d.stroke();
            } else {
              c2d.fillStyle = rgbaText(C.rain, 0.75);
              c2d.fillRect(x, y - K(4), K(4), K(8));
              c2d.fillRect(x + K(6), y - K(6), K(4), K(10));
            }
            setFont(c2d, 10.5 * fs, false);
            c2d.textAlign = 'left';
            c2d.textBaseline = 'middle';
            c2d.fillStyle = C.dim;
            c2d.fillText(it.t, x + K(19), y);
            x += K(19) + c2d.measureText(it.t).width + K(18);
          }
          /* 右下角：时间进程 */
          haloText(c2d, '时间进程 →', x1, y, C.dim, 10 * fs, 'right', false);
        })();

        c2d.restore();
      },

      resize: function (w, h) { /* 每帧按 w/h 自适应，无需缓存尺寸 */ },

      dispose: function () { /* 无外部资源 */ }
    };
  };

  /* 把十六进制颜色转成文字色（与配色表保持一致、可带透明度） */
  function rgbaText(hex, a) {
    var s = String(hex || '').replace('#', '');
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    var n = parseInt(s, 16);
    if (!isFinite(n)) return 'rgba(219,230,255,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
})(typeof window !== 'undefined' ? window : globalThis);
