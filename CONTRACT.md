# 项目契约：锋与天气 · 高中地理交互式教具

## 目标
做一个**可离线双击打开的单文件网页教具**，讲清高中地理「常见天气系统——锋与天气」。
质量要求：可直接用于课堂/视频展示，视觉精美（深色玻璃拟态，与同目录 `../earth-3d` 教具同系列）、
手机端可用、多角度观看、原理讲透、含全部知识点与练习题。

参考项目：`/sdcard/works/earth-3d`（同系列已完成项目，**读它的 `src/m4-chart.js`、`styles.css`、`src/helpers.js` 学习风格与代码写法**，但不要修改它）。

## 目录与分工（严禁越界改文件）

```
front-weather/
  index.html          模板                       ← lead
  styles.css          全局样式                   ← lead
  build.mjs           单文件构建                  ← lead
  prompt.md           「完美提示词」交付文档       ← lead
  README.md           ← lead
  vendor/three.min.js three r150（已就位）
  src/front-data.js   统一数据源（已完成，只读）  ← lead
  src/helpers.js      公共工具（three + 2D 符号） ← lead
  src/scene3d.js      M1 立体空间模型            ← lead
  src/app.js          主控：状态/UI/主循环        ← lead
  src/m2-section.js   M2 剖面图                  ← 队友 A
  src/m4-chart.js     M4 要素曲线                ← 队友 A
  src/m3-map.js       M3 天气图                  ← 队友 B
  src/quiz.js         题库                       ← 队友 B
  src/knowledge.js    全部知识点                 ← 队友 C
  docs/               GitHub Pages 成品          ← lead
```

## 运行方式（不要启动服务器，不要跑 build）
- 开发版由 lead 用 `python3 -m http.server` + 无头 Chrome 截图验证。
- 你只需保证：文件是**经典脚本**（IIFE，`(function(global){...})(window)`），**不写 import/export**，不引入任何外部依赖；挂到 `window.MODELS` / `window.Quiz` / `window.KNOWLEDGE`。
- 写完执行 `node --check <你的文件>` 确认语法通过。
- 代码注释用中文，变量用英文；不要用 ES6 以上新语法以外的花活（可用 const/let/箭头函数/模板字符串，不要用可选链 `?.` 之外太新的东西；`?.` 也尽量少用）。

## 唯一的共享数据源：`window.FRONT`

```js
FRONT.L              // 18，锋面从 x=-18 扫到 x=+18
FRONT.PHASE_EDGE     // [0.38, 0.62] —— 时间轴 p 的三段分界
FRONT.types          // ['cold','warm','stationary']
FRONT.meta           // 每种锋的元数据（见下）
FRONT.phaseIndex(p)  // 0=过境前 1=过境时 2=过境后
FRONT.phaseName(p)   // '过境前' | '过境时' | '过境后'
FRONT.xFront(type,p) // 锋线（锋面与地面交线）在 x 轴上的位置
FRONT.span(type,p,'rain'|'cloud') // → {x0,x1} 降水/云带水平范围
FRONT.curve(type,p)  // → {temp,press,rain,cloud,phase,weather,wind,desc}
                     //   temp ℃ · press hPa · rain 0..1 · cloud 0..1
FRONT.clamp01(x) / FRONT.smooth(x) / FRONT.lerp(a,b,t) / FRONT.bump(p,a,b,c,d)
```

`FRONT.meta[type]` 字段（可直接用于文案/图例/配色）：
`name, glyph, color(十六进制字符串), oneLine, motion, slope(0.09~0.22 视觉坡度), slopeText,
rainZone('behind'|'ahead'|'both'), rainZoneText, cloudText, rainText, symbolText,
rainHalf, rainOffset, cloudHalf, cloudOffset, temp0, temp1, press0, press1,
phases[3] = {name, weather, wind, desc}, examples[]`

**坐标系（3D 与剖面图统一）**：x 轴 = 锋面移动方向（+x 指向暖气团一侧）
- 冷锋：冷气团在 `x < xFront`（冷楔），暖气团在 `x > xFront`；锋面是冷楔的上表面，向 -x 方向抬升；
  暖空气沿锋面被迫抬升 → 云雨在 **锋后**（xFront 附近偏 -x 一侧）。
- 暖锋：冷气团在 `x > xFront`（冷楔），暖气团在 `x < xFront`；锋面向 +x 方向抬升；
  云雨在 **锋前**（xFront 偏 +x 一侧），雨带很宽。
- 准静止锋：冷气团在 `x < xFront`，暖空气沿缓坡爬升，雨带在锋面附近长时间停留。
- 观测站固定在 `x = 0`；时间轴 p=0 时锋面在 x=-18，p=1 时在 x=+18（准静止锋只在 0 附近摆动）。

## 页面状态（唯一数据源，app.js 负责维护）

