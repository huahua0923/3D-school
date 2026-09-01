// ============================================================
// editor-main.js — 路线图编辑器入口：事件装配 + 初始化序列
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// ============================================================
import {
  state, setState, on, emit,
  canvasWrap, $ctxMenu, $name, $floor, $building, $layerList,
  rulerTopCanvas, rulerLeftCanvas,
  snap, fromCanvas, getToken, authHeaders, showToast,
} from './editor-state.js';
import {
  selectElement, deleteSelected, duplicateSelected, bringToFront, sendToBack,
  alignElements, startDrawing, addDrawingPoint, finishDrawing, addTextAnnotation, addStair,
  showCalibrateInput, cancelCalibrate, updateSelEl, setBackgroundImage, hitTest,
} from './editor-elements.js';
import { undo, redo, resetHistory, saveHistory } from './editor-history.js';
import { render, renderRulers, animateFlow, loadBgImage } from './editor-canvas.js';
import { updateUI, updateToolBtns, updateColorPresets } from './editor-ui.js';
import { exportPNG, exportSVG } from './editor-export.js';
import { showGeoBoundsModal } from './editor-geo.js';
import {
  getProjectData, loadProjectData, saveToServer, loadFromServer,
  blankProject, showLoginPrompt, loadPlanList, loadOverlayPlanIds,
} from './editor-data.js';

// ===================== Mouse/Touch =====================

function getEventPos(e) {
  const rect = canvasWrap.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  return { clientX: cx, clientY: cy, rx: cx - rect.left, ry: cy - rect.top };
}

canvasWrap.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const pos = getEventPos(e);
  const world = fromCanvas(pos.rx, pos.ry);

  if (e.button === 2) {
    const hit = hitTest(world.x, world.y);
    if (hit && hit.id) { selectElement(hit); showCtxMenu(pos.clientX, pos.clientY); }
    return;
  }

  if (state.calibrating) {
    const pt = { x: snap(world.x), y: snap(world.y) };
    if (state.isDrawing) {
      addDrawingPoint(pt);
      if (state.drawingPoints.length >= 2) showCalibrateInput();
    } else {
      startDrawing(pt);
    }
    return;
  }

  if (state.currentTool === 'pan' || (state.currentTool === 'select' && e.shiftKey)) {
    state.dragState = { type: 'pan', sx: pos.clientX, sy: pos.clientY, sp: { ...state.stagePosition } };
    canvasWrap.classList.add('panning');
    return;
  }

  if (state.currentTool === 'draw-route' || state.currentTool === 'draw-area') {
    if (state.isDrawing) {
      if (e.detail >= 2) { addDrawingPoint({ x: snap(world.x), y: snap(world.y) }); finishDrawing(); return; }
      addDrawingPoint({ x: snap(world.x), y: snap(world.y) });
    } else {
      startDrawing({ x: snap(world.x), y: snap(world.y) });
    }
    return;
  }

  if (state.currentTool === 'text-tool') {
    addTextAnnotation({ x: snap(world.x), y: snap(world.y) });
    return;
  }

  if (state.currentTool === 'draw-stair') {
    addStair({ x: snap(world.x), y: snap(world.y) });
    return;
  }

  // Select mode
  const hit = hitTest(world.x, world.y);
  if (hit && hit.__vertex !== undefined) {
    selectElement(hit.element);
    state.dragState = { type: 'vertex', eid: hit.element.id, nidx: hit.__vertex, spts: JSON.parse(JSON.stringify(hit.element.points)) };
    return;
  }
  if (hit && hit.id) {
    selectElement(hit);
    if (!hit.locked) state.dragState = { type: 'element', eid: hit.id, sw: world, spts: JSON.parse(JSON.stringify(hit.points)) };
  } else {
    selectElement(null);
    state.boxSelectState = { x: world.x, y: world.y, w: 0, h: 0 };
  }
});

