# 策略回测平台

基于 **akshare**（前复权日K数据）的 A 股策略回测系统。

---

## 架构

```
  ┌──────────────────────────────────────────────────────┐
  │          backtest-server (Python/FastAPI)             │
  │                                                      │
  │  ┌───────────────────────────────────┐               │
  │  │  akshare                          │               │
  │  │  · 个股: stock_zh_a_hist(qfq)    │               │
  │  │  · 指数: stock_zh_index_daily     │               │
  │  │  · 内存缓存 10 分钟               │               │
  │  └──────────────┬────────────────────┘               │
  │                 │                                    │
  │    GET /api/kline?symbol=sz399006                    │
  │         &start=2010-06-01&end=2026-04-07             │
  │    GET /api/range?symbol=sz399006                    │
  │    GET /api/presets  ·  POST /api/presets             │
  │                 │                                    │
  │    static files ← client/dist/                       │
  └─────────────────┼────────────────────────────────────┘
                    │
                    ▼
  ┌──────────────────────────────────────────────────────┐
  │            React Frontend (Recharts)                  │
  │                                                      │
  │  • 标的选择 (预设 + 自定义代码，支持收藏)              │
  │  • 自定义日期范围 (快捷: 1/3/5/10年/最大)              │
  │  • 15种策略勾选对比                                   │
  │  • 成交价格选择 (当日收盘 / 次日开盘)                  │
  │  • 资金曲线图 + 排名表 (收益率/回撤/胜率)              │
  └──────────────────────────────────────────────────────┘
```

## 数据说明

| 类型 | akshare 接口 | 复权 | 覆盖范围 |
|------|-------------|------|---------|
| 个股 | `stock_zh_a_hist(adjust='qfq')` | 前复权 | 上市至今 |
| 指数 | `stock_zh_index_daily` | 无需复权 | 发布至今 |

---

## 项目结构

```
sina-real-time/                  # Git 仓库根目录
├── src/                         # Rust WebSocket 采集器源码
├── Cargo.toml                   # 采集器依赖
├── stocks_100.txt               # 默认股票列表
├── data/                        # (运行时生成) CSV 数据目录
│
├── project/                     # 回测平台
│   ├── server-py/               # Python 后端 (FastAPI + akshare)
│   │   ├── pyproject.toml       # uv 项目配置
│   │   ├── app.py               # 主程序 (路由 + 数据拉取)
│   │   └── presets.json         # 标的预设列表 (可编辑)
│   ├── client/                  # React 前端 (Vite + Recharts)
│   │   ├── package.json
│   │   ├── vite.config.js
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.jsx
│   │       └── App.jsx          # 回测主界面
│   ├── dev.ps1                  # 一键启动脚本 (PowerShell)
│   └── README.md
│
└── backtest-app.jsx             # App.jsx 独立参考副本
```

---

## 本地开发

### 前置条件

