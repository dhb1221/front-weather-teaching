/* ============================================================
 * m8-globe.js — ⑦ 三维地球（geo-three 球面瓦片层）
 *
 * 为什么用 geo-three：
 *   本项目是「离线单文件」，不能用需要 API Key 的 MapBox/MapTiler 瓦片。
 *   geo-three 的 MapProvider 是可插拔的——这里实现一个 OfflineProvider，
 *   在本地用 canvas 把 Natural Earth 世界边界 + 中国省界画成 256px 瓦片，
 *   交给 Geo.MapView(SPHERICAL) 按四叉树 LOD 贴到球面上，全程离线、无 Key。
 *
 * 依赖：THREE · Geo(geo-three UMD) · H(helpers) · GEO_WORLD · GEO_CHINA
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var Geo = global.Geo;
  var H = global.H;

  var DEG = Math.PI / 180;
  var R = (Geo && Geo.UnitsUtils && Geo.UnitsUtils.EARTH_RADIUS) || 6371008;
  var TILE = 256;
  var MAX_Z = 3;                 /* 瓦片层级：0~3，按需细分为 64 张 z3 瓦片 */

  /* ---------------- 配色 ---------------- */
  var OCEAN_HI = [12, 30, 54];   /* 赤道附近的海面 */
  var OCEAN_LO = [4, 10, 20];    /* 高纬海面 */
  var LAND = '#15324f';
  var COAST = 'rgba(96,150,214,0.5)';
  var CHINA_FILL = 'rgba(255,176,96,0.16)';
  var CHINA_EDGE = 'rgba(255,176,96,0.62)';
  var GRID = 'rgba(110,150,215,0.13)';

  /* ============================================================
   * 1. 离线瓦片：把 GeoJSON 画成 Web Mercator 瓦片
   * ============================================================ */
  function mercY(lat) {
    var s = Math.sin(Math.max(-85, Math.min(85, lat)) * DEG);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function oceanFill(lat) {
    var t = Math.max(0, Math.min(1, 1 - Math.abs(lat) / 90));
    var r = Math.round(OCEAN_LO[0] + (OCEAN_HI[0] - OCEAN_LO[0]) * t);
    var g = Math.round(OCEAN_LO[1] + (OCEAN_HI[1] - OCEAN_LO[1]) * t);
    var b = Math.round(OCEAN_LO[2] + (OCEAN_HI[2] - OCEAN_LO[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function ringInfo(ring) {
    if (!ring || ring.length < 3) return null;
    var minLon = 999, maxLon = -999, minLat = 999, maxLat = -999;
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i], lon = p[0], lat = p[1];
      if (!isFinite(lon) || !isFinite(lat)) continue;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    if (maxLon < minLon || maxLat < minLat) return null;
    return { pts: ring, minLon: minLon, maxLon: maxLon, minLat: minLat, maxLat: maxLat };
  }

  var worldRings = null, chinaRings = null, jdRings = null;

  function prepRings() {
    if (worldRings) return;
    worldRings = []; chinaRings = []; jdRings = [];
    var w = global.GEO_WORLD && global.GEO_WORLD.countries;
    if (w) {
      for (var i = 0; i < w.length; i++) {
        var rs = w[i].rings || [];
        for (var j = 0; j < rs.length; j++) {
          var info = ringInfo(rs[j]);
          if (info) worldRings.push(info);
        }
      }
    }
    var ch = global.GEO_CHINA;
    if (ch && ch.provinces) {
      for (var k = 0; k < ch.provinces.length; k++) {
        var prs = ch.provinces[k].rings || [];
        for (var m = 0; m < prs.length; m++) {
          var ci = ringInfo(prs[m]);
          if (ci) chinaRings.push(ci);
        }
      }
    }
    if (ch && ch.jd && ch.jd.rings) {
      for (var q = 0; q < ch.jd.rings.length; q++) {
        var ji = ringInfo(ch.jd.rings[q]);
        if (ji) jdRings.push(ji);
      }
    }
  }

  function ringVisible(r, lon0, lon1, latBot, latTop) {
    if (r.maxLat < latBot - 0.5 || r.minLat > latTop + 0.5) return false;
    if (r.maxLon - r.minLon > 180) return true;          /* 跨 180° 的环不做经度裁剪 */
    return !(r.maxLon < lon0 - 0.5 || r.minLon > lon1 + 0.5);
  }

  /* 画一个环：连续化跨 180° 的经度，避免出现横贯全图的假线段 */
  function traceRing(g, pts, toX, toY, open) {
    var started = false, prevLon = 0;
    for (var i = 0; i < pts.length; i++) {
      var lon = pts[i][0], lat = pts[i][1];
      if (!isFinite(lon) || !isFinite(lat)) continue;
      if (started) {
        while (lon - prevLon > 180) lon -= 360;
        while (prevLon - lon > 180) lon += 360;
      }
      prevLon = lon;
      var x = toX(lon), y = toY(lat);
      if (!started) { g.moveTo(x, y); started = true; }
      else g.lineTo(x, y);
    }
    if (started && !open) g.closePath();
  }

  function traceRings(g, rings, lon0, lon1, latBot, latTop, toX, toY, open) {
    for (var i = 0; i < rings.length; i++) {
      if (!ringVisible(rings[i], lon0, lon1, latBot, latTop)) continue;
      traceRing(g, rings[i].pts, toX, toY, open);
    }
  }

  function drawTile(z, x, y) {
    prepRings();
    var n = Math.pow(2, z);
    var c = document.createElement('canvas');
    c.width = c.height = TILE;
    var g = c.getContext('2d');
    var lon0 = x / n * 360 - 180;
    var lon1 = (x + 1) / n * 360 - 180;
    var latTop = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / DEG;
    var latBot = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) / DEG;
    var toX = function (lon) { return ((lon + 180) / 360 * n - x) * TILE; };
    var toY = function (lat) { return (mercY(lat) * n - y) * TILE; };

    /* 海面 */
    var grad = g.createLinearGradient(0, 0, 0, TILE);
    grad.addColorStop(0, oceanFill(latTop));
    grad.addColorStop(1, oceanFill(latBot));
    g.fillStyle = grad;
    g.fillRect(0, 0, TILE, TILE);

    /* 陆地 */
    g.beginPath();
    traceRings(g, worldRings, lon0, lon1, latBot, latTop, toX, toY, false);
    g.fillStyle = LAND;
    g.fill();
    g.strokeStyle = COAST;
    g.lineWidth = 0.7;
    g.stroke();

    /* 中国省界高亮 */
    if (chinaRings.length) {
      g.beginPath();
      traceRings(g, chinaRings, lon0, lon1, latBot, latTop, toX, toY, false);
      g.fillStyle = CHINA_FILL;
      g.fill();
      g.strokeStyle = CHINA_EDGE;
      g.lineWidth = 0.9;
      g.stroke();
    }
    /* 南海诸岛（九段线） */
    if (jdRings.length) {
      g.beginPath();
      traceRings(g, jdRings, lon0, lon1, latBot, latTop, toX, toY, true);
      g.strokeStyle = 'rgba(255,176,96,0.55)';
      g.lineWidth = 0.9;
      g.stroke();
    }

    /* 经纬网 */
    g.strokeStyle = GRID;
    g.lineWidth = 0.7;
    g.beginPath();
    for (var lon = -150; lon <= 150; lon += 30) {
      if (lon < lon0 || lon > lon1) continue;
      var xx = toX(lon);
      g.moveTo(xx, 0); g.lineTo(xx, TILE);
    }
    for (var lat = -60; lat <= 60; lat += 30) {
      if (lat < latBot || lat > latTop) continue;
      var yy = toY(lat);
      g.moveTo(0, yy); g.lineTo(TILE, yy);
    }
    g.stroke();

    return c;
  }

  /* ---------------- geo-three 离线瓦片提供者 ---------------- */
  var tileCache = Object.create(null);

  class OfflineProvider extends Geo.MapProvider {
    constructor() {
      super();
      this.name = 'offline-natural-earth';
      this.minZoom = 0;
      this.maxZoom = MAX_Z;
    }
    fetchTile(z, x, y) {
      var key = z + '/' + x + '/' + y;
      if (tileCache[key]) return Promise.resolve(tileCache[key]);
      return new Promise(function (resolve) {
        /* 让出主线程，瓦片逐张出现，避免一次性卡顿 */
        setTimeout(function () {
          var tile;
          try { tile = drawTile(z, x, y); }
          catch (e) {
            tile = document.createElement('canvas');
            tile.width = tile.height = TILE;
            var tg = tile.getContext('2d');
            tg.fillStyle = '#081120'; tg.fillRect(0, 0, TILE, TILE);
          }
          tileCache[key] = tile;
          resolve(tile);
        }, 0);
      });
    }
  }

  /* 球面节点原本用 TextureLoader(image.src) 加载，这里改成直接吃 canvas */
  function patchSphereTexture() {
    if (!Geo.MapSphereNode || Geo.MapSphereNode.prototype.__offlinePatch) return;
    Geo.MapSphereNode.prototype.__offlinePatch = true;
    Geo.MapSphereNode.prototype.applyTexture = function (image) {
      if (this.disposed) return Promise.resolve();
      var tex = new THREE.Texture(image);
      tex.generateMipmaps = false;
      tex.format = THREE.RGBAFormat;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      var uni = this.material && this.material.uniforms && this.material.uniforms.uTexture;
      if (uni) {
        var old = uni.value;
        if (old && old !== tex && old.dispose) old.dispose();
        uni.value = tex;
      }
      return Promise.resolve();
    };
  }

  /* ============================================================
   * 2. 球面几何与叠加层
   * ============================================================ */
  function sph(lat, lon, k) {
    return Geo.UnitsUtils.datumsToVector(lat, lon).multiplyScalar(R * (k || 1));
  }

  function buildBand(lat1, lat2, color, opacity) {
    var segs = 96, pos = [], idx = [];
    for (var i = 0; i <= segs; i++) {
      var lon = -180 + i / segs * 360;
      var a = sph(lat1, lon, 1.003), b = sph(lat2, lon, 1.003);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (i = 0; i < segs; i++) {
      var p0 = i * 2, p1 = p0 + 1, p2 = p0 + 2, p3 = p0 + 3;
      idx.push(p0, p2, p1, p1, p2, p3);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    var mat = new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: opacity,
      side: THREE.DoubleSide, depthWrite: false
    });
    return new THREE.Mesh(geo, mat);
  }

  function dashedLatCircle(lat, color, opacity) {
    var pts = [], n = 180;
    for (var i = 0; i <= n; i++) pts.push(sph(lat, -180 + i / n * 360, 1.005));
    return H.makeLine(pts, color, {
      dashed: true, dashSize: R * 0.03, gapSize: R * 0.024, opacity: opacity
    });
  }

  function textSprite(text, color, size, scale) {
    return H.makeLabel(text, { color: color, size: size || 44, scale: R * (scale || 0.06) });
  }

  function putLabel(group, text, lat, lon, k, color, size, scale) {
    var sp = textSprite(text, color, size, scale);
    sp.position.copy(sph(lat, lon, k || 1.045));
    group.add(sp);
    return sp;
  }

  /* 视角预设：以「相机所在的经纬度 + 距离」描述 */
  var VIEWS = {
    eastAsia: { lat: 32, lon: 112, dist: 3.35 },
    north: { lat: 55, lon: 25, dist: 3.9 },
    pacific: { lat: 22, lon: 165, dist: 3.9 },
    south: { lat: -45, lon: 140, dist: 3.8 },
    global: { lat: 12, lon: 100, dist: 4.8 }
  };

  function viewAngles(v) {
    /* three.Spherical：x = r·sinφ·sinθ，z = r·sinφ·cosθ；
       geo-three 的经度 lon = atan2(-z, x)，故 θ = lon + 90° */
    return { theta: (v.lon + 90) * DEG, phi: Math.PI / 2 - v.lat * DEG };
  }

  /* ============================================================
   * 3. 场景
   * ============================================================ */
  function create(canvas, width, height, state) {
    patchSphereTexture();

    var scene = new THREE.Scene();
    var BASE_FOV = 40;
    /* 竖屏时保持水平视野，避免地球被左右裁切 */
    function fitFov(aspect) {
      if (aspect >= 1) return BASE_FOV;
      var half = Math.tan(BASE_FOV * DEG / 2) / Math.max(0.35, aspect);
      return Math.min(78, 2 * Math.atan(half) / DEG);
    }
    var camera = new THREE.PerspectiveCamera(fitFov(Math.max(1, width) / Math.max(1, height)), Math.max(1, width) / Math.max(1, height), R * 0.02, R * 40);
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 1.8));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);

    var g = (state && state.globe) || {};
    var v = VIEWS[g.view] || VIEWS.eastAsia;
    camera.position.copy(sph(v.lat, v.lon, v.dist));
    camera.lookAt(0, 0, 0);

    var orbit = H.createOrbit(camera, canvas, {
      minDist: R * 1.5, maxDist: R * 6.6,
      rotateSpeed: 0.0042, zoomSpeed: 0.0011
    });
    orbit.snap();

    /* --- geo-three 球面瓦片 --- */
    var provider = new OfflineProvider();
    var map = new Geo.MapView(Geo.MapView.SPHERICAL, provider);
    scene.add(map);
    /* 用 LODFrustum 做近处细分：距离阈值按「瓦片层级归一化」设置 */
    map.lod = new Geo.LODFrustum(R * 2.0, R * 5.0);

    /* --- 叠加层 --- */
    var beltsGroup = new THREE.Group();
    var pressureGroup = new THREE.Group();   /* 实时等压线（Open-Meteo 模式场） */
    var labelsGroup = new THREE.Group();
    scene.add(beltsGroup); scene.add(pressureGroup); scene.add(labelsGroup);

    /* 极锋带 40–60°N */
    beltsGroup.add(buildBand(40, 60, 0x3f6fd0, 0.13));
    beltsGroup.add(dashedLatCircle(40, 0x7fb0ff, 0.5));
    beltsGroup.add(dashedLatCircle(60, 0x6f9ff0, 0.35));
    /* 南半球极锋带 40–60°S（与北半球对称） */
    beltsGroup.add(buildBand(-60, -40, 0x3f6fd0, 0.11));
    beltsGroup.add(dashedLatCircle(-40, 0x7fb0ff, 0.45));
    beltsGroup.add(dashedLatCircle(-60, 0x6f9ff0, 0.3));
    /* 副热带高压带 30°N / 30°S */
    beltsGroup.add(dashedLatCircle(30, 0xffb454, 0.45));
    beltsGroup.add(dashedLatCircle(-30, 0xffb454, 0.3));
    /* 赤道低压带 */
    beltsGroup.add(buildBand(-6, 6, 0x2fbf8f, 0.1));
    beltsGroup.add(dashedLatCircle(0, 0x57e0b0, 0.45));

    putLabel(labelsGroup, '极锋带', 51, 104, 1.06, '#9fc8ff', 40, 0.052);
    putLabel(labelsGroup, '极锋带', -50, 128, 1.06, '#9fc8ff', 40, 0.052);
    putLabel(labelsGroup, '副热带高压带', 33, 152, 1.06, '#ffce8a', 36, 0.046);
    putLabel(labelsGroup, '赤道低压带', 2, 158, 1.06, '#7fe9c4', 36, 0.046);
    putLabel(labelsGroup, '中国', 36, 101, 1.07, '#ffd36b', 44, 0.058);

    /* 中国定位点 */
    var dot = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.006, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd36b })
    );
    dot.position.copy(sph(35, 103, 1.012));
    labelsGroup.add(dot);

    /* --- 实时等压线（Open-Meteo 全球气压场，经 window.FIELD） ---
     * 只画真实海平面气压等压线；不做锋面推导，也不再摆示意锋面。 */
    var pressureOn = false, pressureBuiltAt = 0, pressureTryAt = 0;
    var pressureText = '气压场：离线（联网后显示实时等压线）';
    var isobarMat = new THREE.MeshBasicMaterial({ color: 0x7fd3ff, transparent: true, opacity: 0.5 });
    var ISOBAR_LABEL = { color: '#a9dcff', size: 26, scale: 0.03 };

    function fmtTime(ts) {
      var t = new Date(ts || Date.now());
      return ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
    }
    function shortErr(s) {
      /* 只保留失败原因本身：去掉「全球气压场获取失败：」这类前缀，避免状态行套两层 */
      s = String(s || '').replace(/^[^：]*获取失败[:：]\s*/, '').replace(/^全球气压场[:：]\s*/, '');
      return s.length > 32 ? s.slice(0, 32) + '…' : s;
    }
    function clearPressure() {
      for (var i = pressureGroup.children.length - 1; i >= 0; i--) {
        var o = pressureGroup.children[i];
        pressureGroup.remove(o);
        if (o.geometry) o.geometry.dispose();
        var m = o.material;
        if (!m || m === isobarMat) continue;
        if (m.map && m.map.dispose) m.map.dispose();
        m.dispose();
      }
    }
    /* 把经纬度折线画成球面上的等压线，每个气压值只标一次数值 */
    function buildIsobars(derived) {
      clearPressure();
      var lines = (derived && derived.isobars) || [];
      var built = 0, seen = {};
      for (var i = 0; i < lines.length; i++) {
        var is = lines[i];
        var pts = (is && is.pts) || [];
        if (pts.length < 2) continue;
        var vecs = [], lastLa = null, lastLo = null, k;
        for (k = 0; k < pts.length; k++) {
          var la = pts[k][0], lo = pts[k][1];
          if (!isFinite(la) || !isFinite(lo)) continue;
          if (lastLa !== null && Math.abs(lastLa - la) < 0.05 && Math.abs(lastLo - lo) < 0.05) continue;
          vecs.push(sph(la, lo, 1.004));
          lastLa = la; lastLo = lo;
        }
        if (vecs.length < 2) continue;
        var curve = new THREE.CatmullRomCurve3(vecs);
        pressureGroup.add(new THREE.Mesh(
          new THREE.TubeGeometry(curve, Math.max(16, vecs.length * 4), R * 0.0016, 5, false), isobarMat));
        built++;
        if (isFinite(is.hpa) && !seen[is.hpa] && vecs.length >= 5) {
          seen[is.hpa] = 1;
          var lp = curve.getPointAt(0.5).clone().multiplyScalar(1.012);
          var lab = textSprite(String(Math.round(is.hpa)), ISOBAR_LABEL.color, ISOBAR_LABEL.size, ISOBAR_LABEL.scale);
          lab.position.copy(lp);
          pressureGroup.add(lab);
        }
      }
      pressureOn = built > 0;
      return built;
    }
    function refreshPressure() {
      var st = null;
      try { st = (global.FIELD && global.FIELD.get) ? global.FIELD.get('global') : null; } catch (e) { st = null; }
      if (!st) { pressureOn = false; pressureText = '气压场：离线（联网后显示实时等压线）'; return; }
      if (st.state === 'ok' && st.grid && st.derived) {
        if (st.updated !== pressureBuiltAt) {
          pressureBuiltAt = st.updated;
          try { buildIsobars(st.derived); } catch (e) { pressureOn = false; }
        }
        pressureText = pressureOn
          ? ('气压场：实时（' + fmtTime(st.updated) + '，Open-Meteo 模式场）')
          : '气压场：当前场未生成等压线（稍后自动重试）';
      } else if (st.state === 'error' || st.state === 'idle') {
        pressureOn = false;
        var reason = shortErr(st.text);
        pressureText = /额度/.test(reason)
          ? '气压场：今日额度已用完，明日自动恢复'
          : '气压场：获取失败（' + reason + '）';
      } else {
        pressureText = '气压场：正在获取全球气压…';
      }
    }
    function pushPressureText() {
      var el = document.getElementById('globePressure');
      if (el && el.textContent !== pressureText) el.textContent = pressureText;
    }

    /* --- 实时天气图层（全球 8 城，Open-Meteo） --- */
    var liveGroup = new THREE.Group();
    scene.add(liveGroup);
    var liveLayer = null, liveData = null, liveBusy = false, liveErr = '', liveLastTry = 0;
    if (global.GLOBE_LIVE && global.GLOBE_LIVE.buildLayer) {
      try {
        liveLayer = global.GLOBE_LIVE.buildLayer({
          THREE: THREE, H: H, R: R, group: liveGroup, toVec: sph
        });
      } catch (e) { liveLayer = null; }
    }

    function liveText() {
      if (!liveLayer) return '实时天气：图层不可用';
      if (liveBusy) return '实时天气：正在获取…';
      if (liveErr) {
        if (/429|频繁/.test(liveErr)) return '实时天气：请求过于频繁（429），稍后自动重试';
        return '实时天气获取失败：' + liveErr;
      }
      if (liveData && liveData.updated) {
        var t = new Date(liveData.updated);
        var hh = ('0' + t.getHours()).slice(-2), mm = ('0' + t.getMinutes()).slice(-2);
        return '实时天气：更新于 ' + hh + ':' + mm + '（' + (liveData.source || 'Open-Meteo') + '）';
      }
      return '实时天气：待获取';
    }
    function pushLiveText() {
      var el = document.getElementById('globeLive');
      if (el) el.textContent = liveText();
    }
    function fetchLive(force) {
      if (!liveLayer || !global.GLOBE_LIVE || liveBusy) return;
      if (!force && Date.now() - liveLastTry < 30000) return;
      var fresh = liveData && liveData.updated && (Date.now() - (+liveData.updated) < 8 * 60 * 1000);
      if (!force && fresh) { try { liveLayer.update(liveData); } catch (e) { } return; }
      liveLastTry = Date.now();
      liveBusy = true; liveErr = ''; pushLiveText();
      global.GLOBE_LIVE.fetchAll().then(function (d) {
        liveBusy = false;
        liveData = d;
        try { liveLayer.update(d); } catch (e) { liveErr = String(e && e.message || e); }
        rescaleSprites(true);
        pushLiveText();
      }).catch(function (e) {
        liveBusy = false;
        liveErr = String(e && e.message || e || '网络错误');
        pushLiveText();
      });
    }

    function applyToggles(gg) {
      gg = gg || {};
      beltsGroup.visible = gg.belts !== false;
      /* 等压线：有实时数据时按开关显示；没有数据时整组隐藏（不做任何伪造） */
      pressureGroup.visible = gg.isobars !== false && pressureOn;
      labelsGroup.visible = gg.labels !== false;
      var liveOn = gg.live !== false;
      liveGroup.visible = liveOn && !!liveLayer;
      if (liveLayer) {
        try { liveLayer.setVisible(liveOn); } catch (e) { }
        if (liveOn) fetchLive(false);
      }
    }

    /* 小屏补偿：精灵是世界单位，画布越小、文字越小，这里按宽度放大；
       同时按相机距离缩放，拉远看全球时文字不会挤成一团。 */
    var TEXT_GROUPS = [labelsGroup, pressureGroup, liveGroup];
    var widthFactor = 1, lastTextFactor = 0;
    function rescaleSprites(force) {
      var w = (renderer.domElement && renderer.domElement.clientWidth) || width;
      widthFactor = Math.max(1, Math.min(1.6, 1100 / Math.max(320, w)));
      var dist = camera.position.length() / R;
      var zoomFactor = Math.max(0.55, Math.min(1.35, 3.35 / Math.max(1.2, dist)));
      var f = widthFactor * zoomFactor;
      if (!force && Math.abs(f - lastTextFactor) < 0.03) return;
      lastTextFactor = f;
      for (var gi = 0; gi < TEXT_GROUPS.length; gi++) {
        TEXT_GROUPS[gi].traverse(function (o) {
          if (!o.isSprite) return;
          if (!o.userData.__baseScale) o.userData.__baseScale = o.scale.clone();
          var b = o.userData.__baseScale;
          o.scale.set(b.x * f, b.y * f, 1);
        });
      }
    }
    rescaleSprites(true);
    applyToggles(g);

    function applyView(name) {
      var vv = VIEWS[name] || VIEWS.eastAsia;
      var ang = viewAngles(vv);
      orbit.setAngles(ang.theta, ang.phi, R * vv.dist);
    }

    function setView(name) { applyView(name); }

    function resize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = Math.max(1, w) / Math.max(1, h);
      camera.fov = fitFov(camera.aspect);
      camera.updateProjectionMatrix();
      rescaleSprites(true);
    }

    var spinOn = g.spin !== false;
    function frame(st, dt) {
      var gg = st && st.globe;
      if (gg) { spinOn = gg.spin !== false; }
      if (spinOn) orbit.spin(dt, 0.014);
      orbit.update(dt);
      rescaleSprites();
      /* 实时天气：数据超过 8 分钟自动刷新（与 GLOBE_LIVE 的 8 分钟缓存对齐） */
      if (liveLayer && gg && gg.live !== false && !liveBusy &&
        (!liveData || Date.now() - (+liveData.updated) > 8 * 60 * 1000)) {
        fetchLive(false);
      }
      /* 全球气压场：20s 节流检查（FIELD 内部另有 10 分钟缓存与失败退避） */
      if (gg && gg.isobars !== false && Date.now() - pressureTryAt > 20000) {
        pressureTryAt = Date.now();
        refreshPressure();
        applyToggles(gg);
        pushPressureText();
      }
      renderer.render(scene, camera);
    }

    function dispose() {
      try { orbit.dispose(); } catch (e) { }
      if (liveLayer) { try { liveLayer.dispose(); } catch (e) { } }
      scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map && o.material.map.dispose) o.material.map.dispose();
          o.material.dispose();
        }
      });
      renderer.dispose();
    }

    var api = {
      scene: scene, camera: camera, renderer: renderer, map: map,
      setView: setView, setToggles: applyToggles, resize: resize, frame: frame, dispose: dispose
    };
    global.__M8 = api;
    return api;
  }
  /* ============================================================
   * 4. 导出
   * ============================================================ */
  var MODELS = global.MODELS || (global.MODELS = {});
  if (THREE && Geo && H) {
    MODELS.M8 = function (ctx) {
      return create(ctx.canvas, ctx.width, ctx.height, ctx.state);
    };
  }
  /* 供自检脚本调用（不依赖 WebGL） */
  global.M8_TILE = { drawTile: drawTile, offlineProvider: OfflineProvider };
})(window);
