// ========================================================
// indoor.js — 导览方案加载/叠加 + 室内方案 3D 楼层悬浮 + 室内寻路
// 支持多方案同时叠加、勾选记忆（localStorage）
// ========================================================
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { state, authHeaders, PLAN_DEFAULT_W, PLAN_DEFAULT_H, PLAN_MEMORY_KEY, FLOOR_MEMORY_KEY, BUILDING_MEMORY_KEY, LAYER_HEIGHT } from './state.js';
import { METERS_PER_DEG_LAT, planPointToLngLat, rotatedBounds, bakeRotatedImage, rectCorners, defaultPlanBounds } from './coords.js';
import { addFlowRoute, removeFlowRoute, startGuide } from './flow.js';
import { rebuildLocaIfActive } from './loca.js';
import { onFeatureClick, showFeaturePopup } from './route.js';

// 统一销毁图层/覆盖物：Layer 用 setMap(null)，Overlay 用 map.remove
function disposeOverlay(o, map) {
    try {
        const i = state.routeOverlays.indexOf(o);
        if (i >= 0) state.routeOverlays.splice(i, 1);
        if (o && typeof o.setMap === 'function') o.setMap(null);
        else if (o) map.remove(o);
    } catch (_) {}
}

/** 地图上放置名称标签（AMap.Text）：白字 + 半透明深底，可读 */
function addNameLabel(map, text, lngLat, anchor, offsetPx) {
    if (!text) return null;
    const t = new AMap.Text({
        text,
        position: new AMap.LngLat(lngLat[0], lngLat[1]),
        anchor: anchor || 'center',
        offset: offsetPx ? new AMap.Pixel(offsetPx[0], offsetPx[1]) : new AMap.Pixel(0, 0),
        style: {
            'background-color': 'rgba(0,0,0,0.62)',
            'color': '#ffffff',
            'font-size': '12px',
            'font-weight': '600',
            'padding': '3px 8px',
            'border-radius': '4px',
            'border': '1px solid rgba(255,255,255,0.22)',
        },
        zIndex: 20,
    });
    map.add(t);
    return t;
}

// 递归清理 3D 楼层悬浮对象：Three r160 的 CSS2DRenderer 只 append 不清理，对象脱离 scene 后其 DOM
// 仍挂在 domElement 上（停留在最后渲染位置），需手动移除，否则文字标签残留屏幕；顺带 dispose 几何体/材质
function disposeThreeGroup(group) {
    if (!group) return;
    group.traverse(obj => {
        if (obj.isCSS2DObject && obj.element) {
            try {
                const el = obj.element;
                if (el.parentNode) el.parentNode.removeChild(el);
                else if (el.remove) el.remove();
            } catch (_) {}
        }
        if (obj.geometry && obj.geometry.dispose) { try { obj.geometry.dispose(); } catch (_) {} }
        if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => {
                if (!m) return;
                // 释放材质引用的纹理（室内方案底图等），避免 GPU 显存泄漏
                ['map', 'emissiveMap', 'alphaMap', 'roughnessMap', 'metalnessMap', 'normalMap', 'bumpMap', 'aoMap', 'envMap', 'lightMap'].forEach(k => {
                    const t = m[k];
                    if (t && t.isTexture && t.dispose) { try { t.dispose(); } catch (_) {} }
                });
                if (m.dispose) { try { m.dispose(); } catch (_) {} }
            });
        }
    });
}

export function removePlanOverlay(map, planId) {
    const g = state.planOverlayGroups[planId];
    if (!g) return;
    g.overlays.forEach(o => disposeOverlay(o, map));
    // 移除 3D 楼层悬浮对象（含 CSS2D 标签 DOM + 几何体/材质）
    if (g.threeGroup && state.threeCtx) {
        try {
            disposeThreeGroup(g.threeGroup);
            state.threeCtx.scene.remove(g.threeGroup);
        } catch (_) {}
    }
    // 移除该方案的流动虚线
    (g.flowIds || []).forEach(id => removeFlowRoute(id));
    delete state.planOverlayGroups[planId];
    delete state.activePlanData[planId];
}

