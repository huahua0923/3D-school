// ========================================================
// measure.js — 首页测量工具：测距 + 测面积
// 结果常驻地图：测距折线中点出距离标签，测面积多边形中心出面积标签，
// 直到「清除测量」才消失（不再只弹几秒就消失的 toast）。
// 统一用 AMap.MouseTool 绘制，自持全部覆盖物（线/多边形/端点/标签），
// 便于精确清理（RangingTool 的 end 事件不给路径、覆盖物也不好取，弃用）。
// ========================================================
import { state } from './state.js';
import { clearNav } from './route.js';

const R = 6371000, K = R * Math.PI / 180;

// 两点距离（米）：等距圆柱局部近似，与面积计算同一套近似（校园尺度精度足够）
function distanceMeters(p1, p2) {
    const cos = Math.cos((p1[1] + p2[1]) / 2 * Math.PI / 180);
    const dx = (p2[0] - p1[0]) * K * cos;
    const dy = (p2[1] - p1[1]) * K;
    return Math.sqrt(dx * dx + dy * dy);
}

function pathDistance(path) {
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) total += distanceMeters(path[i], path[i + 1]);
    return total;
}

// 折线上累计距离 50% 处的点（测距标签落点，比取中间顶点更贴合真实中点）
function pathMidpoint(path) {
    const total = pathDistance(path);
    if (total <= 0) return path[0];
    let acc = 0, target = total / 2;
    for (let i = 0; i < path.length - 1; i++) {
        const d = distanceMeters(path[i], path[i + 1]);
        if (acc + d >= target) {
            const t = (target - acc) / d;
            return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
        }
        acc += d;
    }
    return path[path.length - 1];
}

// 测面积：等距圆柱局部近似 + shoelace（校园尺度精度足够）
function polygonAreaMeters(path) {
    if (!path || path.length < 3) return 0;
    let latSum = 0; path.forEach(p => latSum += p[1]);
    const cos = Math.cos(latSum / path.length * Math.PI / 180);
    const pts = path.map(p => [p[0] * K * cos, p[1] * K]);
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
    return Math.abs(area / 2);
}

// 多边形面积加权质心（面积标签落点）；退化时回退顶点平均
function polygonCentroid(path) {
    if (!path || path.length < 3) return path && path[0];
    let latSum = 0; path.forEach(p => latSum += p[1]);
    const cos = Math.cos(latSum / path.length * Math.PI / 180);
    const pts = path.map(p => [p[0] * K * cos, p[1] * K]);
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        const cross = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
        A += cross; cx += (pts[i][0] + pts[j][0]) * cross; cy += (pts[i][1] + pts[j][1]) * cross;
    }
    if (Math.abs(A) < 1e-9) {
        return [path.reduce((s, p) => s + p[0], 0) / path.length, path.reduce((s, p) => s + p[1], 0) / path.length];
    }
    return [cx / (3 * A) / (K * cos), cy / (3 * A) / K];
}

function formatDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + ' 公里' : Math.round(m) + ' 米';
}

function formatArea(m2) {
    if (m2 >= 1e6) return (m2 / 1e6).toFixed(2) + ' 平方公里';
    return Math.round(m2) + ' 平方米';
}

