'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useEditorStore } from '@/lib/store';
import type { ProjectData } from '@/lib/types';
import { toast } from 'sonner';

const SAVE_KEY = 'venue-editor-autosave';

export default function TopBar() {
  const {
    projectName, setProjectName,
    elements, backgroundImage, imageWidth, imageHeight,
    bgOpacity, stageScale, stagePosition,
    setBackgroundImage, importProject, exportProject, exportImage,
    clearAll, undo, redo, canUndo, canRedo,
    selectedElementId, selectedElementIds,
    duplicateElement, deleteElement, setSelectedElement,
    gridEnabled, setGridEnabled, gridSize, setGridSize,
    setSelectedElementIds, alignElements, bringToFront, sendToBack,
  } = useEditorStore();

  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showAutoSaveTip, setShowAutoSaveTip] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  // Auto-save to localStorage every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const state = {
        projectName,
        elements,
        backgroundImage,
        imageWidth,
        imageHeight,
        bgOpacity,
        stageScale,
        stagePosition,
        gridEnabled,
        gridSize,
      };
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      } catch { /* ignore quota errors */ }
    }, 30000);
    return () => clearInterval(interval);
  }, [projectName, elements, backgroundImage, imageWidth, imageHeight, bgOpacity, stageScale, stagePosition, gridEnabled, gridSize]);

  // Auto-restore on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SAVE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.backgroundImage && !backgroundImage) {
          setShowAutoSaveTip(true);
          setTimeout(() => setShowAutoSaveTip(false), 5000);
        }
      }
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImportImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          setBackgroundImage(ev.target?.result as string, img.width, img.height);
        };
        img.src = ev.target?.result as string;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [setBackgroundImage]);

  const handleExportImage = useCallback(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    const { elements, projectName } = useEditorStore.getState();

    // Draw legend on canvas
    const legendEls = elements.filter(el => el.visible && (el.type === 'route' || el.type === 'area'));
    if (legendEls.length > 0) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const lx = 20;
        const ly = 20;
        const lw = 180;
        const lh = 20 + legendEls.length * 24;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(lx, ly, lw, Math.max(lh, 40), 8);
        ctx.fill();

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('图例', lx + 12, ly + 18);

        legendEls.forEach((el, i) => {
          const y = ly + 34 + i * 24;
          // Color dot
          ctx.beginPath();
          ctx.arc(lx + 16, y, 5, 0, Math.PI * 2);
          ctx.fillStyle = el.color;
          ctx.fill();
          // Name
          ctx.fillStyle = '#ddd';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(el.name, lx + 30, y + 4);
        });
        ctx.restore();
      }
    }

    link.download = `${projectName || '场地路线图'}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    toast.success('图片已导出');
  }, []);

  const handleExportSvg = useCallback(() => {
    const { elements, backgroundImage, imageWidth, imageHeight, projectName } = useEditorStore.getState();
    const visibleEls = elements.filter(el => el.visible);
    if (visibleEls.length === 0 && !backgroundImage) {
      toast.error('没有可导出的内容');
      return;
    }

    // Build SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth || 800}" height="${imageHeight || 600}" viewBox="0 0 ${imageWidth || 800} ${imageHeight || 600}">`;
    svg += `<rect width="100%" height="100%" fill="#f8f9fa"/>`;

    if (backgroundImage) {
      svg += `<image href="${backgroundImage}" width="${imageWidth}" height="${imageHeight}" opacity="0.8"/>`;
    }

    for (const el of visibleEls) {
      if (el.type === 'route' && el.points.length >= 2) {
        const d = el.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        svg += `<path d="${d}" stroke="${el.color}" stroke-width="${el.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        // Arrows
        for (let i = 0; i < el.points.length - 1; i++) {
          const angle = Math.atan2(el.points[i + 1].y - el.points[i].y, el.points[i + 1].x - el.points[i].x);
          const ax = el.points[i + 1].x;
          const ay = el.points[i + 1].y;
          svg += `<polygon points="${ax},${ay} ${ax - 12 * Math.cos(angle - 0.5)},${ay - 12 * Math.sin(angle - 0.5)} ${ax - 12 * Math.cos(angle + 0.5)},${ay - 12 * Math.sin(angle + 0.5)}" fill="${el.color}"/>`;
        }
      } else if (el.type === 'area' && el.points.length >= 3) {
        const d = el.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + 'Z';
        svg += `<path d="${d}" fill="${el.color}${Math.round(el.opacity * 255).toString(16).padStart(2, '0')}" stroke="${el.color}" stroke-width="${el.strokeWidth}"/>`;
      } else if (el.type === 'text' && el.points.length > 0) {
        const p = el.points[0];
        const text = el.label || el.name;
        const fontSize = el.fontSize || 16;
        svg += `<rect x="${p.x - 60}" y="${p.y - fontSize - 8}" width="120" height="${fontSize + 16}" rx="6" fill="${el.backgroundColor || 'rgba(0,0,0,0.7)'}"/>`;
        svg += `<text x="${p.x}" y="${p.y - 4}" text-anchor="middle" fill="${el.color}" font-size="${fontSize}" font-weight="bold">${text}</text>`;
      }
    }
    svg += '</svg>';

    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `${projectName || '场地路线图'}.svg`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('SVG 已导出');
  }, []);

  const loadInputRef = useRef<HTMLInputElement>(null);
  const handleLoadProject = useCallback(() => {
    loadInputRef.current?.click();
  }, []);
  const handleFileLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string) as ProjectData;
        importProject(data);
      } catch { /* ignore */ }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [importProject]);

  const allElementIds = elements.map(el => el.id);
  const selectedIds = selectedElementIds.length > 0 ? selectedElementIds : (selectedElementId ? [selectedElementId] : []);
  const hasSelection = selectedIds.length > 0;

  return (
    <>
      <div className="h-12 bg-[#1a1a2e] border-b border-[#2a2a4e] flex items-center px-4 gap-2 flex-shrink-0">
        {/* Project name */}
        <div className="flex items-center gap-2 mr-2">
          <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
          </svg>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="bg-transparent text-sm text-gray-300 border border-transparent hover:border-[#2a2a4e] focus:border-gray-500 rounded px-2 py-1 w-32 outline-none"
          />
        </div>

        <div className="w-px h-6 bg-[#2a2a4e]" />

        {/* Import Image */}
        <button onClick={handleImportImage} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="导入图片">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          导入图片
        </button>

        <div className="w-px h-6 bg-[#2a2a4e]" />

        {/* Undo / Redo */}
        <button onClick={undo} disabled={!canUndo} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed" title="撤销 (Ctrl+Z)">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
        </button>
        <button onClick={redo} disabled={!canRedo} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed" title="重做 (Ctrl+Y)">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6" />
          </svg>
        </button>

        <div className="w-px h-6 bg-[#2a2a4e]" />

        {/* Grid toggle */}
        <button
          onClick={() => setGridEnabled(!gridEnabled)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded transition-colors ${gridEnabled ? 'text-blue-400 bg-blue-500/10' : 'text-gray-400 hover:text-white hover:bg-[#2a2a4e]'}`}
          title="显示/隐藏网格"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
          </svg>
          网格
        </button>

        {/* Grid size */}
        {gridEnabled && (
          <select
            value={gridSize}
            onChange={(e) => setGridSize(Number(e.target.value))}
            className="bg-[#0d0d1a] border border-[#2a2a4e] text-xs text-gray-400 rounded px-1.5 py-1 outline-none w-12"
          >
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={40}>40</option>
            <option value={50}>50</option>
          </select>
        )}

        <div className="w-px h-6 bg-[#2a2a4e]" />

        {/* Align buttons (only when multiple selected) */}
        {hasSelection && selectedIds.length >= 2 && (
          <>
            <div className="flex items-center gap-0.5">
              <button onClick={() => alignElements(selectedIds, 'left')} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="左对齐">
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="6" height="2"/><rect x="1" y="7" width="10" height="2"/><rect x="1" y="12" width="8" height="2"/></svg>
              </button>
              <button onClick={() => alignElements(selectedIds, 'center')} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="水平居中">
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="10" height="2"/><rect x="5" y="7" width="6" height="2"/><rect x="4" y="12" width="8" height="2"/></svg>
              </button>
              <button onClick={() => alignElements(selectedIds, 'right')} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="右对齐">
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><rect x="9" y="2" width="6" height="2"/><rect x="5" y="7" width="10" height="2"/><rect x="7" y="12" width="8" height="2"/></svg>
              </button>
              <button onClick={() => alignElements(selectedIds, 'top')} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="顶部对齐">
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="1" width="2" height="6"/><rect x="7" y="1" width="2" height="10"/><rect x="12" y="1" width="2" height="8"/></svg>
              </button>
              <button onClick={() => alignElements(selectedIds, 'middle')} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="垂直居中">
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="2" height="10"/><rect x="7" y="5" width="2" height="6"/><rect x="12" y="4" width="2" height="8"/></svg>
              </button>
              <button onClick={() => alignElements(selectedIds, 'bottom')} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="底部对齐">
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="9" width="2" height="6"/><rect x="7" y="5" width="2" height="10"/><rect x="12" y="7" width="2" height="8"/></svg>
              </button>
              </div>
            <div className="w-px h-6 bg-[#2a2a4e]" />
          </>
        )}

        {/* Duplicate / Delete */}
        {hasSelection && (
          <>
            <button onClick={() => { const id = selectedIds[0]; if (id) duplicateElement(id); }} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="复制 (Ctrl+D)">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button onClick={() => { selectedIds.forEach(id => deleteElement(id)); setSelectedElementIds([]); }} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors" title="删除 (Delete)">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <div className="w-px h-6 bg-[#2a2a4e]" />
          </>
        )}

        {/* Save / Load / Export */}
        <button onClick={exportProject} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="保存项目">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
          </svg>
          保存
        </button>
        <input ref={loadInputRef} type="file" accept=".json" onChange={handleFileLoad} className="hidden" />
        <button onClick={handleLoadProject} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="打开项目">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          打开
        </button>

        {/* Export menu */}
        <div className="relative">
          <button onClick={() => setShowExportMenu(!showExportMenu)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="导出">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            导出
          </button>
          {showExportMenu && (
            <>
              <div className="fixed inset-0 z-50" onClick={() => setShowExportMenu(false)} />
              <div className="absolute top-full right-0 mt-1 bg-[#1a1a2e] border border-[#2a2a4e] rounded-lg shadow-2xl py-1 min-w-[140px] z-50">
                <button onClick={() => { handleExportImage(); setShowExportMenu(false); }} className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-white/5 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  PNG（含图例）
                </button>
                <button onClick={() => { handleExportSvg(); setShowExportMenu(false); }} className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-white/5 flex items-center gap-2">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" /></svg>
                  SVG 矢量图
                </button>
              </div>
            </>
          )}
        </div>

        <div className="flex-1" />

        {/* Zoom controls */}
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <button onClick={() => useEditorStore.getState().setStageScale(stageScale * 0.8)} className="p-1 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="缩小">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <input
            type="range"
            min="10"
            max="500"
            value={Math.round(stageScale * 100)}
            onChange={(e) => useEditorStore.getState().setStageScale(Number(e.target.value) / 100)}
            className="w-20 accent-blue-500"
            title="缩放"
          />
          <span className="w-10 text-center">{Math.round(stageScale * 100)}%</span>
          <button onClick={() => useEditorStore.getState().setStageScale(stageScale * 1.25)} className="p-1 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="放大">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button onClick={() => { useEditorStore.getState().setStageScale(1); useEditorStore.getState().setStagePosition({ x: 0, y: 0 }); }} className="ml-1 px-2 py-1 text-xs text-gray-500 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="重置视图">
            重置
          </button>
        </div>

        <div className="w-px h-6 bg-[#2a2a4e]" />

        {/* History step */}
        <span className="text-xs text-gray-500 font-mono">
          {useEditorStore.getState().historyStep}
        </span>

        <div className="w-px h-6 bg-[#2a2a4e]" />

        {/* Shortcut help */}
        <button onClick={() => setShowShortcutHelp(true)} className="p-1.5 text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors" title="快捷键 (?)">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </button>
      </div>

      {/* Auto-save tip */}
      {showAutoSaveTip && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs px-4 py-2 rounded shadow-lg z-50 animate-fade-in">
          检测到上次的自动保存数据，已恢复
        </div>
      )}

      {/* Shortcut Help Modal */}
      {showShortcutHelp && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShowShortcutHelp(false)}>
          <div className="bg-[#1a1a2e] border border-[#2a2a4e] rounded-lg shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[#2a2a4e] flex items-center justify-between">
              <h2 className="text-base font-medium text-gray-200">快捷键</h2>
              <button onClick={() => setShowShortcutHelp(false)} className="text-gray-400 hover:text-white p-1">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">绘图工具</h3>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm"><span className="text-gray-300">选择工具</span><span className="text-gray-500 font-mono">V</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">平移工具</span><span className="text-gray-500 font-mono">H</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">画线</span><span className="text-gray-500 font-mono">L</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">画框</span><span className="text-gray-500 font-mono">R</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">文字标注</span><span className="text-gray-500 font-mono">T</span></div>
                </div>
              </div>
              <div>
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">编辑操作</h3>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm"><span className="text-gray-300">撤销</span><span className="text-gray-500 font-mono">Ctrl+Z</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">重做</span><span className="text-gray-500 font-mono">Ctrl+Y</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">复制选中元素</span><span className="text-gray-500 font-mono">Ctrl+D</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">删除选中元素</span><span className="text-gray-500 font-mono">Delete / Backspace</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">取消选择 / 取消绘制</span><span className="text-gray-500 font-mono">Esc</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">完成绘制</span><span className="text-gray-500 font-mono">Enter</span></div>
                </div>
              </div>
              <div>
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-2">画布操作</h3>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-sm"><span className="text-gray-300">缩放</span><span className="text-gray-500 font-mono">滚轮</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">平移画布</span><span className="text-gray-500 font-mono">拖拽 / H+拖拽</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">框选多选</span><span className="text-gray-500 font-mono">Shift+拖拽</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-300">显示快捷键</span><span className="text-gray-500 font-mono">?</span></div>
                </div>
              </div>
              <div className="text-xs text-gray-500 pt-2 border-t border-[#2a2a4e]">
                自动保存：每 30 秒自动保存到浏览器本地存储
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}