// ========================================================
// flow.js — 流动虚线层 + 路线引导动画 + 水波纹扩散
// 流动虚线：Canvas 覆盖地图，lineDashOffset 滚动（严格贴合 2D 折线）
// 引导动画：发光点沿路线匀速滑动；水波纹：独立 Canvas 覆盖层 rAF 平滑扩散
// ========================================================
import { state } from './state.js';
import { METERS_PER_DEG_LAT } from './coords.js';

const GUIDE_DURATION = 6;           // 完整走完一条路线所需秒数

// 水波纹常量
const RIPPLE_PERIOD = 1800;       // 一圈扩散的周期（ms）
const RIPPLE_MAX_R_M = 60;        // 最大扩散半径（米，贴地）
const RIPPLE_RINGS = 3;           // 同时存在的圈数
const RIPPLE_SEGMENTS = 24;       // 每圈采样点数（地面圆投影成椭圆）
const RIPPLE_GLOW_R_M = 16;       // 中心光晕半径（米，贴地）
const RIPPLE_GLOW_ALPHA = 0.25;   // 光晕中心不透明度
const RIPPLE_BEAM_PX = 90;        // 光柱基准高度（px，随俯仰缩短）

export function initFlowLayer(map) {
    if (state.flowCanvas) return;
    const container = document.getElementById('map-container');
    if (!container) return;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:10;';
    container.appendChild(canvas);
    state.flowCanvas = canvas;
    state.flowCtx = canvas.getContext('2d');
    resizeFlowLayer();
    requestAnimationFrame((t) => animateFlow(map, t));
}

export function resizeFlowLayer() {
    if (!state.flowCanvas) return;
    const container = document.getElementById('map-container');
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth, h = container.clientHeight;
    state.flowCanvas.width = Math.round(w * dpr);
    state.flowCanvas.height = Math.round(h * dpr);
    state.flowCanvas.style.width = w + 'px';
    state.flowCanvas.style.height = h + 'px';
    state.flowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function addFlowRoute(id, pts, color, width, _speed, _direction) {
    removeFlowRoute(id);
    if (!state.planMap) return;
    // 路线虚线统一用高德原生 Polyline（自投影精确贴线，根治 lngLatToContainer 在 3D 高 zoom 下的错位）
    // _speed/_direction 仅保留签名以兼容旧调用，原生虚线为静态样式，不再做 Canvas 滚动动画
    const polyline = new AMap.Polyline({
        path: pts.map(p => new AMap.LngLat(p[0], p[1])),
        strokeColor: colorToHex(color, '#3b82f6'),
        strokeWeight: width || 3,
        strokeStyle: 'dashed',
        strokeOpacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 9,   // 低于透明点击线(10)，避免吞掉路线点击
    });
    polyline.setMap(state.hideRoutes ? null : state.planMap);
    state.flowPolylines[id] = polyline;
    state.routeOverlays.push(polyline);   // 加入「隐藏路线」开关统一控制显隐
}

export function removeFlowRoute(id) {
    const p = state.flowPolylines[id];
    if (p) {
        const i = state.routeOverlays.indexOf(p);
        if (i >= 0) state.routeOverlays.splice(i, 1);
        try { p.setMap(null); } catch (_) {}
        delete state.flowPolylines[id];
    }
}

function drawFlowLayer(map) {
    if (!state.flowCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = state.flowCanvas.width / dpr, h = state.flowCanvas.height / dpr;
    state.flowCtx.clearRect(0, 0, w, h);
    drawGuide(map);   // 引导光点：最上层，独立于「隐藏路线」开关
}

function animateFlow(map, now) {
    if (state.flowLastT) {
        const dt = Math.min((now - state.flowLastT) / 1000, 0.1);
        if (state.guide) {
            state.guide.t += dt / GUIDE_DURATION;
            if (state.guide.t >= 1) {
                state.guide = null;           // 走完全程自动清除
                drawFlowLayer(map);     // 立即清屏，避免光点残留
            } else if (state.guideFollow) {
                // 漫游跟随：相机沿路线平滑跟随移动点（官方 moveAlong 语义，这里用 map.setCenter 逐帧同步）
                const p = pathPointAt(state.guide.pts, state.guide.t, state.guide.cum);
                if (p) map.setCenter([p[0], p[1]]);
            }
        }
    }
    state.flowLastT = now;
    if (state.guide) drawFlowLayer(map);   // 无引导光点时跳过 Canvas 重绘（静止零开销）
    requestAnimationFrame((t) => animateFlow(map, t));
}

// —— 路线引导动画：折线弧长参数化 + 发光点绘制 ——
// 预计算折线各顶点累计弧长（guide 的 pts 固定，仅算一次，消除每帧 O(n) distance 累加）
function computeArcLengths(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + AMap.GeometryUtil.distance([pts[i - 1][0], pts[i - 1][1]], [pts[i][0], pts[i][1]]));
    }
    return cum;   // cum[i] = 起点到第 i 点的累计弧长，cum[last] = 总长
}

