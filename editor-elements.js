// ============================================================
// editor-elements.js — 元素操作 / 绘制 / 文字 / 楼梯 / 比例尺标定 / 命中测试
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// ============================================================
import {
  state, setState, ctx, canvasWrap, genId, getSelEl, showToast,
  DEFAULT_ROUTE_COLOR, DEFAULT_AREA_COLOR, DEFAULT_TEXT_COLOR, DEFAULT_TEXT_BG, DEFAULT_STAIR_COLOR,
} from './editor-state.js';
import { pointNearSegment, pointInPolygon, ensureGeoBounds, scaleFromBounds, boundsFromScale } from './editor-geometry.js';
import { loadBgImage } from './editor-canvas.js';
import { saveHistory } from './editor-history.js';
import { updatePropsPanel, updateToolBtns } from './editor-ui.js';

export function selectElement(el) {
  setState({ selectedElementId: el && el.id ? el.id : null, selectedElementIds: [] });
  updatePropsPanel();
}

export function deleteSelected() {
  const ids = state.selectedElementIds.length > 0 ? state.selectedElementIds : (state.selectedElementId ? [state.selectedElementId] : []);
  if (ids.length === 0) return;
  setState({ elements: state.elements.filter(e => !ids.includes(e.id)), selectedElementId: null, selectedElementIds: [] });
  saveHistory();
}

export function duplicateSelected() {
  const el = getSelEl(); if (!el) return;
  const newEl = { ...JSON.parse(JSON.stringify(el)), id: genId(), name: el.name + ' 副本',
    points: el.points.map(p => ({ x: p.x + 20, y: p.y + 20 })) };
  setState({ elements: [...state.elements, newEl], selectedElementId: newEl.id });
  saveHistory();
}

export function bringToFront(id) {
  const idx = state.elements.findIndex(e => e.id === id);
  if (idx < 0 || idx === state.elements.length - 1) return;
  const els = [...state.elements];
  els.push(els.splice(idx, 1)[0]);
  setState({ elements: els });
  saveHistory();
}

export function sendToBack(id) {
  const idx = state.elements.findIndex(e => e.id === id);
  if (idx <= 0) return;
  const els = [...state.elements];
  els.unshift(els.splice(idx, 1)[0]);
  setState({ elements: els });
  saveHistory();
}

