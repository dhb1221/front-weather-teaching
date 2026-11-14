/* ============================================================
 * app.js — 主控：状态 / 视图切换 / 主循环 / 交互 / 知识库 / 练习 / 提示词 / 实况
 * 依赖：window.FRONT · H · MODELS(M1~M4) · KNOWLEDGE · Quiz · LIVE
 * state 是唯一数据源，2D 模型只读不写。
 * ============================================================ */
(function (global) {
  'use strict';

  var F = global.FRONT;
  var H = global.H;
  var doc = global.document;

  var state = {
    type: 'cold',
    t: 0.22,
    playing: false,
    speed: 1,
    model: 'M1',
    mapMode: 'cyclone',
    month: 6,
    show: { slope: true, air: true, clouds: true, rain: true, labels: true, grid: true },
    view: 'iso'
  };

  /* ---------------- DOM 引用 ---------------- */
  var $ = function (sel) { return doc.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); };

  var el = {
    main: $('#main'),
    stage: $('#stage'),
    viewArea: $('#viewArea'),
    gl: $('#gl'),
    c2d: $('#c2d'),
    loading: $('#loading'),
    fallback: $('#fallback'),
    phaseBadge: $('#phaseBadge'),
    toast: $('#toast'),
    tabs: $$('#tabs .tab'),
    typeBtns: $('#typeBtns'),
    viewPresets: $('#viewPresets'),
    mapBar: $('#mapBar'),
    monthWrap: $('#monthWrap'),
    monthSlider: $('#monthSlider'),
    monthLabel: $('#monthLabel'),
    tSlider: $('#tSlider'),
    btnPlay: $('#btnPlay'),
    btnReset: $('#btnReset'),
    speeds: $$('.speeds button'),
    toggles: $$('#toggles input'),
    legendList: $('#legendList'),
    mTemp: $('#mTemp'), mPress: $('#mPress'), mRain: $('#mRain'), mCloud: $('#mCloud'),
    mWeather: $('#mWeather'), mWind: $('#mWind'), mDesc: $('#mDesc'), mSlope: $('#mSlope'),
    phasePill: $('#phasePill'),
    knowledge: $('#knowledge'), knList: $('#knList'), knBody: $('#knBody'), knSearch: $('#knSearch'),
    live: $('#live'), cityInput: $('#cityInput'), cityPresets: $('#cityPresets'),
    searchResults: $('#searchResults'), liveNow: $('#liveNow'), liveJudge: $('#liveJudge'),
    liveTitle: $('#liveTitle'), liveSource: $('#liveSource'), liveTime: $('#liveTime'),
    liveChart: $('#liveChart'), liveChartNote: $('#liveChartNote'),
    modalQuiz: $('#modalQuiz'), quizBody: $('#quizBody'), quizProgress: $('#quizProgress'),
    quizScore: $('#quizScore'), quizNext: $('#quizNext'),
    modalPrompt: $('#modalPrompt'), promptBody: $('#promptBody'), promptHint: $('#promptHint'),
    btnPrompt: $('#btnPrompt'), btnQuiz: $('#btnQuiz')
  };

  /* ---------------- 画布 ---------------- */
  var c2d = el.c2d.getContext('2d');
  var W = 0, H2 = 0, DPR = Math.min(global.devicePixelRatio || 1, 2);
  var glReady = false, m1 = null, m2 = null, m3 = null, m4 = null;
  var frameError = 0, lastFrameErrorToast = 0;

  function sizeOf() {
    var r = el.viewArea.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
  }

  function resizeAll() {
    var s = sizeOf();
    W = s.w; H2 = s.h;
    DPR = Math.min(global.devicePixelRatio || 1, 2);
    el.c2d.width = Math.round(W * DPR);
    el.c2d.height = Math.round(H2 * DPR);
    el.c2d.style.width = W + 'px';
    el.c2d.style.height = H2 + 'px';
    el.gl.style.width = W + 'px';
    el.gl.style.height = H2 + 'px';
    if (m2) m2.resize(W, H2);
    if (m3) m3.resize(W, H2);
    if (m4) m4.resize(W, H2);
    if (m1 && glReady) {
      try { m1.resize(W, H2); } catch (e) { /* 忽略 */ }
    }
    if (state.model === 'M6') renderLiveChart();
  }

  /* ---------------- 3D 场景 ---------------- */
  function init3D() {
    if (m1 || !global.MODELS || !global.MODELS.M1) return;
    try {
      if (!global.THREE) throw new Error('no three');
      m1 = global.MODELS.M1({ canvas: el.gl, width: W, height: H2, state: state, FRONT: F, H: H });
      m1.resize(W, H2);
      m1.setView(state.view);
      glReady = true;
      el.loading.hidden = true;
      el.gl.addEventListener('webglcontextlost', function (ev) {
        ev.preventDefault();
        glReady = false;
        showFallback();
        toast('三维渲染不可用，已自动切换到剖面图解');
        setModel('M2', true);
      }, false);
    } catch (e) {
      glReady = false;
      el.loading.hidden = true;
      showFallback();
      setModel('M2', true);
    }
  }

  /* 三维不可用时的提示条：可点击关闭，几秒后自动隐藏 */
  var fallbackTimer = 0;
  function showFallback() {
    el.fallback.hidden = false;
    el.fallback.onclick = function () { el.fallback.hidden = true; };
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(function () { el.fallback.hidden = true; }, 7000);
  }

  function ensure2D(model) {
    var MODS = global.MODELS || {};
    var ctx = { canvas: el.c2d, width: W, height: H2, state: state, FRONT: F, H: H };
    if (model === 'M2' && !m2 && MODS.M2) m2 = MODS.M2(ctx);
    if (model === 'M3' && !m3 && MODS.M3) m3 = MODS.M3(ctx);
    if (model === 'M4' && !m4 && MODS.M4) m4 = MODS.M4(ctx);
  }

  /* ---------------- 视图切换 ---------------- */
  function setModel(model, silent) {
    if (!model) return;
    var prev = state.model;
    state.model = model;
    el.main.dataset.model = model;
    el.tabs.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-model') === model); });

    var is3D = model === 'M1';
    var is2D = model === 'M2' || model === 'M3' || model === 'M4';

    el.stage.hidden = !(is3D || is2D);
    $('#panel').hidden = !(is3D || is2D);
    el.knowledge.hidden = model !== 'M5';
    el.live.hidden = model !== 'M6';

    el.gl.style.display = is3D ? 'block' : 'none';
    el.c2d.style.display = is2D ? 'block' : 'none';
    el.viewPresets.hidden = !is3D;
    el.mapBar.hidden = model !== 'M3';

    if (is3D) init3D();
    if (is2D) { ensure2D(model); resizeAll(); }
    if (model === 'M5') renderKnowledge();
    if (model === 'M6') renderLiveShell();
    syncChrome();

    if (prev === 'M6' && model !== 'M6') { /* 保留已取数据 */ }
    if (!silent) syncURL();
  }

  /* 画布顶部的浮层：视角条 / 天气图条 / 阶段徽标，按视图显隐 */
  function syncChrome() {
    el.phaseBadge.hidden = state.model !== 'M1';
    el.mapBar.hidden = state.model !== 'M3';
    el.monthWrap.hidden = !(state.model === 'M3' && state.mapMode === 'rainbelt');
  }

  /* ---------------- 类型按钮 / 图例 ---------------- */
  function buildTypes() {
    el.typeBtns.innerHTML = '';
    F.types.forEach(function (type) {
      var meta = F.meta[type];
      var b = doc.createElement('button');
      b.className = 'type-btn' + (type === state.type ? ' on' : '');
      b.setAttribute('data-type', type);
      b.style.setProperty('--c', meta.color);
      b.innerHTML = '<span class="tname">' + meta.name + '</span>' +
        '<span class="tglyph">' + meta.glyph + '</span>' +
        '<span class="toneline">' + meta.oneLine + '</span>';
      b.addEventListener('click', function () { setType(type); });
      el.typeBtns.appendChild(b);
    });
  }

  function setType(type) {
    state.type = type;
    /* 教材要求：切换锋面类型时动画必须重置 */
    state.t = 0;
    state.view = 'iso';
    if (m1) { try { m1.setView('iso'); } catch (e) {} }
    syncViewButtons();
    if (m1 && glReady) { try { m1.setType && m1.setType(type); } catch (e) {} }
    state.playing = true;
    el.typeBtns.querySelectorAll('.type-btn').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-type') === type);
    });
    updatePlayBtn();
    toast('已切换到 ' + F.meta[type].name + '，动画重新开始');
    syncURL();
  }

  function buildLegend() {
    var rows = [
      ['冷气团', '#4ea1ff', '温度低、密度大，贴地楔入'],
      ['暖气团', '#ff8a3d', '温度高、密度小，被迫抬升'],
      ['锋面 / 锋线', '#ffffff', '冷暖气团的倾斜交界面'],
      ['云雨区', '#8fc8ff', '暖空气抬升凝结成云致雨'],
      ['观测站', '#b98cff', '固定在地面中央，见证过境']
    ];
    el.legendList.innerHTML = rows.map(function (r) {
      return '<li><i style="background:' + r[1] + '"></i><b>' + r[0] + '</b><span>' + r[2] + '</span></li>';
    }).join('');
  }

  function syncViewButtons() {
    el.viewPresets.querySelectorAll('[data-view]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === state.view);
    });
  }

  /* ---------------- 读数 ---------------- */
  function raindesc(r) {
    if (r > 0.72) return '强降水';
    if (r > 0.42) return '中等降水';
    if (r > 0.16) return '小降水';
    return '无降水';
  }

  function updateReadout() {
    var cur = F.curve(state.type, state.t);
    var meta = F.meta[state.type];
    el.mTemp.textContent = cur.temp.toFixed(1) + ' ℃';
    el.mPress.textContent = cur.press.toFixed(1) + ' hPa';
    el.mRain.textContent = raindesc(cur.rain);
    el.mCloud.textContent = Math.round(cur.cloud * 100) + '%';
    el.mWeather.textContent = cur.weather;
    el.mWind.textContent = cur.wind;
    el.mDesc.textContent = cur.desc;
    el.mSlope.textContent = '坡度：' + meta.slopeText;
    var ph = F.phaseName(state.t);
    el.phaseBadge.textContent = ph;
    el.phaseBadge.className = 'phase-badge ph' + F.phaseIndex(state.t);
    el.phasePill.textContent = ph;
  }

  /* ---------------- 时间轴 ---------------- */
  function syncSlider() {
    el.tSlider.value = String(Math.round(state.t * 1000));
  }
  function updatePlayBtn() {
    el.btnPlay.textContent = state.playing ? '❚❚' : '▶';
    el.btnPlay.classList.toggle('playing', state.playing);
  }

  var toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2200);
  }

  /* ---------------- 主循环 ---------------- */
  var lastT = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!lastT) lastT = now;
    var dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    if (state.playing) {
      state.t += dt * 0.13 * state.speed;
      if (state.t >= 1) { state.t = 1; state.playing = false; updatePlayBtn(); }
      syncSlider();
    }

    try {
      if (state.model === 'M1' && glReady && m1) {
        m1.frame(state, dt);
      } else if (state.model === 'M2' || state.model === 'M3' || state.model === 'M4') {
        var model = state.model === 'M2' ? m2 : state.model === 'M3' ? m3 : m4;
        if (model) {
          c2d.setTransform(DPR, 0, 0, DPR, 0, 0);
          c2d.clearRect(0, 0, W, H2);
          model.draw(c2d, W, H2, state, F);
        }
      }
    } catch (e) {
      frameError++;
      if (frameError < 4 && now - lastFrameErrorToast > 4000) {
        lastFrameErrorToast = now;
        toast('渲染出现异常：' + (e && e.message ? e.message : e));
        if (frameError >= 3) console.error(e);
      }
    }

    if (!readoutAt || now - readoutAt > 90) { readoutAt = now; updateReadout(); }
  }
  var readoutAt = 0;

  /* ---------------- URL 同步 ---------------- */
  function syncURL() {
    if (!global.history || !global.history.replaceState) return;
    var q = '?type=' + state.type + '&m=' + state.model + '&t=' + state.t.toFixed(2);
    if (state.model === 'M3') q += '&map=' + state.mapMode + '&month=' + state.month;
    if (state.model === 'M1') q += '&view=' + state.view;
    try { global.history.replaceState(null, '', q); } catch (e) { /* file:// 下可能失败 */ }
  }

  function readURL() {
    var q = {};
    (global.location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    if (F.types.indexOf(q.type) >= 0) state.type = q.type;
    if (q.t !== undefined && isFinite(parseFloat(q.t))) state.t = Math.max(0, Math.min(1, parseFloat(q.t)));
    if (q.m && /^M[1-6]$/.test(q.m)) state.model = q.m;
    if (q.map && ['cyclone', 'rainbelt', 'symbols'].indexOf(q.map) >= 0) state.mapMode = q.map;
    if (q.month) state.month = Math.max(4, Math.min(9, parseInt(q.month, 10) || 6));
    if (q.view && ['iso', 'profile', 'top', 'cold', 'warm'].indexOf(q.view) >= 0) state.view = q.view;
  }

  /* ---------------- 知识库 ---------------- */
  var knBuilt = false;
  function renderKnowledge() {
    if (knBuilt || !global.KNOWLEDGE) return;
    knBuilt = true;
    var K = global.KNOWLEDGE;
    el.knList.innerHTML = '';
    el.knBody.innerHTML = '';
    var glossHtml = '';
    if (K.glossary && K.glossary.length) {
      glossHtml = '<h4>术语速查表</h4><table class="kc-table"><tr><th>术语</th><th>释义</th></tr>' +
        K.glossary.map(function (it) { return '<tr><td><b>' + it.term + '</b></td><td>' + it.desc + '</td></tr>'; }).join('') +
        '</table>';
    }

    K.sections.forEach(function (sec, i) {
      var b = doc.createElement('button');
      b.className = 'kn-item';
      b.innerHTML = '<span class="kn-ico">' + (sec.icon || '·') + '</span><span>' + sec.title + '</span>';
      b.addEventListener('click', function () {
        var target = doc.getElementById('kn-' + sec.id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.knList.querySelectorAll('.kn-item').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
      el.knList.appendChild(b);

      var art = doc.createElement('article');
      art.className = 'kn-sec';
      art.id = 'kn-' + sec.id;
      art.innerHTML = '<h2>' + (sec.icon ? sec.icon + ' ' : '') + sec.title + '</h2>' + (sec.html || '') +
        (sec.id === 'glossary' ? glossHtml : '');
      el.knBody.appendChild(art);
      if (i === 0) b.classList.add('on');
    });

  }

  function filterKnowledge(kw) {
    kw = (kw || '').trim().toLowerCase();
    $$('.kn-sec').forEach(function (sec) {
      if (!kw) { sec.style.display = ''; return; }
      sec.style.display = sec.textContent.toLowerCase().indexOf(kw) >= 0 ? '' : 'none';
    });
  }

  /* ---------------- 练习 ---------------- */
  var quizState = { list: [], idx: 0, answered: 0, correct: 0 };

  function openQuiz() {
    if (!global.Quiz) { toast('题库未加载'); return; }
    quizState.list = global.Quiz.pick(state.type, 10);
    quizState.idx = 0;
    quizState.answered = 0;
    quizState.correct = 0;
    el.modalQuiz.hidden = false;
    renderQuiz();
  }

  function renderQuiz() {
    var Q = quizState.list[quizState.idx];
    if (!Q) { el.quizBody.innerHTML = '<p>题库为空</p>'; return; }
    el.quizProgress.textContent = (quizState.idx + 1) + ' / ' + quizState.list.length + ' · ' +
      ({ cold: '冷锋', warm: '暖锋', stationary: '准静止锋', general: '综合' }[Q.type] || '综合') +
      (Q.tag ? ' · ' + Q.tag : '');
    el.quizBody.innerHTML =
      '<p class="q-text">' + (quizState.idx + 1) + '. ' + Q.q + '</p>' +
      '<div class="q-options">' +
      Q.options.map(function (op, i) {
        return '<button class="q-opt" data-i="' + i + '"><b>' + 'ABCD'[i] + '</b><span>' + op + '</span></button>';
      }).join('') +
      '</div><div class="q-explain" hidden></div>';
    el.quizBody.querySelectorAll('.q-opt').forEach(function (b) {
      b.addEventListener('click', function () { answerQuiz(b, Q); });
    });
    el.quizScore.textContent = quizState.answered ? ('已答 ' + quizState.answered + ' · 正确 ' + quizState.correct) : '';
    el.quizNext.disabled = true;
  }

  function answerQuiz(btn, Q) {
    if (btn.classList.contains('ok') || btn.classList.contains('bad')) return;
    var i = parseInt(btn.getAttribute('data-i'), 10);
    var correct = i === Q.answer;
    quizState.answered++;
    if (correct) quizState.correct++;
    btn.classList.add(correct ? 'ok' : 'bad');
    el.quizBody.querySelectorAll('.q-opt').forEach(function (b) {
      var bi = parseInt(b.getAttribute('data-i'), 10);
      if (bi === Q.answer) b.classList.add('ok');
      b.disabled = true;
    });
    var ex = el.quizBody.querySelector('.q-explain');
    ex.hidden = false;
    ex.innerHTML = '<b>' + (correct ? '✔ 回答正确' : '✘ 正确答案是 ' + 'ABCD'[Q.answer]) + '</b>' +
      '<p>' + (Q.explain || '') + '</p>';
    el.quizScore.textContent = '已答 ' + quizState.answered + ' · 正确 ' + quizState.correct;
    el.quizNext.disabled = false;
  }

  /* ---------------- 提示词 ---------------- */
  function openPrompt() {
    var txt = global.PROMPT || '';
    el.promptBody.innerHTML = txt
      ? '<pre>' + txt.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>'
      : '<p class="dim">提示词全文在构建时注入；开发模式下请打开仓库中的 prompt.md。</p>';
    el.modalPrompt.hidden = false;
    el.promptHint.textContent = txt ? txt.length + ' 字' : '';
  }

  function copyPrompt() {
    var txt = global.PROMPT || '';
    if (!txt) return;
    if (global.navigator && global.navigator.clipboard) {
      global.navigator.clipboard.writeText(txt).then(function () { toast('已复制全文'); },
        function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    var ta = doc.createElement('textarea');
    ta.value = txt;
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand('copy'); toast('已复制全文'); } catch (e) { toast('复制失败，请手动选择'); }
    doc.body.removeChild(ta);
  }

  /* ---------------- 实况天气 ---------------- */
  var liveData = null, livePlace = null, liveBusy = false;

  function renderLiveShell() {
    buildPresets();
    if (!liveData && !liveBusy && global.LIVE && !(global.navigator && global.navigator.onLine === false)) {
      liveLoad(global.LIVE.PRESETS[0]);
      return;
    }
    if (!liveData && !liveBusy) {
      el.liveNow.innerHTML = '<p class="dim">输入城市名后点击「搜索」，或直接选择常用城市 →</p>';
      el.liveJudge.innerHTML = '<p class="dim">获取到实况后自动判读。</p>';
    }
    renderLiveChart();
  }

  function buildPresets() {
    if (el.cityPresets.children.length) return;
    (global.LIVE ? global.LIVE.PRESETS : []).forEach(function (c) {
      var b = doc.createElement('button');
      b.className = 'chip';
      b.textContent = c.name;
      b.addEventListener('click', function () { liveLoad(c); });
      el.cityPresets.appendChild(b);
    });
  }

  function liveStatus(html) {
    el.liveSource.textContent = '获取中…';
    el.liveNow.innerHTML = '<p class="dim">' + html + '</p>';
    el.liveJudge.innerHTML = '<p class="dim">正在判读…</p>';
  }

  function liveError(msg) {
    el.liveSource.textContent = '失败';
    el.liveNow.innerHTML = '<div class="live-err"><b>数据获取失败</b><p>' + msg +
      '</p><p class="dim">可能是网络不可用（离线环境）。可以：① 换一个常用城市重试；② 手动输入观测值做判读。</p>' +
      '<div class="manual">' +
      '<label>早间气温 <input id="manT0" type="number" step="0.1" placeholder="℃"></label>' +
      '<label>当前气温 <input id="manT1" type="number" step="0.1" placeholder="℃"></label>' +
      '<label>早间气压 <input id="manP0" type="number" step="0.1" placeholder="hPa"></label>' +
      '<label>当前气压 <input id="manP1" type="number" step="0.1" placeholder="hPa"></label>' +
      '<button id="manJudge" class="primary">判读</button></div></div>';
    var b = doc.getElementById('manJudge');
    if (b) b.addEventListener('click', manualJudge);
  }

  function manualJudge() {
    var t0 = parseFloat(doc.getElementById('manT0').value);
    var t1 = parseFloat(doc.getElementById('manT1').value);
    var p0 = parseFloat(doc.getElementById('manP0').value);
    var p1 = parseFloat(doc.getElementById('manP1').value);
    if (!isFinite(t0) || !isFinite(t1) || !isFinite(p0) || !isFinite(p1)) {
      toast('请填写完整的四个数值');
      return;
    }
    var data = {
      source: '手动输入',
      place: { name: '手动输入' },
      current: { temp: t1, press: p1, cloud: null, precip: null, windDir: '', windDeg: null, windSpeed: null },
      hourly: [],
      metrics: { dT: Math.round((t1 - t0) * 10) / 10, dP: Math.round((p1 - p0) * 10) / 10, hours: 6, text: '手动输入的两组观测值' },
      warnings: ['数据由用户手动输入，仅用于判读练习'],
      fetchedAt: new Date()
    };
    data.judge = global.LIVE.judge(data);
    liveData = data;
    renderLiveAll(data);
  }

  function liveLoad(place) {
    if (!global.LIVE) { toast('实况模块未加载'); return; }
    livePlace = place;
    liveBusy = true;
    el.searchResults.hidden = true;
    liveStatus('正在连接气象数据源（wttr.in / MET Norway）…');
    el.cityPresets.querySelectorAll('.chip').forEach(function (b) {
      b.classList.toggle('on', b.textContent === place.name);
    });
    global.LIVE.load(place).then(function (data) {
      liveBusy = false;
      liveData = data;
      renderLiveAll(data);
      toast('已获取 ' + place.name + ' 实况（' + data.source + '）');
    }).catch(function (e) {
      liveBusy = false;
      liveError(e && e.message ? e.message : '网络错误');
    });
  }

  function renderLiveAll(data) {
    el.liveTitle.innerHTML = '当前实况 · ' + (data.place && data.place.name ? data.place.name : '') +
      ' <span class="pill">' + data.source + '</span>';
    el.liveSource.textContent = data.source;
    var c = data.current || {};
    var t = data.today || {};
    var items = [
      ['气温', fmt(c.temp, '℃')],
      ['体感', fmt(c.feels, '℃')],
      ['气压', fmt(c.press, 'hPa')],
      ['海拔', data.place && data.place.elevation !== undefined && data.place.elevation !== null ? Math.round(data.place.elevation) + ' m' : fmt(c.elev, 'm')],
      ['湿度', fmt(c.humidity, '%')],
      ['风', (c.windDir || '—') + (c.windSpeed !== null && c.windSpeed !== undefined ? ' ' + c.windSpeed + ' km/h' : '')],
      ['阵风', fmt(c.windGust, ' km/h')],
      ['云量', fmt(c.cloud, '%')],
      ['能见度', fmt(c.visibility, ' km')],
      ['天气现象', c.desc || '—'],
      ['降水量', fmt(c.precip, ' mm')],
      ['露点', fmt(c.dew, '℃')],
      ['紫外线', fmt(c.uv, '')],
      ['今日高/低', fmt(t.max, '℃') + ' / ' + fmt(t.min, '℃')]
    ];
    el.liveNow.innerHTML = items.map(function (it) {
      return '<div class="lm"><span>' + it[0] + '</span><b>' + it[1] + '</b></div>';
    }).join('');
    var ft = data.fetchedAt ? new Date(data.fetchedAt) : new Date();
    el.liveTime.textContent = '数据获取时间：' + ft.toLocaleString('zh-CN', { hour12: false }) +
      (c.obsTime ? '（观测时间 ' + c.obsTime + '）' : '') +
      (data.warnings && data.warnings.length ? ' · ' + data.warnings.join('；') : '');

    var j = data.judge || global.LIVE.judge(data);
    var badge = { cold: '冷锋', warm: '暖锋', stationary: '准静止锋', none: '无明显锋面' }[j.type] || '无明显锋面';
    var conf = { high: '置信度 较高', medium: '置信度 中等', low: '置信度 较低' }[j.confidence] || '';
    var demo = global.LIVE.demoType(j);
    el.liveJudge.innerHTML =
      '<div class="verdict v-' + (j.type || 'none') + '"><b>' + badge + '</b><span>' + j.title + '</span>' +
      (conf ? '<em>' + conf + '</em>' : '') + '</div>' +
      '<ul class="reasons">' + j.reasons.map(function (r) { return '<li>' + r + '</li>'; }).join('') + '</ul>' +
      (demo ? '<button id="demoBtn" class="primary">用「' + F.meta[demo].name + '」回到课堂演示 →</button>' :
        '<p class="dim">当前实况与三种锋面典型特征都不吻合，可先在知识库复习判据，或查看今天的天气图。</p>');
    var db = doc.getElementById('demoBtn');
    if (db) db.addEventListener('click', function () {
      state.type = demo; state.t = 0; state.playing = true;
      syncSlider(); updatePlayBtn(); buildTypes(); setModel('M1');
      toast('已切换到' + F.meta[demo].name + '演示');
    });
    renderLiveChart();
  }

  function fmt(v, unit) {
    if (v === null || v === undefined || v === '' || !isFinite(v)) return '—';
    return v + (unit || '');
  }

  function renderLiveChart() {
    var cv = el.liveChart;
    if (!cv || !cv.clientWidth) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = cv.clientWidth, h = Math.max(140, Math.round(cv.clientWidth * 0.42));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(10,16,30,0.6)';
    g.fillRect(0, 0, w, h);

    if (!liveData || !liveData.hourly || !liveData.hourly.length) {
      g.fillStyle = 'rgba(219,230,255,0.45)';
      g.font = '12px "PingFang SC","Microsoft YaHei",sans-serif';
      g.textAlign = 'center';
      g.fillText('暂无曲线数据', w / 2, h / 2);
      return;
    }
    var hh = (liveData.hourly || []).filter(function (x) { return x.temp !== null; });
    if (!hh.length) return;
    var padL = 34, padR = 34, padT = 14, padB = 22;
    var temps = hh.map(function (x) { return x.temp; });
    var presses = hh.filter(function (x) { return x.press !== null; }).map(function (x) { return x.press; });
    var tMin = Math.min.apply(null, temps) - 1, tMax = Math.max.apply(null, temps) + 1;
    var pMin = presses.length ? Math.min.apply(null, presses) - 1 : 0;
    var pMax = presses.length ? Math.max.apply(null, presses) + 1 : 1;
    var n = hh.length;
    var X = function (i) { return padL + (w - padL - padR) * (n === 1 ? 0.5 : i / (n - 1)); };
    var YT = function (v) { return padT + (h - padT - padB) * (1 - (v - tMin) / (tMax - tMin || 1)); };
    var YP = function (v) { return padT + (h - padT - padB) * (1 - (v - pMin) / (pMax - pMin || 1)); };

    /* 降水柱 */
    var maxPrecip = Math.max.apply(null, hh.map(function (x) { return x.precip || 0; })) || 1;
    hh.forEach(function (x, i) {
      var pv = (x.precip || 0) / maxPrecip;
      if (pv > 0.02) {
        g.fillStyle = 'rgba(143,200,255,0.35)';
        var bh = pv * (h - padT - padB) * 0.35;
        g.fillRect(X(i) - 3, h - padB - bh, 6, bh);
      }
    });

    /* 网格 */
    g.strokeStyle = 'rgba(150,180,230,0.12)';
    g.lineWidth = 1;
    for (var gy = 0; gy <= 3; gy++) {
      var yy = padT + (h - padT - padB) * gy / 3;
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(w - padR, yy); g.stroke();
    }
    /* 气温曲线 */
    g.strokeStyle = '#ff8a3d';
    g.lineWidth = 2;
    g.beginPath();
    hh.forEach(function (x, i) { var px = X(i), py = YT(x.temp); if (i === 0) g.moveTo(px, py); else g.lineTo(px, py); });
    g.stroke();
    /* 气压曲线 */
    if (presses.length) {
      g.strokeStyle = '#4ea1ff';
      g.beginPath();
      var started = false;
      hh.forEach(function (x, i) {
        if (x.press === null) return;
        var px = X(i), py = YP(x.press);
        if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
      });
      g.stroke();
    }
    /* 当前时刻竖线 */
    var nowH = new Date().getHours();
    for (var i2 = 0; i2 < hh.length; i2++) {
      if (hh[i2].hour >= nowH) {
        g.strokeStyle = 'rgba(255,255,255,0.35)';
        g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(X(i2), padT); g.lineTo(X(i2), h - padB); g.stroke();
        g.setLineDash([]);
        break;
      }
    }
    /* 轴标注 */
    g.fillStyle = 'rgba(255,138,61,0.9)';
    g.font = '10px "PingFang SC","Microsoft YaHei",sans-serif';
    g.textAlign = 'left';
    g.fillText(tMax.toFixed(0) + '℃', 2, padT + 8);
    g.fillText(tMin.toFixed(0) + '℃', 2, h - padB);
    g.fillStyle = 'rgba(78,161,255,0.9)';
    g.textAlign = 'right';
    if (presses.length) {
      g.fillText(pMax.toFixed(0), w - 2, padT + 8);
      g.fillText(pMin.toFixed(0), w - 2, h - padB);
    }
    g.fillStyle = 'rgba(219,230,255,0.5)';
    g.textAlign = 'center';
    g.fillText('0时', X(0), h - 6);
    g.fillText('12时', X(Math.min(n - 1, Math.floor(n / 2))), h - 6);
    g.fillText('24时', X(n - 1), h - 6);
    el.liveChartNote.textContent = '橙线=气温（左轴 ℃） 蓝线=气压（右轴 hPa） 蓝柱=3 小时降水量；虚线=当前时刻';
  }

  function searchLive() {
    var q = (el.cityInput.value || '').trim();
    if (!q) { toast('请输入城市名'); return; }
    el.searchResults.hidden = false;
    el.searchResults.innerHTML = '<p class="dim">正在搜索「' + q + '」…</p>';
    global.LIVE.searchCity(q).then(function (list) {
      if (!list.length) { el.searchResults.innerHTML = '<p class="dim">没有找到「' + q + '」，试试只输入城市名。</p>'; return; }
      el.searchResults.innerHTML = list.map(function (c, i) {
        return '<button class="sr-item" data-i="' + i + '">' + c.name +
          '<small>' + [c.admin1, c.country].filter(Boolean).join(' · ') +
          ' · ' + c.lon.toFixed(2) + ', ' + c.lat.toFixed(2) + '</small></button>';
      }).join('');
      el.searchResults.querySelectorAll('.sr-item').forEach(function (b) {
        b.addEventListener('click', function () {
          var c = list[parseInt(b.getAttribute('data-i'), 10)];
          el.cityInput.value = c.name;
          liveLoad(c);
        });
      });
    }).catch(function (e) {
      el.searchResults.innerHTML = '<p class="dim">城市搜索失败：' + (e.message || e) + '（可试试常用城市）</p>';
    });
  }

  function locateLive() {
    if (!global.navigator || !global.navigator.geolocation) { toast('浏览器不支持定位，请手动搜索城市'); return; }
    toast('正在获取定位…');
    global.navigator.geolocation.getCurrentPosition(function (pos) {
      liveLoad({ name: '我的位置', lat: pos.coords.latitude, lon: pos.coords.longitude });
    }, function () {
      toast('定位被拒绝或不可用，请手动搜索城市');
    }, { timeout: 8000, maximumAge: 600000 });
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    el.tabs.forEach(function (b) {
      b.addEventListener('click', function () { setModel(b.getAttribute('data-model')); });
    });

    el.viewPresets.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.view = b.getAttribute('data-view');
        syncViewButtons();
        if (m1 && glReady) { try { m1.setView(state.view); } catch (e) {} }
        syncURL();
      });
    });

    el.mapBar.querySelectorAll('[data-map]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mapMode = b.getAttribute('data-map');
        el.mapBar.querySelectorAll('[data-map]').forEach(function (x) {
          x.classList.toggle('on', x === b);
        });
        syncChrome();
        syncURL();
      });
    });

    el.monthSlider.addEventListener('input', function () {
      state.month = parseInt(el.monthSlider.value, 10);
      el.monthLabel.textContent = state.month + ' 月';
    });

    el.tSlider.addEventListener('input', function () {
      state.t = parseInt(el.tSlider.value, 10) / 1000;
      state.playing = false;
      updatePlayBtn();
    });

    el.btnPlay.addEventListener('click', function () {
      if (state.t >= 1) state.t = 0;
      state.playing = !state.playing;
      updatePlayBtn();
    });

    el.btnReset.addEventListener('click', function () {
      state.t = 0;
      state.playing = false;
      syncSlider();
      updatePlayBtn();
      toast('已回到过境前');
    });

    el.speeds.forEach(function (b) {
      b.addEventListener('click', function () {
        state.speed = parseFloat(b.getAttribute('data-speed'));
        el.speeds.forEach(function (x) { x.classList.toggle('on', x === b); });
      });
    });

    el.toggles.forEach(function (cb) {
      cb.addEventListener('change', function () {
        state.show[cb.getAttribute('data-show')] = cb.checked;
      });
    });

    el.btnQuiz.addEventListener('click', openQuiz);
    $('#quizClose').addEventListener('click', function () { el.modalQuiz.hidden = true; });
    el.quizNext.addEventListener('click', function () {
      quizState.idx++;
      if (quizState.idx >= quizState.list.length) {
        el.quizBody.innerHTML = '<div class="quiz-done"><h4>本轮完成 🎉</h4><p>共 ' + quizState.answered +
          ' 题，答对 ' + quizState.correct + ' 题' +
          (quizState.answered ? '（正确率 ' + Math.round(quizState.correct / quizState.answered * 100) + '%）' : '') + '</p></div>';
        el.quizProgress.textContent = '完成';
        el.quizNext.disabled = true;
        return;
      }
      renderQuiz();
    });
    $('#quizRestart').addEventListener('click', openQuiz);

    el.btnPrompt.addEventListener('click', openPrompt);
    $('#promptClose').addEventListener('click', function () { el.modalPrompt.hidden = true; });
    $('#promptCopy').addEventListener('click', copyPrompt);

    el.knSearch.addEventListener('input', function () { filterKnowledge(el.knSearch.value); });

    $('#btnSearch').addEventListener('click', searchLive);
    el.cityInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchLive(); });
    $('#btnLocate').addEventListener('click', locateLive);
    $('#btnRefresh').addEventListener('click', function () {
      if (livePlace) liveLoad(livePlace); else toast('先搜索或选择城市');
    });

    doc.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) m.hidden = true;
      });
    });

    doc.addEventListener('keydown', function (e) {
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      var k = e.key;
      if (k === ' ') { e.preventDefault(); el.btnPlay.click(); }
      else if (k === 'ArrowLeft') { state.t = Math.max(0, state.t - 0.02); syncSlider(); }
      else if (k === 'ArrowRight') { state.t = Math.min(1, state.t + 0.02); syncSlider(); }
      else if (k === 'r' || k === 'R') el.btnReset.click();
      else if (k === '1') setType('cold');
      else if (k === '2') setType('warm');
      else if (k === '3') setType('stationary');
      else if (k === 'k' || k === 'K') openQuiz();
      else if (k === 'Escape') {
        el.modalQuiz.hidden = true; el.modalPrompt.hidden = true;
      }
    });

    if (global.ResizeObserver) {
      new global.ResizeObserver(function () { resizeAll(); }).observe(el.viewArea);
    }
    global.addEventListener('resize', resizeAll);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (!F) { doc.body.innerHTML = '<pre style="color:#f88;padding:20px">数据源 front-data.js 未加载</pre>'; return; }
    readURL();
    buildTypes();
    buildLegend();
    syncViewButtons();
    syncSlider();
    updatePlayBtn();
    bindEvents();
    setModel(state.model, true);
    resizeAll();
    init3D();
    updateReadout();
    requestAnimationFrame(loop);
  }

  global.APP = {
    state: state,
    setModel: setModel,
    setType: setType,
    toast: toast
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
