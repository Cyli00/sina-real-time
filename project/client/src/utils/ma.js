// 均线策略：向上向下 + 站上跌破

import { sma } from "./indicators";

// 均线拐头向上买 / 向下卖
function maTrend(c, n) {
  const m = sma(c, n), s = Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    if (m[i] != null && m[i - 1] != null) {
      if (m[i] > m[i - 1] && m[i - 1] <= (m[i - 2] ?? m[i - 1]) && c[i] > m[i]) s[i] = 1;
      else if (m[i] < m[i - 1] && c[i] < m[i]) s[i] = -1;
    }
  }
  return s;
}

// 价格站上均线买 / 跌破卖
function maBreak(c, n) {
  const m = sma(c, n), s = Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    if (m[i] != null) {
      if (c[i] > m[i] && c[i - 1] <= (m[i - 1] ?? c[i - 1])) s[i] = 1;
      else if (c[i] < m[i] && c[i - 1] >= (m[i - 1] ?? c[i - 1])) s[i] = -1;
    }
  }
  return s;
}

export const MA_STRATS = {
  ma5:        { name: "5日均线向上买向下卖",    color: "#8b5cf6", fn: (c) => maTrend(c, 5) },
  ma5_break:  { name: "站上5日均线买跌破卖",    color: "#22c55e", fn: (c) => maBreak(c, 5) },
  ma10:       { name: "10日均线向上买向下卖",   color: "#3b82f6", fn: (c) => maTrend(c, 10) },
  ma10_break: { name: "站上10日均线买跌破卖",   color: "#059669", fn: (c) => maBreak(c, 10) },
  ma20:       { name: "20日均线向上买向下卖",   color: "#f97316", fn: (c) => maTrend(c, 20) },
  ma20_break: { name: "站上20日均线买跌破卖",   color: "#d97706", fn: (c) => maBreak(c, 20) },
  ma30:       { name: "30日均线向上买向下卖",   color: "#eab308", fn: (c) => maTrend(c, 30) },
  ma30_break: { name: "站上30日均线买跌破卖",   color: "#a16207", fn: (c) => maBreak(c, 30) },
  ma60:       { name: "60日均线向上买向下卖",   color: "#ec4899", fn: (c) => maTrend(c, 60) },
  ma60_break: { name: "站上60日均线买跌破卖",   color: "#be185d", fn: (c) => maBreak(c, 60) },
};
