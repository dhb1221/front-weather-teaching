/* ============================================================
 * live.js — M6「实况天气」数据层：联网取数 + 锋面判读
 *
 * 数据链（两个实况来源并行请求，先成功者胜；都失败才明确报错，全程不伪造数据）：
 *   1) 地理编码：https://geocoding-api.open-meteo.com/v1/search
 *        中文城市名 → 经纬度/海拔（本地 GEO_CITIES 优先，命中即离线返回）
 *   2) 实况来源（并行竞速，先返回且解析成功者胜，页面标注本次实际来源）：
 *      A. https://api.open-meteo.com/v1/forecast
 *         Open-Meteo Forecast API（免密钥、全球、CORS）：
 *         current + daily（今日高/低、UV、降水合计）+ hourly（过去 24h + 未来 12h）；
 *         timezone=auto：返回的是**站点当地时区**的时间字符串，utc_offset_seconds 给出偏移
 *      B. https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=&lon=
 *         MET Norway（免密钥、CORS=*）：温度℃ / 海平面气压 hPa / 风速 m/s / 云量 % /
 *         1h 降水 mm / 天气符号 / meta.updated_at。浏览器里禁止自定义 User-Agent，直接 fetch。
 *   3) 两个来源都失败 → reject(new Error(明确原因))，由 app.js 显示离线教学示例，
 *      并允许手动输入观测值；绝不编造数值。
 *
 * 数据性质（重要，页面会原样展示）：
 *   Open-Meteo 与 MET Norway 都是**数值模式**数据（模式网格插值/预报），不是气象站实测。
 *   因此 metrics.forecastBased = true，warnings 里明确写“非气象站实测/数值模式”。
 *
 * 气压口径：统一用**海平面气压** pressure_msl（与教材等压线图、气象台发布值一致；
 *   MET Norway 的 air_pressure_at_sea_level 也是海平面气压）。模式地面气压另存
 *   current.pressSurface / hourly[].pressSurface，只作参考，不参与 ΔP 判读。
 *
 * ΔT/ΔP 说明：教材判据用“24 小时气温/气压变化”，但公开免费源拿不到昨日同刻实测；
 *   这里用「今日 0:00（或最早可用点）的逐时模式值 → 当前」近似，并注明真实小时数
 *   （metrics.hours），metrics.text 写明“今日已过约 N 小时（非 24h 实测）”，不冒充 24h。
 *   备源 MET Norway 不含过去逐时数据，只能用“未来约 9 小时预报变化”代替，并明确标注。
 *
 * 自动刷新：window.LIVE.REFRESH_MS = 300000（5 分钟），由 app.js 定时重新调用 load()。
 *
 * API：window.LIVE = {
 *   PRESETS, TIMEOUT, REFRESH_MS, weatherText(code), searchCity(q),
 *   nearestCity(lat,lon), load(place), judge(data), demoType(judgeResult), degToDir(deg)
 * }
 * ============================================================ */
