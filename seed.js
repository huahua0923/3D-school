// ============================================================
// 数据库填充脚本 — 从 config.json 重建数据库
// 用法: node seed.js
// ============================================================

const path = require('path');
const fs = require('fs');
const { initDb, closeDb } = require('./db');

const dbPath = path.join(__dirname, 'data', 'exhibition-nav.db');
const configPath = path.join(__dirname, 'config.json');

(async () => {
  console.log('🔧 开始填充数据库...');

  // 删除旧数据库
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log('🗑️  已删除旧数据库文件');
  }

  // 初始化（自动检测空库并从 config.json 填充）
  await initDb(dbPath, configPath);

  closeDb();
  console.log('✅ 数据库填充完成: ' + dbPath);
})();
