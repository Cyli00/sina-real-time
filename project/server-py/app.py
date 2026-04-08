"""回测平台 Python 后端 — FastAPI + akshare（前复权日K数据）"""

import json
import time
import logging
import threading
from pathlib import Path
from typing import Optional

import re
import urllib.request

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


def _symbol_type(symbol: str) -> str:
    """判断标的类型: 'index' | 'etf' | 'stock'"""
    prefix = symbol[:2]
    code = symbol[2:]
    if prefix == "sh" and code.startswith("000"):
        return "index"
    if prefix == "sz" and code.startswith("399"):
        return "index"
    # ETF: 上交所 51xxxx/56xxxx/58xxxx, 深交所 15xxxx/16xxxx
    if prefix == "sh" and (code.startswith("51") or code.startswith("56") or code.startswith("58")):
        return "etf"
    if prefix == "sz" and (code.startswith("15") or code.startswith("16")):
        return "etf"
    return "stock"


def is_index(symbol: str) -> bool:
    return _symbol_type(symbol) == "index"


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
            return []  # 异常时不缓存，避免空数据占位 10 分钟

    CACHE[symbol] = (data, now)
    return data


def _df_to_records(df, date_col="date") -> list[dict]:
    """DataFrame 转标准记录列表"""
    records = []
    for _, row in df.iterrows():
        records.append({
            "day": str(row[date_col])[:10],
            "open": round(float(row["open"]), 2),
            "high": round(float(row["high"]), 2),
            "low": round(float(row["low"]), 2),
            "close": round(float(row["close"]), 2),
            "volume": float(row["volume"]),
        })
    return records


def _fetch_kline(symbol: str) -> list[dict]:
    """实际拉取逻辑"""
    stype = _symbol_type(symbol)

    if stype == "index":
        df = ak.stock_zh_index_daily(symbol=symbol)
        return _df_to_records(df)
    elif stype == "etf":
        df = ak.fund_etf_hist_sina(symbol=symbol)
        return _df_to_records(df)
    else:
        df = ak.stock_zh_a_daily(symbol=symbol, adjust="qfq")
        return _df_to_records(df)


def _sina_name(symbol: str) -> Optional[str]:
    """通过新浪实时行情接口获取名称（轻量、无需 akshare）"""
    try:
        url = f"https://hq.sinajs.cn/list={symbol}"
        req = urllib.request.Request(url, headers={"Referer": "https://finance.sina.com.cn"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            text = resp.read().decode("gb18030")
        m = re.search(r'"([^"]*)"', text)
        if m:
            parts = m.group(1).split(",")
            if parts and parts[0]:
                return parts[0]
    except Exception:
        pass
    return None


def fetch_name(symbol: str) -> str:
    """获取股票/指数名称，优先新浪接口，fallback akshare"""
    # 1. 新浪实时行情（最轻量）
    name = _sina_name(symbol)
    if name:
        return name
    # 2. akshare fallback
    try:
        if is_index(symbol):
            for cat in ("上证系列指数", "深证系列指数", "沪深重要指数"):
                try:
                    df = ak.stock_zh_index_spot_em(symbol=cat)
                    row = df[df["代码"] == symbol[2:]]
                    if not row.empty:
                        return str(row.iloc[0]["名称"])
                except Exception:
                    continue
        else:
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
    cached = NAME_CACHE.get(symbol)
    # 如果缓存的是代码本身（之前获取失败），重试一次
    if cached is None or cached == symbol:
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
