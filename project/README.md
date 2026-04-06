# 策略回测平台

基于 **sina-real-time**（Rust WebSocket 采集）+ **新浪 HTTP API**（历史 K 线）的 A 股策略回测系统。

---

## 架构

```
                    ┌─────────────────────────────┐
                    │     sina-real-time           │
                    │  (Rust WebSocket collector)  │
                    │  wss://hq.sinajs.cn/wskt     │
                    └──────────┬──────────────────┘
                               │ 逐笔 tick → CSV
                               ▼
  ┌──────────────────────────────────────────────────────┐
  │              backtest-server (Rust/Axum)              │
  │                                                      │
  │  ┌─────────────┐    ┌───────────────┐                │
  │  │ csv_reader   │    │  sina_api      │               │
  │  │ 读取 CSV      │    │ 历史K线 HTTP   │               │
  │  │ 聚合日K线     │    │ 按季度补数据    │               │
  │  └──────┬──────┘    └──────┬────────┘                │
  │         └────── 合并去重 ──┘                          │
  │              │                                       │
  │    GET /api/kline?symbol=sz399006                    │
  │         &start=2010-06-01&end=2026-04-06             │
  │    GET /api/range?symbol=sz399006                    │
  │              │                                       │
  │    static files ← client/dist/                       │
  └──────────────┼───────────────────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────────────────────┐
  │            React Frontend (Recharts)                  │
  │                                                      │
  │  • 标的选择 (预设 + 自定义代码)                         │
  │  • 自定义日期范围 (快捷: 1/3/5/10年/最大)               │
  │  • 10种策略勾选对比                                    │
  │  • 资金曲线图 + 排名表 (收益率/回撤/胜率)               │
  └──────────────────────────────────────────────────────┘
```

## 数据流说明

| 数据源 | 方式 | 覆盖范围 | 用途 |
|--------|------|---------|------|
| `getKLineData` HTTP API | `symbol + scale=240 + datalen=1023` | 最近约 4 年日K | 主力历史数据 |
| `vMS_MarketHistory` 网页 | 按年+季度爬取 HTML 表格 | 上市首日至今 | 补充更早数据 |
| sina-real-time CSV | 读取 `data_YYYY-MM-DD.csv` | 采集开始至今 | 补充最新实时数据 |

当用户设定的 `start` 早于 K 线 API 覆盖范围时，后端自动按季度往前拉取，直到覆盖用户请求的日期。

---

## 项目结构

```
sina-real-time/                  # Git 仓库根目录
├── src/                         # Rust WebSocket 采集器源码
├── Cargo.toml                   # 采集器依赖
├── Dockerfile.collector         # 采集器 Docker 镜像
├── stocks_100.txt               # 默认股票列表
├── data/                        # (运行时生成) CSV 数据目录
│
├── project/                     # 回测平台
│   ├── server/                  # Rust 后端 (Axum)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs          # 路由 + 启动
│   │       ├── sina_api.rs      # 新浪 HTTP API
│   │       └── csv_reader.rs    # CSV 聚合日K线
│   ├── client/                  # React 前端 (Vite + Recharts)
│   │   ├── package.json
│   │   ├── vite.config.js
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.jsx
│   │       └── App.jsx          # 回测主界面
│   ├── Dockerfile               # 回测平台多阶段构建
│   ├── docker-compose.yml       # 编排 (回测 + 可选采集器)
│   └── README.md
│
└── backtest-app.jsx             # App.jsx 独立参考副本
```

---

## 本地开发

### 1. 启动回测后端

```bash
cd project/server
cargo build --release
./target/release/backtest-server                    # 纯历史回测
./target/release/backtest-server --csv-dir ../../data   # 历史 + 实时
```

### 2. 启动前端 (开发模式)

```bash
cd project/client
npm install
npm run dev
# → http://localhost:3000  (自动代理 /api → localhost:4000)
```

### 3. 启动采集器 (可选)

```bash
cd .   # 仓库根目录
cargo build --release
./target/release/sina-realtime-collector --stocks stocks_100.txt --output data
```

---

## 远程服务器部署

### 前置条件

| 项目 | 最低要求 |
|------|---------|
| 操作系统 | Ubuntu 20.04+ / Debian 11+ / CentOS 8+ |
| 内存 | 1 GB (仅回测) / 2 GB (回测 + 采集) |
| 磁盘 | 2 GB (Docker 镜像 + 数据) |
| 网络 | 能访问 `*.sinajs.cn` 和 `*.sina.com.cn` |

### 方案一: Docker 部署 (推荐)

#### 1. 安装 Docker

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 重新登录使 docker 组生效
```

#### 2. 上传项目到服务器

```bash
# 本地执行 — 上传整个仓库
rsync -avz --exclude target --exclude node_modules --exclude .git \
  . user@your-server:/opt/sina-real-time

# 或者用 git clone
ssh user@your-server
git clone <your-repo-url> /opt/sina-real-time
```

#### 3. 构建并启动

```bash
ssh user@your-server
cd /opt/sina-real-time/project

