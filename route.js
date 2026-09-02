// ========================================================
// route.js — 路径导航（设起终点/高德路线规划）+ 地物详情弹窗 + 图片灯箱 + UI 控制器
// ========================================================
import { state } from './state.js';

// —— 高德官方路线规划（步行/驾车/骑行/公交）：统一提取路径 + 渲染 ——
const NAV_MODE_LABEL = { walking: '步行', driving: '驾车', riding: '骑行', transfer: '公交' };

// —— 路径导航：详情卡设起点/终点 → 画直线 + 距离 + 楼层提示 ——
function setNavPoint(which) {
    if (!state.currentFeature) return;
    if (which === 'start') state.navStart = state.currentFeature;
    else state.navEnd = state.currentFeature;
    if (state.ui) state.ui.hideInfo();
    updateNavPanel();
    updateNavPointMarkers();
    if (state.navStart && state.navEnd) drawNavRoute();
}

function formatNavDistance(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' 公里' : Math.round(m) + ' 米';
}

function updateNavPanel() {
    const sl = document.getElementById('nav-start-line');
    const el = document.getElementById('nav-end-line');
    const dl = document.getElementById('nav-dist-line');
    if (sl) sl.textContent = '起点：' + (state.navStart ? (state.navStart.title + ' · ' + state.navStart.floor + 'F') : '未设置');
    if (el) el.textContent = '终点：' + (state.navEnd ? (state.navEnd.title + ' · ' + state.navEnd.floor + 'F') : '未设置');
    if (dl) dl.textContent = '';
}

function clearNavRoute() {
    if (state.navOverlay) { state.navOverlay.setMap(null); state.navOverlay = null; }
    clearDragRoute();
}

export function clearNav() {
    state.navStart = null; state.navEnd = null;
    state.navReqSeq++;   // 使在途路线规划失效
    clearNavRoute(); updateNavPointMarkers(); updateNavPanel();
}

// 从规划结果拼接完整路径：步行/驾车用 steps[].path；骑行用 rides[].path（高德骑行专属字段）；公交的站点段存于 step.bus.path
function routePathOf(route) {
    const path = [];
    const segs = (route.rides && route.rides.length) ? route.rides : (route.steps || []);
    segs.forEach(s => {
        if (!s) return;
        const p = s.path || (s.bus && s.bus.path) || [];
        if (p && p.length) path.push(...p);
    });
    return path;
}

function clearDragRoute() {
    if (state.dragRoute) { try { if (state.dragRoute.clear) state.dragRoute.clear(); } catch (_) {} state.dragRoute = null; }
}

// 统一渲染规划结果：清直线兜底 → 画真实路线 + 距离/时长；驾车额外挂 DragRoute 供拖拽调整
function renderNavRoute(route, straight, seq, dl) {
    const distText = (r) => NAV_MODE_LABEL[state.navTravelMode] + '：约 ' + formatNavDistance(r.distance || straight)
        + (r.time ? ' · 约 ' + Math.ceil(r.time / 60) + ' 分钟' : '')
        + '（直线 ' + formatNavDistance(straight) + '）';
    if (dl) dl.textContent = distText(route);

    // 驾车：用 DragRoute 画路线并支持拖拽调整；其余模式手动画折线
    clearDragRoute();
    if (state.navTravelMode === 'driving' && window.AMap && AMap.DragRoute) {
        try {
            if (state.navOverlay) { state.navOverlay.setMap(null); state.navOverlay = null; }
            state.dragRoute = new AMap.DragRoute(state.planMap, route, AMap.DrivingPolicy ? AMap.DrivingPolicy.LEAST_TIME : 0, {
                polyOptions: { strokeColor: '#22d3ee', strokeWeight: 5, strokeOpacity: 0.95 },
            });
            state.dragRoute.on('complete', (ev) => {
                if (seq !== state.navReqSeq) return;
                const nr = ev && ev.route;
                if (nr && dl) dl.textContent = distText(nr) + '（已拖拽调整）';
            });
            state.dragRoute.search();
            return;
        } catch (_) {}
    }

    const path = routePathOf(route);
    if (path.length < 2) return;
    if (state.navOverlay) { state.navOverlay.setMap(null); }
    state.navOverlay = new AMap.Polyline({
        path, strokeColor: '#22d3ee', strokeWeight: 5, strokeStyle: 'solid', strokeOpacity: 0.95, zIndex: 30,
    });
    state.navOverlay.setMap(state.planMap);
}