// 3D 楼层悬浮：把室内方案的背景图 + 元素渲染到 Three.js 场景的指定高度（米）
// 关键：几何体用「本地米」坐标（相对方案锚点），group 的 position/scale 由 updateTransform
// 用 lngLatToCoord 算一次锚定——lngLatToCoord 基于 setCenter 的固定坐标系，随缩放/平移/旋转/俯仰稳定，
// 相机每帧由 getCameraParams 同步，悬浮层因此始终贴地锚定、不随鼠标漂移
function renderIndoorPlan3D(data, heightM, group) {
    const areaW = data.imageWidth || PLAN_DEFAULT_W;
    const areaH = data.imageHeight || PLAN_DEFAULT_H;
    const bounds = data.geoBounds || defaultPlanBounds();
    const threeGroup = new THREE.Group();
    group.threeGroup = threeGroup;
    state.threeCtx.scene.add(threeGroup);

    // 方案地理锚点（geoBounds 中心）；旋转已烘焙进 pixel→lng/lat 与底图旋转，无需再转 group
    const anchorLng = (bounds.nw[0] + bounds.se[0]) / 2;
    const anchorLat = (bounds.nw[1] + bounds.se[1]) / 2;
    const rot = bounds.rotation || 0;
    const mPerDegLng = METERS_PER_DEG_LAT * Math.cos(anchorLat * Math.PI / 180);

    // 经纬度 → 本地米（x=东, y=北, 相对锚点）
    const lngLatToLocalM = (lng, lat) => ({ x: (lng - anchorLng) * mPerDegLng, y: (lat - anchorLat) * METERS_PER_DEG_LAT });
    // 像素 → 本地米
    const pxToLocalM = (x, y) => {
        const ll = planPointToLngLat(x, y, bounds, areaW, areaH);
        return lngLatToLocalM(ll[0], ll[1]);
    };

    // 底图 Plane（本地米，水平 XY 平面，z=0；楼层高度由 group.position.z 体现）
    const applyPlane = (url, wMeters, hMeters, cx, cy) => {
        const tex = new THREE.TextureLoader().load(url);
        if ('SRGBColorSpace' in THREE) tex.colorSpace = THREE.SRGBColorSpace;
        const geo = new THREE.PlaneGeometry(wMeters, hMeters);
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: data.bgOpacity ?? 1, side: THREE.DoubleSide, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(cx, cy, 0);
        mesh.renderOrder = Math.round(heightM);
        threeGroup.add(mesh);
    };

    if (data.backgroundImage) {
        if (rot) {
            const rb = rotatedBounds(bounds, areaW, areaH);
            const cLng = (rb.nw[0] + rb.se[0]) / 2, cLat = (rb.nw[1] + rb.se[1]) / 2;
            const wMeters = (rb.se[0] - rb.nw[0]) * METERS_PER_DEG_LAT * Math.cos(cLat * Math.PI / 180);
            const hMeters = (rb.nw[1] - rb.se[1]) * METERS_PER_DEG_LAT;
            const c = lngLatToLocalM(cLng, cLat);
            bakeRotatedImage(data.backgroundImage, areaW, areaH, rot).then(url => applyPlane(url, wMeters, hMeters, c.x, c.y)).catch(() => {});
        } else {
            const wMeters = (bounds.se[0] - bounds.nw[0]) * mPerDegLng;
            const hMeters = (bounds.nw[1] - bounds.se[1]) * METERS_PER_DEG_LAT;
            applyPlane(data.backgroundImage, wMeters, hMeters, 0, 0);
        }
    }

    // 元素（线 / 面 / 文字），本地米坐标，z=0
    (Array.isArray(data.elements) ? data.elements : []).forEach(el => {
        if (el.visible === false) return;
        if (el.type === 'route' && (el.points || []).length >= 2) {
            const pts = (el.points || []).map(p => pxToLocalM(p.x, p.y));
            const pos = new Float32Array(pts.length * 3);
            pts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = 0; });
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: colorToHex(el.color, '#3b82f6'), transparent: true, opacity: el.opacity ?? 0.9 }));
            threeGroup.add(line);
        } else if (el.type === 'area' && (el.points || []).length >= 3) {
            const pts = (el.points || []).map(p => pxToLocalM(p.x, p.y));
            const shape = new THREE.Shape();
            shape.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
            shape.closePath();
            const fill = new THREE.Mesh(
                new THREE.ShapeGeometry(shape),
                new THREE.MeshBasicMaterial({ color: colorToHex(el.color, '#10b981'), transparent: true, opacity: (el.opacity ?? 1) * 0.25, side: THREE.DoubleSide, depthWrite: false })
            );
            fill.renderOrder = Math.round(heightM);
            threeGroup.add(fill);
            const edgePos = new Float32Array(pts.length * 3);
            pts.forEach((p, i) => { edgePos[i * 3] = p.x; edgePos[i * 3 + 1] = p.y; edgePos[i * 3 + 2] = 0; });
            const edgeGeo = new THREE.BufferGeometry();
            edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
            threeGroup.add(new THREE.LineLoop(edgeGeo, new THREE.LineBasicMaterial({ color: colorToHex(el.color, '#10b981') })));
        } else if (el.type === 'text' && (el.points || []).length >= 1) {
            const p = pxToLocalM(el.points[0].x, el.points[0].y);
            const div = document.createElement('div');
            div.textContent = el.label || '';
            div.style.cssText = 'color:' + (el.color || '#fff') + ';font-size:' + (el.fontSize || 14) + 'px;font-weight:600;background:' + (el.backgroundColor || 'rgba(0,0,0,0.7)') + ';padding:4px 8px;border-radius:4px;white-space:nowrap;';
            const label = new CSS2DObject(div);
            label.position.set(p.x, p.y, 0);
            threeGroup.add(label);
        } else if (el.type === 'stair' && (el.points || []).length >= 1) {
            const p = pxToLocalM(el.points[0].x, el.points[0].y);
            const div = document.createElement('div');
            div.textContent = el.name || '楼梯';
            div.style.cssText = 'color:#fff;font-size:12px;font-weight:600;background:' + (el.color || '#8b5cf6') + ';padding:3px 7px;border-radius:4px;white-space:nowrap;border:1px solid rgba(255,255,255,0.6);';
            const label = new CSS2DObject(div);
            label.position.set(p.x, p.y, 0);
            threeGroup.add(label);
        }
    });

    // 锚点经纬度 → 世界坐标（lngLatToCoord 基于 setCenter 固定坐标系，只需算一次）
    threeGroup.userData.anchor = [anchorLng, anchorLat];
    threeGroup.userData.heightM = heightM;
    threeGroup.updateTransform = (cc, lpm) => {
        const c = cc.lngLatToCoord([anchorLng, anchorLat]);
        threeGroup.position.set(c[0], c[1], heightM * lpm);
        threeGroup.scale.setScalar(lpm);
    };
    // 立即算一次，避免首帧出现在 (0,0,0)
    try { threeGroup.updateTransform(state.threeCtx.customCoords, state.threeCtx.lpm); } catch (_) {}

    return threeGroup;
}

