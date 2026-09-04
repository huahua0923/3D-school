// ============================================================
// 会展中心 3D 导览 — 数据库模块
// 基于 sql.js (SQLite WASM)，零原生依赖
// ============================================================

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// ---------- 模块级状态 ----------
let db = null;           // sql.js Database 实例
let dbPath = null;       // 数据库文件路径
let configPath = null;   // config.json 路径（用于自动填充和写入）

// ---------- 工具函数 ----------

/** 确保目录存在 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------- 持久化状态（去抖 + 原子写 + 备份） ----------
let saveTimer = null;   // 去抖定时器
let saveDirty = false;  // 是否有待落盘的写

/** 将数据库写入磁盘（去抖：合并短时间内的多次写，避免每次写操作都全量序列化阻塞事件循环） */
function saveDbToDisk() {
  if (!db || !dbPath) return;
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushDbToDisk();
  }, 800);
}

/** 立即同步落盘（原子写 + 备份），供 closeDb / 进程退出前调用，确保去抖窗口内的写不丢 */
function flushDbToDisk() {
  if (!db || !dbPath || !saveDirty) return;
  saveDirty = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    ensureDir(path.dirname(dbPath));
    // 原子写：先写 .tmp 再 rename，避免进程崩溃/断电写坏主库
    const tmpPath = dbPath + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    // 备份上一份（与 writeConfigJson 的 .bak 对齐，主库损坏可回退）
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, dbPath + '.bak');
    }
    fs.renameSync(tmpPath, dbPath);
  } catch (err) {
    console.error('❌ 数据库落盘失败:', err);
  }
}

// 进程退出前刷盘，避免去抖窗口内未落盘的写因重启丢失
function flushOnExit() {
  if (db && saveDirty) flushDbToDisk();
}
process.on('SIGINT', () => { flushOnExit(); process.exit(0); });
process.on('SIGTERM', () => { flushOnExit(); process.exit(0); });

/** 将配置对象写入 config.json */
function writeConfigJson(config) {
  const backupPath = configPath + '.bak';
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, backupPath);
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ---------- 功能模块开关默认值（透传字段，存 config.json 不进 SQLite 表）----------
const DEFAULT_FEATURES = {
  indoor:         { enabled: true, layerHeight: 4 },
  routeNav:       { enabled: true, defaultTravelMode: 'walking', guideFollow: true, navMarkersOnly: true },
  weather:        { enabled: true, refreshMin: 30 },
  nearby:         { enabled: true, radius: 2000 },
  measure:        { enabled: true },
  loca:           { enabled: true },
  buildingSwitch: { enabled: true },
  autoRotate:     { enabled: true },
};

// ---------- 初始化 ----------

/**
 * 初始化数据库：加载 sql.js WASM，打开/创建数据库文件，建表，自动填充
 * @param {string} [dbFile] 数据库文件路径，默认 ./data/exhibition-nav.db
 * @param {string} [cfgPath] config.json 路径，默认 ./config.json
 */
async function initDb(dbFile, cfgPath) {
  dbPath = dbFile || path.join(__dirname, 'data', 'exhibition-nav.db');
  configPath = cfgPath || path.join(__dirname, 'config.json');

  // 加载 sql.js WASM
  const SQL = await initSqlJs();

  // 尝试从磁盘读取已有数据库
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 启用 WAL 模式和外键
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');

  // 建表（幂等）
  createTables();
  // 迁移：为旧库补充新增列（visible / road_visible）
  migrateSchema();

  // 检查是否需要自动填充
  const versionRow = db.exec('SELECT version FROM schema_version');
  if (versionRow.length === 0 || versionRow[0].values.length === 0) {
    if (fs.existsSync(configPath)) {
      console.log('📥 首次运行，从 config.json 填充数据库...');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      seedFromConfig(config);
      console.log('✅ 数据库填充完成');
    }
  }

  // 持久化
  saveDbToDisk();
  return db;
}