// 按弧长比例 t∈[0,1] 取折线上的点（复用预计算的累计弧长，匀速滑过整条路线）
function pathPointAt(pts, t, cum) {
    if (!pts || !pts.length) return null;
    if (pts.length === 1) return [pts[0][0], pts[0][1]];
    if (!cum) cum = computeArcLengths(pts);
    const total = cum[cum.length - 1];
    if (total <= 0) return [pts[0][0], pts[0][1]];
    const target = Math.max(0, Math.min(1, t)) * total;
    for (let i = 1; i < pts.length; i++) {
        if (cum[i] >= target) {
            const seg = cum[i] - cum[i - 1];
            const k = seg > 0 ? (target - cum[i - 1]) / seg : 0;
            return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
        }
    }
    return [pts[pts.length - 1][0], pts[pts.length - 1][1]];
}

export function startGuide(pts, color, name) {
    if (!pts || pts.length < 2) return;
    const gpts = pts.map(p => [p[0], p[1]]);
    state.guide = { pts: gpts, color: colorToHex(color, '#f59e0b'), t: 0, cum: computeArcLengths(gpts) };
    toast('✨ 路线引导中' + (name ? '：' + name : ''));
}

// 在流动层画一个发光点（白心 + 颜色光环 + 渐隐拖尾），沿路线滑动
function drawGuide(map) {
    if (!state.flowCtx || !state.guide || !state.guide.pts) return;
    const pt = pathPointAt(state.guide.pts, state.guide.t, state.guide.cum);
    if (!pt) return;
    const c = map.lngLatToContainer(new AMap.LngLat(pt[0], pt[1]));
    if (!c) return;
    state.flowCtx.globalCompositeOperation = 'lighter';   // 加法混合，让光点更亮
    // 拖尾：沿路向后采样几个点，渐隐缩小
    const TRAIL = 7;
    for (let i = 1; i <= TRAIL; i++) {
        const tt = state.guide.t - i * 0.015;
        if (tt < 0) break;
        const tp = pathPointAt(state.guide.pts, tt, state.guide.cum);
        if (!tp) continue;
        const tc = map.lngLatToContainer(new AMap.LngLat(tp[0], tp[1]));
        if (!tc) continue;
        const k = 1 - i / (TRAIL + 1);
        const rad = 2 + 9 * k;
        const g = state.flowCtx.createRadialGradient(tc.x, tc.y, 0, tc.x, tc.y, rad);
        g.addColorStop(0, hexToRgba(state.guide.color, 0.45 * k));
        g.addColorStop(1, hexToRgba(state.guide.color, 0));
        state.flowCtx.fillStyle = g;
        state.flowCtx.beginPath();
        state.flowCtx.arc(tc.x, tc.y, rad, 0, Math.PI * 2);
        state.flowCtx.fill();
    }
    // 主光点：白心 + 颜色光环
    const head = state.flowCtx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 14);
    head.addColorStop(0, 'rgba(255,255,255,0.95)');
    head.addColorStop(0.35, hexToRgba(state.guide.color, 0.85));
    head.addColorStop(1, hexToRgba(state.guide.color, 0));
    state.flowCtx.fillStyle = head;
    state.flowCtx.beginPath();
    state.flowCtx.arc(c.x, c.y, 14, 0, Math.PI * 2);
    state.flowCtx.fill();
    state.flowCtx.globalCompositeOperation = 'source-over';
}

// —— 水波纹扩散：独立 Canvas 覆盖层，用 rAF 平滑画扩散圆环（不用 Loca setStyle，避免闪）——
export function initRippleLayer(map) {
    if (state.rippleCanvas) return;
    const container = document.getElementById('map-container');
    if (!container) return;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:10;';
    container.appendChild(canvas);
    state.rippleCanvas = canvas;
    state.rippleCtx = canvas.getContext('2d');
    resizeRippleLayer();
    requestAnimationFrame((t) => animateRipple(map, t));
}

