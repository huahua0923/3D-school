// ============================================================
// seed-indoor.js — 插入「教学楼A」三层室内导航示例方案
// 用法: node seed-indoor.js           （写入数据库）
//       node seed-indoor.js --dry-run （只生成数据 + 本地预检寻路，不写库）
// 追加式写入，不清空已有数据；若已存在同名建筑则跳过。
// 供首页「室内寻路」跨层导航演示。
// ============================================================

const path = require('path');
const { initDb, closeDb, saveEditorProject, getEditorProjects, deleteEditorProject } = require('./db');

const dbPath = path.join(__dirname, 'data', 'exhibition-nav.db');
const configPath = path.join(__dirname, 'config.json');

const BUILDING = '教学楼A';
const W = 1200, H = 800;                     // 画布像素
const CORRIDOR_Y = 400;                      // 走廊中心线 y
const ROOM_OFFSET = 80;                      // 房间中心离走廊中心距离（px）
const ROOM_W = 100, ROOM_H = 80;             // 房间宽/高（px）
const XS = [350, 450, 550, 650, 750, 850];   // 6 间房 x 中心

const CAT_COLOR = { 教室: '#4da6ff', 办公室: '#34d399', 卫生间: '#94a3b8', 实验室: '#a78bfa', 入口: '#fbbf24' };

// 地理范围：画布 1200×800px ≈ 120×80 米（1px=0.1 米），中心对齐学校
const CENTER = [104.14141, 30.67133];  // 与 config.json geo.center 一致（学校地图中心）
const DEG_LNG = 1 / (111320 * Math.cos((CENTER[1] * Math.PI) / 180));
const DEG_LAT = 1 / 111320;
const geoBounds = {
  nw: [CENTER[0] - (W / 2) * 0.1 * DEG_LNG, CENTER[1] + (H / 2) * 0.1 * DEG_LAT],
  se: [CENTER[0] + (W / 2) * 0.1 * DEG_LNG, CENTER[1] - (H / 2) * 0.1 * DEG_LAT],
  rotation: 0,
};

let _n = 0;
const uid = (p) => `${p}${++_n}`;
const rect = (cx, cy) => [
  { x: cx - ROOM_W / 2, y: cy - ROOM_H / 2 },
  { x: cx + ROOM_W / 2, y: cy - ROOM_H / 2 },
  { x: cx + ROOM_W / 2, y: cy + ROOM_H / 2 },
  { x: cx - ROOM_W / 2, y: cy + ROOM_H / 2 },
];

// 每层：走廊 + 北侧 6 间 + 南侧 6 间 + 东西两个楼梯井
function buildFloor(f) {
  const north = [['N1', '教室'], ['N2', '教室'], ['N3', '教室'], ['N4', '实验室'], ['N5', '教室'], ['N6', '教室']];
  const south = [['S1', '卫生间'], ['S2', '教室'], ['S3', '教室'], ['S4', '教室'], ['S5', '办公室'], ['S6', '教室']];
  const els = [
    { id: uid('r'), type: 'route', name: '走廊', color: '#3b82f6', opacity: 0.9,
      points: [{ x: 300, y: CORRIDOR_Y }, { x: 600, y: CORRIDOR_Y }, { x: 900, y: CORRIDOR_Y }] },
  ];
  north.forEach(([s, cat], i) => els.push({ id: uid('a'), type: 'area', name: `${f}F-${s}`, category: cat, color: CAT_COLOR[cat], points: rect(XS[i], CORRIDOR_Y - ROOM_OFFSET) }));
  south.forEach(([s, cat], i) => els.push({ id: uid('a'), type: 'area', name: `${f}F-${s}`, category: cat, color: CAT_COLOR[cat], points: rect(XS[i], CORRIDOR_Y + ROOM_OFFSET) }));
  els.push({ id: uid('s'), type: 'stair', name: '东楼梯', color: '#8b5cf6', points: [{ x: 840, y: CORRIDOR_Y }] });
  els.push({ id: uid('s'), type: 'stair', name: '西楼梯', color: '#8b5cf6', points: [{ x: 360, y: CORRIDOR_Y }] });
  return els;
}

function buildBuilding() {
  const plans = [];
  for (let f = 1; f <= 3; f++) {
    const els = buildFloor(f);
    if (f === 1) {
      // 1F 加「入口」门厅 + 引道（楼外南侧，接到走廊）
      els.push({ id: uid('a'), type: 'area', name: '1F-入口', category: '入口', color: CAT_COLOR['入口'], points: rect(600, CORRIDOR_Y + ROOM_OFFSET + 80) });
      els.push({ id: uid('r'), type: 'route', name: '引道', color: '#3b82f6', opacity: 0.9, points: [{ x: 600, y: CORRIDOR_Y + ROOM_OFFSET + 80 }, { x: 600, y: CORRIDOR_Y }] });
    }
    plans.push({
      name: `${BUILDING}-${f}F`, floor: f, building: BUILDING,
      data: { imageWidth: W, imageHeight: H, geoBounds, elements: els },
    });
  }
  return plans;
}

// —— 本地预检（--dry-run）：不写库，只验证数据能建图 + 寻路 ——
if (process.argv.includes('--dry-run')) {
  const { buildGraph, findPath } = require('./indoor-nav.js');
  const plans = buildBuilding().map(p => ({ floor: p.floor, elements: p.data.elements }));
  const graph = buildGraph(plans);
  const rooms = graph.nodes.filter(n => n.type === 'room');
  const stairs = graph.nodes.filter(n => n.type === 'stair');
  const ent = rooms.find(n => n.name === '1F-入口');
  const target = rooms.find(n => n.name === '3F-S2');
  const r = ent && target ? findPath(graph, ent.id, target.id) : null;
  console.log(`节点=${graph.nodes.length} 房间=${rooms.length} 楼梯=${stairs.length} 楼梯边=${graph.edges.filter(e => e.type === 'stair').length}`);
  console.log(`寻路 1F-入口 → 3F-S2: ${r ? `距离${Math.round(r.distance)}px 跨${r.floorsCrossed}层 [${r.path.filter(n => n.type !== 'corridor').map(n => n.name).join(' → ')}]` : '不可达'}`);
  process.exit(0);
}

// —— 正式写入 ——
(async () => {
  await initDb(dbPath, configPath);
  // 删除旧「教学楼A」方案后重插（幂等，可安全重复运行；修正位置/结构变更）
  const existing = getEditorProjects().filter(p => (p.building || '') === BUILDING);
  for (const p of existing) {
    deleteEditorProject(p.id);
    console.log(`  🗑 删除旧方案 ${p.name} (id=${p.id})`);
  }
  const plans = buildBuilding();
  for (const p of plans) {
    const id = saveEditorProject(null, p.name, p.data, 'public', p.floor, p.building);
    const areaCount = p.data.elements.filter(e => e.type === 'area').length;
    console.log(`  ✅ ${p.name} (floor=${p.floor}, building=${p.building}, id=${id}, 房间=${areaCount})`);
  }
  closeDb();
  console.log('✅ 完成。打开首页 → 底部「室内寻路」即可看到教学楼A 的三层方案。');
})();
