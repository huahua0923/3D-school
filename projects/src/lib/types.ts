export type ElementType = 'route' | 'area' | 'text';

export type ToolMode = 'select' | 'draw-route' | 'draw-area' | 'text-tool' | 'pan';

export interface Point {
  x: number;
  y: number;
}

export interface GuideLine {
  id: string;
  orientation: 'horizontal' | 'vertical';
  position: number;
}

export interface MapElement {
  id: string;
  type: ElementType;
  name: string;
  visible: boolean;
  locked: boolean;
  points: Point[];
  color: string;
  strokeWidth: number;
  opacity: number;
  label?: string;
  fontSize?: number;
  backgroundColor?: string;
}

export interface ProjectData {
  version: number;
  backgroundImage: string | null;
  imageWidth: number;
  imageHeight: number;
  elements: MapElement[];
  projectName: string;
  createdAt: string;
  updatedAt: string;
}

export type ToolDef = {
  tool: ToolMode;
  label: string;
  icon: string;
  shortcut: string;
};

export const TOOLS: ToolDef[] = [
  { tool: 'select', label: '选择', icon: 'cursor', shortcut: 'V' },
  { tool: 'pan', label: '平移', icon: 'hand', shortcut: 'H' },
  { tool: 'draw-route', label: '画线', icon: 'route', shortcut: 'L' },
  { tool: 'draw-area', label: '画框', icon: 'area', shortcut: 'R' },
  { tool: 'text-tool', label: '文字', icon: 'text', shortcut: 'T' },
];