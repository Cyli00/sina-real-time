#!/usr/bin/env bash
# 升级脚本 — 迁移旧版数据库到 ./data/ 目录
# 使用方式: cd project && ./upgrade.sh
set -euo pipefail

DATA_DIR="./data"
mkdir -p "$DATA_DIR"

echo "=== Backtest 升级检查 ==="

# 旧版数据库在 server-py/ 目录下
if [ -f "./server-py/backtest.db" ]; then
    if [ -f "$DATA_DIR/backtest.db" ]; then
        echo "[skip] $DATA_DIR/backtest.db already exists"
    else
        echo "[migrate] ./server-py/backtest.db -> $DATA_DIR/backtest.db"
        cp ./server-py/backtest.db "$DATA_DIR/backtest.db"
    fi
fi

# 裸机部署旧路径
if [ -f "/opt/backtest/server-py/backtest.db" ]; then
    if [ -f "/opt/backtest/data/backtest.db" ]; then
        echo "[skip] /opt/backtest/data/backtest.db already exists"
    else
        mkdir -p /opt/backtest/data
        echo "[migrate] /opt/backtest/server-py/backtest.db -> /opt/backtest/data/backtest.db"
        cp /opt/backtest/server-py/backtest.db /opt/backtest/data/backtest.db
    fi
fi

echo "=== done ==="
