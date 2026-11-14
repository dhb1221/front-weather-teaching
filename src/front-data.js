/* ============================================================
 * front-data.js — 「锋与天气」统一数据源
 * 三种锋：cold 冷锋 / warm 暖锋 / stationary 准静止锋
 * 时间轴 p ∈ [0,1]：锋面从 x=-L 扫到 x=+L（准静止锋近似停留）
 * 观测站固定在 x=0。所有模型（3D/剖面/天气图/曲线/题库）都从这里取数，
 * 保证五个视图讲的是同一件事。
 * 坐标（3D）：x = 锋面移动方向（+x 指向暖气团一侧），y = 高度，z = 沿锋线方向
 * ============================================================ */
(function (global) {
  'use strict';

  var L = 18;                 // 锋面扫过的半程
  var PHASE_EDGE = [0.38, 0.62];  // [前|时|后] 分界

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smooth(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  /* 梯形包络：a 起、b 满、c 落、d 止，两端平滑 */
  function bump(p, a, b, c, d) {
    if (p <= a || p >= d) return 0;
    if (p < b) return smooth((p - a) / (b - a));
    if (p <= c) return 1;
    return 1 - smooth((p - c) / (d - c));
  }

  var types = ['cold', 'warm', 'stationary'];

  var meta = {
    cold: {
      id: 'cold', name: '冷锋', glyph: '▲',
      color: '#4ea1ff', warmColor: '#ff8a3d',
      oneLine: '冷气团主动向暖气团移动的锋',
      motion: '冷气团像楔子插入暖气团下方，暖空气被迫抬升',
      slope: 0.22,                       // 3D 里锋面坡度（视觉用 tan）
      slopeText: '锋面坡度较陡（约 1/50～1/100）',
      rainZone: 'behind',                // 降水在锋后（冷气团一侧）
      rainZoneText: '降水集中在锋线附近及锋后（冷气团一侧）',
      cloudText: '积雨云为主，云体高耸、水平范围窄',
      rainText: '阵性降水，强度大、历时短',
      symbolText: '三角形符号，尖端指向锋面移动方向',
      rainHalf: 2.6, rainOffset: -1.2,   // 雨带 [xFront+offset-half, xFront+offset+half]
      cloudHalf: 4.5, cloudOffset: -0.5,
      temp0: 25, temp1: 17, press0: 1002, press1: 1014,
      phases: [
        { name: '过境前', weather: '晴朗', wind: '偏南风',
          desc: '受暖气团控制：气温高、气压低、天气晴朗' },
        { name: '过境时', weather: '阴天，雷阵雨或雨雪', wind: '偏北风，风力大',
          desc: '锋面过境：大风、降温，出现强度大、历时短的阵性降水' },
        { name: '过境后', weather: '转晴', wind: '偏北风',
          desc: '受冷气团控制：气温下降、气压升高、天气转晴' }
      ],
      examples: ['北方夏季的暴雨', '冬季的寒潮', '春季的沙尘暴', '一场秋雨一场寒']
    },
    warm: {
      id: 'warm', name: '暖锋', glyph: '◗',
      color: '#ff7a6b', warmColor: '#ff8a3d',
      oneLine: '暖气团主动向冷气团移动的锋',
      motion: '暖气团沿锋面缓慢爬升到冷气团上方，形成层状云系',
      slope: 0.09,
      slopeText: '锋面坡度较小（约 1/100～1/300）',
      rainZone: 'ahead',                 // 降水在锋前（冷气团一侧）
      rainZoneText: '降水集中在锋前（冷气团一侧），雨带范围宽',
      cloudText: '层状云（雨层云、高层云、卷层云）为主，云层薄而广',
      rainText: '连续性降水，强度小、历时长',
      symbolText: '半圆符号，凸出方向指向锋面移动方向',
      rainHalf: 5.2, rainOffset: 5.4,
      cloudHalf: 8.5, cloudOffset: 6.5,
      temp0: 6, temp1: 15, press0: 1020, press1: 1008,
      phases: [
        { name: '过境前', weather: '晴朗', wind: '偏北风',
          desc: '受冷气团控制：气温低、气压高、天气晴朗' },
        { name: '过境时', weather: '连续性降水', wind: '偏南风，风力小',
          desc: '锋面过境：云层增厚、出现连续性降水，气温缓慢上升' },
        { name: '过境后', weather: '雨止转晴', wind: '偏南风',
          desc: '受暖气团控制：气温升高、气压降低、天气转晴' }
      ],
      examples: ['一场春雨一场暖', '江淮地区春季的连绵阴雨']
    },
    stationary: {
      id: 'stationary', name: '准静止锋', glyph: '⛆',
      color: '#b98cff', warmColor: '#ff8a3d',
      oneLine: '冷、暖气团势均力敌，锋面移动缓慢或在原地摆动的锋',
      motion: '冷、暖气团势力相当，锋面来回摆动，暖空气持续沿锋面爬升',
      slope: 0.12,
      slopeText: '锋面坡度较小，锋面位置几乎不动',
      rainZone: 'both',
      rainZoneText: '雨带在锋面附近长时间停留，降水范围宽',
      cloudText: '层状云为主，云层厚而持久',
      rainText: '连续性降水，强度小、历时极长（可达数天）',
      symbolText: '三角形与半圆交替，画在锋线两侧',
      rainHalf: 6.5, rainOffset: 0,
      cloudHalf: 9, cloudOffset: 0,
      temp0: 12, temp1: 12.5, press0: 1013, press1: 1011,
      phases: [
        { name: '过境前', weather: '多云转阴', wind: '偏南风',
          desc: '冷、暖气团势力相当，锋面在附近摆动，暖湿空气开始抬升' },
        { name: '过境时', weather: '阴雨连绵', wind: '风力较小',
          desc: '雨带长时间停留在本地，出现持续时间很长的连续性降水' },
        { name: '过境后', weather: '雨止转阴', wind: '风力较小',
          desc: '锋面移出或减弱后降水停歇；若冷空气增强可转为冷锋天气' }
      ],
      examples: ['江淮准静止锋 → 梅雨（6 月中旬～7 月上旬）',
                 '昆明准静止锋 → 贵阳冬半年阴雨、昆明晴暖',
                 '华南准静止锋 → 华南春季连阴雨']
    }
  };

  /* ---------- 时间轴 ---------- */
  function phaseIndex(p) {
    if (p < PHASE_EDGE[0]) return 0;
    if (p <= PHASE_EDGE[1]) return 1;
    return 2;
  }
  function phaseName(p) { return meta.cold.phases[phaseIndex(p)].name; }

  /* 锋线位置（秒面与地面的交线） */
  function xFront(type, p) {
    p = clamp01(p);
    if (type === 'stationary') {
      /* 准静止锋：在观测站附近缓慢来回摆动 */
      return -1.5 + 2.6 * Math.sin((p - 0.1) * Math.PI * 2.2);
    }
    return lerp(-L, L, p);
  }

  /* 降水带 / 云带 的水平范围 [x0, x1]（3D 与剖面共用） */
  function span(type, p, which) {
    var m = meta[type];
    var xf = xFront(type, p);
    var half = which === 'cloud' ? m.cloudHalf : m.rainHalf;
    var off = which === 'cloud' ? m.cloudOffset : m.rainOffset;
    var c = xf + off;
    return { x0: c - half, x1: c + half };
  }

  /* ---------- 要素曲线：温度 / 气压 / 降水强度(0-1) / 云量(0-1) ---------- */
  function curve(type, p) {
    p = clamp01(p);
    var m = meta[type];
    var t, pr, rain, cloud;

    if (type === 'cold') {
      var k = smooth((p - 0.30) / 0.30);          // 过境时骤变
      t = lerp(m.temp0, m.temp1, k);
      pr = lerp(m.press0, m.press1, k);
      rain = bump(p, 0.30, 0.40, 0.54, 0.70);
      cloud = bump(p, 0.16, 0.30, 0.60, 0.82);
    } else if (type === 'warm') {
      var k2 = smooth((p - 0.28) / 0.34);
      t = lerp(m.temp0, m.temp1, k2);
      pr = lerp(m.press0, m.press1, k2);
      rain = bump(p, 0.14, 0.34, 0.56, 0.80) * 0.85;
      cloud = bump(p, 0.02, 0.18, 0.66, 0.92);
    } else {
      /* 准静止锋：温度气压变化小，长时间阴雨 */
      var w = Math.sin(p * Math.PI * 2.1);
      t = m.temp0 + 0.9 * w;
      pr = m.press0 + 1.4 * Math.sin(p * Math.PI * 2.1 + 0.7);
      rain = bump(p, 0.10, 0.26, 0.86, 0.99) * 0.62;
      cloud = bump(p, 0.02, 0.16, 0.92, 1.0) * 0.95;
    }
    var ph = phaseIndex(p);
    return {
      temp: t, press: pr, rain: rain, cloud: cloud,
      phase: ph,
      weather: m.phases[ph].weather,
      wind: m.phases[ph].wind,
      desc: m.phases[ph].desc
    };
  }

  global.FRONT = {
    L: L,
    PHASE_EDGE: PHASE_EDGE,
    types: types,
    meta: meta,
    phaseIndex: phaseIndex,
    phaseName: phaseName,
    xFront: xFront,
    span: span,
    curve: curve,
    clamp01: clamp01,
    smooth: smooth,
    lerp: lerp,
    bump: bump
  };
})(typeof window !== 'undefined' ? window : globalThis);
