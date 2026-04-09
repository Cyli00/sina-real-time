"""回测平台 Python 后端 — FastAPI + akshare（前复权日K数据）"""

import json
import time
import logging
import threading
import os
import secrets
import hashlib
import hmac as _hmac
import base64
from pathlib import Path
from typing import Optional
from datetime import datetime, timedelta, timezone

import re
import urllib.request

import akshare as ak
import pandas as pd
from fastapi import FastAPI, Query, HTTPException, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from db import init_db, get_db, hash_password, verify_password, create_default_presets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("backtest")

app = FastAPI()

# CORS: 生产环境通过 ALLOWED_ORIGINS 环境变量限制，逗号分隔
_origins = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in _origins],
                   allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
                   allow_headers=["Content-Type", "Authorization"])

# ── JWT ──

JWT_SECRET = os.environ.get("JWT_SECRET", secrets.token_hex(32))


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    s += "=" * (4 - len(s) % 4)
    return base64.urlsafe_b64decode(s)


def create_token(user_id: int, username: str, is_admin: bool, pw_ver: int = 0) -> str:
    header = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url_encode(json.dumps({
        "user_id": user_id, "username": username, "is_admin": is_admin, "pw_ver": pw_ver,
        "exp": int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp()),
    }).encode())
    sig = _b64url_encode(_hmac.new(JWT_SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def decode_token(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("invalid")
    header_part, payload, sig = parts
    # 验证 alg
    header_data = json.loads(_b64url_decode(header_part))
    if header_data.get("alg") != "HS256":
        raise ValueError("invalid")
    expected = _b64url_encode(_hmac.new(JWT_SECRET.encode(), f"{header_part}.{payload}".encode(), hashlib.sha256).digest())
    if not secrets.compare_digest(sig, expected):
        raise ValueError("invalid")
    data = json.loads(_b64url_decode(payload))
    if data.get("exp", 0) < int(datetime.now(timezone.utc).timestamp()):
        raise ValueError("expired")
    # 检查 token 是否在密码修改前签发
    pw_ver = data.get("pw_ver", 0)
    conn = get_db()
    try:
        row = conn.execute("SELECT pw_version FROM users WHERE id = ?", (data.get("user_id"),)).fetchone()
        if row and row["pw_version"] != pw_ver:
            raise ValueError("revoked")
    finally:
        conn.close()
    return data


def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "未登录")
    try:
        return decode_token(authorization[7:])
    except ValueError:
        raise HTTPException(401, "认证无效")


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_admin"):
        raise HTTPException(403, "需要管理员权限")
    return user


# ── 启动 ──

@app.on_event("startup")
def startup():
    init_db()
    log.info("[startup] database initialized")


# ── 缓存 ──

CACHE: dict[str, tuple[list[dict], float]] = {}
CACHE_TTL = 600  # 10 分钟
_akshare_lock = threading.Lock()  # akshare 内部 V8 引擎不支持并发


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
        if symbol in CACHE:
            data, ts = CACHE[symbol]
            if now - ts < CACHE_TTL:
                return data
        try:
            data = _fetch_kline(symbol)
        except Exception as e:
            log.error(f"[akshare] fetch failed for {symbol}: {e}")
            return []

    CACHE[symbol] = (data, now)
    return data


def _df_to_records(df, date_col="date", col_map=None) -> list[dict]:
    """DataFrame 转标准记录列表，col_map 用于映射中文列名"""
    if col_map is None:
        col_map = {"open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume"}
    records = []
    for _, row in df.iterrows():
        records.append({
            "day": str(row[date_col])[:10],
            "open": round(float(row[col_map["open"]]), 2),
            "high": round(float(row[col_map["high"]]), 2),
            "low": round(float(row[col_map["low"]]), 2),
            "close": round(float(row[col_map["close"]]), 2),
            "volume": float(row[col_map["volume"]]),
        })
    return records


# 东财接口统一的中文列名映射
_EM_COL_MAP = {"open": "开盘", "high": "最高", "low": "最低", "close": "收盘", "volume": "成交量"}


def _fetch_kline(symbol: str) -> list[dict]:
    """东财优先拉取，失败时 fallback 到新浪"""
    code = symbol[2:]
    stype = _symbol_type(symbol)

    try:
        if stype == "index":
            df = ak.index_zh_a_hist(symbol=code, period="daily")
        elif stype == "etf":
            df = ak.fund_etf_hist_em(symbol=code, period="daily", adjust="qfq")
        else:
            df = ak.stock_zh_a_hist(symbol=code, period="daily", adjust="qfq")
        return _df_to_records(df, date_col="日期", col_map=_EM_COL_MAP)
    except Exception as e:
        log.warning(f"[akshare] 东财接口失败 {symbol}: {e}，尝试新浪 fallback")

    if stype == "index":
        df = ak.stock_zh_index_daily(symbol=symbol)
    elif stype == "etf":
        df = ak.fund_etf_hist_sina(symbol=symbol)
    else:
        df = ak.stock_zh_a_daily(symbol=symbol, adjust="qfq")
    return _df_to_records(df)


def _sina_name(symbol: str) -> Optional[str]:
    """通过新浪实时行情接口获取名称"""
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
    name = _sina_name(symbol)
    if name:
        return name
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


NAME_CACHE: dict[str, str] = {}


def get_name_cached(symbol: str) -> str:
    cached = NAME_CACHE.get(symbol)
    if cached is None or cached == symbol:
        NAME_CACHE[symbol] = fetch_name(symbol)
    return NAME_CACHE[symbol]


# ── API 路由 ──

@app.get("/api/health")
def health():
    return "OK"


class LoginReq(BaseModel):
    username: str
    password: str


# 登录限速：每 IP 15 分钟内最多 10 次
_login_attempts: dict[str, list[float]] = {}
_LOGIN_WINDOW = 900  # 15 min
_LOGIN_MAX = 10


@app.post("/api/login")
def login(req: LoginReq, request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    attempts = _login_attempts.setdefault(ip, [])
    attempts[:] = [t for t in attempts if now - t < _LOGIN_WINDOW]
    if len(attempts) >= _LOGIN_MAX:
        raise HTTPException(429, "登录尝试过于频繁，请稍后再试")
    attempts.append(now)

    conn = get_db()
    try:
        row = conn.execute("SELECT id, username, password_hash, is_admin, pw_version FROM users WHERE username = ?",
                           (req.username,)).fetchone()
        if not row or not verify_password(req.password, row["password_hash"]):
            raise HTTPException(401, "用户名或密码错误")
        token = create_token(row["id"], row["username"], bool(row["is_admin"]), row["pw_version"])
        return {"token": token, "username": row["username"], "is_admin": bool(row["is_admin"])}
    finally:
        conn.close()


# ── 修改密码 ──

class ChangePasswordReq(BaseModel):
    old_password: str
    new_password: str


@app.post("/api/change-password")
def change_password(req: ChangePasswordReq, user: dict = Depends(get_current_user)):
    if not req.new_password.strip():
        raise HTTPException(400, "新密码不能为空")
    conn = get_db()
    try:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["user_id"],)).fetchone()
        if not row or not verify_password(req.old_password, row["password_hash"]):
            raise HTTPException(400, "旧密码错误")
        conn.execute("UPDATE users SET password_hash = ?, pw_version = pw_version + 1 WHERE id = ?",
                     (hash_password(req.new_password), user["user_id"]))
        conn.commit()
        # 返回新 token（旧 token 已因 pw_version 变更而失效）
        r = conn.execute("SELECT id, username, is_admin, pw_version FROM users WHERE id = ?",
                         (user["user_id"],)).fetchone()
        new_token = create_token(r["id"], r["username"], bool(r["is_admin"]), r["pw_version"])
        return {"ok": True, "token": new_token}
    finally:
        conn.close()


# ── Admin 路由 ──

@app.get("/api/admin/users")
def list_users(user: dict = Depends(require_admin)):
    conn = get_db()
    try:
        rows = conn.execute("SELECT id, username, is_admin, created_at FROM users ORDER BY id").fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


class CreateUserReq(BaseModel):
    username: str
    password: str


@app.post("/api/admin/users")
def create_user(req: CreateUserReq, user: dict = Depends(require_admin)):
    if not req.username.strip() or not req.password.strip():
        raise HTTPException(400, "用户名和密码不能为空")
    conn = get_db()
    try:
        existing = conn.execute("SELECT id FROM users WHERE username = ?", (req.username,)).fetchone()
        if existing:
            raise HTTPException(409, "用户名已存在")
        cur = conn.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)",
                           (req.username.strip(), hash_password(req.password)))
        create_default_presets(conn, cur.lastrowid)
        conn.commit()
        return {"id": cur.lastrowid, "username": req.username.strip()}
    finally:
        conn.close()


