import { stochRsi } from "./indicators";

// 经典策略：超卖区 K 上穿 D（金叉）买入，超买区 K 下穿 D（死叉）卖出
function stochRsiClassic(c) {
  const { K, D } = stochRsi(c), s = Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    if (K[i] == null || D[i] == null || K[i - 1] == null || D[i - 1] == null) continue;
    if (K[i - 1] <= D[i - 1] && K[i] > D[i] && K[i] < 20) s[i] = 1;
    else if (K[i - 1] >= D[i - 1] && K[i] < D[i] && K[i] > 80) s[i] = -1;
  }
  return s;
}

// 区域突破：K 从超卖区上穿 20 买入，从超买区下穿 80 卖出
function stochRsiZone(c) {
  const { K, D } = stochRsi(c), s = Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    if (K[i] == null || K[i - 1] == null) continue;
    if (K[i - 1] < 20 && K[i] >= 20) s[i] = 1;
    else if (K[i - 1] > 80 && K[i] <= 80) s[i] = -1;
  }
  return s;
}

// 极端共振：K/D 同向上穿 10 买入，K/D 同向下穿 90 卖出
function stochRsiExtreme(c) {
  const { K, D } = stochRsi(c), s = Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    if (K[i] == null || D[i] == null || K[i - 1] == null || D[i - 1] == null) continue;
    const kUp = K[i] > K[i - 1], dUp = D[i] > D[i - 1];
    const kDown = K[i] < K[i - 1], dDown = D[i] < D[i - 1];
    if (K[i - 1] < 10 && K[i] >= 10 && kUp && dUp) s[i] = 1;
    else if (K[i - 1] > 90 && K[i] <= 90 && kDown && dDown) s[i] = -1;
  }
  return s;
}

export const STOCH_RSI_STRATS = {
  stoch_rsi_classic: { name: "StochRSI金叉死叉(20/80)", color: "#a855f7", fn: stochRsiClassic },
  stoch_rsi_zone:    { name: "StochRSI区域突破(20/80)", color: "#8b5cf6", fn: stochRsiZone },
  stoch_rsi_extreme: { name: "StochRSI极端共振(10/90)", color: "#7c3aed", fn: stochRsiExtreme },
};
