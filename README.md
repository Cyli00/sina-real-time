# sina-real-time

新浪财经 WebSocket 实时行情采集工具（Rust 实现）

## 功能

- 连接 `wss://hq.sinajs.cn/wskt` 实时推送接口
- 自动重连（指数退避，最大 30 秒间隔）
- 按 `--chunk-size` 拆分为多个并行 WebSocket 连接，支持全量沪深 A 股（5189 只）
- 数据持久化到本地 CSV，按天轮转（`data_YYYY-MM-DD.csv`）
- 基于 Tokio 异步运行时，内置缓冲通道解耦采集与存储

## 实测性能（10 核 / 16 GB / macOS）

| 股票数 | 连接数 | 写入速度 |
|--------|--------|----------|
| 100    | 1      | ~45 条/秒 |
| 1000   | 2      | ~440 条/秒 |
| 5189   | 11     | ~968 条/秒 |

## 股票列表文件

```
sina-collector/
├── stocks.txt           # 12 只样本（测试用）
├── stocks_100.txt       # 100 只（用 fetch_stocks.py 生成）
├── stocks_1000.txt      # 1000 只
└── stocks_all.txt       # 5189 只全量沪深 A 股（已预生成）
```

## 快速开始

```bash
cd sina-collector
cargo build --release

# 样本测试（12 只）
./target/release/sina-realtime-collector

# 100 只
./target/release/sina-realtime-collector --stocks stocks_100.txt --output data

# 1000 只
./target/release/sina-realtime-collector --stocks stocks_1000.txt --output data

# 全量沪深 A 股（5189 只，11 个并行连接）
./target/release/sina-realtime-collector --stocks stocks_all.txt --output data
```

## 更新股票列表

```bash
# 重新从新浪 API 拉取最新股票列表（约 53 次请求，耗时 ~3 秒）
python3 scripts/fetch_stocks.py

# 同时生成 100 只样本
python3 scripts/fetch_stocks.py --sample 100

# 指定输出路径
python3 scripts/fetch_stocks.py -o /path/to/stocks.txt
```

## 数据格式

CSV 文件每行：
```
received_at,code,fields
2026-02-26T14:33:46.037,sh600519,"贵州茅台,昨收,今开,当前,最高,最低,买1,卖1,成交量,成交额,<买5档>,<卖5档>,日期,时间,状态"
```

`fields` 列字段顺序：
`名称, 昨收, 今开, 当前价, 最高, 最低, 买一价, 卖一价, 成交量(股), 成交额(元), 买5档×(量,价)×5, 卖5档×(量,价)×5, 日期, 时间, 状态`

## 命令行参数

```
Options:
  -s, --stocks <FILE>        股票列表文件 [default: stocks.txt]
  -o, --output <DIR>         输出目录 [default: data]
      --chunk-size <N>       每个连接的股票数 [default: 500]
      --buffer <N>           通道缓冲容量 [default: 131072]
  -h, --help
  -V, --version
```

## 日志级别

```bash
RUST_LOG=debug ./target/release/sina-realtime-collector --stocks stocks_all.txt --output data --chunk-size 200  # 详细日志
RUST_LOG=warn  ./target/release/sina-realtime-collector   # 仅告警
```

## 后续扩展

`storage.rs` 中的 `mpsc::Receiver<String>` 可替换为 `broadcast` channel，
向下游实时分析模块（Python、数据库写入器等）同时分发数据，无需修改采集层。

---

## 策略回测平台

基于采集数据 + 新浪 HTTP API 的 A 股策略回测系统，位于 `project/` 目录。

- **后端**: Rust/Axum — 合并 CSV 实时数据 + HTTP 历史 K 线，提供 `/api/kline`、`/api/range` 接口
- **前端**: React/Recharts — 10 种策略对比、资金曲线图、排名表
- 详细文档见 [project/README.md](project/README.md)

### Docker 部署

```bash
cd project

# 仅回测平台（不采集实时数据，从新浪 HTTP API 获取历史 K 线）
docker compose up -d backtest

# 回测 + 实时采集
docker compose --profile with-collector up -d

# 查看日志
docker compose logs -f
```

启动后访问 `http://localhost:4000`。

### 手动部署

```bash
# 1. 构建前端
cd project/client && npm install && npm run build

# 2. 构建并启动后端（托管前端静态文件）
cd ../server && cargo build --release
./target/release/backtest-server \
  --static-dir ../client/dist \
  --csv-dir ../../data \
  --port 4000
```

### 远程服务器部署

包含 Nginx + HTTPS、systemd 服务配置、防火墙等完整指南，见 [project/README.md — 远程服务器部署](project/README.md#远程服务器部署)。
