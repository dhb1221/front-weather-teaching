/* ============================================================
 * live.js — M6「实况天气」数据层：联网取数 + 锋面判读
 *
 * 数据链（逐级降级，任意一级失败自动下一级，全程不伪造数据）：
 *   1) 地理编码：https://geocoding-api.open-meteo.com/v1/search （中文城市名→经纬度/海拔）
 *   2) 实况主力：https://wttr.in/{lat},{lon}?format=j1&lang=zh
 *        含 current_condition（气温/体感/气压/湿度/风/云量/能见度/UV/降水/露点）
 *        + weather[3 天] 的 3 小时粒度 hourly（可用于“今日以来”变化）
 *   3) 备选：https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=&lon=
 *        含 air_temperature / air_pressure_at_sea_level / 湿度 / 风 / 云量 / 1h 降水
 *   4) 全部失败 → 由 app.js 显示离线教学示例，并允许手动输入观测值
 *
 * 说明（重要，页面会原样展示）：
 *   权威教材判据用“24 小时气温/气压变化”，但公开免费数据源无法取到昨天同刻的实测，
 *   因此这里用「今日已过时段（约 N 小时）的变化」作近似，并明确标注 N，不外推成 24h。
 *
 * API：window.LIVE = {
 *   PRESETS, searchCity(q), load(place), judge(data), demoType(judgeResult)
 * }
 * ============================================================ */
