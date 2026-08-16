'use client';

import React from 'react';
import { useEditorStore } from '@/lib/store';

export default function StatusBar() {
  const {
    elements, stageScale, gridEnabled, snapToGrid,
    gridSize, setSnapToGrid, guideLines, clearGuideLines,
    historyStep, projectName,
  } = useEditorStore();

  const routeCount = elements.filter((el) => el.type === 'route').length;
  const areaCount = elements.filter((el) => el.type === 'area').length;
  const textCount = elements.filter((el) => el.type === 'text').length;

  return (
    <div className="h-7 bg-[#0d0d1a] border-t border-[#2a2a4e] flex items-center px-4 gap-4 text-xs text-gray-500 flex-shrink-0">
      {/* Project info */}
      <span className="text-gray-400">{projectName || '未命名项目'}</span>

      <div className="w-px h-3 bg-[#2a2a4e]" />

      {/* Element count */}
      <span>
        路线 {routeCount} · 区域 {areaCount} · 文字 {textCount}
        <span className="text-gray-600 ml-1">| 共 {elements.length} 个元素</span>
      </span>

      <div className="w-px h-3 bg-[#2a2a4e]" />

      {/* Zoom */}
      <span>缩放 {Math.round(stageScale * 100)}%</span>

      <div className="w-px h-3 bg-[#2a2a4e]" />

      {/* Grid */}
      <span>网格 {gridSize}px {gridEnabled ? '✓' : '✗'}</span>

      {/* Snap to grid toggle */}
      <button
        onClick={() => setSnapToGrid(!snapToGrid)}
        className={`px-1.5 py-0.5 rounded transition-colors ${
          snapToGrid ? 'text-blue-400 bg-blue-500/10' : 'text-gray-500 hover:text-gray-300'
        }`}
        title="吸附到网格"
      >
        吸附 {snapToGrid ? '✓' : '✗'}
      </button>

      <div className="w-px h-3 bg-[#2a2a4e]" />

      {/* Guide lines */}
      {guideLines.length > 0 && (
        <>
          <span>参考线 {guideLines.length}条</span>
          <button
            onClick={clearGuideLines}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="清除所有参考线"
          >
            清除
          </button>
          <div className="w-px h-3 bg-[#2a2a4e]" />
        </>
      )}

      <div className="flex-1" />

      {/* History step */}
      <span className="text-gray-600">历史 {historyStep}</span>
    </div>
  );
}