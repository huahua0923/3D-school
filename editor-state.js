// ============================================================
// editor-state.js — 路线图编辑器共享状态 + DOM 引用 + 核心工具
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// state 对象承载全部可变共享状态；DOM 引用以原名导出；ctx 为活绑定
// ============================================================

// ===================== 常量 =====================
export const DEFAULT_ROUTE_COLOR = '#3b82f6';
export const DEFAULT_AREA_COLOR = '#10b981';
export const DEFAULT_TEXT_COLOR = '#ffffff';
export const DEFAULT_TEXT_BG = 'rgba(0,0,0,0.7)';
export const DEFAULT_STAIR_COLOR = '#8b5cf6';
export const TEXT_BG_PRESETS = [
  'rgba(0,0,0,0.7)','rgba(255,255,255,0.8)','rgba(59,130,246,0.6)',
  'rgba(16,185,129,0.6)','rgba(239,68,68,0.6)','rgba(245,158,11,0.6)',
  'rgba(139,92,246,0.6)','rgba(236,72,153,0.6)','rgba(249,115,22,0.6)',
  'rgba(34,211,238,0.6)'
];
export const MAX_HISTORY = 50;

// ===================== 状态管理 =====================
export const state = {
  projectId: null,
  projectName: '未命名项目',
  floor: 0,
  building: '',
  geoBounds: null,
  geoBoundsExplicit: false,
  backgroundImage: null,
  imageWidth: 0,
  imageHeight: 0,
  bgOpacity: 1,
  currentTool: 'select',
  elements: [],
  selectedElementId: null,
  selectedElementIds: [],
  isDrawing: false,
  drawingPoints: [],
  calibrating: false,
  stageScale: 1,
  stagePosition: { x: 0, y: 0 },
  mousePos: null,
  gridEnabled: true,
  gridSize: 20,
  snapToGrid: true,
  guideLines: [],
  history: [],
  historyIndex: -1,

  // —— 原 IIFE 模块级 let 变量，统一收敛进 state ——
  bgImageObj: null,               // 已解码的底图 Image 对象
  lastSavedAt: null,              // 上次成功保存到服务器的时间
  textInputEl: null,              // 文字标注内联输入框
  pendingTextPoint: null,
  stairInputEl: null,             // 楼梯名内联输入框
  pendingStairPoint: null,
  calibrateInputEl: null,         // 比例尺标定输入框
  dragState: null,                // 画布拖拽状态（pan/element/vertex）
  boxSelectState: null,           // 框选状态
  rulerDragState: null,           // 参考线拖拽状态
  geoConfig: null,                // config.json 的 geo 配置
  defaultCenter: [104.14141, 30.67133],
  _amapPromise: null,             // 高德 SDK 加载 Promise（单例）
  planListCache: [],              // 侧栏方案列表缓存
  overlayPlanElements: {},        // planId -> elements[]（只读叠加图层）
  overlayPlanIds: new Set(),      // 勾选叠加的方案 id
};

const listeners = {};
export function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
export function emit(evt, data) { (listeners[evt] || []).forEach(fn => fn(data)); }
export function setState(updates) { Object.assign(state, updates); emit('change'); }

// ===================== DOM 引用 =====================
export const canvas = document.getElementById('editor-canvas');
export let ctx = canvas.getContext('2d'); // let — exportPNG 需要临时切换为离屏上下文
export function setCtx(c) { ctx = c; }
export const canvasWrap = document.getElementById('canvas-wrap');
export const $name = document.getElementById('project-name');
export const $floor = document.getElementById('project-floor');
export const $building = document.getElementById('project-building');
export const $layerList = document.getElementById('layer-list');
export const $propsPanel = document.getElementById('props-panel');
export const $noSelection = document.getElementById('no-selection');
export const $ctxMenu = document.getElementById('ctx-menu');
export const $zoomSlider = document.getElementById('zoom-slider');
export const $zoomLabel = document.getElementById('zoom-label');
export const $alignBtns = document.getElementById('align-btns');
export const $exportDropdown = document.getElementById('export-dropdown');
export const $textProps = document.getElementById('text-props');
export const rulerTopCanvas = document.getElementById('ruler-top-canvas');
export const rulerLeftCanvas = document.getElementById('ruler-left-canvas');
export const rulerTopCtx = rulerTopCanvas.getContext('2d');
export const rulerLeftCtx = rulerLeftCanvas.getContext('2d');

// ===================== 核心工具 =====================

let counter = 0;
export function genId() { return 'el_' + Date.now() + '_' + (++counter); }

export function snap(v) {
  if (!state.snapToGrid) return v;
  return Math.round(v / state.gridSize) * state.gridSize;
}

export function fromCanvas(cx, cy) {
  return {
    x: (cx - state.stagePosition.x) / state.stageScale,
    y: (cy - state.stagePosition.y) / state.stageScale
  };
}

export function getSelEl() { return state.elements.find(e => e.id === state.selectedElementId) || null; }

export function showToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);z-index:2000;background:#1a1a2e;color:#e0e0f0;padding:8px 20px;border-radius:8px;font-size:0.85rem;border:1px solid #2a2a4e;pointer-events:none;opacity:0;transition:opacity 0.3s;';
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
}

export function getToken() { return localStorage.getItem('admin_token') || null; }
export function authHeaders() { const t = getToken(); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