export function alignElements(ids, type) {
  const els = state.elements.filter(e => ids.includes(e.id));
  if (els.length < 2) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  els.forEach(e => e.points.forEach(p => {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const newEls = state.elements.map(e => {
    if (!ids.includes(e.id)) return e;
    const ecx = e.points.reduce((s, p) => s + p.x, 0) / e.points.length;
    const ecy = e.points.reduce((s, p) => s + p.y, 0) / e.points.length;
    let ox = 0, oy = 0;
    switch (type) {
      case 'left': ox = minX - ecx; break;
      case 'center': ox = cx - ecx; break;
      case 'right': ox = maxX - ecx; break;
      case 'top': oy = minY - ecy; break;
      case 'middle': oy = cy - ecy; break;
      case 'bottom': oy = maxY - ecy; break;
    }
    return { ...e, points: e.points.map(p => ({ x: p.x + ox, y: p.y + oy })) };
  });
  setState({ elements: newEls });
  saveHistory();
}

export function startDrawing(point) {
  setState({ isDrawing: true, drawingPoints: [point], selectedElementId: null });
}

export function addDrawingPoint(point) {
  if (!state.isDrawing) return;
  const last = state.drawingPoints[state.drawingPoints.length - 1];
  if (last && Math.hypot(last.x - point.x, last.y - point.y) < 1) return; // 与上一点重合，去重
  setState({ drawingPoints: [...state.drawingPoints, point] });
}

export function finishDrawing() {
  const isArea = state.currentTool === 'draw-area';
  const minPts = isArea ? 3 : 2;
  if (!state.isDrawing) return;
  if (state.drawingPoints.length < minPts) {
    setState({ isDrawing: false, drawingPoints: [] });
    showToast(isArea ? '⚠️ 区域至少需要 3 个点' : '⚠️ 路线至少需要 2 个点');
    return;
  }
  const bn = isArea ? '区域' : '路线';
  const cnt = state.elements.filter(e => e.name.startsWith(bn)).length + 1;
  const newEl = {
    id: genId(), type: isArea ? 'area' : 'route', name: `${bn} ${cnt}`,
    visible: true, locked: false, points: [...state.drawingPoints],
    color: isArea ? DEFAULT_AREA_COLOR : DEFAULT_ROUTE_COLOR,
    strokeWidth: isArea ? 2 : 3, opacity: isArea ? 0.3 : 1,
  };
  setState({ elements: [...state.elements, newEl], selectedElementId: newEl.id, isDrawing: false, drawingPoints: [] });
  saveHistory();
}

export function addTextAnnotation(point) {
  state.pendingTextPoint = point;
  if (!state.textInputEl) {
    state.textInputEl = document.createElement('input');
    state.textInputEl.type = 'text';
    state.textInputEl.className = 'inline-text-input';
    state.textInputEl.placeholder = '输入文字，回车确定';
    canvasWrap.appendChild(state.textInputEl);
    state.textInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
    });
    state.textInputEl.addEventListener('blur', commitText);
  }
  const sx = state.stagePosition.x + point.x * state.stageScale;
  const sy = state.stagePosition.y + point.y * state.stageScale;
  state.textInputEl.style.left = sx + 'px';
  state.textInputEl.style.top = (sy - 16) + 'px';
  state.textInputEl.value = '';
  state.textInputEl.style.display = 'block';
  state.textInputEl.focus();
}

export function commitText() {
  if (!state.textInputEl || state.textInputEl.style.display === 'none') return;
  const text = state.textInputEl.value.trim();
  const p = state.pendingTextPoint;
  state.textInputEl.style.display = 'none';
  state.textInputEl.blur();
  state.pendingTextPoint = null;
  if (!text || !p) return;
  const cnt = state.elements.filter(e => e.type === 'text').length + 1;
  const newEl = {
    id: genId(), type: 'text', name: `文字 ${cnt}`, visible: true, locked: false,
    points: [p], color: DEFAULT_TEXT_COLOR, strokeWidth: 0, opacity: 1,
    label: text, fontSize: 16, backgroundColor: DEFAULT_TEXT_BG,
  };
  setState({ elements: [...state.elements, newEl], selectedElementId: newEl.id });
  saveHistory();
}

export function cancelText() {
  if (!state.textInputEl) return;
  state.textInputEl.style.display = 'none';
  state.textInputEl.blur();
  state.pendingTextPoint = null;
}

// 楼梯：单击画一个点，弹出内联输入框填「楼梯名」；同名（不同楼层）在寻路时自动连成垂直边
export function addStair(point) {
  state.pendingStairPoint = point;
  if (!state.stairInputEl) {
    state.stairInputEl = document.createElement('input');
    state.stairInputEl.type = 'text';
    state.stairInputEl.className = 'inline-text-input';
    state.stairInputEl.placeholder = '输入楼梯名（如：东楼梯），同名校内各层自动相连';
    canvasWrap.appendChild(state.stairInputEl);
    state.stairInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitStair(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelStair(); }
    });
    state.stairInputEl.addEventListener('blur', commitStair);
  }
  const sx = state.stagePosition.x + point.x * state.stageScale;
  const sy = state.stagePosition.y + point.y * state.stageScale;
  state.stairInputEl.style.left = sx + 'px';
  state.stairInputEl.style.top = (sy - 16) + 'px';
  state.stairInputEl.value = '';
  state.stairInputEl.style.display = 'block';
  state.stairInputEl.focus();
}

export function commitStair() {
  if (!state.stairInputEl || state.stairInputEl.style.display === 'none') return;
  const name = state.stairInputEl.value.trim();
  const p = state.pendingStairPoint;
  state.stairInputEl.style.display = 'none';
  state.stairInputEl.blur();
  state.pendingStairPoint = null;
  if (!name || !p) { showToast('⚠️ 楼梯名不能为空'); return; }
  const newEl = {
    id: genId(), type: 'stair', name, visible: true, locked: false,
    points: [p], color: DEFAULT_STAIR_COLOR, strokeWidth: 0, opacity: 1,
    stairId: name, category: '楼梯',
  };
  setState({ elements: [...state.elements, newEl], selectedElementId: newEl.id });
  saveHistory();
}

export function cancelStair() {
  if (state.stairInputEl) { state.stairInputEl.style.display = 'none'; state.stairInputEl.blur(); }
  state.pendingStairPoint = null;
}

// ===================== 比例尺标定（参考线：画一段已知距离的线 → 输入米数） =====================

export function startCalibrate() {
  setState({ calibrating: true, currentTool: 'select', isDrawing: false, drawingPoints: [] });
  updateToolBtns();
  showToast('📏 请沿图上一条已知长度的线段点两个点（如一段 50 米的通道）');
}

export function showCalibrateInput() {
  const pts = state.drawingPoints;
  if (pts.length < 2) return;
  const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
  if (!state.calibrateInputEl) {
    state.calibrateInputEl = document.createElement('input');
    state.calibrateInputEl.type = 'number';
    state.calibrateInputEl.min = '0';
    state.calibrateInputEl.step = '0.1';
    state.calibrateInputEl.className = 'inline-text-input';
    state.calibrateInputEl.placeholder = '这段实际多少米？';
    canvasWrap.appendChild(state.calibrateInputEl);
    state.calibrateInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitCalibrate(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelCalibrate(); }
    });
    state.calibrateInputEl.addEventListener('blur', commitCalibrate);
  }
  const sx = state.stagePosition.x + mx * state.stageScale;
  const sy = state.stagePosition.y + my * state.stageScale;
  state.calibrateInputEl.style.left = sx + 'px';
  state.calibrateInputEl.style.top = (sy - 18) + 'px';
  state.calibrateInputEl.value = '';
  state.calibrateInputEl.style.display = 'block';
  state.calibrateInputEl.focus();
}

