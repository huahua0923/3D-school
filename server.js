// ============================================================
// 会展中心 3D 导览 — 后台 API 服务
// Express 后端：配置读取/保存 + 简单登录认证 + 数据库持久化
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 加载环境变量
require('dotenv').config();

// 数据库模块
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.error('❌ 请设置环境变量 ADMIN_PASSWORD（在 .env 文件中）');
    process.exit(1);
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// 强制所有响应使用 UTF-8（解决 Windows 浏览器中文乱码）
app.use((_req, res, next) => {
    res.charset = 'utf-8';
    next();
});

// 开发模式：直接提供静态文件（生产环境由 Nginx 处理）
app.use(express.static(__dirname));

// ---------- 无状态 token 管理（HMAC 签名，服务器重启不丢失）----------
const TOKEN_SECRET = process.env.ADMIN_SECRET || ADMIN_PASSWORD;
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 小时

function generateToken() {
    const timestamp = Date.now();
    const payload = timestamp.toString();
    const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    return Buffer.from(timestamp + '.' + hmac).toString('base64url');
}

function verifyToken(token) {
    try {
        const decoded = Buffer.from(token, 'base64url').toString('utf-8');
        const dotIdx = decoded.indexOf('.');
        if (dotIdx === -1) return false;
        const timestamp = parseInt(decoded.substring(0, dotIdx), 10);
        const hmac = decoded.substring(dotIdx + 1);
        if (!timestamp || !hmac) return false;
        // Check expiry
        if (Date.now() - timestamp > TOKEN_TTL) return false;
        // Verify HMAC
        const expectedHmac = crypto.createHmac('sha256', TOKEN_SECRET).update(timestamp.toString()).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac));
    } catch {
        return false;
    }
}

function authMiddleware(req, res, next) {
    const auth = req.headers.authorization;
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !verifyToken(token)) {
        return res.status(401).json({ error: '未登录或 token 已过期' });
    }
    next();
}

// API 路由：统一 UTF-8 编码
app.use('/api', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

// ==================== 认证相关（不变） ====================

// 登录
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ error: '请输入密码' });
    }
    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: '密码错误' });
    }
    const token = generateToken();
    res.json({ token, message: '登录成功' });
});

// 登出（无状态 token，客户端删除即可）
app.post('/api/logout', authMiddleware, (req, res) => {
    res.json({ message: '已登出' });
});

// 验证 token
app.get('/api/check', authMiddleware, (req, res) => {
    res.json({ valid: true });
});

// ==================== 配置读写（数据库驱动） ====================

// 读取完整配置
app.get('/api/config', (req, res) => {
    try {
        const config = db.getFullConfig();
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: '读取配置失败: ' + err.message });
    }
});

// 保存完整配置（需要认证）
app.post('/api/config', authMiddleware, (req, res) => {
    const config = req.body;
    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: '无效的配置数据' });
    }
    try {
        // 先备份 config.json
        const backupPath = CONFIG_PATH + '.bak';
        if (fs.existsSync(CONFIG_PATH)) {
            fs.copyFileSync(CONFIG_PATH, backupPath);
        }
        // 写入数据库（内部同步更新 config.json）
        db.saveFullConfig(config);
        res.json({ message: '配置保存成功', time: new Date().toISOString() });
    } catch (err) {
        // 尝试恢复备份
        const backupPath = CONFIG_PATH + '.bak';
        if (fs.existsSync(backupPath)) {
            try { fs.copyFileSync(backupPath, CONFIG_PATH); } catch (_) {}
        }
        res.status(500).json({ error: '保存配置失败: ' + err.message });
    }
});

// ==================== 细粒度 CRUD — Geo ====================

