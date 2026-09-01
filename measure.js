// ========================================================
// measure.js — 首页测量工具：测距 + 测面积（复用高德官方 RangingTool / MouseTool）
// ========================================================
import { state } from './state.js';
import { clearNav } from './route.js';

// 测面积：等距圆柱局部近似 + shoelace（校园尺度精度足够）
function polygonAreaMeters(path) {
    if (!path || path.length < 3) return 0;
    const R = 6371000, k = R * Math.PI / 180;
    let latSum = 0; path.forEach(p => latSum += p[1]);
    const cos = Math.cos(latSum / path.length * Math.PI / 180);
    const pts = path.map(p => [p[0] * k * cos, p[1] * k]);
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
    return Math.abs(area / 2);
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
        if (state.measureRanging) { try { state.measureRanging.turnOff(); } catch (_) {} }
        if (state.measureMouseTool) { try { state.measureMouseTool.close(); } catch (_) {} }
        btnDist.classList.remove('active'); btnArea.classList.remove('active');
    }
    function clearMeasure() {
        stopMeasure();
        state.measureOverlays.forEach(o => { try { o.setMap(null); } catch (_) {} });
        state.measureOverlays = [];
    }
    function startDistance() {
        if (state.measureMode === 'distance') { stopMeasure(); return; }
        clearMeasure();
        state.measureMode = 'distance';
        btnDist.classList.add('active'); btnArea.classList.remove('active');
        state.measureRanging.turnOn();
        toast('📏 测距 — 点击加测量点，双击结束');
    }
    function startArea() {
        if (state.measureMode === 'area') { stopMeasure(); return; }
        clearMeasure();
        state.measureMode = 'area';
        btnArea.classList.add('active'); btnDist.classList.remove('active');
        state.measureMouseTool.polygon({ strokeColor:'#f59e0b', strokeWeight:2, strokeOpacity:0.8, fillColor:'#f59e0b', fillOpacity:0.2 });
        toast('🧮 测面积 — 点击加顶点，双击出面积');
    }

    AMap.plugin(['AMap.MouseTool', 'AMap.RangingTool'], () => {
        state.measureMouseTool = new AMap.MouseTool(map);
        state.measureMouseTool.on('draw', (e) => {
            if (state.measureMode !== 'area') return;
            const path = e.obj.getPath().map(p => [p.lng, p.lat]);
            e.obj.setMap(null);
            const area = polygonAreaMeters(path);
            stopMeasure();
            toast('🧮 面积: ' + formatArea(area));
        });

        // 与高德官方测距一致：起点/中间点/终点用官方图标，实线 + 虚线预览
        const mkIcon = (n) => new AMap.Icon({ size:new AMap.Size(19,31), imageSize:new AMap.Size(19,31), image:'https://webapi.amap.com/theme/v1.3/markers/b/' + n + '.png' });
        const mkOpt = (n) => ({ icon: mkIcon(n), offset: new AMap.Pixel(-9,-31) });
        state.measureRanging = new AMap.RangingTool(map, {
            lineOptions: { strokeColor:'#3366FF', strokeWeight:6, strokeStyle:'solid' },
            tmpLineOptions: { strokeColor:'#3366FF', strokeWeight:3, strokeStyle:'dashed', strokeOpacity:0.6 },
            startMarkerOptions: mkOpt('start'),
            midMarkerOptions: mkOpt('mid'),
            endMarkerOptions: mkOpt('end'),
        });
        state.measureRanging.on('end', (e) => {
            if (state.measureMode !== 'distance') return;
            const d = e && typeof e.distance === 'number' ? e.distance : null;
            stopMeasure();
            if (d != null) toast('📐 距离: ' + (d >= 1000 ? (d / 1000).toFixed(2) + ' 公里' : Math.round(d) + ' 米'));
        });

        btnDist.addEventListener('click', startDistance);
        btnArea.addEventListener('click', startArea);
        btnClear.addEventListener('click', clearMeasure);
    });
}
