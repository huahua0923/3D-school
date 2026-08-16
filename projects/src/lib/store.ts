import { create } from 'zustand';
import type { MapElement, ToolMode, Point, ProjectData, GuideLine } from './types';

const DEFAULT_ROUTE_COLOR = '#3b82f6';
const DEFAULT_AREA_COLOR = '#10b981';
const DEFAULT_TEXT_COLOR = '#ffffff';
const DEFAULT_TEXT_BG = 'rgba(0,0,0,0.7)';
const DEFAULT_ROUTE_NAME = '路线';
const DEFAULT_AREA_NAME = '区域';

interface EditorState {
  // Background
  backgroundImage: string | null;
  imageWidth: number;
  imageHeight: number;
  bgOpacity: number;
  projectName: string;

  // Tools
  currentTool: ToolMode;

  // Elements
  elements: MapElement[];
  selectedElementId: string | null;

  // Drawing state
  isDrawing: boolean;
  drawingPoints: Point[];

  // View
  stageScale: number;
  stagePosition: Point;
  gridEnabled: boolean;
  gridSize: number;
  snapToGrid: boolean;
  selectedElementIds: string[];

  // Guide lines
  guideLines: GuideLine[];

  // Undo/Redo
  history: { elements: MapElement[]; backgroundImage: string | null; imageWidth: number; imageHeight: number; bgOpacity: number }[];
  historyIndex: number;