canvasWrap.addEventListener('pointermove', (e) => {
  e.preventDefault();
  const pos = getEventPos(e);
  const world = fromCanvas(pos.rx, pos.ry);
  setState({ mousePos: world });
  document.getElementById('stat-pos').textContent = `X:${Math.round(world.x)} Y:${Math.round(world.y)}`;

  if (state.dragState && state.dragState.type === 'pan') {
    setState({ stagePosition: { x: state.dragState.sp.x + (pos.clientX - state.dragState.sx), y: state.dragState.sp.y + (pos.clientY - state.dragState.sy) } });
    return;
  }
  if (state.dragState && state.dragState.type === 'vertex') {
    const el = state.elements.find(e => e.id === state.dragState.eid); if (!el) return;
    const np = [...el.points]; np[state.dragState.nidx] = { x: snap(world.x), y: snap(world.y) };
    // 直接 setState，避免每次 pointermove 都写入历史（历史刷爆）
    setState({ elements: state.elements.map(e => e.id === state.dragState.eid ? { ...e, points: np } : e) });
    return;
  }
  if (state.dragState && state.dragState.type === 'element') {
    const dx = world.x - state.dragState.sw.x, dy = world.y - state.dragState.sw.y;
    const np = state.dragState.spts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    setState({ elements: state.elements.map(e => e.id === state.dragState.eid ? { ...e, points: np } : e) });
    return;
  }
  if (state.boxSelectState) { state.boxSelectState.w = world.x - state.boxSelectState.x; state.boxSelectState.h = world.y - state.boxSelectState.y; }
});

canvasWrap.addEventListener('pointerup', (e) => {
  e.preventDefault();
  canvasWrap.classList.remove('panning');

  if (state.boxSelectState) {
    const bx = state.boxSelectState.w < 0 ? state.boxSelectState.x + state.boxSelectState.w : state.boxSelectState.x;
    const by = state.boxSelectState.h < 0 ? state.boxSelectState.y + state.boxSelectState.h : state.boxSelectState.y;
    const bw = Math.abs(state.boxSelectState.w), bh = Math.abs(state.boxSelectState.h);
    if (bw > 5 || bh > 5) {
      const ids = [];
      for (const el of state.elements) {
        if (!el.visible) continue;
        if (el.points.every(p => p.x >= bx && p.x <= bx + bw && p.y >= by && p.y <= by + bh)) ids.push(el.id);
      }
      if (ids.length > 0) setState({ selectedElementIds: ids, selectedElementId: ids[0] });
    }
    state.boxSelectState = null;
  }

  if (state.dragState && (state.dragState.type === 'element' || state.dragState.type === 'vertex')) saveHistory();
  state.dragState = null;
});

canvasWrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const pos = getEventPos(e);
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const ns = Math.max(0.1, Math.min(5, state.stageScale * delta));
  const np = { x: pos.rx - (pos.rx - state.stagePosition.x) * (ns / state.stageScale), y: pos.ry - (pos.ry - state.stagePosition.y) * (ns / state.stageScale) };
  setState({ stageScale: ns, stagePosition: np });
});

canvasWrap.addEventListener('contextmenu', (e) => e.preventDefault());
canvasWrap.addEventListener('dragover', (e) => { e.preventDefault(); });
canvasWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onerror = () => { showToast('⚠️ 文件读取失败，请重试'); };
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => { setBackgroundImage(ev.target.result, img.width, img.height); setState({ stageScale: 1, stagePosition: { x: 0, y: 0 } }); showToast('✅ 背景图已导入'); };
    img.onerror = () => { showToast('⚠️ 无法解析该图片，请改用 PNG 或 JPG 格式'); };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

// ===================== Context Menu =====================

function showCtxMenu(x, y) {
  $ctxMenu.style.left = x + 'px'; $ctxMenu.style.top = y + 'px'; $ctxMenu.classList.add('visible');
  setTimeout(() => document.addEventListener('click', function h() { $ctxMenu.classList.remove('visible'); document.removeEventListener('click', h); }, { once: true }), 0);
}

$ctxMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = state.selectedElementId; if (!id) return;
    const a = btn.dataset.action;
    if (a === 'duplicate') duplicateSelected();
    if (a === 'toFront') bringToFront(id);
    if (a === 'toBack') sendToBack(id);
    if (a === 'delete') deleteSelected();
    $ctxMenu.classList.remove('visible');
  });
});