(function (global) {
  'use strict';

  var TIMEOUT = 6500;

  var PRESETS = [
    { name: '贵阳', lon: 106.63, lat: 26.65, elevation: 1100 },
    { name: '北京', lon: 116.41, lat: 39.90, elevation: 44 },
    { name: '上海', lon: 121.47, lat: 31.23, elevation: 4 },
    { name: '广州', lon: 113.26, lat: 23.13, elevation: 21 },
    { name: '武汉', lon: 114.31, lat: 30.59, elevation: 37 },
    { name: '昆明', lon: 102.71, lat: 25.04, elevation: 1892 },
    { name: '哈尔滨', lon: 126.53, lat: 45.80, elevation: 142 }
  ];

  function fetchJSON(url, timeout) {
    return new Promise(function (resolve, reject) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctl) ctl.abort();
        reject(new Error('timeout'));
      }, timeout || TIMEOUT);
      fetch(url, ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (txt) {
          clearTimeout(timer);
          var d;
          try { d = JSON.parse(txt); } catch (e) { reject(new Error('bad json')); return; }
          resolve(d);
        })
        .catch(function (e) {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  function n(v, d) {
    var x = parseFloat(v);
    return isFinite(x) ? x : (d === undefined ? null : d);
  }

  /* ---------------- 1. 城市搜索 ---------------- */
  function searchCity(q) {
    q = String(q || '').trim();
    if (!q) return Promise.resolve([]);
    var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(q) + '&count=8&language=zh&format=json';
    return fetchJSON(url).then(function (d) {
      var out = (d.results || []).map(function (r) {
        return {
          name: r.name,
          admin1: r.admin1 || '',
          country: r.country || '',
          lon: r.longitude,
          lat: r.latitude,
          elevation: r.elevation
        };
      });
      return out;
    });
  }

  /* ---------------- 2. wttr.in 解析 ---------------- */
  function parseWttr(d, place) {
    var cc = (d.current_condition && d.current_condition[0]) || {};
    var descZh = '';
    if (cc.lang_zh && cc.lang_zh[0]) descZh = cc.lang_zh[0].value;
    var current = {
      temp: n(cc.temp_C),
      feels: n(cc.FeelsLikeC),
      press: n(cc.pressure),
      humidity: n(cc.humidity),
      windSpeed: n(cc.windspeedKmph),
      windGust: n(cc.windgustKmph),
      windDeg: n(cc.winddirDegree),
      windDir: cc.winddir16Point || '',
      cloud: n(cc.cloudcover),
      visibility: n(cc.visibility),
      uv: n(cc.uvIndex),
      precip: n(cc.precipMM),
      dew: n(cc.DewPointC),
      desc: descZh || (cc.weatherDesc && cc.weatherDesc[0] && cc.weatherDesc[0].value) || '',
      descEn: (cc.weatherDesc && cc.weatherDesc[0] && cc.weatherDesc[0].value) || '',
      obsTime: cc.observation_time || ''
    };

    var days = d.weather || [];
    var today = days[0] || {};
    var hourly = [];
    (today.hourly || []).forEach(function (h) {
      hourly.push({
        time: h.time,                       // "0" .. "2100"
        hour: parseInt(h.time, 10) / 100,
        temp: n(h.tempC),
        press: n(h.pressure),
        precip: n(h.precipMM),
        cloud: n(h.cloudcover),
        windDeg: n(h.winddirDegree),
        windSpeed: n(h.windspeedKmph),
        desc: (h.lang_zh && h.lang_zh[0] && h.lang_zh[0].value) || (h.weatherDesc && h.weatherDesc[0] && h.weatherDesc[0].value) || ''
      });
    });

    /* 三日 3 小时预报（画趋势用） */
    var forecast = [];
    days.forEach(function (day, di) {
      (day.hourly || []).forEach(function (h, hi) {
        forecast.push({
          day: di,
          time: h.time,
          temp: n(h.tempC),
          press: n(h.pressure),
          precip: n(h.precipMM),
          cloud: n(h.cloudcover),
          windDeg: n(h.winddirDegree),
          windSpeed: n(h.windspeedKmph)
        });
      });
    });

    var metrics = trendFromHourly(hourly, current);

    return {
      source: 'wttr.in',
      place: place,
      current: current,
      today: {
        max: n(today.maxtempC),
        min: n(today.mintempC),
        uv: n(today.uvIndex),
        sunrise: today.astronomy && today.astronomy[0] ? today.astronomy[0].sunrise : '',
        sunset: today.astronomy && today.astronomy[0] ? today.astronomy[0].sunset : '',
        totalPrecip: (today.hourly || []).reduce(function (s, h) { return s + (n(h.precipMM, 0) || 0); }, 0)
      },
      hourly: hourly,
      forecast: forecast,
      metrics: metrics,
      warnings: metrics.hours < 3 ? ['实况数据已过去时段不足 3 小时，温度/气压趋势参考性有限'] : [],
      fetchedAt: new Date()
    };
  }

  /* 用今日已过时段最早的一个整点与当前实况比较，得到近似变化 */
  function trendFromHourly(hourly, current) {
    var nowH = new Date().getHours();
    if (!hourly.length || current.temp === null) {
      return { dT: null, dP: null, hours: 0, fromHour: null, text: '暂无趋势数据' };
    }
    var pick = null;
    for (var i = 0; i < hourly.length; i++) {
      if (hourly[i].hour <= nowH - 2 && hourly[i].temp !== null) { pick = hourly[i]; break; }
    }
    if (!pick) pick = hourly[0];
    var hours = Math.max(1, nowH - pick.hour);
    var dT = current.temp !== null && pick.temp !== null ? current.temp - pick.temp : null;
    var dP = current.press !== null && pick.press !== null ? current.press - pick.press : null;
    return {
      dT: dT === null ? null : Math.round(dT * 10) / 10,
      dP: dP === null ? null : Math.round(dP * 10) / 10,
      hours: hours,
      fromHour: pick.hour,
      text: '较今日 ' + ('0' + pick.hour).slice(-2) + ':00 前后（约 ' + hours + ' 小时）'
    };
  }

  /* ---------------- 3. MET Norway 备选 ---------------- */
  function parseMet(d, place) {
    var ts = (d.properties && d.properties.timeseries) || [];
    if (!ts.length) throw new Error('met.no empty');
    var now = Date.now();
    var first = ts[0];
    var cur = first && first.data && first.data.instant && first.data.instant.details ? first.data.instant.details : {};
    var near = first;
    for (var i = 0; i < Math.min(ts.length, 8); i++) {
      if (Math.abs(new Date(ts[i].time).getTime() - now) < Math.abs(new Date(near.time).getTime() - now)) near = ts[i];
    }
    var nd = near.data.instant.details || {};
    var hourlies = ts.slice(0, 24).map(function (t) {
      var det = t.data.instant.details || {};
      var next1 = t.data.next_1_hours && t.data.next_1_hours.details;
      return {
        time: t.time,
        hour: new Date(t.time).getHours(),
        temp: n(det.air_temperature),
        press: n(det.air_pressure_at_sea_level),
        precip: next1 ? n(next1.precipitation_amount) : null,
        cloud: n(det.cloud_area_fraction),
        windDeg: n(det.wind_from_direction),
        windSpeed: n(det.wind_speed),
        desc: ''
      };
    });
    var windFrom = n(nd.wind_from_direction);
    var current = {
      temp: n(nd.air_temperature),
      feels: null,
      press: n(nd.air_pressure_at_sea_level),
      humidity: n(nd.relative_humidity),
      windSpeed: n(nd.wind_speed),
      windDeg: windFrom,
      windDir: degToDir(windFrom),
      cloud: n(nd.cloud_area_fraction),
      precip: hourlies[0] ? hourlies[0].precip : null,
      elev: d.geometry && d.geometry.coordinates ? d.geometry.coordinates[2] : null,
      desc: '',
      descEn: ''
    };
    /* 未来 12 小时内的变化作为“趋势”替代（明确标注为预报变化） */
    var later = hourlies[Math.min(3, hourlies.length - 1)];
    var metrics = {
      dT: current.temp !== null && later.temp !== null ? Math.round((later.temp - current.temp) * 10) / 10 : null,
      dP: current.press !== null && later.press !== null ? Math.round((later.press - current.press) * 10) / 10 : null,
      hours: 9,
      fromHour: null,
      forecastBased: true,
      text: '未来约 9 小时预报变化（met.no，非实测）'
    };
    return {
      source: 'MET Norway',
      place: place,
      current: current,
      today: { max: null, min: null, uv: null, sunrise: '', sunset: '', totalPrecip: null },
      hourly: hourlies,
      forecast: hourlies,
      metrics: metrics,
      warnings: ['主数据源不可用，已降级到 MET Norway；气温/气压变化来自预报而非实测'],
      fetchedAt: new Date()
    };
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

  /* ---------------- 4. 统一入口 ---------------- */
  function load(place) {
    var lat = n(place.lat), lon = n(place.lon);
    if (lat === null || lon === null) return Promise.reject(new Error('经纬度缺失'));
    var wttrUrl = 'https://wttr.in/' + lat.toFixed(3) + ',' + lon.toFixed(3) + '?format=j1&lang=zh';
    return fetchJSON(wttrUrl, TIMEOUT)
      .then(function (d) { return parseWttr(d, place); })
      .catch(function () {
        var metUrl = 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=' +
          lat.toFixed(3) + '&lon=' + lon.toFixed(3);
        return fetchJSON(metUrl, TIMEOUT).then(function (d) { return parseMet(d, place); });
      })
      .then(function (data) {
        if (data.current.windDir && !data.current.windDeg) {
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
      reasons.push('注意：本次变化量来自预报而非实测，结论仅供参考。');
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

  global.LIVE = {
    PRESETS: PRESETS,
    TIMEOUT: TIMEOUT,
    searchCity: searchCity,
    load: load,
    judge: judge,
    demoType: demoType,
    degToDir: degToDir
  };
})(typeof window !== 'undefined' ? window : globalThis);
