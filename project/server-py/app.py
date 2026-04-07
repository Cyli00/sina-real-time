"""回测平台 Python 后端 — FastAPI + akshare（前复权日K数据）"""

import json
import time
import logging
import threading
from pathlib import Path
from typing import Optional

import akshare as ak
import pandas as pd
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("backtest")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── 缓存 ──

CACHE: dict[str, tuple[list[dict], float]] = {}
CACHE_TTL = 600  # 10 分钟
_akshare_lock = threading.Lock()  # akshare 内部 V8 引擎不支持并发

PRESETS_FILE = Path(__file__).parent / "presets.json"


def is_index(symbol: str) -> bool:
    """判断是否为指数代码"""
    code = symbol[2:]  # sh000001 → 000001
    prefix = symbol[:2]
    # 上证指数 000xxx, 深证指数 399xxx
    if prefix == "sh" and code.startswith("000"):
        return True
    if prefix == "sz" and code.startswith("399"):
        return True
    # 科创50 等
    if prefix == "sh" and code.startswith("000"):
        return True
    return False


def fetch_kline_cached(symbol: str) -> list[dict]:
    """拉取全量日K数据，带缓存"""
    now = time.time()
    if symbol in CACHE:
        data, ts = CACHE[symbol]
        if now - ts < CACHE_TTL:
            return data

    log.info(f"[akshare] cache miss, fetching {symbol}")
    with _akshare_lock:
        # 拿到锁后再检查一次缓存（另一个请求可能已经填充了）
        if symbol in CACHE:
            data, ts = CACHE[symbol]
            if now - ts < CACHE_TTL:
                return data
        try:
            data = _fetch_kline(symbol)
        except Exception as e:
            log.error(f"[akshare] fetch failed for {symbol}: {e}")
            data = []

    CACHE[symbol] = (data, now)
    return data


def _fetch_kline(symbol: str) -> list[dict]:
    """实际拉取逻辑"""
    prefix = symbol[:2]  # sh / sz
    code = symbol[2:]    # 000001

    if is_index(symbol):
        # 指数用 stock_zh_index_daily（快速，英文列名）
        df = ak.stock_zh_index_daily(symbol=symbol)
        # 列: date, open, high, low, close, volume
        records = []
        for _, row in df.iterrows():
            records.append({
                "day": str(row["date"])[:10],
                "open": round(float(row["open"]), 2),
                "high": round(float(row["high"]), 2),
                "low": round(float(row["low"]), 2),
                "close": round(float(row["close"]), 2),
                "volume": float(row["volume"]),
            })
        return records
    else:
        # 个股用 stock_zh_a_hist（前复权）
        df = ak.stock_zh_a_hist(symbol=code, period="daily", adjust="qfq")
        # 中文列名: 日期, 股票代码, 开盘, 收盘, 最高, 最低, 成交量, ...
        records = []
        for _, row in df.iterrows():
            records.append({
                "day": str(row["日期"])[:10],
                "open": round(float(row["开盘"]), 2),
                "high": round(float(row["最高"]), 2),
                "low": round(float(row["最低"]), 2),
                "close": round(float(row["收盘"]), 2),
                "volume": float(row["成交量"]),
            })
        return records


def fetch_name(symbol: str) -> str:
    """获取股票/指数名称"""
    try:
        if is_index(symbol):
            # 从 stock_zh_index_spot_em 获取指数名称
            df = ak.stock_zh_index_spot_em(symbol="")
            row = df[df["代码"] == symbol[2:]]
            if not row.empty:
                return str(row.iloc[0]["名称"])
        else:
            # 从实时行情获取个股名称
            df = ak.stock_zh_a_spot_em()
            row = df[df["代码"] == symbol[2:]]
            if not row.empty:
                return str(row.iloc[0]["名称"])
    except Exception as e:
        log.warning(f"[akshare] fetch name failed for {symbol}: {e}")
    return symbol


# 名称缓存（不过期）
NAME_CACHE: dict[str, str] = {}


def get_name_cached(symbol: str) -> str:
    if symbol not in NAME_CACHE:
        NAME_CACHE[symbol] = fetch_name(symbol)
    return NAME_CACHE[symbol]


# ── API 路由 ──

@app.get("/api/health")
def health():
    return "OK"


@app.get("/api/kline")
def kline(
    symbol: str = Query(...),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
):
    data = fetch_kline_cached(symbol)
    if start:
        data = [d for d in data if d["day"] >= start]
    if end:
        data = [d for d in data if d["day"] <= end]

    name = get_name_cached(symbol)

    return {
        "symbol": symbol,
        "name": name,
        "data": data,
        "source": "akshare_qfq" if not is_index(symbol) else "akshare_index",
        "earliest_date": data[0]["day"] if data else "",
        "latest_date": data[-1]["day"] if data else "",
        "total_points": len(data),
    }


@app.get("/api/range")
def range_probe(symbol: str = Query(...)):
    data = fetch_kline_cached(symbol)
    name = get_name_cached(symbol)

    return {
        "symbol": symbol,
        "name": name,
        "earliest_date": data[0]["day"] if data else "2010-01-01",
        "latest_date": data[-1]["day"] if data else "",
        "kline_points": len(data),
        "csv_available": False,
    }


class Preset(BaseModel):
    code: str
    label: str


def load_presets() -> list[dict]:
    if PRESETS_FILE.exists():
        return json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
    defaults = [
        {"code": "sh000001", "label": "上证指数"},
        {"code": "sz399001", "label": "深证成指"},
        {"code": "sz399006", "label": "创业板指"},
        {"code": "sh000688", "label": "科创50"},
        {"code": "sh000905", "label": "中证500"},
        {"code": "sh000300", "label": "沪深300"},
        {"code": "sh000015", "label": "红利指数"},
    ]
    PRESETS_FILE.write_text(json.dumps(defaults, ensure_ascii=False, indent=2), encoding="utf-8")
    return defaults


@app.get("/api/presets")
def get_presets():
    return load_presets()


@app.post("/api/presets")
def set_presets(presets: list[Preset]):
    data = [p.model_dump() for p in presets]
    PRESETS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info(f"[presets] saved {len(data)} presets")
    return data


# ── 静态文件（生产模式） ──

DIST_DIR = Path(__file__).parent / "../client/dist"
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=4000)
