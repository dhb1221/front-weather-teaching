/* 用 GitHub REST API 把当前项目整体覆盖到远端仓库（单次提交，含删除旧文件）。
 * 用法：
 *   $env:GITHUB_TOKEN="ghp_xxx"; node tools/push-github.mjs --dry-run
 *   $env:GITHUB_TOKEN="ghp_xxx"; node tools/push-github.mjs
 * 说明：不需要安装 git；权限至少需要「Contents: Read and write」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, '');
const OWNER = process.env.GH_OWNER || 'dhb1221';
const REPO = process.env.GH_REPO || 'front-weather-teaching';
const BRANCH = process.env.GH_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const DRY = process.argv.includes('--dry-run');
const API = 'https://api.github.com';
const REPO_API = `${API}/repos/${OWNER}/${REPO}`;

/* 相对路径 → 本地绝对路径；按白名单收集，避免把 _out、node_modules 传上去 */
const INCLUDE_DIRS = ['src', 'vendor', 'tools', 'docs'];
const INCLUDE_FILES = ['.gitignore', 'CONTRACT.md', 'LICENSE', 'README.md', 'build.mjs', 'index.html', 'prompt.md', 'styles.css'];
/* 与远端对齐：这些大文件不上传（旧仓库同样没有它们） */
const EXCLUDE = new Set([
  'tools/raw/100000_full_city.json',
  'node_modules'
]);
/* 远端存在、新版本已删除的文件 */
const DELETE = ['src/m3-map.js', 'docs/prompt.md'];

function walk(dir, out) {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + ent.name;
    if (EXCLUDE.has(rel)) continue;
    if (ent.isDirectory()) walk(rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

const files = [...INCLUDE_FILES];
for (const d of INCLUDE_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d, files);
const present = files.filter((f) => fs.existsSync(path.join(ROOT, f)));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'front-weather-push',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + (json && (json.message || json.error) || text.slice(0, 200)));
  }
  return json;
}

async function main() {
  console.log('目标仓库：' + OWNER + '/' + REPO + '，分支 ' + BRANCH);
  console.log('将上传 ' + present.length + ' 个文件，删除 ' + DELETE.length + ' 个：' + DELETE.join(', '));
  if (DRY) {
    for (const f of present) console.log('  + ' + f + '  (' + fs.statSync(path.join(ROOT, f)).size + ' B)');
    return;
  }
  if (!TOKEN) throw new Error('缺少 GITHUB_TOKEN 环境变量（需要 contents:write 权限）');

  const ref = await api('GET', `${REPO_API}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await api('GET', `${REPO_API}/git/commits/${baseSha}`);
  const baseTree = baseCommit.tree.sha;
  console.log('远端当前提交：' + baseSha.slice(0, 10) + '（' + baseCommit.message.split('\n')[0] + '）');

  const entries = [];
  let done = 0;
  for (const f of present) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    const blob = await api('POST', `${REPO_API}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64'
    });
    entries.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    done++;
    if (done % 10 === 0) console.log('  已上传 ' + done + '/' + present.length + ' 个 blob');
  }
  for (const f of DELETE) entries.push({ path: f, mode: '100644', type: 'blob', sha: null });

  const tree = await api('POST', `${REPO_API}/git/trees`, { base_tree: baseTree, tree: entries });
  const msg = 'feat: 删除天气图，三维地球改为真实全球等压线（7 个视角）';
  const commit = await api('POST', `${REPO_API}/git/commits`, {
    message: msg,
    tree: tree.sha,
    parents: [baseSha]
  });
  await api('PATCH', `${REPO_API}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  console.log('✔ 已推送提交 ' + commit.sha);
  console.log('  https://github.com/' + OWNER + '/' + REPO + '/commit/' + commit.sha);
}

main().catch((e) => {
  console.error('✘ ' + e.message);
  process.exit(1);
});
