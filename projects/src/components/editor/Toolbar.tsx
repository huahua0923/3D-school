'use client';

import React from 'react';
import { useEditorStore } from '@/lib/store';
import { TOOLS } from '@/lib/types';
import type { ToolMode } from '@/lib/types';

const TOOL_ICONS: Record<string, React.ReactNode> = {
  cursor: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
      <path d="M13 13l6 6" />
    </svg>
  ),
  hand: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0v1" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.21 0-4.21-.9-5.66-2.34L3.5 14.5a1.5 1.5 0 0 1 2.12-2.12L8 14.5V6" />
    </svg>
  ),
  route: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" />
      <path d="M12 2l-2 2 2 2" />
      <path d="M12 18l-2 2 2 2" />
    </svg>
  ),
  area: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  ),
  text: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
};

export default function Toolbar() {
  const { currentTool, setTool, setSelectedElement, selectedElementId } = useEditorStore();

  const handleToolClick = (tool: ToolMode) => {
    setTool(tool);
    setSelectedElement(null);
  };

  return (
    <div className="flex flex-col items-center gap-1 py-3 px-2 bg-[#1a1a2e] border-r border-[#2a2a4e]">
      {TOOLS.map((toolDef) => {
        const isActive = currentTool === toolDef.tool;
        return (
          <button
            key={toolDef.tool}
            onClick={() => handleToolClick(toolDef.tool)}
            title={`${toolDef.label} (${toolDef.shortcut})`}
            className={`
              w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-150
              ${isActive
                ? 'bg-white/15 text-white shadow-sm'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
              }
            `}
          >
            <div className="relative">
              {TOOL_ICONS[toolDef.icon]}
              {isActive && (
                <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-white" />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}