```js
APP.state = {
  type: 'cold',      // 'cold' | 'warm' | 'stationary'
  t: 0.22,           // 时间轴 0..1
  playing: false,
  speed: 1,          // 播放倍速 0.5 / 1 / 2
  model: 'M1',       // 'M1' 立体 | 'M2' 剖面 | 'M3' 天气图 | 'M4' 曲线 | 'M5' 知识
  mapMode: 'cyclone',// M3 子模式：'cyclone' 锋面气旋 | 'rainbelt' 我国雨带 | 'symbols' 符号判读
  month: 6,          // M3 雨带模式使用：4~9 月
  show: { slope:true, air:true, clouds:true, rain:true, labels:true, grid:true },
  view: 'iso'        // M1 相机预设
}
```

## 模块 API

### 2D 模型（M2 / M3 / M4）
```js
window.MODELS = window.MODELS || {};
window.MODELS.M2 = function createM2(ctx) {
  // ctx = { canvas, width, height, state, FRONT, H }
  return {
    draw: function (c2d, w, h, state, FRONT) {}, // 每帧调用；只在需要时重绘由 lead 控制
    resize: function (w, h) {},
    dispose: function () {}
  };
};
```
- `c2d` 已按 devicePixelRatio 缩放，**坐标一律用 CSS 像素**（w、h 即 CSS 宽高）。
- 字体统一：`'bold 14px "PingFang SC","Microsoft YaHei",sans-serif'`；主色见下。
- 画布深色背景，不要自己画整块不透明底（由 CSS 底图负责），可以画半透明面板。
- 每帧重新绘制，不要 cache 状态（简单可靠优先）。
- 别写死宽高，按 w/h 自适应；`w < 820` 视为手机：字号 ×0.85、元素间距收紧。

### 题库（`window.Quiz`）
```js
window.Quiz = {
  bank: [ { q:'题干', options:['A','B','C','D'], answer:0, explain:'解析', type:'cold'|'warm'|'stationary'|'general', tag:'判读' } ],
  pick: function (type, n) { /* 返回 n 道：优先该类型+综合题，随机打乱 */ }
};
```

### 知识（`window.KNOWLEDGE`）
```js
window.KNOWLEDGE = {
  sections: [ { id:'airmass', title:'气团与锋', icon:'🌬', html:'<p>…</p>' } ],
  glossary: [ { term:'锋面', desc:'…' } ]
};
```
`html` 里只允许用这些标签/类（样式由 lead 的 styles.css 提供）：
`<h4> <p> <ul><li> <ol><li> <b> <i> <table class="kc-table"> <th> <td> <tr>`
`<div class="kc-note">`（浅蓝提示框）`<div class="kc-warn">`（橙色易错框）`<div class="kc-key">`（重点框）
`<span class="kc-chip">`（小标签）`<br>`
**不要写 style 属性、不要写 class 以外的自定义类、不要用 script/img。**

## 配色 / 视觉

```js
var C = {
  bg: '#05070f', panel: 'rgba(16,24,42,0.72)', line: 'rgba(150,180,230,0.22)',
  text: '#dbe6ff', dim: 'rgba(219,230,255,0.55)', accent: '#4ea1ff',
  cold: '#4ea1ff',      // 冷气团 / 冷锋
  warm: '#ff8a3d',      // 暖气团（橙）
  warmLine: '#ff7a6b',  // 暖锋线（红）
  station: '#b98cff',   // 准静止锋（紫）
  rain: '#8fc8ff', cloud: '#cfd8ea', ok: '#37d39b', warn: '#ffb454'
};
```
冷气团填充用蓝色半透明，暖气团用橙色半透明，锋面用亮白色斜线/面。
`H` 工具（lead 提供，2D 可直接用）：
`H.frontSymbol(c2d, type, x, y, size, dir)` 画单个锋面符号（三角形/半圆/交替），dir=+1 或 -1；
`H.frontSymbols(c2d, type, x0, y0, x1, y1, size, opts)` 沿线段画一排符号（用于天气图）；
`H.drawArrow(c2d, x0,y0,x1,y1, color, width)` 画箭头。

## 验收标准

### M2 剖面图（src/m2-section.js）
- 图面：地面线 + 两侧气团（冷蓝/暖橙半透明块）+ 按 `FRONT.meta[type].slope` 表现坡度的锋面
- 气流箭头：冷气团水平推进（贴地）、暖气团沿锋面爬升（沿坡面箭头），冷暖两侧各一个「冷气团/暖气团」标签
- 云：冷锋画高耸的积雨云（顶部可到画面上 1/4）、暖锋画多层层状云（水平铺开）、准静止锋层状云更广更厚
- 雨：沿正确位置落雨（冷锋在锋后/锋线附近、暖锋在锋前、准静止锋在锋面附近宽雨带）；雨滴用短斜线，落地处画浅色涟漪/雨幕；气温 < 0 时画雪花（至少冷锋允许出现）
- 观测站：固定画在画面中央，小房子 + 风向旗（旗帜方向随 phase 变化），标注「观测站」
- 锋面符号：画在地面锋线处，符号方向正确（冷锋三角指向移动方向、暖锋半圆凸向移动方向）
- 顶部信息条：当前「过境前/过境时/过境后」+ 温度、气压、天气（取 `FRONT.curve(type,t)`）
- 图例 + 标题「剖面图解 · 冷锋」；底部说明一行（取 meta.slopeText 等）
- 锋线随 `state.t` 左右移动；过境时锋线正好扫过观测站

