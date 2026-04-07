// Stochastic RSI 策略
// 买入：触碰0后，K和D同时>10且方向一致向上
// 卖出：触及95后，K和D方向一致向下

import { stochRsi } from "./indicators";

export const STOCH_RSI_STRATS = {
  stoch_rsi: {
    name: "StochRSI触0共振买触95共振卖",
    color: "#a855f7",
    fn: (c) => {
      const { K, D } = stochRsi(c), s = Array(c.length).fill(0);
      let touched0 = false, touched95 = false;
      for (let i = 1; i < c.length; i++) {
        if (K[i] == null || D[i] == null || K[i - 1] == null || D[i - 1] == null) continue;

        if (K[i] <= 0 || K[i - 1] <= 0) touched0 = true;
        if (K[i] >= 95 || K[i - 1] >= 95) touched95 = true;

        const kUp = K[i] > K[i - 1];
        const dUp = D[i] > D[i - 1];
        const kDown = K[i] < K[i - 1];
        const dDown = D[i] < D[i - 1];

        // 触碰0后，K和D同时>10，方向一致向上
        if (touched0 && K[i] > 10 && D[i] > 10 && kUp && dUp) {
          s[i] = 1;
          touched0 = false;
        }
        // 触及95后，K和D方向一致向下
        else if (touched95 && kDown && dDown) {
          s[i] = -1;
          touched95 = false;
        }
      }
      return s;
    },
  },
};
