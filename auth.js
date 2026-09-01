// ========================================================
// auth.js — 首页登录（角色决定方案可见性）
// 未登录 = 访客（等同普通用户，仅公开方案）；超级用户/管理员 = 全部方案
// 首页为纯查看：无编辑、无删除，登录只影响「能看到哪些方案」
// ========================================================
import { state, AUTH_KEY, ROLE_NAMES } from './state.js';
import { getActivePlanIds, saveActivePlanIds, removePlanOverlay, refreshPlanList, renderPlanList, fetchPlanData, applyPlan, syncFloorVisibility } from './indoor.js';
import { rebuildLocaIfActive } from './loca.js';

function openLogin() {
    const overlay = document.getElementById('login-modal');
    if (overlay) { overlay.style.display = 'flex'; setTimeout(() => document.getElementById('login-user').focus(), 50); }
}
function closeLogin() {
    const overlay = document.getElementById('login-modal');
    if (overlay) overlay.style.display = 'none';
}

async function doLogin() {
    const username = (document.getElementById('login-user').value || '').trim();
    const pwd = document.getElementById('login-pwd').value;
    if (!username || !pwd) { alert('请输入用户名和密码'); return; }
    try {
        const payload = { username, password: pwd };
        const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = await r.json();
        if (!r.ok) { alert('登录失败：' + (j.error || ('HTTP ' + r.status))); return; }
        state.viewerAuth = { token: j.token, username: j.username, role: j.role };
        localStorage.setItem(AUTH_KEY, j.token);
        closeLogin();
        renderAuthState();
        await refreshPlansAfterAuthChange();
    } catch (e) { alert('登录失败：' + e.message); }
}

async function logout() {
    state.viewerAuth = { token: null, username: null, role: null };
    localStorage.removeItem(AUTH_KEY);
    renderAuthState();
    await refreshPlansAfterAuthChange();
}

export async function initAuth() {
    try {
        const token = localStorage.getItem(AUTH_KEY);
        if (!token) { renderAuthState(); return; }
        state.viewerAuth.token = token;
        const r = await fetch('/api/check', { headers: { 'Authorization': 'Bearer ' + token } });
        if (r.ok) {
            const j = await r.json();
            state.viewerAuth.username = j.username;
            state.viewerAuth.role = j.role;
        } else {
            state.viewerAuth = { token: null, username: null, role: null };
            localStorage.removeItem(AUTH_KEY);
        }
    } catch (_) {
        state.viewerAuth = { token: null, username: null, role: null };
    }
    renderAuthState();
}

function renderAuthState() {
    const btn = document.getElementById('btn-auth');
    const badge = document.getElementById('auth-badge');
    const hint = document.getElementById('auth-hint');
    if (state.viewerAuth.role) {
        if (btn) btn.textContent = '🚪 退出';
        if (badge) { badge.textContent = ROLE_NAMES[state.viewerAuth.role] || state.viewerAuth.role; badge.style.display = 'inline-block'; }
        if (hint) hint.textContent = (state.viewerAuth.role === 'user') ? '仅显示公开方案' : '显示全部方案';
    } else {
        if (btn) btn.textContent = '👤 登录';
        if (badge) badge.style.display = 'none';
        if (hint) hint.textContent = '未登录 · 仅显示公开方案';
    }
}

// 登录/退出后清空已叠加方案，按新角色重新加载可见方案
async function refreshPlansAfterAuthChange() {
    if (state.planMap) getActivePlanIds().forEach(id => removePlanOverlay(state.planMap, Number(id)));
    saveActivePlanIds([]);
    await refreshPlanList();
    rebuildLocaIfActive();
    const allIds = state.planProjects.map(p => String(p.id));
    saveActivePlanIds(allIds);
    renderPlanList();
    if (state.planMap && allIds.length > 0) {
        Promise.all(allIds.map(id => fetchPlanData(id))).then(plans => {
            plans.forEach(plan => { if (plan) applyPlan(state.planMap, plan); });
            rebuildLocaIfActive();
            syncFloorVisibility();
        });
    }
}

document.getElementById('login-cancel').addEventListener('click', closeLogin);
document.getElementById('login-submit').addEventListener('click', doLogin);
document.getElementById('login-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeLogin(); });
document.getElementById('login-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('btn-auth').addEventListener('click', () => { state.viewerAuth.role ? logout() : openLogin(); });