export function applyPlan(map, plan) {
    removePlanOverlay(map, plan.id);
    const overlays = [];
    const group = { overlays, route: 0, area: 0, rect: 0, circle: 0, ellipse: 0, text: 0, flowIds: [] };
    state.planOverlayGroups[plan.id] = group;

    const data = plan.data || {};
    state.activePlanData[plan.id] = data;   // 缓存方案数据，供 Loca 特效读取

    // 「地图绘制」方案：routes/areas 直接存经纬度 [lng, lat]，无需底图对齐
    if (data.kind === 'map') {
        let added = 0;
        if (data.routes) {
            Object.entries(data.routes).forEach(([name, r]) => {
                if (!r.pts || r.pts.length < 2) return;
                const path = r.pts.map(p => new AMap.LngLat(p[0], p[1]));
                const o = new AMap.Polyline({ path, strokeColor: colorToHex(r.color), strokeWeight: 8, strokeOpacity: 0.01, zIndex: 10 });
                o.on('click', (e) => onFeatureClick(e, () => { const mp = r.pts[Math.floor(r.pts.length / 2)]; showFeaturePopup(map,{ icon: '🛣️', title: name, badge: '路线', desc: r.desc || '', images: r.images || [], lng: mp[0], lat: mp[1] }); startGuide(r.pts, r.color, name); }));
                map.add(o); overlays.push(o); group.route++; added++;
                // 流动虚线（Canvas 层绘制，严格贴线）
                const flowId = 'plan:' + plan.id + ':' + name;
                addFlowRoute(flowId, r.pts, r.color, r.strokeWidth || 3, r.speed, r.direction);
                group.flowIds.push(flowId);
                // 路线名称标签（中点）
                const mid = r.pts[Math.floor(r.pts.length / 2)];
                const lbl = addNameLabel(map, name, mid, 'center');
                overlays.push(lbl);
                state.routeOverlays.push(o, lbl);
            });
        }
        if (data.areas) {
            Object.entries(data.areas).forEach(([name, a]) => {
                if (!a.pts || a.pts.length < 3) return;
                const path = a.pts.map(p => new AMap.LngLat(p[0], p[1]));
                const o = new AMap.Polygon({ path, strokeColor: colorToHex(a.color, '#10b981'), strokeWeight: a.strokeWidth || 2, fillColor: colorToHex(a.color, '#10b981'), fillOpacity: a.opacity ?? 0.2, zIndex: 5 });
                o.on('click', (e) => onFeatureClick(e, () => { let ax = 0, ay = 0; a.pts.forEach(p => { ax += p[0]; ay += p[1]; }); showFeaturePopup(map,{ icon: '🗺️', title: name, badge: '区域', desc: a.desc || '', images: a.images || [], lng: ax / a.pts.length, lat: ay / a.pts.length }); }));
                map.add(o); overlays.push(o); group.area++; added++;
                // 区域名称标签（质心）
                let cx = 0, cy = 0;
                a.pts.forEach(p => { cx += p[0]; cy += p[1]; });
                cx /= a.pts.length; cy /= a.pts.length;
                overlays.push(addNameLabel(map, name, [cx, cy], 'center'));
            });
        }
        if (data.markers) {
            Object.entries(data.markers).forEach(([name, m]) => {
                if (m.lng == null || m.lat == null) return;
                const color = colorToHex(m.color, '#f59e0b');
                const mk = new AMap.Marker({
                    position: new AMap.LngLat(m.lng, m.lat),
                    content: '<div style="width:12px;height:12px;background:' + color + ';border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,0.6)"></div>',
                    offset: new AMap.Pixel(-8, -8),
                    zIndex: 15,
                });
                mk.on('click', (e) => onFeatureClick(e, () => showFeaturePopup(map,{ icon: '📍', title: name, badge: '标记点', desc: m.desc || '', images: m.images || [], lng: m.lng, lat: m.lat })));
                map.add(mk);
                overlays.push(mk); added++;
                // 标记点名称标签（圆点下方）
                overlays.push(addNameLabel(map, name, [m.lng, m.lat], 'top-center', [0, 10]));
            });
        }
        if (data.rects) {
            Object.entries(data.rects).forEach(([name, r]) => {
                if (!r.bounds || !r.bounds[0] || !r.bounds[1]) return;
                const rot = r.rotation || 0;
                const o = rot
                    ? new AMap.Polygon({ path: rectCorners(r.bounds, rot), strokeColor: colorToHex(r.color, '#8b5cf6'), strokeWeight: r.strokeWidth || 2, fillColor: colorToHex(r.color, '#8b5cf6'), fillOpacity: r.opacity ?? 0.2, zIndex: 5 })
                    : new AMap.Rectangle({ bounds: new AMap.Bounds(r.bounds[0], r.bounds[1]), strokeColor: colorToHex(r.color, '#8b5cf6'), strokeWeight: r.strokeWidth || 2, fillColor: colorToHex(r.color, '#8b5cf6'), fillOpacity: r.opacity ?? 0.2, zIndex: 5 });
                o.on('click', (e) => onFeatureClick(e, () => showFeaturePopup(map,{ icon: '▭', title: name, badge: '画框', desc: r.desc || '', images: r.images || [], lng: (r.bounds[0][0] + r.bounds[1][0]) / 2, lat: (r.bounds[0][1] + r.bounds[1][1]) / 2 })));
                map.add(o); overlays.push(o); group.rect++; added++;
                const c = [(r.bounds[0][0] + r.bounds[1][0]) / 2, (r.bounds[0][1] + r.bounds[1][1]) / 2];
                overlays.push(addNameLabel(map, name, c, 'center'));
            });
        }
        if (data.circles) {
            Object.entries(data.circles).forEach(([name, c]) => {
                if (!c.center || c.radius == null) return;
                const o = new AMap.Circle({ center: c.center, radius: c.radius, strokeColor: colorToHex(c.color, '#ec4899'), strokeWeight: c.strokeWidth || 2, fillColor: colorToHex(c.color, '#ec4899'), fillOpacity: c.opacity ?? 0.2, zIndex: 5 });
                o.on('click', (e) => onFeatureClick(e, () => showFeaturePopup(map,{ icon: '◯', title: name, badge: '画圆', desc: c.desc || '', images: c.images || [], lng: c.center[0], lat: c.center[1] })));
                map.add(o); overlays.push(o); group.circle++; added++;
                overlays.push(addNameLabel(map, name, c.center, 'center'));
            });
        }
        if (data.ellipses) {
            Object.entries(data.ellipses).forEach(([name, e]) => {
                if (!e.center || e.radius == null) return;
                const r = Array.isArray(e.radius) ? e.radius : [e.radius, e.radius];
                const o = new AMap.Ellipse({ center: e.center, radius: r, strokeColor: colorToHex(e.color, '#06b6d4'), strokeWeight: e.strokeWidth || 2, fillColor: colorToHex(e.color, '#06b6d4'), fillOpacity: e.opacity ?? 0.2, zIndex: 5 });
                o.on('click', (ev) => onFeatureClick(ev, () => showFeaturePopup(map,{ icon: '⬭', title: name, badge: '椭圆', desc: e.desc || '', images: e.images || [], lng: e.center[0], lat: e.center[1] })));
                map.add(o); overlays.push(o); group.ellipse++; added++;
                overlays.push(addNameLabel(map, name, e.center, 'center'));
            });
        }
        if (data.texts) {
            Object.entries(data.texts).forEach(([name, t]) => {
                if (t.lng == null || t.lat == null) return;
                const o = new AMap.Text({ text: name, position: new AMap.LngLat(t.lng, t.lat), anchor: 'center', style: { 'color': t.color || '#ffffff', 'font-size': '14px', 'font-weight': '600', 'background-color': 'rgba(0,0,0,0.55)', 'padding': '3px 8px', 'border-radius': '4px', 'border': '1px solid rgba(255,255,255,0.25)' }, zIndex: 20 });
                map.add(o); overlays.push(o); group.text++; added++;
            });
        }
        return overlays.length;
    }

    // 室内方案：有楼层 + Three.js 就绪 → 3D 楼层悬浮；否则回退 2D 贴地
    if (floorOf(plan) >= 1 && state.threeCtx) {
        renderIndoorPlan3D(data, (floorOf(plan) - 1) * LAYER_HEIGHT, group);
        return overlays.length;   // 3D 对象计入 group.threeGroup，不占 2D overlays
    }

    const els = Array.isArray(data.elements) ? data.elements : [];
    const areaW = data.imageWidth || PLAN_DEFAULT_W;
    const areaH = data.imageHeight || PLAN_DEFAULT_H;
    const bounds = data.geoBounds || defaultPlanBounds();

    // 底图：场地平面图，按 geoBounds 对齐到地图（支持旋转烘焙）
    if (data.backgroundImage) {
        const rot = bounds.rotation || 0;
        const bbox = rotatedBounds(bounds, areaW, areaH);
        const makeLayer = (url) => {
            try {
                const imgLayer = new AMap.ImageLayer({
                    url,
                    bounds: new AMap.Bounds(
                        new AMap.LngLat(bbox.nw[0], bbox.nw[1]),
                        new AMap.LngLat(bbox.se[0], bbox.se[1])
                    ),
                    opacity: data.bgOpacity ?? 1,
                    zooms: [3, 20],
                    zIndex: 1,
                });
                imgLayer.setMap(map);
                overlays.push(imgLayer);
            } catch (err) {
                console.warn('⚠️ 底图叠加失败:', err.message);
            }
        };
        if (rot) {
            bakeRotatedImage(data.backgroundImage, areaW, areaH, rot).then(url => {
                if (state.planOverlayGroups[plan.id] !== group) return; // 方案已移除，丢弃
                makeLayer(url);
            }).catch(err => console.warn('⚠️ 底图旋转失败:', err.message));
        } else {
            makeLayer(data.backgroundImage);
        }
    }

    els.forEach(el => {
        if (el.visible === false) return;
        const pts = (el.points || []).map(p => planPointToLngLat(p.x, p.y, bounds, areaW, areaH));
        const path = pts.map(p => new AMap.LngLat(p[0], p[1]));
        let o = null;
        const title = el.label || el.name || '';
        if (el.type === 'route' && pts.length >= 2) {
            o = new AMap.Polyline({ path, strokeColor: colorToHex(el.color, '#3b82f6'), strokeWeight: el.strokeWidth || 3, strokeOpacity: el.opacity ?? 0.9, zIndex: 10 });
            const mid = pts[Math.floor(pts.length / 2)];
            o.on('click', (e) => onFeatureClick(e, () => showFeaturePopup(map,{ icon: '🛣️', title, badge: '路线', desc: '', images: [], lng: mid[0], lat: mid[1] })));
            group.route++;
        } else if (el.type === 'area' && pts.length >= 3) {
            o = new AMap.Polygon({ path, strokeColor: colorToHex(el.color, '#10b981'), strokeWeight: el.strokeWidth || 2, fillColor: colorToHex(el.color, '#10b981'), fillOpacity: (el.opacity ?? 1) * 0.25, zIndex: 5 });
            let ax = 0, ay = 0; pts.forEach(p => { ax += p[0]; ay += p[1]; });
            o.on('click', (e) => onFeatureClick(e, () => showFeaturePopup(map,{ icon: '🗺️', title, badge: '区域', desc: '', images: [], lng: ax / pts.length, lat: ay / pts.length })));
            group.area++;
        } else if (el.type === 'text' && pts.length >= 1) {
            o = new AMap.Text({
                text: el.label || '', position: new AMap.LngLat(pts[0][0], pts[0][1]),
                style: {
                    'background-color': el.backgroundColor || 'rgba(0,0,0,0.7)',
                    'color': el.color || '#ffffff', 'font-size': (el.fontSize || 16) + 'px',
                    'padding': '4px 8px', 'border-radius': '14px',
                },
            });
            o.on('click', (e) => onFeatureClick(e, () => showFeaturePopup(map,{ icon: '💬', title, badge: '文字', desc: '', images: [], lng: pts[0][0], lat: pts[0][1] })));
        } else if (el.type === 'stair' && pts.length >= 1) {
            const color = colorToHex(el.color, '#8b5cf6');
            o = new AMap.Marker({
                position: new AMap.LngLat(pts[0][0], pts[0][1]),
                content: '<div style="width:12px;height:12px;background:' + color + ';border:2px solid #fff;transform:rotate(45deg);border-radius:2px;box-shadow:0 0 6px rgba(0,0,0,0.6)"></div>',
                offset: new AMap.Pixel(-8, -8),
                zIndex: 18,
            });
            o.on('click', (e) => onFeatureClick(e, () => showFeaturePopup(map,{ icon: '🪜', title: title || '楼梯', badge: '楼梯', desc: '', images: [], lng: pts[0][0], lat: pts[0][1] })));
            const stairLbl = addNameLabel(map, title, [pts[0][0], pts[0][1]], 'top-center', [0, 12]);
            if (stairLbl) overlays.push(stairLbl);
            group.text++;
        }
        if (o) { map.add(o); overlays.push(o); }
    });
    return overlays.length;
}

