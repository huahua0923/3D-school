// ========================================================
// loca.js — Loca v2 可视化特效：呼吸点(Scatter) + 脉冲线(PulseLine)
// 叠加在现有 2D 覆盖物之上，由开关控制；Loca 与 GLCustomLayer 共用 WebGL 上下文
// ========================================================
import { state } from './state.js';
import { initRippleLayer } from './flow.js';

function buildLocaFeatures() {
    const features = [];
    // 数据源 = 首页勾选的「地图方案」（admin-map.html 绘制）。config.json 的旧 markers/routes/areas 已废弃。
    Object.entries(state.activePlanData).forEach(([, data]) => {
        if (!data || data.kind !== 'map') return;
        // 标记点 → Point（地图方案直接存经纬度 lng/lat）
        Object.entries(data.markers || {}).forEach(([name, m]) => {
            if (m.lng == null || m.lat == null) return;
            features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
                properties: { name, icon: m.icon || '📍', color: colorToHex(m.color, '#f59e0b') } });
        });
        // 路线 → LineString（贴地，无海拔分层）
        Object.entries(data.routes || {}).forEach(([name, r]) => {
            if (!r.pts || r.pts.length < 2) return;
            features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.pts },
                properties: { name, color: colorToHex(r.color, '#3b82f6') } });
        });
        // 区域 → Polygon（GeoJSON 外环需闭合，编辑器存的 pts 可能未闭合，这里补齐）
        Object.entries(data.areas || {}).forEach(([name, a]) => {
            if (!a.pts || a.pts.length < 3) return;
            const ring = a.pts.map(p => [p[0], p[1]]);
            const f0 = ring[0], fl = ring[ring.length - 1];
            if (f0[0] !== fl[0] || f0[1] !== fl[1]) ring.push([f0[0], f0[1]]);
            features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
                properties: { name, color: colorToHex(a.color, '#10b981') } });
        });
    });
    return features;
}

// 从 Loca 回调参数里安全取颜色（不同图层回调签名可能是 (feature) 或 (index, feature)）
function locaColorOf(...args) {
    let fallback = '#3b82f6';
    for (const a of args) {
        if (a && a.properties && a.properties.color) return a.properties.color;
        if (a && a.color) return a.color;
        if (typeof a === 'string' && a.charAt(0) === '#') fallback = a;
    }
    return fallback;
}

