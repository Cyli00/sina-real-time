"""SQLite 数据库初始化与用户管理工具函数"""

import hashlib
import logging
import os
import secrets
import sqlite3
import threading
from pathlib import Path

log = logging.getLogger("backtest")

DB_PATH = Path(os.environ.get("DB_PATH", str(Path(__file__).parent / "backtest.db")))
_lock = threading.Lock()

DEFAULT_PRESETS = [
    ("sh000001", "上证指数"),
    ("sz399001", "深证成指"),
    ("sz399006", "创业板指"),
    ("sh000688", "科创50"),
    ("sh000905", "中证500"),
    ("sh000300", "沪深300"),
    ("sh000015", "红利指数"),
]


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100_000)
    return f"{salt}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt, h = stored.split("$", 1)
    expected = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100_000)
    return secrets.compare_digest(expected.hex(), h)


def create_default_presets(conn: sqlite3.Connection, user_id: int):
    conn.executemany(
        "INSERT OR IGNORE INTO presets (user_id, code, label) VALUES (?, ?, ?)",
        [(user_id, code, label) for code, label in DEFAULT_PRESETS],
    )


def _ensure_columns(conn: sqlite3.Connection):
    """增量迁移：确保新字段存在"""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "pw_version" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN pw_version INTEGER NOT NULL DEFAULT 0")


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            pw_version INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            code TEXT NOT NULL,
            label TEXT NOT NULL,
            UNIQUE(user_id, code)
        );
    """)
    _ensure_columns(conn)

    admin_user = os.environ.get("ADMIN_USER", "admin")
    admin_pass = os.environ.get("ADMIN_PASS")
    if not admin_pass:
        log.warning("[db] ADMIN_PASS not set, using default — change before production!")
        admin_pass = "admin123"

    row = conn.execute("SELECT id FROM users WHERE username = ?", (admin_user,)).fetchone()
    if row:
        conn.execute("UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?",
                      (hash_password(admin_pass), row["id"]))
        log.info("[db] admin credentials updated")
    else:
        cur = conn.execute("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)",
                           (admin_user, hash_password(admin_pass)))
        create_default_presets(conn, cur.lastrowid)
        log.info("[db] admin created with default presets")

    conn.commit()
    conn.close()
