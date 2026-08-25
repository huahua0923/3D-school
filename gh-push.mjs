// ============================================================
// 通过 GitHub Git Data API 推送文件（github.com git 端口被墙，走 api.github.com）
// 用法: LOCAL_DIR=<项目根目录> node gh-push.mjs <file1> [file2 ...]
// token 从 Windows 凭据管理器取（git credential fill）
// ============================================================
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OWNER = 'huahua0923';
const REPO = '3D-school';
const BRANCH = 'main';
const BASE = 'https://api.github.com';
const LOCAL_DIR = process.env.LOCAL_DIR || process.cwd();
const COMMIT_MSG = process.env.COMMIT_MSG || 'fix: 修复功能缺失问题';

function getToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('无法从 git credential 获取 token');
  return m[1].trim();
}

async function api(path, method, token, body, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    if (res.ok) return json;
    // 503/429/5xx 为瞬时错误，退避重试
    if (res.status >= 500 || res.status === 429) {
      const wait = 1000 * (attempt + 1);
      console.warn(`  ⚠️ ${path} -> ${res.status}，${wait / 1000}s 后重试 (${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  throw new Error(`${method} ${path} -> 重试耗尽`);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: LOCAL_DIR=<dir> node gh-push.mjs <file1> [file2 ...]');
  process.exit(1);
}

// 本地运行时文件（含密钥/个性化配置），永远不进 git
// 否则部署 tarball 会覆盖服务器上后台改过的 config.json（系统名字回退的根因）
const NEVER_PUSH = new Set(['config.json', '.env', 'config.json.bak']);
const blocked = files.filter(f => NEVER_PUSH.has(f.replace(/\\/g, '/')));
if (blocked.length > 0) {
  console.error('❌ 拒绝推送本地运行时文件（会覆盖服务器改过的配置 / 泄露密钥）: ' + blocked.join(', '));
  process.exit(1);
}

const token = getToken();

// 1. 当前 HEAD + base tree
const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, 'GET', token);
const headSha = ref.object.sha;
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${headSha}`, 'GET', token);
const baseTreeSha = commit.tree.sha;

// 2. 为每个变更文件创建 blob
const treeItems = [];
for (const f of files) {
  const content = readFileSync(join(LOCAL_DIR, f));
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', token, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  treeItems.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  blob ${f} -> ${blob.sha.slice(0, 7)}`);
}

// 3. 新 tree（base_tree 保留未变更文件）
const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', token, {
  base_tree: baseTreeSha,
  tree: treeItems,
});

// 4. 新 commit
const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', token, {
  message: COMMIT_MSG,
  tree: tree.sha,
  parents: [headSha],
});

// 5. 更新 ref
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, 'PATCH', token, {
  sha: newCommit.sha,
  force: false,
});

console.log(`✅ 已推送 ${files.length} 个文件，commit ${newCommit.sha.slice(0, 7)}`);