export function getActivePlanIds() {
    try { return JSON.parse(localStorage.getItem(PLAN_MEMORY_KEY) || '[]'); }
    catch (_) { return []; }
}
export function saveActivePlanIds(ids) {
    try { localStorage.setItem(PLAN_MEMORY_KEY, JSON.stringify(ids)); } catch (_) {}
}

// 方案楼层：取 floor 字段，非法/缺失回退 0F（默认/未配置）
export function floorOf(p) { return (p.floor && Number(p.floor) > 0) ? Number(p.floor) : 0; }
export function buildingOf(p) { return (p.building && String(p.building).trim()) || ''; }

// ========================================================
// 室内寻路：同楼跨层 Dijkstra 最短路径（indoor-nav.js 内核）
// 楼内沿走廊/楼梯走比高德步行更真实；与「路径导航」的户外路线互补
// ========================================================

// 解析室内寻路目标建筑：''=全部时若仅一栋则自动取之
function resolveIndoorBuilding() {
    const blds = [...new Set(state.planProjects
        .filter(p => !(p.data && p.data.kind === 'map') && buildingOf(p))
        .map(buildingOf))].sort();
    if (state.currentBuilding) return state.currentBuilding;
    if (blds.length === 1) return blds[0];
    return '';
}

// 拉取目标建筑所有楼层方案 + 收集可路由点位（房间 area / 楼梯 stair）
async function loadIndoorBuilding(building) {
    const floorPlans = state.planProjects.filter(p => !(p.data && p.data.kind === 'map') && buildingOf(p) === building);
    const loaded = await Promise.all(floorPlans.map(p => fetchPlanData(p.id)));
    const plans = [];
    const pois = [];
    floorPlans.forEach((p, i) => {
        const proj = loaded[i];
        const data = (proj && proj.data) || {};
        const els = Array.isArray(data.elements) ? data.elements : [];
        const floor = floorOf(p);
        plans.push({ floor, elements: els, data });
        for (const el of els) {
            if (el.visible === false) continue;
            if (el.type === 'area' && (el.points || []).length >= 3) {
                const name = el.name || el.label || '';
                if (name) pois.push({ floor, name, type: 'area', elementId: el.id });
            } else if (el.type === 'stair' && (el.points || []).length >= 1) {
                const name = el.name || el.label || '';
                if (name) pois.push({ floor, name, type: 'stair', elementId: el.id });
            }
        }
    });
    plans.sort((a, b) => a.floor - b.floor);
    pois.sort((a, b) => (a.floor - b.floor) || a.name.localeCompare(b.name, 'zh'));
    return { plans, pois };
}

