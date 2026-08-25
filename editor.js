// ============================================================
// 路线图编辑器 — 核心逻辑 v2
// 基于 HTML5 Canvas，无框架依赖
// 功能完整对齐 Coze 原始项目
// ============================================================

(function () {
  'use strict';

  // ===================== 常量 =====================
  const DEFAULT_ROUTE_COLOR = '#3b82f6';
  const DEFAULT_AREA_COLOR = '#10b981';
  const DEFAULT_TEXT_COLOR = '#ffffff';
  const DEFAULT_TEXT_BG = 'rgba(0,0,0,0.7)';
  const COLOR_PRESETS = [
    '#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4',
    '#f97316','#84cc16','#14b8a6','#6366f1','#d946ef','#0ea5e9','#e11d48',
    '#22c55e','#eab308','#a855f7','#64748b','#ffffff','#000000'
  ];
  const TEXT_BG_PRESETS = [
    'rgba(0,0,0,0.7)','rgba(255,255,255,0.8)','rgba(59,130,246,0.6)',
    'rgba(16,185,129,0.6)','rgba(239,68,68,0.6)','rgba(245,158,11,0.6)',
    'rgba(139,92,246,0.6)','rgba(236,72,153,0.6)','rgba(249,115,22,0.6)',
    'rgba(34,211,238,0.6)'
  ];
  const MAX_HISTORY = 50;

  // ===================== 状态管理 =====================
  const state = {
    projectId: null,
    projectName: '未命名项目',
    floor: 0,
    building: '',
    geoBounds: null,
    geoBoundsExplicit: false,
    backgroundImage: null,
    imageWidth: 0,
    imageHeight: 0,
    bgOpacity: 1,
    currentTool: 'select',
    elements: [],
    selectedElementId: null,
    selectedElementIds: [],
    isDrawing: false,
    drawingPoints: [],
    calibrating: false,
    stageScale: 1,
    stagePosition: { x: 0, y: 0 },
    mousePos: null,
    gridEnabled: true,
    gridSize: 20,
    snapToGrid: true,
    guideLines: [],
    history: [],
    historyIndex: -1,
  };

  let bgImageObj = null;

  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach(fn => fn(data)); }
  function setState(updates) { Object.assign(state, updates); emit('change'); }
  let lastSavedAt = null;   // 上次成功保存到服务器的时间

  // ===================== DOM 引用 =====================
  const canvas = document.getElementById('editor-canvas');
  let ctx = canvas.getContext('2d'); // let — exportPNG 需要临时切换为离屏上下文
  const canvasWrap = document.getElementById('canvas-wrap');
  const $name = document.getElementById('project-name');
  const $floor = document.getElementById('project-floor');
  const $building = document.getElementById('project-building');
  const $layerList = document.getElementById('layer-list');
  const $propsPanel = document.getElementById('props-panel');
  const $noSelection = document.getElementById('no-selection');
  const $ctxMenu = document.getElementById('ctx-menu');
  const $zoomSlider = document.getElementById('zoom-slider');
  const $zoomLabel = document.getElementById('zoom-label');
  const $alignBtns = document.getElementById('align-btns');
  const $exportDropdown = document.getElementById('export-dropdown');
  const $textProps = document.getElementById('text-props');

  // ===================== Canvas 渲染 =====================

  function fromCanvas(cx, cy) {
    return {
      x: (cx - state.stagePosition.x) / state.stageScale,
      y: (cy - state.stagePosition.y) / state.stageScale
    };
  }

  function snap(v) {
    if (!state.snapToGrid) return v;
    return Math.round(v / state.gridSize) * state.gridSize;
  }

  function render() {
    const w = canvasWrap.clientWidth;
    const h = canvasWrap.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(state.stagePosition.x, state.stagePosition.y);
    ctx.scale(state.stageScale, state.stageScale);

    // Background
    const vx = -state.stagePosition.x / state.stageScale;
    const vy = -state.stagePosition.y / state.stageScale;
    const vw = w / state.stageScale;
    const vh = h / state.stageScale;
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(vx, vy, vw, vh);

    // Grid
    if (state.gridEnabled) {
      const gs = state.gridSize;
      const lw = 0.3 / state.stageScale;
      const startX = Math.floor(vx / gs) * gs;
      const startY = Math.floor(vy / gs) * gs;
      const endX = vx + vw + gs;
      const endY = vy + vh + gs;
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let x = startX; x <= endX; x += gs) { ctx.moveTo(x, startY); ctx.lineTo(x, endY); }
      for (let y = startY; y <= endY; y += gs) { ctx.moveTo(startX, y); ctx.lineTo(endX, y); }
      ctx.stroke();
    }

    // Background image
    if (bgImageObj && state.bgOpacity > 0) {
      ctx.globalAlpha = state.bgOpacity;
      ctx.drawImage(bgImageObj, 0, 0, state.imageWidth || bgImageObj.width, state.imageHeight || bgImageObj.height);
      ctx.globalAlpha = 1;
    }

    // Guide lines
    state.guideLines.forEach(gl => {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1 / state.stageScale;
      ctx.setLineDash([4 / state.stageScale, 4 / state.stageScale]);
      ctx.beginPath();
      if (gl.orientation === 'horizontal') { ctx.moveTo(vx, gl.position); ctx.lineTo(vx + vw, gl.position); }
      else { ctx.moveTo(gl.position, vy); ctx.lineTo(gl.position, vy + vh); }
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Elements
    for (const el of state.elements) { if (el.visible) drawElement(el); }

    // Overlay plans (readonly, dimmed) — 勾选的其它方案叠加对比
    for (const pid in overlayPlanElements) {
      for (const el of overlayPlanElements[pid]) { if (el.visible !== false) drawOverlayElement(el); }
    }

    // Drawing preview
    if (state.isDrawing && state.drawingPoints.length > 0) drawDrawingPreview();

    // Box select
    if (boxSelectState) {
      const s = boxSelectState;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1 / state.stageScale;
      ctx.setLineDash([5 / state.stageScale, 3 / state.stageScale]);
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(59,130,246,0.08)';
      ctx.fillRect(s.x, s.y, s.w, s.h);
    }

    ctx.restore();
  }

  function drawElement(el) {
    ctx.save();
    ctx.globalAlpha = el.opacity;
    if (el.type === 'route') drawRoute(el);
    else if (el.type === 'area') drawArea(el);
    else if (el.type === 'text') drawText(el);
    ctx.restore();

    if (el.id === state.selectedElementId && !el.locked && (el.type === 'route' || el.type === 'area')) {
      drawVertexHandles(el);
    }
  }

  // 只读叠加图层：其它方案的元素以灰暗虚线绘制，用于对比（不参与编辑/保存/选中）
  function drawOverlayElement(el) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    if (el.type === 'route') {
      if (el.points.length < 2) { ctx.restore(); return; }
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = el.strokeWidth || 3;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(el.points[0].x, el.points[0].y);
      for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (el.type === 'area') {
      if (el.points.length < 3) { ctx.restore(); return; }
      ctx.fillStyle = 'rgba(156,163,175,0.25)';
      ctx.beginPath();
      ctx.moveTo(el.points[0].x, el.points[0].y);
      for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = el.strokeWidth || 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (el.type === 'text') {
      const p = el.points[0]; if (!p) { ctx.restore(); return; }
      const fs = el.fontSize || 16;
      ctx.font = `${fs}px "Inter","PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.fillStyle = '#9ca3af';
      ctx.textBaseline = 'middle';
      ctx.fillText(el.label || '', p.x + 8, p.y);
    }
    ctx.restore();
  }

  function drawRoute(el) {
    if (el.points.length < 2) return;

    // Glow base (thicker, semi-transparent stroke underneath)
    ctx.strokeStyle = el.color + '40';
    ctx.lineWidth = (el.strokeWidth || 3) + 4;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
    ctx.stroke();

    // Main line
    ctx.strokeStyle = el.color;
    ctx.lineWidth = el.strokeWidth || 3;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
    ctx.stroke();

    // Flowing water effect - dashed highlight that animates along the line
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(2, (el.strokeWidth || 3) - 2);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash([18, 25]);
    ctx.lineDashOffset = -flowOffset * 2;
    ctx.stroke();
    ctx.restore();

    // Arrows at midpoints
    for (let i = 0; i < el.points.length - 1; i++) {
      const mx = (el.points[i].x + el.points[i + 1].x) / 2;
      const my = (el.points[i].y + el.points[i + 1].y) / 2;
      const angle = Math.atan2(el.points[i + 1].y - el.points[i].y, el.points[i + 1].x - el.points[i].x);
      const al = Math.max(6, (el.strokeWidth || 3) * 2.5);
      ctx.save(); ctx.translate(mx, my); ctx.rotate(angle);
      ctx.fillStyle = el.color;
      ctx.beginPath();
      ctx.moveTo(al, 0); ctx.lineTo(-al * 0.3, -al * 0.4); ctx.lineTo(-al * 0.3, al * 0.4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // Start/end dots
    [el.points[0], el.points[el.points.length - 1]].forEach(p => {
      ctx.fillStyle = el.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    });

    // Length
    if (el.points.length >= 2) {
      let len = 0;
      for (let i = 0; i < el.points.length - 1; i++) len += Math.hypot(el.points[i + 1].x - el.points[i].x, el.points[i + 1].y - el.points[i].y);
      const mp = el.points[Math.floor(el.points.length / 2)];
      drawPill(mp.x + 10, mp.y - 10, Math.round(len) + 'px', el.color);
    }
  }

  function drawArea(el) {
    if (el.points.length < 3) return;
    ctx.fillStyle = hexToRgba(el.color, el.opacity * 0.25);
    ctx.beginPath();
    ctx.moveTo(el.points[0].x, el.points[0].y);
    for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = el.color;
    ctx.lineWidth = el.strokeWidth || 2; ctx.lineJoin = 'round'; ctx.stroke();

    const cx = el.points.reduce((s, p) => s + p.x, 0) / el.points.length;
    const cy = el.points.reduce((s, p) => s + p.y, 0) / el.points.length;
    drawPill(cx, cy, Math.round(Math.abs(computePolygonArea(el.points))) + 'px²', el.color);
  }

  function drawText(el) {
    const p = el.points[0]; if (!p) return;
    const fs = el.fontSize || 16;
    ctx.font = `${fs}px "Inter","PingFang SC","Microsoft YaHei",sans-serif`;
    const text = el.label || '';
    const m = ctx.measureText(text);
    const pw = m.width + 16, ph = fs + 10;
    ctx.fillStyle = el.backgroundColor || DEFAULT_TEXT_BG;
    ctx.beginPath(); roundRect(ctx, p.x, p.y - ph / 2, pw, ph, ph / 2); ctx.fill();
    ctx.fillStyle = el.color || DEFAULT_TEXT_COLOR;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x + 8, p.y);
  }

  function drawVertexHandles(el) {
    el.points.forEach(p => {
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath(); ctx.arc(p.x, p.y, 5 / state.stageScale, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / state.stageScale; ctx.stroke();
    });
  }

  function drawDrawingPreview() {
    const pts = state.drawingPoints;
    const isArea = state.currentTool === 'draw-area';
    const color = state.calibrating ? '#f59e0b' : (isArea ? DEFAULT_AREA_COLOR : DEFAULT_ROUTE_COLOR);
    if (pts.length >= 2) {
      ctx.strokeStyle = color; ctx.lineWidth = isArea ? 2 : 3;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.setLineDash([6, 4]); ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (isArea && state.mousePos) {
        ctx.lineTo(state.mousePos.x, state.mousePos.y);
        ctx.lineTo(pts[0].x, pts[0].y);
      }
      ctx.stroke(); ctx.setLineDash([]);
      // 标定模式：在中点显示两点像素距离
      if (state.calibrating) {
        const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        drawPill((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2 - 16, Math.round(d) + ' px', '#f59e0b');
      }
    }
    pts.forEach(p => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); });
  }

  function drawPill(x, y, text, color) {
    ctx.font = 'bold 11px "Inter","PingFang SC","Microsoft YaHei",sans-serif';
    const m = ctx.measureText(text); const pw = m.width + 8, ph = 16;
    ctx.fillStyle = color;
    ctx.beginPath(); roundRect(ctx, x - pw / 2, y - ph / 2, pw, ph, 8); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(text, x, y); ctx.textAlign = 'start';
    ctx.globalAlpha = 1;
  }

  // ===================== Helpers =====================

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y); c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
  }

  function computePolygonArea(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return area / 2;
  }

  function hitTest(mx, my) {
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

  function pointNearSegment(px, py, a, b, threshold) {
    const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - a.x, py - a.y) < threshold;
    let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)) < threshold;
  }

  function pointInPolygon(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if ((pts[i].y > py) !== (pts[j].y > py) &&
          px < (pts[j].x - pts[i].x) * (py - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside;
    }
    return inside;
  }

  function getSelEl() { return state.elements.find(e => e.id === state.selectedElementId) || null; }

  // ===================== History =====================
  // 标准「变更后快照」模型：saveHistory 在 setState 之后调用，
  // historyIndex 始终指向当前已提交快照；undo/redo 在快照间移动。

  function snapshotState() {
    return {
      elements: JSON.parse(JSON.stringify(state.elements)),
      backgroundImage: state.backgroundImage,
      imageWidth: state.imageWidth, imageHeight: state.imageHeight,
      bgOpacity: state.bgOpacity,
    };
  }

  function saveHistory() {
    const nh = state.history.slice(0, state.historyIndex + 1);
    nh.push(snapshotState());
    if (nh.length > MAX_HISTORY) nh.shift();
    setState({ history: nh, historyIndex: nh.length - 1 });
  }

  function resetHistory() {
    setState({ history: [snapshotState()], historyIndex: 0 });
  }

  function applySnapshot(sp, ni) {
    setState({
      elements: JSON.parse(JSON.stringify(sp.elements)),
      backgroundImage: sp.backgroundImage, imageWidth: sp.imageWidth, imageHeight: sp.imageHeight,
      bgOpacity: sp.bgOpacity, historyIndex: ni,
      selectedElementId: null, selectedElementIds: [], isDrawing: false, drawingPoints: [], calibrating: false,
    });
    loadBgImage(sp.backgroundImage, sp.imageWidth, sp.imageHeight);
  }

  function undo() {
    if (state.historyIndex <= 0) return;
    applySnapshot(state.history[state.historyIndex - 1], state.historyIndex - 1);
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    applySnapshot(state.history[state.historyIndex + 1], state.historyIndex + 1);
  }

  // ===================== Element Operations =====================

  function selectElement(el) {
    setState({ selectedElementId: el && el.id ? el.id : null, selectedElementIds: [] });
    updatePropsPanel();
  }

  function deleteSelected() {
    const ids = state.selectedElementIds.length > 0 ? state.selectedElementIds : (state.selectedElementId ? [state.selectedElementId] : []);
    if (ids.length === 0) return;
    setState({ elements: state.elements.filter(e => !ids.includes(e.id)), selectedElementId: null, selectedElementIds: [] });
    saveHistory();
  }

  function duplicateSelected() {
    const el = getSelEl(); if (!el) return;
    const newEl = { ...JSON.parse(JSON.stringify(el)), id: genId(), name: el.name + ' 副本',
      points: el.points.map(p => ({ x: p.x + 20, y: p.y + 20 })) };
    setState({ elements: [...state.elements, newEl], selectedElementId: newEl.id });
    saveHistory();
  }

  function bringToFront(id) {
    const idx = state.elements.findIndex(e => e.id === id);
    if (idx < 0 || idx === state.elements.length - 1) return;
    const els = [...state.elements];
    els.push(els.splice(idx, 1)[0]);
    setState({ elements: els });
    saveHistory();
  }

  function sendToBack(id) {
    const idx = state.elements.findIndex(e => e.id === id);
    if (idx <= 0) return;
    const els = [...state.elements];
    els.unshift(els.splice(idx, 1)[0]);
    setState({ elements: els });
    saveHistory();
  }

  function alignElements(ids, type) {
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

  function startDrawing(point) {
    setState({ isDrawing: true, drawingPoints: [point], selectedElementId: null });
  }

  function addDrawingPoint(point) {
    if (!state.isDrawing) return;
    const last = state.drawingPoints[state.drawingPoints.length - 1];
    if (last && Math.hypot(last.x - point.x, last.y - point.y) < 1) return; // 与上一点重合，去重
    setState({ drawingPoints: [...state.drawingPoints, point] });
  }

  function finishDrawing() {
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

  let textInputEl = null;
  let pendingTextPoint = null;

  function addTextAnnotation(point) {
    pendingTextPoint = point;
    if (!textInputEl) {
      textInputEl = document.createElement('input');
      textInputEl.type = 'text';
      textInputEl.className = 'inline-text-input';
      textInputEl.placeholder = '输入文字，回车确定';
      canvasWrap.appendChild(textInputEl);
      textInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitText(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
      });
      textInputEl.addEventListener('blur', commitText);
    }
    const sx = state.stagePosition.x + point.x * state.stageScale;
    const sy = state.stagePosition.y + point.y * state.stageScale;
    textInputEl.style.left = sx + 'px';
    textInputEl.style.top = (sy - 16) + 'px';
    textInputEl.value = '';
    textInputEl.style.display = 'block';
    textInputEl.focus();
  }

  function commitText() {
    if (!textInputEl || textInputEl.style.display === 'none') return;
    const text = textInputEl.value.trim();
    const p = pendingTextPoint;
    textInputEl.style.display = 'none';
    textInputEl.blur();
    pendingTextPoint = null;
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

  function cancelText() {
    if (!textInputEl) return;
    textInputEl.style.display = 'none';
    textInputEl.blur();
    pendingTextPoint = null;
  }

  // ===================== 比例尺标定（参考线：画一段已知距离的线 → 输入米数） =====================
  let calibrateInputEl = null;

  function startCalibrate() {
    setState({ calibrating: true, currentTool: 'select', isDrawing: false, drawingPoints: [] });
    updateToolBtns();
    showToast('📏 请沿图上一条已知长度的线段点两个点（如一段 50 米的通道）');
  }

  function showCalibrateInput() {
    const pts = state.drawingPoints;
    if (pts.length < 2) return;
    const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
    if (!calibrateInputEl) {
      calibrateInputEl = document.createElement('input');
      calibrateInputEl.type = 'number';
      calibrateInputEl.min = '0';
      calibrateInputEl.step = '0.1';
      calibrateInputEl.className = 'inline-text-input';
      calibrateInputEl.placeholder = '这段实际多少米？';
      canvasWrap.appendChild(calibrateInputEl);
      calibrateInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitCalibrate(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelCalibrate(); }
      });
      calibrateInputEl.addEventListener('blur', commitCalibrate);
    }
    const sx = state.stagePosition.x + mx * state.stageScale;
    const sy = state.stagePosition.y + my * state.stageScale;
    calibrateInputEl.style.left = sx + 'px';
    calibrateInputEl.style.top = (sy - 18) + 'px';
    calibrateInputEl.value = '';
    calibrateInputEl.style.display = 'block';
    calibrateInputEl.focus();
  }

  function commitCalibrate() {
    if (!calibrateInputEl || calibrateInputEl.style.display === 'none') return;
    const meters = parseFloat(calibrateInputEl.value);
    calibrateInputEl.style.display = 'none';
    calibrateInputEl.blur();
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

  function cancelCalibrate() {
    if (calibrateInputEl) { calibrateInputEl.style.display = 'none'; calibrateInputEl.blur(); }
    setState({ calibrating: false, isDrawing: false, drawingPoints: [] });
  }

  function updateSelEl(updates) {
    const id = state.selectedElementId; if (!id) return;
    setState({ elements: state.elements.map(e => e.id === id ? { ...e, ...updates } : e) });
    saveHistory();
  }

  function updateSelPoints(points) {
    const id = state.selectedElementId; if (!id) return;
    setState({ elements: state.elements.map(e => e.id === id ? { ...e, points } : e) });
    saveHistory();
  }

  async function setBackgroundImage(dataUrl, w, h) {
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

  function loadBgImage(dataUrl, w, h) {
    if (!dataUrl) { bgImageObj = null; return; }
    const img = new Image();
    img.onload = () => { bgImageObj = img; render(); };
    img.src = dataUrl;
  }

  // ===================== Export =====================

  function exportPNG() {
    // 计算全部内容（背景图 + 元素）的包围盒，导出完整场景而非仅视口
    let minX = 0, minY = 0, maxX = state.imageWidth || 0, maxY = state.imageHeight || 0;
    state.elements.forEach(el => el.points && el.points.forEach(p => {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }));
    if (maxX <= minX) { maxX = 800; maxY = 600; } // 空场景回退
    const pad = 40;
    const w = Math.round(maxX - minX + pad * 2);
    const h = Math.round(maxY - minY + pad * 2);

    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const savedCtx = ctx;
    ctx = octx; // 复用 drawRoute/drawArea/drawText 等模块级 ctx 引用

    try {
      octx.fillStyle = '#f8f9fa';
      octx.fillRect(0, 0, w, h);
      octx.save();
      octx.translate(-minX + pad, -minY + pad);
      if (bgImageObj && state.bgOpacity > 0) {
        octx.globalAlpha = state.bgOpacity;
        octx.drawImage(bgImageObj, 0, 0, state.imageWidth || bgImageObj.width, state.imageHeight || bgImageObj.height);
        octx.globalAlpha = 1;
      }
      for (const el of state.elements) {
        if (!el.visible) continue;
        octx.save();
        octx.globalAlpha = el.opacity;
        if (el.type === 'route') drawRoute(el);
        else if (el.type === 'area') drawArea(el);
        else if (el.type === 'text') drawText(el);
        octx.restore();
      }
      octx.restore();

      // 图例（左下角）
      const legendEls = state.elements.filter(el => el.visible && (el.type === 'route' || el.type === 'area'));
      if (legendEls.length > 0) {
        const lx = 20, ly = 20, lw = 180;
        const lh = 20 + legendEls.length * 24;
        octx.save();
        octx.fillStyle = 'rgba(0,0,0,0.7)';
        octx.beginPath(); roundRectCtx(octx, lx, ly, lw, Math.max(lh, 40), 8); octx.fill();
        octx.fillStyle = '#fff'; octx.font = 'bold 12px sans-serif'; octx.textAlign = 'left';
        octx.fillText('图例', lx + 12, ly + 18);
        legendEls.forEach((el, i) => {
          const y = ly + 34 + i * 24;
          octx.beginPath(); octx.arc(lx + 16, y, 5, 0, Math.PI * 2); octx.fillStyle = el.color; octx.fill();
          octx.fillStyle = '#ddd'; octx.font = '11px sans-serif';
          octx.fillText(el.name, lx + 30, y + 4);
        });
        octx.textAlign = 'start'; octx.restore();
      }
    } finally {
      ctx = savedCtx; // 恢复主画布上下文
    }

    const link = document.createElement('a');
    link.download = (state.projectName || '场地路线图') + '.png';
    link.href = off.toDataURL('image/png');
    link.click();
    showToast('✅ PNG 已导出');
  }

  function roundRectCtx(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
  }

  function exportSVG() {
    const visEls = state.elements.filter(el => el.visible);
    const iw = state.imageWidth || 800, ih = state.imageHeight || 600;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${iw}" height="${ih}" viewBox="0 0 ${iw} ${ih}">`;
    svg += `<rect width="100%" height="100%" fill="#f8f9fa"/>`;
    if (state.backgroundImage) {
      svg += `<image href="${state.backgroundImage}" width="${iw}" height="${ih}" opacity="${state.bgOpacity}"/>`;
    }
    for (const el of visEls) {
      if (el.type === 'route' && el.points.length >= 2) {
        const d = el.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        svg += `<path d="${d}" stroke="${el.color}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        for (let i = 0; i < el.points.length - 1; i++) {
          const ang = Math.atan2(el.points[i + 1].y - el.points[i].y, el.points[i + 1].x - el.points[i].x);
          const ax = el.points[i + 1].x, ay = el.points[i + 1].y;
          svg += `<polygon points="${ax},${ay} ${ax - 12 * Math.cos(ang - 0.5)},${ay - 12 * Math.sin(ang - 0.5)} ${ax - 12 * Math.cos(ang + 0.5)},${ay - 12 * Math.sin(ang + 0.5)}" fill="${el.color}"/>`;
        }
      } else if (el.type === 'area' && el.points.length >= 3) {
        const d = el.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + 'Z';
        const alphaHex = Math.round(el.opacity * 255).toString(16).padStart(2, '0');
        svg += `<path d="${d}" fill="${el.color}${alphaHex}" stroke="${el.color}" stroke-width="${el.strokeWidth}"/>`;
      } else if (el.type === 'text' && el.points.length > 0) {
        const p = el.points[0], text = el.label || el.name, fs = el.fontSize || 16;
        svg += `<rect x="${p.x - 60}" y="${p.y - fs - 8}" width="120" height="${fs + 16}" rx="6" fill="${el.backgroundColor || DEFAULT_TEXT_BG}"/>`;
        svg += `<text x="${p.x}" y="${p.y - 4}" text-anchor="middle" fill="${el.color}" font-size="${fs}" font-weight="bold">${escXml(text)}</text>`;
      }
    }
    svg += '</svg>';
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = (state.projectName || '场地路线图') + '.svg';
    link.href = url; link.click();
    URL.revokeObjectURL(url);
    showToast('✅ SVG 已导出');
  }

  function escXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ===================== 地理范围（供 3D 主地图展示） =====================

  let defaultCenter = [104.14141, 30.67133];
  let geoConfig = null;
  const GEO_HALF_LNG = 0.002, GEO_HALF_LAT = 0.0014;
  const METERS_PER_DEG_LAT = 111320;

  // 由 center + 每像素米数(mpp) + 图片尺寸 → 等比 nw/se（宽度方向用墨卡托 cos 修正，保证不变形）
  function boundsFromScale(center, mpp, imgW, imgH, rotation) {
    const mPerDegLng = METERS_PER_DEG_LAT * Math.cos(center[1] * Math.PI / 180);
    const dLng = (imgW * mpp) / mPerDegLng;
    const dLat = (imgH * mpp) / METERS_PER_DEG_LAT;
    return {
      center: [center[0], center[1]], metersPerPixel: mpp, rotation: rotation || 0,
      nw: [center[0] - dLng / 2, center[1] + dLat / 2],
      se: [center[0] + dLng / 2, center[1] - dLat / 2],
    };
  }

  // 由现有 nw/se 反推 center + 每像素米数（宽度方向），兼容旧数据 / 从范围取比例尺
  function scaleFromBounds(gb, imgW) {
    const center = gb.center || [(gb.nw[0] + gb.se[0]) / 2, (gb.nw[1] + gb.se[1]) / 2];
    const dLng = gb.se[0] - gb.nw[0];
    const mPerDegLng = METERS_PER_DEG_LAT * Math.cos(center[1] * Math.PI / 180);
    return { center, mpp: (dLng * mPerDegLng) / imgW };
  }

  function defaultGeoBounds() {
    const [clng, clat] = defaultCenter;
    return { nw: [clng - GEO_HALF_LNG, clat + GEO_HALF_LAT], se: [clng + GEO_HALF_LNG, clat - GEO_HALF_LAT] };
  }

  function ensureGeoBounds() {
    if (!state.geoBounds) { state.geoBounds = defaultGeoBounds(); setState({ geoBounds: state.geoBounds }); }
    return state.geoBounds;
  }

  // —— 在地图上点选地理范围（自动获取经纬度） ——
  let _amapPromise = null;
  function loadAmap() {
    if (_amapPromise) return _amapPromise;
    _amapPromise = (async () => {
      if (window.AMap) return window.AMap;
      const cfg = geoConfig || {};
      let key = cfg.amapKey || '';
      let sec = cfg.amapSecurityCode || '';
      // 优先用服务端 .env 注入的高德 Key/安全密钥（高德官方建议：key 不进仓库）
      try {
        const r = await fetch('/api/amap');
        const d = await r.json();
        if (d && d.key) key = d.key;
        if (d && d.securityJsCode) sec = d.securityJsCode;
      } catch (_) { /* 回退到 config.json */ }
      if (sec) window._AMapSecurityConfig = { securityJsCode: sec };
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + key;
        s.onload = () => window.AMap ? resolve() : reject(new Error('AMap 未加载'));
        s.onerror = () => reject(new Error('地图 SDK 加载失败'));
        document.head.appendChild(s);
      });
      return window.AMap;
    })();
    return _amapPromise;
  }

  function showGeoPicker(onPick) {
    const center = (geoConfig && Array.isArray(geoConfig.center) && geoConfig.center.length >= 2) ? geoConfig.center : defaultCenter;
    const zoom = (geoConfig && geoConfig.zoom) || 16;
    const mapStyle = (geoConfig && geoConfig.mapStyle) || 'amap://styles/normal';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="position:relative;width:min(94vw,1100px);height:min(88vh,720px);background:#0d1117;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.5);">
        <div style="padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.08);background:#111827;">
          <span style="font-weight:700;color:#e0e0f0;font-size:0.9rem;">🖱️ 在地图上点选范围</span>
          <span id="geo-pick-hint" style="font-size:0.8rem;color:#9aa;flex:1;"></span>
          <button id="geo-pick-reset" class="toolbar-btn" style="font-size:0.75rem;">重新选点</button>
          <button id="geo-pick-cancel" class="toolbar-btn" style="font-size:0.75rem;">取消</button>
          <button id="geo-pick-ok" class="toolbar-btn primary" style="font-size:0.75rem;" disabled>确定</button>
        </div>
        <div id="geo-pick-map" style="flex:1;min-height:0;"></div>
      </div>`;
    document.body.appendChild(overlay);

    const hint = overlay.querySelector('#geo-pick-hint');
    const okBtn = overlay.querySelector('#geo-pick-ok');
    overlay.querySelector('#geo-pick-cancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    loadAmap().then(AMap => {
      const map = new AMap.Map('geo-pick-map', { viewMode: '2D', center, zoom, mapStyle });
      const pts = [];
      const markers = [];
      let rect = null;
      hint.textContent = '点击地图上的第一个角点（例如左上角）';

      map.on('click', e => {
        if (pts.length >= 2) return;
        pts.push([e.lnglat.getLng(), e.lnglat.getLat()]);
        markers.push(new AMap.Marker({ position: e.lnglat, map }));
        if (pts.length === 1) {
          hint.textContent = '已选第一个角点，请点击第二个角点（例如右下角）';
        } else {
          hint.textContent = '已选两个角点，点「确定」使用此范围';
          const lngs = [pts[0][0], pts[1][0]], lats = [pts[0][1], pts[1][1]];
          const nw = [Math.min(...lngs), Math.max(...lats)];
          const se = [Math.max(...lngs), Math.min(...lats)];
          rect = new AMap.Polygon({ path: [nw, [se[0], nw[1]], se, [nw[0], se[1]]], strokeColor: '#ffd400', strokeWeight: 2, fillColor: '#ffd400', fillOpacity: 0.15, map });
          okBtn.disabled = false;
        }
      });

      overlay.querySelector('#geo-pick-reset').onclick = () => {
        markers.forEach(m => m.setMap(null)); markers.length = 0;
        pts.length = 0;
        if (rect) { rect.setMap(null); rect = null; }
        okBtn.disabled = true;
        hint.textContent = '点击地图上的第一个角点（例如左上角）';
      };
      overlay.querySelector('#geo-pick-ok').onclick = () => {
        if (pts.length < 2) return;
        const lngs = [pts[0][0], pts[1][0]], lats = [pts[0][1], pts[1][1]];
        onPick({ nw: [Math.min(...lngs), Math.max(...lats)], se: [Math.max(...lngs), Math.min(...lats)] });
        overlay.remove();
      };
    }).catch(err => {
      hint.textContent = '❌ ' + err.message;
    });
  }

  // —— 所见即所得对位：底图半透明叠加到地图，点击定位 + 拖手柄微调 + 滑块缩放 ——
  function showGeoAlign(onPick) {
    const imgDataUrl = state.backgroundImage;
    if (!imgDataUrl) { alert('请先导入底图（🖼️ 导入图片）'); return; }
    const imgW = state.imageWidth || 1200;
    const imgH = state.imageHeight || 800;
    const gb = ensureGeoBounds();
    const center0 = [(gb.nw[0] + gb.se[0]) / 2, (gb.nw[1] + gb.se[1]) / 2];
    const width0 = Math.max(gb.se[0] - gb.nw[0], 1e-6);

    const zoom = (geoConfig && geoConfig.zoom) || 16;
    const mapStyle = (geoConfig && geoConfig.mapStyle) || 'amap://styles/normal';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="position:relative;width:min(96vw,1200px);height:min(92vh,780px);background:#0d1117;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.5);">
        <div style="padding:10px 14px;display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(255,255,255,0.08);background:#111827;flex-wrap:wrap;">
          <span style="font-weight:700;color:#e0e0f0;font-size:0.9rem;">🎯 地图对位</span>
          <span id="geo-align-hint" style="font-size:0.76rem;color:#9aa;flex:1;min-width:220px;">点击地图 → 移动中心；拖 🟡 手柄 → 微调；缩放/旋转可拖动或直接输入数值</span>
          <label style="font-size:0.75rem;color:#9aa;display:flex;align-items:center;gap:6px;">底图缩放
            <input id="geo-align-scale" type="range" min="20" max="500" value="100" style="width:100px;accent-color:#3b82f6;" />
            <input id="geo-align-scale-val" type="number" min="20" max="500" value="100" style="width:58px;background:#1f2937;border:1px solid rgba(255,255,255,0.15);color:#e0e0f0;border-radius:4px;padding:2px 4px;font-size:0.72rem;" />%
          </label>
          <label style="font-size:0.75rem;color:#9aa;display:flex;align-items:center;gap:6px;">旋转
            <input id="geo-align-rotate" type="range" min="-180" max="180" value="0" step="0.5" style="width:90px;accent-color:#f59e0b;" />
            <input id="geo-align-rotate-val" type="number" min="-180" max="180" step="0.5" value="0" style="width:58px;background:#1f2937;border:1px solid rgba(255,255,255,0.15);color:#e0e0f0;border-radius:4px;padding:2px 4px;font-size:0.72rem;" />°
          </label>
          <button id="geo-align-reset" class="toolbar-btn" style="font-size:0.75rem;">重置</button>
          <button id="geo-align-cancel" class="toolbar-btn" style="font-size:0.75rem;">取消</button>
          <button id="geo-align-ok" class="toolbar-btn primary" style="font-size:0.75rem;">✅ 确定使用</button>
        </div>
        <div id="geo-align-map" style="flex:1;min-height:0;position:relative;overflow:hidden;">
          <img id="geo-align-img" style="position:absolute;opacity:0.55;pointer-events:none;z-index:30;box-shadow:0 0 0 2px #ffd400;transform-origin:center;" />
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const mapEl = overlay.querySelector('#geo-align-map');
    const img = overlay.querySelector('#geo-align-img');
    const hint = overlay.querySelector('#geo-align-hint');
    const scaleEl = overlay.querySelector('#geo-align-scale');
    const scaleVal = overlay.querySelector('#geo-align-scale-val');
    const rotateEl = overlay.querySelector('#geo-align-rotate');
    const rotateVal = overlay.querySelector('#geo-align-rotate-val');
    img.src = imgDataUrl;

    overlay.querySelector('#geo-align-cancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    loadAmap().then(AMap => {
      const map = new AMap.Map(mapEl, { viewMode: '2D', center: center0, zoom, mapStyle, pitch: 0, rotation: 0 });

      let center = [...center0];
      let widthDeg = width0;
      let rotation = gb.rotation || 0;
      rotateEl.value = rotation; rotateVal.value = rotation;

      // 纬度跨度按图片宽高比 + 墨卡托 cos 修正，保证底图在地图上显示为正确宽高比、不变形
      function heightDeg() {
        return widthDeg * (imgH / imgW) * Math.cos(center[1] * Math.PI / 180);
      }
      function positionImg() {
        const hD = heightDeg();
        const nw = [center[0] - widthDeg / 2, center[1] + hD / 2];
        const se = [center[0] + widthDeg / 2, center[1] - hD / 2];
        const pNW = map.lngLatToContainer(new AMap.LngLat(nw[0], nw[1]));
        const pSE = map.lngLatToContainer(new AMap.LngLat(se[0], se[1]));
        img.style.left = pNW.x + 'px';
        img.style.top = pNW.y + 'px';
        img.style.width = Math.max(1, pSE.x - pNW.x) + 'px';
        img.style.height = Math.max(1, pSE.y - pNW.y) + 'px';
        img.style.transform = 'rotate(' + rotation + 'deg)';
      }

      // 中心手柄（可拖拽，微调平移）
      const centerMarker = new AMap.Marker({
        position: center0,
        draggable: true,
        map,
        zIndex: 40,
        content: '<div style="width:22px;height:22px;border-radius:50%;background:#ffd400;border:3px solid #fff;box-shadow:0 0 10px rgba(0,0,0,0.7);cursor:move;"></div>',
        offset: new AMap.Pixel(-11, -11),
      });
      centerMarker.on('dragging', e => {
        center = [e.lnglat.getLng(), e.lnglat.getLat()];
        positionImg();
      });

      // 点击地图：底图中心直接跳过去（快速定位）
      map.on('click', e => {
        center = [e.lnglat.getLng(), e.lnglat.getLat()];
        centerMarker.setPosition([center[0], center[1]]);
        positionImg();
      });

      // 底图缩放（滑块拖动 / 数字框输入，双向同步）
      const applyScale = v => { widthDeg = width0 * (v / 100); scaleEl.value = v; scaleVal.value = v; positionImg(); };
      scaleEl.addEventListener('input', () => applyScale(Number(scaleEl.value)));
      scaleVal.addEventListener('input', () => applyScale(Math.min(500, Math.max(20, Number(scaleVal.value) || 100))));

      // 底图旋转（滑块拖动 / 数字框输入，双向同步；用于对齐非正北朝向的平面图）
      const applyRotation = v => { rotation = v; rotateEl.value = v; rotateVal.value = v; positionImg(); };
      rotateEl.addEventListener('input', () => applyRotation(Number(rotateEl.value)));
      rotateVal.addEventListener('input', () => applyRotation(Math.min(180, Math.max(-180, Number(rotateVal.value) || 0))));

      overlay.querySelector('#geo-align-reset').onclick = () => {
        center = [...center0]; widthDeg = width0; rotation = gb.rotation || 0;
        scaleEl.value = 100; scaleVal.value = 100;
        rotateEl.value = rotation; rotateVal.value = rotation;
        centerMarker.setPosition([center[0], center[1]]);
        positionImg();
      };

      // 地图移动/缩放后，重新贴底图（底图固定在地理坐标上，跟随地图）
      map.on('moveend', positionImg);
      map.on('zoomend', positionImg);

      overlay.querySelector('#geo-align-ok').onclick = () => {
        const hD = heightDeg();
        onPick({ nw: [center[0] - widthDeg / 2, center[1] + hD / 2], se: [center[0] + widthDeg / 2, center[1] - hD / 2], rotation });
        overlay.remove();
      };

      // 首次定位（地图容器就绪后）
      map.on('complete', positionImg);
      setTimeout(positionImg, 250);
    }).catch(err => {
      hint.textContent = '❌ ' + err.message;
    });
  }

  function showGeoBoundsModal() {
    const gb = ensureGeoBounds();
    const imgW = state.imageWidth || 1200;
    const imgH = state.imageHeight || 800;
    const imgAr = imgW / imgH;
    const midLng = (gb.nw[0] + gb.se[0]) / 2;
    const midLat = (gb.nw[1] + gb.se[1]) / 2;
    const { mpp: curMpp } = scaleFromBounds(gb, imgW);
    const curWM = imgW * curMpp, curHM = imgH * curMpp;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box"><h2>🌐 地理范围</h2>
      <p style="color:#8888aa;font-size:0.8rem;margin-bottom:12px;">设定本方案对应真实地图的经纬度范围与比例尺（1 像素 = 多少米），保存后 3D 主地图按此范围展示线/框/文字，并保持图片宽高比不变形。</p>

      <div style="background:#111827;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-size:0.8rem;font-weight:600;color:#e0e0f0;margin-bottom:8px;">⚡ 真实尺寸标定（推荐）</div>
        <div class="geo-grid">
          <label>中心 经度<input type="number" id="geo-c-lng" step="0.00001" value="${midLng.toFixed(5)}"></label>
          <label>中心 纬度<input type="number" id="geo-c-lat" step="0.00001" value="${midLat.toFixed(5)}"></label>
          <label>实地宽度(米)<input type="number" id="geo-width" step="1" min="1" value="${curWM.toFixed(1)}" placeholder="例如 80"></label>
          <label>实地高度(米)<input type="number" id="geo-height" step="1" min="1" value="${curHM.toFixed(1)}" placeholder="按比例自动"></label>
        </div>
        <div id="geo-scale-readout" style="font-size:0.78rem;color:#8888aa;margin:8px 0;"></div>
        <button class="toolbar-btn primary" id="geo-apply-scale" style="width:100%;justify-content:center;">应用比例尺</button>
      </div>

      <button class="toolbar-btn" id="geo-calibrate" style="width:100%;justify-content:center;">📏 参考线标定（画一段已知长度的线）</button>

      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-panel);">
        <div style="font-size:0.78rem;color:#8888aa;margin-bottom:8px;">手动范围（高级）</div>
        <div class="geo-grid">
          <label>西北角 经度<input type="number" id="geo-nw-lng" step="0.00001" value="${gb.nw[0]}"></label>
          <label>西北角 纬度<input type="number" id="geo-nw-lat" step="0.00001" value="${gb.nw[1]}"></label>
          <label>东南角 经度<input type="number" id="geo-se-lng" step="0.00001" value="${gb.se[0]}"></label>
          <label>东南角 纬度<input type="number" id="geo-se-lat" step="0.00001" value="${gb.se[1]}"></label>
          <label>旋转角度(度)<input type="number" id="geo-rotation" step="0.5" value="${gb.rotation || 0}"></label>
        </div>
        <button class="toolbar-btn" id="geo-align" style="margin-top:12px;width:100%;justify-content:center;">🎯 在地图上对位（拖拽/缩放底图，所见即所得）</button>
        <button class="toolbar-btn" id="geo-pick" style="margin-top:6px;width:100%;justify-content:center;">🖱️ 点选两个角点（备用）</button>
        <div id="geo-distort" style="margin-top:10px;font-size:0.78rem;color:#8888aa;line-height:1.5;"></div>
      </div>

      <div class="actions">
        <button class="toolbar-btn" id="geo-default">恢复默认</button>
        <button class="toolbar-btn" id="geo-cancel">取消</button>
        <button class="toolbar-btn primary" id="geo-save">确定</button>
      </div></div>`;
    document.body.appendChild(overlay);
    const nwLng = overlay.querySelector('#geo-nw-lng'), nwLat = overlay.querySelector('#geo-nw-lat');
    const seLng = overlay.querySelector('#geo-se-lng'), seLat = overlay.querySelector('#geo-se-lat');
    const rotationEl = overlay.querySelector('#geo-rotation');
    const distortEl = overlay.querySelector('#geo-distort');
    const widthEl = overlay.querySelector('#geo-width');
    const heightEl = overlay.querySelector('#geo-height');
    const readoutEl = overlay.querySelector('#geo-scale-readout');

    function readBounds() {
      return {
        nw: [Number(nwLng.value), Number(nwLat.value)],
        se: [Number(seLng.value), Number(seLat.value)],
        rotation: Number(rotationEl.value) || 0,
      };
    }
    function updateDistortHint() {
      const { nw, se } = readBounds();
      if (nw.some(isNaN) || se.some(isNaN) || se[0] <= nw[0] || nw[1] <= se[1]) {
        distortEl.innerHTML = '⚠️ 经纬度范围无效';
        return;
      }
      const dLng = se[0] - nw[0], dLat = nw[1] - se[1];
      const mid = (nw[1] + se[1]) / 2;
      const groundAr = (dLng * Math.cos(mid * Math.PI / 180)) / dLat;
      const ratio = groundAr / imgAr;
      const pct = Math.abs(1 - ratio) * 100;
      if (pct < 1) distortEl.innerHTML = '✅ 经纬度跨度比与图片宽高比一致，无变形';
      else distortEl.innerHTML = `⚠️ 会拉伸变形约 <b>${pct.toFixed(0)}%</b>（地面宽高比 ${groundAr.toFixed(2)} vs 图片 ${imgAr.toFixed(2)}），建议点「应用比例尺」`;
    }
    // 真实尺寸：宽/高按图片比例联动
    function updateScaleReadout() {
      const wM = Number(widthEl.value), hM = Number(heightEl.value);
      if (isFinite(wM) && wM > 0 && isFinite(hM) && hM > 0) {
        const mpp = wM / imgW;
        readoutEl.innerHTML = `每像素 ≈ <b>${(mpp * 100).toFixed(2)} cm</b> · 整图 ≈ 宽 <b>${wM.toFixed(1)} m</b> × 高 <b>${hM.toFixed(1)} m</b>`;
      } else {
        readoutEl.innerHTML = '输入宽度或高度后自动计算比例尺';
      }
    }
    widthEl.addEventListener('input', () => {
      const wM = Number(widthEl.value);
      if (isFinite(wM) && wM > 0) heightEl.value = (wM / imgAr).toFixed(2);
      updateScaleReadout();
    });
    heightEl.addEventListener('input', () => {
      const hM = Number(heightEl.value);
      if (isFinite(hM) && hM > 0) widthEl.value = (hM * imgAr).toFixed(2);
      updateScaleReadout();
    });

    ['geo-nw-lng', 'geo-nw-lat', 'geo-se-lng', 'geo-se-lat'].forEach(id => {
      overlay.querySelector('#' + id).addEventListener('input', updateDistortHint);
    });

    // 应用比例尺：由 center + 宽度 → 等比 nw/se
    overlay.querySelector('#geo-apply-scale').onclick = () => {
      const clng = Number(overlay.querySelector('#geo-c-lng').value);
      const clat = Number(overlay.querySelector('#geo-c-lat').value);
      const wM = Number(widthEl.value) || (Number(heightEl.value) * imgAr);
      if ([clng, clat, wM].some(isNaN) || wM <= 0) { alert('请输入有效的中心与实地宽度/高度'); return; }
      const nb = boundsFromScale([clng, clat], wM / imgW, imgW, imgH, Number(rotationEl.value) || 0);
      nwLng.value = nb.nw[0]; nwLat.value = nb.nw[1]; seLng.value = nb.se[0]; seLat.value = nb.se[1];
      updateDistortHint();
    };

    // 参考线标定：关弹窗 → 画布上画两个点
    overlay.querySelector('#geo-calibrate').onclick = () => {
      overlay.remove();
      startCalibrate();
    };

    overlay.querySelector('#geo-align').onclick = () => {
      showGeoAlign(({ nw, se, rotation }) => {
        nwLng.value = nw[0]; nwLat.value = nw[1]; seLng.value = se[0]; seLat.value = se[1];
        rotationEl.value = rotation || 0;
        updateDistortHint();
      });
    };
    overlay.querySelector('#geo-pick').onclick = () => {
      showGeoPicker(({ nw, se }) => {
        // 点选两角：保持中心 + 宽度，高度按图片比例强制等比（避免拉伸变形）
        const center = [(nw[0] + se[0]) / 2, (nw[1] + se[1]) / 2];
        const { mpp } = scaleFromBounds({ nw, se }, imgW);
        const nb = boundsFromScale(center, mpp, imgW, imgH, Number(rotationEl.value) || 0);
        nwLng.value = nb.nw[0]; nwLat.value = nb.nw[1]; seLng.value = nb.se[0]; seLat.value = nb.se[1];
        updateDistortHint();
      });
    };
    overlay.querySelector('#geo-default').onclick = () => {
      const d = defaultGeoBounds();
      nwLng.value = d.nw[0]; nwLat.value = d.nw[1]; seLng.value = d.se[0]; seLat.value = d.se[1];
      rotationEl.value = 0;
      updateDistortHint();
    };
    overlay.querySelector('#geo-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#geo-save').onclick = () => {
      const nw = [Number(nwLng.value), Number(nwLat.value)];
      const se = [Number(seLng.value), Number(seLat.value)];
      if (nw.some(isNaN) || se.some(isNaN)) { alert('请输入有效经纬度'); return; }
      if (se[0] <= nw[0] || nw[1] <= se[1]) { alert('请确保东南角经度大于西北角经度、西北角纬度大于东南角纬度'); return; }
      const rotation = Number(rotationEl.value) || 0;
      // 归一化：始终存等比范围 + center + 每像素米数（宽度方向为准），保证旋转/比例正确、不变形
      const center = [(nw[0] + se[0]) / 2, (nw[1] + se[1]) / 2];
      const { mpp } = scaleFromBounds({ nw, se, rotation }, imgW);
      const nb = boundsFromScale(center, mpp, imgW, imgH, rotation);
      setState({ geoBounds: nb, geoBoundsExplicit: true });
      overlay.remove();
      showToast('✅ 地理范围与比例尺已设置');
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    updateDistortHint();
    updateScaleReadout();
  }

  // ===================== Save/Load =====================

  function getProjectData() {
    return {
      version: 1, backgroundImage: state.backgroundImage,
      imageWidth: state.imageWidth, imageHeight: state.imageHeight,
      bgOpacity: state.bgOpacity, elements: state.elements,
      projectName: state.projectName, geoBounds: ensureGeoBounds(),
    };
  }

  function loadProjectData(data, floor, building) {
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
    lastSavedAt = null;
    $name.value = data.projectName || '未命名项目';
    updateUI();
  }

  async function saveToServer() {
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
    lastSavedAt = Date.now();
    showToast('✅ 项目已保存到服务器');
    updateSaveStatus();
    loadPlanList();
  }

  async function loadFromServer() {
    const res = await fetch('/api/editor/projects', { headers: authHeaders() });
    const json = await res.json();
    // 过滤掉「地图绘制」方案（kind==='map'），避免与 2D 路线编辑器项目混在一起
    showProjectList((json.data || []).filter(p => !(p.data && p.data.kind === 'map')));
  }

  function showProjectList(projects) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    let html = '<div class="modal-box"><h2>📂 打开项目</h2>';
    if (projects.length === 0) {
      html += '<p style="color:#8888aa;text-align:center;padding:24px;">暂无保存的项目</p>';
    } else {
      projects.forEach(p => {
        html += `<div class="project-row" data-id="${p.id}">
          <span class="name">${esc(p.name)}</span>
          <span class="time">${esc(p.updated_at || '')}</span>
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
  let planListCache = [];
  let overlayPlanElements = {};   // planId -> elements[]（只读叠加图层）
  let overlayPlanIds = new Set(); // 勾选叠加的方案 id
  const OVERLAY_MEMORY_KEY = 'editor_overlay_plans';

  function saveOverlayPlanIds() { try { localStorage.setItem(OVERLAY_MEMORY_KEY, JSON.stringify([...overlayPlanIds])); } catch (_) {} }
  function loadOverlayPlanIds() { try { overlayPlanIds = new Set((JSON.parse(localStorage.getItem(OVERLAY_MEMORY_KEY) || '[]') || []).map(String)); } catch (_) { overlayPlanIds = new Set(); } }

  function removePlanOverlay(id) {
    const changed = overlayPlanIds.delete(String(id)) || !!overlayPlanElements[String(id)];
    if (changed) { delete overlayPlanElements[String(id)]; saveOverlayPlanIds(); render(); }
  }

  async function togglePlanOverlay(p, on) {
    const id = String(p.id);
    if (on) {
      if (overlayPlanElements[id]) return;
      overlayPlanIds.add(id); saveOverlayPlanIds();
      try {
        const res = await fetch('/api/editor/projects/' + p.id, { headers: authHeaders() });
        const json = await res.json();
        const data = json.data && (json.data.data || json.data);
        overlayPlanElements[id] = (data && Array.isArray(data.elements)) ? data.elements : [];
        render();
      } catch (e) {
        console.error('❌ 叠加方案失败', e);
        overlayPlanIds.delete(id); saveOverlayPlanIds();
        renderPlanList();
      }
    } else {
      removePlanOverlay(id);
    }
  }

  async function restoreOverlayPlans() {
    for (const id of overlayPlanIds) {
      if (String(id) === String(state.projectId)) continue;
      if (overlayPlanElements[id]) continue;
      const p = planListCache.find(x => String(x.id) === String(id));
      if (!p) { overlayPlanIds.delete(id); continue; }
      try {
        const res = await fetch('/api/editor/projects/' + id, { headers: authHeaders() });
        const json = await res.json();
        const data = json.data && (json.data.data || json.data);
        overlayPlanElements[id] = (data && Array.isArray(data.elements)) ? data.elements : [];
      } catch (e) { overlayPlanIds.delete(id); }
    }
    render();
  }

  async function loadPlanList() {
    try {
      const res = await fetch('/api/editor/projects', { headers: authHeaders() });
      const json = await res.json();
      planListCache = (json.data || []).filter(p => !(p.data && p.data.kind === 'map'));
    } catch (e) {
      planListCache = [];
    }
    renderPlanList();
    await restoreOverlayPlans();
  }

  function renderPlanList() {
    const box = document.getElementById('plan-list');
    if (!box) return;
    box.innerHTML = '';
    if (!planListCache.length) {
      box.innerHTML = '<div class="empty">暂无室内方案</div>';
      return;
    }
    planListCache.forEach(p => {
      const isCurrent = String(p.id) === String(state.projectId);
      const row = document.createElement('div');
      row.className = 'project-row' + (isCurrent ? ' selected' : '');
      if (isCurrent) {
        const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '✏️'; badge.title = '编辑中';
        row.appendChild(badge);
      } else {
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = overlayPlanIds.has(String(p.id));
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

  function blankProject() {
    setState({
      projectId: null, projectName: '未命名项目', floor: 0, building: '', geoBounds: null, geoBoundsExplicit: false,
      backgroundImage: null, imageWidth: 0, imageHeight: 0, bgOpacity: 1,
      elements: [], selectedElementId: null, selectedElementIds: [],
      stageScale: 1, stagePosition: { x: 0, y: 0 },
    });
    bgImageObj = null; $name.value = '未命名项目'; lastSavedAt = null; resetHistory(); updateUI();
  }

  function getToken() { return localStorage.getItem('admin_token') || null; }
  function authHeaders() { const t = getToken(); return t ? { 'Authorization': 'Bearer ' + t } : {}; }

  function showLoginPrompt(onSuccess) {
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

  function showToast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);z-index:2000;background:#1a1a2e;color:#e0e0f0;padding:8px 20px;border-radius:8px;font-size:0.85rem;border:1px solid #2a2a4e;pointer-events:none;opacity:0;transition:opacity 0.3s;';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
  }

  function updateSaveStatus() {
    const el = document.getElementById('stat-save');
    if (!el) return;
    if (lastSavedAt) {
      el.textContent = '💾 已保存 ' + new Date(lastSavedAt).toLocaleTimeString();
      el.style.color = '#10b981';
    } else {
      el.textContent = '● 未保存';
      el.style.color = '#ffb347';
    }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

  // ===================== UI =====================

  function updateUI() {
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
      `路线:${state.elements.filter(e => e.type === 'route').length} 区域:${state.elements.filter(e => e.type === 'area').length} 文字:${state.elements.filter(e => e.type === 'text').length} | 共${state.elements.length}个`;
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
        <span class="name">${esc(el.name)}</span>
        <button class="${el.visible ? '' : 'off'}" data-action="toggle-vis">👁</button>
        <button class="${el.locked ? '' : 'off'}" data-action="toggle-lock">🔒</button>
      </div>`;
    }
    $layerList.innerHTML = html || '<div style="padding:16px;text-align:center;color:#555577;font-size:0.8rem;">使用工具开始绘制</div>';

    document.getElementById('bg-opacity').value = Math.round(state.bgOpacity * 100);

    updatePropsPanel();
  }

  function updatePropsPanel() {
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
    $textProps.style.display = isText ? '' : 'none';
    document.getElementById('label-stroke').style.display = isText ? 'none' : '';
    document.getElementById('prop-stroke').style.display = isText ? 'none' : '';
    document.getElementById('label-fontsize').style.display = isText ? '' : 'none';
    document.getElementById('prop-fontsize').style.display = isText ? '' : 'none';

    if (isText) {
      document.getElementById('prop-text').value = el.label || '';
      document.getElementById('prop-fontsize').value = el.fontSize || 16;
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

  function updateColorPresets() {
    document.getElementById('color-presets').innerHTML = COLOR_PRESETS.map(c =>
      `<span class="color-preset" style="background:${c}" data-color="${c}" title="${c}"></span>`).join('');
    document.getElementById('text-bg-presets').innerHTML = TEXT_BG_PRESETS.map(c =>
      `<span class="color-preset" style="background:${c}" data-color="${c}" title="${c}"></span>`).join('');
  }

  // ===================== Mouse/Touch =====================

  let dragState = null;
  let boxSelectState = null;

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
      dragState = { type: 'pan', sx: pos.clientX, sy: pos.clientY, sp: { ...state.stagePosition } };
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

    // Select mode
    const hit = hitTest(world.x, world.y);
    if (hit && hit.__vertex !== undefined) {
      selectElement(hit.element);
      dragState = { type: 'vertex', eid: hit.element.id, nidx: hit.__vertex, spts: JSON.parse(JSON.stringify(hit.element.points)) };
      return;
    }
    if (hit && hit.id) {
      selectElement(hit);
      if (!hit.locked) dragState = { type: 'element', eid: hit.id, sw: world, spts: JSON.parse(JSON.stringify(hit.points)) };
    } else {
      selectElement(null);
      boxSelectState = { x: world.x, y: world.y, w: 0, h: 0 };
    }
  });

  canvasWrap.addEventListener('pointermove', (e) => {
    e.preventDefault();
    const pos = getEventPos(e);
    const world = fromCanvas(pos.rx, pos.ry);
    setState({ mousePos: world });
    document.getElementById('stat-pos').textContent = `X:${Math.round(world.x)} Y:${Math.round(world.y)}`;

    if (dragState && dragState.type === 'pan') {
      setState({ stagePosition: { x: dragState.sp.x + (pos.clientX - dragState.sx), y: dragState.sp.y + (pos.clientY - dragState.sy) } });
      return;
    }
    if (dragState && dragState.type === 'vertex') {
      const el = state.elements.find(e => e.id === dragState.eid); if (!el) return;
      const np = [...el.points]; np[dragState.nidx] = { x: snap(world.x), y: snap(world.y) };
      // 直接 setState，避免每次 pointermove 都写入历史（历史刷爆）
      setState({ elements: state.elements.map(e => e.id === dragState.eid ? { ...e, points: np } : e) });
      return;
    }
    if (dragState && dragState.type === 'element') {
      const dx = world.x - dragState.sw.x, dy = world.y - dragState.sw.y;
      const np = dragState.spts.map(p => ({ x: p.x + dx, y: p.y + dy }));
      setState({ elements: state.elements.map(e => e.id === dragState.eid ? { ...e, points: np } : e) });
      return;
    }
    if (boxSelectState) { boxSelectState.w = world.x - boxSelectState.x; boxSelectState.h = world.y - boxSelectState.y; }
  });

  canvasWrap.addEventListener('pointerup', (e) => {
    e.preventDefault();
    canvasWrap.classList.remove('panning');

    if (boxSelectState) {
      const bx = boxSelectState.w < 0 ? boxSelectState.x + boxSelectState.w : boxSelectState.x;
      const by = boxSelectState.h < 0 ? boxSelectState.y + boxSelectState.h : boxSelectState.y;
      const bw = Math.abs(boxSelectState.w), bh = Math.abs(boxSelectState.h);
      if (bw > 5 || bh > 5) {
        const ids = [];
        for (const el of state.elements) {
          if (!el.visible) continue;
          if (el.points.every(p => p.x >= bx && p.x <= bx + bw && p.y >= by && p.y <= by + bh)) ids.push(el.id);
        }
        if (ids.length > 0) setState({ selectedElementIds: ids, selectedElementId: ids[0] });
      }
      boxSelectState = null;
    }

    if (dragState && (dragState.type === 'element' || dragState.type === 'vertex')) saveHistory();
    dragState = null;
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
    if (k === 'escape') { setState({ isDrawing: false, drawingPoints: [], currentTool: 'select' }); updateToolBtns(); }
    if (k === 'enter' && state.isDrawing) { finishDrawing(); }
    if (k === '?' && !ctrl) { document.getElementById('btn-shortcuts').click(); }
  });

  function updateToolBtns() {
    document.querySelectorAll('#toolbar button').forEach(b => { b.classList.toggle('active', b.dataset.tool === state.currentTool); });
  }

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
    bgImageObj = null; $name.value = '未命名项目'; lastSavedAt = null; resetHistory(); updateUI();
  });
  document.getElementById('btn-geo').addEventListener('click', showGeoBoundsModal);

  // 批量导入：粘贴建筑清单 JSON，一键生成每栋 × 每层的方案骨架
  function showBatchImport() {
    const token = getToken();
    if (!token) { showLoginPrompt(() => showBatchImport()); return; }
    const example = JSON.stringify([
      { name: '会展中心主馆', center: [104.0636, 30.6725], widthM: 80, heightM: 60, rotation: 0, floors: [1, 2, 3, 4, 5] }
    ], null, 2);
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
        const res = await fetch('/api/editor/projects/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify(payload) });
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

  // ===================== Ruler Rendering =====================
  const rulerTopCanvas = document.getElementById('ruler-top-canvas');
  const rulerLeftCanvas = document.getElementById('ruler-left-canvas');
  const rulerTopCtx = rulerTopCanvas.getContext('2d');
  const rulerLeftCtx = rulerLeftCanvas.getContext('2d');

  function renderRulers() {
    const cw = canvasWrap.clientWidth;
    const ch = canvasWrap.clientHeight;
    const tw = rulerTopCanvas.parentElement.clientWidth;
    const lh = rulerLeftCanvas.parentElement.clientHeight;

    // Top ruler
    if (rulerTopCanvas.width !== tw || rulerTopCanvas.height !== 20) {
      rulerTopCanvas.width = tw; rulerTopCanvas.height = 20;
    }
    rulerTopCtx.clearRect(0, 0, tw, 20);
    rulerTopCtx.fillStyle = '#1a1a2e';
    rulerTopCtx.fillRect(0, 0, tw, 20);

    const gs = state.gridSize * state.stageScale;
    const offsetX = state.stagePosition.x % gs;
    rulerTopCtx.fillStyle = '#8888aa';
    rulerTopCtx.font = '9px monospace';
    rulerTopCtx.textAlign = 'center';
    for (let x = offsetX; x < tw; x += gs) {
      const worldX = Math.round((x - state.stagePosition.x) / state.stageScale / state.gridSize) * state.gridSize;
      rulerTopCtx.fillRect(x - 0.5, 14, 1, 6);
      if (gs > 30) rulerTopCtx.fillText(worldX, x, 10);
    }

    // Left ruler
    if (rulerLeftCanvas.width !== 20 || rulerLeftCanvas.height !== lh) {
      rulerLeftCanvas.width = 20; rulerLeftCanvas.height = lh;
    }
    rulerLeftCtx.clearRect(0, 0, 20, lh);
    rulerLeftCtx.fillStyle = '#1a1a2e';
    rulerLeftCtx.fillRect(0, 0, 20, lh);

    const offsetY = state.stagePosition.y % gs;
    rulerLeftCtx.fillStyle = '#8888aa';
    rulerLeftCtx.font = '9px monospace';
    rulerLeftCtx.textAlign = 'right';
    for (let y = offsetY; y < lh; y += gs) {
      const worldY = Math.round((y - state.stagePosition.y) / state.stageScale / state.gridSize) * state.gridSize;
      rulerLeftCtx.fillRect(14, y - 0.5, 6, 1);
      if (gs > 30) {
        rulerLeftCtx.save();
        rulerLeftCtx.translate(8, y);
        rulerLeftCtx.rotate(-Math.PI / 2);
        rulerLeftCtx.fillText(String(worldY), 0, 0);
        rulerLeftCtx.restore();
      }
    }
  }

  // ===================== Ruler Drag =====================
  let rulerDragState = null;

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
    rulerDragState = { orientation: 'horizontal', startWorldPos: worldY };
    addGuideLine('horizontal', worldY);
  });

  document.getElementById('ruler-left').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = rulerLeftCanvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left + rect.width;
    const worldX = (screenX - state.stagePosition.x) / state.stageScale;
    rulerDragState = { orientation: 'vertical', startWorldPos: worldX };
    addGuideLine('vertical', worldX);
  });

  // Global move for ruler drag — update last guide line position
  document.addEventListener('pointermove', (e) => {
    if (!rulerDragState || state.guideLines.length === 0) return;
    const last = state.guideLines[state.guideLines.length - 1];
    let worldPos;
    if (rulerDragState.orientation === 'horizontal') {
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
    rulerDragState = null;
  });

  // ===================== Flow Animation Loop =====================
  let flowOffset = 0;
  function animateFlow() {
    flowOffset += 0.5;
    if (flowOffset > 20) flowOffset = 0;
    if (state.elements.some(e => e.type === 'route' && e.visible)) render();
    requestAnimationFrame(animateFlow);
  }
  requestAnimationFrame(animateFlow);

  // ===================== Init =====================

  let counter = 0;
  function genId() { return 'el_' + Date.now() + '_' + (++counter); }

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
      geoConfig = cfg.geo;
      if (Array.isArray(cfg.geo.center) && cfg.geo.center.length >= 2) {
        defaultCenter = cfg.geo.center;
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
        loadProjectData(json.data.data || json.data);
        showToast('✅ 已加载项目：' + (state.projectName || ('方案 ' + id)));
        loadPlanList();
      }
    }).catch(() => {});
  })();

  // ===================== API =====================
  window.editorAPI = { getState: () => state, loadProject: loadProjectData, getProject: getProjectData, render };
})();
