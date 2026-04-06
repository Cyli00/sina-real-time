mod csv_reader;
mod sina_api;

use axum::{extract::Query, extract::State, http::StatusCode, response::Json, routing::get, Router};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tracing::info;

// ── 配置 ──

#[derive(Parser, Clone)]
#[command(name = "backtest-server", version)]
struct Cli {
    /// sina-real-time CSV 输出目录 (留空则不使用实时数据)
    #[arg(long, default_value = "")]
    csv_dir: String,

    /// 前端静态文件目录
    #[arg(long, default_value = "../client/dist")]
    static_dir: String,

    /// 监听端口
    #[arg(short, long, default_value_t = 4000)]
    port: u16,
}

#[derive(Clone)]
struct AppState {
    csv_dir: Option<PathBuf>,
}

// ── API 结构体 ──

#[derive(Serialize)]
struct KLineResponse {
    symbol: String,
    name: String,
    data: Vec<sina_api::KLinePoint>,
    source: String,
    earliest_date: String,
    latest_date: String,
    total_points: usize,
}

#[derive(Serialize)]
struct RangeResponse {
    symbol: String,
    name: String,
    earliest_date: String,
    latest_date: String,
    kline_points: usize,
    csv_available: bool,
}

#[derive(Deserialize)]
struct KLineQuery {
    symbol: String,
    start: Option<String>,
    end: Option<String>,
}

#[derive(Deserialize)]
struct SymbolQuery {
    symbol: String,
}

// ── 路由处理 ──

/// GET /api/kline?symbol=sz399006&start=2015-01-01&end=2025-12-31
///
/// 数据优先级:
///   1. Sina HTTP API (历史K线，覆盖到约4年前)
///   2. sina-real-time CSV (如果配置了目录，补充最新实时数据)
///   3. 按季度爬取 (如果 start 早于方法1的覆盖范围)
async fn handle_kline(
    State(state): State<Arc<AppState>>,
    Query(params): Query<KLineQuery>,
) -> Result<Json<KLineResponse>, StatusCode> {
    let symbol = &params.symbol;

    // 并行获取: 名称 + 历史数据
    let name_fut = sina_api::fetch_name(symbol);
    let hist_fut = sina_api::fetch_history(
        symbol,
        params.start.as_deref(),
        params.end.as_deref(),
    );

    let (name, hist_result) = tokio::join!(name_fut, hist_fut);
    let mut data = hist_result.map_err(|e| {
        tracing::error!("fetch_history failed: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    let mut source = "sina_http".to_string();

    // 合并 CSV 实时数据
    if let Some(ref csv_dir) = state.csv_dir {
        match csv_reader::read_csv_dir(
            csv_dir,
            symbol,
            params.start.as_deref(),
            params.end.as_deref(),
        ) {
            Ok(csv_points) if !csv_points.is_empty() => {
                info!("Merging {} CSV candles for {}", csv_points.len(), symbol);
                source = "sina_http+csv".to_string();

                // CSV 数据覆盖 HTTP 数据中相同日期的记录 (实时更准确)
                let http_latest = data.last().map(|p| p.day.clone()).unwrap_or_default();
                for pt in csv_points {
                    if pt.day.as_str() > http_latest.as_str() {
                        data.push(pt);
                    }
                }
                data.sort_by(|a, b| a.day.cmp(&b.day));
                data.dedup_by(|a, b| a.day == b.day);
            }
            Ok(_) => {}
            Err(e) => info!("CSV read warning: {e}"),
        }
    }

    let total_points = data.len();
    let earliest = data.first().map(|p| p.day.clone()).unwrap_or_default();
    let latest = data.last().map(|p| p.day.clone()).unwrap_or_default();

    Ok(Json(KLineResponse {
        symbol: symbol.clone(),
        name,
        data,
        source,
        earliest_date: earliest,
        latest_date: latest,
        total_points,
    }))
}

/// GET /api/range?symbol=sz399006
/// 快速探测可用日期范围 (不拉取完整数据)
async fn handle_range(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SymbolQuery>,
) -> Result<Json<RangeResponse>, StatusCode> {
    let symbol = &params.symbol;

    let name_fut = sina_api::fetch_name(symbol);
    let range_fut = sina_api::probe_range(symbol);

    let (name, range_result) = tokio::join!(name_fut, range_fut);
    let (earliest, latest, kline_points) = range_result.unwrap_or_else(|_| {
        ("2010-01-01".into(), "2026-04-06".into(), 0)
    });

    let csv_available = state
        .csv_dir
        .as_ref()
        .map(|d| d.exists())
        .unwrap_or(false);

    Ok(Json(RangeResponse {
        symbol: symbol.clone(),
        name,
        earliest_date: earliest,
        latest_date: latest,
        kline_points,
        csv_available,
    }))
}

async fn handle_health() -> &'static str {
    "OK"
}

// ── 启动 ──

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backtest_server=info".into()),
        )
        .init();

    let cli = Cli::parse();

    let csv_dir = if cli.csv_dir.is_empty() {
        None
    } else {
        let p = PathBuf::from(&cli.csv_dir);
        info!("CSV directory: {:?}", p);
        Some(p)
    };

    let state = Arc::new(AppState { csv_dir });

    let app = Router::new()
        .route("/api/kline", get(handle_kline))
        .route("/api/range", get(handle_range))
        .route("/api/health", get(handle_health))
        .fallback_service(
            ServeDir::new(&cli.static_dir).append_index_html_on_directories(true),
        )
        .layer(CorsLayer::very_permissive())
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], cli.port));

    println!();
    println!("  ┌─────────────────────────────────────────────┐");
    println!("  │  策略回测平台 · Backtest Engine              │");
    println!("  │  http://localhost:{}                       │", cli.port);
    println!("  │                                             │");
    println!("  │  GET /api/kline?symbol=sz399006             │");
    println!("  │      &start=2015-01-01&end=2026-04-06       │");
    println!("  │  GET /api/range?symbol=sz399006             │");
    if cli.csv_dir.is_empty() {
        println!("  │                                             │");
        println!("  │  ⚠ CSV 未配置 (--csv-dir path/to/data)      │");
    } else {
        println!("  │  CSV: {}  │", cli.csv_dir);
    }
    println!("  └─────────────────────────────────────────────┘");
    println!();

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