// 刷新下拉选项（切换建筑 / 方案列表变化时调用）
async function refreshIndoorNavPois() {
    const startSel = document.getElementById('indoor-nav-start');
    const endSel = document.getElementById('indoor-nav-end');
    const hint = document.getElementById('indoor-nav-hint');
    if (!startSel || !endSel) return;
    const building = resolveIndoorBuilding();
    state.indoorNavPois = [];
    if (!building) {
        const blds = [...new Set(state.planProjects.filter(p => !(p.data && p.data.kind === 'map') && buildingOf(p)).map(buildingOf))];
        if (hint) hint.textContent = blds.length > 1 ? '请先在「方案」面板选择一栋建筑' : '暂无室内方案（需在编辑器绘制房间/楼梯）';
        startSel.innerHTML = '<option value="">请选择</option>';
        endSel.innerHTML = '<option value="">请选择</option>';
        return;
    }
    if (hint) hint.textContent = '';
    try {
        const { pois } = await loadIndoorBuilding(building);
        state.indoorNavPois = pois;
        const opts = pois.map((p, idx) => `<option value="${idx}">${p.floor}F · ${p.name}</option>`).join('');
        startSel.innerHTML = '<option value="">请选择</option>' + opts;
        endSel.innerHTML = '<option value="">请选择</option>' + opts;
    } catch (_) {
        state.indoorNavPois = [];
    }
}

