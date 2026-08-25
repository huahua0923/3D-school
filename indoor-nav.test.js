// ============================================================
// indoor-nav.test.js — 室内寻路内核单测
// 写死一栋 3 层教学楼（2 个楼梯井、每层 2 个教室），验证：
//   1) 建图节点/边计数合理
//   2) 跨层寻路走「最近楼梯」且楼层跨越数正确
//   3) 同层寻路不跨层
//   4) avoidStairs 时跨层不可达
//   5) 房间 category / 楼梯 stairId 正确落入节点
// 运行：node indoor-nav.test.js
// ============================================================
'use strict';

const { buildGraph, findPath, findNodeByLabel } = require('./indoor-nav.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + ` (期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)})`); }

// ---- 构造数据 ----
// 走廊：每层一条 (0,100)→(200,100)→(400,100)
function route(id, pts) { return { id, type: 'route', name: id, points: pts }; }
// 房间：以质心为中心的方块
function area(id, name, category, cx, cy) {
  return { id, type: 'area', name, category, points: [
    { x: cx - 30, y: cy - 20 }, { x: cx + 30, y: cy - 20 },
    { x: cx + 30, y: cy + 20 }, { x: cx - 30, y: cy + 20 },
  ] };
}
// 楼梯：单点，name 即 stairId
function stair(id, name, x, y) { return { id, type: 'stair', name, points: [{ x, y }] }; }

const CORRIDOR = [{ x: 0, y: 100 }, { x: 200, y: 100 }, { x: 400, y: 100 }];

function buildTeachingBuilding() {
  const mkFloor = (f, rooms) => ({
    floor: f,
    elements: [
      route('r' + f, CORRIDOR),
      ...rooms,
      stair('s-east-' + f, '东楼梯', 60, 100),
      stair('s-west-' + f, '西楼梯', 340, 100),
    ],
  });
  return [
    mkFloor(1, [area('a101', '101', '教室', 100, 40), area('a102', '102', '教室', 300, 40), area('a-ent', '入口', '入口', 200, 160)]),
    mkFloor(2, [area('a201', '201', '教室', 100, 40), area('a202', '202', '教室', 300, 40)]),
    mkFloor(3, [area('a301', '301', '教室', 100, 40), area('a302', '302', '教室', 300, 40)]),
  ];
}

console.log('\n=== 1. 建图 ===');
const graph = buildGraph(buildTeachingBuilding());

const roomNodes = graph.nodes.filter(n => n.type === 'room');
const stairNodes = graph.nodes.filter(n => n.type === 'stair');
const corridorNodes = graph.nodes.filter(n => n.type === 'corridor');
const stairEdges = graph.edges.filter(e => e.type === 'stair');

eq(roomNodes.length, 7, '房间节点数 = 7（1楼3个 + 2楼2个 + 3楼2个）');
eq(stairNodes.length, 6, '楼梯节点数 = 6（东/西 × 3 层）');
eq(stairEdges.length, 4, '楼梯垂直边 = 4（东 2 条 + 西 2 条）');
ok(corridorNodes.length >= 3, '走廊节点数 >= 3');
ok(roomNodes.every(n => n.category === '教室' || n.category === '入口'), '房间节点带 category');
ok(stairNodes.every(n => n.stairId), '楼梯节点带 stairId');

const n301 = findNodeByLabel(graph, '301', 3);
const n101 = findNodeByLabel(graph, '101', 1);
const n302 = findNodeByLabel(graph, '302', 3);
const nEnt = findNodeByLabel(graph, '入口', 1);
ok(n301 && n101 && n302 && nEnt, '能按名字+楼层查到房间节点');

console.log('\n=== 2. 跨层寻路 301 → 101 ===');
const p1 = findPath(graph, n301.id, n101.id);
ok(p1, '301 → 101 可达');
if (p1) {
  eq(p1.floorsCrossed, 2, '楼层跨越 2 次（3→2→1）');
  ok(p1.path.some(n => n.stairId === '东楼梯'), '走了东楼梯（301 离东楼梯更近）');
  ok(!p1.path.some(n => n.stairId === '西楼梯'), '没绕到西楼梯');
  eq(p1.path[0].name, '301', '起点是 301');
  eq(p1.path[p1.path.length - 1].name, '101', '终点是 101');
  console.log('    路径: ' + p1.path.map(n => `${n.floor}F:${n.name}`).join(' → '));
}

console.log('\n=== 3. 同层寻路 301 → 302 ===');
const p2 = findPath(graph, n301.id, n302.id);
ok(p2, '301 → 302 可达');
if (p2) {
  eq(p2.floorsCrossed, 0, '同层不跨层');
  ok(!p2.path.some(n => n.type === 'stair'), '同层路径不含楼梯节点');
}

console.log('\n=== 4. avoidStairs 跨层不可达 ===');
const p3 = findPath(graph, n301.id, n101.id, { avoidStairs: true });
eq(p3, null, 'avoidStairs 时 301 → 101 返回 null（无电梯）');

console.log('\n=== 5. 入口(1F) → 302(3F) ===');
const p4 = findPath(graph, nEnt.id, n302.id);
ok(p4, '入口 → 302 可达');
if (p4) {
  eq(p4.floorsCrossed, 2, '楼层跨越 2 次');
  ok(p4.path.some(n => n.type === 'stair'), '路径经过楼梯节点');
}

console.log('\n=== 6. 不可达/非法 ===');
eq(findPath(graph, n301.id, 'nonsense'), null, '终点不存在返回 null');
eq(findPath(graph, 'nonsense', n101.id), null, '起点不存在返回 null');

console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========\n`);
process.exit(fail ? 1 : 0);
