/* ============================================================
 * build.mjs — 把开发版打包成「单文件离线网页」docs/index.html
 *   node build.mjs
 * 做两件事：
 *   1) 把 styles.css 内联进 <style>
 *   2) 把 vendor/three.min.js 与 src/*.js 按原顺序内联进 <script>
 * 产物可直接双击打开（file://），也可直接作为 GitHub Pages 的 /docs 首页。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const escScript = (s) => s.replace(/<\/script/gi, '<\\/script');

let html = read('index.html');

/* 1) 内联 CSS */
const css = read('styles.css');
html = html.replace(
  /<link rel="stylesheet" href="styles\.css" \/>/,
  () => '<style>\n' + css + '\n</style>'
);

/* 2) 内联脚本 */
const scriptRe = /<script src="([^"]+)"><\/script>/g;
const scripts = [];
let m;
while ((m = scriptRe.exec(html)) !== null) scripts.push({ tag: m[0], src: m[1] });

const inlined = [];
for (const s of scripts) {
  let code;
  try {
    code = read(s.src);
  } catch (e) {
    throw new Error('缺少脚本：' + s.src + '（' + e.message + '）');
  }
  const banner = '\n/* ==== ' + s.src + ' ==== */\n';
  inlined.push({ tag: s.tag, code: '<script>' + banner + escScript(code) + '\n</script>' });
}
for (const it of inlined) html = html.replace(it.tag, () => it.code);

/* 3) 写入 docs/ */
const outDir = path.join(ROOT, 'docs');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'index.html');
fs.writeFileSync(outFile, html, 'utf8');

/* 附带：把 README 也给 Pages 一份（可直接访问） */
for (const f of ['README.md']) {
  try {
    fs.copyFileSync(path.join(ROOT, f), path.join(outDir, f));
  } catch (e) { /* 可选文件 */ }
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('✔ 已生成 ' + path.relative(ROOT, outFile));
console.log('  大小：' + kb(Buffer.byteLength(html)));
console.log('  内联脚本：' + scripts.length + ' 个');
console.log('  用法：双击打开该文件即可离线使用；或 push 后开启 Pages（main /docs）。');
