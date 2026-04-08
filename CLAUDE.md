## 远程部署待解决问题

### 安全
1. **CORS 全开放** — `app.py` `allow_origins=["*"]`，部署时需限制为实际域名
2. **无认证/授权** — 所有 API 端点公开，`POST /api/presets` 可被任何人调用覆盖预设列表
3. **无速率限制** — akshare 线程锁串行执行，少量恶意并发即可阻塞服务
4. **Host 绑定 0.0.0.0** — `app.py` uvicorn 监听所有网络接口，需改为反向代理 + 127.0.0.1

### 部署
5. **Dockerfile 失效** — 仍引用旧 Rust 架构（`server/` + `cargo build`），需重写为 Python FastAPI 镜像
6. **Sina fallback 正则解析** — `App.jsx` 用字符串替换解析 Sina 非标准 JSON，格式变化时静默失败
