# 成都理工大学 · 3D 智慧导览系统

基于高德地图 JS API 2.0 + Three.js 的校园 3D 智慧导览系统，包含首页 3D 展示、后台配置面板和地图编辑器。

## 功能特性

- **首页 3D 导览**：高德 3D 地图 + Three.js 建筑/路线/区域/标记点叠加渲染（`index.html`）
- **经典模式**：无高德 Key 时的降级展示（`index-classic.html`）
- **后台配置**：建筑、路线、区域、标记点、停车场、粒子、相机等可视化配置（`admin.html`）
- **地图编辑器**：在地图上直接绘制路线/区域/测距/标记点（`admin-map.html`）
- **双重持久化**：`config.json`（首页直接读取）+ SQLite（sql.js，后台读写）

## 技术栈

| 层 | 技术 |
|----|------|
| 地图 | 高德地图 JS API v2.0（`webapi.amap.com/maps?v=2.0`） |
| 3D 渲染 | Three.js |
| 后端 | Express + sql.js（SQLite 的 WASM 实现） |
| 进程管理 | PM2 |
| 认证 | HMAC 签名 token（无状态） |

## 目录结构

```
├── server.js          # Express 后端 API
├── db.js              # sql.js 数据库封装（建表/迁移/读写）
├── index.html         # 首页 3D 展示
├── index-classic.html # 经典降级模式
├── admin.html         # 后台配置面板
├── admin-map.html     # 地图编辑器
├── editor.html/js/css # 编辑器
├── config.json        # 配置数据（不含任何密钥）
├── .env               # 本地环境变量（含高德 Key，不入库）
└── ecosystem.config.js# PM2 配置
```

## 高德地图官方配置（重要）

本项目已按高德官方最佳实践配置 Key 与安全密钥：

1. **Key 类型**：在[高德开放平台控制台](https://console.amap.com)创建「**Web 端 (JS API)**」类型 Key。
2. **安全密钥（securityJsCode）**：2021-12 之后创建的 Key **必须**配置安全密钥，否则部分服务受限。控制台「应用管理 → 安全密钥」查看。
3. **Key 不进仓库**：Key 与安全密钥由**服务端 `.env` 管理**，通过 `GET /api/amap` 接口注入前端，`config.json` 中不再保存任何密钥。
4. **域名白名单**：控制台为该 Key 配置「Web 服务域名白名单」，防止 Key 被他人盗用。
5. **HTTPS 建议**：生产环境建议启用 HTTPS（白名单 + 安全密钥在 HTTPS 下才真正生效）。

### 前端如何取 Key

`index.html` / `admin-map.html` / `editor.js` 在加载高德 SDK 前统一：

```js
const r = await fetch('/api/amap');          // 服务端从 .env 读取
const { key, securityJsCode } = await r.json();
window._AMapSecurityConfig = { securityJsCode }; // 必须先于 SDK 加载
// 再加载 https://webapi.amap.com/maps?v=2.0&key=${key}
```

> 若 `/api/amap` 不可用，前端会回退到 `config.json` 的 `geo.amapKey`（旧部署兼容）。

## 环境变量（.env）

```bash
# 管理员密码（必填，后台登录用）
ADMIN_PASSWORD=your_password_here

# 服务端口（可选，默认 3000）
PORT=3000

# 高德地图 JS API Key
AMAP_KEY=your_amap_key_here

# 高德地图安全密钥（jscode）
AMAP_SECURITY_CODE=your_amap_security_code_here
```

复制 `.env.example` 为 `.env` 后填写。

## 本地运行

```bash
npm install
cp .env.example .env     # 填入真实值
npm start                # 或 npm run dev（热重载）
# 访问 http://localhost:3005
```

## 服务器部署

> 目标服务器为教育网（如 `202.115.132.14`），`github.com` 的 git 端口被墙，
> 因此用 **tarball 方式**拉取代码（不走 git clone）。

### 1. 拉取代码（tarball）

```bash
cd /opt
curl -L https://api.github.com/repos/huahua0923/3D-school/tarball/main -o exhibition-nav.tar.gz
mkdir -p exhibition-nav
tar -xzf exhibition-nav.tar.gz -C exhibition-nav --strip-components=1
cd exhibition-nav
```

### 2. 安装依赖

```bash
npm install --production
```

### 3. 配置环境变量

```bash
echo "ADMIN_PASSWORD=你的密码" > .env
echo "PORT=3005" >> .env
echo "AMAP_KEY=你的高德Key" >> .env
echo "AMAP_SECURITY_CODE=你的安全密钥" >> .env
```

### 4. 启动（PM2）

```bash
pm2 start server.js --name exhibition-nav-api
pm2 save
```

### 5. 放行端口

```bash
firewall-cmd --permanent --add-port=3005/tcp && firewall-cmd --reload
```

### 6. 验证

```bash
curl -s http://127.0.0.1:3005/api/config   # 应返回配置，且 amapKey 为空
curl -s http://127.0.0.1:3005/api/amap     # 应返回真实 key/安全密钥
```

### 更新部署（后续）

重新下载 tarball 解压覆盖即可（无 `.git`，直接覆盖旧文件）：

```bash
cd /opt
curl -L https://api.github.com/repos/huahua0923/3D-school/tarball/main -o exhibition-nav.tar.gz
tar -xzf exhibition-nav.tar.gz -C exhibition-nav --strip-components=1
pm2 restart exhibition-nav-api
```

## 安全说明

- 高德 Key / 安全密钥 / 管理员密码**只存在 `.env`**，绝不进 git。
- 若旧版本曾把真实 Key 提交到公开仓库，请到高德控制台**轮换 Key 与安全密钥**并更新 `.env`。
- `config.json` 为公开数据文件，已确认不含任何密钥。
