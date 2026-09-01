// ============================================================
// editor-canvas.js — Canvas 渲染 + 标尺 + 流光动画 + 底图加载
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// ============================================================
import {
  state, ctx, canvas, canvasWrap,
  rulerTopCanvas, rulerLeftCanvas, rulerTopCtx, rulerLeftCtx,
  DEFAULT_ROUTE_COLOR, DEFAULT_AREA_COLOR, DEFAULT_TEXT_COLOR, DEFAULT_TEXT_BG, DEFAULT_STAIR_COLOR,
} from './editor-state.js';
import { roundRect, computePolygonArea } from './editor-geometry.js';

// 底图背景色用到的 hexToRgba 来自 shared.js 全局（<script src="shared.js">）

export function render() {
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
  if (state.bgImageObj && state.bgOpacity > 0) {
    ctx.globalAlpha = state.bgOpacity;
    ctx.drawImage(state.bgImageObj, 0, 0, state.imageWidth || state.bgImageObj.width, state.imageHeight || state.bgImageObj.height);
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
  for (const pid in state.overlayPlanElements) {
    for (const el of state.overlayPlanElements[pid]) { if (el.visible !== false) drawOverlayElement(el); }
  }

  // Drawing preview
  if (state.isDrawing && state.drawingPoints.length > 0) drawDrawingPreview();

  // Box select
  if (state.boxSelectState) {
    const s = state.boxSelectState;
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
  else if (el.type === 'stair') drawStair(el);
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
  } else if (el.type === 'stair') {
    const p = el.points[0]; if (!p) { ctx.restore(); return; }
    ctx.fillStyle = 'rgba(156,163,175,0.5)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export function drawRoute(el) {
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

export function drawArea(el) {
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

export function drawText(el) {
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

function drawStair(el) {
  const p = el.points[0]; if (!p) return;
  const r = 7;
  // 菱形标记（旋转 45° 的方块）
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = el.color || DEFAULT_STAIR_COLOR;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - r * 1.15);
  ctx.lineTo(p.x + r * 1.15, p.y);
  ctx.lineTo(p.x, p.y + r * 1.15);
  ctx.lineTo(p.x - r * 1.15, p.y);
  ctx.closePath();
  ctx.stroke();
  // 楼梯名标注
  if (el.name) {
    ctx.font = '11px "Inter","PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#111';
    ctx.textBaseline = 'bottom';
    ctx.fillText(el.name, p.x + 12, p.y - 4);
  }
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

export function loadBgImage(dataUrl, w, h) {
  if (!dataUrl) { state.bgImageObj = null; return; }
  const img = new Image();
  img.onload = () => { state.bgImageObj = img; render(); };
  img.src = dataUrl;
}

// ===================== Ruler Rendering =====================

export function renderRulers() {
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

// ===================== Flow Animation Loop =====================
let flowOffset = 0;
export function animateFlow() {
  flowOffset += 0.5;
  if (flowOffset > 20) flowOffset = 0;
  if (state.elements.some(e => e.type === 'route' && e.visible)) render();
  requestAnimationFrame(animateFlow);
}
