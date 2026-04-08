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
│   ├── app.py                   API 服务 + akshare 数据拉取
│   └── presets.json             用户收藏标的持久化
└── dev.ps1          一键启动脚本 (PowerShell)
```

**数据流**: 前端 → Vite proxy → FastAPI → akshare → 东财/新浪/网易

## 数据源

| 标的类型 | akshare 接口 | 数据源 |
|---------|-------------|-------|
| 个股 | `stock_zh_a_daily(adjust="qfq")` | 新浪/网易 |
| 指数 | `stock_zh_index_daily` | 新浪 |
| ETF | `fund_etf_hist_sina` | 新浪 |

名称查询优先使用新浪实时行情接口 (`hq.sinajs.cn`)，fallback akshare。

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

## 快速启动

```powershell
# 前提: Node.js, Python 3.12+, uv
cd project
.\dev.ps1
# 访问 http://localhost:3000
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

## API

| 端点 | 说明 |
|------|------|
| `GET /api/kline?symbol=sh000001&start=2020-01-01&end=2026-04-08` | K 线数据 |
| `GET /api/range?symbol=sh000001` | 数据范围探测 + 名称 |
| `GET /api/presets` | 获取收藏标的列表 |
| `POST /api/presets` | 保存收藏标的列表 |
| `GET /api/health` | 健康检查 |