# 仅回测平台 (不采集实时数据)
docker compose up -d backtest

# 回测 + 实时采集
docker compose --profile with-collector up -d

# 查看日志
docker compose logs -f backtest
docker compose logs -f collector    # 如果启用了采集
```

启动后访问 `http://your-server:4000`。

#### 4. 更新部署

```bash
cd /opt/sina-real-time
git pull
cd project
docker compose build
docker compose up -d
```

---

### 方案二: 手动编译部署

适用于不想使用 Docker 的场景，直接在服务器上编译运行。

#### 1. 安装依赖

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# 安装 Node.js (用于构建前端)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装系统依赖
sudo apt-get install -y build-essential pkg-config libssl-dev
```

#### 2. 构建前端

```bash
cd /opt/sina-real-time/project/client
npm install
npm run build    # 输出到 dist/
```

#### 3. 构建并启动后端

```bash
cd /opt/sina-real-time/project/server
cargo build --release

# 启动 (前端静态文件由后端托管)
./target/release/backtest-server \
  --static-dir ../client/dist \
  --csv-dir ../../data \
  --port 4000
```

#### 4. 配置 systemd 服务

创建 `/etc/systemd/system/backtest.service`：

```ini
[Unit]
Description=Backtest Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/sina-real-time/project/server
ExecStart=/opt/sina-real-time/project/server/target/release/backtest-server \
  --static-dir /opt/sina-real-time/project/client/dist \
  --csv-dir /opt/sina-real-time/data \
  --port 4000
Environment=RUST_LOG=backtest_server=info
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

（可选）采集器服务 `/etc/systemd/system/sina-collector.service`：

```ini
[Unit]
Description=Sina Real-time Collector
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/sina-real-time
ExecStart=/opt/sina-real-time/target/release/sina-realtime-collector \
  --stocks /opt/sina-real-time/stocks_100.txt \
  --output /opt/sina-real-time/data
Environment=RUST_LOG=sina_collector=info
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now backtest
sudo systemctl enable --now sina-collector   # 可选
sudo systemctl status backtest
```

---

### Nginx 反向代理 + HTTPS

推荐在 backtest-server 前面加一层 Nginx，提供 HTTPS 和域名访问。

#### 1. 安装 Nginx + Certbot

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

#### 2. 配置 Nginx

创建 `/etc/nginx/sites-available/backtest`：

```nginx
server {
    listen 80;
    server_name backtest.your-domain.com;  # 替换为你的域名

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
# Certbot 会自动修改 Nginx 配置并设置自动续期
```

完成后访问 `https://backtest.your-domain.com`。

---

### 防火墙配置

```bash
# 仅开放必要端口
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable

# 如果不用 Nginx，直接暴露 4000 端口
sudo ufw allow 4000/tcp
```

---

### 部署验证

```bash
# 健康检查
curl http://localhost:4000/api/health
# 期望输出: OK

# 测试 K 线接口
curl "http://localhost:4000/api/kline?symbol=sz399006&start=2024-01-01" | head -c 200

# 测试日期范围探测
curl "http://localhost:4000/api/range?symbol=sh000001"
```

---

## API 文档

### `GET /api/kline`

获取 K 线数据（自动合并多数据源）。

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
  "source": "sina_http+csv",
  "earliest_date": "2020-01-02",
  "latest_date": "2026-04-04",
  "total_points": 1502
}
```

### `GET /api/range`

快速探测标的可用日期范围（不返回完整数据）。

| 参数 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `symbol` | string | Y | 股票代码 |

### `GET /api/health`

健康检查，返回 `OK`。

---

## 回测策略

| 策略 | 逻辑 |
|------|------|
| 一直持有 | 第一天买入，持有到最后 |
| 5/10/20/30/60日均线趋势 | MA 拐头向上且价格在 MA 上方买入，拐头向下且价格跌破卖出 |
| 站上5日均线突破 | 价格从下方突破 MA5 买入，从上方跌破卖出 |
| MACD 金叉死叉 | DIF 上穿 DEA 买入，下穿卖出 |
| KDJ 金叉死叉 | K 上穿 D 买入，下穿卖出 |
| CCI ±100 | CCI 上穿 +100 买入，下穿 -100 卖出 |

---

## 常见问题

**Q: 后端启动后前端显示 DEMO DATA？**
后端需要能访问 `money.finance.sina.com.cn`，检查服务器网络/DNS 是否通畅：
```bash
curl -I "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sz399006&scale=240&ma=no&datalen=5"
```

**Q: Docker 构建时 Rust 编译很慢？**
Rust release 编译需要较多内存和时间。建议服务器至少 2 GB 内存，或在本地交叉编译后上传二进制文件。

**Q: 采集器连接断开？**
新浪 WebSocket 可能定期断开，采集器已内置自动重连。通过 `docker compose logs -f collector` 查看状态。

**Q: 如何更换股票列表？**
编辑仓库根目录的 `stocks_100.txt`（每行一个代码如 `sz300394`），重启采集器即可。
