// ============================================================
// editor-export.js — PNG / SVG 导出
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// ============================================================
import { state, ctx, setCtx, showToast, DEFAULT_TEXT_BG } from './editor-state.js';
import { roundRectCtx, escXml } from './editor-geometry.js';
import { drawRoute, drawArea, drawText } from './editor-canvas.js';

export function exportPNG() {
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
  setCtx(octx); // 复用 drawRoute/drawArea/drawText 等模块级 ctx 引用

  try {
    octx.fillStyle = '#f8f9fa';
    octx.fillRect(0, 0, w, h);
    octx.save();
    octx.translate(-minX + pad, -minY + pad);
    if (state.bgImageObj && state.bgOpacity > 0) {
      octx.globalAlpha = state.bgOpacity;
      octx.drawImage(state.bgImageObj, 0, 0, state.imageWidth || state.bgImageObj.width, state.imageHeight || state.bgImageObj.height);
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
    setCtx(savedCtx); // 恢复主画布上下文
  }

  const link = document.createElement('a');
  link.download = (state.projectName || '场地路线图') + '.png';
  link.href = off.toDataURL('image/png');
  link.click();
  showToast('✅ PNG 已导出');
}

export function exportSVG() {
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