export function resizeRippleLayer() {
    if (!state.rippleCanvas) return;
    const container = document.getElementById('map-container');
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth, h = container.clientHeight;
    state.rippleCanvas.width = Math.round(w * dpr);
    state.rippleCanvas.height = Math.round(h * dpr);
    state.rippleCanvas.style.width = w + 'px';
    state.rippleCanvas.style.height = h + 'px';
    state.rippleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 把以 (lng,lat) 为中心、地面半径 Rm 的圆采样成屏幕折线路径，3D 俯仰/旋转下自然压成椭圆
function projectGroundEllipse(map, lng, lat, Rm, dLatPerM, dLngPerM) {
    const path = new Path2D();
    let started = false;
    for (let s = 0; s < RIPPLE_SEGMENTS; s++) {
        const th = (s / RIPPLE_SEGMENTS) * Math.PI * 2;
        const c = map.lngLatToContainer(new AMap.LngLat(
            lng + Rm * dLngPerM * Math.cos(th),
            lat + Rm * dLatPerM * Math.sin(th)
        ));
        if (!c) continue;
        if (!started) { path.moveTo(c.x, c.y); started = true; }
        else path.lineTo(c.x, c.y);
    }
    if (!started) return null;
    path.closePath();
    return path;
}

function drawRipple(map, now) {
    if (!state.rippleCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = state.rippleCanvas.width / dpr, h = state.rippleCanvas.height / dpr;
    state.rippleCtx.clearRect(0, 0, w, h);
    if (!state.rippleOn || !state.ripplePoints.length) return;
    state.rippleCtx.globalCompositeOperation = 'lighter';   // 加法混合：重叠发光互相叠亮
    state.rippleCtx.lineWidth = 2.5;
    for (const p of state.ripplePoints) {
        // 地面半径 → 经纬度偏移（经度方向除以 cos(lat) 做球面修正）
        const cosLat = Math.cos(p.lat * Math.PI / 180);
        const dLatPerM = 1 / METERS_PER_DEG_LAT;
        const dLngPerM = 1 / (METERS_PER_DEG_LAT * cosLat);
        const c0 = map.lngLatToContainer(new AMap.LngLat(p.lng, p.lat));
        if (!c0) continue;

        // 屏幕尺度：光晕半径对应的像素，光晕和光柱都按它定大小
        const ce = map.lngLatToContainer(new AMap.LngLat(p.lng + RIPPLE_GLOW_R_M * dLngPerM, p.lat));
        const gradR = ce ? Math.hypot(ce.x - c0.x, ce.y - c0.y) : RIPPLE_GLOW_R_M;

        // 中心光晕：软径向渐变填充贴地椭圆，让标记点有发光感（无硬点）
        const glow = projectGroundEllipse(map, p.lng, p.lat, RIPPLE_GLOW_R_M, dLatPerM, dLngPerM);
        if (glow) {
            const grad = state.rippleCtx.createRadialGradient(c0.x, c0.y, 0, c0.x, c0.y, gradR);
            grad.addColorStop(0, hexToRgba(p.color, RIPPLE_GLOW_ALPHA));
            grad.addColorStop(1, hexToRgba(p.color, 0));
            state.rippleCtx.fillStyle = grad;
            state.rippleCtx.fill(glow);
        }

        // 光柱：从标记点向上的一道竖向光束（加法混合，顶部渐隐，俯仰越大越矮）
        const pitch = (typeof map.getPitch === 'function') ? map.getPitch() : 55;
        const beamH = RIPPLE_BEAM_PX * (0.35 + 0.65 * Math.cos(pitch * Math.PI / 180));
        if (beamH > 8) {
            const halfW = Math.max(3, gradR * 0.18);
            const bg = state.rippleCtx.createLinearGradient(0, c0.y - beamH, 0, c0.y);
            bg.addColorStop(0, hexToRgba(p.color, 0));
            bg.addColorStop(0.72, hexToRgba(p.color, 0.16));
            bg.addColorStop(1, hexToRgba(p.color, 0.38));
            state.rippleCtx.fillStyle = bg;
            state.rippleCtx.beginPath();
            state.rippleCtx.moveTo(c0.x - halfW, c0.y);
            state.rippleCtx.lineTo(c0.x + halfW, c0.y);
            state.rippleCtx.lineTo(c0.x, c0.y - beamH);
            state.rippleCtx.closePath();
            state.rippleCtx.fill();
        }

        // 扩散圆环
        for (let i = 0; i < RIPPLE_RINGS; i++) {
            const t = ((now / RIPPLE_PERIOD) + i / RIPPLE_RINGS) % 1;   // 0..1
            const R = RIPPLE_MAX_R_M * t;
            const alpha = 0.75 * Math.sin(Math.PI * t);                  // 平滑淡入淡出
            if (R < 1) continue;                                         // 刚冒出时太小不画
            const ring = projectGroundEllipse(map, p.lng, p.lat, R, dLatPerM, dLngPerM);
            if (!ring) continue;
            state.rippleCtx.strokeStyle = hexToRgba(p.color, Math.max(0, alpha));
            state.rippleCtx.stroke(ring);
        }
    }
    state.rippleCtx.globalCompositeOperation = 'source-over';
}

function animateRipple(map, now) {
    drawRipple(map, now);
    requestAnimationFrame((t) => animateRipple(map, t));
}