// 带重试的路线规划：高德骑行/驾车等偶发 QPS 限流会返回 status='error'（result 为 undefined），
// 短暂延迟重试两次；仍失败则回调 null（保留直线虚线并提示）
function planRouteWithRetry(planner, start, end, onResult, attempt = 0) {
    planner.search(start, end, (status, result) => {
        if (status === 'complete' && result && result.routes && result.routes[0]) {
            onResult(result.routes[0]);
        } else if (status === 'error' && attempt < 2) {
            setTimeout(() => planRouteWithRetry(planner, start, end, onResult, attempt + 1), 700 * (attempt + 1));
        } else {
            onResult(null);
        }
    });
}

// 起点/终点标记：优先高德弹性标记（弹跳动画），插件未就绪回退普通圆点
function navPointMarker(lng, lat, color, label) {
    if (state.elasticAvailable && window.AMap && AMap.ElasticMarker) {
        try {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="21" viewBox="0 0 32 42">'
                + '<circle cx="16" cy="16" r="12" fill="' + color + '" stroke="#fff" stroke-width="2.5"/>'
                + '<path d="M16 30 C16 30 8 22 8 16 A8 8 0 0 1 24 16 C24 22 16 30 16 30" fill="' + color + '"/></svg>';
            const m = new AMap.ElasticMarker({
                position: [lng, lat],
                styles: [{ icon: { img: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), size: [16, 21], anchor: 'bottom-center' } }],
                zoomStyleMapping: { 14: 0, 15: 0, 16: 0, 17: 0, 18: 0, 19: 0, 20: 0 },
            });
            m.setMap(state.planMap);
            try { m.elasticMarker(); } catch (_) {}
            return m;
        } catch (_) {}
    }
    const dot = '<div style="width:7px;height:7px;border-radius:50%;background:' + color
        + ';border:1px solid #fff;box-shadow:0 0 5px ' + color + ';" title="' + label + '"></div>';
    const m = new AMap.Marker({ position: [lng, lat], content: dot, anchor: 'bottom-center', zIndex: 120 });
    m.setMap(state.planMap);
    return m;
}

function updateNavPointMarkers() {
    state.navPointMarkers.forEach(m => { try { m.setMap(null); } catch (_) {} });
    state.navPointMarkers = [];
    if (!state.planMap) return;
    if (state.navStart) state.navPointMarkers.push(navPointMarker(state.navStart.lng, state.navStart.lat, '#22c55e', '起点'));
    if (state.navEnd) state.navPointMarkers.push(navPointMarker(state.navEnd.lng, state.navEnd.lat, '#ef4444', '终点'));
}

export function drawNavRoute() {
    if (!state.planMap || !state.navStart || !state.navEnd) return;
    clearNavRoute();
    const start = new AMap.LngLat(state.navStart.lng, state.navStart.lat);
    const end = new AMap.LngLat(state.navEnd.lng, state.navEnd.lat);
    const straight = AMap.GeometryUtil.distance(start, end);
    const seq = ++state.navReqSeq;
    const dl = document.getElementById('nav-dist-line');

    // 1) 先用直线虚线兜底（高德原生），真实步行路线算好后替换
    state.navOverlay = new AMap.Polyline({
        path: [start, end],
        strokeColor: '#22d3ee', strokeWeight: 4, strokeStyle: 'dashed', strokeOpacity: 0.45, zIndex: 30,
    });
    state.navOverlay.setMap(state.planMap);
    if (dl) dl.textContent = '直线距离：约 ' + formatNavDistance(straight);

    // 2) 真实路线规划（步行/驾车/骑行/公交，高德官方），失败保留直线虚线
    const planner = state.navTravelMode === 'driving' ? state.navDriving
        : state.navTravelMode === 'riding' ? state.navRiding
        : state.navTravelMode === 'transfer' ? state.navTransfer
        : state.navWalking;
    if (planner) {
        planRouteWithRetry(planner, start, end, (route) => {
            if (seq !== state.navReqSeq) return;   // 已被新请求 / 清除取代
            if (!route) { toast('⚠️ ' + NAV_MODE_LABEL[state.navTravelMode] + '规划失败，请重试或换出行方式'); return; }
            renderNavRoute(route, straight, seq, dl);
        });
    }

    if (state.navStart.floor !== state.navEnd.floor) {
        toast('⚠️ 终点「' + state.navEnd.title + '」在 ' + state.navEnd.floor + 'F，请切换楼层查看');
    }
    state.planMap.setZoomAndCenter(Math.max(state.planMap.getZoom(), 17), [state.navStart.lng, state.navStart.lat]);
}

