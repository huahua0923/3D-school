// ========================================================
// coords.js — 坐标换算 + 底图旋转烘焙（纯函数，无 DOM 副作用）
// ========================================================
import { state, PLAN_HALF_LNG, PLAN_HALF_LAT } from './state.js';

export const METERS_PER_DEG_LAT = 111320;

/** 本地坐标 (meters from center) → 经纬度 */
export function localToLngLat(localX, localZ, center) {
    const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180);
    return [center[0] + localX / metersPerDegLng, center[1] + localZ / METERS_PER_DEG_LAT];
}

/** 经纬度 → 本地坐标 (meters from center)，localToLngLat 的逆运算 */
export function lngLatToLocal(lng, lat, center) {
    const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180);
    return [(lng - center[0]) * metersPerDegLng, (lat - center[1]) * METERS_PER_DEG_LAT];
}

function planPointToLngLat(x, y, bounds, areaW, areaH) {
    const rot = bounds.rotation || 0;
    let px = x, py = y;
    if (rot) {
        // 底图旋转对位：像素绕图片中心顺时针旋转（与编辑器 CSS rotate 一致），再线性投影到经纬度
        const rad = rot * Math.PI / 180;
        const dx = x - areaW / 2, dy = y - areaH / 2;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        px = areaW / 2 + (dx * cos - dy * sin);
        py = areaH / 2 + (dx * sin + dy * cos);
    }
    const lng = bounds.nw[0] + (px / areaW) * (bounds.se[0] - bounds.nw[0]);
    const lat = bounds.nw[1] + (py / areaH) * (bounds.se[1] - bounds.nw[1]);
    return [lng, lat];
}

// 旋转后四角的轴对齐外接 bounds（供 ImageLayer 使用）
function rotatedBounds(bounds, areaW, areaH) {
    const rot = bounds.rotation || 0;
    if (!rot) return bounds;
    const corners = [[0, 0], [areaW, 0], [areaW, areaH], [0, areaH]];
    const lls = corners.map(c => planPointToLngLat(c[0], c[1], bounds, areaW, areaH));
    const lngs = lls.map(p => p[0]), lats = lls.map(p => p[1]);
    return { nw: [Math.min(...lngs), Math.max(...lats)], se: [Math.max(...lngs), Math.min(...lats)] };
}

// 把底图旋转 rotation 度烘焙成新图（轴对齐外接矩形，四角透明）
function bakeRotatedImage(dataUrl, w, h, rotation) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const rad = rotation * Math.PI / 180;
            const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
            const bw = Math.max(1, Math.ceil(w * cos + h * sin));
            const bh = Math.max(1, Math.ceil(w * sin + h * cos));
            const canvas = document.createElement('canvas');
            canvas.width = bw; canvas.height = bh;
            const ctx = canvas.getContext('2d');
            ctx.translate(bw / 2, bh / 2);
            ctx.rotate(rad);
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('底图加载失败'));
        img.src = dataUrl;
    });
}

// 方框旋转：bounds（西南/东北角）绕中心顺时针旋转，返回 4 顶点
function rectCorners(bounds, rotation) {
    const sw = bounds[0], ne = bounds[1];
    const cx = (sw[0] + ne[0]) / 2, cy = (sw[1] + ne[1]) / 2;
    const hl = (ne[0] - sw[0]) / 2, hla = (ne[1] - sw[1]) / 2;
    const corners = [[cx - hl, cy - hla], [cx + hl, cy - hla], [cx + hl, cy + hla], [cx - hl, cy + hla]];
    if (!rotation) return corners;
    const rad = rotation * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const mLng = 111320 * Math.cos(cy * Math.PI / 180);
    return corners.map(([lng, lat]) => {
        const dx = (lng - cx) * mLng, dy = (lat - cy) * 111320;
        const dx2 = dx * cos + dy * sin, dy2 = -dx * sin + dy * cos;
        return [cx + dx2 / mLng, cy + dy2 / 111320];
    });
}

// 方案默认地理 bounds（未配置 geoBounds 时回退到地图中心附近）
export function defaultPlanBounds(center) {
    const [clng, clat] = center || (state.CONFIG.geo ? state.CONFIG.geo.center : [104.14141, 30.67133]);
    return { nw: [clng - PLAN_HALF_LNG, clat + PLAN_HALF_LAT], se: [clng + PLAN_HALF_LNG, clat - PLAN_HALF_LAT] };
}

// 供室内方案 / 搜索 / 底图对齐使用（内部函数转导出）
export { planPointToLngLat, rotatedBounds, bakeRotatedImage, rectCorners };
