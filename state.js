// ========================================================
// state.js — 共享可变状态 + 单例句柄 + 跨模块常量
// ES module 的 import 绑定只读（live-binding 不可重新赋值），
// 因此所有跨模块可变的 `let` 全局都收敛到这个对象里，用 state.xxx 读写。
// ========================================================

export const state = {
    // —— 配置（loadConfig 填充）——
    CONFIG: null,

    // —— 3D 场景脉冲标记（animate 每帧遍历的预收集数组）——
    pulseRings: [],
    pulseCones: [],

    // —— 流动虚线层（Canvas + 高德 Polyline）——
    flowCanvas: null,
    flowCtx: null,
    flowPolylines: {},          // id -> AMap.Polyline
    flowLastT: 0,
    hideRoutes: false,          // 卫星图「隐藏路线」开关
    routeOverlays: [],          // 路线相关覆盖物（透明点击线 + 名称标签）

    // —— 水波纹扩散层 ——
    rippleCanvas: null,
    rippleCtx: null,
    ripplePoints: [],           // [{lng, lat, color}]
    rippleOn: false,

    // —— 路线引导动画 ——
    guide: null,                // { pts, color, t } t∈[0,1]
    guideFollow: true,

    // —— 首页测量工具 ——
    measureMouseTool: null,
    measureMode: null,          // 'distance' | 'area' | null
    measureOverlays: [],        // 常驻测量覆盖物（线/多边形/端点/结果标签），清除测量才移除

    // —— Loca v2 可视化特效 ——
    locaContainer: null,
    locaActive: false,
    locaEffects: { routes: true, breathing: true, areas: true, scatter: false, prism: false },

    // —— 图片灯箱 ——
    lbImages: [],
    lbIndex: 0,

    // —— 导览方案 ——
    currentFloor: 0,            // 当前楼层（0=默认/未配置）
    currentBuilding: '',        // 当前建筑（''=全部）
    planMap: null,              // 当前地图实例
    planProjects: [],           // 方案列表缓存 {id,name,...}
    planOverlayGroups: {},      // planId -> { overlays:[], route:0, area:0 }
    activePlanData: {},         // planId -> { kind:'map', routes, areas, markers, ... }（供 Loca 读取）
    planFetching: {},           // planId -> Promise（防重复 fetch）
    ui: null,                   // UI 控制器引用
    suppressMapClickUntil: 0,   // 覆盖物点击后短暂屏蔽 map click 的 hideInfo

    // —— 路径导航 ——
    navStart: null,             // {lng,lat,title,floor}
    navEnd: null,
    navOverlay: null,           // 路径线 AMap.Polyline
    navWalking: null,           // AMap.Walking
    navReqSeq: 0,               // 路线请求序号，防异步竞态
    currentFeature: null,       // 当前详情卡地物 {lng,lat,title,floor}
    featureInfoWindow: null,    // AMap.InfoWindow
    geocoder: null,             // AMap.Geocoder
    placeSearch: null,          // AMap.PlaceSearch
    nearbyMarkers: [],          // 周边搜索结果临时标记
    navTravelMode: 'walking',   // walking/driving/riding/transfer
    navDriving: null,
    navRiding: null,
    navTransfer: null,
    dragRoute: null,            // AMap.DragRoute
    navPointMarkers: [],        // 起点/终点弹性标记
    elasticAvailable: false,    // AMap.ElasticMarker 是否就绪
    threeCtx: null,             // Three.js 上下文 {scene, customCoords, lpm, labelRenderer}

    // —— 室内寻路 ——
    indoorPathGroup: null,      // 室内路径 3D 折线组
    indoorNavPois: [],          // 当前建筑可路由点位 [{floor,name,type,elementId}]

    // —— 首页登录 ——
    viewerAuth: { token: null, username: null, role: null },
};

// —— 跨模块共享常量 ——
export const PLAN_DEFAULT_W = 1200;
export const PLAN_DEFAULT_H = 800;
export const PLAN_HALF_LNG = 0.002;
export const PLAN_HALF_LAT = 0.0014;
export const PLAN_MEMORY_KEY = 'active_plans';
export const FLOOR_MEMORY_KEY = 'current_floor';
export const BUILDING_MEMORY_KEY = 'current_building';
export const LAYER_HEIGHT = 4;                 // 3D 楼层堆叠：每层高度（米）
export const AUTH_KEY = 'viewer_token';
export const ROLE_NAMES = { admin: '管理员', super: '超级用户', user: '普通用户' };

// 登录态请求头（供方案 CRUD 接口调用；token 存 state.viewerAuth）
export function authHeaders() {
    return state.viewerAuth.token ? { 'Authorization': 'Bearer ' + state.viewerAuth.token } : {};
}

// 从 localStorage 恢复楼层/建筑记忆（依赖 localStorage，须在浏览器环境下调用）
export function initStateFromStorage() {
    try {
        state.currentFloor = parseInt(localStorage.getItem(FLOOR_MEMORY_KEY) || '0', 10) || 0;
    } catch (_) { state.currentFloor = 0; }
    try {
        state.currentBuilding = localStorage.getItem(BUILDING_MEMORY_KEY) || '';
    } catch (_) { state.currentBuilding = ''; }
}
