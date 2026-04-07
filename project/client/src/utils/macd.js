// MACD 金叉死叉策略

import { macd } from "./indicators";

export const MACD_STRATS = {
  macd_x: {
    name: "MACD金叉买死叉卖",
    color: "#6366f1",
    fn: (c) => {
      const { dif, dea } = macd(c), s = Array(c.length).fill(0);
      for (let i = 1; i < c.length; i++) {
        if (dif[i] != null && dea[i] != null && dif[i - 1] != null && dea[i - 1] != null) {
          if (dif[i] > dea[i] && dif[i - 1] <= dea[i - 1]) s[i] = 1;
          else if (dif[i] < dea[i] && dif[i - 1] >= dea[i - 1]) s[i] = -1;
        }
      }
      return s;
    },
  },
};