/** 建表（CREATE TABLE IF NOT EXISTS — 幂等） */
function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS geo (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      amap_key TEXT NOT NULL DEFAULT '',
      amap_security_code TEXT NOT NULL DEFAULT '',
      center_lng REAL NOT NULL DEFAULT 0,
      center_lat REAL NOT NULL DEFAULT 0,
      zoom REAL NOT NULL DEFAULT 17,
      pitch REAL NOT NULL DEFAULT 55,
      rotation REAL NOT NULL DEFAULT 20,
      map_style TEXT NOT NULL DEFAULT 'amap://styles/dark'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scene_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ground_size REAL NOT NULL DEFAULT 200,
      fog_color TEXT NOT NULL DEFAULT '#0a0e17',
      fog_near REAL NOT NULL DEFAULT 60,
      fog_far REAL NOT NULL DEFAULT 220
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS buildings_main (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      w REAL NOT NULL DEFAULT 40,
      d REAL NOT NULL DEFAULT 60,
      h REAL NOT NULL DEFAULT 18,
      color TEXT NOT NULL DEFAULT '#1e2d5a',
      pos_x REAL NOT NULL DEFAULT 0,
      pos_y REAL NOT NULL DEFAULT 0,
      pos_z REAL NOT NULL DEFAULT 0,
      road_width REAL NOT NULL DEFAULT 8,
      visible INTEGER NOT NULL DEFAULT 1,
      road_visible INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS buildings_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      w REAL NOT NULL DEFAULT 10,
      d REAL NOT NULL DEFAULT 10,
      h REAL NOT NULL DEFAULT 6,
      x REAL NOT NULL DEFAULT 0,
      z REAL NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#253a6a',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS parking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      offset_x REAL NOT NULL DEFAULT 0,
      offset_y REAL NOT NULL DEFAULT 0,
      offset_z REAL NOT NULL DEFAULT 0,
      capacity INTEGER NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#4da6ff'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS particles (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      count INTEGER NOT NULL DEFAULT 180,
      spread REAL NOT NULL DEFAULT 90,
      height REAL NOT NULL DEFAULT 35
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS camera (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      fov REAL NOT NULL DEFAULT 42,
      near REAL NOT NULL DEFAULT 0.5,
      far REAL NOT NULL DEFAULT 400,
      initial_pos_x REAL NOT NULL DEFAULT 70,
      initial_pos_y REAL NOT NULL DEFAULT 50,
      initial_pos_z REAL NOT NULL DEFAULT 80,
      initial_target_x REAL NOT NULL DEFAULT 0,
      initial_target_y REAL NOT NULL DEFAULT 4,
      initial_target_z REAL NOT NULL DEFAULT 0,
      tween_ms INTEGER NOT NULL DEFAULT 1400,
      orbit_damping REAL NOT NULL DEFAULT 0.08,
      min_dist REAL NOT NULL DEFAULT 12,
      max_dist REAL NOT NULL DEFAULT 160,
      max_polar_factor REAL NOT NULL DEFAULT 0.46
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS camera_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      pos_x REAL NOT NULL DEFAULT 0,
      pos_y REAL NOT NULL DEFAULT 0,
      pos_z REAL NOT NULL DEFAULT 0,
      target_x REAL NOT NULL DEFAULT 0,
      target_y REAL NOT NULL DEFAULT 0,
      target_z REAL NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS editor_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '未命名项目',
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'public'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS nav_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '未命名路线',
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
}

/** 迁移：为旧数据库补充新增列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列） */
function migrateSchema() {
  const addColumn = (table, col, ddl) => {
    try {
      const info = db.exec(`PRAGMA table_info(${table})`);
      if (info.length === 0) return;
      const cols = info[0].values.map(v => v[1]);
      if (!cols.includes(col)) {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      }
    } catch (err) {
      console.error(`⚠️ 迁移 ${table}.${col} 失败:`, err.message);
    }
  };

  addColumn('buildings_main', 'visible', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('buildings_main', 'road_visible', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('buildings_main', 'name', "TEXT NOT NULL DEFAULT ''");
  // 方案可见性：public（普通用户可见）/ restricted（仅超级用户与管理员）
  addColumn('editor_projects', 'visibility', "TEXT NOT NULL DEFAULT 'public'");
  // 楼层：方案归属楼层（0=默认/未配置，1=1F, 2=2F…），默认 0F
  addColumn('editor_projects', 'floor', 'INTEGER NOT NULL DEFAULT 0');
  // 建筑：方案归属楼栋（分组键，同楼各层同值；空=未分组）
  addColumn('editor_projects', 'building', "TEXT NOT NULL DEFAULT ''");

  // 一次性迁移：旧版无楼层配置功能，floor 默认写入 1；把「未配置楼层」的旧数据归零（没有楼层 = 0 层）
  try {
    const uv = db.exec('PRAGMA user_version');
    const v = uv.length ? uv[0].values[0][0] : 0;
    if (v < 2) {
      db.run(`UPDATE editor_projects SET floor = 0 WHERE floor IS NULL OR floor = 1`);
      db.run(`PRAGMA user_version = 2`);
      console.log('✅ 迁移：旧方案楼层归零（没有楼层 = 0 层）');
    }
  } catch (err) {
    console.error('⚠️ 迁移 floor 归零失败:', err.message);
  }
}

// ---------- 数据填充 ----------

/** 从 config 对象填充所有表（清空后写入） */
function seedFromConfig(config) {
  // 先清空所有表
  const tables = [
    'geo', 'scene_settings', 'buildings_main', 'buildings_subs',
    'parking', 'particles', 'camera', 'camera_presets', 'schema_version'
  ];
  for (const t of tables) {
    db.run(`DELETE FROM ${t}`);
  }

  // --- Geo ---
  const g = config.geo || {};
  db.run(
    `INSERT INTO geo (id, amap_key, amap_security_code, center_lng, center_lat, zoom, pitch, rotation, map_style)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [g.amapKey || '', g.amapSecurityCode || '', (g.center || [0, 0])[0], (g.center || [0, 0])[1],
     g.zoom || 17, g.pitch || 55, g.rotation || 20, g.mapStyle || 'amap://styles/dark']
  );

  // --- Scene Settings ---
  db.run(
    `INSERT INTO scene_settings (id, ground_size, fog_color, fog_near, fog_far)
     VALUES (1, ?, ?, ?, ?)`,
    [config.groundSize || 200, config.fogColor || '#0a0e17', config.fogNear || 60, config.fogFar || 220]
  );

  // --- Buildings Main ---
  const bm = (config.building && config.building.main) || null;
  const bmVisible = bm ? 1 : 0;
  const roadVisible = (config.building && config.building.roadVisible === false) ? 0 : 1;
  db.run(
    `INSERT INTO buildings_main (id, w, d, h, color, pos_x, pos_y, pos_z, road_width, visible, road_visible, name)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bm ? (bm.w || 40) : 40, bm ? (bm.d || 60) : 60, bm ? (bm.h || 18) : 18,
     bm ? (bm.color || '#1e2d5a') : '#1e2d5a',
     bm ? (bm.pos || [0, 0, 0])[0] : 0, bm ? (bm.pos || [0, 0, 0])[1] : 0, bm ? (bm.pos || [0, 0, 0])[2] : 0,
     (config.building && config.building.roadWidth) || 8,
     bmVisible, roadVisible, bm ? (bm.name || '') : '']
  );

  // --- Buildings Subs ---
  const subs = (config.building && config.building.subs) || [];
  const insertSub = db.prepare(
    `INSERT INTO buildings_subs (w, d, h, x, z, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  subs.forEach((s, i) => {
    insertSub.run([s.w || 10, s.d || 10, s.h || 6, s.x || 0, s.z || 0, s.color || '#253a6a', i]);
  });

  // --- Parking ---
  const parking = config.parking || [];
  const insertParking = db.prepare(
    `INSERT INTO parking (name, offset_x, offset_y, offset_z, capacity, available, color)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  parking.forEach(p => {
    insertParking.run([
      p.name || '', (p.offset || [0, 0, 0])[0], (p.offset || [0, 0, 0])[1], (p.offset || [0, 0, 0])[2],
      p.capacity || 0, p.available || 0, p.color || '#4da6ff'
    ]);
  });

  // --- Particles ---
  const pt = config.particles || {};
  db.run(
    `INSERT INTO particles (id, count, spread, height) VALUES (1, ?, ?, ?)`,
    [pt.count || 180, pt.spread || 90, pt.height || 35]
  );

  // --- Camera ---
  const cam = config.camera || {};
  const init = cam.initial || {};
  db.run(
    `INSERT INTO camera (id, fov, near, far, initial_pos_x, initial_pos_y, initial_pos_z,
       initial_target_x, initial_target_y, initial_target_z, tween_ms, orbit_damping,
       min_dist, max_dist, max_polar_factor)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cam.fov || 42, cam.near || 0.5, cam.far || 400,
     (init.pos || [70, 50, 80])[0], (init.pos || [70, 50, 80])[1], (init.pos || [70, 50, 80])[2],
     (init.target || [0, 4, 0])[0], (init.target || [0, 4, 0])[1], (init.target || [0, 4, 0])[2],
     cam.tweenMs || 1400, cam.orbitDamping || 0.08, cam.minDist || 12, cam.maxDist || 160, cam.maxPolarFactor || 0.46]
  );

  // --- Camera Presets ---
  const presets = cam.presets || {};
  const insertPreset = db.prepare(
    `INSERT INTO camera_presets (key, pos_x, pos_y, pos_z, target_x, target_y, target_z)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [key, p] of Object.entries(presets)) {
    insertPreset.run([
      key,
      (p.pos || [0, 0, 0])[0], (p.pos || [0, 0, 0])[1], (p.pos || [0, 0, 0])[2],
      (p.target || [0, 0, 0])[0], (p.target || [0, 0, 0])[1], (p.target || [0, 0, 0])[2]
    ]);
  }

  // --- Schema Version ---
  db.run(`INSERT INTO schema_version (version, applied_at) VALUES (1, ?)`, [new Date().toISOString()]);

  saveDbToDisk();
  writeConfigJson(config);
}

// ---------- 读取完整配置 ----------

/** 从数据库组装完整 config 对象（与 config.json 结构一致） */
function getFullConfig() {
  if (!db) throw new Error('数据库未初始化，请先调用 initDb()');

  const one = (sql, params) => {
    const rows = db.exec(sql, params);
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    const cols = rows[0].columns;
    const vals = rows[0].values[0];
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i]; });
    return obj;
  };

  const all = (sql, params) => {
    const rows = db.exec(sql, params);
    if (rows.length === 0) return [];
    const cols = rows[0].columns;
    return rows[0].values.map(vals => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = vals[i]; });
      return obj;
    });
  };

  const geoRow = one('SELECT * FROM geo WHERE id = 1');
  const sceneRow = one('SELECT * FROM scene_settings WHERE id = 1');
  const bmRow = one('SELECT * FROM buildings_main WHERE id = 1');
  const subRows = all('SELECT * FROM buildings_subs ORDER BY sort_order');
  const parkingRows = all('SELECT * FROM parking ORDER BY id');
  const particlesRow = one('SELECT * FROM particles WHERE id = 1');
  const cameraRow = one('SELECT * FROM camera WHERE id = 1');
  const presetRows = all('SELECT * FROM camera_presets ORDER BY id');

  const config = {
    geo: geoRow ? {
      amapKey: '', // 高德 Key 已下沉到 .env（AMAP_KEY），不再经 config/数据库对外暴露
      amapSecurityCode: '',
      center: [geoRow.center_lng, geoRow.center_lat],
      zoom: geoRow.zoom,
      pitch: geoRow.pitch,
      rotation: geoRow.rotation,
      mapStyle: geoRow.map_style
    } : {},

    groundSize: sceneRow ? sceneRow.ground_size : 200,
    fogColor: sceneRow ? sceneRow.fog_color : '#0a0e17',
    fogNear: sceneRow ? sceneRow.fog_near : 60,
    fogFar: sceneRow ? sceneRow.fog_far : 220,

    building: bmRow ? {
      main: bmRow.visible === 1 ? {
        w: bmRow.w, d: bmRow.d, h: bmRow.h,
        color: bmRow.color,
        pos: [bmRow.pos_x, bmRow.pos_y, bmRow.pos_z],
        name: bmRow.name || ''
      } : null,
      subs: subRows.map(s => ({
        w: s.w, d: s.d, h: s.h, x: s.x, z: s.z, color: s.color
      })),
      roadWidth: bmRow.road_width,
      roadVisible: bmRow.road_visible !== 0
    } : { main: { w: 40, d: 60, h: 18, color: '#1e2d5a', pos: [0, 0, 0], name: '' }, subs: [], roadWidth: 8, roadVisible: true },

    markers: {},
    routes: {},
    parking: [],

    particles: particlesRow ? {
      count: particlesRow.count, spread: particlesRow.spread, height: particlesRow.height
    } : { count: 180, spread: 90, height: 35 },

    camera: cameraRow ? {
      fov: cameraRow.fov, near: cameraRow.near, far: cameraRow.far,
      initial: {
        pos: [cameraRow.initial_pos_x, cameraRow.initial_pos_y, cameraRow.initial_pos_z],
        target: [cameraRow.initial_target_x, cameraRow.initial_target_y, cameraRow.initial_target_z]
      },
      presets: {},
      tweenMs: cameraRow.tween_ms, orbitDamping: cameraRow.orbit_damping,
      minDist: cameraRow.min_dist, maxDist: cameraRow.max_dist, maxPolarFactor: cameraRow.max_polar_factor
    } : {}
  };

  // Parking
  config.parking = parkingRows.map(p => ({
    name: p.name,
    offset: [p.offset_x, p.offset_y, p.offset_z],
    capacity: p.capacity, available: p.available, color: p.color
  }));

  // Camera presets
  if (cameraRow) {
    for (const p of presetRows) {
      config.camera.presets[p.key] = {
        pos: [p.pos_x, p.pos_y, p.pos_z],
        target: [p.target_x, p.target_y, p.target_z]
      };
    }
  }

  // 透传字段：SQLite 未建模的 brand / planName，从 config.json 补齐
  // （否则后台保存时这些字段会被抹掉，导致首页标题/Logo 丢失）
  // 先给默认值，确保 config.brand 始终存在（否则后台无法设置品牌名）
  config.brand = { name: '', subtitle: '', logo: '', logoText: '' };
  config.features = JSON.parse(JSON.stringify(DEFAULT_FEATURES));
  let fileCfg = null;
  try {
    if (configPath && fs.existsSync(configPath)) {
      fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) {}
  if (fileCfg) {
    if (fileCfg.brand) config.brand = fileCfg.brand;
    if (fileCfg.planName !== undefined) config.planName = fileCfg.planName;
    if (fileCfg.features) {
      // 浅合并补默认：老 config.json 缺某模块时回退到 DEFAULT_FEATURES
      for (const [k, v] of Object.entries(DEFAULT_FEATURES)) {
        config.features[k] = { ...v, ...(fileCfg.features[k] || {}) };
      }
    }
  }

  // 迁移：老版本 logo 字段存的是文字/emoji，拆成 logo(图片) + logoText(文字)
  if (config.brand && config.brand.logo && !/^(data:image|https?:\/\/)/i.test(config.brand.logo)) {
    if (!config.brand.logoText) config.brand.logoText = config.brand.logo;
    config.brand.logo = '';
  }

  return config;
}

