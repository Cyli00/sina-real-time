// 技术指标

export const sma = (c, n) => {
  const r = Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += c[j];
    r[i] = s / n;
  }
  return r;
};

export const ema = (c, n) => {
  if (c.length < n) return Array(c.length).fill(null);
  const r = Array(c.length).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += c[i];
  r[n - 1] = sum / n; // SMA 种子
  const k = 2 / (n + 1);
  for (let i = n; i < c.length; i++) r[i] = c[i] * k + r[i - 1] * (1 - k);
  return r;
};

export function macd(c) {
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const dif = c.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const vd = dif.filter((v) => v != null);
  const deaR = ema(vd, 9);
  const dea = Array(c.length).fill(null);
  let idx = 0;
  for (let i = 0; i < dif.length; i++) if (dif[i] != null) dea[i] = deaR[idx++] ?? null;
  return { dif, dea };
}

export function stochRsi(C, rsiN = 14, stochN = 14, kSmooth = 3, dSmooth = 3) {
  // RSI
  const rsi = Array(C.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= rsiN; i++) {
    const d = C[i] - C[i - 1];
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= rsiN; avgL /= rsiN;
  rsi[rsiN] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = rsiN + 1; i < C.length; i++) {
    const d = C[i] - C[i - 1], g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (rsiN - 1) + g) / rsiN;
    avgL = (avgL * (rsiN - 1) + l) / rsiN;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  // Stochastic on RSI
  const raw = Array(C.length).fill(null);
  for (let i = rsiN + stochN - 1; i < C.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - stochN + 1; j <= i; j++) {
      if (rsi[j] > hi) hi = rsi[j];
      if (rsi[j] < lo) lo = rsi[j];
    }
    raw[i] = hi === lo ? 50 : ((rsi[i] - lo) / (hi - lo)) * 100;
  }
  // K = SMA(raw, kSmooth), D = SMA(K, dSmooth)
  const K = sma(raw.map((v) => v ?? 0), kSmooth).map((v, i) => (raw[i] != null ? v : null));
  const D = sma(K.map((v) => v ?? 0), dSmooth).map((v, i) => (K[i] != null ? v : null));
  return { K, D };
}
