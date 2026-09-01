// ============================================================
// editor-history.js — 撤销/重做历史栈（「变更后快照」模型）
// 原 editor.js IIFE 拆出（Phase 2，纯搬移不改行为）
// ============================================================
import { state, setState, MAX_HISTORY } from './editor-state.js';
import { loadBgImage } from './editor-canvas.js';

// 标准「变更后快照」模型：saveHistory 在 setState 之后调用，
// historyIndex 始终指向当前已提交快照；undo/redo 在快照间移动。

function snapshotState() {
  return {
    elements: JSON.parse(JSON.stringify(state.elements)),
    backgroundImage: state.backgroundImage,
    imageWidth: state.imageWidth, imageHeight: state.imageHeight,
    bgOpacity: state.bgOpacity,
  };
}

export function saveHistory() {
  const nh = state.history.slice(0, state.historyIndex + 1);
  nh.push(snapshotState());
  if (nh.length > MAX_HISTORY) nh.shift();
  setState({ history: nh, historyIndex: nh.length - 1 });
}

export function resetHistory() {
  setState({ history: [snapshotState()], historyIndex: 0 });
}

function applySnapshot(sp, ni) {
  setState({
    elements: JSON.parse(JSON.stringify(sp.elements)),
    backgroundImage: sp.backgroundImage, imageWidth: sp.imageWidth, imageHeight: sp.imageHeight,
    bgOpacity: sp.bgOpacity, historyIndex: ni,
    selectedElementId: null, selectedElementIds: [], isDrawing: false, drawingPoints: [], calibrating: false,
  });
  loadBgImage(sp.backgroundImage, sp.imageWidth, sp.imageHeight);
}

export function undo() {
  if (state.historyIndex <= 0) return;
  applySnapshot(state.history[state.historyIndex - 1], state.historyIndex - 1);
}

export function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  applySnapshot(state.history[state.historyIndex + 1], state.historyIndex + 1);
}