// ===================== Keyboard =====================

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (state.calibrating) {
    if (k === 'escape') { e.preventDefault(); cancelCalibrate(); }
    return; // 标定模式下屏蔽其它快捷键，先 Esc 退出
  }
  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if (ctrl && (k === 'z' && e.shiftKey || k === 'y')) { e.preventDefault(); redo(); }
  if (ctrl && k === 's') { e.preventDefault(); handleSave(); }
  if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); }
  if ((k === 'delete' || k === 'backspace') && !ctrl) {
    e.preventDefault();
    if (state.isDrawing) {
      if (state.drawingPoints.length > 1) setState({ drawingPoints: state.drawingPoints.slice(0, -1) });
      else setState({ isDrawing: false, drawingPoints: [] });
    } else {
      deleteSelected();
    }
  }
  if (k === 'v') { setState({ currentTool: 'select', isDrawing: false, drawingPoints: [] }); updateToolBtns(); }
  if (k === 'h') { setState({ currentTool: 'pan', isDrawing: false, drawingPoints: [] }); updateToolBtns(); }
  if (k === 'l') { setState({ currentTool: 'draw-route', isDrawing: false, drawingPoints: [] }); updateToolBtns(); }
  if (k === 'r') { setState({ currentTool: 'draw-area', isDrawing: false, drawingPoints: [] }); updateToolBtns(); }
  if (k === 't') { setState({ currentTool: 'text-tool', isDrawing: false, drawingPoints: [] }); updateToolBtns(); }
  if (k === 's' && !ctrl) { setState({ currentTool: 'draw-stair', isDrawing: false, drawingPoints: [] }); updateToolBtns(); }
  if (k === 'escape') { setState({ isDrawing: false, drawingPoints: [], currentTool: 'select' }); updateToolBtns(); }
  if (k === 'enter' && state.isDrawing) { finishDrawing(); }
  if (k === '?' && !ctrl) { document.getElementById('btn-shortcuts').click(); }
});

// ===================== Buttons =====================

$name.addEventListener('input', function () { setState({ projectName: this.value || '未命名项目' }); });

$floor.addEventListener('change', function () { setState({ floor: parseInt(this.value, 10) || 0 }); });

$building.addEventListener('input', function () { setState({ building: this.value.trim() }); });

document.querySelectorAll('#toolbar button').forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool; if (!tool) return;
    setState({ currentTool: tool, isDrawing: false, drawingPoints: [], calibrating: false });
    updateToolBtns();
  });
});

document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);
document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-duplicate').addEventListener('click', duplicateSelected);
document.getElementById('btn-to-front').addEventListener('click', () => bringToFront(state.selectedElementId));
document.getElementById('btn-to-back').addEventListener('click', () => sendToBack(state.selectedElementId));

document.getElementById('btn-grid').addEventListener('click', function () {
  setState({ gridEnabled: !state.gridEnabled });
  this.classList.toggle('primary', state.gridEnabled);
});
document.getElementById('btn-grid').classList.add('primary');

document.getElementById('grid-size').addEventListener('change', function () { setState({ gridSize: Number(this.value) }); });

document.getElementById('zoom-slider').addEventListener('input', function () { setState({ stageScale: Number(this.value) / 100 }); });
document.getElementById('btn-zoom-in').addEventListener('click', () => setState({ stageScale: Math.min(5, state.stageScale * 1.25) }));
document.getElementById('btn-zoom-out').addEventListener('click', () => setState({ stageScale: Math.max(0.1, state.stageScale * 0.8) }));
document.getElementById('btn-reset-view').addEventListener('click', () => setState({ stageScale: 1, stagePosition: { x: 0, y: 0 } }));

document.getElementById('bg-opacity').addEventListener('input', function () {
  const o = Number(this.value) / 100; setState({ bgOpacity: o }); saveHistory();
});