export function commitCalibrate() {
  if (!state.calibrateInputEl || state.calibrateInputEl.style.display === 'none') return;
  const meters = parseFloat(state.calibrateInputEl.value);
  state.calibrateInputEl.style.display = 'none';
  state.calibrateInputEl.blur();
  const pts = state.drawingPoints;
  setState({ calibrating: false, isDrawing: false, drawingPoints: [] });
  if (!isFinite(meters) || meters <= 0 || pts.length < 2) { showToast('⚠️ 请输入有效的米数'); return; }
  const dpx = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  if (dpx < 1) { showToast('⚠️ 两点距离太近'); return; }
  const mpp = meters / dpx;   // 每像素多少米（比例尺真相）
  const imgW = state.imageWidth || 1200;
  const imgH = state.imageHeight || 800;
  const gb = ensureGeoBounds();
  const { center } = scaleFromBounds(gb, imgW);
  const nb = boundsFromScale(center, mpp, imgW, imgH, gb.rotation || 0);
  setState({ geoBounds: nb, geoBoundsExplicit: true });
  showToast(`✅ 比例尺已标定：1px = ${(mpp * 100).toFixed(2)}cm · 整图 ≈ ${(imgW * mpp).toFixed(1)}m × ${(imgH * mpp).toFixed(1)}m`);
}

export function cancelCalibrate() {
  if (state.calibrateInputEl) { state.calibrateInputEl.style.display = 'none'; state.calibrateInputEl.blur(); }
  setState({ calibrating: false, isDrawing: false, drawingPoints: [] });
}

export function updateSelEl(updates) {
  const id = state.selectedElementId; if (!id) return;
  setState({ elements: state.elements.map(e => e.id === id ? { ...e, ...updates } : e) });
  saveHistory();
}

export function updateSelPoints(points) {
  const id = state.selectedElementId; if (!id) return;
  setState({ elements: state.elements.map(e => e.id === id ? { ...e, points } : e) });
  saveHistory();
}

export async function setBackgroundImage(dataUrl, w, h) {
  const optimized = await optimizeImage(dataUrl);
  setState({ backgroundImage: optimized, imageWidth: w, imageHeight: h });
  saveHistory();
  loadBgImage(optimized, w, h);
}

// 背景图过大时按最大边长压缩，避免 base64 撑爆数据库/JSON
function optimizeImage(dataUrl, maxDim = 1600) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        if (scale >= 1) { resolve(dataUrl); return; }
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        // 保持原图格式：PNG 带透明通道，JPEG 会把透明区域压成黑底，透明底图会看起来「导入坏了」
        const png = dataUrl.indexOf('image/png') !== -1;
        resolve(c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.85));
      } catch (e) {
        console.error('⚠️ 背景图压缩失败，回退原图', e);
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function hitTest(mx, my) {
  const threshold = 8;
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    if (!el.visible || el.locked) continue;
    if (el.type === 'route') {
      for (let j = 0; j < el.points.length - 1; j++) {
        if (pointNearSegment(mx, my, el.points[j], el.points[j + 1], threshold)) return el;
      }
    } else if (el.type === 'area') {
      if (pointInPolygon(mx, my, el.points)) return el;
    } else if (el.type === 'text') {
      const p = el.points[0];
      if (p) {
        const fs = el.fontSize || 16;
        ctx.save();
        ctx.font = `${fs}px "Inter","PingFang SC","Microsoft YaHei",sans-serif`;
        const pw = ctx.measureText(el.label || '').width + 16;
        ctx.restore();
        const ph = fs + 10;
        if (mx >= p.x - 2 && mx <= p.x + pw + 2 && my >= p.y - ph / 2 - 2 && my <= p.y + ph / 2 + 2) return el;
      }
    } else if (el.type === 'stair') {
      const p = el.points[0];
      if (p && Math.hypot(mx - p.x, my - p.y) < threshold + 6) return el;
    }
  }
  const sel = getSelEl();
  if (sel && !sel.locked && (sel.type === 'route' || sel.type === 'area')) {
    for (let i = 0; i < sel.points.length; i++) {
      if (Math.hypot(mx - sel.points[i].x, my - sel.points[i].y) < threshold) {
        return { __vertex: i, element: sel };
      }
    }
  }
  return null;
}
