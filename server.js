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
app.use(express.json({ limit: '25mb' }));

// 强制所有响应使用 UTF-8（解决 Windows 浏览器中文乱码）
app.use((_req, res, next) => {
    res.charset = 'utf-8';
    next();
});

// 静态文件白名单：只暴露前端所需文件，避免 .db 数据库、config.json.bak、源码、
// node_modules、projects 等被公开下载。生产环境由 Nginx 处理时此段同样生效。
const PUBLIC_PATHS = new Set([
    '/index.html', '/index-classic.html', '/admin.html', '/admin-map.html',
    '/editor.html', '/editor.css', '/editor.js', '/favicon.svg', '/config.json'
]);
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const p = req.path === '/' ? '/index.html' : req.path;
    if (!PUBLIC_PATHS.has(p)) {
        return res.status(404).type('text/plain').send('Not Found');
    }
    next();
});
// 前端静态文件禁用缓存，避免编辑后浏览器仍用旧文件（表现为 SyntaxError: Unexpected end of input）
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
    next();
});
app.use(express.static(__dirname));

// ---------- 密码哈希（scrypt，符合「密码必须哈希存储」）----------
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
    return salt + ':' + hash;
}

function verifyPassword(password, stored) {
    try {
        if (!stored || !stored.includes(':')) return false;
        const [salt, hash] = stored.split(':');
        const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
    } catch {
        return false;
    }
}

// ---------- 无状态 token 管理（HMAC 签名，服务器重启不丢失）----------
const TOKEN_SECRET = process.env.ADMIN_SECRET || ADMIN_PASSWORD;
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 小时

function generateToken(username, role) {
    const timestamp = Date.now();
    const payload = `${timestamp}.${username}.${role}`;
    const hmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    return Buffer.from(payload + '.' + hmac).toString('base64url');
}

function verifyToken(token) {
    try {
        const decoded = Buffer.from(token, 'base64url').toString('utf-8');
        const parts = decoded.split('.');
        if (parts.length !== 4) return null;
        const [tsStr, username, role, hmac] = parts;
        const timestamp = parseInt(tsStr, 10);
        if (!timestamp || !username || !hmac) return null;
        if (Date.now() - timestamp > TOKEN_TTL) return null;
        const payload = `${tsStr}.${username}.${role}`;
        const expectedHmac = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) return null;
        return { username, role };
    } catch {
        return null;
    }
}

// 从请求读取并解析 token（无/无效返回 null，不抛错）
function readUser(req) {
    const auth = req.headers.authorization;
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    return verifyToken(token);
}

// 任意已登录角色可访问（super/user 也能通过）
function authMiddleware(req, res, next) {
    const user = readUser(req);
    if (!user) {
        return res.status(401).json({ error: '未登录或 token 已过期' });
    }
    req.user = user;
    next();
}

// 仅管理员可访问（所有写操作）
function adminOnly(req, res, next) {
    const user = readUser(req);
    if (!user) {
        return res.status(401).json({ error: '未登录或 token 已过期' });
    }
    if (user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    req.user = user;
    next();
}

// ---------- 登录限流（内存版，按 IP：15 分钟 5 次失败）----------
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const loginAttempts = new Map(); // ip -> { count, resetAt }

function loginBlocked(ip) {
    const rec = loginAttempts.get(ip);
    if (!rec) return false;
    if (Date.now() > rec.resetAt) { loginAttempts.delete(ip); return false; }
    return rec.count >= LOGIN_MAX_FAILS;
}

function recordLoginFail(ip) {
    const rec = loginAttempts.get(ip);
    if (!rec || Date.now() > rec.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    } else {
        rec.count += 1;
    }
}

function clearLoginFails(ip) {
    loginAttempts.delete(ip);
}

// API 路由：统一 UTF-8 编码
app.use('/api', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

// ==================== 认证相关 ====================

// 登录：{ username, password } 或旧格式 { password }（→ 默认管理员 admin）
app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (loginBlocked(ip)) {
        return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
    }
    if (!password) {
        return res.status(400).json({ error: '请输入密码' });
    }
    const uname = (username || 'admin').toString().trim();
    const user = db.getUserByUsername(uname);
    if (!user || !verifyPassword(password, user.password_hash)) {
        recordLoginFail(ip);
        return res.status(403).json({ error: '用户名或密码错误' });
    }
    clearLoginFails(ip);
    const token = generateToken(user.username, user.role);
    res.json({ token, username: user.username, role: user.role, message: '登录成功' });
});

