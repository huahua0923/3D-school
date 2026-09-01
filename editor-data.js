// ============================================================
// editor-data.js — 项目数据序列化 + 服务器存取 + 方案列表 + 登录
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// escHtml 来自 shared.js 全局
// ============================================================
import { state, setState, getToken, authHeaders, showToast, $name } from './editor-state.js';
import { ensureGeoBounds } from './editor-geometry.js';
import { loadBgImage, render } from './editor-canvas.js';
import { resetHistory } from './editor-history.js';
import { updateUI, updateSaveStatus } from './editor-ui.js';

export function getProjectData() {
  return {
    version: 1, backgroundImage: state.backgroundImage,
    imageWidth: state.imageWidth, imageHeight: state.imageHeight,
    bgOpacity: state.bgOpacity, elements: state.elements,
    projectName: state.projectName, geoBounds: ensureGeoBounds(),
  };
}

export function loadProjectData(data, floor, building) {
  setState({
    backgroundImage: data.backgroundImage || null,
    imageWidth: data.imageWidth || 0, imageHeight: data.imageHeight || 0,
    bgOpacity: data.bgOpacity ?? 1,
    elements: Array.isArray(data.elements) ? data.elements : [],
    projectName: data.projectName || '未命名项目',
    floor: floor !== undefined ? floor : 0,
    building: building || '',
    geoBounds: data.geoBounds || null,
    geoBoundsExplicit: !!(data.geoBounds),
    selectedElementId: null, selectedElementIds: [],
    isDrawing: false, drawingPoints: [], calibrating: false, stageScale: 1, stagePosition: { x: 0, y: 0 },
  });
  loadBgImage(data.backgroundImage, data.imageWidth, data.imageHeight);
  resetHistory();
  state.lastSavedAt = null;
  $name.value = data.projectName || '未命名项目';
  updateUI();
}

export async function saveToServer() {
  const token = getToken();
  if (!token) throw new Error('未登录');
  // 新建项目且名字仍是默认名时，自动追加时间戳，避免多个「未命名项目」混淆
  let name = state.projectName;
  if (!state.projectId && (!name || name === '未命名项目')) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    name = '未命名项目 ' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    setState({ projectName: name });
  }
  const data = getProjectData();
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
  let res;
  const payload = { name, data, floor: state.floor, building: state.building || '' };
  if (state.projectId) {
    res = await fetch(`/api/editor/projects/${state.projectId}`, { method: 'PUT', headers, body: JSON.stringify(payload) });
  } else {
    res = await fetch('/api/editor/projects', { method: 'POST', headers, body: JSON.stringify(payload) });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'HTTP ' + res.status);
  }
  const json = await res.json();
  if (json.id) state.projectId = json.id;
  state.lastSavedAt = Date.now();
  showToast('✅ 项目已保存到服务器');
  updateSaveStatus();
  loadPlanList();
}

export async function loadFromServer() {
  const res = await fetch('/api/editor/projects', { headers: authHeaders() });
  const json = await res.json();
  // 过滤掉「地图绘制」方案（kind==='map'），避免与 2D 路线编辑器项目混在一起
  showProjectList((json.data || []).filter(p => !(p.data && p.data.kind === 'map')));
}