export function initLoca(map) {
    if (!window.Loca) { toast('⚠️ Loca SDK 未加载'); return; }
    if (state.locaContainer) return;
    try {
        const loca = new Loca.Container({ map });
        // 光照：参照 cadmall 剖面图案例（环境光 + 平行光 + 点光），让 3D 面图层有明暗立体感
        loca.ambLight = { intensity: 0.2, color: '#fff' };
        loca.dirLight = { intensity: 0.2, color: '#fff', target: [0, 0, 0], position: [0, -1, 1] };
        let plLng = 116.3894, plLat = 39.9976;
        try { const _mc = map.getCenter(); plLng = _mc.getLng(); plLat = _mc.getLat(); } catch (_) {}
        loca.pointLight = { color: '#c2beff', position: [plLng, plLat, 120], intensity: 2.5, distance: 300 };
        const all = buildLocaFeatures();
        const pts = all.filter(f => f.geometry.type === 'Point');
        const lines = all.filter(f => f.geometry.type === 'LineString');
        const polys = all.filter(f => f.geometry.type === 'Polygon');

        // 呼吸点 → 水波纹扩散：用独立 Canvas 覆盖层画扩散圆环（rAF 平滑，不闪）
        if (pts.length && state.locaEffects.breathing) {
            state.ripplePoints = pts.map(f => ({
                lng: f.geometry.coordinates[0],
                lat: f.geometry.coordinates[1],
                color: (f.properties && f.properties.color) || '#f59e0b',
            }));
            initRippleLayer(map);
            state.rippleOn = true;
        }

        // 光点 → 3D 散点图层（标记点发光体块）
        if (pts.length && state.locaEffects.scatter) {
            try {
                const src = new Loca.GeoJSONSource({ data: { type: 'FeatureCollection', features: pts } });
                const scatterLayer = new Loca.ScatterLayer({ zIndex: 110, opacity: 0.95 });
                scatterLayer.setSource(src);
                scatterLayer.setStyle({ unit: 'meter', size: [10, 10, 10], color: (...a) => locaColorOf(...a), borderColor: '#ffffff', borderWidth: 1 });
                loca.add(scatterLayer);
            } catch (e) { console.warn('⚠️ 光点图层不可用:', e && e.message); }
        }

        // 光柱 → 3D 柱状图层（标记点向上拉伸）
        if (pts.length && state.locaEffects.prism) {
            try {
                const src = new Loca.GeoJSONSource({ data: { type: 'FeatureCollection', features: pts } });
                const prismLayer = new Loca.PrismLayer({ zIndex: 109, opacity: 0.85 });
                prismLayer.setSource(src);
                prismLayer.setStyle({ unit: 'meter', topColor: (...a) => locaColorOf(...a), sideColor: (...a) => shadeHex(locaColorOf(...a), -0.35), height: 30, altitude: 0 });
                loca.add(prismLayer);
            } catch (e) { console.warn('⚠️ 光柱图层不可用:', e && e.message); }
        }

        // 区域 → 3D 体块挤出（参照 cadmall：topColor 顶面 + sideColor 侧面 + 光照立体感）
        if (polys.length && state.locaEffects.areas) {
            const src = new Loca.GeoJSONSource({ data: { type: 'FeatureCollection', features: polys } });
            const areaLayer = new Loca.PolygonLayer({ zIndex: 105, opacity: 0.9, shininess: 8 });
            areaLayer.setSource(src);
            areaLayer.setStyle({
                topColor: (...a) => locaColorOf(...a),
                sideColor: (...a) => shadeHex(locaColorOf(...a), -0.35),
                height: 8,
                altitude: 0,
            });
            loca.add(areaLayer);
        }

        // 路线：贴地脉冲流动动画（去掉海拔分层，只留脉冲）
        if (lines.length && state.locaEffects.routes) {
            const src = new Loca.GeoJSONSource({ data: { type: 'FeatureCollection', features: lines } });
            const pulseLayer = new Loca.PulseLineLayer({ zIndex: 111 });
            pulseLayer.setSource(src);
            pulseLayer.setStyle({ lineWidth: 4, trailColor: (...a) => locaColorOf(...a), headColor: '#ffffff', duration: 1800 });
            loca.add(pulseLayer);
        }

        loca.animate.start();
        state.locaContainer = loca;
    } catch (e) {
        console.error('❌ Loca 特效初始化失败', e);
        toast('⚠️ 特效初始化失败：' + (e && e.message ? e.message : e));
    }
}

export function destroyLoca() {
    state.rippleOn = false;
    try {
        if (state.locaContainer && typeof state.locaContainer.destroy === 'function') state.locaContainer.destroy();
    } catch (_) {}
    state.locaContainer = null;
}

function updateLocaToggleBtn() {
    const btn = document.getElementById('btn-loca-toggle');
    if (btn) { btn.textContent = state.locaActive ? '🎆 关闭 3D 特效' : '🎆 开启 3D 特效'; btn.classList.toggle('active', state.locaActive); }
}

export function updateLocaEffectButtons() {
    document.querySelectorAll('#loca-effects button[data-effect]').forEach(b => {
        b.classList.toggle('active', !!state.locaEffects[b.dataset.effect]);
    });
}

export function toggleLoca(map) {
    if (state.locaActive) { destroyLoca(); state.locaActive = false; }
    else { initLoca(map); if (state.locaContainer) state.locaActive = true; }
    updateLocaToggleBtn();
}

// 单个特效开关：切换后重建 Loca 图层（仅当特效已开启时生效）
export function toggleLocaEffect(name, on) {
    if (!(name in state.locaEffects)) return;
    state.locaEffects[name] = on;
    updateLocaEffectButtons();
    if (state.locaActive) rebuildLocaIfActive();
}

// 方案勾选变化后，若特效已开启则重建 Loca 图层（数据源变了）
export function rebuildLocaIfActive() {
    if (!state.locaActive || !state.planMap) return;
    destroyLoca();
    initLoca(state.planMap);
}
