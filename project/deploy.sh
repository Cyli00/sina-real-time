#!/usr/bin/env bash
# 裸机 Debian 部署脚本 — 在无头服务器上安装并运行回测平台
# 使用方式:
#   1. 将项目上传到服务器
#   2. chmod +x deploy.sh && sudo ./deploy.sh
#   3. 修改 /etc/caddy/Caddyfile 中的域名
#   4. 修改 /etc/backtest.env 中的密码和密钥
set -euo pipefail

APP_DIR="/opt/backtest"
SERVICE_USER="backtest"
ENV_FILE="/etc/backtest.env"

echo "=== 1. 安装系统依赖 ==="
apt-get update
apt-get install -y curl git python3 python3-venv caddy ca-certificates gnupg

# 安装 Node.js 20.x（Debian 默认源版本过低）
if ! node --version 2>/dev/null | grep -q "^v2[0-9]"; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# 安装 uv
if ! command -v uv &>/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi

echo "=== 2. 创建服务用户 ==="
if ! id "$SERVICE_USER" &>/dev/null; then
    useradd -r -m -s /usr/sbin/nologin "$SERVICE_USER"
fi

echo "=== 3. 部署应用代码 ==="
mkdir -p "$APP_DIR"
cp -r server-py "$APP_DIR/"
cp -r client "$APP_DIR/"

echo "=== 4. 构建前端 ==="
cd "$APP_DIR/client"
npm ci
npm run build

echo "=== 5. 安装 Python 依赖 ==="
cd "$APP_DIR/server-py"
uv sync --frozen --no-dev 2>/dev/null || uv sync --no-dev

echo "=== 6. 创建环境变量文件 ==="
if [ ! -f "$ENV_FILE" ]; then
    JWT_SECRET=$(openssl rand -hex 32)
    cat > "$ENV_FILE" << EOF
JWT_SECRET=$JWT_SECRET
ALLOWED_ORIGINS=https://your-domain.com
DB_PATH=$APP_DIR/data/backtest.db
EOF
    chmod 600 "$ENV_FILE"
    echo "!! 请修改 $ENV_FILE 中的域名 !!"
    echo "!! 默认管理员: admin / admin123（首次登录强制修改）!!"
fi

mkdir -p "$APP_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "=== 7. 创建 systemd 服务 ==="
cat > /etc/systemd/system/backtest.service << EOF
[Unit]
Description=Backtest Platform (FastAPI)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/server-py
EnvironmentFile=$ENV_FILE
ExecStart=$(which uv) run uvicorn app:app --host 127.0.0.1 --port 4000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "=== 8. 配置 Caddy 反代 ==="
cat > /etc/caddy/Caddyfile << 'EOF'
# 替换 your-domain.com 为实际域名（Caddy 自动 HTTPS）
# 无域名时用 :80 替代
your-domain.com {
    reverse_proxy 127.0.0.1:4000
}
EOF

echo "=== 9. 启动服务 ==="
systemctl daemon-reload
systemctl enable --now backtest
systemctl restart caddy

echo ""
echo "=== 部署完成 ==="
echo "后端服务: systemctl status backtest"
echo "反向代理: systemctl status caddy"
echo "环境配置: $ENV_FILE"
echo ""
echo "!! 必须操作 !!"
echo "1. 修改 /etc/caddy/Caddyfile 中的域名"
echo "2. systemctl restart backtest && systemctl restart caddy"
echo "3. 首次登录默认管理员 admin / admin123，系统强制修改用户名和密码"