// 加载后台保存的预设导航路线：直接画保存的路径点（含拖拽改线结果，不重新规划）
export function loadPresetRoute(idx) {
    const route = state.navRoutes[idx];
    if (!route || !route.data || !state.planMap) return;
    const d = route.data;
    const mode = d.travelMode || 'walking';

    state.navStart = { lng: d.start.lng, lat: d.start.lat, title: d.start.name || '起点' };
    state.navEnd = { lng: d.end.lng, lat: d.end.lat, title: d.end.name || '终点' };
    state.navTravelMode = mode;

    // 同步出行方式按钮 active 态
    const nm = document.getElementById('nav-mode-btns');
    if (nm) nm.querySelectorAll('button[data-nav-mode]').forEach(x =>
        x.classList.toggle('active', x.dataset.navMode === mode));

    clearNavRoute();
    const pts = (d.pts || []).map(p => Array.isArray(p) ? new AMap.LngLat(p[0], p[1]) : new AMap.LngLat(p.lng, p.lat));
    if (pts.length >= 2) {
        state.navOverlay = new AMap.Polyline({
            path: pts, strokeColor: '#22d3ee', strokeWeight: 5, strokeStyle: 'solid', strokeOpacity: 0.95, zIndex: 30,
        });
        state.navOverlay.setMap(state.planMap);
    }
    updateNavPointMarkers();

    // 起终点文案（预设路线不展示楼层）
    const sl = document.getElementById('nav-start-line');
    const el = document.getElementById('nav-end-line');
    if (sl) sl.textContent = '起点：' + (d.start.name || '起点');
    if (el) el.textContent = '终点：' + (d.end.name || '终点');
    const dl = document.getElementById('nav-dist-line');
    if (dl) {
        dl.textContent = NAV_MODE_LABEL[mode] + '：约 ' + formatNavDistance(d.distance || 0)
            + (d.time ? ' · 约 ' + Math.ceil(d.time / 60) + ' 分钟' : '');
    }
    if (pts.length >= 2) {
        state.planMap.setZoomAndCenter(Math.max(state.planMap.getZoom(), 17), [d.start.lng, d.start.lat]);
    }
}

/** 覆盖物点击：阻止冒泡并短暂屏蔽 map click 的 hideInfo，再执行展示逻辑 */
export function onFeatureClick(e, fn) {
    if (e && e.originalEvent && e.originalEvent.stopPropagation) e.originalEvent.stopPropagation();
    state.suppressMapClickUntil = performance.now() + 300;
    fn();
}

/** 官方 AMap.InfoWindow 地物详情弹出：icon+标题+badge+描述+图片缩略图+设为起点/终点 */
export function showFeaturePopup(map, f) {
    if (!map || !state.featureInfoWindow) return;
    const box = document.createElement('div');
    box.style.cssText = 'background:rgba(17,20,32,0.97);border:1px solid rgba(255,255,255,0.2);border-radius:16px;padding:20px 22px;min-width:360px;max-width:min(480px,calc(100vw - 40px));box-shadow:0 12px 40px rgba(0,0,0,0.6);';

    // 头部：icon + 标题 + badge + 关闭
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px;';
    const icon = document.createElement('span');
    icon.textContent = f.icon || '📍';
    icon.style.cssText = 'font-size:32px;line-height:1;';
    const title = document.createElement('strong');
    title.textContent = f.title || '';
    title.style.cssText = 'color:#fff;font-size:20px;flex:1;line-height:1.3;';
    head.appendChild(icon); head.appendChild(title);
    if (f.badge) {
        const b = document.createElement('span');
        b.textContent = f.badge;
        b.style.cssText = 'font-size:13px;color:#22d3ee;border:1px solid rgba(34,211,238,0.5);border-radius:10px;padding:3px 10px;white-space:nowrap;';
        head.appendChild(b);
    }
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.7);font-size:20px;cursor:pointer;padding:2px 6px;';
    close.addEventListener('click', () => state.featureInfoWindow.close());
    head.appendChild(close);
    box.appendChild(head);

    // 描述
    if (f.desc) {
        const d = document.createElement('div');
        d.textContent = f.desc;
        d.style.cssText = 'color:rgba(255,255,255,0.82);font-size:15px;line-height:1.7;margin-bottom:12px;';
        box.appendChild(d);
    }

    // 图片缩略图（点击放大灯箱）
    if (f.images && f.images.length) {
        const imgs = document.createElement('div');
        imgs.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;';
        f.images.forEach((src, i) => {
            const im = document.createElement('img');
            im.src = src; im.alt = f.title || '图片';
            im.style.cssText = 'width:96px;height:72px;object-fit:cover;border-radius:8px;cursor:pointer;border:1px solid rgba(255,255,255,0.2);';
            im.addEventListener('click', () => openLightbox(f.images, i));
            imgs.appendChild(im);
        });
        box.appendChild(imgs);
    }

    // 设为起点 / 终点
    if (f.lng != null && f.lat != null) {
        state.currentFeature = { lng: f.lng, lat: f.lat, title: f.title || '该位置', floor: state.currentFloor };
        const nav = document.createElement('div');
        nav.style.cssText = 'display:flex;gap:10px;';
        const mkBtn = (txt, which) => {
            const b = document.createElement('button');
            b.textContent = txt;
            b.style.cssText = 'flex:1;font-size:15px;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.1);color:#fff;cursor:pointer;';
            b.addEventListener('click', () => { setNavPoint(which); state.featureInfoWindow.close(); });
            return b;
        };
        nav.appendChild(mkBtn('🚩 设为起点', 'start'));
        nav.appendChild(mkBtn('🏁 设为终点', 'end'));
        box.appendChild(nav);
    }

    state.featureInfoWindow.setContent(box);
    state.featureInfoWindow.open(map, [f.lng, f.lat]);
}

