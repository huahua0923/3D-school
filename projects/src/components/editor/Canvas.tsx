'use client';

import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useEditorStore } from '@/lib/store';
import type { Point, MapElement } from '@/lib/types';

// Check if a point is near a line segment
function pointNearSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number, threshold: number = 8): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1) < threshold;
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nearX = x1 + t * dx;
  const nearY = y1 + t * dy;
  return Math.hypot(px - nearX, py - nearY) < threshold;
}

// Check if a point is inside a polygon
function pointInPolygon(px: number, py: number, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Draw a direction arrow at the end of a segment
function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string, lineWidth: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const arrowLen = Math.max(8, lineWidth * 2.5);
  const arrowAngle = Math.PI / 6;
  ctx.save();
  ctx.translate(to.x, to.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-arrowLen, -arrowLen * 0.5);
  ctx.lineTo(-arrowLen, arrowLen * 0.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// Get position along a polyline path at a given progress (0-1)
export default function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const animOffsetRef = useRef(0);
  const animFrameRef = useRef<number>(0);

  // Drag state
  const [dragState, setDragState] = useState<{
    type: 'element' | 'node' | 'pan' | null;
    elementId: string | null;
    nodeIndex: number;
    startMouse: Point;
    startPoints: Point[];
  }>({ type: null, elementId: null, nodeIndex: -1, startMouse: { x: 0, y: 0 }, startPoints: [] });

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    pos: Point;
    elementId: string | null;
  } | null>(null);

  // Mouse coordinates for status
  const [canvasMousePos, setCanvasMousePos] = useState<Point | null>(null);

  const {
    currentTool, isDrawing, drawingPoints,
    elements, selectedElementId,
    backgroundImage, imageWidth, imageHeight, bgOpacity,
    stageScale, stagePosition, gridEnabled, gridSize, snapToGrid,
    selectedElementIds, projectName, guideLines,
    startDrawing, addDrawingPoint, finishDrawing, cancelDrawing,
    setSelectedElement, deleteElement, updateElement, updateElementPoints,
    setStageScale, setStagePosition, setTool, addTextAnnotation,
    setSelectedElementIds, setGridEnabled,
    undo, redo, duplicateElement, bringToFront, sendToBack,
    addGuideLine, removeGuideLine,
  } = useEditorStore();

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Box select state
  const [boxSelect, setBoxSelect] = useState<{ start: Point; end: Point } | null>(null);

  // Ruler drag state (for dragging guide lines from ruler)
  const [rulerDrag, setRulerDrag] = useState<{
    orientation: 'horizontal' | 'vertical';
    active: boolean;
    pos: number;
  } | null>(null);

  // Draw canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match canvas resolution to container size (no stretch)
    const w = containerSize.width;
    const h = containerSize.height;
    canvas.width = w;
    canvas.height = h;

    // Apply transform
    ctx.save();
    ctx.translate(stagePosition.x, stagePosition.y);
    ctx.scale(stageScale, stageScale);

    // Clear
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, w, h);

    // Grid
    if (gridEnabled) {
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 0.3 / stageScale;
      const gs = gridSize * stageScale;
      for (let x = 0; x <= w; x += gs) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += gs) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // Background image - draw at natural size, maintain aspect ratio
    if (bgImageRef.current) {
      ctx.save();
      ctx.globalAlpha = bgOpacity;
      const img = bgImageRef.current;
      // Scale image to fit canvas (contain mode)
      const imgScale = Math.min(canvas.width / img.width, canvas.height / img.height);
      const ix = (canvas.width - img.width * imgScale) / 2;
      const iy = (canvas.height - img.height * imgScale) / 2;
      ctx.drawImage(img, ix, iy, img.width * imgScale, img.height * imgScale);
      ctx.restore();
    }

    // Guide lines
    ctx.save();
    for (const gl of guideLines) {
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.6)';
      ctx.lineWidth = 1 / stageScale;
      ctx.setLineDash([4 / stageScale, 4 / stageScale]);
      ctx.beginPath();
      if (gl.orientation === 'horizontal') {
        ctx.moveTo(0, gl.position);
        ctx.lineTo(w, gl.position);
      } else {
        ctx.moveTo(gl.position, 0);
        ctx.lineTo(gl.position, h);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Ruler drag preview
    if (rulerDrag && rulerDrag.active) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.8)';
      ctx.lineWidth = 2 / stageScale;
      ctx.setLineDash([4 / stageScale, 4 / stageScale]);
      ctx.beginPath();
      if (rulerDrag.orientation === 'horizontal') {
        ctx.moveTo(0, rulerDrag.pos);
        ctx.lineTo(w, rulerDrag.pos);
      } else {
        ctx.moveTo(rulerDrag.pos, 0);
        ctx.lineTo(rulerDrag.pos, h);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Draw elements
    for (const el of elements) {
      if (!el.visible) continue;

      if (el.type === 'area' && el.points.length >= 3) {
        // Draw area
        ctx.beginPath();
        ctx.moveTo(el.points[0].x, el.points[0].y);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i].x, el.points[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = el.color + Math.round(el.opacity * 255).toString(16).padStart(2, '0');
        ctx.fill();
        ctx.strokeStyle = el.color;
        ctx.lineWidth = el.strokeWidth;
        ctx.stroke();

        // Label
        const cx = el.points.reduce((s, p) => s + p.x, 0) / el.points.length;
        const cy = el.points.reduce((s, p) => s + p.y, 0) / el.points.length;
        ctx.fillStyle = el.color;
        ctx.font = `14px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(el.name, cx, cy);

        // Measurement: area
        if (el.id === selectedElementId && el.points.length >= 3) {
          let area = 0;
          for (let i = 0; i < el.points.length; i++) {
            const j = (i + 1) % el.points.length;
            area += el.points[i].x * el.points[j].y;
            area -= el.points[j].x * el.points[i].y;
          }
          area = Math.abs(area) / 2;
          const displayArea = area > 1000 ? (area / 1000).toFixed(1) + 'k' : area.toFixed(0);
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.roundRect(cx - 30, cy + 8, 60, 18, 4);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${displayArea}px²`, cx, cy + 21);
        }

        // Selection handles
        if (el.id === selectedElementId) {
          for (const p of el.points) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = el.color;
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      } else if (el.type === 'route' && el.points.length >= 2) {
        // Draw route - solid glow base
        ctx.beginPath();
        ctx.moveTo(el.points[0].x, el.points[0].y);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i].x, el.points[i].y);
        }
        ctx.strokeStyle = el.color + '40';
        ctx.lineWidth = el.strokeWidth + 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Draw route - solid line
        ctx.beginPath();
        ctx.moveTo(el.points[0].x, el.points[0].y);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i].x, el.points[i].y);
        }
        ctx.strokeStyle = el.color;
        ctx.lineWidth = el.strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Water flow effect - flowing highlight along the line
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(el.points[0].x, el.points[0].y);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i].x, el.points[i].y);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = Math.max(2, el.strokeWidth - 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.setLineDash([18, 25]);
        ctx.lineDashOffset = -animOffsetRef.current * 2;
        ctx.stroke();
        ctx.restore();

        // Direction arrows on each segment
        for (let i = 0; i < el.points.length - 1; i++) {
          drawArrow(ctx, el.points[i], el.points[i + 1], el.color, el.strokeWidth);
        }

        // Start marker
        ctx.beginPath();
        ctx.arc(el.points[0].x, el.points[0].y, 6, 0, Math.PI * 2);
        ctx.fillStyle = el.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // End marker
        const last = el.points[el.points.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = el.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Label
        const midIdx = Math.floor(el.points.length / 2);
        const mid = el.points[midIdx];
        ctx.fillStyle = el.color;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(el.name, mid.x, mid.y - 15);

        // Measurement: route length
        if (el.id === selectedElementId) {
          let totalLen = 0;
          for (let i = 0; i < el.points.length - 1; i++) {
            const dx = el.points[i + 1].x - el.points[i].x;
            const dy = el.points[i + 1].y - el.points[i].y;
            totalLen += Math.sqrt(dx * dx + dy * dy);
          }
          const displayLen = totalLen.toFixed(0);
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.roundRect(mid.x - 30, mid.y - 30, 60, 18, 4);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${displayLen}px`, mid.x, mid.y - 17);
        }

        // Selection handles
        if (el.id === selectedElementId) {
          for (const p of el.points) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = el.color;
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
      } else if (el.type === 'text' && el.points.length > 0) {
        // Draw text annotation
        const p = el.points[0];
        const text = el.label || el.name;
        const fontSize = el.fontSize || 16;

        // Background pill
        ctx.font = `bold ${fontSize}px sans-serif`;
        const metrics = ctx.measureText(text);
        const tw = metrics.width;
        const pad = 8;
        const bx = p.x - tw / 2 - pad;
        const by = p.y - fontSize - pad;
        const bw = tw + pad * 2;
        const bh = fontSize + pad * 2;
        ctx.fillStyle = el.backgroundColor || 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 6);
        ctx.fill();

        // Text
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, p.x, p.y - 4);

        // Selection
        if (el.id === selectedElementId) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(bx - 2, by - 2, bw + 4, bh + 4, 8);
          ctx.stroke();
        }

        ctx.textBaseline = 'alphabetic';
      }
    }

    // Drawing preview
    if (isDrawing && drawingPoints.length > 0) {
      const isArea = currentTool === 'draw-area';
      const previewColor = isArea ? '#10b981' : '#3b82f6';
      ctx.setLineDash([8, 4]);
      ctx.strokeStyle = previewColor;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(drawingPoints[0].x, drawingPoints[0].y);
      for (let i = 1; i < drawingPoints.length; i++) {
        ctx.lineTo(drawingPoints[i].x, drawingPoints[i].y);
      }
      if (mousePos) {
        ctx.lineTo(mousePos.x, mousePos.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Points
      for (let i = 0; i < drawingPoints.length; i++) {
        ctx.beginPath();
        ctx.arc(drawingPoints[i].x, drawingPoints[i].y, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? previewColor : '#fff';
        ctx.fill();
        ctx.strokeStyle = previewColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Draw box select rectangle
    if (boxSelect) {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(
        boxSelect.start.x, boxSelect.start.y,
        boxSelect.end.x - boxSelect.start.x,
        boxSelect.end.y - boxSelect.start.y
      );
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
      ctx.fillRect(
        boxSelect.start.x, boxSelect.start.y,
        boxSelect.end.x - boxSelect.start.x,
        boxSelect.end.y - boxSelect.start.y
      );
    }

    ctx.restore();
  }, [containerSize, bgOpacity, elements, selectedElementId, isDrawing, drawingPoints, mousePos, stageScale, stagePosition, currentTool, boxSelect, gridEnabled, gridSize, guideLines, rulerDrag]);

  // Redraw on state change
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  // Load background image
  useEffect(() => {
    if (!backgroundImage) {
      bgImageRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      bgImageRef.current = img;
      drawCanvas();
    };
    img.src = backgroundImage;
  }, [backgroundImage, drawCanvas]);

  // Get canvas-relative position with transform
  // Corrects for canvas internal resolution vs CSS display size
  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: ((e.clientX - rect.left) * scaleX - stagePosition.x) / stageScale,
      y: ((e.clientY - rect.top) * scaleY - stagePosition.y) / stageScale,
    };
  }, [stagePosition, stageScale]);

  // Get screen position (CSS pixels relative to canvas element)
  const getScreenPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  // Snap point to grid
  const snapPoint = useCallback((point: Point): Point => {
    if (!snapToGrid || !gridEnabled) return point;
    const gs = gridSize * stageScale;
    return {
      x: Math.round(point.x / gs) * gs,
      y: Math.round(point.y / gs) * gs,
    };
  }, [snapToGrid, gridEnabled, gridSize, stageScale]);

  // Drag & drop image import state
  const [isDragOver, setIsDragOver] = useState(false);

  // Hit test - find element at position
  const hitTest = useCallback((pos: Point): { el: MapElement; nodeIndex: number } | null => {
    // Check routes first (lines are easier to hit)
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (!el.visible || el.locked) continue;

      if (el.type === 'route' && el.points.length >= 2) {
        for (let j = 0; j < el.points.length - 1; j++) {
          if (pointNearSegment(pos.x, pos.y, el.points[j].x, el.points[j].y, el.points[j + 1].x, el.points[j + 1].y, 10)) {
            return { el, nodeIndex: j };
          }
        }
        // Check start/end markers
        for (let j = 0; j < el.points.length; j++) {
          if (Math.hypot(pos.x - el.points[j].x, pos.y - el.points[j].y) < 10) {
            return { el, nodeIndex: j };
          }
        }
      }

      if (el.type === 'area' && el.points.length >= 3) {
        if (pointInPolygon(pos.x, pos.y, el.points)) {
          return { el, nodeIndex: -1 };
        }
        // Check edge
        for (let j = 0; j < el.points.length; j++) {
          const next = (j + 1) % el.points.length;
          if (pointNearSegment(pos.x, pos.y, el.points[j].x, el.points[j].y, el.points[next].x, el.points[next].y, 8)) {
            return { el, nodeIndex: j };
          }
        }
      }

      if (el.type === 'text' && el.points.length > 0) {
        const p = el.points[0];
        if (Math.hypot(pos.x - p.x, pos.y - p.y) < 30) {
          return { el, nodeIndex: -1 };
        }
      }
    }
    return null;
  }, [elements]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rawPos = getCanvasPos(e);
    const pos = snapPoint(rawPos);

    if (currentTool === 'draw-route' || currentTool === 'draw-area') {
      if (!isDrawing) {
        startDrawing(pos);
      } else {
        addDrawingPoint(pos);
      }
      return;
    }

    if (currentTool === 'text-tool') {
      const text = prompt('输入文字标注内容：');
      if (text && text.trim()) {
        addTextAnnotation(pos, text.trim());
      }
      return;
    }

    if (currentTool === 'pan') {
      const screenPos = getScreenPos(e);
      setDragState({
        type: 'pan',
        elementId: null,
        nodeIndex: -1,
        startMouse: screenPos,
        startPoints: [{ x: stagePosition.x, y: stagePosition.y }],
      });
      return;
    }

    if (currentTool === 'select') {
      // Check if clicking on a node handle first
      if (selectedElementId) {
        const selEl = elements.find(el => el.id === selectedElementId);
        if (selEl && !selEl.locked) {
          for (let i = 0; i < selEl.points.length; i++) {
            if (Math.hypot(rawPos.x - selEl.points[i].x, rawPos.y - selEl.points[i].y) < 8) {
              setDragState({
                type: 'node',
                elementId: selectedElementId,
                nodeIndex: i,
                startMouse: rawPos,
                startPoints: selEl.points.map(p => ({ ...p })),
              });
              return;
            }
          }
        }
      }

      // Hit test element
      const hit = hitTest(rawPos);
      if (hit) {
        setSelectedElement(hit.el.id);
        if (!hit.el.locked) {
          setDragState({
            type: 'element',
            elementId: hit.el.id,
            nodeIndex: -1,
            startMouse: rawPos,
            startPoints: hit.el.points.map(p => ({ ...p })),
          });
        }
      } else if (e.shiftKey) {
        // Shift+click on empty area: start box select
        setBoxSelect({ start: rawPos, end: rawPos });
      } else {
        setSelectedElement(null);
      }
    }
  }, [currentTool, isDrawing, getCanvasPos, snapPoint, getScreenPos, startDrawing, addDrawingPoint, elements, selectedElementId, stagePosition, stageScale, hitTest, setSelectedElement, addTextAnnotation]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasPos(e);
    setCanvasMousePos(pos);

    // Ruler drag preview update
    if (rulerDrag && rulerDrag.active) {
      setRulerDrag(prev => prev ? { ...prev, pos: rulerDrag.orientation === 'horizontal' ? pos.y : pos.x } : null);
      return;
    }

    if (isDrawing) {
      setMousePos(pos);
      return;
    }

    if (dragState.type === 'element' && dragState.elementId) {
      const dx = pos.x - dragState.startMouse.x;
      const dy = pos.y - dragState.startMouse.y;
      const newPoints = dragState.startPoints.map(p => ({
        x: p.x + dx,
        y: p.y + dy,
      }));
      updateElementPoints(dragState.elementId, newPoints);
      return;
    }

    if (dragState.type === 'node' && dragState.elementId && dragState.nodeIndex >= 0) {
      const newPoints = dragState.startPoints.map((p, i) =>
        i === dragState.nodeIndex ? { x: pos.x, y: pos.y } : { ...p }
      );
      updateElementPoints(dragState.elementId, newPoints);
      return;
    }

    if (dragState.type === 'pan') {
      const screenPos = getScreenPos(e);
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const scaleX = canvas ? canvas.width / rect!.width : 1;
      const scaleY = canvas ? canvas.height / rect!.height : 1;
      const dx = (screenPos.x - dragState.startMouse.x) * scaleX;
      const dy = (screenPos.y - dragState.startMouse.y) * scaleY;
      const startPos = dragState.startPoints[0];
      setStagePosition({ x: startPos.x + dx, y: startPos.y + dy });
      return;
    }

    // Box select with Shift+drag
    if (boxSelect) {
      setBoxSelect({ start: boxSelect.start, end: pos });
      return;
    }

    setMousePos(pos);
  }, [isDrawing, dragState, getCanvasPos, getScreenPos, updateElementPoints, setStagePosition, currentTool, boxSelect, setBoxSelect, rulerDrag]);

  const handleMouseUp = useCallback(() => {
    // Clear ruler drag
    if (rulerDrag) setRulerDrag(null);

    if (dragState.type !== null) {
      setDragState({ type: null, elementId: null, nodeIndex: -1, startMouse: { x: 0, y: 0 }, startPoints: [] });
    }

    // Close context menu on click
    if (contextMenu) setContextMenu(null);

    // Finish box select
    if (boxSelect) {
      const minX = Math.min(boxSelect.start.x, boxSelect.end.x);
      const maxX = Math.max(boxSelect.start.x, boxSelect.end.x);
      const minY = Math.min(boxSelect.start.y, boxSelect.end.y);
      const maxY = Math.max(boxSelect.start.y, boxSelect.end.y);

      const hitIds = elements
        .filter(el => {
          // Check if any point of the element is within the box
          return el.points.some(p =>
            p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
          );
        })
        .map(el => el.id);

      if (hitIds.length > 0) {
        setSelectedElementIds(hitIds);
        setSelectedElement(hitIds[hitIds.length - 1]);
      } else {
        setSelectedElement(null);
        setSelectedElementIds([]);
      }
      setBoxSelect(null);
    }
  }, [dragState, boxSelect, elements, setSelectedElement, setSelectedElementIds, contextMenu, rulerDrag]);

  const handleDoubleClick = useCallback(() => {
    if (currentTool !== 'draw-route' && currentTool !== 'draw-area') return;
    if (!isDrawing) return;
    finishDrawing();
  }, [currentTool, isDrawing, finishDrawing]);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(5, stageScale * delta));

    // Zoom towards mouse position
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!rect || !canvas) return;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;
    const scaleChange = newScale / stageScale;
    const newPos = {
      x: mx - (mx - stagePosition.x) * scaleChange,
      y: my - (my - stagePosition.y) * scaleChange,
    };

    setStageScale(newScale);
    setStagePosition(newPos);
  }, [stageScale, stagePosition, setStageScale, setStagePosition]);

  // Context menu
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const pos = getCanvasPos(e);
    const hit = hitTest(pos);
    setContextMenu({
      pos: { x: e.clientX, y: e.clientY },
      elementId: hit?.el.id || null,
    });
  }, [getCanvasPos, hitTest]);

  // Drag & drop image import
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const state = useEditorStore.getState();
        state.setBackgroundImage(ev.target?.result as string, img.width, img.height);
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if the user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Escape') {
        if (isDrawing) cancelDrawing();
        setSelectedElement(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isDrawing) {
        if (selectedElementId) {
          const el = elements.find(el => el.id === selectedElementId);
          if (el && !el.locked) deleteElement(selectedElementId);
        }
      }
      if (e.key === 'Enter' && isDrawing) finishDrawing();

      // Shortcuts
      if (e.key === 'v' || e.key === 'V') setTool('select');
      if (e.key === 'h' || e.key === 'H') setTool('pan');
      if (e.key === 't' || e.key === 'T') setTool('text-tool');

      // Undo/Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }

      // Duplicate
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        if (selectedElementId) duplicateElement(selectedElementId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDrawing, selectedElementId, elements, cancelDrawing, setSelectedElement, deleteElement, finishDrawing, setTool, undo, redo, duplicateElement]);

  // Flowing line animation loop
  useEffect(() => {
    const animate = () => {
      animOffsetRef.current += 0.5;
      if (animOffsetRef.current > 20) animOffsetRef.current = 0;
      drawCanvas();
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [drawCanvas]);

  // Auto-save to localStorage every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      const data = { elements, backgroundImage, imageWidth, imageHeight, projectName, bgOpacity };
      localStorage.setItem('route-editor-autosave', JSON.stringify(data));
    }, 30000);
    return () => clearInterval(timer);
  }, [elements, backgroundImage, imageWidth, imageHeight, projectName, bgOpacity]);

  // Ruler state
  const RULER_SIZE = 20;
  const canvasWidth = containerSize.width;
  const canvasHeight = containerSize.height;

  const getCursor = () => {
    if (currentTool === 'draw-route') return 'crosshair';
    if (currentTool === 'draw-area') return 'nwse-resize';
    if (currentTool === 'text-tool') return 'text';
    if (currentTool === 'pan' || dragState.type === 'pan') return 'grab';
    if (dragState.type === 'element' || dragState.type === 'node') return 'move';
    return 'default';
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden bg-[#f0f1f3]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        className="block"
        style={{ cursor: getCursor(), width: '100%', height: '100%' }}
      />

      {/* Ruler bars */}
      {/* Top ruler */}
      <div
        className="absolute top-0 left-0 right-0 z-10 select-none"
        style={{ height: RULER_SIZE }}
        onMouseDown={(e) => {
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          const x = e.clientX - rect.left;
          const canvasPos = (x - stagePosition.x) / stageScale;
          addGuideLine({ id: `gl_${Date.now()}`, orientation: 'horizontal', position: canvasPos });
          setRulerDrag({ orientation: 'horizontal', active: true, pos: canvasPos });
        }}
      >
        <div className="relative w-full h-full">
          {/* Ruler background */}
          <div className="absolute inset-0 bg-[#1a1a2e]/90 border-b border-[#2a2a4e]" />
          {/* Tick marks */}
          <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
            {gridEnabled && Array.from({ length: Math.ceil(canvasWidth / (gridSize * stageScale)) + 1 }).map((_, i) => {
              const x = i * gridSize * stageScale + stagePosition.x;
              const h = i % 5 === 0 ? 14 : (i % 2 === 0 ? 10 : 6);
              return (
                <line key={i} x1={x} y1={RULER_SIZE} x2={x} y2={RULER_SIZE - h} stroke="#4a4a6e" strokeWidth={0.5} />
              );
            })}
          </svg>
        </div>
      </div>

      {/* Left ruler */}
      <div
        className="absolute top-0 left-0 bottom-0 z-10 select-none"
        style={{ width: RULER_SIZE }}
        onMouseDown={(e) => {
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          const y = e.clientY - rect.top;
          const canvasPos = (y - stagePosition.y) / stageScale;
          addGuideLine({ id: `gl_${Date.now()}`, orientation: 'vertical', position: canvasPos });
          setRulerDrag({ orientation: 'vertical', active: true, pos: canvasPos });
        }}
      >
        <div className="relative w-full h-full">
          <div className="absolute inset-0 bg-[#1a1a2e]/90 border-r border-[#2a2a4e]" />
          <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
            {gridEnabled && Array.from({ length: Math.ceil(canvasHeight / (gridSize * stageScale)) + 1 }).map((_, i) => {
              const y = i * gridSize * stageScale + stagePosition.y;
              const w = i % 5 === 0 ? 14 : (i % 2 === 0 ? 10 : 6);
              return (
                <line key={i} x1={RULER_SIZE} y1={y} x2={RULER_SIZE - w} y2={y} stroke="#4a4a6e" strokeWidth={0.5} />
              );
            })}
          </svg>
        </div>
      </div>

      {/* Ruler corner */}
      <div className="absolute top-0 left-0 z-10 bg-[#1a1a2e]/90 border-b border-r border-[#2a2a4e]" style={{ width: RULER_SIZE, height: RULER_SIZE }}>
        <div className="w-full h-full flex items-center justify-center">
          <svg className="w-3 h-3 text-[#4a4a6e]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M4 4v16h16" />
          </svg>
        </div>
      </div>

      {/* Drawing hint */}
      {isDrawing && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-lg text-sm backdrop-blur-sm whitespace-nowrap">
          点击添加节点 · 双击或按 Enter 完成 · Esc 取消
        </div>
      )}

      {/* Mouse coordinates */}
      {canvasMousePos && (
        <div className="absolute bottom-4 right-16 bg-black/60 text-white px-3 py-1.5 rounded-lg text-xs backdrop-blur-sm font-mono">
          X: {Math.round(canvasMousePos.x)} Y: {Math.round(canvasMousePos.y)}
        </div>
      )}

      {/* Zoom indicator */}
      <div className="absolute bottom-4 right-4 bg-black/60 text-white px-3 py-1.5 rounded-lg text-xs backdrop-blur-sm">
        {Math.round(stageScale * 100)}%
      </div>

      {/* Drag & drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-500/10 border-2 border-dashed border-blue-400 flex items-center justify-center pointer-events-none">
          <div className="bg-black/70 text-white px-6 py-4 rounded-lg text-sm backdrop-blur-sm">
            松开导入图片
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 bg-[#1a1a2e] border border-[#2a2a4e] rounded-lg shadow-2xl py-1 min-w-[140px]"
            style={{ left: contextMenu.pos.x, top: contextMenu.pos.y }}
          >
            {contextMenu.elementId ? (
              <>
                <button
                  className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-white/5 flex items-center gap-2"
                  onClick={() => { duplicateElement(contextMenu.elementId!); setContextMenu(null); }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                  复制
                </button>
                <button
                  className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-white/5 flex items-center gap-2"
                  onClick={() => { bringToFront(contextMenu.elementId!); setContextMenu(null); }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                  置顶
                </button>
                <button
                  className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-white/5 flex items-center gap-2"
                  onClick={() => { sendToBack(contextMenu.elementId!); setContextMenu(null); }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  置底
                </button>
                <div className="border-t border-[#2a2a4e] my-1" />
                <button
                  className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2"
                  onClick={() => {
                    const el = elements.find(e => e.id === contextMenu.elementId);
                    if (el && !el.locked) {
                      deleteElement(contextMenu.elementId!);
                    }
                    setContextMenu(null);
                  }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  删除
                </button>
              </>
            ) : (
              <div className="px-4 py-2 text-xs text-gray-500">无操作</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}