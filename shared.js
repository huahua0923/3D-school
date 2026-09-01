// ============================================================
// shared.js — 三页共享工具（颜色 / HTML 转义 / Toast 提示）
// build-free 纯脚本，通过 <script src="shared.js"></script> 引入。
// 顶层 function 声明会挂到 window（供 index 的 <script type="module">
// 及 admin/admin-map/editor 的经典脚本直接调用）；COLOR_PRESETS 是
// 全局词法 const，仅经典脚本消费（editor.js / admin-map.html）。
// ============================================================

// 颜色调色板（编辑器 + 地图编辑共用；取并集：editor 比 admin-map 多一个 #22c55e）
const COLOR_PRESETS = [
  '#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4',
  '#f97316','#84cc16','#14b8a6','#6366f1','#d946ef','#0ea5e9','#e11d48',
  '#22c55e','#eab308','#a855f7','#64748b','#ffffff','#000000'
];

/** 颜色统一转为 #hex 字符串（config 中路线颜色已被 loadConfig 转为 int） */
function colorToHex(c, fallback = '#3b82f6') {
  if (c == null) return fallback;
  if (typeof c === 'string') return c.startsWith('#') ? c : '#' + c;
  if (typeof c === 'number') return '#' + c.toString(16).padStart(6, '0');
  return fallback;
}

/** hex → rgba() 字符串（canvas 渐变用）；健壮版：兼容 3 位 hex 与非法输入回退 */
function hexToRgba(hex, alpha) {
  const h = String(hex || '#f59e0b').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : (h.length === 6 ? h : 'f59e0b');
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/** hex 颜色明暗调整（amount 负=变暗，正=变亮），用于 3D 体块侧面 */
function shadeHex(hex, amount) {
  const h = String(hex || '#10b981').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : (h.length === 6 ? h : '10b981');
  const n = parseInt(full, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amount < 0) { r = Math.round(r * (1 + amount)); g = Math.round(g * (1 + amount)); b = Math.round(b * (1 + amount)); }
  else { r = Math.round(r + (255 - r) * amount); g = Math.round(g + (255 - g) * amount); b = Math.round(b + (255 - b) * amount); }
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

/** HTML 转义（渲染用户输入前调用，防 XSS） */
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 轻量 Toast 提示（依赖页面里的 <div id="toast">，无该节点则静默跳过） */
let _toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}
