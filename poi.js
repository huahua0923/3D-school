// ========================================================
// poi.js — 搜索定位 + 周边服务：从勾选的「地图方案」收集可搜索地物 + 周边 POI 落点
// ========================================================
import { state, PLAN_DEFAULT_W, PLAN_DEFAULT_H } from './state.js';
import { planPointToLngLat, defaultPlanBounds } from './coords.js';
import { floorOf } from './indoor.js';
import { onFeatureClick, showFeaturePopup } from './route.js';

// —— 搜索定位：从当前勾选的「地图方案」里收集可搜索地物（标记/区域/路线/画框/圆/椭圆） ——
export function buildSearchIndex() {
    const items = [];
    const push = (type, badge, icon, name, lng, lat, desc, images, color, pts, planId, floor, indoor) => {
        if (lng == null || lat == null) return;
        items.push({ type, badge, icon, name, lng, lat, desc: desc || '', images: images || [], color, pts, planId, floor, indoor: !!indoor });
    };
    // 遍历全部方案（含所有楼层），支持跨层搜索；planProjects 已在列表接口返回完整 data
    (state.planProjects || []).forEach(p => {
        const data = (p && p.data) ? p.data : {};
        const floor = floorOf(p);
        const planId = String(p.id);
        if (data.kind === 'map') {
            Object.entries(data.markers || {}).forEach(([name, m]) => push('marker', '标记点', '📍', name, m.lng, m.lat, m.desc, m.images, m.color, null, planId, floor, false));
            Object.entries(data.areas || {}).forEach(([name, a]) => {
                if (!a.pts || !a.pts.length) return;
                let cx = 0, cy = 0; a.pts.forEach(pt => { cx += pt[0]; cy += pt[1]; });
                push('area', '区域', '🗺️', name, cx / a.pts.length, cy / a.pts.length, a.desc, a.images, a.color, null, planId, floor, false);
            });
            Object.entries(data.routes || {}).forEach(([name, r]) => {
                if (!r.pts || r.pts.length < 2) return;
                const mid = r.pts[Math.floor(r.pts.length / 2)];
                push('route', '路线', '🛣️', name, mid[0], mid[1], r.desc, r.images, r.color, r.pts, planId, floor, false);
            });
            Object.entries(data.rects || {}).forEach(([name, r]) => {
                if (r.bounds && r.bounds[0] && r.bounds[1]) push('rect', '画框', '▭', name, (r.bounds[0][0] + r.bounds[1][0]) / 2, (r.bounds[0][1] + r.bounds[1][1]) / 2, r.desc, r.images, r.color, null, planId, floor, false);
            });
            Object.entries(data.circles || {}).forEach(([name, c]) => { if (c.center) push('circle', '画圆', '◯', name, c.center[0], c.center[1], c.desc, c.images, c.color, null, planId, floor, false); });
            Object.entries(data.ellipses || {}).forEach(([name, e]) => { if (e.center) push('ellipse', '椭圆', '⬭', name, e.center[0], e.center[1], e.desc, e.images, e.color, null, planId, floor, false); });
        } else {
            // 室内方案：elements（路线/区域/文字）用图片坐标 → 经纬度
            const els = Array.isArray(data.elements) ? data.elements : [];
            if (!els.length) return;
            const areaW = data.imageWidth || PLAN_DEFAULT_W;
            const areaH = data.imageHeight || PLAN_DEFAULT_H;
            const bounds = data.geoBounds || defaultPlanBounds();
            els.forEach(el => {
                if (el.visible === false) return;
                const pts = (el.points || []).map(pt => planPointToLngLat(pt.x, pt.y, bounds, areaW, areaH));
                const name = el.label || el.name || '';
                if (el.type === 'route' && pts.length >= 2) {
                    const mid = pts[Math.floor(pts.length / 2)];
                    push('route', '路线', '🛣️', name, mid[0], mid[1], '', [], el.color, pts, planId, floor, true);
                } else if (el.type === 'area' && pts.length >= 3) {
                    let cx = 0, cy = 0; pts.forEach(pt => { cx += pt[0]; cy += pt[1]; });
                    push('area', '区域', '🗺️', name, cx / pts.length, cy / pts.length, '', [], el.color, null, planId, floor, true);
                } else if (el.type === 'text' && pts.length >= 1) {
                    push('text', '文字', '💬', name, pts[0][0], pts[0][1], '', [], el.color, null, planId, floor, true);
                }
            });
        }
    });
    return items;
}

/** 周边服务搜索：以地图中心为圆心搜周边 POI，结果临时落点 */
export function searchNearby(map, keyword) {
    if (!state.placeSearch) { toast('⚠️ 周边搜索未就绪'); return; }
    const c = map.getCenter();
    state.nearbyMarkers.forEach(m => { try { m.setMap(null); } catch (_) {} });
    state.nearbyMarkers = [];
    state.placeSearch.searchNearBy(keyword, [c.lng, c.lat], 2000, (status, result) => {
        if (status === 'complete' && result && result.poiList) {
            const pois = result.poiList.pois || [];
            pois.slice(0, 10).forEach(p => {
                const lng = p.location.lng, lat = p.location.lat;
                const mk = new AMap.Marker({
                    position: new AMap.LngLat(lng, lat),
                    content: '<div style="width:12px;height:12px;background:#22d3ee;border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,0.6)"></div>',
                    offset: new AMap.Pixel(-8, -8),
                    zIndex: 16,
                });
                mk.on('click', (ev) => onFeatureClick(ev, () => showFeaturePopup(map, { icon: '🔍', title: p.name, badge: keyword, desc: (p.address || '') + (p.distance != null ? ' · ' + Math.round(p.distance) + '米' : ''), images: [], lng, lat })));
                map.add(mk); state.nearbyMarkers.push(mk);
            });
            toast('🔍 找到 ' + pois.length + ' 个' + keyword);
        } else {
            toast('⚠️ 周边未找到' + keyword);
        }
    });
}
