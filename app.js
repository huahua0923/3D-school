// ========================================================
// app.js — 高德地图初始化 + 应用编排（boot）
// 加载 Key/配置 → 初始化地图 → Three.js 场景 → 各子系统 → 事件装配
// ========================================================
import * as THREE from 'three';
import { state } from './state.js';
import { localToLngLat } from './coords.js';
import { setupThreeScene, buildVenue } from './three-scene.js';
import { initFlowLayer, resizeFlowLayer, resizeRippleLayer, startGuide } from './flow.js';
import { toggleLoca, toggleLocaEffect, updateLocaEffectButtons } from './loca.js';
import { initWeather } from './weather.js';
import { buildSearchIndex, searchNearby } from './poi.js';
import { initMeasureTools } from './measure.js';
import { UIController, showFeaturePopup, drawNavRoute } from './route.js';
import { initPlanSelector, initIndoorNav } from './indoor.js';
import { initAuth } from './auth.js';
import { loadConfig } from './config.js';

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load: ' + url));
        document.head.appendChild(s);
    });
}

// 预取高德 Key/安全密钥（独立于 config.json，可与 loadConfig 并行，消除串行等待链）
async function fetchAmapKey() {
    try {
        const r = await fetch('/api/amap');
        const d = await r.json();
        if (d && d.key) return d;
    } catch (_) { /* 回退到 config.json 中的值 */ }
    return null;
}

async function initAmap(amapKeyCfg) {
    const geo = state.CONFIG.geo;
    // 优先用服务端 .env 注入的高德 Key/安全密钥（高德官方建议：key 不进仓库）
    let amapKey = geo && geo.amapKey;
    let amapSecurityCode = geo && geo.amapSecurityCode;
    if (amapKeyCfg) {
        if (amapKeyCfg.key) amapKey = amapKeyCfg.key;
        if (amapKeyCfg.securityJsCode) amapSecurityCode = amapKeyCfg.securityJsCode;
    }

    if (!amapKey || amapKey === 'YOUR_AMAP_KEY_HERE') {
        // Show setup hint, fallback to classic
        document.getElementById('setup-hint').classList.add('show');
        document.getElementById('loading-screen').classList.add('hidden');
        console.warn('⚠️ 未配置高德地图 Key，使用经典 3D 模式');
        // Try loading classic version
        window.location.href = '/index-classic.html';
        return null;
    }

    // Set security code BEFORE loading Amap (required for keys created after 2021-12)
    if (amapSecurityCode) {
        window._AMapSecurityConfig = { securityJsCode: amapSecurityCode };
    }

    // Load Amap JS API
    const amapUrl = `https://webapi.amap.com/maps?v=2.0&key=${amapKey}`;
    await loadScript(amapUrl);

    // 加载 Loca v2（数据可视化）SDK，失败不阻塞主地图
    try { await loadScript(`https://webapi.amap.com/loca?v=2.0.0&key=${amapKey}`); }
    catch (_) { console.warn('⚠️ Loca SDK 加载失败，可视化特效不可用'); }

    // Also load AMap helper plugins if needed
    if (!window.AMap) {
        console.error('❌ 高德地图加载失败');
        return null;
    }

    const map = new AMap.Map('map-container', {
        viewMode: '3D',
        center: geo.center,
        zoom: geo.zoom || 17,
        pitch: geo.pitch || 55,
        rotation: geo.rotation || 20,
        mapStyle: geo.mapStyle || 'amap://styles/dark',
        features: ['bg', 'road', 'building', 'point'],
        showBuildingBlock: false,
        showLabel: true,
        buildingAnimation: true,
        showIndoorMap: false,  // 高德官方室内图已弃用，室内图走自家「室内方案」系统（editor.html 绘制）
        // 允许 WebGL 内容
        webglParams: { preserveDrawingBuffer: false },
    });

    console.log('✅ 高德地图 3D 初始化完成');
    return map;
}