function clearIndoorPath() {
    if (state.indoorPathGroup && state.threeCtx) {
        try { disposeThreeGroup(state.indoorPathGroup); state.threeCtx.scene.remove(state.indoorPathGroup); } catch (_) {}
    }
    state.indoorPathGroup = null;
}

// 像素→本地米（与 renderIndoorPlan3D 同一换算；同楼各层共享 geoBounds）
function indoorPlanLocalTransform(plans) {
    const meta = plans.find(p => p.data && p.data.geoBounds) || null;
    if (!meta || !meta.data || !meta.data.geoBounds) return null;
    const data = meta.data;
    const areaW = data.imageWidth || PLAN_DEFAULT_W;
    const areaH = data.imageHeight || PLAN_DEFAULT_H;
    const bounds = data.geoBounds;
    const anchorLng = (bounds.nw[0] + bounds.se[0]) / 2;
    const anchorLat = (bounds.nw[1] + bounds.se[1]) / 2;
    const mPerDegLng = METERS_PER_DEG_LAT * Math.cos(anchorLat * Math.PI / 180);
    const pxToLocalM = (x, y) => {
        const ll = planPointToLngLat(x, y, bounds, areaW, areaH);
        return { x: (ll[0] - anchorLng) * mPerDegLng, y: (ll[1] - anchorLat) * METERS_PER_DEG_LAT };
    };
    return { pxToLocalM, anchorLng, anchorLat };
}

// 把室内路径画成 3D 折线（每层高度 (floor-1)*LAYER_HEIGHT，楼梯段呈斜线上升）
function renderIndoorPath3D(path, plans) {
    if (!state.threeCtx || !path || path.length < 2) return;
    clearIndoorPath();
    const t = indoorPlanLocalTransform(plans);
    if (!t) return;
    const { pxToLocalM, anchorLng, anchorLat } = t;

    const group = new THREE.Group();
    const pts = path.map(n => {
        const m = pxToLocalM(n.x, n.y);
        return new THREE.Vector3(m.x, m.y, (n.floor - 1) * LAYER_HEIGHT);
    });
    group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.95 })
    ));

    // 每个路径节点补一个小光点，标记经过的楼层/楼梯
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9 });
    path.forEach(n => {
        const m = pxToLocalM(n.x, n.y);
        const sp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 10), dotMat);
        sp.position.set(m.x, m.y, (n.floor - 1) * LAYER_HEIGHT);
        group.add(sp);
    });

    group.userData.anchor = [anchorLng, anchorLat];
    group.updateTransform = (cc, lpm) => {
        const c = cc.lngLatToCoord([anchorLng, anchorLat]);
        group.position.set(c[0], c[1], 0);
        group.scale.setScalar(lpm);
    };
    state.threeCtx.scene.add(group);
    try { group.updateTransform(state.threeCtx.customCoords, state.threeCtx.lpm); } catch (_) {}
    state.indoorPathGroup = group;
}

async function computeIndoorRoute() {
    const resultEl = document.getElementById('indoor-nav-result');
    const startSel = document.getElementById('indoor-nav-start');
    const endSel = document.getElementById('indoor-nav-end');
    if (!startSel || !endSel) return;
    if (!window.IndoorNav) { if (resultEl) resultEl.textContent = '⚠️ 室内寻路内核未加载'; return; }

    const s = state.indoorNavPois[+startSel.value];
    const e = state.indoorNavPois[+endSel.value];
    if (!s || !e) { if (resultEl) resultEl.textContent = '请选择起点和终点'; return; }
    if (s.floor === e.floor && s.elementId === e.elementId) { if (resultEl) resultEl.textContent = '起点和终点相同'; return; }

    const building = resolveIndoorBuilding();
    if (!building) { toast('⚠️ 请先在「方案」面板选择一栋建筑'); return; }

    clearIndoorPath();
    if (resultEl) resultEl.textContent = '计算中…';

    const { plans } = await loadIndoorBuilding(building);
    const graph = window.IndoorNav.buildGraph(plans.map(p => ({ floor: p.floor, elements: p.elements })));
    const nodeTypeOf = type => (type === 'area' ? 'room' : 'stair');
    const startNode = graph.nodes.find(n => n.floor === s.floor && n.type === nodeTypeOf(s.type) && n.elementId === s.elementId);
    const endNode = graph.nodes.find(n => n.floor === e.floor && n.type === nodeTypeOf(e.type) && n.elementId === e.elementId);
    if (!startNode || !endNode) { if (resultEl) resultEl.textContent = '⚠️ 未在楼内找到该点位（可能未连到走廊）'; return; }

    const res = window.IndoorNav.findPath(graph, startNode.id, endNode.id);
    if (!res) { if (resultEl) resultEl.textContent = '⚠️ 无法到达（可能缺少楼梯连接）'; return; }

    const stairCount = res.path.filter(n => n.type === 'stair').length;
    const steps = res.path.filter(n => n.type !== 'corridor')
        .map(n => `${n.floor}F ${n.type === 'stair' ? '🪜' + n.name : n.name}`).join(' → ');
    if (resultEl) resultEl.textContent = `约 ${Math.round(res.distance)} 米 · 跨 ${res.floorsCrossed} 层 · 经 ${stairCount} 处楼梯\n${steps}`;
    renderIndoorPath3D(res.path, plans);
}