app.get('/api/geo', (req, res) => {
    try { res.json({ data: db.getGeo() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/geo', authMiddleware, (req, res) => {
    try { db.updateGeo(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Scene ====================

app.get('/api/scene', (req, res) => {
    try { res.json({ data: db.getScene() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/scene', authMiddleware, (req, res) => {
    try { db.updateScene(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Buildings ====================

app.get('/api/buildings/main', (req, res) => {
    try { res.json({ data: db.getBuildingMain() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/buildings/main', authMiddleware, (req, res) => {
    try { db.updateBuildingMain(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/buildings/subs', (req, res) => {
    try { res.json({ data: db.getBuildingSubs() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/buildings/subs', authMiddleware, (req, res) => {
    try {
        const id = db.addBuildingSub(req.body);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/buildings/subs/:id', authMiddleware, (req, res) => {
    try {
        db.updateBuildingSub(Number(req.params.id), req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/buildings/subs/:id', authMiddleware, (req, res) => {
    try {
        db.deleteBuildingSub(Number(req.params.id));
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Markers ====================

app.get('/api/markers', (req, res) => {
    try { res.json({ data: db.getMarkers() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/markers/:key', (req, res) => {
    try {
        const m = db.getMarkerByKey(req.params.key);
        if (!m) return res.status(404).json({ error: '标记不存在' });
        res.json({ data: m });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/markers', authMiddleware, (req, res) => {
    try {
        db.addMarker(req.body);
        res.status(201).json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/markers/:key', authMiddleware, (req, res) => {
    try {
        db.updateMarker(req.params.key, req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/markers/:key', authMiddleware, (req, res) => {
    try {
        db.deleteMarker(req.params.key);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Routes ====================

app.get('/api/routes', (req, res) => {
    try { res.json({ data: db.getRoutes() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/routes/:key', (req, res) => {
    try {
        const r = db.getRouteByKey(req.params.key);
        if (!r) return res.status(404).json({ error: '路线不存在' });
        res.json({ data: r });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/routes', authMiddleware, (req, res) => {
    try {
        db.addRoute(req.body);
        res.status(201).json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/routes/:key', authMiddleware, (req, res) => {
    try {
        db.updateRoute(req.params.key, req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/routes/:key', authMiddleware, (req, res) => {
    try {
        db.deleteRoute(req.params.key);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Parking ====================

app.get('/api/parking', (req, res) => {
    try { res.json({ data: db.getParking() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parking', authMiddleware, (req, res) => {
    try {
        const id = db.addParking(req.body);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/parking/:id', authMiddleware, (req, res) => {
    try {
        db.updateParking(Number(req.params.id), req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/parking/:id', authMiddleware, (req, res) => {
    try {
        db.deleteParking(Number(req.params.id));
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Particles ====================

app.get('/api/particles', (req, res) => {
    try { res.json({ data: db.getParticles() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/particles', authMiddleware, (req, res) => {
    try { db.updateParticles(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Camera ====================

app.get('/api/camera', (req, res) => {
    try { res.json({ data: db.getCamera() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/camera', authMiddleware, (req, res) => {
    try { db.updateCamera(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 路线图编辑器 ====================

// 列出所有项目
app.get('/api/editor/projects', (req, res) => {
    try { res.json({ data: db.getEditorProjects() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// 获取单个项目
app.get('/api/editor/projects/:id', (req, res) => {
    try {
        const p = db.getEditorProject(Number(req.params.id));
        if (!p) return res.status(404).json({ error: '项目不存在' });
        res.json({ data: p });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 创建新项目
app.post('/api/editor/projects', authMiddleware, (req, res) => {
    try {
        const { name, data } = req.body;
        const id = db.saveEditorProject(null, name || '未命名项目', data || {});
        res.status(201).json({ message: 'ok', id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新项目
app.put('/api/editor/projects/:id', authMiddleware, (req, res) => {
    try {
        const { name, data } = req.body;
        db.saveEditorProject(Number(req.params.id), name, data);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除项目
app.delete('/api/editor/projects/:id', authMiddleware, (req, res) => {
    try {
        db.deleteEditorProject(Number(req.params.id));
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 启动服务器 ====================

(async () => {
    // 初始化数据库（首次运行自动从 config.json 填充）
    try {
        await db.initDb();
        console.log('📦 数据库已就绪');
    } catch (err) {
        console.error('❌ 数据库初始化失败:', err.message);
        process.exit(1);
    }

    app.listen(PORT, () => {
        console.log(`🔧 后台 API 服务已启动: http://localhost:${PORT}`);
        console.log(`📁 配置文件: ${CONFIG_PATH}`);
        if (ADMIN_PASSWORD === 'admin123') {
            console.warn('⚠️  使用默认密码 "admin123"，请修改 .env 中的 ADMIN_PASSWORD！');
        }
    });
})();