// ---------- 保存完整配置 ----------

/** 将 config 对象写入所有表并持久化到磁盘 */
function saveFullConfig(config) {
  seedFromConfig(config);
  saveDbToDisk();
}

// ---------- 实体级 CRUD ----------

// --- Geo ---
function getGeo() {
  const row = db.exec('SELECT * FROM geo WHERE id = 1');
  if (row.length === 0 || row[0].values.length === 0) return null;
  const g = row[0].values[0];
  return { amapKey: g[1], amapSecurityCode: g[2], center: [g[3], g[4]], zoom: g[5], pitch: g[6], rotation: g[7], mapStyle: g[8] };
}

function updateGeo(data) {
  db.run(`UPDATE geo SET amap_key=?, amap_security_code=?, center_lng=?, center_lat=?, zoom=?, pitch=?, rotation=?, map_style=? WHERE id=1`,
    [data.amapKey || '', data.amapSecurityCode || '', (data.center || [0, 0])[0], (data.center || [0, 0])[1],
     data.zoom ?? 17, data.pitch ?? 55, data.rotation ?? 20, data.mapStyle || 'amap://styles/dark']);
  syncToDisk();
}

// --- Scene ---
function getScene() {
  const row = db.exec('SELECT * FROM scene_settings WHERE id = 1');
  if (row.length === 0 || row[0].values.length === 0) return null;
  const s = row[0].values[0];
  return { groundSize: s[1], fogColor: s[2], fogNear: s[3], fogFar: s[4] };
}