// —— 时段氛围：根据当前小时给地图叠加一层色调 + 暗角，营造昼夜氛围 ——
function updateAtmosphere() {
    const el = document.getElementById('atmosphere');
    if (!el) return;
    const h = new Date().getHours();
    // 每段 [起始时, 顶部色, 底部色, 暗角强度]
    const phases = [
        { from: 5, to: 7,  top: 'rgba(255,170,80,0.20)', bot: 'rgba(120,70,200,0.12)', vig: 0.22 },   // 清晨
        { from: 7, to: 10, top: 'rgba(255,225,170,0.08)', bot: 'rgba(255,255,255,0)',   vig: 0.10 },   // 上午
        { from: 10, to: 15, top: 'rgba(255,255,255,0)',   bot: 'rgba(255,255,255,0)',   vig: 0.06 },   // 正午
        { from: 15, to: 17, top: 'rgba(255,255,255,0)',   bot: 'rgba(255,190,110,0.07)', vig: 0.10 },  // 下午
        { from: 17, to: 19, top: 'rgba(40,60,140,0.20)',  bot: 'rgba(255,140,60,0.14)', vig: 0.28 },   // 黄昏
        { from: 19, to: 24, top: 'rgba(6,14,38,0.32)',    bot: 'rgba(3,6,20,0.22)',    vig: 0.40 },   // 夜晚
        { from: 0, to: 5,   top: 'rgba(6,14,38,0.32)',    bot: 'rgba(3,6,20,0.22)',    vig: 0.40 },   // 深夜
    ];
    const p = phases.find(p => h >= p.from && h < p.to) || phases[4];
    el.style.background = 'radial-gradient(ellipse at 50% 38%, rgba(0,0,0,0) 55%, rgba(0,0,0,' + p.vig + ') 100%), linear-gradient(180deg, ' + p.top + ', ' + p.bot + ')';
}

// 后台「功能模块」开关 + 参数：根据 state.CONFIG.features 控制显隐并注入参数
// 在 loadConfig 之后、各子系统初始化之前调用，确保参数在绑定/初始化前就位
function applyFeatureFlags() {
    const f = (state.CONFIG && state.CONFIG.features) || {};
    const hide = (sel) => { const el = document.querySelector(sel); if (el) el.style.display = 'none'; };
    const hideClosest = (id, parentSel) => {
        const el = document.getElementById(id);
        const p = el && el.closest ? el.closest(parentSel) : null;
        if (p) p.style.display = 'none';
    };

    // —— 显隐（display:none）——
    if (f.indoor && f.indoor.enabled === false) hideClosest('btn-indoor-nav', '.bottom-card');      // 室内寻路卡
    if (f.routeNav && f.routeNav.enabled === false) hideClosest('nav-start-line', '.bottom-card');  // 路径导航卡
    if (f.weather && f.weather.enabled === false) hide('#weather-panel');                           // 天气面板
    if (f.nearby && f.nearby.enabled === false) hideClosest('btn-nearby-toggle', '.map-tool-wrap'); // 周边搜索
    if (f.measure && f.measure.enabled === false) {                                                // 测量工具（三个独立按钮）
        hide('#btn-measure-distance'); hide('#btn-measure-area'); hide('#btn-measure-clear');
    }
    if (f.loca && f.loca.enabled === false) hideClosest('btn-effects-toggle', '.map-tool-wrap');   // Loca 特效
    if (f.buildingSwitch && f.buildingSwitch.enabled === false) {                                  // 楼栋 + 楼层切换
        hide('#building-section'); hide('#floor-section');
    }
    if (f.autoRotate && f.autoRotate.enabled === false) hide('#btn-auto-rotate');                  // 自动旋转

    // —— 参数注入 ——
    if (f.routeNav) {
        if (f.routeNav.defaultTravelMode) {
            state.navTravelMode = f.routeNav.defaultTravelMode;
            const nm = document.getElementById('nav-mode-btns');
            if (nm) nm.querySelectorAll('button[data-nav-mode]').forEach(x =>
                x.classList.toggle('active', x.dataset.navMode === state.navTravelMode));
        }
        state.guideFollow = f.routeNav.guideFollow !== false;
        const bgf = document.getElementById('btn-guide-follow');
        if (bgf) {
            bgf.classList.toggle('active', state.guideFollow);
            bgf.title = '漫游跟随：' + (state.guideFollow ? '开' : '关');
        }
    }
}