// 登出（无状态 token，客户端删除即可）
app.post('/api/logout', authMiddleware, (req, res) => {
    res.json({ message: '已登出' });
});

// 验证 token（返回当前用户名与角色）
app.get('/api/check', authMiddleware, (req, res) => {
    res.json({ valid: true, username: req.user.username, role: req.user.role });
});

// ==================== 用户管理（管理员专用） ====================

app.get('/api/users', adminOnly, (_req, res) => {
    try { res.json({ data: db.getUsers() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', adminOnly, (req, res) => {
    try {
        const { username, password, role } = req.body || {};
        const uname = (username || '').toString().trim();
        if (!uname) return res.status(400).json({ error: '用户名不能为空' });
        if (uname.length > 50) return res.status(400).json({ error: '用户名过长' });
        if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
        if (!db.USER_ROLES.includes(role)) return res.status(400).json({ error: '角色无效' });
        if (db.getUserByUsername(uname)) return res.status(409).json({ error: '用户名已存在' });
        const id = db.createUser({ username: uname, password_hash: hashPassword(String(password)), role });
        res.status(201).json({ message: 'ok', id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', adminOnly, (req, res) => {
    try {
        const id = Number(req.params.id);
        const user = db.getUserById(id);
        if (!user) return res.status(404).json({ error: '用户不存在' });
        const { username, password, role } = req.body || {};
        const patch = {};
        if (username !== undefined) {
            const uname = username.toString().trim();
            if (!uname) return res.status(400).json({ error: '用户名不能为空' });
            const dup = db.getUserByUsername(uname);
            if (dup && dup.id !== id) return res.status(409).json({ error: '用户名已存在' });
            patch.username = uname;
        }
        if (password !== undefined && password !== '') {
            if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
            patch.password_hash = hashPassword(String(password));
        }
        if (role !== undefined) {
            if (!db.USER_ROLES.includes(role)) return res.status(400).json({ error: '角色无效' });
            if (user.role === 'admin' && role !== 'admin' && db.countAdmins() <= 1) {
                return res.status(400).json({ error: '不能降级最后一个管理员' });
            }
            patch.role = role;
        }
        db.updateUser(id, patch);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', adminOnly, (req, res) => {
    try {
        const id = Number(req.params.id);
        const user = db.getUserById(id);
        if (!user) return res.status(404).json({ error: '用户不存在' });
        if (req.user && req.user.username === user.username) {
            return res.status(400).json({ error: '不能删除自己' });
        }
        if (user.role === 'admin' && db.countAdmins() <= 1) {
            return res.status(400).json({ error: '不能删除最后一个管理员' });
        }
        db.deleteUser(id);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 高德地图 JS API Key + 安全密钥（从 .env 注入，不进仓库、不进 config.json）
// 高德官方建议：key 由服务端管理，前端加载 SDK 前通过此接口获取
app.get('/api/amap', (_req, res) => {
    res.json({
        key: process.env.AMAP_KEY || '',
        securityJsCode: process.env.AMAP_SECURITY_CODE || '',
    });
});

// 和风天气 QWeather 代理：key 只在服务端 .env，前端不接触（不暴露到浏览器）
// 前端调用 GET /api/weather?type=now|3d，本接口转发到 QWeather 并原样返回 JSON
// 注意：新版 QWeather 每个开发者有专属 API Host（形如 https://xxx.qweatherapi.com），
//       必须用 QWEATHER_HOST 指定，通用 devapi/api.qweather.com 会返回 403 Invalid Host。
app.get('/api/weather', async (req, res) => {
    const key = process.env.QWEATHER_KEY || '';
    if (!key) return res.status(500).json({ code: '500', error: 'QWEATHER_KEY 未配置' });
    const host = (process.env.QWEATHER_HOST || 'https://devapi.qweather.com').replace(/\/+$/, '');
    const type = req.query.type === '3d' ? '3d' : 'now';
    // 定位：优先 config.json 的 geo.center（[lng, lat]），QWeather location 格式为 "lng,lat"
    let loc = '116.41,39.92';
    try {
        const geo = db.getGeo();
        if (geo && geo.center && geo.center.length >= 2) loc = geo.center[0] + ',' + geo.center[1];
    } catch (_) {}
    const url = host + '/v7/weather/' + type +
        '?location=' + encodeURIComponent(loc) + '&key=' + encodeURIComponent(key);
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data = await r.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ code: '502', error: '天气服务请求失败: ' + err.message });
    }
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
app.post('/api/config', adminOnly, (req, res) => {
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

app.put('/api/geo', adminOnly, (req, res) => {
    try { db.updateGeo(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Scene ====================

app.get('/api/scene', (req, res) => {
    try { res.json({ data: db.getScene() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/scene', adminOnly, (req, res) => {
    try { db.updateScene(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Buildings ====================

app.get('/api/buildings/main', (req, res) => {
    try { res.json({ data: db.getBuildingMain() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/buildings/main', adminOnly, (req, res) => {
    try { db.updateBuildingMain(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/buildings/subs', (req, res) => {
    try { res.json({ data: db.getBuildingSubs() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/buildings/subs', adminOnly, (req, res) => {
    try {
        const id = db.addBuildingSub(req.body);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/buildings/subs/:id', adminOnly, (req, res) => {
    try {
        db.updateBuildingSub(Number(req.params.id), req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/buildings/subs/:id', adminOnly, (req, res) => {
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

app.post('/api/markers', adminOnly, (req, res) => {
    try {
        db.addMarker(req.body);
        res.status(201).json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/markers/:key', adminOnly, (req, res) => {
    try {
        db.updateMarker(req.params.key, req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/markers/:key', adminOnly, (req, res) => {
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

app.post('/api/routes', adminOnly, (req, res) => {
    try {
        db.addRoute(req.body);
        res.status(201).json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/routes/:key', adminOnly, (req, res) => {
    try {
        db.updateRoute(req.params.key, req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/routes/:key', adminOnly, (req, res) => {
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

app.post('/api/parking', adminOnly, (req, res) => {
    try {
        const id = db.addParking(req.body);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/parking/:id', adminOnly, (req, res) => {
    try {
        db.updateParking(Number(req.params.id), req.body);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/parking/:id', adminOnly, (req, res) => {
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

app.put('/api/particles', adminOnly, (req, res) => {
    try { db.updateParticles(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 细粒度 CRUD — Camera ====================

app.get('/api/camera', (req, res) => {
    try { res.json({ data: db.getCamera() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/camera', adminOnly, (req, res) => {
    try { db.updateCamera(req.body); res.json({ message: 'ok' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== 路线图编辑器 ====================

// 列出所有项目（按角色过滤：user/访客只见公开，super/admin 见全部）
app.get('/api/editor/projects', (req, res) => {
    try {
        const user = readUser(req);
        const role = user ? user.role : 'user';
        res.json({ data: db.getEditorProjectsForRole(role) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 获取单个项目（受限方案对 user/访客隐藏）
app.get('/api/editor/projects/:id', (req, res) => {
    try {
        const p = db.getEditorProject(Number(req.params.id));
        if (!p) return res.status(404).json({ error: '项目不存在' });
        const user = readUser(req);
        const role = user ? user.role : 'user';
        if (!db.canViewProject(role, p)) return res.status(403).json({ error: '无权查看该项目' });
        res.json({ data: p });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 创建新项目
app.post('/api/editor/projects', adminOnly, (req, res) => {
    try {
        const { name, data, visibility, floor } = req.body;
        const id = db.saveEditorProject(null, name || '未命名项目', data || {}, visibility, floor);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 更新项目（支持部分更新：只改名时保留已有 data；可单独改可见性）
app.put('/api/editor/projects/:id', adminOnly, (req, res) => {
    try {
        const { name, data, visibility, floor } = req.body;
        const existing = db.getEditorProject(Number(req.params.id));
        if (!existing) return res.status(404).json({ error: '项目不存在' });
        const nextName = name !== undefined ? name : existing.name;
        const nextData = data !== undefined ? data : existing.data;
        const nextVis = visibility !== undefined ? visibility : existing.visibility;
        const nextFloor = floor !== undefined ? floor : existing.floor;
        db.saveEditorProject(Number(req.params.id), nextName, nextData, nextVis, nextFloor);
        res.json({ message: 'ok' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除项目
app.delete('/api/editor/projects/:id', adminOnly, (req, res) => {
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
        // 播种默认管理员（用户名 admin，密码 = ADMIN_PASSWORD），保持旧密码可继续登录后台
        if (db.countAdmins() === 0) {
            db.createUser({ username: 'admin', password_hash: hashPassword(ADMIN_PASSWORD), role: 'admin' });
            console.log('👤 已创建默认管理员账号: admin');
        }
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
