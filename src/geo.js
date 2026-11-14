/* ============================================================
 * geo.js — 真实地理数据投影与绘制（配合 src/geo-china.js、src/geo-world.js）
 * 中国地图采用兰勃特等角圆锥投影（标准纬线 25°N / 47°N，中央经线 105°E），
 * 这是我国地图常用投影；南海诸岛按标准地图要求以插图形式呈现。
 * 世界底图用等经纬投影（示意用）。
 * ============================================================ */
(function (global) {
  'use strict';

  var RAD = Math.PI / 180;

  var CITIES = [
    { name: '北京', lon: 116.41, lat: 39.90 },
    { name: '哈尔滨', lon: 126.53, lat: 45.80 },
    { name: '乌鲁木齐', lon: 87.62, lat: 43.83 },
    { name: '西安', lon: 108.94, lat: 34.34 },
    { name: '成都', lon: 104.07, lat: 30.57 },
    { name: '武汉', lon: 114.31, lat: 30.59 },
    { name: '上海', lon: 121.47, lat: 31.23 },
    { name: '昆明', lon: 102.71, lat: 25.04 },
    { name: '贵阳', lon: 106.63, lat: 26.65 },
    { name: '广州', lon: 113.26, lat: 23.13 },
    { name: '海口', lon: 110.32, lat: 20.04 },
    { name: '沈阳', lon: 123.43, lat: 41.81 }
  ];

  /* ---------- 兰勃特等角圆锥投影 ---------- */
  function lcc(phi1, phi2, lam0) {
    var p1 = phi1 * RAD, p2 = phi2 * RAD, l0 = lam0 * RAD;
    var n = Math.log(Math.cos(p1) / Math.cos(p2)) /
      Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
    var F = Math.cos(p1) * Math.pow(Math.tan(Math.PI / 4 + p1 / 2), n) / n;
    return function (lon, lat) {
      var rho = F / Math.pow(Math.tan(Math.PI / 4 + (lat * RAD) / 2), n);
      var th = n * (lon * RAD - l0);
      return { x: rho * Math.sin(th), y: -rho * Math.cos(th) };
    };
  }

  /* 在给定经纬范围与画布区域内，构造投影函数（自动适配留白） */
  function makeProjector(fwd, lonMin, lonMax, latMin, latMax, w, h, pad) {
    pad = pad === undefined ? 8 : pad;
    var i, j, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, p;
    for (i = 0; i <= 20; i++) {
      for (j = 0; j <= 20; j++) {
        p = fwd(lonMin + (lonMax - lonMin) * i / 20, latMin + (latMax - latMin) * j / 20);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    var sx = (w - pad * 2) / (maxX - minX);
    var sy = (h - pad * 2) / (maxY - minY);
    var s = Math.min(sx, sy);
    var ox = pad + ((w - pad * 2) - (maxX - minX) * s) / 2;
    var oy = pad + ((h - pad * 2) - (maxY - minY) * s) / 2;
    return {
      project: function (lon, lat) {
        var q = fwd(lon, lat);
        return { x: ox + (q.x - minX) * s, y: oy + (q.y - minY) * s };
      },
      scale: s
    };
  }

  /* 兰勃特投影的 y 轴朝北（数学坐标），画布 y 朝下，需先取反再交给 makeProjector */
  function lccNorthUp(phi1, phi2, lam0) {
    var f = lcc(phi1, phi2, lam0);
    return function (lon, lat) {
      var p = f(lon, lat);
      return { x: p.x, y: -p.y };
    };
  }

  /* 中国主图：经度 73~135，纬度 17~54（南海诸岛另作插图） */
  function chinaProjector(w, h, pad) {
    return makeProjector(lccNorthUp(25, 47, 105), 73, 135, 17, 54, w, h, pad === undefined ? 10 : pad);
  }

  /* 区域图（天气图底图）：等经纬，按中纬度压缩经度 */
  function regionProjector(lonMin, lonMax, latMin, latMax, w, h, pad) {
    pad = pad === undefined ? 8 : pad;
    var midLat = (latMin + latMax) / 2;
    var kx = Math.cos(midLat * RAD);
    var fwd = function (lon, lat) {
      return { x: (lon - lonMin) * kx, y: -(lat - latMin) };
    };
    return makeProjector(fwd, lonMin, lonMax, latMin, latMax, w, h, pad);
  }

  function pathRings(c2d, rings, project) {
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (!r || r.length < 2) continue;
      c2d.beginPath();
      for (var j = 0; j < r.length; j++) {
        var p = project(r[j][0], r[j][1]);
        if (j === 0) c2d.moveTo(p.x, p.y);
        else c2d.lineTo(p.x, p.y);
      }
      c2d.closePath();
    }
  }

  /* 画中国地图：海洋底色 + 省级陆地 + 省界 + 南海诸岛插图 + 城市点
     opts: { ocean, land, border, coast, label, cities, highlight } */
  function drawChina(c2d, w, h, opts) {
    opts = opts || {};
    var CH = global.GEO_CHINA;
    var main = chinaProjector(w, h, opts.pad === undefined ? 10 : opts.pad);

    if (opts.ocean) {
      c2d.save();
      c2d.fillStyle = opts.ocean;
      c2d.fillRect(0, 0, w, h);
      c2d.restore();
    }

    /* 省级陆地 */
    c2d.save();
    c2d.fillStyle = opts.land || '#0e1a2c';
    c2d.strokeStyle = opts.border || 'rgba(120,160,220,0.22)';
    c2d.lineWidth = opts.borderWidth || 0.7;
    CH.provinces.forEach(function (pv) {
      pathRings(c2d, pv.rings, main.project);
      c2d.fill();
    });
    CH.provinces.forEach(function (pv) {
      pathRings(c2d, pv.rings, main.project);
      c2d.stroke();
    });
    c2d.restore();

    /* 高亮某省（如雨带覆盖省份） */
    if (opts.highlight && opts.highlight.length) {
      c2d.save();
      c2d.fillStyle = opts.highlightFill || 'rgba(78,161,255,0.16)';
      CH.provinces.forEach(function (pv) {
        if (opts.highlight.some(function (n) { return pv.name.indexOf(n) >= 0; })) {
          pathRings(c2d, pv.rings, main.project);
          c2d.fill();
        }
      });
      c2d.restore();
    }

    /* 南海诸岛插图（标准地图要求：主图之外另设小图） */
    var iw = Math.max(48, Math.min(w * 0.2, 96));
    var ih = iw * 1.35;
    var ix = w - iw - (opts.insetPad === undefined ? 12 : opts.insetPad);
    var iy = h - ih - (opts.insetPad === undefined ? 12 : opts.insetPad);
    c2d.save();
    c2d.fillStyle = 'rgba(7,13,24,0.82)';
    c2d.fillRect(ix, iy, iw, ih);
    c2d.strokeStyle = 'rgba(150,180,230,0.4)';
    c2d.lineWidth = 0.8;
    c2d.strokeRect(ix, iy, iw, ih);
    var inset = makeProjector(lccNorthUp(25, 47, 105), 106, 123, 2, 24, iw, ih, 4);
    c2d.translate(ix, iy);
    c2d.fillStyle = opts.land || '#0e1a2c';
    c2d.strokeStyle = opts.border || 'rgba(120,160,220,0.28)';
    c2d.lineWidth = 0.5;
    CH.provinces.forEach(function (pv) {
      pathRings(c2d, pv.rings, function (lon, lat) {
        var p = inset.project(lon, lat);
        return { x: p.x, y: p.y };
      });
      c2d.fill();
      c2d.stroke();
    });
    if (CH.jd) {
      c2d.strokeStyle = opts.jdColor || 'rgba(150,190,240,0.85)';
      c2d.lineWidth = Math.max(0.8, iw / 60);
      CH.jd.rings.forEach(function (r) {
        c2d.beginPath();
        for (var j = 0; j < r.length; j++) {
          var p = inset.project(r[j][0], r[j][1]);
          if (j === 0) c2d.moveTo(p.x, p.y); else c2d.lineTo(p.x, p.y);
        }
        c2d.stroke();
      });
    }
    c2d.restore();
    c2d.save();
    c2d.fillStyle = 'rgba(219,230,255,0.72)';
    c2d.font = 'bold 9px "PingFang SC","Microsoft YaHei",sans-serif';
    c2d.textAlign = 'right';
    c2d.fillText('南海诸岛', ix + iw - 3, iy + ih - 3);
    c2d.restore();

    /* 城市点 */
    if (opts.cities !== false) {
      var cities = opts.cityList || CITIES;
      c2d.save();
      c2d.font = 'bold 10px "PingFang SC","Microsoft YaHei",sans-serif';
      c2d.textAlign = 'left';
      c2d.textBaseline = 'middle';
      cities.forEach(function (ct) {
        var p = main.project(ct.lon, ct.lat);
        c2d.fillStyle = opts.cityColor || 'rgba(219,230,255,0.85)';
        c2d.beginPath();
        c2d.arc(p.x, p.y, 2.2, 0, 6.2832);
        c2d.fill();
        c2d.fillStyle = opts.cityText || 'rgba(219,230,255,0.62)';
        c2d.fillText(ct.name, p.x + 4, p.y - 1);
      });
      c2d.restore();
    }

    return { projector: main, inset: { x: ix, y: iy, w: iw, h: ih } };
  }

  /* 画世界/区域国家底图 */
  function drawWorld(c2d, w, h, opts) {
    opts = opts || {};
    var W = global.GEO_WORLD;
    var proj = opts.projector || regionProjector(
      opts.lonMin === undefined ? -20 : opts.lonMin,
      opts.lonMax === undefined ? 160 : opts.lonMax,
      opts.latMin === undefined ? 0 : opts.latMin,
      opts.latMax === undefined ? 60 : opts.latMax,
      w, h, opts.pad === undefined ? 6 : opts.pad
    );
    c2d.save();
    if (opts.ocean) {
      c2d.fillStyle = opts.ocean;
      c2d.fillRect(0, 0, w, h);
    }
    c2d.fillStyle = opts.land || '#0e1a2c';
    c2d.strokeStyle = opts.border || 'rgba(120,160,220,0.2)';
    c2d.lineWidth = opts.borderWidth || 0.6;
    var bboxCheck = opts.filter;
    W.countries.forEach(function (ct) {
      if (bboxCheck && !bboxCheck(ct)) return;
      pathRings(c2d, ct.rings, proj.project);
      c2d.fill();
    });
    W.countries.forEach(function (ct) {
      if (bboxCheck && !bboxCheck(ct)) return;
      pathRings(c2d, ct.rings, proj.project);
      c2d.stroke();
    });
    c2d.restore();
    return proj;
  }

  global.GEO = {
    RAD: RAD,
    CITIES: CITIES,
    lcc: lcc,
    makeProjector: makeProjector,
    lccNorthUp: lccNorthUp,
    chinaProjector: chinaProjector,
    regionProjector: regionProjector,
    pathRings: pathRings,
    drawChina: drawChina,
    drawWorld: drawWorld
  };
})(typeof window !== 'undefined' ? window : globalThis);
