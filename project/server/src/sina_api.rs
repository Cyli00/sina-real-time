// sina_api.rs — 新浪财经 HTTP API 历史数据拉取
//
// 通过 getKLineData 接口的 datalen 参数控制偏移窗口，
// 多次请求不同 datalen 值并合并，可覆盖上市至今全部日K数据。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use tokio::sync::RwLock;
use tracing::info;

// 内存缓存：symbol → (data, 缓存时间)
static KLINE_CACHE: LazyLock<RwLock<HashMap<String, (Vec<KLinePoint>, std::time::Instant)>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

const CACHE_TTL_SECS: u64 = 600; // 10 分钟

/// 带缓存的全量日K拉取（datalen=10000 覆盖上市至今）
async fn fetch_full_cached(symbol: &str) -> Vec<KLinePoint> {
    let key = symbol.to_string();

    // 读缓存
    {
        let cache = KLINE_CACHE.read().await;
        if let Some((data, ts)) = cache.get(&key) {
            if ts.elapsed().as_secs() < CACHE_TTL_SECS {
                return data.clone();
            }
        }
    }

    // 缓存未命中，请求新浪
    info!("[sina_api] cache miss for {symbol}, fetching full kline");
    let client = build_client();
    let mut data = fetch_kline(&client, symbol, 240, 10000).await.unwrap_or_default();
    data.sort_by(|a, b| a.day.cmp(&b.day));
    data.dedup_by(|a, b| a.day == b.day);

    // 写缓存
    {
        let mut cache = KLINE_CACHE.write().await;
        cache.insert(key, (data.clone(), std::time::Instant::now()));
    }

    data
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KLinePoint {
    pub day: String,   // YYYY-MM-DD
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// 综合拉取: 从缓存获取全量数据后按日期裁剪
pub async fn fetch_history(
    symbol: &str,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Vec<KLinePoint>> {
    let mut all = fetch_full_cached(symbol).await;

    if let Some(s) = start {
        all.retain(|p| p.day.as_str() >= s);
    }
    if let Some(e) = end {
        all.retain(|p| p.day.as_str() <= e);
    }

    info!("[sina_api] {} points for {symbol} (after filter)", all.len());
    Ok(all)
}

/// 探测某标的可用日期范围（复用缓存，无额外请求）
pub async fn probe_range(symbol: &str) -> Result<(String, String, usize)> {
    let data = fetch_full_cached(symbol).await;
    let earliest = data.first().map(|p| p.day.clone()).unwrap_or("2010-01-01".into());
    let latest = data.last().map(|p| p.day.clone()).unwrap_or_default();
    Ok((earliest, latest, data.len()))
}

/// 获取股票名称 (实时行情接口)
pub async fn fetch_name(symbol: &str) -> String {
    use encoding_rs::GBK;
    let url = format!("http://hq.sinajs.cn/list={symbol}");
    let client = build_client();
    let Ok(resp) = client
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn")
        .send()
        .await
    else {
        return symbol.to_string();
    };
    let Ok(bytes) = resp.bytes().await else {
        return symbol.to_string();
    };
    let (text, _, _) = GBK.decode(&bytes);
    // var hq_str_sh000001="上证指数,3094,...";
    text.find('"')
        .and_then(|s| {
            let rest = &text[s + 1..];
            rest.find('"').map(|e| &rest[..e])
        })
        .and_then(|data| data.split(',').next())
        .map(|n| n.trim().to_string())
        .unwrap_or_else(|| symbol.to_string())
}

// ── 内部实现 ──

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; backtest/1.0)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap()
}

/// getKLineData — datalen 控制偏移窗口
async fn fetch_kline(
    client: &reqwest::Client,
    symbol: &str,
    scale: u32,
    datalen: u32,
) -> Result<Vec<KLinePoint>> {
    let url = format!(
        "http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/\
         CN_MarketData.getKLineData?symbol={symbol}&scale={scale}&ma=no&datalen={datalen}"
    );
    let text = client
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn")
        .send()
        .await?
        .text()
        .await?;

    // 新浪返回的 key 没有引号: {day:"...",open:"...",...}
    let fixed = text
        .replace("day:", "\"day\":")
        .replace("open:", "\"open\":")
        .replace("high:", "\"high\":")
        .replace("low:", "\"low\":")
        .replace("close:", "\"close\":")
        .replace("volume:", "\"volume\":");

    #[derive(Deserialize)]
    struct Raw {
        day: String,
        open: String,
        high: String,
        low: String,
        close: String,
        volume: String,
    }

    let raws: Vec<Raw> = serde_json::from_str(&fixed).unwrap_or_default();
    Ok(raws
        .into_iter()
        .map(|r| KLinePoint {
            day: r.day.chars().take(10).collect(),
            open: r.open.parse().unwrap_or(0.0),
            high: r.high.parse().unwrap_or(0.0),
            low: r.low.parse().unwrap_or(0.0),
            close: r.close.parse().unwrap_or(0.0),
            volume: r.volume.parse().unwrap_or(0.0),
        })
        .collect())
}