export function initIndoorNav() {
    const btn = document.getElementById('btn-indoor-nav');
    if (btn) btn.addEventListener('click', computeIndoorRoute);
    const startSel = document.getElementById('indoor-nav-start');
    const endSel = document.getElementById('indoor-nav-end');
    const resultEl = document.getElementById('indoor-nav-result');
    const onPick = () => { if (resultEl) resultEl.textContent = ''; clearIndoorPath(); };
    if (startSel) startSel.addEventListener('change', onPick);
    if (endSel) endSel.addEventListener('change', onPick);
    refreshIndoorNavPois();
}

export function renderPlanList() {
    const active = new Set(getActivePlanIds().map(String));
    const mapPlans = state.planProjects.filter(p => p.data && p.data.kind === 'map');
    const indoorAll = state.planProjects.filter(p => !(p.data && p.data.kind === 'map'));
    const indoorPlans = indoorAll.filter(p => state.currentBuilding === '' || buildingOf(p) === state.currentBuilding);
    renderOnePlanList(document.getElementById('plan-list-map'), mapPlans, active);
    renderIndoorGrouped(document.getElementById('plan-list-indoor'), indoorPlans, active);
    renderBuildingSwitcher();
    renderFloorSwitcher();
}

// 室内方案按「建筑」分组渲染（每组一个组头，点击聚焦该建筑；''=未分组）
function renderIndoorGrouped(box, plans, active) {
    if (!box) return;
    box.innerHTML = '';
    if (plans.length === 0) {
        box.innerHTML = '<div style="font-size:0.72rem;color:rgba(255,255,255,0.35);padding:4px 0;">暂无方案</div>';
        return;
    }
    const groups = new Map();
    for (const p of plans) {
        const key = buildingOf(p);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
    }
    for (const [key, list] of groups) {
        const head = document.createElement('div');
        head.className = 'plan-building-head';
        head.textContent = '🏢 ' + (key || '未分组');
        if (key) {
            head.title = '点击只看这栋楼的方案';
            head.addEventListener('click', () => setBuilding(key));
        } else {
            head.title = '未分组方案';
        }
        box.appendChild(head);
        const sub = document.createElement('div');
        sub.className = 'plan-list';
        renderOnePlanList(sub, list, active);
        box.appendChild(sub);
    }
}