export function showProjectList(projects) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  let html = '<div class="modal-box"><h2>📂 打开项目</h2>';
  if (projects.length === 0) {
    html += '<p style="color:#8888aa;text-align:center;padding:24px;">暂无保存的项目</p>';
  } else {
    projects.forEach(p => {
      html += `<div class="project-row" data-id="${p.id}">
        <span class="name">${escHtml(p.name)}</span>
        <span class="time">${escHtml(p.updated_at || '')}</span>
        <button class="toolbar-btn danger" data-delete="${p.id}" style="padding:2px 8px;font-size:0.7rem;">🗑</button>
      </div>`;
    });
  }
  html += '<div class="actions"><button class="toolbar-btn" id="modal-close">关闭</button></div></div>';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').onclick = () => overlay.remove();
  overlay.querySelectorAll('.project-row').forEach(row => {
    row.onclick = async (e) => {
      if (e.target.dataset.delete) {
        e.stopPropagation();
        if (confirm('确定删除此项目？')) {
          const t = getToken();
          const res = await fetch(`/api/editor/projects/${e.target.dataset.delete}`, { method: 'DELETE', headers: t ? { 'Authorization': 'Bearer ' + t } : {} });
          if (res.ok) { overlay.remove(); loadFromServer(); showToast('✅ 已删除'); }
          else { const j = await res.json().catch(() => ({})); alert('删除失败：' + (j.error || ('HTTP ' + res.status)) + '（请先保存/登录后再试）'); }
        }
        return;
      }
      const id = Number(row.dataset.id);
      const res = await fetch(`/api/editor/projects/${id}`);
      const json = await res.json();
      if (json.data) { state.projectId = id; loadProjectData(json.data.data || json.data, json.data.floor, json.data.building); overlay.remove(); showToast('✅ 项目已加载'); }
    };
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ===== 侧栏方案列表（始终可见，参考路线图编辑器的右侧方案列表）=====
const OVERLAY_MEMORY_KEY = 'editor_overlay_plans';

function saveOverlayPlanIds() { try { localStorage.setItem(OVERLAY_MEMORY_KEY, JSON.stringify([...state.overlayPlanIds])); } catch (_) {} }
export function loadOverlayPlanIds() { try { state.overlayPlanIds = new Set((JSON.parse(localStorage.getItem(OVERLAY_MEMORY_KEY) || '[]') || []).map(String)); } catch (_) { state.overlayPlanIds = new Set(); } }

function removePlanOverlay(id) {
  const changed = state.overlayPlanIds.delete(String(id)) || !!state.overlayPlanElements[String(id)];
  if (changed) { delete state.overlayPlanElements[String(id)]; saveOverlayPlanIds(); render(); }
}

async function togglePlanOverlay(p, on) {
  const id = String(p.id);
  if (on) {
    if (state.overlayPlanElements[id]) return;
    state.overlayPlanIds.add(id); saveOverlayPlanIds();
    try {
      const res = await fetch('/api/editor/projects/' + p.id, { headers: authHeaders() });
      const json = await res.json();
      const data = json.data && (json.data.data || json.data);
      state.overlayPlanElements[id] = (data && Array.isArray(data.elements)) ? data.elements : [];
      render();
    } catch (e) {
      console.error('❌ 叠加方案失败', e);
      state.overlayPlanIds.delete(id); saveOverlayPlanIds();
      renderPlanList();
    }
  } else {
    removePlanOverlay(id);
  }
}

async function restoreOverlayPlans() {
  for (const id of state.overlayPlanIds) {
    if (String(id) === String(state.projectId)) continue;
    if (state.overlayPlanElements[id]) continue;
    const p = state.planListCache.find(x => String(x.id) === String(id));
    if (!p) { state.overlayPlanIds.delete(id); continue; }
    try {
      const res = await fetch('/api/editor/projects/' + id, { headers: authHeaders() });
      const json = await res.json();
      const data = json.data && (json.data.data || json.data);
      state.overlayPlanElements[id] = (data && Array.isArray(data.elements)) ? data.elements : [];
    } catch (e) { state.overlayPlanIds.delete(id); }
  }
  render();
}

export async function loadPlanList() {
  try {
    const res = await fetch('/api/editor/projects', { headers: authHeaders() });
    const json = await res.json();
    state.planListCache = (json.data || []).filter(p => !(p.data && p.data.kind === 'map'));
  } catch (e) {
    state.planListCache = [];
  }
  renderPlanList();
  await restoreOverlayPlans();
}

function renderPlanList() {
  const box = document.getElementById('plan-list');
  if (!box) return;
  box.innerHTML = '';
  if (!state.planListCache.length) {
    box.innerHTML = '<div class="empty">暂无室内方案</div>';
    return;
  }
  state.planListCache.forEach(p => {
    const isCurrent = String(p.id) === String(state.projectId);
    const row = document.createElement('div');
    row.className = 'project-row' + (isCurrent ? ' selected' : '');
    if (isCurrent) {
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '✏️'; badge.title = '编辑中';
      row.appendChild(badge);
    } else {
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = state.overlayPlanIds.has(String(p.id));
      cb.title = '勾选叠加对比';
      cb.style.cssText = 'flex-shrink:0;accent-color:#3b82f6;cursor:pointer;';
      cb.addEventListener('change', () => togglePlanOverlay(p, cb.checked));
      row.appendChild(cb);
    }
    const name = document.createElement('span'); name.className = 'name'; name.textContent = p.name || ('方案 ' + p.id); name.title = p.name || '';
    const time = document.createElement('span'); time.className = 'time'; time.textContent = (p.updated_at || '').slice(0, 16).replace('T', ' ');
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = '删除';
    row.appendChild(name); row.appendChild(time); row.appendChild(del);
    row.addEventListener('click', async (e) => {
      if (e.target === del) {
        e.stopPropagation();
        if (!confirm('确定删除方案「' + (p.name || ('方案 ' + p.id)) + '」？')) return;
        const t = getToken();
        const res = await fetch('/api/editor/projects/' + p.id, { method: 'DELETE', headers: t ? { 'Authorization': 'Bearer ' + t } : {} });
        if (res.ok) {
          showToast('✅ 已删除');
          if (String(p.id) === String(state.projectId)) blankProject();
          removePlanOverlay(String(p.id));
          loadPlanList();
        } else {
          const j = await res.json().catch(() => ({}));
          alert('删除失败：' + (j.error || ('HTTP ' + res.status)) + '（请先保存/登录后再试）');
        }
        return;
      }
      if (e.target.tagName === 'INPUT') return;
      const res = await fetch('/api/editor/projects/' + p.id, { headers: authHeaders() });
      const json = await res.json();
      if (json.data) { state.projectId = p.id; loadProjectData(json.data.data || json.data, json.data.floor, json.data.building); showToast('✅ 已加载：' + (json.data.name || p.name)); removePlanOverlay(String(p.id)); renderPlanList(); }
    });
    box.appendChild(row);
  });
}

export function blankProject() {
  setState({
    projectId: null, projectName: '未命名项目', floor: 0, building: '', geoBounds: null, geoBoundsExplicit: false,
    backgroundImage: null, imageWidth: 0, imageHeight: 0, bgOpacity: 1,
    elements: [], selectedElementId: null, selectedElementIds: [],
    stageScale: 1, stagePosition: { x: 0, y: 0 },
  });
  state.bgImageObj = null; $name.value = '未命名项目'; state.lastSavedAt = null; resetHistory(); updateUI();
}

export function showLoginPrompt(onSuccess) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box"><h2>🔐 管理员登录</h2>
    <p style="color:#8888aa;margin-bottom:12px;">保存和加载项目需要管理员密码</p>
    <input type="password" id="login-pwd" placeholder="管理员密码" style="width:100%;padding:8px;border-radius:6px;border:1px solid #2a2a4e;background:#0f0f1a;color:#e0e0f0;font-size:0.9rem;margin-bottom:12px;" />
    <div class="actions"><button class="toolbar-btn" id="login-cancel">取消</button>
    <button class="toolbar-btn primary" id="login-submit">登录</button></div></div>`;
  document.body.appendChild(overlay);
  const pwdInput = overlay.querySelector('#login-pwd');
  overlay.querySelector('#login-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#login-submit').onclick = async () => {
    const pwd = pwdInput.value;
    if (!pwd) { alert('请输入密码'); return; }
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
      const json = await res.json();
      if (json.token) {
        localStorage.setItem('admin_token', json.token);
        overlay.remove();
        showToast('✅ 登录成功');
        if (onSuccess) setTimeout(onSuccess, 300);
      } else {
        alert(json.error || '密码错误');
      }
    } catch (err) {
      alert('登录失败: ' + err.message);
    }
  };
  // Enter key submits
  pwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') overlay.querySelector('#login-submit').click(); });
  // Focus the input
  setTimeout(() => pwdInput.focus(), 100);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