function updateScene(data) {
  db.run(`UPDATE scene_settings SET ground_size=?, fog_color=?, fog_near=?, fog_far=? WHERE id=1`,
    [data.groundSize ?? 200, data.fogColor || '#0a0e17', data.fogNear ?? 60, data.fogFar ?? 220]);
  syncToDisk();
}

// --- Buildings Main ---
function getBuildingMain() {
  const row = db.exec('SELECT * FROM buildings_main WHERE id = 1');
  if (row.length === 0 || row[0].values.length === 0) return null;
  const b = row[0].values[0];
  return { w: b[1], d: b[2], h: b[3], color: b[4], pos: [b[5], b[6], b[7]], roadWidth: b[8], name: b[11] || '' };
}

function updateBuildingMain(data) {
  // 更新主建筑时顺带重置 visible/road_visible=1，避免「恢复主建筑」后仍因 visible=0 不渲染
  db.run(`UPDATE buildings_main SET w=?, d=?, h=?, color=?, pos_x=?, pos_y=?, pos_z=?, road_width=?, name=?, visible=1, road_visible=1 WHERE id=1`,
    [data.w ?? 40, data.d ?? 60, data.h ?? 18, data.color || '#1e2d5a',
     (data.pos || [0, 0, 0])[0], (data.pos || [0, 0, 0])[1], (data.pos || [0, 0, 0])[2],
     data.roadWidth ?? 8, data.name || '']);
  syncToDisk();
}

