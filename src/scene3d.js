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
    var n = kind === 'cumulo' ? 16 : 34;
    for (var i = 0; i < n; i++) {
      var mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
        opacity: kind === 'cumulo' ? 0.5 : 0.34
      });
      var sp = new THREE.Sprite(mat);
      if (kind === 'cumulo') {
        var u = i / (n - 1);
        var ang = Math.random() * Math.PI * 2;
        var r = 1.9 * (1 - u * 0.55);
        sp.position.set(
          Math.cos(ang) * r * 0.7,
          2.4 + u * 4.6 + Math.random() * 0.6,
          Math.sin(ang) * r
        );
        var s = 2.2 + (1 - u) * 2.6 + Math.random();
        sp.scale.set(s, s * 0.85, 1);
        sp.userData.puff = { u: u, ox: sp.position.x, oy: sp.position.y, oz: sp.position.z, s: s };
      } else {
        var row = i % 2;
        sp.position.set(
          0.6 + Math.random() * 9.5,
          3.1 + row * 0.9 + Math.random() * 0.5,
          -Z + 0.5 + Math.random() * (2 * Z - 1)
        );
        var sw = 3.2 + Math.random() * 2.6;
        sp.scale.set(sw, sw * 0.42, 1);
        sp.userData.baseY = sp.position.y;
        sp.userData.baseX = sp.position.x;
        sp.userData.ph = Math.random() * 6.28;
      }
      g.add(sp);
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

    var rainTex = global.H.makeSoftTexture('rain');
    var rainCount = 900;
    var rainPos = new Float32Array(rainCount * 3);
    var rainState = [];
    for (var r = 0; r < rainCount; r++) {
      rainState.push({ x: 0, y: Math.random() * 6, z: -Z + Math.random() * 2 * Z, v: 12 + Math.random() * 8 });
      rainPos[r * 3] = 0; rainPos[r * 3 + 1] = rainState[r].y; rainPos[r * 3 + 2] = rainState[r].z;
    }
    var rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    var rainMat = new THREE.PointsMaterial({
      map: rainTex, color: 0xa8d4ff, size: 0.5, transparent: true, opacity: 0.8,
      depthWrite: false, sizeAttenuation: true
    });
    var rainPts = new THREE.Points(rainGeo, rainMat);
    rainPts.visible = false;
    scene.add(rainPts);

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
    snowPts.visible = false;
    scene.add(snowPts);

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
      labels.front.text = '';
      labels.slope.text = meta.slopeText;
      labels.cold.text = type === 'warm' ? '冷气团' : '冷气团';
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
        clouds.cumulo.visible = !!st.show.clouds && cumOn && cloudSum > 0.05;
        clouds.layer.visible = !!st.show.clouds && (!cumOn || cloudSum > 0.05);
        clouds.cumulo.position.x = xf - 1.4;
        clouds.layer.position.x = xf + 1.5;
        clouds.cumulo.children.forEach(function (sp) {
          var u = sp.userData.puff.u;
          var grow = 0.55 + 0.45 * cloudSum;
          sp.scale.set(sp.userData.puff.s * grow, sp.userData.puff.s * grow * 0.9, 1);
          sp.material.opacity = 0.18 + 0.5 * cloudSum;
          sp.position.y = 2.4 + u * 4.6 * (0.65 + 0.35 * cloudSum);
        });
        clouds.layer.children.forEach(function (sp) {
          sp.material.opacity = 0.1 + 0.32 * cloudSum;
          sp.position.y = sp.userData.baseY + Math.sin(time * 0.6 + sp.userData.ph) * 0.12;
        });

        /* 雨/雪 */
        var rain = cur.rain;
        var isSnow = cur.temp < 1.5;
        rainPts.visible = !!st.show.rain && rain > 0.02 && !isSnow;
        snowPts.visible = !!st.show.rain && rain > 0.02 && isSnow;
        rainMat.opacity = Math.min(0.9, 0.25 + rain * 0.75);
        if (rainPts.visible) {
          var rLeft = xf + meta.rainOffset - meta.rainHalf;
          var rRight = xf + meta.rainOffset + meta.rainHalf;
          var active = Math.floor(rainCount * Math.min(1, 0.25 + rain));
          rainGeo.setDrawRange(0, active);
          for (var q = 0; q < active; q++) {
            var rs = rainState[q];
            rs.y -= rs.v * dt;
            if (rs.y < 0.05) {
              rs.y = 4.6 + Math.random() * 2.4;
              rs.x = rLeft + Math.random() * Math.max(0.2, rRight - rLeft);
            }
            rainPos[q * 3] = rs.x - 0.12;
            rainPos[q * 3 + 1] = rs.y;
            rainPos[q * 3 + 2] = rs.z;
          }
          rainGeo.attributes.position.needsUpdate = true;
        }
        if (snowPts.visible) {
          var sLeft = xf + meta.rainOffset - meta.rainHalf;
          var sRight = xf + meta.rainOffset + meta.rainHalf;
          var actS = Math.floor(snowCount * Math.min(1, 0.4 + rain));
          snowGeo.setDrawRange(0, actS);
          for (var w = 0; w < actS; w++) {
            var ss = snowState[w];
            ss.y -= ss.v * dt;
            if (ss.y < 0.05) {
              ss.y = 4.6 + Math.random() * 2;
              ss.x = sLeft + Math.random() * Math.max(0.2, sRight - sLeft);
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

        /* 冷气团在移动方向后方 */
        var behindX = type === 'warm' ? -L * 0.55 : xf - 7;
        var aheadX = type === 'warm' ? xf + 6 : L * 0.55;
        if (type === 'warm') { behindX = xf + 7; aheadX = -L * 0.5; }
        labels.cold.position.set(behindX, 1.1, 0);
        labels.warm.position.set(type === 'warm' ? -6 : Math.min(L * 0.72, xf + 6.5), type === 'warm' ? 2.4 : 1.0, 0);
        labels.cold.text = '';
        labels.cold.material.map = null;
        /* 文字精灵内容固定，冷/暖标签位置随类型互换 */
        var coldLabelText = type === 'warm' ? '冷气团' : '冷气团';
        labels.cold.position.set(type === 'warm' ? xf + 7 : xf - 7, 1.1, 0);
        labels.warm.position.set(type === 'warm' ? -7 : xf + 7, type === 'warm' ? 1.1 : 1.1, 0);
        labels.front.position.set(xf - (type === 'warm' ? 1.6 : 2.2), (type === 'warm' ? 3.4 : 4.6), 0);
        labels.line.position.set(xf, 0.5, Z * 0.72);
        labels.rain.position.set(xf + meta.rainOffset, 5.4, 0);
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
    return api;
  }

  global.MODELS = global.MODELS || {};
  global.MODELS.M1 = function createM1(ctx) {
    return create(ctx.canvas);
  };
})(typeof window !== 'undefined' ? window : globalThis);
