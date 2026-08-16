// ============================================================
// 数据库往返测试 — 验证 getFullConfig() 输出与 config.json 一致
// 用法: node db.test.js
// ============================================================

const path = require('path');
const fs = require('fs');
const { initDb, getFullConfig, closeDb } = require('./db');

const dbPath = path.join(__dirname, 'data', 'exhibition-nav.db');
const configPath = path.join(__dirname, 'config.json');

function deepEqual(a, b, tolerance = 0.001) {
  if (typeof a !== typeof b) return { ok: false, path: '', reason: `类型不同: ${typeof a} vs ${typeof b}` };

  if (a === null || b === null) {
    if (a !== b) return { ok: false, path: '', reason: `${JSON.stringify(a)} !== ${JSON.stringify(b)}` };
    return { ok: true };
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return { ok: false, path: '', reason: `数组长度不同: ${a.length} vs ${b.length}` };
    for (let i = 0; i < a.length; i++) {
      const r = deepEqual(a[i], b[i], tolerance);
      if (!r.ok) return { ok: false, path: `[${i}]${r.path}`, reason: r.reason };
    }
    return { ok: true };
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    const allKeys = [...new Set([...keysA, ...keysB])];
    for (const key of allKeys) {
      const r = deepEqual(a[key], b[key], tolerance);
      if (!r.ok) return { ok: false, path: `.${key}${r.path}`, reason: r.reason };
    }
    return { ok: true };
  }

  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > tolerance) return { ok: false, path: '', reason: `${a} !== ${b} (tolerance=${tolerance})` };
    return { ok: true };
  }

  if (a !== b) return { ok: false, path: '', reason: `${JSON.stringify(a)} !== ${JSON.stringify(b)}` };
  return { ok: true };
}

(async () => {
  let passed = 0;
  let failed = 0;

  console.log('🧪 数据库往返测试\n');

  // 删除旧数据库确保从 config.json 填充
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  // 初始化
  await initDb(dbPath, configPath);

  // 读取
  const original = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const rebuilt = getFullConfig();

  // 逐段比较
  const sections = [
    { name: 'geo', a: original.geo, b: rebuilt.geo },
    { name: 'scene (groundSize/fog)', a: { groundSize: original.groundSize, fogColor: original.fogColor, fogNear: original.fogNear, fogFar: original.fogFar }, b: { groundSize: rebuilt.groundSize, fogColor: rebuilt.fogColor, fogNear: rebuilt.fogNear, fogFar: rebuilt.fogFar } },
    { name: 'building.main', a: original.building.main, b: rebuilt.building.main },
    { name: 'building.subs', a: original.building.subs, b: rebuilt.building.subs },
    { name: 'building.roadWidth', a: { rw: original.building.roadWidth }, b: { rw: rebuilt.building.roadWidth } },
    { name: 'markers', a: original.markers, b: rebuilt.markers },
    { name: 'routes', a: original.routes, b: rebuilt.routes },
    { name: 'parking', a: original.parking, b: rebuilt.parking },
    { name: 'particles', a: original.particles, b: rebuilt.particles },
    { name: 'camera (不含presets)', a: { fov: original.camera.fov, near: original.camera.near, far: original.camera.far, initial: original.camera.initial, tweenMs: original.camera.tweenMs, orbitDamping: original.camera.orbitDamping, minDist: original.camera.minDist, maxDist: original.camera.maxDist, maxPolarFactor: original.camera.maxPolarFactor }, b: { fov: rebuilt.camera.fov, near: rebuilt.camera.near, far: rebuilt.camera.far, initial: rebuilt.camera.initial, tweenMs: rebuilt.camera.tweenMs, orbitDamping: rebuilt.camera.orbitDamping, minDist: rebuilt.camera.minDist, maxDist: rebuilt.camera.maxDist, maxPolarFactor: rebuilt.camera.maxPolarFactor } },
    { name: 'camera.presets', a: original.camera.presets, b: rebuilt.camera.presets },
  ];

  for (const { name, a, b } of sections) {
    const result = deepEqual(a, b);
    if (result.ok) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}: ${result.reason} (路径: ${result.path || '(root)'})`);
      failed++;
    }
  }

  closeDb();

  // 清理测试数据库
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  console.log(`\n${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log('❌ 测试未通过');
    process.exit(1);
  } else {
    console.log('✅ 全部测试通过');
  }
})();