// 加载后台保存的预设导航路线：填充首页「预设路线」下拉，供访客点选
async function loadPresetNavRoutes() {
    try {
        const res = await fetch('/api/nav-routes', { cache: 'no-store' });
        const json = await res.json();
        state.navRoutes = (json && json.data) || [];
    } catch (err) {
        console.warn('⚠️ 预设路线加载失败', err && err.message);
        state.navRoutes = [];
    }
    const sel = document.getElementById('nav-preset');
    if (!sel) return;
    sel.innerHTML = '<option value="">📌 预设路线…</option>';
    state.navRoutes.forEach((r, i) => {
        const d = r.data || {};
        const startName = (d.start && d.start.name) ? d.start.name : '起点';
        const endName = (d.end && d.end.name) ? d.end.name : '终点';
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = (r.name || '未命名路线') + '（' + startName + ' → ' + endName + '）';
        sel.appendChild(o);
    });
}

export async function boot() {
    state.ui = new UIController();
    state.ui.setProgress('加载配置...', 5);

    // Load config —— 高德密钥与配置互不依赖，并行拉取
    const amapKeyPromise = fetchAmapKey();
    await loadConfig();

    // 应用后台「功能模块」开关与参数（显隐 + 参数注入，须在地图/各子系统初始化前）
    applyFeatureFlags();

    // 加载后台保存的预设导航路线（不阻塞 boot，下拉填充完成后即可点选）
    loadPresetNavRoutes();

    // Init Amap
    state.ui.setProgress('初始化地图...', 20);
    const map = await initAmap(await amapKeyPromise);
    if (!map) return; // Fallback handled in initAmap

    // Setup Three.js — wait for GLCustomLayer init, then create objects
    state.ui.setProgress('初始化 3D 引擎...', 40);
    const { scene, camera, renderer, labelRenderer, customCoords, waitForInit } = setupThreeScene(map);

    // waitForInit returns a promise that resolves after GLCustomLayer.init runs
    state.ui.setProgress('等待图层就绪...', 50);
    const { localToAmap, localPerMeter } = await waitForInit();
    state.threeCtx = { scene, customCoords, lpm: localPerMeter, labelRenderer };

    state.ui.setProgress('构建场馆模型...', 60);
    buildVenue(scene, localToAmap);

    state.ui.setProgress('生成流动路线...', 80);

    initFlowLayer(map);

    // 先解析登录态（角色决定方案可见性），再加载「导览方案」
    await initAuth();
    initPlanSelector(map);
    initIndoorNav();

    // 首页测量工具：测距 + 测面积
    initMeasureTools(map);

    // 高德原生控件：比例尺 + 视角控制（旋转/倾斜/复位）+ 鹰眼小地图
    AMap.plugin(['AMap.Scale', 'AMap.ControlBar', 'AMap.OverView'], () => {
        try {
            map.addControl(new AMap.Scale({ position: { bottom: '24px', left: '264px' } }));
            map.addControl(new AMap.ControlBar({ position: { top: '72px', right: '20px' } }));
            map.addControl(new AMap.OverView({ position: { bottom: '84px', right: '24px' }, isOpen: false }));
        } catch (e) { console.warn('⚠️ 原生控件加载失败:', e && e.message); }
    });

    // 真实路线规划：高德自带步行导航（AMap.Walking），失败回退直线
    AMap.plugin('AMap.Walking', () => {
        try { state.navWalking = new AMap.Walking(); }
        catch (e) { console.warn('⚠️ 步行路线规划不可用:', e && e.message); }
    });

    // 驾车/骑行/公交路线规划（配合路径导航出行方式切换）
    AMap.plugin(['AMap.Driving', 'AMap.Riding', 'AMap.Transfer'], () => {
        try { state.navDriving = new AMap.Driving({ policy: AMap.DrivingPolicy ? AMap.DrivingPolicy.LEAST_TIME : 0, hideMarkers: true }); }
        catch (e) { console.warn('⚠️ 驾车路线规划不可用:', e && e.message); }
        try { state.navRiding = new AMap.Riding({}); }
        catch (e) { console.warn('⚠️ 骑行路线规划不可用:', e && e.message); }
        try { state.navTransfer = new AMap.Transfer({ city: '成都', policy: AMap.TransferPolicy ? AMap.TransferPolicy.LEAST_TIME : 0 }); }
        catch (e) { console.warn('⚠️ 公交路线规划不可用:', e && e.message); }
    });

    // 弹性标记：起点/终点弹跳动画（插件就绪后，setNavPoint 优先使用）
    AMap.plugin('AMap.ElasticMarker', () => { state.elasticAvailable = true; });

    // 官方信息窗体：地物详情弹出（替代手写侧栏 showFeature）
    state.featureInfoWindow = new AMap.InfoWindow({ isCustom: true, offset: new AMap.Pixel(0, -12), autoMove: true });

    // 逆地理编码：点击空白处显示地址
    AMap.plugin('AMap.Geocoder', () => {
        try { state.geocoder = new AMap.Geocoder({ city: '成都' }); }
        catch (e) { console.warn('⚠️ 逆地理编码不可用:', e && e.message); }
    });

    // 周边 POI 搜索：停车场/地铁/餐饮/洗手间
    AMap.plugin('AMap.PlaceSearch', () => {
        try { state.placeSearch = new AMap.PlaceSearch({ city: '成都', pageSize: 10, pageIndex: 1 }); }
        catch (e) { console.warn('⚠️ 周边搜索不可用:', e && e.message); }
    });

    // 漫游跟随开关（悬浮工具栏图标按钮：active 高亮表示开）
    const btnGuideFollow = document.getElementById('btn-guide-follow');
    if (btnGuideFollow) btnGuideFollow.addEventListener('click', () => {
        state.guideFollow = !state.guideFollow;
        btnGuideFollow.classList.toggle('active', state.guideFollow);
        btnGuideFollow.title = '漫游跟随：' + (state.guideFollow ? '开' : '关');
        toast('🚶 漫游跟随：' + (state.guideFollow ? '开' : '关'));
    });

    // 路径导航出行方式切换（步行/驾车/骑行/公交）
    const navModeBtns = document.getElementById('nav-mode-btns');
    if (navModeBtns) navModeBtns.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-nav-mode]');
        if (!b) return;
        state.navTravelMode = b.dataset.navMode;
        navModeBtns.querySelectorAll('button[data-nav-mode]').forEach(x => x.classList.toggle('active', x === b));
        if (state.navStart && state.navEnd) drawNavRoute();
    });

    // 周边建筑显隐（高德默认 3D 建筑层）
    let amapBuildingsOn = true;
    const btnBuildings = document.getElementById('btn-buildings-toggle');
    if (btnBuildings) btnBuildings.addEventListener('click', () => {
        amapBuildingsOn = !amapBuildingsOn;
        const feats = ['bg', 'road', 'point'];
        if (amapBuildingsOn) feats.push('building');
        map.setFeatures(feats);
        btnBuildings.classList.toggle('active', amapBuildingsOn);
        btnBuildings.title = '周边建筑：' + (amapBuildingsOn ? '开' : '关');
        toast('🏙 周边建筑：' + (amapBuildingsOn ? '开' : '关'));
    });

    // 周边服务搜索按钮
    const nearbyBtns = document.getElementById('nearby-btns');
    if (nearbyBtns) nearbyBtns.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-nearby]');
        if (b) searchNearby(map, b.dataset.nearby);
    });

    // —— 悬浮工具栏：周边 / 特效面板的展开收起（点图标开关，点面板外收起）——
    function closeToolPanels() {
        document.querySelectorAll('#map-tools .map-tool-panel.open').forEach(p => p.classList.remove('open'));
    }
    function bindToolPanel(btnId, panelId) {
        const btn = document.getElementById(btnId);
        const panel = document.getElementById(panelId);
        if (!btn || !panel) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = !panel.classList.contains('open');
            closeToolPanels();
            panel.classList.toggle('open', willOpen);
        });
        panel.addEventListener('click', (e) => e.stopPropagation());
    }
    bindToolPanel('btn-nearby-toggle', 'nearby-panel');
    bindToolPanel('btn-effects-toggle', 'effects-panel');
    document.addEventListener('click', closeToolPanels);

    // 可视化特效开关（Loca v2）
    const btnLoca = document.getElementById('btn-loca-toggle');
    if (btnLoca) btnLoca.addEventListener('click', () => toggleLoca(map));

    // 单个特效选择性展示（路线/呼吸点）
    document.querySelectorAll('#loca-effects button[data-effect]').forEach(b => {
        b.addEventListener('click', () => toggleLocaEffect(b.dataset.effect, !state.locaEffects[b.dataset.effect]));
    });
    updateLocaEffectButtons();

    // 天气预报（AMap.Weather）
    initWeather();

    // 时段氛围：初始渲染 + 每分钟刷新（小时变化才真正跳档）
    updateAtmosphere();
    setInterval(updateAtmosphere, 60000);

    // 搜索：优先匹配本地场馆标记，其次高德 POI
    AMap.plugin('AMap.AutoComplete', () => {
        const auto = new AMap.AutoComplete({ city: '成都', citylimit: true });
        const searchInput = document.getElementById('search-input');
        const searchResults = document.getElementById('search-results');
        const itemCache = {};   // 方案地物结果缓存：itemId → {type,badge,icon,name,lng,lat,desc,images,pts}
        searchInput.addEventListener('input', () => {
            const val = searchInput.value.trim();
            if (!val) { searchResults.style.display = 'none'; return; }
            searchResults.innerHTML = '';
            const q = val.toLowerCase();
            // 方案地物（标记/区域/路线/画框/圆/椭圆 + 室内元素）
            let seq = 0;
            for (const it of buildSearchIndex()) {
                if (!(it.name || '').toLowerCase().includes(q)) continue;
                const id = 'pi' + (seq++);
                itemCache[id] = it;
                const div = document.createElement('div');
                div.className = 'search-item';
                div.dataset.itemId = id;
                const floorTag = it.floor ? (' · ' + it.floor + 'F') : '';
                div.textContent = (it.indoor ? '🏠 ' : '') + (it.icon || '📍') + ' ' + it.name + floorTag;
                searchResults.appendChild(div);
            }
            searchResults.style.display = searchResults.children.length ? 'block' : 'none';
            // 3) 高德 POI
            auto.search(val, (status, result) => {
                if (status === 'complete' && result.tips) {
                    result.tips.slice(0, 6).forEach(t => {
                        const div = document.createElement('div');
                        div.className = 'search-item';
                        div.dataset.lng = t.location?.lng || '';
                        div.dataset.lat = t.location?.lat || '';
                        div.textContent = '📍 ' + (t.name || '');
                        searchResults.appendChild(div);
                    });
                    searchResults.style.display = searchResults.children.length ? 'block' : 'none';
                }
            });
        });
        searchResults.addEventListener('click', (e) => {
            const item = e.target.closest('.search-item');
            if (!item) return;
            if (item.dataset.itemId) {
                const it = itemCache[item.dataset.itemId];
                if (it) {
                    searchResults.style.display = 'none';
                    searchInput.value = it.name;
                    flyTo([it.lng, it.lat], 18, map.getPitch(), map.getRotation());
                    showFeaturePopup(map,{ icon: it.icon, title: it.name, badge: it.badge, desc: it.desc, images: it.images, lng: it.lng, lat: it.lat });
                    if (it.type === 'route' && it.pts) startGuide(it.pts, it.color, it.name);
                }
                return;
            }
            const lng = parseFloat(item.dataset.lng), lat = parseFloat(item.dataset.lat);
            if (lng && lat) {
                map.setZoomAndCenter(18, [lng, lat]);
                searchResults.style.display = 'none';
                searchInput.value = item.textContent.replace('📍 ', '');
            }
        });
        document.addEventListener('click', (e) => { if (!e.target.closest('.sb-search')) searchResults.style.display = 'none'; });
    });

    map.on('click', (e) => {
        // 刚点击了路线/区域覆盖物时，不触发这里的 hideInfo（避免信息卡闪退）
        if (performance.now() < state.suppressMapClickUntil) return;
        const clicked = e.lnglat;
        state.ui.hideInfo();
        // 逆地理编码：点击空白处显示地址（官方 AMap.Geocoder）
        if (state.geocoder) {
            state.geocoder.getAddress([clicked.lng, clicked.lat], (status, result) => {
                if (status === 'complete' && result && result.regeocode) {
                    const addr = result.regeocode.formattedAddress || '';
                    if (addr) toast('📍 ' + addr);
                }
            });
        }
    });

    // Smooth camera animation helper
    function flyTo(targetLngLat, targetZoom, targetPitch, targetRotation, duration = 1200) {
        const startZoom = map.getZoom();
        const startPitch = map.getPitch();
        const startRotation = map.getRotation();
        const startCenter = map.getCenter();
        const startTime = performance.now();

        return new Promise(resolve => {
            function step(now) {
                const elapsed = now - startTime;
                const t = Math.min(elapsed / duration, 1);
                // easeInOutCubic
                const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

                map.setZoom(startZoom + (targetZoom - startZoom) * ease);
                map.setPitch(startPitch + (targetPitch - startPitch) * ease);
                map.setRotation(startRotation + (targetRotation - startRotation) * ease);

                const lng = startCenter.lng + (targetLngLat[0] - startCenter.lng) * ease;
                const lat = startCenter.lat + (targetLngLat[1] - startCenter.lat) * ease;
                map.setCenter([lng, lat]);

                if (t < 1) {
                    requestAnimationFrame(step);
                } else {
                    resolve();
                }
            }
            requestAnimationFrame(step);
        });
    }

    // Map style switching (bottom-right controls)
    const layerStyles = { dark: 'amap://styles/dark', normal: 'amap://styles/light', satellite: 'amap://styles/light' };
    let satelliteLayer = null;

    // 卫星图「隐藏路线」：切换流动虚线 + 路线名称标签的显隐
    function applyHideRoutes() {
        state.routeOverlays.forEach(o => {
            try {
                if (state.hideRoutes) o.setMap(null);
                else o.setMap(map);
            } catch (_) {}
        });
        const btn = document.getElementById('btn-hide-routes');
        if (btn) btn.textContent = state.hideRoutes ? '🛣️ 显示路线' : '🚫 隐藏路线';
    }
    const btnHideRoutes = document.getElementById('btn-hide-routes');
    if (btnHideRoutes) btnHideRoutes.addEventListener('click', () => { state.hideRoutes = !state.hideRoutes; applyHideRoutes(); });

    document.querySelectorAll('#bottom-controls button[data-layer]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#bottom-controls button[data-layer]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const layer = btn.dataset.layer;
            const visGroup = document.getElementById('route-visibility');
            if (layer === 'satellite') {
                // 卫星层只 add 一次，之后用 show/hide 切换；绝不用 setLayers 替换底图
                //（否则底图被换成默认栅格层，setMapStyle 切不回暗黑/标准矢量样式）
                if (!satelliteLayer) { satelliteLayer = new AMap.TileLayer.Satellite(); map.add(satelliteLayer); }
                satelliteLayer.show();
                if (visGroup) visGroup.style.display = '';   // 卫星图下显示「隐藏路线」开关
            } else {
                // 非卫星：隐藏卫星层，用 setMapStyle 切回矢量样式（暗黑/标准）
                if (satelliteLayer) { try { satelliteLayer.hide(); } catch (_) {} }
                map.setMapStyle(layerStyles[layer] || 'amap://styles/dark');
                if (visGroup) visGroup.style.display = 'none';
                // 离开卫星图自动恢复显示路线
                if (state.hideRoutes) { state.hideRoutes = false; applyHideRoutes(); }
            }
        });
    });

    // 2D/3D toggle (bottom-right controls)
    let savedPitch = state.CONFIG.geo.pitch || 55;
    let savedRotation = state.CONFIG.geo.rotation || 20;
    document.querySelectorAll('#bottom-controls button[data-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#bottom-controls button[data-mode]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (btn.dataset.mode === '2d') {
                savedPitch = map.getPitch() || savedPitch;
                savedRotation = map.getRotation() || 0;
                map.setPitch(0);
                map.setRotation(0);
            } else {
                map.setPitch(savedPitch);
                map.setRotation(savedRotation);
            }
        });
    });

    // 视角预设：飞至后台配置的相机视角
    function applyPreset(name) {
        const p = state.CONFIG.camera.presets && state.CONFIG.camera.presets[name];
        if (!p) return;
        const target = localToLngLat(p.target[0], p.target[2], state.CONFIG.geo.center);
        const dx = p.pos[0] - p.target[0];
        const dy = p.pos[1] - p.target[1];
        const dz = p.pos[2] - p.target[2];
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const pitch = Math.round(Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI);
        const zoom = Math.max(14, Math.min(20, 19 - Math.log2(dist)));
        map.setZoomAndCenter(zoom, target);
        map.setPitch(Math.max(0, Math.min(80, pitch)));
        map.setRotation(state.CONFIG.geo.rotation || 20);
        document.querySelectorAll('#camera-presets button').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    }
    function renderCameraPresets() {
        const container = document.getElementById('camera-presets');
        if (!container) return;
        const presets = Object.entries(state.CONFIG.camera.presets || {});
        container.innerHTML = '';
        if (!presets.length) { container.style.display = 'none'; return; }
        container.style.display = 'flex';
        for (const [name] of presets) {
            const btn = document.createElement('button');
            btn.textContent = name;
            btn.dataset.preset = name;
            btn.addEventListener('click', () => applyPreset(name));
            container.appendChild(btn);
        }
    }
    renderCameraPresets();

    // Auto-rotate (orbit the Amap camera)
    let autoRotate = false;
    let rotationAngle = state.CONFIG.geo.rotation || 20;
    document.getElementById('btn-auto-rotate').addEventListener('click', () => {
        autoRotate = !autoRotate;
        const btn = document.getElementById('btn-auto-rotate');
        if (autoRotate) { btn.textContent = '⏸'; btn.style.color = 'var(--accent-main)'; }
        else { btn.textContent = '⟳'; btn.style.color = ''; }
    });

    // —— 手机端侧边栏抽屉 ——
    const sidebarEl = document.getElementById('sidebar');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    const btnMenu = document.getElementById('btn-menu');
    function closeSidebar() {
        if (sidebarEl) sidebarEl.classList.remove('open');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('show');
    }
    function toggleSidebar() {
        if (sidebarEl && sidebarEl.classList.contains('open')) closeSidebar();
        else {
            if (sidebarEl) sidebarEl.classList.add('open');
            if (sidebarBackdrop) sidebarBackdrop.classList.add('show');
        }
    }
    if (btnMenu) btnMenu.addEventListener('click', toggleSidebar);
    if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeSidebar);
    // 选中方案/搜索结果后自动收起抽屉
    document.addEventListener('click', e => {
        if (window.innerWidth > 768) return;
        if (e.target.closest('.plan-item') || e.target.closest('.search-item')) closeSidebar();
    });

    // Animation loop — update objects, trigger GLCustomLayer render
    const clock = new THREE.Clock();
    function animate() {
        requestAnimationFrame(animate);
        const dt = Math.min(clock.getDelta(), 0.1);
        const elapsed = clock.elapsedTime;

        let needsRender = false;

        // Auto-rotate
        if (autoRotate) {
            rotationAngle += dt * 8;
            map.setRotation(rotationAngle % 360);
            needsRender = true;
        }

        // Pulse marker rings & cones（预收集数组，避免每帧全场景 scene.children 字符串比较）
        for (const ring of state.pulseRings) {
            const s = 1 + 0.25 * Math.sin(elapsed * 2.2 + ring.userData.phase);
            ring.scale.set(s, s, 1);
            ring.material.opacity = 0.25 + 0.2 * Math.sin(elapsed * 2.2 + ring.userData.phase);
        }
        for (const cone of state.pulseCones) {
            const base = cone.userData.baseEmissive;
            cone.material.emissiveIntensity = base + 0.3 * Math.sin(elapsed * 2.5 + (cone.userData.phase || 0));
        }
        if (state.pulseRings.length || state.pulseCones.length) needsRender = true;

        // 引导光点漫游跟随时会 setCenter，需重绘（ripple/flow 走各自 Canvas 覆盖层，不依赖 map.render）
        if (state.guide) needsRender = true;

        // 仅在有动画活动时触发 Amap 重绘（→ GLCustomLayer.render() → Three.js 渲染），静止零重绘
        if (needsRender) map.render();
    }

    // 就绪，立即收起加载屏（去掉人为 500ms 延迟）
    state.ui.setProgress('就绪', 100);
    state.ui.hideLoading();

    // Start animation loop
    animate();

    // Resize
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        labelRenderer.setSize(window.innerWidth, window.innerHeight);
        resizeFlowLayer();
        resizeRippleLayer();
    });

    console.log('✅ ' + (state.CONFIG.brand?.name||'3D 智慧导览') + ' 已就绪');
    console.log('   🗺️  高德地图底图 + Three.js 3D 叠加层');
    console.log('   📍 点击入口标记查看详情');
    console.log('   🎯 右侧按钮切换视角');
    console.log('   🅿️  右下角查看停车位实时数据');
    console.log('   🌓 右下角切换地图样式');
}
