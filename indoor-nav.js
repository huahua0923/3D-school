// ============================================================
// indoor-nav.js — 室内寻路内核（纯函数，无 DOM / 无框架依赖）
//
// 把编辑器画好的每层方案（route 走廊 / area 房间 / stair 楼梯）
// 建成一张「跨层无向图」，再用 Dijkstra 求最短路径。
//
// 坐标约定：每层用自己的画布像素坐标 (x, y)，跨层靠楼梯的
// 「垂直边」衔接（同 stairId 在不同楼层的点之间连边）。
//
// 用法（Node）：   const { buildGraph, findPath } = require('./indoor-nav.js')
// 用法（浏览器）： <script src="indoor-nav.js"></script> → 全局 IndoorNav
//
// 元素格式与编辑器 editor.js 一致：
//   route: { type:'route', points:[{x,y},...] }            → 走廊线
//   area : { type:'area',  points:[{x,y},...], name, category } → 房间（取质心）
//   stair: { type:'stair', points:[{x,y}], name }          → 楼梯点（name 即 stairId）
//   text : 忽略
// ============================================================
(function (global) {
  'use strict';

  // ---- 可调参数 ----
  const SNAP_TOLERANCE = 6;    // 走廊节点合并容差（px）：两条走廊端点/拐点在此距离内视为同一节点
  const ROOM_SNAP_MAX = 200;   // 房间质心/楼梯点到最近走廊的最大连接距离（px），超出视为不可达
  const STAIR_COST = 50;       // 走一层楼梯的代价（px 等价，越小越愿意爬楼，可调）

  // ===================== 基础几何 =====================
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // 点到线段的最近点（垂足），返回 { foot, t, dist }
  function pointToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { foot: { x: a.x, y: a.y }, t: 0, dist: dist(p, a) };
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const foot = { x: a.x + t * dx, y: a.y + t * dy };
    return { foot, t, dist: dist(p, foot) };
  }

  // ===================== 最小堆（Dijkstra 用） =====================
  function MinHeap() {
    const a = [];
    const less = (i, j) => a[i].p < a[j].p;
    const swap = (i, j) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
    function up(i) { while (i > 0) { const p = (i - 1) >> 1; if (less(i, p)) { swap(i, p); i = p; } else break; } }
    function down(i) {
      const n = a.length;
      while (true) {
        let l = i * 2 + 1, r = i * 2 + 2, m = i;
        if (l < n && less(l, m)) m = l;
        if (r < n && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m); i = m;
      }
    }
    return {
      get size() { return a.length; },
      push(id, p) { a.push({ id, p }); up(a.length - 1); },
      pop() { const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; down(0); } return top.id; },
    };
  }

  // ===================== 建图 =====================
  // plans: [{ floor:number, elements:[...] }, ...]（同一栋楼的各层）
  // opts:  { snapTolerance, roomSnapMax, stairCost } 可覆盖默认参数
  // 返回:  { nodes, edges, nodeById:Map, adj:Map, floors:number[] }
  function buildGraph(plans, opts = {}) {
    const snap = opts.snapTolerance ?? SNAP_TOLERANCE;
    const roomSnapMax = opts.roomSnapMax ?? ROOM_SNAP_MAX;
    const stairCost = opts.stairCost ?? STAIR_COST;

    const nodes = [];
    const edges = [];
    const nodeById = new Map();
    const posKey = new Map();        // `${floor}:${snapKey}` -> nodeId（走廊节点去重）
    const segmentsByFloor = new Map(); // floor -> [{ a:node, b:node }] 走廊线段（供投影）

    let nid = 0;
    function newNode(floor, x, y, type, name, extra) {
      extra = extra || {};
      const node = {
        id: 'n' + (++nid), floor, x, y, type, name: name || '',
        category: extra.category || null,
        stairId: extra.stairId || null,
        elementId: extra.elementId || null,
      };
      nodes.push(node);
      nodeById.set(node.id, node);
      return node;
    }
    function addEdge(from, to, weight, type) {
      edges.push({ id: 'e' + edges.length, from, to, weight, type: type || 'walk' });
    }

    const snapKeyOf = (x, y) => Math.round(x / snap) + ',' + Math.round(y / snap);

    // 取得/创建某层的走廊节点（同一容差内复用）
    function corridorNodeAt(x, y, floor, elementId) {
      const k = floor + ':' + snapKeyOf(x, y);
      if (posKey.has(k)) return nodeById.get(posKey.get(k));
      const node = newNode(floor, x, y, 'corridor', '走廊节点', { elementId });
      posKey.set(k, node.id);
      return node;
    }

    // ---- Phase A：走廊网络（每层 route 的顶点=节点，相邻顶点=边） ----
    for (const plan of plans) {
      const floor = plan.floor;
      const segs = [];
      segmentsByFloor.set(floor, segs);
      for (const el of (plan.elements || [])) {
        if (el.type !== 'route') continue;
        const pts = el.points || [];
        if (pts.length < 2) continue;
        let prev = corridorNodeAt(pts[0].x, pts[0].y, floor, el.id);
        for (let i = 1; i < pts.length; i++) {
          const cur = corridorNodeAt(pts[i].x, pts[i].y, floor, el.id);
          if (prev.id !== cur.id) {
            addEdge(prev.id, cur.id, dist(prev, cur), 'walk');
            segs.push({ a: prev, b: cur });
          }
          prev = cur;
        }
      }
    }

    // 找某层离 (px,py) 最近的走廊节点或线段垂足
    function nearestCorridor(floor, px, py) {
      const p = { x: px, y: py };
      let best = null;
      for (const n of nodes) {
        if (n.floor !== floor || n.type !== 'corridor') continue;
        const d = dist(n, p);
        if (!best || d < best.dist) best = { node: n, dist: d, foot: { x: n.x, y: n.y }, onSegment: false };
      }
      for (const s of (segmentsByFloor.get(floor) || [])) {
        const r = pointToSegment(p, s.a, s.b);
        if (!best || r.dist < best.dist) best = { node: s.a, dist: r.dist, foot: r.foot, onSegment: true, seg: s };
      }
      return best;
    }

    // 把「最近点」落成走廊节点：若是垂足则插入节点并劈开该线段，返回可挂接的节点
    function connectToCorridor(floor, near) {
      if (!near.onSegment) return near.node;
      const s = near.seg;
      if (dist(near.foot, s.a) < snap) return s.a;
      if (dist(near.foot, s.b) < snap) return s.b;
      const n = corridorNodeAt(near.foot.x, near.foot.y, floor, null);
      const idx = edges.findIndex(e =>
        (e.from === s.a.id && e.to === s.b.id) || (e.from === s.b.id && e.to === s.a.id));
      if (idx >= 0) edges.splice(idx, 1);
      addEdge(s.a.id, n.id, dist(s.a, n), 'walk');
      addEdge(n.id, s.b.id, dist(n, s.b), 'walk');
      const segs = segmentsByFloor.get(floor);
      segs.push({ a: s.a, b: n });
      segs.push({ a: n, b: s.b });
      return n;
    }

    // ---- Phase B：房间（area 质心）与楼梯点挂到走廊 ----
    for (const plan of plans) {
      const floor = plan.floor;
      for (const el of (plan.elements || [])) {
        if (el.type === 'area') {
          const pts = el.points || [];
          if (pts.length < 3) continue;
          const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
          const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
          const room = newNode(floor, cx, cy, 'room', el.name || '', {
            category: el.category || null, elementId: el.id,
          });
          const near = nearestCorridor(floor, cx, cy);
          if (near && near.dist <= roomSnapMax) {
            const target = connectToCorridor(floor, near);
            addEdge(room.id, target.id, near.dist, 'walk');
          }
        } else if (el.type === 'stair') {
          const p = (el.points && el.points[0]) || null;
          if (!p) continue;
          const stairId = (el.name || el.stairId || '').trim() || ('楼梯' + el.id);
          const stair = newNode(floor, p.x, p.y, 'stair', stairId, { stairId, elementId: el.id });
          const near = nearestCorridor(floor, p.x, p.y);
          if (near && near.dist <= roomSnapMax) {
            const target = connectToCorridor(floor, near);
            addEdge(stair.id, target.id, near.dist, 'walk');
          }
        }
      }
    }

    // ---- Phase C：楼梯垂直边（同 stairId 跨层衔接） ----
    const stairsByName = new Map();
    for (const n of nodes) {
      if (n.type !== 'stair') continue;
      if (!stairsByName.has(n.stairId)) stairsByName.set(n.stairId, []);
      stairsByName.get(n.stairId).push(n);
    }
    for (const arr of stairsByName.values()) {
      const byFloor = new Map();          // 每层只保留第一个（防同层重复点）
      for (const n of arr) if (!byFloor.has(n.floor)) byFloor.set(n.floor, n);
      const ordered = [...byFloor.values()].sort((a, b) => a.floor - b.floor);
      for (let i = 0; i < ordered.length - 1; i++) {
        addEdge(ordered[i].id, ordered[i + 1].id, stairCost, 'stair');
      }
    }

    // ---- 邻接表 ----
    const adj = new Map();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) {
      adj.get(e.from).push({ to: e.to, weight: e.weight, type: e.type });
      adj.get(e.to).push({ to: e.from, weight: e.weight, type: e.type });
    }

    return { nodes, edges, nodeById, adj, floors: [...new Set(plans.map(p => p.floor))].sort((a, b) => a - b) };
  }

  // ===================== 寻路 =====================
  // graph: buildGraph 的返回值
  // startId/endId: 节点 id
  // opts: { avoidStairs:boolean }  true 则不走楼梯垂直边（无障碍路径）
  // 返回: { path:[node,...], distance:number, floorsCrossed:number } | null（不可达）
  function findPath(graph, startId, endId, opts) {
    opts = opts || {};
    const avoidStairs = !!opts.avoidStairs;
    if (!graph.nodeById.has(startId) || !graph.nodeById.has(endId)) return null;

    const distMap = new Map();
    const prev = new Map();
    const visited = new Set();
    const heap = new MinHeap();

    distMap.set(startId, 0);
    heap.push(startId, 0);

    while (heap.size > 0) {
      const cur = heap.pop();
      if (visited.has(cur)) continue;
      visited.add(cur);
      if (cur === endId) break;
      const d = distMap.get(cur);
      for (const e of (graph.adj.get(cur) || [])) {
        if (avoidStairs && e.type === 'stair') continue;
        const nd = d + e.weight;
        if (!distMap.has(e.to) || nd < distMap.get(e.to)) {
          distMap.set(e.to, nd);
          prev.set(e.to, cur);
          heap.push(e.to, nd);
        }
      }
    }

    if (!distMap.has(endId)) return null;

    const pathIds = [];
    let c = endId;
    while (c !== undefined) { pathIds.unshift(c); c = prev.get(c); }

    const path = pathIds.map(id => graph.nodeById.get(id));
    let floorsCrossed = 0;
    for (let i = 1; i < path.length; i++) {
      if (path[i].floor !== path[i - 1].floor) floorsCrossed++;
    }
    return { path, distance: distMap.get(endId), floorsCrossed };
  }

  // ===================== 查询辅助 =====================
  function findNodeByLabel(graph, name, floor) {
    const hit = graph.nodes.find(n =>
      n.name === name && (floor === undefined || n.floor === floor));
    return hit || null;
  }

  function findNodes(graph, predicate) {
    return graph.nodes.filter(predicate);
  }

  const api = { buildGraph, findPath, findNodeByLabel, findNodes, VERSION: '0.1.0' };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.IndoorNav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