### M4 要素曲线（src/m4-chart.js）
- 横轴 = 时间（0..1，左「过境前」中「过境时」右「过境后」三段浅色分区 + 顶部段标签）
- 左轴气温（℃）、右轴气压（hPa），两条曲线用 `FRONT.curve` 采样 120 点
- 降水强度画成底部蓝色柱条（0..1 映射高度）
- 播放头竖线 + 圆点跟随 `state.t`，右上角实时读数（温度/气压/降水/天气）
- 网格 + 刻度 + 单位 + 图例；曲线要平滑（Catmull-Rom 或折线足够密）
- 三种锋的曲线形态要明显不同（冷锋陡、暖锋缓、准静止锋几乎平）

### M3 天气图（src/m3-map.js）
顶部/内部有三个子模式按钮（读 `state.mapMode`，按钮由你在 canvas 内画 or 由 app 提供——**由 app 提供**，你只读 state.mapMode）：
- `cyclone` 锋面气旋：画等压线（闭合低压，L 中心）、北半球气旋逆时针辐合的风向箭头、
  左侧冷锋（三角形符号，向东南移动）、右侧暖锋（半圆符号，向东北移动）、
  冷锋后与暖锋前的降水阴影区、标注「冷锋」「暖锋」「降水区」「低压中心」；
  可画一条虚线表示「观测站过境路线」并标出 过境前/时/后。
- `rainbelt` 我国锋面雨带：简化中国轮廓（东部为主，多边形，不求精确但轮廓可辨认），
  按 `state.month`（4~9）画出雨带位置：4-5 月华南、6 月江淮（梅雨）、7-8 月华北东北、9 月南退；
  标出主要城市（北京/上海/武汉/广州/哈尔滨 任选 3-4 个），雨带用蓝色斜线阴影 + 「雨带」标签，
  左上角显示月份与雨带位置说明。
- `symbols` 符号判读：三种锋的符号（红/蓝/紫）、名称、移动方向、降水位置对照卡片，
  点击某张卡片高亮（可用内部状态，但不要改 state；用局部变量记住点击）。
- 三种模式都要有标题、图例、简洁说明文字。

### 题库（src/quiz.js）
- 至少 30 道题，覆盖：锋的概念与结构、冷锋（3 阶段天气、实例、快行/慢行）、暖锋、准静止锋（梅雨/昆明）、
  三种锋对比、锋面气旋、我国雨带推移、气温气压曲线判读、锋面符号判读、易错概念；
- 每题 4 个选项、1 个正确答案、`explain` 一句话讲透（可 1~2 句）；
- `pick(type, n)` 随机抽题：该类型题 ≥ 一半 + 综合题；

### 知识（src/knowledge.js）
12 个 section，按这个目录（缺一不可，可增加）：
1. 气团与锋（气团概念、冷暖气团、锋/锋面/锋线/锋区、锋面坡度、锋的形成）
2. 冷锋（结构、符号、三阶段天气、快行冷锋/慢行冷锋、实例、防御）
3. 暖锋（结构、符号、三阶段天气、实例）
4. 准静止锋（形成、江淮梅雨、昆明准静止锋、华南准静止锋、影响）
5. 三种锋对比表（kc-table：坡度/云系/降水位置/降水性质/移动/气温变化/气压变化/天气实例/符号）
6. 锋面气旋（北半球左冷右暖、降水区、过境天气过程、判读步骤）
7. 我国锋面雨带推移（4-5 月华南 → 6 月江淮 → 7-8 月华北东北 → 9 月南退；副高、夏季风、异常与旱涝）
8. 判读方法（等压线图、锋面符号、气温气压曲线、卫星云图、常见设问与答题模板）
9. 易错点清单（≥8 条，用 kc-warn）
10. 经典例题与解析（≥3 题，带答案与解析，用 kc-key 标答案）
11. 生活中的锋（寒潮、沙尘暴、梅雨、回南天、一场秋雨一场寒、一场春雨一场暖）
12. 术语速查表（glossary 至少 12 条，每条 1-2 行）

内容要求：严格对标人教版高中地理必修第一册「常见天气系统」，表述准确、面向高中生、
多用短句和对比，关键结论加粗；不要抄教材原句段落，用讲透原理的方式写。

## 工作纪律
- 只改自己名下的文件；不改 index.html / styles.css / app.js / front-data.js / helpers.js；不动 earth-3d。
- 不新增依赖，不联网，不启动服务器。
- 每个文件写完 `node --check <file>`。
- 完成后向 lead 汇报：文件路径、导出的 API、已覆盖的内容、已知限制（≤15 行）。
