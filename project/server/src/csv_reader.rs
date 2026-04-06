// csv_reader.rs — 读取 sina-real-time 采集的 CSV，聚合为日 K 线
//
// sina-real-time CSV 格式:
//   received_at,code,fields
//   2026-02-26T14:33:46.037,sh600519,"贵州茅台,昨收,今开,当前价,最高,最低,买1,卖1,成交量,成交额,..."
//
// fields 字段顺序 (逗号分隔):
//   [0]  名称
//   [1]  昨收
//   [2]  今开
//   [3]  当前价
//   [4]  最高
//   [5]  最低
//   [6]  买一价
//   [7]  卖一价
//   [8]  成交量(股)
//   [9]  成交额(元)
//   ...  买卖5档
//   [-3] 日期 (YYYY-MM-DD)
//   [-2] 时间 (HH:MM:SS)
//   [-1] 状态

use crate::sina_api::KLinePoint;
use anyhow::Result;
use std::collections::BTreeMap;
use std::path::Path;
use tracing::info;

/// 一个交易日的聚合状态
struct DayAgg {
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    first_time: String,  // 用于确定开盘价 (最早一笔)
}

/// 扫描指定目录下所有 data_YYYY-MM-DD.csv，聚合为日 K 线
pub fn read_csv_dir(
    dir: &Path,
    symbol: &str,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Vec<KLinePoint>> {
    let mut day_map: BTreeMap<String, DayAgg> = BTreeMap::new();

    if !dir.exists() {
        info!("[csv_reader] directory {:?} not found, skipping", dir);
        return Ok(vec![]);
    }

    // 收集所有匹配的 CSV 文件
    let mut csv_files: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("data_") && name.ends_with(".csv")
        })
        .collect();

    csv_files.sort_by_key(|e| e.file_name());

    // 按文件名过滤日期范围 (data_YYYY-MM-DD.csv)
    let csv_files: Vec<_> = csv_files
        .into_iter()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // 提取日期部分
            let date = &name[5..15]; // "data_" = 5 chars, date = 10 chars
            if date.len() != 10 {
                return false;
            }
            if let Some(s) = start {
                if date < s {
                    return false;
                }
            }
            if let Some(e) = end {
                if date > e {
                    return false;
                }
            }
            true
        })
        .collect();

    info!(
        "[csv_reader] scanning {} CSV files for symbol {}",
        csv_files.len(),
        symbol
    );

    for entry in csv_files {
        let path = entry.path();
        if let Err(e) = process_csv_file(&path, symbol, &mut day_map) {
            info!("[csv_reader] skip {:?}: {}", path, e);
        }
    }

    // 转换为 KLinePoint 列表
    let points: Vec<KLinePoint> = day_map
        .into_iter()
        .map(|(day, agg)| KLinePoint {
            day,
            open: agg.open,
            high: agg.high,
            low: agg.low,
            close: agg.close,
            volume: agg.volume,
        })
        .collect();

    info!("[csv_reader] aggregated {} daily candles", points.len());
    Ok(points)
}

fn process_csv_file(
    path: &Path,
    target_symbol: &str,
    day_map: &mut BTreeMap<String, DayAgg>,
) -> Result<()> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_path(path)?;

    for record in rdr.records() {
        let record = record?;

        // CSV 列: received_at, code, fields
        let code = record.get(1).unwrap_or("").trim();
        if code != target_symbol {
            continue;
        }

        let received_at = record.get(0).unwrap_or("").trim();
        let fields_raw = record.get(2).unwrap_or("").trim();

        // 去掉可能的引号包裹
        let fields = fields_raw.trim_matches('"');
        let parts: Vec<&str> = fields.split(',').collect();

        if parts.len() < 10 {
            continue;
        }

        // 解析关键字段
        let current_price: f64 = parts[3].parse().unwrap_or(0.0);
        let day_high: f64 = parts[4].parse().unwrap_or(0.0);
        let day_low: f64 = parts[5].parse().unwrap_or(0.0);
        let today_open: f64 = parts[2].parse().unwrap_or(0.0);
        let volume: f64 = parts[8].parse().unwrap_or(0.0);

        if current_price <= 0.0 {
            continue;
        }

        // 提取日期: 优先用 fields 末尾的日期字段，否则用 received_at
        let day = if parts.len() >= 3 {
            // 倒数第3个字段应该是日期
            let date_field = parts[parts.len() - 3].trim();
            if date_field.len() == 10 && date_field.contains('-') {
                date_field.to_string()
            } else {
                // 从 received_at 截取
                received_at.chars().take(10).collect()
            }
        } else {
            received_at.chars().take(10).collect()
        };

        if day.len() != 10 {
            continue;
        }

        let time_str = received_at.to_string();

        // 更新当日聚合
        let agg = day_map.entry(day).or_insert(DayAgg {
            open: today_open,
            high: day_high,
            low: day_low,
            close: current_price,
            volume,
            first_time: time_str.clone(),
        });

        // 用交易所报告的日内最高最低 (比逐笔聚合更准确)
        if day_high > agg.high {
            agg.high = day_high;
        }
        if day_low > 0.0 && (day_low < agg.low || agg.low <= 0.0) {
            agg.low = day_low;
        }

        // 每次更新收盘价为最新价
        agg.close = current_price;
        // 成交量取最大值 (交易所累计值)
        if volume > agg.volume {
            agg.volume = volume;
        }
        // 开盘价用当日第一笔
        if time_str < agg.first_time {
            agg.first_time = time_str;
            agg.open = today_open;
        }
    }

    Ok(())
}