  // New actions
  setGridEnabled: (enabled: boolean) => void;
  setGridSize: (size: number) => void;
  setSnapToGrid: (enabled: boolean) => void;
  setSelectedElementIds: (ids: string[]) => void;
  bringToFront: (id: string) => void;
  sendToBack: (id: string) => void;
  alignElements: (ids: string[], type: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;

  // Guide lines
  addGuideLine: (line: GuideLine) => void;
  removeGuideLine: (id: string) => void;
  clearGuideLines: () => void;

  // Actions
  setBackgroundImage: (url: string, width: number, height: number) => void;
  setProjectName: (name: string) => void;
  setTool: (tool: ToolMode) => void;
  setSelectedElement: (id: string | null) => void;

  // Drawing
  startDrawing: (point: Point) => void;
  addDrawingPoint: (point: Point) => void;
  finishDrawing: () => void;
  cancelDrawing: () => void;

  // Element management
  updateElement: (id: string, updates: Partial<MapElement>) => void;
  deleteElement: (id: string) => void;
  toggleElementVisibility: (id: string) => void;
  toggleElementLock: (id: string) => void;
  moveElementOrder: (id: string, direction: 'up' | 'down') => void;
  duplicateElement: (id: string) => void;
  updateElementPoints: (id: string, points: Point[]) => void;

  // Text annotation
  addTextAnnotation: (point: Point, text: string) => void;

  // Undo/Redo
  undo: () => void;
  redo: () => void;

  // View
  setStageScale: (scale: number) => void;
  setStagePosition: (pos: Point) => void;

  // Computed
  canUndo: boolean;
  canRedo: boolean;
  exportImage: () => void;
  historyStep: string;

  // Save/Load
  exportProject: () => ProjectData;
  importProject: (data: ProjectData) => void;
  clearAll: () => void;
  setBgOpacity: (opacity: number) => void;
}

let elementCounter = 0;
function generateId(): string {
  return `el_${Date.now()}_${++elementCounter}`;
}

function getElementName(baseName: string, elements: MapElement[]): string {
  const count = elements.filter(e => e.name.startsWith(baseName)).length + 1;
  return `${baseName} ${count}`;
}

function saveHistory(state: EditorState) {
  const snapshot = {
    elements: JSON.parse(JSON.stringify(state.elements)),
    backgroundImage: state.backgroundImage,
    imageWidth: state.imageWidth,
    imageHeight: state.imageHeight,
    bgOpacity: state.bgOpacity,
  };
  const newHistory = state.history.slice(0, state.historyIndex + 1);
  newHistory.push(snapshot);
  if (newHistory.length > 50) newHistory.shift();
  return {
    history: newHistory,
    historyIndex: newHistory.length - 1,
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  // Background
  backgroundImage: null,
  imageWidth: 0,
  imageHeight: 0,
  bgOpacity: 1,
  projectName: '未命名项目',

  // Tools
  currentTool: 'select' as ToolMode,

  // Elements
  elements: [],
  selectedElementId: null,

  // Drawing
  isDrawing: false,
  drawingPoints: [],

  // View
  stageScale: 1,
  stagePosition: { x: 0, y: 0 },
  gridEnabled: true,
  gridSize: 20,
  snapToGrid: true,
  selectedElementIds: [],

  // Guide lines
  guideLines: [],

  // History
  history: [],
  historyIndex: -1,

  // Computed
  get canUndo() { return get().historyIndex > 0; },
  get canRedo() { return get().historyIndex < get().history.length - 1; },
  get historyStep() {
    const { historyIndex, history } = get();
    if (history.length === 0) return '0/0';
    return `${historyIndex + 1}/${history.length}`;
  },
  get exportImage() { 
    return () => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return;
      const link = document.createElement('a');
      link.download = `${get().projectName || '场地路线图'}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    };
  },

  // Actions
  setBackgroundImage: (url, width, height) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({
      backgroundImage: url,
      imageWidth: width,
      imageHeight: height,
      ...historyUpdate,
    });
  },

  setProjectName: (name) => set({ projectName: name }),

  setBgOpacity: (opacity) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({ bgOpacity: opacity, ...historyUpdate });
  },

  setTool: (tool) => set({
    currentTool: tool,
    isDrawing: false,
    drawingPoints: [],
  }),

  setSelectedElement: (id) => set({ selectedElementId: id, selectedElementIds: [] }),

  setSelectedElementIds: (ids) => set({ selectedElementIds: ids, selectedElementId: null }),

  setGridEnabled: (enabled) => set({ gridEnabled: enabled }),

  setGridSize: (size) => set({ gridSize: size }),

  setSnapToGrid: (enabled) => set({ snapToGrid: enabled }),

  addGuideLine: (line) => set((state) => ({ guideLines: [...state.guideLines, line] })),

  removeGuideLine: (id) => set((state) => ({ guideLines: state.guideLines.filter((l) => l.id !== id) })),

  clearGuideLines: () => set({ guideLines: [] }),

  bringToFront: (id) => {
    const state = get();
    const idx = state.elements.findIndex((el) => el.id === id);
    if (idx < 0 || idx === state.elements.length - 1) return;
    const newElements = [...state.elements];
    const [el] = newElements.splice(idx, 1);
    newElements.push(el);
    const historyUpdate = saveHistory(state);
    set({ elements: newElements, ...historyUpdate });
  },

  sendToBack: (id) => {
    const state = get();
    const idx = state.elements.findIndex((el) => el.id === id);
    if (idx <= 0) return;
    const newElements = [...state.elements];
    const [el] = newElements.splice(idx, 1);
    newElements.unshift(el);
    const historyUpdate = saveHistory(state);
    set({ elements: newElements, ...historyUpdate });
  },

  alignElements: (ids, type) => {
    const state = get();
    const els = state.elements.filter((el) => ids.includes(el.id));
    if (els.length < 2) return;

    // Compute bounding box of all selected elements
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    els.forEach((el) => {
      el.points.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      });
    });
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const newElements = state.elements.map((el) => {
      if (!ids.includes(el.id)) return el;
      const dx = el.points[0].x;
      const dy = el.points[0].y;
      const elCenterX = el.points.reduce((s, p) => s + p.x, 0) / el.points.length;
      const elCenterY = el.points.reduce((s, p) => s + p.y, 0) / el.points.length;

      let offsetX = 0, offsetY = 0;
      switch (type) {
        case 'left': offsetX = minX - elCenterX; break;
        case 'center': offsetX = centerX - elCenterX; break;
        case 'right': offsetX = maxX - elCenterX; break;
        case 'top': offsetY = minY - elCenterY; break;
        case 'middle': offsetY = centerY - elCenterY; break;
        case 'bottom': offsetY = maxY - elCenterY; break;
      }
      return { ...el, points: el.points.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })) };
    });
    const historyUpdate = saveHistory(state);
    set({ elements: newElements, ...historyUpdate });
  },

  // Drawing
  startDrawing: (point) => set({
    isDrawing: true,
    drawingPoints: [point],
  }),

  addDrawingPoint: (point) => {
    const state = get();
    if (!state.isDrawing) return;
    set({ drawingPoints: [...state.drawingPoints, point] });
  },

  finishDrawing: () => {
    const state = get();
    if (!state.isDrawing || state.drawingPoints.length < 2) {
      set({ isDrawing: false, drawingPoints: [] });
      return;
    }

    const isArea = state.currentTool === 'draw-area';
    const historyUpdate = saveHistory(state);
    const baseName = isArea ? DEFAULT_AREA_NAME : DEFAULT_ROUTE_NAME;
    const newElement: MapElement = {
      id: generateId(),
      type: isArea ? 'area' : 'route',
      name: getElementName(baseName, state.elements),
      visible: true,
      locked: false,
      points: state.drawingPoints,
      color: isArea ? DEFAULT_AREA_COLOR : DEFAULT_ROUTE_COLOR,
      strokeWidth: isArea ? 2 : 3,
      opacity: isArea ? 0.3 : 1,
    };

    set({
      elements: [...state.elements, newElement],
      selectedElementId: newElement.id,
      isDrawing: false,
      drawingPoints: [],
      ...historyUpdate,
    });
  },

  cancelDrawing: () => set({
    isDrawing: false,
    drawingPoints: [],
  }),

  // Element management
  updateElement: (id, updates) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({
      elements: state.elements.map(el =>
        el.id === id ? { ...el, ...updates } : el
      ),
      ...historyUpdate,
    });
  },

  deleteElement: (id) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({
      elements: state.elements.filter(el => el.id !== id),
      selectedElementId: state.selectedElementId === id ? null : state.selectedElementId,
      ...historyUpdate,
    });
  },

  toggleElementVisibility: (id) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({
      elements: state.elements.map(el =>
        el.id === id ? { ...el, visible: !el.visible } : el
      ),
      ...historyUpdate,
    });
  },

  toggleElementLock: (id) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({
      elements: state.elements.map(el =>
        el.id === id ? { ...el, locked: !el.locked } : el
      ),
      ...historyUpdate,
    });
  },

  moveElementOrder: (id, direction) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    const idx = state.elements.findIndex(el => el.id === id);
    if (idx === -1) return;
    const newElements = [...state.elements];
    if (direction === 'up' && idx < newElements.length - 1) {
      [newElements[idx], newElements[idx + 1]] = [newElements[idx + 1], newElements[idx]];
    } else if (direction === 'down' && idx > 0) {
      [newElements[idx], newElements[idx - 1]] = [newElements[idx - 1], newElements[idx]];
    } else {
      return;
    }
    set({ elements: newElements, ...historyUpdate });
  },

  duplicateElement: (id) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    const original = state.elements.find(el => el.id === id);
    if (!original) return;
    const newElement: MapElement = {
      ...JSON.parse(JSON.stringify(original)),
      id: generateId(),
      name: `${original.name} 副本`,
      points: original.points.map(p => ({ x: p.x + 20, y: p.y + 20 })),
    };
    set({
      elements: [...state.elements, newElement],
      selectedElementId: newElement.id,
      ...historyUpdate,
    });
  },

  updateElementPoints: (id, points) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({
      elements: state.elements.map(el =>
        el.id === id ? { ...el, points } : el
      ),
      ...historyUpdate,
    });
  },

  addTextAnnotation: (point, text) => {
    const state = get();
    const historyUpdate = saveHistory(state);
    const newElement: MapElement = {
      id: generateId(),
      type: 'text',
      name: `文字 ${state.elements.filter(e => e.type === 'text').length + 1}`,
      visible: true,
      locked: false,
      points: [point],
      color: DEFAULT_TEXT_COLOR,
      strokeWidth: 0,
      opacity: 1,
      label: text,
      fontSize: 16,
      backgroundColor: DEFAULT_TEXT_BG,
    };
    set({
      elements: [...state.elements, newElement],
      selectedElementId: newElement.id,
      ...historyUpdate,
    });
  },

  undo: () => {
    const state = get();
    if (state.historyIndex < 0) return;
    const snapshot = state.history[state.historyIndex];
    const prevState = state.historyIndex > 0
      ? state.history[state.historyIndex - 1]
      : { elements: [], backgroundImage: null, imageWidth: 0, imageHeight: 0, bgOpacity: 1 };
    set({
      elements: JSON.parse(JSON.stringify(snapshot.elements)),
      backgroundImage: snapshot.backgroundImage,
      imageWidth: snapshot.imageWidth,
      imageHeight: snapshot.imageHeight,
      bgOpacity: snapshot.bgOpacity,
      historyIndex: state.historyIndex - 1,
      selectedElementId: null,
      isDrawing: false,
      drawingPoints: [],
    });
  },

  redo: () => {
    const state = get();
    if (state.historyIndex >= state.history.length - 2) return;
    const nextIdx = state.historyIndex + 2;
    const snapshot = state.history[nextIdx];
    set({
      elements: JSON.parse(JSON.stringify(snapshot.elements)),
      backgroundImage: snapshot.backgroundImage,
      imageWidth: snapshot.imageWidth,
      imageHeight: snapshot.imageHeight,
      bgOpacity: snapshot.bgOpacity,
      historyIndex: nextIdx,
      selectedElementId: null,
      isDrawing: false,
      drawingPoints: [],
    });
  },

  setStageScale: (scale) => set({ stageScale: Math.max(0.1, Math.min(10, scale)) }),

  setStagePosition: (pos) => set({ stagePosition: pos }),

  exportProject: () => {
    const state = get();
    return {
      version: 1,
      backgroundImage: state.backgroundImage,
      imageWidth: state.imageWidth,
      imageHeight: state.imageHeight,
      elements: state.elements,
      projectName: state.projectName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  },

  importProject: (data) => {
    set({
      backgroundImage: data.backgroundImage,
      imageWidth: data.imageWidth,
      imageHeight: data.imageHeight,
      elements: data.elements,
      projectName: data.projectName,
      history: [],
      historyIndex: -1,
      selectedElementId: null,
      isDrawing: false,
      drawingPoints: [],
      stageScale: 1,
      stagePosition: { x: 0, y: 0 },
    });
  },

  clearAll: () => {
    const state = get();
    const historyUpdate = saveHistory(state);
    set({
      elements: [],
      selectedElementId: null,
      isDrawing: false,
      drawingPoints: [],
      ...historyUpdate,
    });
  },
}));