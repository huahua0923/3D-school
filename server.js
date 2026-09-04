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
// 信任一层反向代理（Nginx）：让 req.ip 取 X-Forwarded-For 的真实客户端 IP，
// 否则登录限流按 127.0.0.1 计数，反代下会把全站锁死
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.error('❌ 请设置环境变量 ADMIN_PASSWORD（在 .env 文件中）');
    process.exit(1);
}

// 中间件
app.use(cors());
// 请求体上限：编辑器背景图已在前端压缩到 1600px（base64 约 2-3MB），
// 其余配置/项目均为几十 KB 级，10MB 足够且把内存型 DoS 面收窄 60%
app.use(express.json({ limit: '10mb' }));

// 写接口（POST/PUT）请求体必须是 JSON 对象：拒绝 null / 数组 / 标量，防类型混淆
// （空对象与缺失 body 放行，由各路由自行校验必填字段）
app.use((req, res, next) => {
    if ((req.method === 'POST' || req.method === 'PUT') && req.body !== undefined && req.body !== null) {
        if (typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({ error: '请求体必须是 JSON 对象' });
        }
    }
    next();
});

// 强制所有响应使用 UTF-8（解决 Windows 浏览器中文乱码）
app.use((_req, res, next) => {
    res.charset = 'utf-8';
    next();
});

// 静态文件白名单：只暴露前端所需文件，避免 .db 数据库、config.json.bak、源码、
// node_modules、projects 等被公开下载。生产环境由 Nginx 处理时此段同样生效。
const PUBLIC_PATHS = new Set([
    '/index.html', '/index-classic.html', '/admin.html', '/admin-map.html',
    '/editor.html', '/editor.css', '/indoor-nav.js', '/shared.js', '/favicon.svg', '/config.json',
    // index.html 拆分出的 ES 模块（2026-09-01 重构）
    '/state.js', '/config.js', '/coords.js', '/tween.js', '/three-scene.js', '/flow.js', '/loca.js',
    '/weather.js', '/poi.js', '/measure.js', '/route.js', '/indoor.js', '/auth.js', '/app.js',
    // editor.js 拆分出的 ES 模块（2026-09-01 重构）
    '/editor-state.js', '/editor-geometry.js', '/editor-canvas.js', '/editor-history.js', '/editor-ui.js',
    '/editor-elements.js', '/editor-export.js', '/editor-geo.js', '/editor-data.js', '/editor-main.js',
    // three.js 本地自托管（2026-09-02：脱离 unpkg CDN，避免校园网/DNS 污染致首屏 3D 加载失败）
    '/vendor/three/three.module.js',
    '/vendor/three/addons/controls/OrbitControls.js',
    '/vendor/three/addons/renderers/CSS2DRenderer.js',
    // GLB 模型加载器（2026-09-04：模型导入）
    '/vendor/three/addons/loaders/GLTFLoader.js',
    '/vendor/three/addons/utils/BufferGeometryUtils.js'
]);
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const p = req.path === '/' ? '/index.html' : req.path;
    // 上传的 GLB 模型存 /models/ 目录，文件名动态生成无法精确列举，按前缀放行
    if (!PUBLIC_PATHS.has(p) && !p.startsWith('/models/')) {
        return res.status(404).type('text/plain').send('Not Found');
    }
    next();
});
// 前端静态文件用 ETag 校验（no-cache）：内容未变返回 304 省流量，编辑后 mtime 变化即重新下载，
// 避免每次访问都全量重下所有 JS/CSS（原先 no-store 会强制全量重下，40+ 模块首屏负担大）
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css') ||
        req.path.endsWith('.glb') || req.path.endsWith('.gltf') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-cache');
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
// 签名密钥必须显式配置，绝不回退到 ADMIN_PASSWORD（弱口令且已入 git 历史，可被伪造 admin token）
const TOKEN_SECRET = process.env.ADMIN_SECRET;
if (!TOKEN_SECRET) {
    console.error('❌ 请设置环境变量 ADMIN_SECRET（token 签名密钥，勿与 ADMIN_PASSWORD 相同）');
    process.exit(1);
}
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
    const claims = verifyToken(token);
    if (!claims) return null;
    // 重查 DB 获取最新角色：防止被降权/删除后旧 token 仍保留管理员特权（token 只证明身份，角色以 DB 为准）
    const dbUser = db.getUserByUsername(claims.username);
    if (!dbUser) return null;
    return { username: dbUser.username, role: dbUser.role };
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
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
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
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
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
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
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
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
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
// 内置内存缓存：同一 type+location 结果缓存 10 分钟，避免每次刷新都打 QWeather 配额。
const WEATHER_TTL_MS = 10 * 60 * 1000;
const weatherCache = new Map();   // `${type}:${loc}` -> { data, expireAt }

