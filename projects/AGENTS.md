# AGENTS.md

## 项目概览

场地路线图编辑器 - 大型活动场地人流路线图编辑工具。用户可以导入场地图片作为底图，在上面绘制嘉宾路线、志愿者路线、座位区域、等待区域等，并支持保存/加载项目文件和导出 PNG 图片。

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **Canvas**: HTML5 Canvas API (原生)
- **State**: Zustand
- **Styling**: Tailwind CSS 4

## 目录结构

```
src/
├── app/
│   ├── layout.tsx          # 根布局
│   ├── page.tsx            # 主页面（编辑器入口）
│   └── globals.css         # 全局样式
├── components/
│   ├── editor/
│   │   ├── Canvas.tsx      # 画布编辑器核心（HTML5 Canvas）
│   │   ├── CanvasWrapper.tsx # Canvas 客户端包装组件
│   │   ├── Toolbar.tsx     # 左侧工具栏
│   │   ├── LayerPanel.tsx  # 右侧图层面板
│   │   └── TopBar.tsx      # 顶部操作栏
│   └── ui/                 # shadcn/ui 组件
└── lib/
    ├── types.ts            # 类型定义与元素分类配置
    ├── store.ts            # Zustand 状态管理
    └── utils.ts            # 通用工具函数
```

## 核心功能

1. **图片导入**: 支持导入场地图片作为画布背景
2. **路线绘制**: 点击添加节点，双击/Enter 完成绘制
   - 嘉宾路线（琥珀金 #f59e0b）
   - 志愿者路线（天际蓝 #3b82f6）
3. **区域绘制**: 点击添加多边形顶点，双击/Enter 闭合
   - 座位区域（翡翠绿 #10b981）
   - 等待区域（暖橙色 #f97316）
4. **图层管理**: 显隐、锁定、删除、重命名
5. **保存/加载**: JSON 格式项目文件导入导出
6. **导出图片**: 导出为 PNG 格式

## 快捷键

- `Esc`: 取消绘制 / 取消选择
- `Enter`: 完成当前绘制
- `Delete/Backspace`: 删除选中元素

## 构建命令

```bash
pnpm install          # 安装依赖
pnpm run dev          # 开发模式
pnpm run build        # 生产构建
pnpm run start        # 生产启动
```
