# ── Stage 1: Build Rust backend ──
FROM rust:1.78-slim AS rust-build
WORKDIR /build
COPY server/ ./
RUN cargo build --release

# ── Stage 2: Build React frontend ──
FROM node:20-alpine AS node-build
WORKDIR /build
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN npm run build

# ── Stage 3: Runtime ──
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust-build /build/target/release/backtest-server .
COPY --from=node-build /build/dist ./static
EXPOSE 4000
CMD ["./backtest-server", "--static-dir", "./static", "--port", "4000"]