// --- Buildings Subs ---
function getBuildingSubs() {
  const rows = db.exec('SELECT * FROM buildings_subs ORDER BY sort_order');
  if (rows.length === 0) return [];
  return rows[0].values.map(r => ({ id: r[0], w: r[1], d: r[2], h: r[3], x: r[4], z: r[5], color: r[6] }));
}

function addBuildingSub(data) {
  const maxOrder = db.exec('SELECT COALESCE(MAX(sort_order), -1) + 1 FROM buildings_subs');
  const next = maxOrder[0].values[0][0];
  db.run(`INSERT INTO buildings_subs (w, d, h, x, z, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.w ?? 10, data.d ?? 10, data.h ?? 6, data.x ?? 0, data.z ?? 0, data.color || '#253a6a', next]);
  syncToDisk();
  return Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
}

function updateBuildingSub(id, data) {
  db.run(`UPDATE buildings_subs SET w=?, d=?, h=?, x=?, z=?, color=? WHERE id=?`,
    [data.w ?? 10, data.d ?? 10, data.h ?? 6, data.x ?? 0, data.z ?? 0, data.color || '#253a6a', id]);
  syncToDisk();
}

function deleteBuildingSub(id) {
  db.run('DELETE FROM buildings_subs WHERE id = ?', [id]);
  syncToDisk();
}

// --- Parking ---
function getParking() {
  const rows = db.exec('SELECT * FROM parking ORDER BY id');
  if (rows.length === 0) return [];
  return rows[0].values.map(r => ({
    id: r[0], name: r[1], offset: [r[2], r[3], r[4]], capacity: r[5], available: r[6], color: r[7]
  }));
}

function addParking(data) {
  db.run(`INSERT INTO parking (name, offset_x, offset_y, offset_z, capacity, available, color) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.name || '', (data.offset || [0, 0, 0])[0], (data.offset || [0, 0, 0])[1], (data.offset || [0, 0, 0])[2],
     data.capacity ?? 0, data.available ?? 0, data.color || '#4da6ff']);
  syncToDisk();
  return Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
}

