# 策略回测平台

基于 **akshare** 的 A 股策略回测系统，支持个股、指数、ETF。

## 架构

```
project/
├── client/          React + Vite 前端 (port 3000)
│   └── src/
│       ├── App.jsx              主组件 + 回测引擎
│       └── utils/
│           ├── indicators.js    SMA / EMA / MACD 指标计算
│           ├── ma.js            均线策略 (5/10/20/30/60日)
│           └── macd.js          MACD 金叉死叉策略
├── server-py/       FastAPI 后端 (port 4000)
│   ├── app.py                   API 服务 + JWT 认证 + akshare 数据拉取
│   └── db.py                    SQLite 用户管理 + per-user presets
├── dev.ps1          本地开发一键启动 (PowerShell)
├── deploy.sh        裸机 Debian 部署脚本
├── Dockerfile       多阶段构建镜像
├── docker-compose.yml  Docker Compose + Caddy 反代
├── Caddyfile        Caddy 反向代理配置（自动 HTTPS）
└── .env.example     环境变量模板
```

**数据流**: 前端 → Vite proxy / Caddy → FastAPI → akshare → 东财（fallback 新浪）

## 数据源

| 标的类型 | akshare 接口（东财优先） | fallback |
|---------|------------------------|----------|
| 个股 | `stock_zh_a_hist(adjust="qfq")` | `stock_zh_a_daily` (新浪) |
| 指数 | `index_zh_a_hist` | `stock_zh_index_daily` (新浪) |
| ETF | `fund_etf_hist_em(adjust="qfq")` | `fund_etf_hist_sina` (新浪) |

名称查询优先使用新浪实时行情接口 (`hq.sinajs.cn`)，fallback akshare。

## 用户管理

- 首次部署默认管理员: `admin` / `admin123`
- **首次登录强制修改管理员用户名和密码**，设置完成后默认凭证失效
- 管理员可在 UI 中添加/删除用户、重置密码
- 每个用户拥有独立的标的监控列表（首次创建自动生成默认 7 个指数）
- 用户可自行修改密码
- JWT 认证，改密后旧 token 自动失效

## 回测策略

- **一直持有** — 基准策略
- **均线拐头** — 5/10/20/30/60 日均线向上买入、向下卖出
- **均线突破** — 价格站上均线买入、跌破卖出
- **MACD 金叉死叉** — DIF 上穿 DEA 买入、下穿卖出

## 回测参数

- 成交价格: 当日收盘 / 次日开盘
- 佣金费率 (万N)、印花税 (千N)、最低佣金、滑点
- 涨跌停检测 (科创板 20%、创业板 20%、北交所 30%、主板 10%)
- 指数 / ETF 免佣金印花税，无整手约束

## 快速启动（本地开发）

```powershell
# 前提: Node.js, Python 3.12+, uv
cd project
.\dev.ps1
# 访问 http://localhost:3000
# 默认管理员: admin / admin123（首次登录强制修改）
```

手动启动:

```bash
# 后端
cd project/server-py
uv run python app.py          # http://localhost:4000

# 前端
cd project/client
npm install && npm run dev    # http://localhost:3000
```

## 部署（远程服务器）

### Docker Compose（推荐）

```bash
cd project

# 创建 .env（仅需两个变量）
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "ALLOWED_ORIGINS=https://your-domain.com" >> .env

docker compose up -d
# 首次登录默认管理员 admin / admin123，系统强制修改
```

后端监听 `127.0.0.1:4000`，需用服务器已有的 Caddy/nginx 反代：

```caddyfile
your-domain.com {
    reverse_proxy 127.0.0.1:4000
}
```

### 裸机 Debian

```bash
cd project
sudo ./deploy.sh
# 脚本自动生成 JWT_SECRET，部署后仅需修改域名:
sudo vim /etc/caddy/Caddyfile  # 替换 your-domain.com
sudo vim /etc/backtest.env     # ALLOWED_ORIGINS 改为实际域名
sudo systemctl restart backtest caddy
# 首次登录默认管理员 admin / admin123，系统强制修改
```

### 更新部署

```bash
cd project
docker compose down
git pull
docker compose up -d --build
```

数据库在 `./data/` 目录（已加入 `.gitignore`），`git pull` 不会影响用户数据。

旧版升级（数据库在 `server-py/` 下）需先迁移：`./upgrade.sh`

### 服务管理

- `systemctl status backtest` — 后端状态
- `systemctl status caddy` — 反代状态
- 日志: `journalctl -u backtest -f`

## 部署架构

```
Internet → Caddy (:443 HTTPS) → FastAPI (:4000 localhost)
                                  ├── /api/*    后端 API
                                  └── /*        前端静态文件 (dist/)
```

- 后端绑定 `127.0.0.1:4000`，仅本机可访问
- Caddy 反代对外暴露，自动 HTTPS
- SQLite 数据库持久化在 `./data/`（`.gitignore` 忽略，`git pull` 不影响）

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 签名密钥 | 随机生成（重启失效，生产应固定） |
| `ALLOWED_ORIGINS` | CORS 允许来源，逗号分隔 | `*` |
| `DB_PATH` | SQLite 数据库路径 | `server-py/backtest.db` |
| `DIST_DIR` | 前端构建产物路径 | `../client/dist` |

## API

| 端点 | 认证 | 说明 |
|------|------|------|
| `POST /api/login` | 无 | 登录获取 token（含 `must_setup` 标志） |
| `POST /api/setup` | 用户 | 首次设置管理员用户名+密码 |
| `POST /api/change-password` | 用户 | 修改密码（返回新 token） |
| `GET /api/admin/users` | 管理员 | 用户列表 |
| `POST /api/admin/users` | 管理员 | 添加用户 |
| `POST /api/admin/users/{id}/reset-password` | 管理员 | 重置密码 |
| `DELETE /api/admin/users/{id}` | 管理员 | 删除用户 |
| `GET /api/kline?symbol=sh000001&start=...&end=...` | 用户 | K 线数据 |
| `GET /api/range?symbol=sh000001` | 用户 | 数据范围探测 + 名称 |
| `GET /api/presets` | 用户 | 获取收藏标的列表（per-user） |
| `POST /api/presets` | 用户 | 保存收藏标的列表（per-user） |
| `GET /api/health` | 无 | 健康检查 |