// 天气接口按 IP 限流（内存固定窗口）：防单 IP 高频刷；配合上面 10 分钟缓存，正常刷新不会触顶
const WEATHER_RATE_MAX = 30;                    // 每窗口最多请求数
const WEATHER_RATE_WINDOW_MS = 60 * 1000;       // 窗口 60s
const weatherHits = new Map();                  // ip -> { count, resetAt }
function weatherLimiter(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = weatherHits.get(ip);
    if (!rec || now > rec.resetAt) {
        weatherHits.set(ip, { count: 1, resetAt: now + WEATHER_RATE_WINDOW_MS });
    } else {
        rec.count += 1;
        if (rec.count > WEATHER_RATE_MAX) {
            return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
        }
    }
    next();
}

app.get('/api/weather', weatherLimiter, async (req, res) => {
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

    // 命中缓存直接返回（不动上游）
    const cacheKey = type + ':' + loc;
    const cached = weatherCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) {
        res.setHeader('X-Weather-Cache', 'hit');
        return res.json(cached.data);
    }

    const url = host + '/v7/weather/' + type +
        '?location=' + encodeURIComponent(loc) + '&key=' + encodeURIComponent(key);
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) {
            // 上游非 2xx：不透传 body（可能含内部信息），返回通用错误
            console.error('天气服务返回 ' + r.status);
            return res.status(502).json({ code: '502', error: '天气服务暂不可用' });
        }
        const data = await r.json();
        weatherCache.set(cacheKey, { data, expireAt: Date.now() + WEATHER_TTL_MS });
        res.setHeader('X-Weather-Cache', 'miss');
        res.json(data);
    } catch (err) {
        console.error('天气服务请求失败:', err);
        res.status(502).json({ code: '502', error: '天气服务暂不可用' });
    }
});

// ==================== 配置读写（数据库驱动） ====================

// 读取完整配置
app.get('/api/config', (req, res) => {
    try {
        const config = db.getFullConfig();
        res.json(config);
    } catch (err) {
        console.error('读取配置失败:', err);
        res.status(500).json({ error: '读取配置失败' });
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
        console.error('保存配置失败:', err);
        res.status(500).json({ error: '保存配置失败' });
    }
});

// ==================== 细粒度 CRUD — Geo ====================