// Export
document.getElementById('btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('export-dropdown').classList.toggle('visible');
});
document.getElementById('export-dropdown').querySelectorAll('button').forEach(b => {
  b.addEventListener('click', (e) => {
    const t = b.dataset.export;
    if (t === 'png') exportPNG();
    if (t === 'svg') exportSVG();
    document.getElementById('export-dropdown').classList.remove('visible');
  });
});
document.addEventListener('click', () => document.getElementById('export-dropdown').classList.remove('visible'));

// Import image
// 导入图片 — Chrome 要求 input 始终在 DOM 中，click 在用户事件同步回调中触发
const fileInput = document.getElementById('hidden-file-input');
fileInput.addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => { showToast('⚠️ 文件读取失败，请重试'); this.value = ''; };
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => { setBackgroundImage(ev.target.result, img.width, img.height); showToast('✅ 背景图已导入'); };
    img.onerror = () => { showToast('⚠️ 无法解析该图片，请改用 PNG 或 JPG 格式'); };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  this.value = '';
});

// Snap toggle
document.getElementById('snap-toggle').addEventListener('change', function () {
  setState({ snapToGrid: this.checked });
});

// Clear guides
document.getElementById('btn-clear-guides').addEventListener('click', () => setState({ guideLines: [] }));

// Align buttons
document.querySelectorAll('#align-btns button').forEach(b => {
  b.addEventListener('click', () => {
    const ids = state.selectedElementIds.length > 0 ? state.selectedElementIds : (state.selectedElementId ? [state.selectedElementId] : []);
    const type = b.dataset.align; if (ids.length < 2 || !type) return;
    alignElements(ids, type);
  });
});

// Save/Load/New
async function handleSave() {
  const token = getToken();
  if (!token) { showLoginPrompt(() => handleSave()); return; }
  if (state.backgroundImage && !state.geoBoundsExplicit) {
    const go = confirm('⚠️ 当前方案有底图，但还未设置「地理范围」。\n未设置时，方案会默认落在当前地图中心附近，可能与实际场地不对齐。\n\n点「确定」去设置地理范围；点「取消」仍直接保存。');
    if (go) { showGeoBoundsModal(); return; }
  }
  try { await saveToServer(); } catch (err) { showToast('❌ 保存失败: ' + err.message); }
}
document.getElementById('btn-save').addEventListener('click', handleSave);
document.getElementById('btn-load').addEventListener('click', loadFromServer);
document.getElementById('btn-new').addEventListener('click', () => {
  if (state.elements.length > 0 && !confirm('确定新建？未保存更改将丢失。')) return;
  setState({
    projectId: null, projectName: '未命名项目', floor: 0, building: '', geoBounds: null, geoBoundsExplicit: false,
    backgroundImage: null, imageWidth: 0, imageHeight: 0, bgOpacity: 1,
    elements: [], selectedElementId: null, selectedElementIds: [],
    stageScale: 1, stagePosition: { x: 0, y: 0 },
  });
  state.bgImageObj = null; $name.value = '未命名项目'; state.lastSavedAt = null; resetHistory(); updateUI();
});
document.getElementById('btn-geo').addEventListener('click', showGeoBoundsModal);

