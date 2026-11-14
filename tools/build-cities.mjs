/* 从 DataV 行政区划数据生成地级市索引 src/geo-cities.js
   输入: tools/raw/china-100000_full.json (省级, 含 34 个单元)
         tools/raw/100000_full_city.json (市级 + 区县)
   输出: window.GEO_CITIES = [{n:名称, s:短名, p:省, ps:省简称, lon, lat, cap:1|0}] */
import fs from 'node:fs';

const prov = JSON.parse(fs.readFileSync(new URL('./raw/china-100000_full.json', import.meta.url), 'utf8'));
const city = JSON.parse(fs.readFileSync(new URL('./raw/100000_full_city.json', import.meta.url), 'utf8'));

const provByAd = new Map();
for (const f of prov.features) {
  const p = f.properties || {};
  if (p.adcode && p.name) provByAd.set(String(p.adcode), p.name);
}

function shortProv(name) {
  return name
    .replace(/维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市$/g, '')
    .replace(/^内蒙古$/, '内蒙古')
    .replace(/^广西$/, '广西')
    .replace(/^宁夏$/, '宁夏')
    .replace(/^新疆$/, '新疆')
    .replace(/^西藏$/, '西藏');
}
function shortCity(name) {
  return name.replace(/(特别行政区|自治州|地区|林区|市|盟|县|区)$/g, '');
}

const out = [];
const seen = new Set();
function add(name, provName, lon, lat, cap) {
  if (!name || !isFinite(lon) || !isFinite(lat)) return;
  const key = name + '|' + provName;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ n: name, s: shortCity(name), p: provName, ps: shortProv(provName), lon: +lon.toFixed(3), lat: +lat.toFixed(3), cap: cap ? 1 : 0 });
}

// 直辖市 / 特别行政区：省级单元本身作为“城市”
const MUNI = new Set(['北京市', '天津市', '上海市', '重庆市', '香港特别行政区', '澳门特别行政区']);
for (const f of prov.features) {
  const p = f.properties || {};
  if (!MUNI.has(p.name)) continue;
  const c = (p.centroid || p.center || []);
  add(p.name, p.name, c[0], c[1], 1);
}

// 地级市（cap=省会/首府）
const CAP = new Set(['石家庄市','太原市','呼和浩特市','沈阳市','长春市','哈尔滨市','南京市','杭州市','合肥市','福州市','南昌市','济南市','郑州市','武汉市','长沙市','广州市','南宁市','海口市','成都市','贵阳市','昆明市','拉萨市','西安市','兰州市','西宁市','银川市','乌鲁木齐市']);
for (const f of city.features) {
  const p = f.properties || {};
  if (p.level !== 'city') continue;
  const provName = p.parent && provByAd.get(String(p.parent.adcode));
  if (!provName) continue;
  const c = (p.centroid || p.center || []);
  add(p.name, provName, c[0], c[1], CAP.has(p.name) ? 1 : 0);
}

// 台湾地区主要城市（DataV 市级数据未含，手工补充坐标）
add('台北市', '台湾省', 121.565, 25.033, 1);
add('新北市', '台湾省', 121.465, 25.012, 0);
add('桃园市', '台湾省', 121.301, 24.993, 0);
add('台中市', '台湾省', 120.685, 24.14, 0);
add('台南市', '台湾省', 120.212, 22.99, 0);
add('高雄市', '台湾省', 120.312, 22.627, 0);

const body = '/* 自动生成：node tools/build-cities.mjs —— 中国地级市（含直辖市、港澳）索引，仅名称/省份/坐标 */\n' +
  'window.GEO_CITIES = ' + JSON.stringify(out) + ';\n';
fs.writeFileSync(new URL('../src/geo-cities.js', import.meta.url), body);
console.log('cities:', out.length, 'bytes:', body.length);
const lyl = out.filter(c => c.n.indexOf('洛阳') === 0);
console.log('洛阳:', JSON.stringify(lyl));
console.log('北京:', JSON.stringify(out.filter(c => /北京/.test(c.n))));
console.log('成都:', JSON.stringify(out.filter(c => /成都/.test(c.n))));
console.log('台北?', out.filter(c => /台湾/.test(c.p)).map(c => c.n).join(','));