app.get('/api/geo', (req, res) => {
    try { res.json({ data: db.getGeo() }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.put('/api/geo', adminOnly, (req, res) => {
    try { db.updateGeo(req.body); res.json({ message: 'ok' }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// ==================== 细粒度 CRUD — Scene ====================

app.get('/api/scene', (req, res) => {
    try { res.json({ data: db.getScene() }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.put('/api/scene', adminOnly, (req, res) => {
    try { db.updateScene(req.body); res.json({ message: 'ok' }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// ==================== 细粒度 CRUD — Buildings ====================

app.get('/api/buildings/main', (req, res) => {
    try { res.json({ data: db.getBuildingMains() }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.post('/api/buildings/main', adminOnly, (req, res) => {
    try {
        const id = db.addBuildingMain(req.body);
        res.json({ message: 'ok', id });
    }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.put('/api/buildings/main/:id', adminOnly, (req, res) => {
    try { db.updateBuildingMain(Number(req.params.id), req.body); res.json({ message: 'ok' }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.delete('/api/buildings/main/:id', adminOnly, (req, res) => {
    try { db.deleteBuildingMain(Number(req.params.id)); res.json({ message: 'ok' }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.get('/api/buildings/subs', (req, res) => {
    try { res.json({ data: db.getBuildingSubs() }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.post('/api/buildings/subs', adminOnly, (req, res) => {
    try {
        const id = db.addBuildingSub(req.body);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.put('/api/buildings/subs/:id', adminOnly, (req, res) => {
    try {
        db.updateBuildingSub(Number(req.params.id), req.body);
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.delete('/api/buildings/subs/:id', adminOnly, (req, res) => {
    try {
        db.deleteBuildingSub(Number(req.params.id));
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// ==================== 模型上传（GLB/GLTF） ====================

// 上传 3D 模型：raw 二进制体 + ?name=文件名，存到 models/ 目录，返回可公开访问的 URL。
// 前端直接 POST 原始字节（非 base64，避免 33% 膨胀）；文件名经 sanitize 防路径穿越。
app.post('/api/upload-model', adminOnly, express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: '请求体为空' });
        }
        const rawName = (req.query.name || '').toString();
        const ext = (path.extname(rawName) || '').toLowerCase();
        if (ext !== '.glb' && ext !== '.gltf') {
            return res.status(400).json({ error: '仅支持 .glb / .gltf 文件' });
        }
        // 文件名消毒：只保留字母数字 . _ -，剥离路径分隔符，防 ../ 穿越
        const base = (path.basename(rawName, ext).replace(/[^a-zA-Z0-9._-]/g, '_') || 'model').slice(0, 80);
        const filename = base + ext;
        const modelsDir = path.join(__dirname, 'models');
        if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
        fs.writeFileSync(path.join(modelsDir, filename), req.body);
        res.json({ url: '/models/' + encodeURIComponent(filename), size: req.body.length });
    } catch (err) {
        console.error('模型上传失败:', err);
        res.status(500).json({ error: '模型上传失败' });
    }
});

// ==================== 细粒度 CRUD — Parking ====================

app.get('/api/parking', (req, res) => {
    try { res.json({ data: db.getParking() }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.post('/api/parking', adminOnly, (req, res) => {
    try {
        const id = db.addParking(req.body);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.put('/api/parking/:id', adminOnly, (req, res) => {
    try {
        db.updateParking(Number(req.params.id), req.body);
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.delete('/api/parking/:id', adminOnly, (req, res) => {
    try {
        db.deleteParking(Number(req.params.id));
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// ==================== 细粒度 CRUD — Particles ====================

app.get('/api/particles', (req, res) => {
    try { res.json({ data: db.getParticles() }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.put('/api/particles', adminOnly, (req, res) => {
    try { db.updateParticles(req.body); res.json({ message: 'ok' }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// ==================== 细粒度 CRUD — Camera ====================

app.get('/api/camera', (req, res) => {
    try { res.json({ data: db.getCamera() }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

app.put('/api/camera', adminOnly, (req, res) => {
    try { db.updateCamera(req.body); res.json({ message: 'ok' }); }
    catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// ==================== 路线图编辑器 ====================

// 列出所有项目（按角色过滤：user/访客只见公开，super/admin 见全部）
app.get('/api/editor/projects', (req, res) => {
    try {
        const user = readUser(req);
        const role = user ? user.role : 'user';
        res.json({ data: db.getEditorProjectsForRole(role) });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
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
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// 创建新项目
app.post('/api/editor/projects', adminOnly, (req, res) => {
    try {
        const { name, data, visibility, floor, building } = req.body;
        const id = db.saveEditorProject(null, name || '未命名项目', data || {}, visibility, floor, building);
        res.status(201).json({ message: 'ok', id });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// 更新项目（支持部分更新：只改名时保留已有 data；可单独改可见性）
app.put('/api/editor/projects/:id', adminOnly, (req, res) => {
    try {
        const { name, data, visibility, floor, building } = req.body;
        const existing = db.getEditorProject(Number(req.params.id));
        if (!existing) return res.status(404).json({ error: '项目不存在' });
        const nextName = name !== undefined ? name : existing.name;
        const nextData = data !== undefined ? data : existing.data;
        const nextVis = visibility !== undefined ? visibility : existing.visibility;
        const nextFloor = floor !== undefined ? floor : existing.floor;
        const nextBuilding = building !== undefined ? building : (existing.building || '');
        db.saveEditorProject(Number(req.params.id), nextName, nextData, nextVis, nextFloor, nextBuilding);
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// 删除项目
app.delete('/api/editor/projects/:id', adminOnly, (req, res) => {
    try {
        db.deleteEditorProject(Number(req.params.id));
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// ==================== 导航路线（后台路径导航保存的预设路线） ====================

// 列出全部导航路线（公开，供前台访客点选预设路线）
app.get('/api/nav-routes', (req, res) => {
    try {
        res.json({ data: db.getNavRoutes() });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// 创建导航路线
app.post('/api/nav-routes', adminOnly, (req, res) => {
    try {
        const { name, data } = req.body;
        const id = db.saveNavRoute(null, name || '未命名路线', data || {});
        res.status(201).json({ message: 'ok', id });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// 更新导航路线（部分更新：只改名时保留原 data）
app.put('/api/nav-routes/:id', adminOnly, (req, res) => {
    try {
        const { name, data } = req.body;
        const existing = db.getNavRoute(Number(req.params.id));
        if (!existing) return res.status(404).json({ error: '路线不存在' });
        const nextName = name !== undefined ? name : existing.name;
        const nextData = data !== undefined ? data : existing.data;
        db.saveNavRoute(Number(req.params.id), nextName, nextData);
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// 删除导航路线
app.delete('/api/nav-routes/:id', adminOnly, (req, res) => {
    try {
        db.deleteNavRoute(Number(req.params.id));
        res.json({ message: 'ok' });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
});

// 批量导入：按「建筑清单」一次性生成每栋 × 每层的方案骨架（无底图，位置+比例尺由实地宽高算）
app.post('/api/editor/projects/batch', adminOnly, (req, res) => {
    try {
        const buildings = req.body && req.body.buildings;
        if (!Array.isArray(buildings) || buildings.length === 0) {
            return res.status(400).json({ error: '缺少 buildings 数组' });
        }
        const METERS_PER_DEG_LAT = 111320;
        // 由中心经纬度 + 实地宽高（米）→ 等比 geoBounds（不依赖图片像素）
        const boundsFromMeters = (center, widthM, heightM, rotation = 0) => {
            const mPerDegLng = METERS_PER_DEG_LAT * Math.cos(center[1] * Math.PI / 180);
            const dLng = widthM / mPerDegLng;
            const dLat = heightM / METERS_PER_DEG_LAT;
            return {
                center: [center[0], center[1]], rotation,
                nw: [center[0] - dLng / 2, center[1] + dLat / 2],
                se: [center[0] + dLng / 2, center[1] - dLat / 2],
            };
        };
        let created = 0;
        for (const b of buildings) {
            const name = (b && b.name && String(b.name).trim()) || '';
            if (!name) return res.status(400).json({ error: '每栋建筑必须有 name' });
            const center = b && Array.isArray(b.center) ? b.center : null;
            const clng = center ? Number(center[0]) : NaN;
            const clat = center ? Number(center[1]) : NaN;
            const widthM = Number(b && b.widthM), heightM = Number(b && b.heightM);
            const rotation = Number(b && b.rotation) || 0;
            const floors = b && Array.isArray(b.floors) ? b.floors : null;
            if (!isFinite(clng) || !isFinite(clat)) return res.status(400).json({ error: `建筑「${name}」center 必须是 [经度, 纬度]` });
            if (!(widthM > 0) || !(heightM > 0)) return res.status(400).json({ error: `建筑「${name}」widthM/heightM 必须 > 0` });
            if (!floors || floors.length === 0) return res.status(400).json({ error: `建筑「${name}」floors 不能为空` });
            for (const f of floors) {
                if (!Number.isInteger(f) || f < 1) return res.status(400).json({ error: `建筑「${name}」楼层必须是 ≥1 的整数` });
                const data = {
                    version: 1, projectName: name,
                    backgroundImage: null, imageWidth: 0, imageHeight: 0, bgOpacity: 1,
                    elements: [],
                    geoBounds: boundsFromMeters([clng, clat], widthM, heightM, rotation),
                };
                db.saveEditorProject(null, `${name} ${f}F`, data, 'public', f, name);
                created++;
            }
        }
        res.status(201).json({ message: 'ok', created });
    } catch (err) { console.error('API 500:', err); res.status(500).json({ error: '服务器内部错误' }); }
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
