# ── Stage 1: 构建前端 ──
FROM node:20-slim AS frontend
WORKDIR /build
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2: Python 后端 ──
FROM python:3.12-slim
WORKDIR /app

# 安装 uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 安装 Python 依赖
COPY server-py/pyproject.toml server-py/uv.lock ./
RUN uv sync --frozen --no-dev

# 复制后端代码
COPY server-py/*.py ./

# 复制前端构建产物（后端 StaticFiles 需要相对路径 ../client/dist）
RUN mkdir -p /app/client
COPY --from=frontend /build/dist /app/client/dist

# 数据持久化目录
RUN mkdir -p /app/data

# 默认环境变量
ENV ADMIN_USER=admin
ENV ADMIN_PASS=changeme
ENV JWT_SECRET=""
ENV ALLOWED_ORIGINS=""
ENV DB_PATH=/app/data/backtest.db
ENV DIST_DIR=/app/client/dist

EXPOSE 4000

CMD ["uv", "run", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4000"]