export function initMeasureTools(map) {
    const btnDist = document.getElementById('btn-measure-distance');
    const btnArea = document.getElementById('btn-measure-area');
    const btnClear = document.getElementById('btn-measure-clear');
    const btnClearNav = document.getElementById('btn-clear-nav');
    if (btnClearNav) btnClearNav.addEventListener('click', () => clearNav());
    if (!btnDist || !btnArea || !btnClear) return;

    function stopMeasure() {
        state.measureMode = null;
        if (state.measureMouseTool) { try { state.measureMouseTool.close(); } catch (_) {} }
        btnDist.classList.remove('active'); btnArea.classList.remove('active');
    }

    function clearMeasure() {
        stopMeasure();
        state.measureOverlays.forEach(o => { try { o.setMap(null); } catch (_) {} });
        state.measureOverlays = [];
    }

    // 常驻结果标签（测距中点 / 测面积中心），随「清除测量」一起消失
    function addResultLabel(lngLat, text, color) {
        const label = new AMap.Text({
            text, position: lngLat, anchor: 'center', zIndex: 120,
            style: {
                'background-color': 'rgba(12,18,30,0.94)',
                'border': '1px solid rgba(255,255,255,0.22)',
                'border-radius': '8px',
                'padding': '5px 12px',
                'color': color,
                'font-size': '14px',
                'font-weight': '600',
                'white-space': 'nowrap',
                'box-shadow': '0 4px 16px rgba(0,0,0,0.4)',
            },
        });
        label.setMap(map);
        state.measureOverlays.push(label);
    }

    // 端点圆点（起点绿 / 终点红），保留传统导航的起终点视觉
    function addDot(lngLat, color, title) {
        const dot = new AMap.Marker({
            position: lngLat, zIndex: 110,
            content: '<div style="width:12px;height:12px;border-radius:50%;background:' + color
                + ';border:2px solid #fff;box-shadow:0 0 8px ' + color + ';" title="' + title + '"></div>',
            offset: new AMap.Pixel(-8, -8),
        });
        dot.setMap(map);
        state.measureOverlays.push(dot);
    }

    function finishDistance(path) {
        stopMeasure();
        if (!path || path.length < 2) return;
        const total = pathDistance(path);
        const line = new AMap.Polyline({ path, strokeColor: '#3366FF', strokeWeight: 5, strokeStyle: 'solid', strokeOpacity: 0.9, zIndex: 108 });
        line.setMap(map); state.measureOverlays.push(line);
        addDot(path[0], '#22c55e', '起点');
        addDot(path[path.length - 1], '#ef4444', '终点');
        addResultLabel(pathMidpoint(path), '📏 ' + formatDist(total), '#7fb3ff');
        toast('📐 距离: ' + formatDist(total));
    }

    function finishArea(path) {
        stopMeasure();
        if (!path || path.length < 3) return;
        const area = polygonAreaMeters(path);
        const poly = new AMap.Polygon({
            path, strokeColor: '#f59e0b', strokeWeight: 2, strokeOpacity: 0.8,
            fillColor: '#f59e0b', fillOpacity: 0.18, zIndex: 107,
        });
        poly.setMap(map); state.measureOverlays.push(poly);
        addResultLabel(polygonCentroid(path), '🧮 ' + formatArea(area), '#ffc066');
        toast('🧮 面积: ' + formatArea(area));
    }

    function startDistance() {
        if (state.measureMode === 'distance') { stopMeasure(); return; }
        clearMeasure();
        state.measureMode = 'distance';
        btnDist.classList.add('active'); btnArea.classList.remove('active');
        state.measureMouseTool.polyline({ strokeColor: '#3366FF', strokeWeight: 3, strokeStyle: 'dashed', strokeOpacity: 0.7 });
        toast('📏 测距 — 点击加测量点，双击结束');
    }

    function startArea() {
        if (state.measureMode === 'area') { stopMeasure(); return; }
        clearMeasure();
        state.measureMode = 'area';
        btnArea.classList.add('active'); btnDist.classList.remove('active');
        state.measureMouseTool.polygon({ strokeColor: '#f59e0b', strokeWeight: 2, strokeOpacity: 0.8, fillColor: '#f59e0b', fillOpacity: 0.2 });
        toast('🧮 测面积 — 点击加顶点，双击出面积');
    }

    AMap.plugin('AMap.MouseTool', () => {
        state.measureMouseTool = new AMap.MouseTool(map);
        state.measureMouseTool.on('draw', (e) => {
            const path = e.obj.getPath().map(p => [p.lng, p.lat]);
            e.obj.setMap(null);   // 移除 MouseTool 预览，下面用常驻覆盖物重画
            if (state.measureMode === 'distance') finishDistance(path);
            else if (state.measureMode === 'area') finishArea(path);
        });
        btnDist.addEventListener('click', startDistance);
        btnArea.addEventListener('click', startArea);
        btnClear.addEventListener('click', clearMeasure);
    });
}
