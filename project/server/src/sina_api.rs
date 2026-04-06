// sina_api.rs — 新浪财经 HTTP API 历史数据拉取
//
// 数据源:
//   1. getKLineData  — 最近 1023 个节点 (快，但时间范围有限)
//   2. vMS_MarketHistory — 按季度分页，可回溯到上市首日 (慢，需要多次请求)
//
// 流程: 先用方法1拿近期数据，如果用户请求的 start 早于方法1覆盖的范围，
//       再用方法2按季度往前补数据，最后去重排序裁剪。

use anyhow::Result;
use chrono::NaiveDate;
use encoding_rs::GBK;
use serde::{Deserialize, Serialize};
use tracing::info;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KLinePoint {
    pub day: String,   // YYYY-MM-DD
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// 综合拉取: 自动根据日期范围选择最优策略
pub async fn fetch_history(
    symbol: &str,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Vec<KLinePoint>> {
    let client = build_client();
    let mut all: Vec<KLinePoint> = Vec::new();

    // ── 步骤1: getKLineData 拿最近 1023 天日K ──
    info!("[sina_api] fetching kline for {symbol}");
    let kline = fetch_kline(&client, symbol, 240, 1023).await.unwrap_or_default();
    all.extend(kline);

    // ── 步骤2: 如果需要更早数据，按季度往前拉 ──
    if let Some(s) = start {
        if let Ok(start_date) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            let earliest = all
                .first()
                .and_then(|p| NaiveDate::parse_from_str(&p.day, "%Y-%m-%d").ok());

            let need_more = match earliest {
                Some(e) => start_date < e,
                None => true,
            };

            if need_more {
                let stop_before = earliest.unwrap_or(chrono::Local::now().date_naive());
                info!(
                    "[sina_api] need data before {stop_before}, fetching quarterly pages..."
                );

                let start_y = start_date.year() as u32;
                let end_y = stop_before.year() as u32;

                'outer: for year in start_y..=end_y {
                    for quarter in 1..=4u32 {
                        // 该季度起始月
                        let q_month = (quarter - 1) * 3 + 1;
                        if let Some(q_start) =
                            NaiveDate::from_ymd_opt(year as i32, q_month, 1)
                        {
                            if q_start >= stop_before {
                                break 'outer;
                            }
                        }

                        info!("[sina_api]   {year}年Q{quarter}");
                        match fetch_quarter(&client, symbol, year, quarter).await {
                            Ok(pts) => all.extend(pts),
                            Err(e) => info!("[sina_api]   skip: {e}"),
                        }
                        // 控制频率
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                }
            }
        }
    }

    // ── 去重 + 排序 + 裁剪 ──
    all.sort_by(|a, b| a.day.cmp(&b.day));
    all.dedup_by(|a, b| a.day == b.day);

    if let Some(s) = start {
        all.retain(|p| p.day.as_str() >= s);
    }
    if let Some(e) = end {
        all.retain(|p| p.day.as_str() <= e);
    }

    Ok(all)
}

/// 探测某标的可用日期范围 (用 kline 接口快速获取)
pub async fn probe_range(symbol: &str) -> Result<(String, String, usize)> {
    let client = build_client();
    let data = fetch_kline(&client, symbol, 240, 1023).await?;
    let earliest = data.first().map(|p| p.day.clone()).unwrap_or_default();
    let latest = data.last().map(|p| p.day.clone()).unwrap_or_default();
    Ok((earliest, latest, data.len()))
}

/// 获取股票名称 (实时行情接口)
pub async fn fetch_name(symbol: &str) -> String {
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

/// 方法1: getKLineData
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

/// 方法2: vMS_MarketHistory 按季度爬取
async fn fetch_quarter(
    client: &reqwest::Client,
    symbol: &str,
    year: u32,
    quarter: u32,
) -> Result<Vec<KLinePoint>> {
    let code: String = symbol.chars().filter(|c| c.is_ascii_digit()).collect();
    let url = format!(
        "http://vip.stock.finance.sina.com.cn/corp/go.php/vMS_MarketHistory/\
         stockid/{code}.phtml?year={year}&jidu={quarter}"
    );

    let bytes = client
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn")
        .send()
        .await?
        .bytes()
        .await?;

    let (html, _, _) = GBK.decode(&bytes);
    parse_history_html(&html)
}

/// 从 HTML 表格解析日K数据
fn parse_history_html(html: &str) -> Result<Vec<KLinePoint>> {
    let mut points = Vec::new();

    // 简单状态机: 找 <tr> 中连续的 <td> 内容
    // 表头: 日期 | 开盘价 | 最高价 | 收盘价 | 最低价 | 成交量 | 成交金额
    let mut in_row = false;
    let mut cells: Vec<String> = Vec::new();

    for line in html.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<tr") {
            in_row = true;
            cells.clear();
        }
        if trimmed.contains("</tr>") {
            if cells.len() >= 7 {
                // cells[0]=日期 [1]=开盘 [2]=最高 [3]=收盘 [4]=最低 [5]=成交量 [6]=成交额
                let day = extract_text(&cells[0]);
                if day.len() == 10 && day.contains('-') {
                    let open = extract_text(&cells[1]).parse().unwrap_or(0.0);
                    let high = extract_text(&cells[2]).parse().unwrap_or(0.0);
                    let close = extract_text(&cells[3]).parse().unwrap_or(0.0);
                    let low = extract_text(&cells[4]).parse().unwrap_or(0.0);
                    let vol_str = extract_text(&cells[5]).replace(',', "");
                    let volume = vol_str.parse().unwrap_or(0.0);
                    points.push(KLinePoint { day, open, high, low, close, volume });
                }
            }
            in_row = false;
        }
        if in_row && trimmed.starts_with("<td") {
            cells.push(trimmed.to_string());
        }
    }

    points.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(points)
}

/// 从 HTML 标签中提取纯文本
fn extract_text(html_cell: &str) -> String {
    let mut result = String::new();
    let mut in_tag = false;
    for ch in html_cell.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result.trim().to_string()
}