(function (global) {
  'use strict';

  var TIMEOUT = 8000;          /* 请求超时：8 秒（prompt.md 要求） */
  var REFRESH_MS = 300000;     /* 自动刷新间隔：5 分钟 */

  var PRESETS = [
    { name: '贵阳', prov: '贵州', provFull: '贵州省', lon: 106.63, lat: 26.65, elevation: 1100 },
    { name: '北京', prov: '北京', provFull: '北京市', lon: 116.41, lat: 39.90, elevation: 44 },
    { name: '上海', prov: '上海', provFull: '上海市', lon: 121.47, lat: 31.23, elevation: 4 },
    { name: '广州', prov: '广东', provFull: '广东省', lon: 113.26, lat: 23.13, elevation: 21 },
    { name: '武汉', prov: '湖北', provFull: '湖北省', lon: 114.31, lat: 30.59, elevation: 37 },
    { name: '昆明', prov: '云南', provFull: '云南省', lon: 102.71, lat: 25.04, elevation: 1892 },
    { name: '哈尔滨', prov: '黑龙江', provFull: '黑龙江省', lon: 126.53, lat: 45.80, elevation: 142 }
  ];

  /* ---------------- 0. 请求与数值小工具 ---------------- */
  function fetchJSON(url, timeout) {
    var ms = timeout || TIMEOUT;
    return new Promise(function (resolve, reject) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        reject(new Error('timeout'));
      }, ms);
      fetch(url, ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' })
        .then(function (r) {
          return r.text().then(function (txt) {
            if (!r.ok) {
              var reason = '';
              try {
                var e = JSON.parse(txt);
                reason = e.reason || e.error || e.message || '';
              } catch (e2) {}
              throw new Error('HTTP ' + r.status + (reason ? ' ' + reason : ''));
            }
            return txt;
          });
        })
        .then(function (txt) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          var d;
          try { d = JSON.parse(txt); } catch (e) { reject(new Error('返回数据不是合法 JSON')); return; }
          resolve(d);
        })
        .catch(function (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  function n(v, d) {
    var x = parseFloat(v);
    return isFinite(x) ? x : (d === undefined ? null : d);
  }

  function round1(v) {
    var x = parseFloat(v);
    return isFinite(x) ? Math.round(x * 10) / 10 : null;
  }

  function two(v) {
    v = parseInt(v, 10);
    return (v < 10 ? '0' : '') + v;
  }

  /* 本地时区 ISO 字符串 "2026-11-20T23:30" → "11-20 23:30"（不做时区换算） */
  function fmtIsoLocal(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return String(s || '');
    return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  }

  /* 本地时区 ISO 字符串 → 毫秒（按 UTC 计算差值，避免浏览器时区影响） */
  function isoMs(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  }

  /* UTC ISO（MET Norway 用）→ 指定经度估算的当地 "MM-DD HH:MM" */
  function fmtTsPlace(iso, offHours) {
    var ms = Date.parse(iso);
    if (isNaN(ms)) return String(iso || '');
    var d = new Date(ms + (offHours || 0) * 3600000);
    return two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate()) + ' ' +
      two(d.getUTCHours()) + ':' + two(d.getUTCMinutes());
  }

  function errText(e) {
    var m = (e && e.message) ? e.message : String(e);
    if (m === 'timeout') return '请求超时（8 秒）';
    return m;
  }

  /* ---------------- WMO 天气码 → 中文天气现象 ---------------- */
  /* Open-Meteo weather_code 采用 WMO 4677 天气码 */
  var WMO_ZH = {
    0: '晴',
    1: '晴间多云',
    2: '多云',
    3: '阴',
    45: '雾',
    48: '雾凇（冻雾）',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '大毛毛雨',
    56: '冻毛毛雨',
    57: '强冻毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    66: '冻雨',
    67: '强冻雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    77: '雪粒',
    80: '小阵雨',
    81: '阵雨',
    82: '强阵雨',
    85: '小阵雪',
    86: '强阵雪',
    95: '雷暴',
    96: '雷暴伴小冰雹',
    99: '雷暴伴大冰雹'
  };

  function weatherText(code) {
    var c = parseInt(code, 10);
    if (!isFinite(c)) return '';
    if (WMO_ZH[c] !== undefined) return WMO_ZH[c];
    /* 未列出的码按区段兜底，保证不返回空串 */
    if (c >= 1 && c <= 3) return '多云';
    if (c >= 45 && c <= 48) return '雾';
    if (c >= 51 && c <= 57) return '毛毛雨';
    if (c >= 61 && c <= 67) return '雨';
    if (c >= 71 && c <= 77) return '雪';
    if (c >= 80 && c <= 82) return '阵雨';
    if (c >= 85 && c <= 86) return '阵雪';
    if (c >= 95) return '雷暴';
    return '';
  }

  /* MET Norway symbol_code → 中文（如 "clearsky_day" / "partlycloudy_night" / "heavyrain"） */
  function metSymbolText(sym) {
    if (!sym) return '';
    var s = String(sym).toLowerCase();
    if (s.indexOf('clearsky') === 0) return '晴';
    if (s.indexOf('fair') === 0) return '晴间多云';
    if (s.indexOf('partlycloudy') === 0) return '多云';
    if (s.indexOf('cloudy') === 0) return '阴';
    if (s.indexOf('fog') >= 0) return '雾';
    if (s.indexOf('thunderstorm') >= 0) return '雷暴';
    if (s.indexOf('heavyrain') >= 0) return '大雨';
    if (s.indexOf('lightrain') >= 0) return '小雨';
    if (s.indexOf('rainshowers') >= 0) return '阵雨';
    if (s.indexOf('rain') >= 0) return '雨';
    if (s.indexOf('heavysleet') >= 0) return '雨夹雪';
    if (s.indexOf('lightsleet') >= 0) return '小范围雨夹雪';
    if (s.indexOf('sleet') >= 0) return '雨夹雪';
    if (s.indexOf('heavysnow') >= 0) return '大雪';
    if (s.indexOf('lightsnow') >= 0) return '小雪';
    if (s.indexOf('snowshowers') >= 0) return '阵雪';
    if (s.indexOf('snow') >= 0) return '雪';
    return '';
  }

  /* ---------------- 数据源 URL ---------------- */
  var OPEN_CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,' +
    'surface_pressure,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,' +
    'precipitation,rain,showers,snowfall,weather_code,cloud_cover,visibility,dew_point_2m';
  var OPEN_DAILY = 'temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_sum';
  var OPEN_HOURLY = 'temperature_2m,surface_pressure,pressure_msl,precipitation,' +
    'cloud_cover,weather_code,wind_speed_10m,uv_index';

  function openMeteoUrl(lat, lon) {
    return 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + lat.toFixed(3) + '&longitude=' + lon.toFixed(3) +
      '&current=' + OPEN_CURRENT +
      '&daily=' + OPEN_DAILY +
      '&hourly=' + OPEN_HOURLY +
      /* forecast_hours=13：Open-Meteo 把“当前这一小时”也计入，13 个才覆盖未来 12 小时 */
      '&past_hours=24&forecast_hours=13&timezone=auto';
  }

  function metNorwayUrl(lat, lon) {
    return 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' +
      lat.toFixed(3) + '&lon=' + lon.toFixed(3);
  }

  /* ---------------- 1. 城市搜索 ---------------- */
  /* 先查本地中国城市索引（准确、可离线），再退回在线地理编码并按人口/行政级别排序 */
  function norm(s) {
    return String(s || '').replace(/[\s　]/g, '')
      .replace(/(特别行政区|自治区|自治州|地区|林区|省|市|盟|县|区)$/g, '');
  }

  /* 省级行政区 → 省会/首府（直辖市、港澳、台湾各自对应），用于“直接搜省名”的场景 */
  var PROV_CAP = {
    '北京': '北京', '天津': '天津', '上海': '上海', '重庆': '重庆',
    '河北': '石家庄', '山西': '太原', '内蒙古': '呼和浩特', '辽宁': '沈阳', '吉林': '长春',
    '黑龙江': '哈尔滨', '江苏': '南京', '浙江': '杭州', '安徽': '合肥', '福建': '福州',
    '江西': '南昌', '山东': '济南', '河南': '郑州', '湖北': '武汉', '湖南': '长沙',
    '广东': '广州', '广西': '南宁', '海南': '海口', '四川': '成都', '贵州': '贵阳',
    '云南': '昆明', '西藏': '拉萨', '陕西': '西安', '甘肃': '兰州', '青海': '西宁',
    '宁夏': '银川', '新疆': '乌鲁木齐', '台湾': '台北', '香港': '香港', '澳门': '澳门'
  };

  /* 查询是省名/简称时，返回省会城市（并注明省份），避免在线接口把省名当普通村庄 */
  function provinceHit(q) {
    var nq = norm(q);
    if (!nq || !global.GEO_CITIES) return [];
    var cap = null, provName = null;
    for (var key in PROV_CAP) {
      if (PROV_CAP.hasOwnProperty(key) && (nq === key || nq === key + '省' || nq === key + '市')) {
        cap = PROV_CAP[key];
        provName = key;
        break;
      }
    }
    /* 自治区全称（如“广西壮族自治区”“新疆维吾尔自治区”）也能识别 */
    if (!cap) {
      var FULL = ['广西壮族自治区', '宁夏回族自治区', '新疆维吾尔自治区', '西藏自治区',
        '内蒙古自治区', '香港特别行政区', '澳门特别行政区'];
      for (var i = 0; i < FULL.length; i++) {
        if (q.indexOf(FULL[i]) === 0 || norm(q) === norm(FULL[i])) {
          var short = FULL[i].replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)/g, '');
          if (PROV_CAP[short]) { cap = PROV_CAP[short]; provName = short; }
          break;
        }
      }
    }
    if (!cap) return [];
    var list = global.GEO_CITIES;
    for (var j = 0; j < list.length; j++) {
      if (list[j].s === cap) {
        return [{
          name: list[j].s, prov: list[j].ps, provFull: list[j].p,
          country: '中国', lon: list[j].lon, lat: list[j].lat,
          local: true, viaProvince: provName
        }];
      }
    }
    return [];
  }

  function localSearch(q) {
    var list = global.GEO_CITIES;
    if (!list || !list.length) return [];
    var nq = norm(q);
    if (!nq) return [];
    var hits = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var n = norm(c.n), ns = c.s;
      var score = 0;
      if (n === nq || ns === nq) score = 100;
      else if (n.indexOf(nq) === 0 || ns.indexOf(nq) === 0) score = 80 - Math.min(20, n.length - nq.length);
      else if (nq.length >= 2 && (n.indexOf(nq) > 0 || ns.indexOf(nq) > 0)) score = 50 - Math.min(15, n.length - nq.length);
      if (!score) continue;
      score += c.cap ? 6 : 0;
      hits.push({ score: score, c: c });
    }
    hits.sort(function (a, b) { return b.score - a.score || a.c.length - b.c.length; });
    return hits.slice(0, 8).map(function (h) {
      var c = h.c;
      return {
        name: c.s,
        prov: c.ps,
        provFull: c.p,
        country: '中国',
        lon: c.lon,
        lat: c.lat,
        local: true
      };
    });
  }

  var FEATURE_RANK = { PPLC: 0, PPLA: 1, PPLA2: 2, PPLA3: 3, PPLA4: 4, PPL: 5 };

  function searchCity(q) {
    q = String(q || '').trim();
    if (!q) return Promise.resolve([]);
    var local = localSearch(q);
    if (local.length) return Promise.resolve(local);
    var prov = provinceHit(q);
    if (prov.length) return Promise.resolve(prov);
    var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(q) + '&count=20&language=zh&format=json';
    return fetchJSON(url).then(function (d) {
      var rows = (d.results || []).map(function (r) {
        return {
          name: r.name,
          admin1: r.admin1 || '',
          prov: r.admin1 || '',
          country: r.country || '',
          lon: r.longitude,
          lat: r.latitude,
          elevation: r.elevation,
          rank: FEATURE_RANK[r.feature_code] === undefined ? (r.feature_code && r.feature_code.indexOf('PPL') === 0 ? 5 : 9) : FEATURE_RANK[r.feature_code],
          pop: r.population || 0
        };
      });
      rows.sort(function (a, b) { return a.rank - b.rank || b.pop - a.pop; });
      // 同名但省份/国家不同的结果去重
      var seen = {}, out = [];
      rows.forEach(function (r) {
        var k = r.name + '|' + (r.prov || r.country || '');
        if (seen[k]) return;
        seen[k] = 1;
        out.push(r);
      });
      return out.slice(0, 8);
    });
  }

  /* 按坐标找最近的本土城市（定位时用于显示“省 · 市”） */
  function nearestCity(lat, lon) {
    var list = global.GEO_CITIES;
    if (!list || !list.length || !isFinite(lat) || !isFinite(lon)) return null;
    var k = Math.cos(lat * Math.PI / 180);
    var best = null, bd = 1e9;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var dx = (c.lon - lon) * k, dy = c.lat - lat;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return null;
    // 超过约 80km 就不硬套城市名
    if (Math.sqrt(bd) * 111 > 80) return null;
    return { name: best.s, prov: best.ps, provFull: best.p, lon: best.lon, lat: best.lat, local: true, near: true };
  }

  /* ---------------- 2. Open-Meteo 主源解析 ---------------- */
  /* 用“今日 0:00（或最早可用点）→ 当前”的模式逐时值近似 ΔT/ΔP，注真实小时数 */
  function trendToday(hourly, current, baseIdx, curTime) {
    var out = {
      dT: null, dP: null, hours: null, fromHour: null, fromTime: null,
      forecastBased: true,
      text: '暂无趋势数据'
    };
    if (baseIdx < 0 || !hourly[baseIdx] || current.temp === null) return out;
    var base = hourly[baseIdx];
    var hours = null;
    var a = isoMs(base.time);
    var b = isoMs(curTime);
    if (isFinite(a) && isFinite(b) && b >= a) hours = Math.round((b - a) / 36000) / 100; /* 毫秒→小时，保留 2 位再取 1 位 */
    if (hours === null || !isFinite(hours)) hours = 0;
    hours = Math.round(hours * 10) / 10;
    out.dT = (current.temp !== null && base.temp !== null) ? round1(current.temp - base.temp) : null;
    out.dP = (current.press !== null && base.press !== null) ? round1(current.press - base.press) : null;
    out.hours = hours;
    out.fromHour = base.hour;
    out.fromTime = base.time;
    var todayStr = String(curTime || '').slice(0, 10);
    if (base.date === todayStr) {
      out.text = '今日已过约 ' + hours + ' 小时（非 24h 实测）';
    } else {
      out.text = '较 ' + fmtIsoLocal(base.time) + '（约 ' + hours + ' 小时前，非 24h 实测）';
    }
    return out;
  }

  function parseOpenMeteo(d, place) {
    if (!d || !d.current || typeof d.current !== 'object') {
      throw new Error('返回数据缺少 current 字段');
    }
    var cur = d.current;
    var hly = d.hourly || {};
    var hTime = hly.time || [];
    var hTemp = hly.temperature_2m || [];
    var hPress = hly.pressure_msl || [];
    var hSurf = hly.surface_pressure || [];
    var hPrecip = hly.precipitation || [];
    var hCloud = hly.cloud_cover || [];
    var hCode = hly.weather_code || [];
    var hWind = hly.wind_speed_10m || [];
    var hUv = hly.uv_index || [];

    var curTime = String(cur.time || '');
    var todayStr = curTime.slice(0, 10);
    var curHourKey = curTime.slice(0, 13);

    /* 当前小时在 hourly 中的下标（current 与 hourly 的时间格式一致，可直接截断比较） */
    var curIdx = -1;
    for (var i = 0; i < hTime.length; i++) {
      if (String(hTime[i]).slice(0, 13) === curHourKey) { curIdx = i; break; }
    }
    if (curIdx < 0 && curTime) {
      var curMs = isoMs(curTime);
      for (i = hTime.length - 1; i >= 0; i--) {
        if (isoMs(hTime[i]) <= curMs) { curIdx = i; break; }
      }
    }

    /* 基准：今日 0:00；缺失时退回当前之前最早可用点 */
    var baseIdx = -1;
    for (i = 0; i < hTime.length; i++) {
      if (String(hTime[i]) === todayStr + 'T00:00') { baseIdx = i; break; }
    }
    if (baseIdx < 0) {
      var start = curIdx >= 0 ? curIdx : hTime.length - 1;
      for (i = start; i >= 0; i--) {
        if (n(hTemp[i]) !== null) { baseIdx = i; break; }
      }
    }

    /* 逐时序列（供曲线：过去 24h + 未来 12h） */
    var hourly = [];
    for (i = 0; i < hTime.length; i++) {
      var t = String(hTime[i]);
      hourly.push({
        time: t,
        ts: isoMs(t),
        date: t.slice(0, 10),
        hour: parseInt(t.slice(11, 13), 10),
        temp: n(hTemp[i]),
        press: n(hPress[i]),
        pressSurface: n(hSurf[i]),
        precip: n(hPrecip[i]),
        cloud: n(hCloud[i]),
        code: n(hCode[i]),
        desc: weatherText(hCode[i]),
        windSpeed: n(hWind[i])
      });
    }

    var code = n(cur.weather_code);
    var visM = n(cur.visibility);
    var precip = n(cur.precipitation);
    if (precip === null && curIdx >= 0) precip = n(hPrecip[curIdx]);
    var press = n(cur.pressure_msl);
    if (press === null) press = n(cur.surface_pressure);

    var current = {
      temp: n(cur.temperature_2m),
      feels: n(cur.apparent_temperature),
      press: press,
      pressSurface: n(cur.surface_pressure),
      humidity: n(cur.relative_humidity_2m),
      windDir: degToDir(n(cur.wind_direction_10m)),
      windDeg: n(cur.wind_direction_10m),
      windSpeed: n(cur.wind_speed_10m),
      windGust: n(cur.wind_gusts_10m),
      cloud: n(cur.cloud_cover),
      visibility: visM === null ? null : Math.round(visM / 100) / 10, /* 米 → 公里 */
      desc: weatherText(code),
      code: code,
      precip: precip,
      rain: n(cur.rain),
      showers: n(cur.showers),
      snowfall: n(cur.snowfall),
      dew: n(cur.dew_point_2m),
      uv: curIdx >= 0 ? round1(n(hUv[curIdx])) : null,
      obsTime: fmtIsoLocal(curTime) + ' 模式时刻',
      timeRaw: curTime,
      elev: n(d.elevation)
    };

    /* 今日高/低、UV、降水合计（daily 与 current.time 同一天） */
    var daily = d.daily || {};
    var dTime = daily.time || [];
    var di = -1;
    for (i = 0; i < dTime.length; i++) {
      if (String(dTime[i]) === todayStr) { di = i; break; }
    }
    if (di < 0 && dTime.length) di = 0;
    var today = {
      max: di >= 0 ? n((daily.temperature_2m_max || [])[di]) : null,
      min: di >= 0 ? n((daily.temperature_2m_min || [])[di]) : null,
      uv: di >= 0 ? n((daily.uv_index_max || [])[di]) : null,
      sunrise: '',
      sunset: '',
      totalPrecip: di >= 0 ? n((daily.precipitation_sum || [])[di]) : null
    };

    var metrics = trendToday(hourly, current, baseIdx, curTime);

    var warnings = ['数据为 Open-Meteo 数值模式（网格插值/预报），非气象站实测'];
    if (metrics.hours !== null && metrics.hours < 3) {
      warnings.push('今日已过时段不足 3 小时，ΔT/ΔP 参考性有限');
    }
    if (hourly.length < 20) {
      warnings.push('逐时数据仅 ' + hourly.length + ' 条，曲线参考性有限');
    }
    if (place.elevation !== null && place.elevation !== undefined &&
        current.elev !== null && Math.abs(place.elevation - current.elev) > 300) {
      warnings.push('城市海拔 ' + Math.round(place.elevation) + ' m 与模式网格海拔 ' +
        Math.round(current.elev) + ' m 差异较大，气温/气压仅供参考');
    }

    return {
      source: 'Open-Meteo 数值模式',
      place: place,
      current: current,
      today: today,
      hourly: hourly,
      forecast: curIdx >= 0 ? hourly.slice(curIdx) : hourly,
      metrics: metrics,
      warnings: warnings,
      fetchedAt: new Date()
    };
  }

  /* ---------------- 3. MET Norway 备源解析 ---------------- */
  function metSymbolOf(t) {
    if (!t || !t.data) return '';
    var n1 = t.data.next_1_hours;
    if (n1 && n1.summary && n1.summary.symbol_code) return n1.summary.symbol_code;
    var n6 = t.data.next_6_hours;
    if (n6 && n6.summary && n6.summary.symbol_code) return n6.summary.symbol_code;
    return '';
  }

  /* 1h 降水量 mm（没有 next_1_hours 时用 next_6_hours 平均） */
  function metPrecip1h(t) {
    if (!t || !t.data) return null;
    var n1 = t.data.next_1_hours;
    if (n1 && n1.details && n1.details.precipitation_amount !== undefined) {
      return n(n1.details.precipitation_amount);
    }
    var n6 = t.data.next_6_hours;
    if (n6 && n6.details && n6.details.precipitation_amount !== undefined) {
      var p6 = n(n6.details.precipitation_amount);
      return p6 === null ? null : round1(p6 / 6);
    }
    return null;
  }

  /* 备源不含过去时段，只能用“未来约 N 小时预报变化”代替，并明确标注 forecastBased */
  function forecastTrend(hourly, current, hoursAhead) {
    var out = {
      dT: null, dP: null, hours: null, fromHour: null, fromTime: null,
      forecastBased: true,
      text: '暂无趋势数据'
    };
    if (!hourly.length || current.temp === null) return out;
    var base = hourly[0];
    var target = hourly[hourly.length - 1];
    var want = hoursAhead || 9;
    for (var i = 1; i < hourly.length; i++) {
      if ((hourly[i].ts - base.ts) / 3600000 >= want) { target = hourly[i]; break; }
    }
    var hours = round1((target.ts - base.ts) / 3600000);
    if (hours === null || hours <= 0) hours = 0;
    out.dT = (current.temp !== null && target.temp !== null) ? round1(target.temp - current.temp) : null;
    out.dP = (current.press !== null && target.press !== null) ? round1(target.press - current.press) : null;
    out.hours = hours;
    out.fromHour = base.hour;
    out.fromTime = base.time;
    out.text = '未来约 ' + hours + ' 小时预报变化（MET Norway 数值模式，非实测）';
    return out;
  }

  function parseMet(d, place) {
    var props = d && d.properties;
    var ts = props && props.timeseries;
    if (!ts || !ts.length) throw new Error('返回数据缺少 timeseries');
    var now = Date.now();

    /* 取离当前时刻最近的预报时次作为“当前” */
    var nearIdx = 0, best = Infinity;
    for (var i = 0; i < ts.length; i++) {
      var ms = Date.parse(ts[i].time);
      if (isNaN(ms)) continue;
      var diff = Math.abs(ms - now);
      if (diff < best) { best = diff; nearIdx = i; }
    }
    var near = ts[nearIdx];
    var nd = (near.data && near.data.instant && near.data.instant.details) || {};

    /* 备源没有时区字段：按经度粗估当地时差（教学展示够用，且不冒充精确） */
    var off = isFinite(place.lon) ? Math.round(place.lon / 15) : 0;

    var windMs = n(nd.wind_speed);
    var current = {
      temp: n(nd.air_temperature),
      feels: null,
      press: n(nd.air_pressure_at_sea_level),
      pressSurface: null,
      humidity: n(nd.relative_humidity),
      windDir: degToDir(n(nd.wind_from_direction)),
      windDeg: n(nd.wind_from_direction),
      windSpeed: windMs === null ? null : round1(windMs * 3.6), /* m/s → km/h */
      windGust: null,
      cloud: n(nd.cloud_area_fraction),
      visibility: null,
      desc: metSymbolText(metSymbolOf(near)),
      code: null,
      precip: metPrecip1h(near),
      rain: null,
      showers: null,
      snowfall: null,
      dew: null,
      uv: null,
      obsTime: fmtTsPlace(near.time, off) + ' 模式时刻',
      timeRaw: near.time,
      elev: (d.geometry && d.geometry.coordinates && d.geometry.coordinates.length > 2)
        ? n(d.geometry.coordinates[2]) : null
    };

    /* 未来逐时（过去时段备源不提供）：最多 37 条 / 30 小时 */
    var hourly = [];
    var horizon = now + 30 * 3600000;
    for (i = nearIdx; i < ts.length && hourly.length < 37; i++) {
      var t = ts[i];
      var tms = Date.parse(t.time);
      if (isNaN(tms) || tms > horizon) break;
      var det = (t.data && t.data.instant && t.data.instant.details) || {};
      var shifted = new Date(tms + off * 3600000);
      var sp = n(det.wind_speed);
      hourly.push({
        time: t.time,
        ts: tms,
        date: shifted.toISOString().slice(0, 10),
        hour: shifted.getUTCHours(),
        temp: n(det.air_temperature),
        press: n(det.air_pressure_at_sea_level),
        pressSurface: null,
        precip: metPrecip1h(t),
        cloud: n(det.cloud_area_fraction),
        code: null,
        desc: metSymbolText(metSymbolOf(t)),
        windSpeed: sp === null ? null : round1(sp * 3.6)
      });
    }

    /* 今日高/低：备源只有当前之后的预报，只能算“今日剩余时段”，并注明 */
    var todayStr = new Date(now + off * 3600000).toISOString().slice(0, 10);
    var dayTemps = [];
    for (i = nearIdx; i < ts.length && i < nearIdx + 40; i++) {
      var tms2 = Date.parse(ts[i].time);
      if (isNaN(tms2)) continue;
      var dstr = new Date(tms2 + off * 3600000).toISOString().slice(0, 10);
      if (dstr > todayStr) break;
      if (dstr < todayStr) continue;
      var tv = n(ts[i].data && ts[i].data.instant && ts[i].data.instant.details &&
        ts[i].data.instant.details.air_temperature);
      if (tv !== null) dayTemps.push(tv);
    }
    var hasDayRange = dayTemps.length >= 2;
    var today = {
      max: hasDayRange ? Math.max.apply(null, dayTemps) : null,
      min: hasDayRange ? Math.min.apply(null, dayTemps) : null,
      uv: null,
      sunrise: '',
      sunset: '',
      totalPrecip: null
    };

    var metrics = forecastTrend(hourly, current, 9);

    var warnings = ['主源 Open-Meteo 不可用，已降级到 MET Norway 数值预报（非气象站实测）'];
    warnings.push('备源不含过去时段逐时数据，曲线从当前时刻起为未来预报');
    if (hourly.length < 20) {
      warnings.push('逐时数据仅 ' + hourly.length + ' 条，曲线参考性有限');
    }
    if (hasDayRange) {
      warnings.push('今日高/低为备源对今日剩余时段的预报值');
    }

    return {
      source: 'MET Norway',
      place: place,
      current: current,
      today: today,
      hourly: hourly,
      forecast: hourly,
      metrics: metrics,
      warnings: warnings,
      fetchedAt: new Date()
    };
  }

  /* ---------------- 4. 统一入口（Open-Meteo / MET Norway 并行竞速 → 双失败明确报错） ---------------- */
  function normalizePlace(place, lat, lon) {
    place = place || {};
    return {
      name: place.name || '当前位置',
      prov: place.prov || place.provFull || place.admin1 || '',
      provFull: place.provFull || place.prov || place.admin1 || '',
      lat: lat,
      lon: lon,
      elevation: n(place.elevation)
    };
  }

  function load(place) {
    place = place || {};
    var lat = n(place.lat), lon = n(place.lon);
    if (lat === null || lon === null) {
      return Promise.reject(new Error('经纬度缺失，无法获取实况'));
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return Promise.reject(new Error('经纬度超出有效范围，无法获取实况'));
    }
    var P = normalizePlace(place, lat, lon);

    /* 两个数据源并行请求，谁先成功用谁（双源竞速）；
       都失败才报错。二者都是数值模式，页面上会标明本次来源。 */
    var omPromise = fetchJSON(openMeteoUrl(lat, lon), TIMEOUT)
      .then(function (d) { return parseOpenMeteo(d, P); });
    var metPromise = fetchJSON(metNorwayUrl(lat, lon), TIMEOUT)
      .then(function (d) { return parseMet(d, P); });

    return new Promise(function (resolve, reject) {
      var pending = 2, settled = false, errs = [];
      function ok(d) { if (settled) return; settled = true; resolve(d); }
      function bad(name, e) {
        errs.push(name + '（' + errText(e) + '）');
        pending--;
        if (!settled && pending === 0) {
          settled = true;
          reject(new Error('实时天气获取失败：' + errs.join('；') + '。请检查网络后重试'));
        }
      }
      omPromise.then(ok).catch(function (e) { bad('Open-Meteo', e); });
      metPromise.then(ok).catch(function (e) { bad('MET Norway', e); });
    })
      .then(function (data) {
        if (P.elevation === null && data.current && data.current.elev !== null &&
            data.current.elev !== undefined) {
          P.elevation = data.current.elev;
        }
        data.place = P;
        if (data.current && data.current.windDir &&
            (data.current.windDeg === null || data.current.windDeg === undefined)) {
          data.current.windDeg = dirToDeg16(data.current.windDir);
        }
        data.judge = judge(data);
        return data;
      });
  }

  /* ---------------- 5. 锋面判读 ---------------- */
  function judge(data) {
    var c = data.current || {};
    var m = data.metrics || {};
    var dT = m.dT, dP = m.dP, h = m.hours || 0;
    var reasons = [];
    var type = 'none', title = '暂未见明显锋面活动', confidence = 'low';
    var windNote = '';

    if (c.windDir && c.windDeg !== null && c.windDeg !== undefined) {
      windNote = '当前风 ' + c.windDir + '风（' + Math.round(c.windDeg) + '°）' +
        (c.windSpeed !== null && c.windSpeed !== undefined ? '，' + c.windSpeed + ' km/h' : '');
    }

    if (dT === null || dP === null) {
      reasons.push('缺少可用的气温/气压变化数据，无法判定锋面类型；可查看当前天气现象与风向辅助判断。');
      return { type: 'none', title: title, confidence: 'low', reasons: reasons, windNote: windNote, dT: dT, dP: dP, hours: h };
    }

    var rainHours = (data.hourly || []).filter(function (x) { return x.precip !== null && x.precip > 0.2; }).length;
    var pressHigh = c.press !== null && c.press !== undefined && c.press >= 1010;
    var bigCloud = c.cloud !== null && c.cloud !== undefined && c.cloud >= 70;
    var heavyRain = c.precip !== null && c.precip !== undefined && c.precip >= 2;

    reasons.push('气温较今日早期变化 ΔT ≈ ' + signed(dT) + ' ℃，气压变化 ΔP ≈ ' + signed(dP) + ' hPa（' + (m.text || '') + '）。');
    if (windNote) reasons.push(windNote + '。');

    if (dT <= -4 && dP >= 3) {
      type = 'cold';
      title = '冷锋影响特征明显（气温骤降、气压升高）';
      confidence = h >= 6 ? 'high' : 'medium';
      reasons.push('ΔT ≤ −4℃ 且 ΔP ≥ +3hPa：冷气团推进、气温骤降、气压上升，符合冷锋过境后的典型特征。');
      if (heavyRain && bigCloud) reasons.push('当前有降水且云量大：冷锋过境常伴随短时强降水、大风，雨区多在锋后。');
    } else if (dT >= 3 && dP <= -3) {
      type = 'warm';
      title = '暖锋影响特征明显（气温回升、气压下降）';
      confidence = h >= 6 ? 'high' : 'medium';
      reasons.push('ΔT ≥ +3℃ 且 ΔP ≤ −3hPa：暖空气爬升、气压下降，符合暖锋过境特征。');
      if (rainHours >= 2) reasons.push('已持续多个时段有降水：暖锋云系宽广、降水连续，雨区多在锋前。');
    } else if (Math.abs(dT) < 2.5 && Math.abs(dP) < 2) {
      if (rainHours >= 3) {
        type = 'stationary';
        title = '准静止锋影响特征（气温气压变化小、降水持续）';
        confidence = h >= 6 ? 'medium' : 'low';
        reasons.push('|ΔT| < 2.5℃、|ΔP| < 2hPa 而且降水时段长：符合准静止锋长时间阴雨的特征（如江淮梅雨、昆明准静止锋）。');
      } else {
        type = 'none';
        title = '天气平稳，暂无明显锋面活动';
        confidence = 'medium';
        reasons.push('气温与气压变化都很小，且无持续性降水：更可能是单一气团控制或锋面尚未来临。');
      }
    } else if (dP >= 3 && dT > -4) {
      type = 'none';
      title = '气压明显上升，但气温变化未达冷锋标准';
      confidence = 'low';
      reasons.push('气压上升但 ΔT 未达到 −4℃，可能是冷高压控制或冷锋已过境一段时间，建议结合等压线图判断。');
    } else {
      type = 'none';
      title = '未见典型锋面天气特征';
      confidence = 'low';
      reasons.push('气温、气压变化方向或幅度不符合冷锋/暖锋/准静止锋的典型判据，可能是局地热力对流或单一气团控制。');
    }

    if (data.metrics && data.metrics.forecastBased) {
      confidence = 'low';
      reasons.push('注意：本次数据来自数值模式（非气象站实测），结论仅供参考。');
    }

    return {
      type: type, title: title, confidence: confidence, reasons: reasons,
      windNote: windNote, dT: dT, dP: dP, hours: h
    };
  }

  function signed(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + v;
  }

  /* 判读结果 → 建议演示的锋面类型（用于“一键重现”） */
  function demoType(result) {
    if (!result) return null;
    if (result.type === 'cold' || result.type === 'warm' || result.type === 'stationary') return result.type;
    return null;
  }

  var DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  function degToDir(deg) {
    if (deg === null || deg === undefined || !isFinite(deg)) return '';
    var i = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
    return DIRS[i];
  }
  function dirToDeg16(pt) {
    var map = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
      S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
    return map[pt] !== undefined ? map[pt] : null;
  }

  global.LIVE = {
    PRESETS: PRESETS,
    TIMEOUT: TIMEOUT,
    REFRESH_MS: REFRESH_MS,
    weatherText: weatherText,
    WEATHER_CODES: WMO_ZH,
    searchCity: searchCity,
    nearestCity: nearestCity,
    load: load,
    judge: judge,
    demoType: demoType,
    degToDir: degToDir
  };
})(typeof window !== 'undefined' ? window : globalThis);
