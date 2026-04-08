## 远程部署待解决问题

### 安全
1. **CORS 全开放** — `app.py` `allow_origins=["*"]`，部署时需限制为实际域名
2. **无速率限制** — akshare 线程锁串行执行，少量恶意并发即可阻塞服务

### 部署
3. **Dockerfile 失效** — 仍引用旧 Rust 架构（`server/` + `cargo build`），需重写为 Python FastAPI 镜像

### 部署架构
- 后端绑定 `127.0.0.1:4000`，仅本机可访问
- 前端通过 nginx/caddy 反代对外暴露，反代同时转发 `/api` 到后端
