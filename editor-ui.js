// ============================================================
// editor-ui.js — 状态栏 / 属性面板 / 图层面板 / 颜色预设更新
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// escHtml / COLOR_PRESETS 来自 shared.js 全局
// ============================================================
import {
  state, getSelEl, TEXT_BG_PRESETS,
  $name, $floor, $building, $layerList, $propsPanel, $noSelection,
  $zoomSlider, $zoomLabel, $alignBtns, $textProps,
} from './editor-state.js';
import { computePolygonArea } from './editor-geometry.js';

export function updateUI() {
  $name.value = state.projectName;
  $floor.value = String(state.floor ?? 0);
  $building.value = state.building || '';
  $zoomSlider.value = Math.round(state.stageScale * 100);
  $zoomLabel.textContent = Math.round(state.stageScale * 100) + '%';
  document.getElementById('btn-undo').disabled = state.historyIndex < 0;
  document.getElementById('btn-redo').disabled = state.historyIndex >= state.history.length - 2;
  document.getElementById('stat-project').textContent = state.projectName;
  updateSaveStatus();
  document.getElementById('stat-elements').textContent =
    `路线:${state.elements.filter(e => e.type === 'route').length} 区域:${state.elements.filter(e => e.type === 'area').length} 文字:${state.elements.filter(e => e.type === 'text').length} 楼梯:${state.elements.filter(e => e.type === 'stair').length} | 共${state.elements.length}个`;
  document.getElementById('stat-zoom').textContent = '缩放 ' + Math.round(state.stageScale * 100) + '%';
  document.getElementById('stat-snap').textContent = '吸附 ' + (state.snapToGrid ? '✓' : '✗');
  document.getElementById('stat-history').textContent = '历史 ' + (state.history.length > 0 ? `${state.historyIndex + 1}/${state.history.length}` : '0/0');
  document.getElementById('history-step-label').textContent = state.history.length > 0 ? `${state.historyIndex + 1}/${state.history.length}` : '';

  // Guide lines
  const glCount = state.guideLines.length;
  document.getElementById('sep-guides').style.display = glCount > 0 ? '' : 'none';
  document.getElementById('stat-guides').style.display = glCount > 0 ? '' : 'none';
  document.getElementById('btn-clear-guides').style.display = glCount > 0 ? '' : 'none';
  document.getElementById('stat-guides').textContent = `参考线 ${glCount}条`;

  // Align buttons visibility
  const selIds = state.selectedElementIds.length > 0 ? state.selectedElementIds : (state.selectedElementId ? [state.selectedElementId] : []);
  $alignBtns.style.display = selIds.length >= 2 ? 'flex' : 'none';

  // Background image info
  document.getElementById('bg-img-info').textContent = state.backgroundImage ? `尺寸: ${state.imageWidth} × ${state.imageHeight}px` : '';

  // Layer list
  let html = '';
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    const sel = el.id === state.selectedElementId;
    html += `<div class="layer-item${sel ? ' selected' : ''}" data-id="${el.id}">
      <span class="color-dot" style="background:${el.color};opacity:${el.opacity}"></span>
      <span class="name">${escHtml(el.name)}</span>
      <button class="${el.visible ? '' : 'off'}" data-action="toggle-vis">👁</button>
      <button class="${el.locked ? '' : 'off'}" data-action="toggle-lock">🔒</button>
    </div>`;
  }
  $layerList.innerHTML = html || '<div style="padding:16px;text-align:center;color:#555577;font-size:0.8rem;">使用工具开始绘制</div>';

  document.getElementById('bg-opacity').value = Math.round(state.bgOpacity * 100);

  updatePropsPanel();
}

export function updatePropsPanel() {
  const el = getSelEl();
  if (!el) {
    $propsPanel.classList.remove('visible');
    $noSelection.style.display = 'block';
    return;
  }
  $propsPanel.classList.add('visible');
  $noSelection.style.display = 'none';

  document.getElementById('prop-name').value = el.name;
  document.getElementById('prop-color').value = el.color;
  document.getElementById('prop-stroke').value = el.strokeWidth || 0;
  document.getElementById('prop-opacity').value = Math.round((el.opacity ?? 1) * 100);

  const isText = el.type === 'text';
  const isArea = el.type === 'area';
  $textProps.style.display = isText ? '' : 'none';
  document.getElementById('category-props').style.display = isArea ? '' : 'none';
  document.getElementById('label-stroke').style.display = isText ? 'none' : '';
  document.getElementById('prop-stroke').style.display = isText ? 'none' : '';
  document.getElementById('label-fontsize').style.display = isText ? '' : 'none';
  document.getElementById('prop-fontsize').style.display = isText ? '' : 'none';

  if (isText) {
    document.getElementById('prop-text').value = el.label || '';
    document.getElementById('prop-fontsize').value = el.fontSize || 16;
  }

  if (isArea) {
    document.getElementById('prop-category').value = el.category || '';
  }

  // Point info
  let info = `节点数: ${el.points.length}`;
  if (el.type === 'route' && el.points.length >= 2) {
    let len = 0;
    for (let i = 0; i < el.points.length - 1; i++) len += Math.hypot(el.points[i + 1].x - el.points[i].x, el.points[i + 1].y - el.points[i].y);
    info += ' | 长度: ' + Math.round(len) + 'px';
  }
  if (el.type === 'area' && el.points.length >= 3) info += ' | 面积: ' + Math.round(Math.abs(computePolygonArea(el.points))) + 'px²';
  document.getElementById('prop-point-info').textContent = info;
}

export function updateColorPresets() {
  document.getElementById('color-presets').innerHTML = COLOR_PRESETS.map(c =>
    `<span class="color-preset" style="background:${c}" data-color="${c}" title="${c}"></span>`).join('');
  document.getElementById('text-bg-presets').innerHTML = TEXT_BG_PRESETS.map(c =>
    `<span class="color-preset" style="background:${c}" data-color="${c}" title="${c}"></span>`).join('');
}

export function updateSaveStatus() {
  const el = document.getElementById('stat-save');
  if (!el) return;
  if (state.lastSavedAt) {
    el.textContent = '💾 已保存 ' + new Date(state.lastSavedAt).toLocaleTimeString();
    el.style.color = '#10b981';
  } else {
    el.textContent = '● 未保存';
    el.style.color = '#ffb347';
  }
}

export function updateToolBtns() {
  document.querySelectorAll('#toolbar button').forEach(b => { b.classList.toggle('active', b.dataset.tool === state.currentTool); });
}