function updateParking(id, data) {
  db.run(`UPDATE parking SET name=?, offset_x=?, offset_y=?, offset_z=?, capacity=?, available=?, color=? WHERE id=?`,
    [data.name || '', (data.offset || [0, 0, 0])[0], (data.offset || [0, 0, 0])[1], (data.offset || [0, 0, 0])[2],
     data.capacity ?? 0, data.available ?? 0, data.color || '#4da6ff', id]);
  syncToDisk();
}

function deleteParking(id) {
  db.run('DELETE FROM parking WHERE id = ?', [id]);
  syncToDisk();
}

// --- Particles ---
function getParticles() {
  const row = db.exec('SELECT * FROM particles WHERE id = 1');
  if (row.length === 0 || row[0].values.length === 0) return null;
  const p = row[0].values[0];
  return { count: p[1], spread: p[2], height: p[3] };
}

function updateParticles(data) {
  db.run(`UPDATE particles SET count=?, spread=?, height=? WHERE id=1`,
    [data.count ?? 180, data.spread ?? 90, data.height ?? 35]);
  syncToDisk();
}

// --- Camera ---
function getCamera() {
  const camRow = db.exec('SELECT * FROM camera WHERE id = 1');
  if (camRow.length === 0 || camRow[0].values.length === 0) return null;
  const c = camRow[0].values[0];
  const presets = db.exec('SELECT * FROM camera_presets ORDER BY id');
  const presetObj = {};
  if (presets.length > 0) {
    presets[0].values.forEach(p => {
      presetObj[p[1]] = { pos: [p[2], p[3], p[4]], target: [p[5], p[6], p[7]] };
    });
  }
  return {
    fov: c[1], near: c[2], far: c[3],
    initial: { pos: [c[4], c[5], c[6]], target: [c[7], c[8], c[9]] },
    presets: presetObj,
    tweenMs: c[10], orbitDamping: c[11], minDist: c[12], maxDist: c[13], maxPolarFactor: c[14]
  };
}

