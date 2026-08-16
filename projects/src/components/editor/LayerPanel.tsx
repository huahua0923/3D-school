'use client';

import React, { useState } from 'react';
import { useEditorStore } from '@/lib/store';

const PRESET_COLORS = [
  '#3b82f6', '#2563eb', '#f59e0b', '#f97316', '#10b981',
  '#059669', '#ef4444', '#dc2626', '#8b5cf6', '#7c3aed',
  '#ec4899', '#db2777', '#06b6d4', '#0891b2', '#84cc16',
  '#65a30d', '#f43f5e', '#e11d48', '#6366f1', '#4f46e5',
  '#ffffff', '#94a3b8', '#64748b', '#1e293b', '#000000',
];

export default function LayerPanel() {
  const {
    elements, selectedElementId, backgroundImage, imageWidth, imageHeight,
    setSelectedElement, updateElement, deleteElement,
    toggleElementVisibility, toggleElementLock, moveElementOrder,
    bringToFront, sendToBack, selectedElementIds,
    bgOpacity, setBgOpacity, clearAll,
  } = useEditorStore();
  const [showColorPicker, setShowColorPicker] = useState(false);

  const selectedElement = elements.find(el => el.id === selectedElementId);

  return (
    <div className="w-64 bg-[#1a1a2e] border-l border-[#2a2a4e] flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#2a2a4e]">
        <h3 className="text-sm font-medium text-gray-300">图层</h3>
      </div>

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto">
        {elements.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-xs">
            暂无元素<br />使用左侧工具开始绘制
          </div>
        ) : (
          <div className="py-1">
            {[...elements].reverse().map((el) => {
              const isSelected = el.id === selectedElementId;
              return (
                <div
                  key={el.id}
                  onClick={() => setSelectedElement(isSelected ? null : el.id)}
                  className={`
                    px-4 py-2.5 cursor-pointer transition-all duration-150
                    ${isSelected ? 'bg-white/10 border-l-2 border-white' : 'hover:bg-white/5 border-l-2 border-transparent'}
                  `}
                >
                  <div className="flex items-center gap-2.5">
                    {/* Color indicator */}
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: el.color, opacity: el.opacity }}
                    />
                    {/* Name */}
                    <span className="flex-1 text-sm text-gray-300 truncate">
                      {el.name}
                    </span>
                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ opacity: isSelected ? 1 : undefined }}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleElementVisibility(el.id); }}
                        className={`p-1 rounded ${el.visible ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-300'}`}
                        title={el.visible ? '隐藏' : '显示'}
                      >
                        {el.visible ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        )}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleElementLock(el.id); }}
                        className={`p-1 rounded ${el.locked ? 'text-amber-400' : 'text-gray-400 hover:text-white'}`}
                        title={el.locked ? '解锁' : '锁定'}
                      >
                        {el.locked ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                        )}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteElement(el.id); }}
                        className="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-red-400/10"
                        title="删除"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Properties panel */}
      <div className="border-t border-[#2a2a4e] p-4 space-y-3">
        {selectedElement ? (
          <>
            <div className="text-xs text-gray-500 mb-2">属性编辑</div>

            {/* Name */}
            <div>
              <label className="text-xs text-gray-400 block mb-1">名称</label>
              <input
                type="text"
                value={selectedElement.name}
                onChange={(e) => updateElement(selectedElement.id, { name: e.target.value })}
                className="w-full bg-[#0d0d1a] border border-[#2a2a4e] rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
              />
            </div>

            {/* Color */}
            <div>
              <label className="text-xs text-gray-400 block mb-1">颜色</label>
              <div className="flex items-center gap-2 mb-1">
                <div
                  className="w-7 h-7 rounded-full cursor-pointer border-2 border-white/20 flex-shrink-0"
                  style={{ backgroundColor: selectedElement.color }}
                  onClick={() => setShowColorPicker(!showColorPicker)}
                />
                <span className="text-xs text-gray-400">{selectedElement.color}</span>
              </div>
              {showColorPicker && (
                <div className="grid grid-cols-5 gap-1.5 p-2 bg-[#0d0d1a] rounded-lg mt-1">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => {
                        updateElement(selectedElement.id, { color: c });
                        setShowColorPicker(false);
                      }}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${
                        c === selectedElement.color ? 'border-white scale-110' : 'border-transparent hover:scale-110'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <div className="col-span-5 mt-1">
                    <label className="text-xs text-gray-500 block mb-1">自定义</label>
                    <input
                      type="color"
                      value={selectedElement.color}
                      onChange={(e) => updateElement(selectedElement.id, { color: e.target.value })}
                      className="w-full h-8 rounded cursor-pointer bg-transparent"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Stroke Width (for routes and areas) */}
            {selectedElement.type !== 'text' && (
              <div>
                <label className="text-xs text-gray-400 block mb-1">
                  线宽: <span className="text-gray-300">{selectedElement.strokeWidth}px</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="12"
                  value={selectedElement.strokeWidth}
                  onChange={(e) => updateElement(selectedElement.id, { strokeWidth: Number(e.target.value) })}
                  className="w-full accent-blue-500"
                />
              </div>
            )}

            {/* Font Size (for text) */}
            {selectedElement.type === 'text' && (
              <>
                {/* Text Content */}
                <div>
                  <label className="text-xs text-gray-400 block mb-1">文字内容</label>
                  <input
                    type="text"
                    value={selectedElement.label || ''}
                    onChange={(e) => updateElement(selectedElement.id, { label: e.target.value })}
                    className="w-full bg-[#0d0d1a] border border-[#2a2a4e] rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
                    placeholder="输入文字内容..."
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">
                    字号: <span className="text-gray-300">{selectedElement.fontSize || 16}px</span>
                  </label>
                  <input
                    type="range"
                    min="10"
                    max="72"
                    value={selectedElement.fontSize || 16}
                    onChange={(e) => updateElement(selectedElement.id, { fontSize: Number(e.target.value) })}
                    className="w-full accent-blue-500"
                  />
                </div>
                {/* Text Background Color */}
                <div>
                  <label className="text-xs text-gray-400 block mb-1">背景色</label>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded border border-white/10 flex-shrink-0" style={{ backgroundColor: selectedElement.backgroundColor || 'rgba(0,0,0,0.7)' }} />
                    <span className="text-xs text-gray-400">{selectedElement.backgroundColor || 'rgba(0,0,0,0.7)'}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-2 mb-2">
                    {['rgba(0,0,0,0.7)', 'rgba(255,255,255,0.8)', 'rgba(59,130,246,0.6)', 'rgba(16,185,129,0.6)', 'rgba(239,68,68,0.6)', 'rgba(245,158,11,0.6)', 'rgba(139,92,246,0.6)', 'rgba(236,72,153,0.6)', 'rgba(249,115,22,0.6)', 'rgba(34,211,238,0.6)'].map((c) => (
                      <button
                        key={c}
                        className={`w-full aspect-square rounded border ${selectedElement.backgroundColor === c ? 'border-white ring-1 ring-white' : 'border-white/10'} hover:scale-110 transition-transform`}
                        style={{ backgroundColor: c }}
                        onClick={() => updateElement(selectedElement.id, { backgroundColor: c })}
                        title={c}
                      />
                    ))}
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">自定义</label>
                    <input
                      type="color"
                      value={selectedElement.backgroundColor?.includes('rgba') ? '#000000' : selectedElement.backgroundColor || '#000000'}
                      onChange={(e) => {
                        const hex = e.target.value;
                        const r = parseInt(hex.slice(1,3), 16);
                        const g = parseInt(hex.slice(3,5), 16);
                        const b = parseInt(hex.slice(5,7), 16);
                        updateElement(selectedElement.id, { backgroundColor: `rgba(${r},${g},${b},0.7)` });
                      }}
                      className="w-full h-8 rounded cursor-pointer bg-transparent"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Opacity */}
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                透明度: <span className="text-gray-300">{Math.round(selectedElement.opacity * 100)}%</span>
              </label>
              <input
                type="range"
                min="5"
                max="100"
                value={Math.round(selectedElement.opacity * 100)}
                onChange={(e) => updateElement(selectedElement.id, { opacity: Number(e.target.value) / 100 })}
                className="w-full accent-blue-500"
              />
            </div>

            {/* Point count */}
            <div className="text-xs text-gray-500">
              节点数: {selectedElement.points.length}
              {selectedElement.type === 'route' && selectedElement.points.length >= 2 && ' | 路线长度'}
              {selectedElement.type === 'area' && selectedElement.points.length >= 3 && ' | 多边形'}
            </div>

            {/* Bring to front / Send to back */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => bringToFront(selectedElement.id)}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors border border-[#2a2a4e]"
                title="置顶"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
                置顶
              </button>
              <button
                onClick={() => sendToBack(selectedElement.id)}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-[#2a2a4e] rounded transition-colors border border-[#2a2a4e]"
                title="置底"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                置底
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Background image controls */}
            {backgroundImage && (
              <>
                <div className="text-xs text-gray-500 mb-2">背景图片</div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">
                    图片透明度: <span className="text-gray-300">{Math.round(bgOpacity * 100)}%</span>
                  </label>
                  <input
                    type="range"
                    min="5"
                    max="100"
                    value={Math.round(bgOpacity * 100)}
                    onChange={(e) => setBgOpacity(Number(e.target.value) / 100)}
                    className="w-full accent-blue-500"
                  />
                </div>
                <div className="text-xs text-gray-500">
                  尺寸: {imageWidth} × {imageHeight}px
                </div>
              </>
            )}
            {!backgroundImage && (
              <div className="text-xs text-gray-500 text-center py-4">
                点击顶部"导入图片"<br />上传场地平面图
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}