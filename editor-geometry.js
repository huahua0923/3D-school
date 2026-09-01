// ============================================================
// editor-geometry.js — 几何纯函数 + 地理范围换算
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// ============================================================
import { state, setState } from './editor-state.js';

// ===================== Helpers =====================

export function roundRect(c, x, y, w, h, r) {
  c.moveTo(x + r, y); c.lineTo(x + w - r, y);
  c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r);
  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);
  c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r);
  c.arcTo(x, y, x + r, y, r);
}

export function computePolygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return area / 2;
}

export function pointNearSegment(px, py, a, b, threshold) {
  const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - a.x, py - a.y) < threshold;
  let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)) < threshold;
}

export function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if ((pts[i].y > py) !== (pts[j].y > py) &&
        px < (pts[j].x - pts[i].x) * (py - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside;
  }
  return inside;
}

// ===================== 地理范围（供 3D 主地图展示） =====================

const GEO_HALF_LNG = 0.002, GEO_HALF_LAT = 0.0014;
const METERS_PER_DEG_LAT = 111320;

// 由 center + 每像素米数(mpp) + 图片尺寸 → 等比 nw/se（宽度方向用墨卡托 cos 修正，保证不变形）
export function boundsFromScale(center, mpp, imgW, imgH, rotation) {
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
export function scaleFromBounds(gb, imgW) {
  const center = gb.center || [(gb.nw[0] + gb.se[0]) / 2, (gb.nw[1] + gb.se[1]) / 2];
  const dLng = gb.se[0] - gb.nw[0];
  const mPerDegLng = METERS_PER_DEG_LAT * Math.cos(center[1] * Math.PI / 180);
  return { center, mpp: (dLng * mPerDegLng) / imgW };
}

export function defaultGeoBounds() {
  const [clng, clat] = state.defaultCenter;
  return { nw: [clng - GEO_HALF_LNG, clat + GEO_HALF_LAT], se: [clng + GEO_HALF_LNG, clat - GEO_HALF_LAT] };
}

export function ensureGeoBounds() {
  if (!state.geoBounds) { state.geoBounds = defaultGeoBounds(); setState({ geoBounds: state.geoBounds }); }
  return state.geoBounds;
}

// ===================== Export 辅助 =====================

export function roundRectCtx(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
}

export function escXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
