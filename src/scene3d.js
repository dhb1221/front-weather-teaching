/* ============================================================
 * scene3d.js — M1 立体空间模型（three.js）
 * 冷/暖气团、倾斜锋面、锋线、锋面符号、云、雨雪、气流箭头、观测站
 * 视角预设：iso 斜视 / profile 正剖面 / top 俯视 / cold 冷气团侧 / warm 暖气团侧
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var L = 18;                  // 与 FRONT.L 一致
  var H = 8;                   // 场景高度
  var Z = 10;                  // 锋线沿 z 的半长
  var TARGET = null;

  function has3D() {
    return !!(THREE && global.WebGLRenderingContext);
  }

  /* 生成锋面（局部坐标：锋线在 x=0，y=0），冷锋在 x<0 抬升，暖锋在 x>0 抬升 */
  function buildFrontSurface(type, slope) {
    var steps = 26, zSteps = 12;
    var maxY = H;
    var half = Math.min(L, maxY / Math.max(0.04, slope));
    var xs = [];
    for (var i = 0; i <= steps; i++) {
      var u = i / steps;
      xs.push((type === 'warm' ? 1 : -1) * half * u);
    }
    var pos = [], idx = [];
    for (var zi = 0; zi <= zSteps; zi++) {
      var z = -Z + (2 * Z) * (zi / zSteps);
      for (var xi = 0; xi <= steps; xi++) {
        var x = xs[xi];
        var y = Math.min(maxY, Math.abs(x) * slope);
        pos.push(x, y, z);
      }
    }
    var row = steps + 1;
    for (var z2 = 0; z2 < zSteps; z2++) {
      for (var x2 = 0; x2 < steps; x2++) {
        var a = z2 * row + x2, b = a + 1, c = a + row, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  function makeArrow3D(len, color) {
    var g = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.9 });
    var shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, len * 0.72, 6), mat);
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = len * 0.36;
    g.add(shaft);
    var head = new THREE.Mesh(new THREE.ConeGeometry(0.16, len * 0.34, 8), mat);
    head.rotation.z = -Math.PI / 2;
    head.position.x = len * 0.85;
    g.add(head);
    return g;
  }

  /* 把 canvas 绘制的锋面符号排成一排，贴在地面上（沿 z 方向铺开） */
  function buildSymbolStrip(type) {
    var pad = 3;
    var cell = 96;
    var c = document.createElement('canvas');
    c.width = cell; c.height = cell * 2;
    var g = c.getContext('2d');
    var groups = new THREE.Group();
    for (var i = 0; i < 9; i++) {
      var z = -Z + 1.6 + i * (2 * Z - 3.2) / 8;
      g.clearRect(0, 0, c.width, c.height);
      var color = type === 'cold' ? '#7dc0ff' : type === 'warm' ? '#ff9a8a' : '#d3b0ff';
      g.fillStyle = color;
      g.strokeStyle = color;
      if (type === 'cold') {
        g.beginPath();
        g.moveTo(cell * 0.12, cell * 2 - pad);
        g.lineTo(cell * 0.88, cell * 2 - pad);
        g.lineTo(cell * 0.5, cell * 0.28);
        g.closePath();
        g.fill();
      } else if (type === 'warm') {
        g.beginPath();
        g.arc(cell * 0.5, cell * 2 - pad, cell * 0.38, Math.PI, 0, false);
        g.closePath();
        g.fill();
      } else {
        if (i % 2 === 0) {
          g.beginPath();
          g.moveTo(cell * 0.1, cell * 2 - pad);
          g.lineTo(cell * 0.9, cell * 2 - pad);
          g.lineTo(cell * 0.5, cell * 0.3);
          g.closePath();
          g.fill();
        } else {
          g.beginPath();
          g.arc(cell * 0.5, cell * 2 - pad, cell * 0.4, Math.PI, 0, false);
          g.closePath();
          g.fill();
        }
      }
      var tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.95 });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(1.05, 2.1, 1);
      sp.position.set(0.55, 0.06, z);
      sp.userData.isSymbol = true;
      groups.add(sp);
    }
    return groups;
  }

  function cloudField(kind) {
    var tex = global.H.makeSoftTexture('cloud');
    var g = new THREE.Group();
    var i, mat, sp, u, s, r, ang;
    if (kind === 'cumulo') {
      /* 积雨云：底部扁平云盘 + 高耸云柱 + 顶部云砧（向 +x 铺展） */
      var baseN = 9, colN = 11, anvilN = 7;
      for (i = 0; i < baseN; i++) {
        u = i / (baseN - 1);
        mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5, color: 0x74879e });
        sp = new THREE.Sprite(mat);
        ang = u * Math.PI * 2;
        r = 2.5 + Math.cos(u * 3.1) * 0.5;
        sp.position.set(Math.cos(ang) * r * 0.8, 2.15 + Math.sin(u * 2) * 0.16, Math.sin(ang) * r * 1.15);
        s = 2.5 + Math.random() * 0.8;
        sp.userData.puff = { kind: 'base', sx: s * 1.3, sy: s * 0.6, y0: sp.position.y, u: 0 };
        g.add(sp);
      }
      for (i = 0; i < colN; i++) {
        u = i / (colN - 1);
        mat = new THREE.SpriteMaterial({
          map: tex, transparent: true, depthWrite: false, opacity: 0.62,
          color: u > 0.72 ? 0xffffff : 0xc6d6e9
        });
        sp = new THREE.Sprite(mat);
        r = 1.5 * (1 - u * 0.55);
        ang = i * 2.4;
        sp.position.set(Math.cos(ang) * r * 0.85, 2.35 + u * 4.3, Math.sin(ang) * r);
        s = 3.0 - u * 1.0 + Math.random() * 0.5;
        sp.userData.puff = { kind: 'col', sx: s, sy: s * 0.95, y0: sp.position.y, u: u };
        g.add(sp);
      }
      for (i = 0; i < anvilN; i++) {
        u = i / (anvilN - 1);
        mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.3, color: 0xeef4ff });
        sp = new THREE.Sprite(mat);
        sp.position.set(0.6 + u * 4.8, 6.5 + Math.sin(u * 2.2) * 0.22, (u - 0.5) * 3.4);
        s = 2.4 + u * 1.1;
        sp.userData.puff = { kind: 'anvil', sx: s * 1.5, sy: s * 0.5, y0: sp.position.y, u: u };
        g.add(sp);
      }
    } else {
      /* 层状云：两层水平云毯 + 低空雨层云，边缘用大而淡的片铺开 */
      var rows = [{ y: 3.55, w: 4.4, o: 0.24 }, { y: 4.4, w: 3.2, o: 0.18 }];
      for (i = 0; i < 34; i++) {
        var rr = rows[i % 2];
        mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: rr.o, color: 0xd8e3f2 });
        sp = new THREE.Sprite(mat);
        sp.position.set(0.3 + (i / 34) * 9.8, rr.y + Math.random() * 0.3, -Z + 0.4 + Math.random() * (2 * Z - 0.8));
        s = rr.w + Math.random() * 1.9;
        sp.scale.set(s, s * 0.32, 1);
        sp.userData.baseY = sp.position.y;
        sp.userData.baseX = sp.position.x;
        sp.userData.ph = Math.random() * 6.28;
        sp.userData.sx = s;
        sp.userData.sy = s * 0.32;
        g.add(sp);
      }
    }
    return g;
  }

  function makeStation() {
    var g = new THREE.Group();
    var body = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.7, 0.95),
      new THREE.MeshBasicMaterial({ color: 0x1b2b48 })
    );
    body.position.y = 0.35;
    g.add(body);
    var roof = new THREE.Mesh(
      new THREE.ConeGeometry(0.82, 0.52, 4),
      new THREE.MeshBasicMaterial({ color: 0x3d6ea8 })
    );
    roof.position.y = 0.96;
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    var pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6),
      new THREE.MeshBasicMaterial({ color: 0x8fb4dd })
    );
    pole.position.set(0.62, 1.2, 0);
    g.add(pole);
    var flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.85, 0.34),
      new THREE.MeshBasicMaterial({ color: 0x7dc0ff, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
    );
    flag.position.set(1.06, 2.2, 0);
    g.add(flag);
    g.userData.flag = flag;
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 1.72, 48),
      new THREE.MeshBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    g.add(ring);
    return g;
  }

  function cloudTextureSprite() { return null; }

  function create(canvas) {
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x05070f, 0);
    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05070f, 0.016);
    var camera = new THREE.PerspectiveCamera(44, 1, 0.1, 400);
    TARGET = new THREE.Vector3(0, 2.1, 0);
    camera.position.set(-18, 11, 24);
    var orbit = global.H.createOrbit(camera, canvas, {
      target: TARGET, minDist: 9, maxDist: 72,
      rotateSpeed: 0.005, zoomSpeed: 0.0015
    });

    scene.add(new THREE.AmbientLight(0x6b86b8, 1.1));
    var keyLight = new THREE.DirectionalLight(0xdfe9ff, 1.2);
    keyLight.position.set(-16, 26, 18);
    scene.add(keyLight);
    var flashLight = new THREE.PointLight(0xbfe0ff, 0, 40, 2);
    flashLight.position.set(0, 5, 0);
    scene.add(flashLight);

    /* 地面 + 网格 */
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 90),
      new THREE.MeshBasicMaterial({ color: 0x070c16 })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    var gridPts = [];
    for (var gx = -30; gx <= 30; gx += 2) { gridPts.push(gx, 0.01, -Z * 1.4, gx, 0.01, Z * 1.4); }
    for (var gz = -14; gz <= 14; gz += 2) { gridPts.push(-30, 0.01, gz, 30, 0.01, gz); }
    var gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    var grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({
      color: 0x1d2f4d, transparent: true, opacity: 0.55
    }));
    scene.add(grid);

    /* 锋面 + 锋线（每帧按类型重建形状） */
    var frontGroup = new THREE.Group();
    scene.add(frontGroup);
    var surfaceMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: 0xbcd8ff, transparent: true, opacity: 0.13, side: THREE.DoubleSide,
      depthWrite: false
    }));
    surfaceMesh.renderOrder = 2;
    frontGroup.add(surfaceMesh);
    var surfaceWire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: 0x9fc4ff, transparent: true, opacity: 0.28
    }));
    frontGroup.add(surfaceWire);
    var frontLine = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.06, 2 * Z),
      new THREE.MeshBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0.95 })
    );
    frontLine.position.y = 0.04;
    frontGroup.add(frontLine);
    var symbolStrip = buildSymbolStrip('cold');
    frontGroup.add(symbolStrip);

    /* 气团体块（半透明） */
    var coldBox = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x2b6fbf, transparent: true, opacity: 0.10, depthWrite: false })
    );
    var warmBox = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xc4612c, transparent: true, opacity: 0.08, depthWrite: false })
    );
    scene.add(coldBox); scene.add(warmBox);

    /* 气团粒子 */
    var NC = 320, NW = 300;
    var coldP = [], warmP = [];
    var coldPos = new Float32Array(NC * 3), warmPos = new Float32Array(NW * 3);
    for (var i = 0; i < NC; i++) {
      coldP.push({
        x: -L + Math.random() * (2 * L), y: 0.15 + Math.random() * 2.6,
        z: -Z + Math.random() * 2 * Z, v: 0.5 + Math.random() * 0.9
      });
    }
    for (var j = 0; j < NW; j++) {
      warmP.push({
        x: -L + Math.random() * (2 * L), y: 0.4 + Math.random() * 5.2,
        z: -Z + Math.random() * 2 * Z, v: 0.4 + Math.random() * 0.8
      });
    }
    var coldGeo = new THREE.BufferGeometry();
    coldGeo.setAttribute('position', new THREE.BufferAttribute(coldPos, 3));
    var coldPts = new THREE.Points(coldGeo, new THREE.PointsMaterial({
      color: 0x5aa4ff, size: 0.16, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    scene.add(coldPts);
    var warmGeo = new THREE.BufferGeometry();
    warmGeo.setAttribute('position', new THREE.BufferAttribute(warmPos, 3));
    var warmPts = new THREE.Points(warmGeo, new THREE.PointsMaterial({
      color: 0xff9a4d, size: 0.16, transparent: true, opacity: 0.8,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    scene.add(warmPts);

    /* 气流箭头（局部坐标，定位在锋面处） */
    var arrowGroup = new THREE.Group();
    scene.add(arrowGroup);
    var pushArrows = [], climbArrows = [];
    for (var k = -1; k <= 1; k++) {
      var a1 = makeArrow3D(4.2, 0x8fc8ff);
      a1.position.set(-5.2, 0.55, k * 6.2);
      a1.userData.z = k * 6.2;
      arrowGroup.add(a1); pushArrows.push(a1);
    }
    var climbDefs = [[0.9, 0.75, -3.4, 2.9], [1.2, 1.1, -3.1, 3.4], [1.5, 1.5, -2.8, 3.9]];
    for (var m = 0; m < 3; m++) {
      var d = climbDefs[m];
      var a2 = makeArrow3D(4.6, 0xffc27a);
      a2.position.set(d[0], d[1], -3 + m * 3);
      var dx = d[2] - d[0], dy = d[3] - d[1];
      a2.rotation.z = Math.atan2(dy, dx);
      arrowGroup.add(a2); climbArrows.push(a2);
    }

    /* 云 + 雨/雪 */
    var clouds = { cumulo: cloudField('cumulo'), layer: cloudField('layer') };
    scene.add(clouds.cumulo); scene.add(clouds.layer);

    /* 降雨：线段粒子（每滴一条倾斜雨丝）+ 地面涟漪，比点精灵更像真雨 */
    var RAIN_N = 820;
    var rainSeg = new Float32Array(RAIN_N * 6);
    var rainDrops = [];
    for (var r = 0; r < RAIN_N; r++) {
      rainDrops.push({
        x: (Math.random() * 2 - 1) * 14, y: Math.random() * 3.4,
        z: -Z + Math.random() * 2 * Z,
        len: 0.4 + Math.random() * 0.55,
        sp: 13 + Math.random() * 9,
        k: 0.55 + Math.random() * 0.45
      });
    }
    var rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainSeg, 3));
    var rainMat = new THREE.LineBasicMaterial({
      color: 0xcde6ff, transparent: true, opacity: 0.55, depthWrite: false
    });
    var rainPts = new THREE.LineSegments(rainGeo, rainMat);
    rainPts.frustumCulled = false; /* 顶点每帧变化，包围球不可信 */
    rainPts.visible = false;
    scene.add(rainPts);

    /* 雨区水汽：稀疏大颗粒雾点，让雨幕有体积感 */
    var MIST_N = 130;
    var mistPos = new Float32Array(MIST_N * 3);
    var mistState = [];
    for (var mi = 0; mi < MIST_N; mi++) {
      mistState.push({ x: 0, y: Math.random() * 4.5, z: -Z + Math.random() * 2 * Z, v: 0.7 + Math.random() * 0.8 });
    }
    var mistGeo = new THREE.BufferGeometry();
    mistGeo.setAttribute('position', new THREE.BufferAttribute(mistPos, 3));
    var mistMat = new THREE.PointsMaterial({
      map: global.H.makeSoftTexture('cloud'), color: 0x9ec4ea, size: 2.4,
      transparent: true, opacity: 0.06, depthWrite: false, sizeAttenuation: true
    });
    var mistPts = new THREE.Points(mistGeo, mistMat);
    mistPts.frustumCulled = false;
    mistPts.visible = false;
    scene.add(mistPts);

    /* 地面涟漪（雨滴落地） */
    function ringTexture() {
      var c = document.createElement('canvas');
      c.width = c.height = 64;
      var g2 = c.getContext('2d');
      g2.strokeStyle = 'rgba(190,225,255,0.9)';
      g2.lineWidth = 4;
      g2.beginPath();
      g2.arc(32, 32, 24, 0, Math.PI * 2);
      g2.stroke();
      var t = new THREE.CanvasTexture(c);
      return t;
    }
    var ringTex = ringTexture();
    var SPLASH_N = 54;
    var splashGroup = new THREE.Group();
    splashGroup.rotation.x = -Math.PI / 2;
    splashGroup.position.y = 0.03;
    scene.add(splashGroup);
    var splashes = [];
    for (var sp2 = 0; sp2 < SPLASH_N; sp2++) {
      var smat = new THREE.MeshBasicMaterial({
        map: ringTex, transparent: true, opacity: 0, depthWrite: false, color: 0xbfe2ff
      });
      var smesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), smat);
      smesh.frustumCulled = false;
      smesh.visible = false;
      splashGroup.add(smesh);
      splashes.push({
        mesh: smesh, mat: smat, ph: Math.random(),
        x: (Math.random() * 2 - 1) * 10, z: -Z + Math.random() * 2 * Z
      });
    }

    var snowCount = 260;
    var snowPos = new Float32Array(snowCount * 3);
    var snowState = [];
    for (var s = 0; s < snowCount; s++) {
      snowState.push({
        x: 0, y: Math.random() * 6, z: -Z + Math.random() * 2 * Z,
        v: 1.6 + Math.random(), ph: Math.random() * 6.28
      });
    }
    var snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
    var snowPts = new THREE.Points(snowGeo, new THREE.PointsMaterial({
      map: global.H.makeSoftTexture('snow'), color: 0xffffff, size: 0.28,
      transparent: true, opacity: 0.9, depthWrite: false
    }));
    snowPts.frustumCulled = false;
    snowPts.visible = false;
    scene.add(snowPts);

    /* 云影：云下雨区在地面上压暗一片 */
    var cloudShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({ color: 0x03060d, transparent: true, opacity: 0.2, depthWrite: false })
    );
    cloudShadow.rotation.x = -Math.PI / 2;
    cloudShadow.position.y = 0.015;
    scene.add(cloudShadow);

    /* 观测站 */
    var station = makeStation();
    scene.add(station);

    /* 三维文字标签 */
    var labels = {};
    function addLabel(key, text, color, size) {
      var sp = global.H.makeLabel(text, { color: color, size: 40, scale: 1.05 });
      sp.userData.baseScale = 1.05;
      labels[key] = sp;
      scene.add(sp);
      return sp;
    }
    addLabel('cold', '冷气团', '#9fc8ff');
    addLabel('warm', '暖气团', '#ffc394');
    addLabel('front', '锋面', '#ffffff', 0.9);
    addLabel('line', '锋线', '#cfe4ff', 0.9);
    addLabel('rain', '云雨区', '#9fd8ff', 0.9);
    addLabel('station', '观测站', '#d8c2ff', 0.9);
    addLabel('move', '移动方向', '#ffd36b', 0.85);
    addLabel('slope', '', '#9fb8d8', 0.8);

    var moveArrow = makeArrow3D(3.4, 0xffd36b);
    scene.add(moveArrow);

    var state = { type: 'cold', t: 0.22 };
    var geoCache = {};
    var time = 0;
    var lastType = '';
    var cloudSum = 0;

    function frontFor(type, t) {
      return global.FRONT.xFront(type, t);
    }

    function setType(type) {
      if (geoCache[type]) return;
      var slope = global.FRONT.meta[type].slope;
      var geo = buildFrontSurface(type, slope);
      var wire = new THREE.WireframeGeometry(geo);
      geoCache[type] = { geo: geo, wire: wire };
    }

    function applyType(type) {
      setType(type);
      var g = geoCache[type];
      surfaceMesh.geometry = g.geo;
      surfaceWire.geometry = g.wire;
      var meta = global.FRONT.meta[type];
      surfaceMesh.material.color.set(type === 'warm' ? 0xffbf9f : type === 'cold' ? 0x9fc4ff : 0xd0b6ff);
      frontGroup.remove(symbolStrip);
      symbolStrip = buildSymbolStrip(type);
      frontGroup.add(symbolStrip);
      /* 爬升箭头按类型调整 */
      climbArrows.forEach(function (a, idx) {
        var d;
        if (type === 'warm') d = [[1.4, 0.7, 8.4, 2.5], [1.8, 1.0, 9.0, 3.0], [2.2, 1.3, 9.4, 3.4]][idx];
        else if (type === 'stationary') d = [[0.8, 0.7, -3.0, 2.2], [1.0, 1.0, -2.8, 2.6], [1.2, 1.3, -2.6, 3.0]][idx];
        else d = [[0.9, 0.75, -3.4, 2.9], [1.2, 1.1, -3.1, 3.4], [1.5, 1.5, -2.8, 3.9]][idx];
        a.position.set(d[0], d[1], -3 + idx * 3);
        var dx = d[2] - d[0], dy = d[3] - d[1];
        a.rotation.z = Math.atan2(dy, dx);
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        a.scale.setScalar(Math.max(0.7, len / 4.6));
      });
      global.H.setLabelText(labels.front, '锋面 · ' + meta.name, { color: '#ffffff', size: 40, scale: 1.0 });
      global.H.setLabelText(labels.slope, meta.slopeText, { color: '#9fb8d8', size: 32, scale: 0.78 });
    }

    var views = {
      iso: [-18, 11, 24],
      profile: [0.5, 2.6, 27],
      top: [0.4, 34, 2],
      cold: [-27, 4.2, 0.6],
      warm: [27, 4.2, 0.6]
    };

    var api = {
      scene: scene, camera: camera, renderer: renderer,
      setView: function (name) {
        var v = views[name] || views.iso;
        orbit.setView(v[0], v[1], v[2]);
      },
      resize: function (w, h) {
        renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      },
      frame: function (st, dt) {
        dt = Math.min(0.05, dt || 0.016);
        time += dt;
        state = st;
        var type = st.type, t = st.t, p = t;
        if (type !== lastType) { applyType(type); lastType = type; }
        var FRONT = global.FRONT;
        var meta = FRONT.meta[type];
        var cur = FRONT.curve(type, t);
        var xf = frontFor(type, t);
        frontGroup.position.x = xf;
        frontLine.material.opacity = 0.75 + 0.25 * Math.sin(time * 3);
        symbolStrip.position.x = 0;

        /* 气团体块 */
        var coldLeft = type === 'warm' ? xf : -L;
        var coldRight = type === 'warm' ? L : xf;
        coldBox.scale.set(Math.max(0.1, coldRight - coldLeft), 2.6, 2 * Z);
        coldBox.position.set((coldLeft + coldRight) / 2, 1.3, 0);
        var wLeft = type === 'warm' ? -L : xf;
        var wRight = type === 'warm' ? xf : L;
        warmBox.scale.set(Math.max(0.1, wRight - wLeft), 6.4, 2 * Z);
        warmBox.position.set((wLeft + wRight) / 2, 3.2, 0);

        /* 粒子：冷气团沿 +x 推进、暖空气贴锋面爬升 */
        for (var i = 0; i < NC; i++) {
          var cp = coldP[i];
          cp.x += cp.v * dt * (type === 'stationary' ? 0.25 : 1);
          if (cp.x > xf - 0.4) {
            cp.x = -L + Math.random() * 2;
            cp.y = 0.15 + Math.random() * 2.2;
            cp.z = -Z + Math.random() * 2 * Z;
          }
          if (type === 'warm' && cp.x > xf) { cp.x = -L + Math.random() * 2; }
          coldPos[i * 3] = cp.x; coldPos[i * 3 + 1] = cp.y; coldPos[i * 3 + 2] = cp.z;
        }
        for (var j = 0; j < NW; j++) {
          var wp = warmP[j];
          wp.x -= wp.v * dt * (type === 'stationary' ? 0.3 : 1);
          if (wp.x < xf + 0.3) {
            wp.x = L - Math.random() * 3;
            wp.y = 0.5 + Math.random() * 3.2;
            wp.z = -Z + Math.random() * 2 * Z;
          }
          if (type !== 'warm' && wp.x < xf) { wp.x = L - Math.random() * 2; }
          /* 靠近锋面时抬升 */
          var near = Math.max(0, 1 - Math.abs(wp.x - xf) / 12);
          if (near > 0.05) wp.y = Math.min(6.6, wp.y + near * 0.9 * dt);
          warmPos[j * 3] = wp.x; warmPos[j * 3 + 1] = wp.y; warmPos[j * 3 + 2] = wp.z;
        }
        coldGeo.attributes.position.needsUpdate = true;
        warmGeo.attributes.position.needsUpdate = true;

        /* 箭头 */
        arrowGroup.position.x = xf;
        pushArrows.forEach(function (a) { a.visible = !!st.show.air; });
        climbArrows.forEach(function (a) { a.visible = !!st.show.air; });

        /* 云 */
        cloudSum = cur.cloud;
        var cumOn = type !== 'warm';
        clouds.cumulo.visible = !!st.show.clouds && cumOn && cloudSum > 0.03;
        clouds.layer.visible = !!st.show.clouds && (!cumOn || cloudSum > 0.03);
        clouds.cumulo.position.x = xf - 1.2;
        clouds.layer.position.x = xf + 1.6;
        clouds.cumulo.children.forEach(function (sp) {
          var pd = sp.userData.puff;
          var grow = 0.55 + 0.45 * Math.min(1, cloudSum * 1.05);
          sp.scale.set(pd.sx * grow, pd.sy * grow, 1);
          if (pd.kind === 'col') sp.position.y = pd.y0 + (cloudSum - 0.35) * 0.7 * pd.u;
          sp.material.opacity = (pd.kind === 'anvil' ? 0.16 : pd.kind === 'base' ? 0.34 : 0.42) * (0.45 + 0.55 * cloudSum);
        });
        clouds.layer.children.forEach(function (sp) {
          sp.material.opacity = 0.08 + 0.26 * cloudSum;
          sp.scale.set(sp.userData.sx * (0.7 + 0.3 * cloudSum), sp.userData.sy, 1);
          sp.position.y = sp.userData.baseY + Math.sin(time * 0.6 + sp.userData.ph) * 0.12;
        });

        /* 雨/雪：雨区与 2D 视图同一套数据（FRONT.span），冷锋在锋后、暖锋在锋前 */
        var rain = cur.rain;
        var isSnow = cur.temp < 1.5;
        var rsp = FRONT.span(type, t, 'rain');
        var rL = Math.max(-L, Math.min(L, rsp.x0));
        var rR = Math.max(-L, Math.min(L, rsp.x1));
        var bandW = Math.max(0.6, rR - rL);
        var slant = type === 'cold' ? -0.42 : type === 'warm' ? -0.16 : -0.26;
        rainPts.visible = !!st.show.rain && rain > 0.02 && !isSnow;
        snowPts.visible = !!st.show.rain && rain > 0.02 && isSnow;
        mistPts.visible = !!st.show.rain && rain > 0.05 && !isSnow;
        rainMat.opacity = Math.min(0.9, 0.26 + rain * 0.66);
        cloudShadow.visible = !!st.show.clouds;
        cloudShadow.position.x = (rL + rR) / 2;
        cloudShadow.scale.set(bandW * 0.62 + 1.2, (bandW * 0.62 + 1.2) * 0.8, 1);
        cloudShadow.material.opacity = 0.06 + 0.22 * rain;
        if (rainPts.visible) {
          var active = Math.floor(RAIN_N * Math.min(1, 0.2 + rain * 0.9));
          rainGeo.setDrawRange(0, active * 2);
          for (var q = 0; q < active; q++) {
            var rs = rainDrops[q];
            rs.y -= rs.sp * dt;
            if (rs.y < 0.05) {
              /* 云底（约 2.3~2.6）以下开始下雨，避免雨丝出现在云顶之上 */
              rs.y = 2.4 + Math.random() * 1.3;
              rs.x = rL + Math.random() * bandW;
            }
            var len = rs.len;
            rainSeg[q * 6] = rs.x;
            rainSeg[q * 6 + 1] = rs.y;
            rainSeg[q * 6 + 2] = rs.z;
            rainSeg[q * 6 + 3] = rs.x + slant * len;
            rainSeg[q * 6 + 4] = rs.y - len;
            rainSeg[q * 6 + 5] = rs.z;
          }
          rainGeo.attributes.position.needsUpdate = true;
        }
        if (mistPts.visible) {
          for (var mq = 0; mq < MIST_N; mq++) {
            var ms = mistState[mq];
            ms.y -= ms.v * dt;
            if (ms.y < 0.4) {
              ms.y = 4.2 + Math.random() * 1.6;
              ms.x = rL + Math.random() * bandW;
            }
            if (!ms.x) ms.x = rL + Math.random() * bandW;
            mistPos[mq * 3] = ms.x;
            mistPos[mq * 3 + 1] = ms.y;
            mistPos[mq * 3 + 2] = ms.z;
          }
          mistGeo.attributes.position.needsUpdate = true;
          mistMat.opacity = 0.03 + 0.07 * rain;
        }
        /* 地面涟漪：雨区边缘扩散的水圈 */
        var splashOn = !!st.show.rain && rain > 0.06 && !isSnow;
        for (var sq = 0; sq < SPLASH_N; sq++) {
          var spl = splashes[sq];
          if (!splashOn) { spl.mesh.visible = false; continue; }
          spl.ph += dt * (1.3 + 0.9 * rain);
          if (spl.ph >= 1) {
            spl.ph = 0;
            spl.x = rL + Math.random() * bandW;
            spl.z = -Z + Math.random() * 2 * Z;
          }
          spl.mesh.visible = true;
          var sc = 0.26 + spl.ph * 1.1;
          spl.mesh.scale.set(sc, sc, 1);
          spl.mesh.position.set(spl.x, -spl.z, 0);
          spl.mat.opacity = (1 - spl.ph) * (0.22 + 0.45 * rain);
        }
        if (snowPts.visible) {
          var actS = Math.floor(snowCount * Math.min(1, 0.4 + rain));
          snowGeo.setDrawRange(0, actS);
          for (var w = 0; w < actS; w++) {
            var ss = snowState[w];
            ss.y -= ss.v * dt;
            if (ss.y < 0.05) {
              ss.y = 4.6 + Math.random() * 2;
              ss.x = rL + Math.random() * bandW;
            }
            snowPos[w * 3] = ss.x + Math.sin(time * 1.4 + ss.ph) * 0.25;
            snowPos[w * 3 + 1] = ss.y;
            snowPos[w * 3 + 2] = ss.z;
          }
          snowGeo.attributes.position.needsUpdate = true;
        }

        /* 闪电 */
        if (type === 'cold' && cur.phase === 1 && rain > 0.55) {
          if (Math.random() < 0.012) flashLight.intensity = 5;
        }
        flashLight.intensity *= 0.86;
        flashLight.position.set(xf - 1, 5, 0);

        /* 观测站 */
        station.userData.flag.rotation.y = cur.phase === 0 ? -0.5 : cur.phase === 1 ? 0.5 : 0.15;
        station.userData.flag.rotation.z = Math.sin(time * 4) * 0.08;

        /* 标注 */
        var showLabels = !!st.show.labels;
        labels.cold.visible = showLabels;
        labels.warm.visible = showLabels;
        labels.front.visible = showLabels;
        labels.line.visible = showLabels;
        labels.rain.visible = showLabels && rain > 0.05;
        labels.station.visible = showLabels;
        labels.move.visible = showLabels;
        labels.slope.visible = showLabels;

        /* 冷/暖气团标签位置随类型互换：冷气团总在锋面后方（移动方向一侧） */
        var left = -L * 0.88, right = L * 0.88;
        var coldX = type === 'warm' ? Math.min(right, xf + 7.5) : Math.max(left, xf - 7.5);
        var warmX = type === 'warm' ? Math.max(left, xf - 7.5) : Math.min(right, xf + 7.5);
        labels.cold.position.set(coldX, 1.2, 0);
        labels.warm.position.set(warmX, 1.2, 0);
        labels.front.position.set(xf - (type === 'warm' ? 1.6 : 2.2), (type === 'warm' ? 3.4 : 4.6), 0);
        labels.line.position.set(xf, 0.5, Z * 0.72);
        labels.rain.position.set((rL + rR) / 2, 5.2, 0);
        labels.station.position.set(0, 2.9, 0);
        labels.slope.position.set(xf - (type === 'warm' ? 6 : 5), 0.5, Z * 0.86);
        labels.move.position.set(type === 'warm' ? xf + 4 : xf - 4, 0.9, -Z * 0.78);
        labels.move.material.opacity = 0.95;

        /* 移动方向箭头（地面，指向锋面推进方向） */
        moveArrow.position.set(type === 'warm' ? xf + 3.4 : xf - 4.2, 0.35, 0);
        moveArrow.rotation.y = type === 'warm' ? Math.PI : 0;
        moveArrow.visible = showLabels;
        moveArrow.children.forEach(function (c) { c.material.opacity = 0.8; });

        /* 网格开关 */
        grid.visible = !!st.show.grid;
        ground.visible = true;

        /* 云雨浓度联动：冷锋云雨在锋后（锋面左侧），暖锋在锋前（右侧） */

        orbit.update(dt);
        renderer.render(scene, camera);
      },
      orbit: orbit,
      dispose: function () {
        orbit.dispose();
        renderer.dispose();
      }
    };
    api.frameCount = 0;
    var _frame = api.frame;
    api.frame = function (st, dt) { api.frameCount++; _frame(st, dt); };
    global.__M1 = api;
    return api;
  }

  global.MODELS = global.MODELS || {};
  global.MODELS.M1 = function createM1(ctx) {
    return create(ctx.canvas);
  };
})(typeof window !== 'undefined' ? window : globalThis);