// 批量导入：粘贴建筑清单 JSON，一键生成每栋 × 每层的方案骨架
function showBatchImport() {
  const token = getToken();
  if (!token) { showLoginPrompt(() => showBatchImport()); return; }
  const example = JSON.stringify({
    buildings: [
      { name: '会展中心主馆', center: [104.0636, 30.6725], widthM: 80, heightM: 60, rotation: 0, floors: [1, 2, 3, 4, 5] }
    ]
  }, null, 2);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="min-width:560px;"><h2>🧱 批量导入建筑</h2>
    <p style="color:#8888aa;font-size:0.8rem;margin-bottom:8px;">粘贴一份「建筑清单」JSON，每栋楼自动生成每个楼层的方案骨架（名称/楼层/位置/比例尺就绪，底图后续逐层导入）。</p>
    <textarea id="batch-json" style="width:100%;height:280px;padding:10px;border-radius:8px;border:1px solid #2a2a4e;background:#0f0f1a;color:#e0e0f0;font-size:0.8rem;font-family:ui-monospace,Consolas,monospace;">${example}</textarea>
    <div class="actions">
      <button class="toolbar-btn" id="batch-cancel">取消</button>
      <button class="toolbar-btn primary" id="batch-run">导入</button>
    </div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#batch-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#batch-run').onclick = async () => {
    let payload;
    try { payload = JSON.parse(overlay.querySelector('#batch-json').value); }
    catch (e) { alert('JSON 解析失败：' + e.message); return; }
    const t = getToken();
    try {
      const buildings = Array.isArray(payload) ? payload : payload.buildings;
      const res = await fetch('/api/editor/projects/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify({ buildings }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { alert('导入失败：' + (j.error || ('HTTP ' + res.status))); return; }
      overlay.remove();
      showToast('✅ 已生成 ' + (j.created || 0) + ' 个方案');
      loadPlanList();
    } catch (err) { alert('导入失败：' + err.message); }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
document.getElementById('btn-batch-import').addEventListener('click', showBatchImport);

// 侧栏方案列表：新建 / 刷新
document.getElementById('btn-plan-new').addEventListener('click', () => {
  if (state.elements.length > 0 && !confirm('确定新建？未保存更改将丢失。')) return;
  blankProject();
});
document.getElementById('btn-plan-refresh').addEventListener('click', loadPlanList);

// Shortcuts help
document.getElementById('btn-shortcuts').addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box"><h2>⌨️ 快捷键</h2>
    <div class="shortcut-grid">
      <span>选择</span><span class="key">V</span><span>平移</span><span class="key">H</span>
      <span>画线</span><span class="key">L</span><span>画框</span><span class="key">R</span>
      <span>文字</span><span class="key">T</span><span>撤销</span><span class="key">Ctrl+Z</span>
      <span>重做</span><span class="key">Ctrl+Y</span><span>保存</span><span class="key">Ctrl+S</span>
      <span>复制</span><span class="key">Ctrl+D</span><span>删除</span><span class="key">Delete</span>
      <span>取消</span><span class="key">Esc</span><span>完成绘制</span><span class="key">Enter</span>
      <span>缩放</span><span class="key">滚轮</span><span>平移</span><span class="key">Shift+拖拽</span>
      <span>框选</span><span class="key">Shift+拖拽</span>
    </div>
    <div class="actions"><button class="toolbar-btn" id="sc-close">关闭</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#sc-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
});

// ===================== Properties panel =====================

document.getElementById('prop-name').addEventListener('input', function () { updateSelEl({ name: this.value }); });
document.getElementById('prop-color').addEventListener('input', function () { updateSelEl({ color: this.value }); });
document.getElementById('prop-stroke').addEventListener('input', function () { updateSelEl({ strokeWidth: Number(this.value) }); });
document.getElementById('prop-opacity').addEventListener('input', function () { updateSelEl({ opacity: Number(this.value) / 100 }); });
document.getElementById('prop-fontsize').addEventListener('input', function () { updateSelEl({ fontSize: Number(this.value) }); });
document.getElementById('prop-text').addEventListener('input', function () { updateSelEl({ label: this.value }); });
document.getElementById('prop-category').addEventListener('change', function () { updateSelEl({ category: this.value || null }); });

// Color presets
document.getElementById('color-presets').addEventListener('click', (e) => {
  const p = e.target.closest('.color-preset'); if (!p) return;
  updateSelEl({ color: p.dataset.color });
  document.getElementById('prop-color').value = p.dataset.color;
});

// Text bg presets
document.getElementById('text-bg-presets').addEventListener('click', (e) => {
  const p = e.target.closest('.color-preset'); if (!p) return;
  updateSelEl({ backgroundColor: p.dataset.color });
});

// Layer list
$layerList.addEventListener('click', (e) => {
  const item = e.target.closest('.layer-item'); if (!item) return;
  const id = item.dataset.id;
  const action = e.target.dataset.action;
  if (action === 'toggle-vis') {
    setState({ elements: state.elements.map(el => el.id === id ? { ...el, visible: !el.visible } : el) });
    saveHistory();
  } else if (action === 'toggle-lock') {
    setState({ elements: state.elements.map(el => el.id === id ? { ...el, locked: !el.locked } : el) });
  } else {
    selectElement(state.elements.find(el => el.id === id));
  }
});

