/* ============================================================
 * helpers.js — 公共工具
 *   三维：标签精灵 / 线条 / 太阳光晕 / 轻量轨道控制
 *   二维：锋面符号、箭头（剖面图、天气图、图例共用）
 * 依赖 three.min.js 的全局 THREE（无则只导出二维部分）
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;

  var PALETTE = {
    bg: '#05070f', panel: 'rgba(16,24,42,0.72)', line: 'rgba(150,180,230,0.22)',
    text: '#dbe6ff', dim: 'rgba(219,230,255,0.55)', accent: '#4ea1ff',
    cold: '#4ea1ff', warm: '#ff8a3d', warmLine: '#ff7a6b',
    station: '#b98cff', rain: '#8fc8ff', cloud: '#cfd8ea',
    ok: '#37d39b', warn: '#ffb454'
  };

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* ================= 三维 ================= */

  function makeLabel(text, opts) {
    opts = opts || {};
    var fs = opts.size || 48;
    var pad = 14;
    var c = document.createElement('canvas');
    var g = c.getContext('2d');
    var font = (opts.bold === false ? '' : 'bold ') + fs + 'px "PingFang SC","Microsoft YaHei",sans-serif';
    g.font = font;
    var w = Math.ceil(g.measureText(text).width) + pad * 2;
    var h = fs + pad * 2;
    c.width = w; c.height = h;
    g = c.getContext('2d');
    if (opts.bg) {
      g.fillStyle = opts.bg;
      roundRect(g, 1, 1, w - 2, h - 2, 12);
      g.fill();
    }
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = opts.color || PALETTE.text;
    g.fillText(text, w / 2, h / 2 + 1);
    var tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    var mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: opts.depthTest !== false
    });
    var sp = new THREE.Sprite(mat);
    var scale = opts.scale || 0.5;
    sp.scale.set(scale * w / h, scale, 1);
    sp.userData.baseScale = scale;
    sp.userData.aspect = w / h;
    return sp;
  }

  /* 就地改写一个文字精灵：重绘贴图、复用它自己的材质，避免每帧新建贴图 */
  function setLabelText(sprite, text, opts) {
    if (!sprite || !sprite.material) return sprite;
    opts = opts || {};
    var fresh = makeLabel(text, opts);
    var oldMap = sprite.material.map;
    sprite.material.map = fresh.material.map;
    sprite.material.transparent = true;
    sprite.material.needsUpdate = true;
    if (oldMap && oldMap.dispose) oldMap.dispose();
    sprite.userData.baseScale = fresh.userData.baseScale;
    sprite.userData.aspect = fresh.userData.aspect;
    sprite.scale.set(fresh.scale.x, fresh.scale.y, 1);
    /* 断开临时精灵对贴图的引用，防止它被回收时连带 dispose 已交接的贴图 */
    fresh.material.map = null;
    return sprite;
  }

  function makeLine(points, color, opts) {
    opts = opts || {};
    var geo = new THREE.BufferGeometry().setFromPoints(points);
    var mat;
    if (opts.dashed) {
      mat = new THREE.LineDashedMaterial({
        color: color, dashSize: opts.dashSize || 0.25, gapSize: opts.gapSize || 0.18,
        transparent: true, opacity: opts.opacity === undefined ? 1 : opts.opacity
      });
    } else {
      mat = new THREE.LineBasicMaterial({
        color: color, transparent: true,
        opacity: opts.opacity === undefined ? 1 : opts.opacity
      });
    }
    var line = new THREE.Line(geo, mat);
    if (opts.dashed) line.computeLineDistances();
    return line;
  }

  function makeCircleLine(radius, color, opts) {
    opts = opts || {};
    var pts = [];
    var n = opts.segments || 96;
    for (var i = 0; i <= n; i++) {
      var a = i / n * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    return makeLine(pts, color, opts);
  }

  /* 柔光粒子贴图（云、雨幕、雪） */
  function makeSoftTexture(kind) {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var g = c.getContext('2d');
    if (kind === 'rain') {
      c.width = 8; c.height = 64;
      g = c.getContext('2d');
      var grd = g.createLinearGradient(0, 0, 0, 64);
      grd.addColorStop(0, 'rgba(180,220,255,0)');
      grd.addColorStop(0.5, 'rgba(180,220,255,0.9)');
      grd.addColorStop(1, 'rgba(140,190,255,0.1)');
      g.fillStyle = grd;
      g.fillRect(2, 0, 3, 64);
    } else {
      var rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      if (kind === 'cloud') {
        rg.addColorStop(0, 'rgba(226,236,255,0.95)');
        rg.addColorStop(0.45, 'rgba(198,214,246,0.55)');
        rg.addColorStop(1, 'rgba(180,200,235,0)');
      } else if (kind === 'snow') {
        rg.addColorStop(0, 'rgba(255,255,255,1)');
        rg.addColorStop(0.6, 'rgba(235,245,255,0.7)');
        rg.addColorStop(1, 'rgba(235,245,255,0)');
      } else {
        rg.addColorStop(0, 'rgba(255,255,255,0.9)');
        rg.addColorStop(1, 'rgba(255,255,255,0)');
      }
      g.fillStyle = rg;
      g.fillRect(0, 0, 64, 64);
    }
    var tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    return tex;
  }

  /* 轻量轨道控制（阻尼 + 触摸） */
  function createOrbit(camera, dom, opts) {
    opts = opts || {};
    var target = opts.target ? opts.target.clone() : new THREE.Vector3();
    var minDist = opts.minDist || 6;
    var maxDist = opts.maxDist || 70;
    var rotSpeed = opts.rotateSpeed || 0.006;
    var zoomSpeed = opts.zoomSpeed || 0.0015;
    var sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(target));
    var cur = { theta: sph.theta, phi: sph.phi, radius: sph.radius };
    var goal = { theta: sph.theta, phi: sph.phi, radius: sph.radius };
    var dragging = false, lastX = 0, lastY = 0, pinchDist = 0;
    var listeners = [];

    function onPointerDown(e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      dom.style.cursor = 'grabbing';
      if (dom.setPointerCapture && e.pointerId !== undefined) {
        try { dom.setPointerCapture(e.pointerId); } catch (err) { }
      }
    }
    function onPointerMove(e) {
      if (!dragging || pinchDist) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      goal.theta -= dx * rotSpeed * 2;
      goal.phi -= dy * rotSpeed * 2;
      goal.phi = Math.max(0.12, Math.min(Math.PI - 0.12, goal.phi));
    }
    function onPointerUp() { dragging = false; dom.style.cursor = 'grab'; }
    function onWheel(e) {
      e.preventDefault();
      goal.radius *= 1 + Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * zoomSpeed, 0.3);
      goal.radius = Math.max(minDist, Math.min(maxDist, goal.radius));
    }
    function dist(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function onTouchStart(e) {
      if (e.touches.length === 2) { pinchDist = dist(e.touches); dragging = false; }
      else if (e.touches.length === 1) {
        dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
      }
    }
    function onTouchMove(e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        var d = dist(e.touches);
        if (pinchDist > 0 && d > 0) goal.radius = Math.max(minDist, Math.min(maxDist, goal.radius * pinchDist / d));
        pinchDist = d;
      } else if (e.touches.length === 1 && dragging) {
        var t = e.touches[0];
        var dx = t.clientX - lastX, dy = t.clientY - lastY;
        lastX = t.clientX; lastY = t.clientY;
        goal.theta -= dx * rotSpeed * 2;
        goal.phi -= dy * rotSpeed * 2;
        goal.phi = Math.max(0.12, Math.min(Math.PI - 0.12, goal.phi));
      }
    }
    function onTouchEnd() { pinchDist = 0; dragging = false; }
    function add(ev, fn, el) {
      el = el || dom;
      el.addEventListener(ev, fn, { passive: false });
      listeners.push([el, ev, fn]);
    }
    add('pointerdown', onPointerDown);
    add('pointermove', onPointerMove);
    add('pointerup', onPointerUp);
    add('pointercancel', onPointerUp);
    add('pointerleave', onPointerUp);
    add('wheel', onWheel);
    add('touchstart', onTouchStart);
    add('touchmove', onTouchMove);
    add('touchend', onTouchEnd);

    var api = {
      update: function (dt) {
        var k = Math.min(1, (dt || 0.016) * 7);
        cur.theta += (goal.theta - cur.theta) * k;
        cur.phi += (goal.phi - cur.phi) * k;
        cur.radius += (goal.radius - cur.radius) * k;
        var s = new THREE.Spherical(cur.radius, cur.phi, cur.theta);
        camera.position.setFromSpherical(s).add(target);
        camera.lookAt(target);
      },
      setAngles: function (theta, phi, radius) {
        if (theta !== undefined) goal.theta = theta;
        if (phi !== undefined) goal.phi = phi;
        if (radius !== undefined) goal.radius = Math.max(minDist, Math.min(maxDist, radius));
      },
      /* 直接给一个目标机位（世界坐标） */
      setView: function (px, py, pz) {
        var v = new THREE.Vector3(px, py, pz).sub(target);
        var s = new THREE.Spherical().setFromVector3(v);
        goal.theta = s.theta;
        goal.phi = Math.max(0.12, Math.min(Math.PI - 0.12, s.phi));
        goal.radius = Math.max(minDist, Math.min(maxDist, s.radius));
      },
      snap: function () { cur.theta = goal.theta; cur.phi = goal.phi; cur.radius = goal.radius; },
      setTarget: function (v) { target.copy(v); },
      getTarget: function () { return target; },
      dispose: function () {
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
        listeners.length = 0;
      }
    };
    dom.style.cursor = 'grab';
    return api;
  }

  /* ================= 二维：锋面符号 ================= */

  /* 单个符号：冷锋三角 / 暖锋半圆 / 准静止锋（三角与半圆交替）
     x,y 为符号在锋线上的基准点，size 为高度，dir=+1 指向 +x，-1 指向 -x */
  function frontSymbol(c2d, type, x, y, size, dir, opts) {
    opts = opts || {};
    var color = opts.color || (type === 'cold' ? PALETTE.cold : type === 'warm' ? PALETTE.warmLine : PALETTE.station);
    var fill = opts.fill || color;
    dir = dir >= 0 ? 1 : -1;
    c2d.save();
    c2d.translate(x, y);
    c2d.scale(dir, 1);
    c2d.fillStyle = fill;
    c2d.strokeStyle = color;
    c2d.lineWidth = opts.lineWidth || 1.4;
    if (type === 'cold') {
      c2d.beginPath();
      c2d.moveTo(-size * 0.62, 0);
      c2d.lineTo(size * 0.62, 0);
      c2d.lineTo(0, -size);
      c2d.closePath();
      c2d.fill();
    } else if (type === 'warm') {
      c2d.beginPath();
      c2d.arc(0, 0, size * 0.62, Math.PI, 0, false);
      c2d.closePath();
      c2d.fill();
    } else {
      /* 准静止锋：三角与半圆交替，分列锋线两侧 */
      c2d.beginPath();
      c2d.moveTo(-size * 0.62, 0);
      c2d.lineTo(size * 0.62, 0);
      c2d.lineTo(0, -size);
      c2d.closePath();
      c2d.fill();
      c2d.beginPath();
      c2d.arc(0, size * 0.5, size * 0.62, 0, Math.PI, false);
      c2d.closePath();
      c2d.fill();
    }
    c2d.restore();
  }

  /* 沿线段画一排符号（天气图用）。dir 指向移动方向，符号画在 dir 方向一侧 */
  function frontSymbols(c2d, type, x0, y0, x1, y1, size, opts) {
    opts = opts || {};
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    var ux = dx / len, uy = dy / len;
    var step = opts.step || size * 1.9;
    var n = Math.max(1, Math.floor(len / step));
    var start = (len - (n - 1) * step) / 2;
    for (var i = 0; i < n; i++) {
      var d = start + i * step;
      var px = x0 + ux * d, py = y0 + uy * d;
      /* 符号垂直于锋线，指向移动方向 */
      var nx = -uy, ny = ux;
      var dir = opts.dir === undefined ? 1 : opts.dir;
      var sx = px + nx * size * (dir > 0 ? 0.05 : -0.05);
      var sy = py + ny * size * (dir > 0 ? 0.05 : -0.05);
      c2d.save();
      c2d.translate(sx, sy);
      /* 让符号“上方”对齐法线方向 */
      var ang = Math.atan2(ny * dir, nx * dir) - Math.PI / 2;
      c2d.rotate(ang);
      if (i % 2 === 1) c2d.translate(0, type === 'stationary' ? size * 0.95 : 0);
      frontSymbol(c2d, type, 0, 0, size, 1, opts);
      c2d.restore();
    }
  }

  /* 2D 箭头 */
  function drawArrow(c2d, x0, y0, x1, y1, color, width, opts) {
    opts = opts || {};
    c2d.save();
    c2d.strokeStyle = color;
    c2d.fillStyle = color;
    c2d.lineWidth = width || 2;
    c2d.lineCap = 'round';
    c2d.beginPath();
    c2d.moveTo(x0, y0);
    c2d.lineTo(x1, y1);
    c2d.stroke();
    var a = Math.atan2(y1 - y0, x1 - x0);
    var h = opts.head || Math.max(6, (width || 2) * 3);
    c2d.beginPath();
    c2d.moveTo(x1, y1);
    c2d.lineTo(x1 - h * Math.cos(a - 0.42), y1 - h * Math.sin(a - 0.42));
    c2d.lineTo(x1 - h * Math.cos(a + 0.42), y1 - h * Math.sin(a + 0.42));
    c2d.closePath();
    c2d.fill();
    c2d.restore();
  }

  /* 2D 圆角面板 */
  function panel(c2d, x, y, w, h, opts) {
    opts = opts || {};
    c2d.save();
    roundRect(c2d, x, y, w, h, opts.r || 10);
    c2d.fillStyle = opts.fill || 'rgba(12,20,36,0.66)';
    c2d.fill();
    if (opts.stroke !== false) {
      c2d.strokeStyle = opts.stroke || 'rgba(150,180,230,0.22)';
      c2d.lineWidth = 1;
      c2d.stroke();
    }
    c2d.restore();
  }

  global.H = {
    PALETTE: PALETTE,
    roundRect: roundRect,
    makeLabel: makeLabel,
    setLabelText: setLabelText,
    makeLine: makeLine,
    makeCircleLine: makeCircleLine,
    makeSoftTexture: makeSoftTexture,
    createOrbit: createOrbit,
    frontSymbol: frontSymbol,
    frontSymbols: frontSymbols,
    drawArrow: drawArrow,
    panel: panel
  };
})(typeof window !== 'undefined' ? window : globalThis);