function updateCamera(data) {
  db.run(`UPDATE camera SET fov=?, near=?, far=?, initial_pos_x=?, initial_pos_y=?, initial_pos_z=?,
    initial_target_x=?, initial_target_y=?, initial_target_z=?, tween_ms=?, orbit_damping=?,
    min_dist=?, max_dist=?, max_polar_factor=? WHERE id=1`,
    [data.fov ?? 42, data.near ?? 0.5, data.far ?? 400,
     (data.initial && data.initial.pos || [70, 50, 80])[0], (data.initial && data.initial.pos || [70, 50, 80])[1], (data.initial && data.initial.pos || [70, 50, 80])[2],
     (data.initial && data.initial.target || [0, 4, 0])[0], (data.initial && data.initial.target || [0, 4, 0])[1], (data.initial && data.initial.target || [0, 4, 0])[2],
     data.tweenMs ?? 1400, data.orbitDamping ?? 0.08, data.minDist ?? 12, data.maxDist ?? 160, data.maxPolarFactor ?? 0.46]);

  // 更新 presets
  if (data.presets) {
    db.run('DELETE FROM camera_presets');
    for (const [key, p] of Object.entries(data.presets)) {
      db.run(`INSERT INTO camera_presets (key, pos_x, pos_y, pos_z, target_x, target_y, target_z) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [key, (p.pos || [0, 0, 0])[0], (p.pos || [0, 0, 0])[1], (p.pos || [0, 0, 0])[2],
         (p.target || [0, 0, 0])[0], (p.target || [0, 0, 0])[1], (p.target || [0, 0, 0])[2]]);
    }
  }
  syncToDisk();
}

// ---------- 同步到磁盘 ----------

/** 写数据库文件 + 更新 config.json（供静态文件服务） */
function syncToDisk() {
  const config = getFullConfig();
  writeConfigJson(config);
  saveDbToDisk();
}

// ---------- 编辑器项目 ----------

function getEditorProjects() {
  const rows = db.exec('SELECT * FROM editor_projects ORDER BY updated_at DESC');
  if (rows.length === 0) return [];
  return rows[0].values.map(r => ({
    id: r[0], name: r[1], data: JSON.parse(r[2]), updated_at: r[3], visibility: r[4] || 'public', floor: r[5] || 0, building: r[6] || ''
  }));
}

function getEditorProject(id) {
  const rows = db.exec('SELECT * FROM editor_projects WHERE id = ?', [id]);
  if (rows.length === 0 || rows[0].values.length === 0) return null;
  const r = rows[0].values[0];
  return { id: r[0], name: r[1], data: JSON.parse(r[2]), updated_at: r[3], visibility: r[4] || 'public', floor: r[5] || 0, building: r[6] || '' };
}

// 按角色过滤方案列表：user（含访客）只见公开方案；super/admin 见全部
function getEditorProjectsForRole(role) {
  const all = getEditorProjects();
  if (role === 'super' || role === 'admin') return all;
  return all.filter(p => (p.visibility || 'public') === 'public');
}

// 判断某角色能否查看某方案（user 只能看 public）
function canViewProject(role, project) {
  if (!project) return false;
  if (role === 'super' || role === 'admin') return true;
  return (project.visibility || 'public') === 'public';
}

function saveEditorProject(id, name, data, visibility, floor, building) {
  const now = new Date().toISOString();
  const vis = visibility === 'restricted' ? 'restricted' : 'public';
  if (id) {
    // 部分更新：floor/building 未传时保留原值（editor.js 只传 name/data 不会抹掉楼层/建筑）
    const existing = getEditorProject(id);
    const nextFloor = floor !== undefined ? floor : (existing ? existing.floor : 0);
    const nextBuilding = building !== undefined ? building : (existing ? (existing.building || '') : '');
    db.run('UPDATE editor_projects SET name = ?, data = ?, updated_at = ?, visibility = ?, floor = ?, building = ? WHERE id = ?',
      [name, JSON.stringify(data), now, vis, nextFloor, nextBuilding, id]);
    saveDbToDisk();
    return id;
  } else {
    db.run('INSERT INTO editor_projects (name, data, updated_at, visibility, floor, building) VALUES (?, ?, ?, ?, ?, ?)',
      [name, JSON.stringify(data), now, vis, floor !== undefined ? floor : 0, building || '']);
    saveDbToDisk();
    const result = db.exec('SELECT MAX(id) as id FROM editor_projects');
    return result[0].values[0][0];
  }
}

function deleteEditorProject(id) {
  db.run('DELETE FROM editor_projects WHERE id = ?', [id]);
  saveDbToDisk();
}

// ---------- 导航路线（后台路径导航保存的独立列表） ----------

function getNavRoutes() {
  const rows = db.exec('SELECT * FROM nav_routes ORDER BY id');
  if (rows.length === 0) return [];
  return rows[0].values.map(r => ({
    id: r[0], name: r[1], data: JSON.parse(r[2] || '{}'), updated_at: r[3]
  }));
}

function getNavRoute(id) {
  const rows = db.exec('SELECT * FROM nav_routes WHERE id = ?', [id]);
  if (rows.length === 0 || rows[0].values.length === 0) return null;
  const r = rows[0].values[0];
  return { id: r[0], name: r[1], data: JSON.parse(r[2] || '{}'), updated_at: r[3] };
}

function saveNavRoute(id, name, data) {
  const now = new Date().toISOString();
  if (id) {
    db.run('UPDATE nav_routes SET name = ?, data = ?, updated_at = ? WHERE id = ?',
      [name, JSON.stringify(data), now, id]);
    saveDbToDisk();
    return id;
  } else {
    db.run('INSERT INTO nav_routes (name, data, updated_at) VALUES (?, ?, ?)',
      [name, JSON.stringify(data), now]);
    saveDbToDisk();
    const result = db.exec('SELECT MAX(id) as id FROM nav_routes');
    return result[0].values[0][0];
  }
}

function deleteNavRoute(id) {
  db.run('DELETE FROM nav_routes WHERE id = ?', [id]);
  saveDbToDisk();
}

// ---------- 用户管理 ----------

// 账号角色仅两类：admin（全部功能）、super（看全部数据）。
// 「普通用户」= 未登录访客（服务端 readUser 返回 null 时按 'user' 处理），无需账号。
const USER_ROLES = ['admin', 'super'];

function getUsers() {
  const rows = db.exec('SELECT id, username, role, created_at, updated_at FROM users ORDER BY id');
  if (rows.length === 0) return [];
  return rows[0].values.map(r => ({
    id: r[0], username: r[1], role: r[2], created_at: r[3], updated_at: r[4]
  }));
}

function getUserByUsername(username) {
  const rows = db.exec('SELECT * FROM users WHERE username = ?', [username]);
  if (rows.length === 0 || rows[0].values.length === 0) return null;
  const r = rows[0].values[0];
  return { id: r[0], username: r[1], password_hash: r[2], role: r[3], created_at: r[4], updated_at: r[5] };
}

function getUserById(id) {
  const rows = db.exec('SELECT * FROM users WHERE id = ?', [id]);
  if (rows.length === 0 || rows[0].values.length === 0) return null;
  const r = rows[0].values[0];
  return { id: r[0], username: r[1], password_hash: r[2], role: r[3], created_at: r[4], updated_at: r[5] };
}

function createUser({ username, password_hash, role }) {
  const now = new Date().toISOString();
  db.run('INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [username, password_hash || '', role || 'user', now, now]);
  saveDbToDisk();
  return Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
}

function updateUser(id, { username, password_hash, role }) {
  const existing = getUserById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.run('UPDATE users SET username = ?, password_hash = ?, role = ?, updated_at = ? WHERE id = ?',
    [username !== undefined ? username : existing.username,
     password_hash !== undefined ? password_hash : existing.password_hash,
     role !== undefined ? role : existing.role,
     now, id]);
  saveDbToDisk();
  return getUserById(id);
}

function deleteUser(id) {
  db.run('DELETE FROM users WHERE id = ?', [id]);
  saveDbToDisk();
}

function countAdmins() {
  const rows = db.exec("SELECT COUNT(*) FROM users WHERE role = 'admin'");
  if (rows.length === 0 || rows[0].values.length === 0) return 0;
  return rows[0].values[0][0];
}

// ---------- 关闭数据库 ----------

function closeDb() {
  if (db) {
    flushDbToDisk();
    db.close();
    db = null;
  }
}

// ---------- 导出 ----------

module.exports = {
  initDb, closeDb,
  getFullConfig, saveFullConfig,

  // 实体级 CRUD
  getGeo, updateGeo,
  getScene, updateScene,
  getBuildingMain, updateBuildingMain,
  getBuildingSubs, addBuildingSub, updateBuildingSub, deleteBuildingSub,
  getParking, addParking, updateParking, deleteParking,
  getParticles, updateParticles,
  getCamera, updateCamera,

  // 编辑器项目
  getEditorProjects, getEditorProject, getEditorProjectsForRole, canViewProject,
  saveEditorProject, deleteEditorProject,

  // 导航路线
  getNavRoutes, getNavRoute, saveNavRoute, deleteNavRoute,

  // 用户管理
  getUsers, getUserByUsername, getUserById, createUser, updateUser, deleteUser, countAdmins,
  USER_ROLES
};