class ResetPasswordReq(BaseModel):
    new_password: str


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: int, req: ResetPasswordReq, user: dict = Depends(require_admin)):
    if not req.new_password.strip():
        raise HTTPException(400, "新密码不能为空")
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(404, "用户不存在")
        conn.execute("UPDATE users SET password_hash = ?, pw_version = pw_version + 1 WHERE id = ?",
                     (hash_password(req.new_password), user_id))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, user: dict = Depends(require_admin)):
    if user_id == user["user_id"]:
        raise HTTPException(400, "不能删除自己")
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(404, "用户不存在")
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── 行情路由（需认证） ──

_SYMBOL_RE = re.compile(r"^(sh|sz|bj)\d{6}$")


def _validate_symbol(symbol: str) -> str:
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(400, "无效的标的代码")
    return symbol


@app.get("/api/kline")
def kline(
    symbol: str = Query(...),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    _validate_symbol(symbol)
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
def range_probe(
    symbol: str = Query(...),
    user: dict = Depends(get_current_user),
):
    _validate_symbol(symbol)
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


# ── Presets（per-user） ──

class Preset(BaseModel):
    code: str
    label: str


@app.get("/api/presets")
def get_presets(user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        rows = conn.execute("SELECT code, label FROM presets WHERE user_id = ? ORDER BY id",
                            (user["user_id"],)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.post("/api/presets")
def set_presets(presets: list[Preset], user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        conn.execute("DELETE FROM presets WHERE user_id = ?", (user["user_id"],))
        conn.executemany(
            "INSERT INTO presets (user_id, code, label) VALUES (?, ?, ?)",
            [(user["user_id"], p.code, p.label) for p in presets],
        )
        conn.commit()
        log.info(f"[presets] user={user['username']} saved {len(presets)} presets")
        return [p.model_dump() for p in presets]
    finally:
        conn.close()


# ── 静态文件（生产模式） ──

# 生产模式：从构建产物提供前端静态文件
# 裸机: server-py/../client/dist, Docker: /app/client/dist
DIST_DIR = Path(os.environ.get("DIST_DIR", str(Path(__file__).parent / "../client/dist")))
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=4000)