// ===================== Resize =====================
new ResizeObserver(() => { render(); renderRulers(); }).observe(canvasWrap);

// ===================== Ruler Drag =====================

function addGuideLine(orientation, worldPos) {
  const gl = { id: 'gl_' + Date.now(), orientation, position: worldPos };
  setState({ guideLines: [...state.guideLines, gl] });
  return gl;
}

document.getElementById('ruler-top').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const rect = rulerTopCanvas.getBoundingClientRect();
  const screenY = e.clientY - rect.top + rect.height;
  const worldY = (screenY - state.stagePosition.y) / state.stageScale;
  state.rulerDragState = { orientation: 'horizontal', startWorldPos: worldY };
  addGuideLine('horizontal', worldY);
});

document.getElementById('ruler-left').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const rect = rulerLeftCanvas.getBoundingClientRect();
  const screenX = e.clientX - rect.left + rect.width;
  const worldX = (screenX - state.stagePosition.x) / state.stageScale;
  state.rulerDragState = { orientation: 'vertical', startWorldPos: worldX };
  addGuideLine('vertical', worldX);
});

// Global move for ruler drag — update last guide line position
document.addEventListener('pointermove', (e) => {
  if (!state.rulerDragState || state.guideLines.length === 0) return;
  const last = state.guideLines[state.guideLines.length - 1];
  let worldPos;
  if (state.rulerDragState.orientation === 'horizontal') {
    const rect = rulerTopCanvas.getBoundingClientRect();
    const screenY = e.clientY - rect.top + rect.height;
    worldPos = (screenY - state.stagePosition.y) / state.stageScale;
  } else {
    const rect = rulerLeftCanvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left + rect.width;
    worldPos = (screenX - state.stagePosition.x) / state.stageScale;
  }
  state.guideLines[state.guideLines.length - 1] = { ...last, position: worldPos };
  emit('change');
});

document.addEventListener('pointerup', () => {
  state.rulerDragState = null;
});

// ===================== Flow Animation Loop =====================
requestAnimationFrame(animateFlow);

// ===================== Init =====================

function init() {
  updateColorPresets();
  loadBgImage(state.backgroundImage, state.imageWidth, state.imageHeight);
  resetHistory();
  updateUI(); updateToolBtns(); render(); renderRulers();
}

on('change', () => { updateUI(); render(); renderRulers(); });

// Auto-save to localStorage
setInterval(() => {
  try { localStorage.setItem('editor_autosave', JSON.stringify(getProjectData())); } catch (_) {}
}, 30000);

// Restore autosave
const autosave = localStorage.getItem('editor_autosave');
if (autosave) { try { loadProjectData(JSON.parse(autosave)); } catch (_) {} }

// 从配置读取地图中心，作为默认地理范围中心
fetch('/config.json').then(r => r.ok ? r.json() : null).then(cfg => {
  if (cfg && cfg.geo) {
    state.geoConfig = cfg.geo;
    if (Array.isArray(cfg.geo.center) && cfg.geo.center.length >= 2) {
      state.defaultCenter = cfg.geo.center;
    }
  }
}).catch(() => {});

init();
loadOverlayPlanIds();
loadPlanList();

// 从 URL ?project=<id> 跳转时自动加载对应项目（供首页「编辑」按钮跳转）
(function autoLoadProjectFromUrl() {
  const id = Number(new URLSearchParams(location.search).get('project'));
  if (!id) return;
  fetch('/api/editor/projects/' + id, { headers: authHeaders() }).then(r => r.ok ? r.json() : null).then(json => {
    if (json && json.data) {
      state.projectId = id;
      loadProjectData(json.data.data || json.data, json.data.floor, json.data.building);
      showToast('✅ 已加载项目：' + (state.projectName || ('方案 ' + id)));
      loadPlanList();
    }
  }).catch(() => {});
})();

// ===================== API =====================
window.editorAPI = { getState: () => state, loadProject: loadProjectData, getProject: getProjectData, render };