/** 图片灯箱：点击缩略图放大，多图左右切换 */
function openLightbox(imgs, idx) {
    state.lbImages = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
    state.lbIndex = idx || 0;
    renderLightbox();
    document.getElementById('lightbox').classList.add('show');
}
function renderLightbox() {
    document.getElementById('lightbox-img').src = state.lbImages[state.lbIndex] || '';
    document.getElementById('lb-count').textContent = state.lbImages.length > 1 ? (state.lbIndex + 1) + ' / ' + state.lbImages.length : '';
    document.getElementById('lb-prev').style.display = state.lbImages.length > 1 ? 'flex' : 'none';
    document.getElementById('lb-next').style.display = state.lbImages.length > 1 ? 'flex' : 'none';
}
function lightboxStep(d) {
    if (!state.lbImages.length) return;
    state.lbIndex = (state.lbIndex + d + state.lbImages.length) % state.lbImages.length;
    renderLightbox();
}
document.getElementById('lightbox').addEventListener('click', () => document.getElementById('lightbox').classList.remove('show'));
document.getElementById('lightbox-img').addEventListener('click', (e) => e.stopPropagation());
document.getElementById('lb-prev').addEventListener('click', (e) => { e.stopPropagation(); lightboxStep(-1); });
document.getElementById('lb-next').addEventListener('click', (e) => { e.stopPropagation(); lightboxStep(1); });
document.getElementById('lb-close').addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('lightbox').classList.remove('show'); });
document.addEventListener('keydown', (e) => {
    if (!document.getElementById('lightbox').classList.contains('show')) return;
    if (e.key === 'ArrowLeft') lightboxStep(-1);
    else if (e.key === 'ArrowRight') lightboxStep(1);
    else if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('show');
});

// 预设路线下拉：点选后台保存的路线 → 加载显示（不重新规划）
const navPresetSel = document.getElementById('nav-preset');
if (navPresetSel) navPresetSel.addEventListener('change', () => {
    if (navPresetSel.value !== '') loadPresetRoute(parseInt(navPresetSel.value, 10));
});

// ========================================================
// UI 控制器
// ========================================================
export class UIController {
    constructor() {
        this.loadingEl = document.getElementById('loading-screen');
        this.loaderBar = document.getElementById('loader-bar');
        this.loaderPct = document.getElementById('loader-pct');
        this.infoCard = document.getElementById('info-card');
        this.infoBackdrop = document.getElementById('info-card-backdrop');
        this._bindInfoClose();
    }

    setProgress(msg, pct) {
        this.loaderBar.style.width = pct + '%';
        this.loaderPct.textContent = msg || (Math.round(pct) + '%');
    }

    hideLoading() { this.loadingEl.classList.add('hidden'); }

    hideInfo() {
        this.infoCard.classList.remove('show');
        this.infoBackdrop.classList.remove('show');
    }

    setActivePreset(name) {
        const el = document.querySelector('#camera-presets');
        if (!el) return;
        el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    }

    _bindInfoClose() {
        document.querySelector('.info-close').addEventListener('click', () => this.hideInfo());
        document.getElementById('info-card-backdrop').addEventListener('click', () => this.hideInfo());
        document.getElementById('info-btn-close').addEventListener('click', () => this.hideInfo());
        document.getElementById('info-btn-start').addEventListener('click', () => setNavPoint('start'));
        document.getElementById('info-btn-end').addEventListener('click', () => setNavPoint('end'));
    }
}