- [uv](https://docs.astral.sh/uv/) (Python 包管理)
- [Node.js](https://nodejs.org/) 18+

### 一键启动

```powershell
cd project
.\dev.ps1
```

自动启动后端 (4000) + 前端 (3000)，访问 **http://localhost:3000**。

### 手动启动（两个终端）

#### 终端 1: Python 后端

```bash
cd project/server-py
uv run python app.py             # 监听 4000 端口
```

#### 终端 2: 前端

```bash
cd project/client
npm install
npm run dev                      # 监听 3000 端口，代理 /api → 4000
```

打开浏览器访问 **http://localhost:3000**。

---

## 远程服务器部署

### 前置条件

| 项目 | 最低要求 |
|------|---------|
| 操作系统 | Ubuntu 20.04+ / Debian 11+ / CentOS 8+ |
| 内存 | 512 MB |
| 磁盘 | 500 MB |
| 网络 | 能访问 `*.eastmoney.com`（akshare 数据源）|

### 手动部署

#### 1. 安装依赖

```bash
# 安装 uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

#### 2. 构建前端

```bash
cd /opt/sina-real-time/project/client
npm install
npm run build    # 输出到 dist/
```

#### 3. 启动后端（托管前端静态文件）

```bash
cd /opt/sina-real-time/project/server-py
uv run python app.py
```

后端启动后访问 `http://your-server:4000`。

#### 4. 配置 systemd 服务

创建 `/etc/systemd/system/backtest.service`：

```ini
[Unit]
Description=Backtest Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/sina-real-time/project/server-py
ExecStart=/usr/local/bin/uv run python app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now backtest
sudo systemctl status backtest
```

---

### Nginx 反向代理 + HTTPS

#### 1. 安装 Nginx + Certbot

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

#### 2. 配置 Nginx

创建 `/etc/nginx/sites-available/backtest`：

```nginx
server {
    listen 80;
    server_name backtest.your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/backtest /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

#### 3. 申请 SSL 证书

```bash
sudo certbot --nginx -d backtest.your-domain.com
```

完成后访问 `https://backtest.your-domain.com`。

---

### 防火墙配置

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
```

---

### 部署验证

```bash
# 健康检查
curl http://localhost:4000/api/health
# 期望输出: "OK"

# 测试 K 线接口
curl "http://localhost:4000/api/kline?symbol=sz399006&start=2024-01-01" | head -c 200

# 测试日期范围探测
curl "http://localhost:4000/api/range?symbol=sh000001"
```

---

## API 文档

### `GET /api/kline`

获取 K 线数据（个股自动前复权）。

| 参数 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `symbol` | string | Y | 股票代码，如 `sz399006`, `sh600519` |
| `start` | string | N | 起始日期 `YYYY-MM-DD`，留空则返回全部 |
| `end` | string | N | 结束日期 `YYYY-MM-DD` |

响应:
```json
{
  "symbol": "sz399006",
  "name": "创业板指",
  "data": [
    {"day":"2020-01-02","open":1793.29,"high":1799.81,"low":1780.02,"close":1793.49,"volume":2.3e9}
  ],
  "source": "akshare_index",
  "earliest_date": "2010-06-01",
  "latest_date": "2026-04-07",
  "total_points": 3801
}
```

### `GET /api/range`

快速探测标的可用日期范围。

| 参数 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `symbol` | string | Y | 股票代码 |

### `GET /api/presets`

获取标的预设列表。

### `POST /api/presets`

保存标的预设列表（JSON 数组 `[{code, label}]`）。

### `GET /api/health`

健康检查，返回 `"OK"`。

---

## 回测策略

| 策略 | 逻辑 |
|------|------|
| 一直持有 | 第一天买入，持有到最后 |
| 5/10/20/30/60日均线趋势 | MA 拐头向上且价格在 MA 上方买入，拐头向下且价格跌破卖出 |
| 站上5/10/20/30/60日均线突破 | 价格从下方突破 MA 买入，从上方跌破卖出 |
| MACD 金叉死叉 | DIF 上穿 DEA 买入，下穿卖出 |
| KDJ 金叉死叉 | K 上穿 D 买入，下穿卖出 |
| CCI ±100 | CCI 上穿 +100 买入，下穿 -100 卖出 |

---

## 常见问题

**Q: 后端启动后前端显示 DEMO DATA？**
后端需要能访问 akshare 数据源（东方财富等），检查网络是否通畅。

**Q: 某只股票加载很慢？**
首次加载某标的需要从 akshare 拉取全量数据，之后 10 分钟内有缓存。

**Q: 个股数据是否复权？**
个股自动使用前复权数据（`adjust='qfq'`），指数无需复权。

**Q: 如何添加自选标的？**
输入代码（支持 `sh600519`、`600519`、`600519.SH`）→ 回测 → 点"+ 收藏"按钮，预设会保存到 `server-py/presets.json`。