// 楼层互斥切换：收集所有 >0 的楼层，生成「全部 / 1F / 2F…」按钮；点某层只看该层方案
function renderFloorSwitcher() {
    const section = document.getElementById('floor-section');
    const box = document.getElementById('floor-switcher');
    if (!section || !box) return;
    // 楼层按钮只显示「当前建筑」下的楼层（''=全部建筑）
    const scope = state.planProjects.filter(p => state.currentBuilding === '' || buildingOf(p) === state.currentBuilding);
    const floors = [...new Set(scope.map(p => floorOf(p)).filter(f => f > 0))].sort((a, b) => a - b);
    if (floors.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    box.innerHTML = '';
    const mk = (label, val) => {
        const b = document.createElement('button');
        b.className = 'floor-btn';
        b.textContent = label;
        if (state.currentFloor === val) b.classList.add('active');
        b.addEventListener('click', () => setFloor(val));
        box.appendChild(b);
    };
    mk('全部', 0);
    floors.forEach(f => mk(f + 'F', f));
}

// 建筑互斥切换：收集所有建筑，生成「全部 / 楼A / 楼B…」按钮；≥2 个建筑才显示
function renderBuildingSwitcher() {
    const section = document.getElementById('building-section');
    const box = document.getElementById('building-switcher');
    if (!section || !box) return;
    const buildings = [...new Set(state.planProjects.map(buildingOf).filter(Boolean))].sort();
    if (buildings.length < 2) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    box.innerHTML = '';
    const mk = (label, val) => {
        const b = document.createElement('button');
        b.className = 'floor-btn';
        b.textContent = label;
        if (state.currentBuilding === val) b.classList.add('active');
        b.addEventListener('click', () => setBuilding(val));
        box.appendChild(b);
    };
    mk('全部', '');
    buildings.forEach(bn => mk(bn, bn));
}

function setBuilding(b) {
    if (state.currentBuilding === b) return;
    state.currentBuilding = b;
    try { localStorage.setItem(BUILDING_MEMORY_KEY, String(b)); } catch (_) {}
    renderBuildingSwitcher();
    renderFloorSwitcher();
    renderPlanList();
    syncFloorVisibility();
    clearIndoorPath();
    refreshIndoorNavPois();
}

function setFloor(f) {
    if (state.currentFloor === f) return;
    state.currentFloor = f;
    try { localStorage.setItem(FLOOR_MEMORY_KEY, String(f)); } catch (_) {}
    renderFloorSwitcher();
    syncFloorVisibility();
}

// 按当前楼层对齐所有已勾选方案的显隐（唯一真理：切换楼层 / 勾选方案都走这里）
export function syncFloorVisibility() {
    if (!state.planMap) return;
    const active = new Set(getActivePlanIds().map(String));
    for (const p of state.planProjects) {
        const id = String(p.id);
        const isMap = p.data && p.data.kind === 'map';
        const want = active.has(id)
            && (isMap || state.currentBuilding === '' || buildingOf(p) === state.currentBuilding)
            && (isMap || state.currentFloor === 0 || floorOf(p) === state.currentFloor);
        const shown = !!state.planOverlayGroups[id];
        if (want && !shown) {
            fetchPlanData(p.id).then(plan => {
                if (!plan) return;
                // 二次校验：异步期间建筑/楼层/勾选可能已变（map 方案不受建筑过滤）
                const isMapP = plan.data && plan.data.kind === 'map';
                if ((isMapP || state.currentBuilding === '' || buildingOf(plan) === state.currentBuilding)
                    && (isMapP || state.currentFloor === 0 || floorOf(plan) === state.currentFloor)
                    && getActivePlanIds().map(String).includes(id)
                    && !state.planOverlayGroups[id]) {
                    applyPlan(state.planMap, plan);
                    rebuildLocaIfActive();
                }
            });
        } else if (!want && shown) {
            removePlanOverlay(state.planMap, id);
        }
    }
    rebuildLocaIfActive();
}

function renderOnePlanList(box, plans, active) {
    if (!box) return;
    box.innerHTML = '';
    if (plans.length === 0) {
        box.innerHTML = '<div style="font-size:0.72rem;color:rgba(255,255,255,0.35);padding:4px 0;">暂无方案</div>';
        return;
    }
    plans.forEach(p => {
        const item = document.createElement('div');
        item.className = 'plan-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = active.has(String(p.id));
        cb.addEventListener('change', () => togglePlan(p.id, cb.checked));
        const name = document.createElement('span');
        name.className = 'plan-name';
        const fl = floorOf(p);
        name.textContent = (p.name || ('方案 ' + p.id)) + (fl > 0 ? ' · ' + fl + 'F' : '');
        name.title = p.name || '';
        name.addEventListener('click', () => { cb.checked = !cb.checked; togglePlan(p.id, cb.checked); });
        item.appendChild(cb);
        item.appendChild(name);
        box.appendChild(item);
    });
}

function togglePlan(planId, on) {
    const active = getActivePlanIds().filter(id => String(id) !== String(planId));
    if (on) active.push(String(planId));
    saveActivePlanIds(active);
    syncFloorVisibility();   // 统一按当前楼层对齐显隐（含勾选变化）
}

export async function fetchPlanData(id) {
    if (state.planFetching[id]) return state.planFetching[id];
    state.planFetching[id] = (async () => {
        try {
            const res = await fetch('/api/editor/projects/' + id, { headers: authHeaders(), cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const json = await res.json();
            return json.data;
        } catch (err) {
            console.error('❌ 加载方案失败:', err.message);
            return null;
        } finally {
            delete state.planFetching[id];
        }
    })();
    return state.planFetching[id];
}

export async function refreshPlanList() {
    try {
        const res = await fetch('/api/editor/projects', { headers: authHeaders(), cache: 'no-store' });
        const json = await res.json();
        state.planProjects = json.data || [];
    } catch (e) {}
    renderPlanList();
    refreshIndoorNavPois();
}

export async function initPlanSelector(map) {
    state.planMap = map;
    try {
        const res = await fetch('/api/editor/projects', { headers: authHeaders(), cache: 'no-store' });
        const json = await res.json();
        state.planProjects = json.data || [];
    } catch (err) {
        console.warn('⚠️ 加载方案列表失败:', err.message);
    }
    renderPlanList();

    const btnClear = document.getElementById('btn-clear-plan');
    if (btnClear) btnClear.addEventListener('click', () => {
        getActivePlanIds().forEach(id => removePlanOverlay(map, Number(id)));
        saveActivePlanIds([]);
        renderPlanList();
        rebuildLocaIfActive();
    });

    // 恢复勾选记忆（无记忆则全部勾选），再按当前楼层对齐显隐
    const allIds = state.planProjects.map(p => String(p.id));
    const savedIds = getActivePlanIds().filter(id => allIds.includes(String(id)));
    const toActivate = (savedIds.length > 0) ? savedIds : allIds;
    saveActivePlanIds(toActivate);
    renderPlanList();
    syncFloorVisibility();   // 统一按当前楼层对齐（含初始加载）
}

// 活动方案自动刷新：后台删除/编辑路线、区域后，切回首页（focus/visibility）或定时轮询时立即同步，不保留旧数据
async function refreshActivePlans() {
    if (!state.planMap) return;
    const ids = getActivePlanIds();
    // 并行拉取所有激活方案数据（原为串行 await，逐个等待网络往返）
    const results = await Promise.all(ids.map(async id => {
        try {
            const plan = await fetchPlanData(id);
            return { id, plan };
        } catch (_) { return { id, plan: null }; }
    }));
    let changed = false;
    for (const { id, plan } of results) {
        if (!plan) continue;
        const prev = JSON.stringify(state.activePlanData[id] || null);
        const next = JSON.stringify(plan.data || null);
        if (prev !== next) { applyPlan(state.planMap, plan); changed = true; }
    }
    if (changed) rebuildLocaIfActive();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshActivePlans(); });
window.addEventListener('focus', refreshActivePlans);
setInterval(refreshActivePlans, 30000);
