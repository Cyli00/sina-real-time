import { useState, useEffect, useCallback, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

/* ══════════════════════════════════════════
   API Layer
   - 优先通过 Rust 后端 /api/*
   - 后端不可用时 fallback 到直连新浪 + demo
   ══════════════════════════════════════════ */

async function apiFetchKLine(symbol, start, end) {
  const p = new URLSearchParams({ symbol });
  if (start) p.set("start", start);
  if (end) p.set("end", end);
  try {
    const r = await fetch(`/api/kline?${p}`);
    if (!r.ok) throw new Error(r.status);
    return await r.json();                       // { symbol, name, data[], source, earliest_date, latest_date }
  } catch { return null; }
}

async function apiFetchRange(symbol) {
  try {
    const r = await fetch(`/api/range?symbol=${symbol}`);
    if (!r.ok) throw new Error(r.status);
    return await r.json();                       // { earliest_date, latest_date, kline_points, csv_available }
  } catch { return null; }
}

async function fallbackSina(symbol) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=1023`;
  try {
    const t = await (await fetch(url)).text();
    const fixed = t.replace(/day:/g,'"day":').replace(/open:/g,'"open":').replace(/high:/g,'"high":').replace(/low:/g,'"low":').replace(/close:/g,'"close":').replace(/volume:/g,'"volume":').replace(/'/g,'"');
    return JSON.parse(fixed);
  } catch { return null; }
}

function generateDemo(symbol, start, end) {
  const seeds = {
    "sz399006":{s:800,v:.022,n:"创业板指"},"sh000001":{s:2800,v:.014,n:"上证指数"},
    "sh000300":{s:3500,v:.015,n:"沪深300"},"sz000001":{s:12,v:.025,n:"平安银行"},
    "sh600519":{s:200,v:.018,n:"贵州茅台"},"sz000858":{s:30,v:.025,n:"五粮液"},
    "sh601318":{s:40,v:.02,n:"中国平安"},"sh600036":{s:25,v:.018,n:"招商银行"},
  };
  const c = seeds[symbol] || {s:100,v:.02,n:symbol};
  let p = c.s; const data = [];
  const d = new Date(start || "2010-06-01"), endD = new Date(end || new Date());
  while (d <= endD) {
    if (d.getDay()%6!==0) {
      p = Math.max(p*(1+.00015+c.v*(Math.random()*2-1)), c.s*.2);
      const h=p*(1+Math.random()*.015), l=p*(1-Math.random()*.015);
      data.push({day:d.toISOString().slice(0,10),open:(l+Math.random()*(h-l)).toFixed(2),high:h.toFixed(2),low:l.toFixed(2),close:p.toFixed(2),volume:String(~~(Math.random()*5e8+1e8))});
    }
    d.setDate(d.getDate()+1);
  }
  return {data, name:c.n};
}

/* ══════════════════════════════════════════
   Technical Indicators
   ══════════════════════════════════════════ */

const sma = (c,n) => { const r=Array(c.length).fill(null); for(let i=n-1;i<c.length;i++){let s=0;for(let j=i-n+1;j<=i;j++)s+=c[j];r[i]=s/n;} return r; };
const ema = (c,n) => { const r=[...c]; const k=2/(n+1); for(let i=1;i<c.length;i++) r[i]=c[i]*k+r[i-1]*(1-k); return r.map((v,i)=>i>=n-1?v:null); };

function macd(c) {
  const e12=ema(c,12),e26=ema(c,26);
  const dif=c.map((_,i)=>(e12[i]!=null&&e26[i]!=null)?e12[i]-e26[i]:null);
  const vd=dif.filter(v=>v!=null), deaR=ema(vd,9), dea=Array(c.length).fill(null);
  let idx=0; for(let i=0;i<dif.length;i++) if(dif[i]!=null) dea[i]=deaR[idx++]??null;
  return {dif,dea};
}

function kdj(H,L,C,n=9) {
  const len=C.length, K=Array(len).fill(null), D=Array(len).fill(null);
  let pK=50,pD=50;
  for(let i=n-1;i<len;i++){
    let hh=-Infinity,ll=Infinity;
    for(let j=i-n+1;j<=i;j++){if(H[j]>hh)hh=H[j];if(L[j]<ll)ll=L[j];}
    const rsv=hh===ll?50:((C[i]-ll)/(hh-ll))*100;
    const k=(2/3)*pK+(1/3)*rsv, d=(2/3)*pD+(1/3)*k;
    K[i]=k;D[i]=d;pK=k;pD=d;
  }
  return {K,D};
}

function cci(H,L,C,n=14) {
  const r=Array(C.length).fill(null);
  for(let i=n-1;i<C.length;i++){
    let sTP=0; for(let j=i-n+1;j<=i;j++) sTP+=(H[j]+L[j]+C[j])/3;
    const ma=sTP/n; let sd=0;
    for(let j=i-n+1;j<=i;j++) sd+=Math.abs((H[j]+L[j]+C[j])/3-ma);
    const md=sd/n, tp=(H[i]+L[i]+C[i])/3;
    r[i]=md===0?0:(tp-ma)/(0.015*md);
  }
  return r;
}

/* ══════════════════════════════════════════
   Strategies
   ══════════════════════════════════════════ */

const STRATS = {
  buy_hold:  {name:"一直持有",            color:"#78716c", fn:c=>{const s=Array(c.length).fill(0);s[0]=1;return s;}},
  ma5:       {name:"5日均线向上买向下卖",   color:"#8b5cf6", fn:c=>{const m=sma(c,5),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null&&m[i-1]!=null){if(m[i]>m[i-1]&&m[i-1]<=(m[i-2]??m[i-1])&&c[i]>m[i])s[i]=1;else if(m[i]<m[i-1]&&c[i]<m[i])s[i]=-1;}return s;}},
  ma5_break:  {name:"站上5日均线买跌破卖",   color:"#22c55e", fn:c=>{const m=sma(c,5),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null){if(c[i]>m[i]&&c[i-1]<=(m[i-1]??c[i-1]))s[i]=1;else if(c[i]<m[i]&&c[i-1]>=(m[i-1]??c[i-1]))s[i]=-1;}return s;}},
  ma10_break: {name:"站上10日均线买跌破卖", color:"#059669", fn:c=>{const m=sma(c,10),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null){if(c[i]>m[i]&&c[i-1]<=(m[i-1]??c[i-1]))s[i]=1;else if(c[i]<m[i]&&c[i-1]>=(m[i-1]??c[i-1]))s[i]=-1;}return s;}},
  ma20_break: {name:"站上20日均线买跌破卖", color:"#d97706", fn:c=>{const m=sma(c,20),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null){if(c[i]>m[i]&&c[i-1]<=(m[i-1]??c[i-1]))s[i]=1;else if(c[i]<m[i]&&c[i-1]>=(m[i-1]??c[i-1]))s[i]=-1;}return s;}},
  ma30_break: {name:"站上30日均线买跌破卖", color:"#a16207", fn:c=>{const m=sma(c,30),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null){if(c[i]>m[i]&&c[i-1]<=(m[i-1]??c[i-1]))s[i]=1;else if(c[i]<m[i]&&c[i-1]>=(m[i-1]??c[i-1]))s[i]=-1;}return s;}},
  ma60_break: {name:"站上60日均线买跌破卖", color:"#be185d", fn:c=>{const m=sma(c,60),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null){if(c[i]>m[i]&&c[i-1]<=(m[i-1]??c[i-1]))s[i]=1;else if(c[i]<m[i]&&c[i-1]>=(m[i-1]??c[i-1]))s[i]=-1;}return s;}},
  ma10:      {name:"10日均线向上买向下卖",  color:"#3b82f6", fn:c=>{const m=sma(c,10),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null&&m[i-1]!=null){if(m[i]>m[i-1]&&m[i-1]<=(m[i-2]??m[i-1])&&c[i]>m[i])s[i]=1;else if(m[i]<m[i-1]&&c[i]<m[i])s[i]=-1;}return s;}},
  ma20:      {name:"20日均线向上买向下卖",  color:"#f97316", fn:c=>{const m=sma(c,20),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null&&m[i-1]!=null){if(m[i]>m[i-1]&&m[i-1]<=(m[i-2]??m[i-1])&&c[i]>m[i])s[i]=1;else if(m[i]<m[i-1]&&c[i]<m[i])s[i]=-1;}return s;}},
  ma30:      {name:"30日均线向上买向下卖",  color:"#eab308", fn:c=>{const m=sma(c,30),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null&&m[i-1]!=null){if(m[i]>m[i-1]&&m[i-1]<=(m[i-2]??m[i-1])&&c[i]>m[i])s[i]=1;else if(m[i]<m[i-1]&&c[i]<m[i])s[i]=-1;}return s;}},
  ma60:      {name:"60日均线向上买向下卖",  color:"#ec4899", fn:c=>{const m=sma(c,60),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(m[i]!=null&&m[i-1]!=null){if(m[i]>m[i-1]&&m[i-1]<=(m[i-2]??m[i-1])&&c[i]>m[i])s[i]=1;else if(m[i]<m[i-1]&&c[i]<m[i])s[i]=-1;}return s;}},
  macd_x:    {name:"MACD金叉买死叉卖",    color:"#6366f1", fn:c=>{const{dif,dea}=macd(c),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(dif[i]!=null&&dea[i]!=null&&dif[i-1]!=null&&dea[i-1]!=null){if(dif[i]>dea[i]&&dif[i-1]<=dea[i-1])s[i]=1;else if(dif[i]<dea[i]&&dif[i-1]>=dea[i-1])s[i]=-1;}return s;}},
  kdj_x:     {name:"KDJ金叉买死叉卖",     color:"#f43f5e", fn:(c,h,l)=>{const{K,D}=kdj(h,l,c),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(K[i]!=null&&D[i]!=null&&K[i-1]!=null&&D[i-1]!=null){if(K[i]>D[i]&&K[i-1]<=D[i-1])s[i]=1;else if(K[i]<D[i]&&K[i-1]>=D[i-1])s[i]=-1;}return s;}},
  cci_100:   {name:"CCI上100买下100卖",   color:"#14b8a6", fn:(c,h,l)=>{const cc=cci(h,l,c),s=Array(c.length).fill(0);for(let i=1;i<c.length;i++)if(cc[i]!=null&&cc[i-1]!=null){if(cc[i]>100&&cc[i-1]<=100)s[i]=1;else if(cc[i]<-100&&cc[i-1]>=-100)s[i]=-1;}return s;}},
};

/* ══════════════════════════════════════════
   Backtester
   ══════════════════════════════════════════ */

// execMode: "close" = 当日收盘价成交, "nextOpen" = 次日开盘价成交
function backtest(data, stratFn, capital, execMode="close") {
  const C=data.map(d=>+d.close), H=data.map(d=>+d.high), L=data.map(d=>+d.low), O=data.map(d=>+d.open);
  const sig=stratFn(C,H,L);
  let cash=capital, shares=0, trades=0, wins=0, lastBuy=0;
  let pendingBuy=false, pendingSell=false;
  const eq=[];
  for(let i=0;i<data.length;i++){
    // 次日开盘价模式：执行前一天的挂起信号
    if(execMode==="nextOpen"&&i>0){
      const ep=O[i];
      if(pendingBuy){if(cash>0){const n=Math.floor(cash/ep/100)*100;if(n>0){cash-=n*ep;shares=n;lastBuy=ep;trades++;}}pendingBuy=false;}
      else if(pendingSell){if(shares>0){cash+=shares*ep;if(ep>lastBuy)wins++;shares=0;}pendingSell=false;}
    }
    if(execMode==="close"){
      const p=C[i];
      if(sig[i]===1&&cash>0){const n=Math.floor(cash/p/100)*100;if(n>0){cash-=n*p;shares=n;lastBuy=p;trades++;}}
      else if(sig[i]===-1&&shares>0){cash+=shares*p;if(p>lastBuy)wins++;shares=0;}
    } else {
      if(sig[i]===1) pendingBuy=true;
      else if(sig[i]===-1) pendingSell=true;
    }
    eq.push(Math.round((cash+shares*C[i])/10000));
  }
  const fv=cash+shares*C[C.length-1];
  let peak=capital,maxDD=0;
  eq.forEach(v=>{const rv=v*10000;if(rv>peak)peak=rv;const dd=(peak-rv)/peak;if(dd>maxDD)maxDD=dd;});
  return{equity:eq,totalReturn:((fv-capital)/capital*100).toFixed(1),trades,winRate:trades?((wins/Math.ceil(trades))*100).toFixed(1):"0",maxDrawdown:(maxDD*100).toFixed(1),finalValue:Math.round(fv/10000)};
}

/* ══════════════════════════════════════════
   Presets & Helpers
   ══════════════════════════════════════════ */

const DEFAULT_PRESETS = [
  {code:"sh000001",label:"上证指数"},{code:"sz399001",label:"深证成指"},
  {code:"sz399006",label:"创业板指"},{code:"sh000688",label:"科创50"},
  {code:"sh000905",label:"中证500"},{code:"sh000300",label:"沪深300"},
  {code:"sh000015",label:"红利指数"},
];

const fmt = n => Number(n).toLocaleString();

// 标准化股票代码：支持 "000001.SZ" / "600519.SH" / 纯数字 "000001"
function normalizeSymbol(input) {
  const s = input.trim().toLowerCase();
  if (/^(sh|sz)\d{6}$/.test(s)) return s;                      // 已是标准格式
  const dotMatch = s.match(/^(\d{6})\.(sh|sz)$/);              // 000001.sz
  if (dotMatch) return dotMatch[2] + dotMatch[1];
  const pureDigit = s.match(/^(\d{6})$/);                      // 纯6位数字
  if (pureDigit) {
    const code = pureDigit[1];
    return (code[0] === '6' ? 'sh' : 'sz') + code;             // 6开头→sh，其余→sz
  }
  return s;
}

/* ══════════════════════════════════════════
   Main Component
   ══════════════════════════════════════════ */

export default function App() {
  const [presets, setPresets] = useState(DEFAULT_PRESETS);
  const [symbol, setSymbol] = useState("sh000001");
  const [custom, setCustom] = useState("");
  const [capital, setCapital] = useState(100);
  const [selStrats, setSelStrats] = useState(Object.keys(STRATS));

  // 加载预设
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/presets");
        if (r.ok) { const data = await r.json(); if (data.length) setPresets(data); }
      } catch {}
    })();
  }, []);

  const savePresets = async (list) => {
    setPresets(list);
    try {
      const r = await fetch("/api/presets", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(list) });
      if (!r.ok) console.warn("[presets] save failed:", r.status);
    } catch (e) { console.warn("[presets] save error:", e); }
  };

  const addPreset = () => {
    const code = normalizeSymbol(custom);
    if (!code || presets.some(p => p.code === code)) return;
    savePresets([...presets, { code, label: stockName || code }]);
    setCustom("");
  };

  const removePreset = (code) => {
    savePresets(presets.filter(p => p.code !== code));
    if (symbol === code && presets.length > 1) setSymbol(presets.find(p => p.code !== code)?.code || "sh000001");
  };

  // Date range
  const [startDate, setStartDate] = useState("2015-01-01");
  const [endDate, setEndDate]   = useState(new Date().toISOString().slice(0,10));
  const [rangeInfo, setRangeInfo] = useState(null);   // { earliest_date, latest_date, ... }

  const [rawData, setRawData] = useState(null);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stockName, setStockName] = useState("创业板指");
  const [dataSource, setDataSource] = useState("");
  const [execMode, setExecMode] = useState("nextOpen");  // "close" | "nextOpen"
  const [sortCol, setSortCol] = useState("finalValue");
  const [sortAsc, setSortAsc] = useState(false);

  // Probe date range when symbol changes
  const activeSymbol = custom.trim() ? normalizeSymbol(custom) : symbol;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await apiFetchRange(activeSymbol);
      if (cancelled) return;
      if (info) {
        setRangeInfo(info);
        setStockName(info.name || activeSymbol);
        // 自动设置日期范围为最大可用范围
        if (info.earliest_date) setStartDate(info.earliest_date);
        if (info.latest_date) setEndDate(info.latest_date);
      } else {
        setRangeInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [activeSymbol]);

  const toggleStrat = k => setSelStrats(p => p.includes(k) ? p.filter(x=>x!==k) : [...p,k]);

  const run = useCallback(async () => {
    setLoading(true);
    const sym = activeSymbol;
    let data = null, src = "demo", name = stockName;

    // 1. 尝试 Rust 后端
    const apiResp = await apiFetchKLine(sym, startDate, endDate);
    if (apiResp && apiResp.data?.length > 20) {
      data = apiResp.data;
      src = apiResp.source;
      name = apiResp.name;
    }

    // 2. Fallback 直连新浪
    if (!data) {
      const sina = await fallbackSina(sym);
      if (sina && sina.length > 20) {
        data = sina.map(d => ({...d, day: d.day.slice(0,10)}));
        // 手动按日期裁剪
        if (startDate) data = data.filter(d => d.day >= startDate);
        if (endDate) data = data.filter(d => d.day <= endDate);
        src = "sina_direct";
      }
    }

    // 3. Fallback demo
    if (!data || data.length < 20) {
      const demo = generateDemo(sym, startDate, endDate);
      data = demo.data; name = demo.name; src = "demo";
    }

    setRawData(data); setStockName(name); setDataSource(src);

    const cap = capital * 10000;
    const res = {};
    for (const key of selStrats) {
      res[key] = backtest(data, STRATS[key].fn, cap, execMode);
    }
    setResults(res);
    setLoading(false);
  }, [activeSymbol, startDate, endDate, capital, selStrats, stockName, execMode]);

  // Auto-run on mount
  useEffect(() => { run(); }, []);

  const chartData = useMemo(() => {
    if (!rawData || !results) return [];
    return rawData.map((d,i) => {
      const pt = { date: d.day };
      for (const k of selStrats) if (results[k]) pt[k] = results[k].equity[i];
      return pt;
    });
  }, [rawData, results, selStrats]);

  const sorted = useMemo(() => {
    if (!results) return [];
    const a = Object.entries(results).map(([k,r])=>({key:k,...r}));
    a.sort((x,y)=>{const va=+x[sortCol]||0,vb=+y[sortCol]||0;return sortAsc?va-vb:vb-va;});
    return a;
  }, [results, sortCol, sortAsc]);

  const handleSort = c => { if(sortCol===c) setSortAsc(!sortAsc); else {setSortCol(c);setSortAsc(false);} };

  /* ── RENDER ── */

  const srcBadge = {
    "akshare_qfq":   {bg:"rgba(34,197,94,.15)",  c:"#22c55e", b:"rgba(34,197,94,.3)",  t:"akshare · 前复权"},
    "akshare_index":  {bg:"rgba(99,102,241,.15)", c:"#818cf8", b:"rgba(99,102,241,.3)", t:"akshare · 指数"},
    "sina_direct":   {bg:"rgba(251,191,36,.15)", c:"#fbbf24", b:"rgba(251,191,36,.3)", t:"直连新浪 (无后端)"},
    "demo":          {bg:"rgba(251,191,36,.15)", c:"#fbbf24", b:"rgba(251,191,36,.3)", t:"DEMO DATA · 模拟数据"},
  }[dataSource] || {bg:"transparent",c:"#666",b:"#333",t:dataSource};

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(145deg,#0a0a0f,#111118,#0d0d14)",color:"#e8e6e3",fontFamily:"'JetBrains Mono','SF Mono','Fira Code',monospace"}}>

      {/* ── HEADER ── */}
      <div style={{background:"linear-gradient(90deg,rgba(249,115,22,.12),rgba(99,102,241,.08))",borderBottom:"1px solid rgba(249,115,22,.2)",padding:"20px 28px",display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:40,height:40,borderRadius:8,background:"linear-gradient(135deg,#f97316,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:900,color:"#fff"}}>量</div>
        <div>
          <h1 style={{margin:0,fontSize:22,fontWeight:700,letterSpacing:1,background:"linear-gradient(90deg,#f97316,#fb923c,#fbbf24)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>策略回测平台</h1>
          <p style={{margin:0,fontSize:11,color:"#6b7280",letterSpacing:2,marginTop:2}}>STRATEGY BACKTESTING · sina-real-time + Sina HTTP API</p>
        </div>
        {dataSource && <span style={{marginLeft:"auto",fontSize:10,padding:"3px 10px",background:srcBadge.bg,color:srcBadge.c,borderRadius:4,border:`1px solid ${srcBadge.b}`}}>{srcBadge.t}</span>}
      </div>

      <div style={{padding:"20px 28px"}}>
        {/* ── CONTROLS: 2-column ── */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>

          {/* LEFT: Symbol + Capital + Date Range */}
          <div style={{...panelStyle}}>
            <SectionLabel>标的选择 · Symbol</SectionLabel>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
              {presets.map(p=>(
                <div key={p.code} style={{position:"relative",display:"inline-flex"}}>
                  <Chip active={symbol===p.code&&!custom} onClick={()=>{setSymbol(p.code);setCustom("");}}>{p.label}</Chip>
                  <button onClick={e=>{e.stopPropagation();removePreset(p.code);}} style={{position:"absolute",top:-4,right:-4,width:14,height:14,borderRadius:"50%",background:"rgba(239,68,68,.8)",border:"none",color:"#fff",fontSize:9,lineHeight:"14px",cursor:"pointer",padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:10,marginBottom:14}}>
              <div style={{flex:1}}>
                <MiniLabel>自定义代码</MiniLabel>
                <div style={{display:"flex",gap:6}}>
                  <Input value={custom} onChange={e=>setCustom(e.target.value)} placeholder="sh600036, sz000002" style={{flex:1}} />
                  <button onClick={addPreset} disabled={!custom.trim()} style={{padding:"0 12px",fontSize:11,borderRadius:6,cursor:custom.trim()?"pointer":"default",background:custom.trim()?"rgba(34,197,94,.15)":"rgba(255,255,255,.03)",border:"1px solid "+(custom.trim()?"rgba(34,197,94,.4)":"rgba(255,255,255,.06)"),color:custom.trim()?"#22c55e":"#555",whiteSpace:"nowrap"}}>+ 收藏</button>
                </div>
              </div>
              <div style={{width:120}}>
                <MiniLabel>初始资金(万)</MiniLabel>
                <Input type="number" value={capital} onChange={e=>setCapital(+e.target.value)} style={{color:"#fbbf24",fontWeight:600}} />
              </div>
              <div style={{width:150}}>
                <MiniLabel>成交价格</MiniLabel>
                <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:"1px solid rgba(255,255,255,.1)",height:35}}>
                  {[["close","当日收盘"],["nextOpen","次日开盘"]].map(([v,label])=>(
                    <button key={v} onClick={()=>setExecMode(v)} style={{flex:1,fontSize:11,border:"none",cursor:"pointer",background:execMode===v?"rgba(249,115,22,.2)":"rgba(0,0,0,.3)",color:execMode===v?"#fb923c":"#6b7280",fontWeight:execMode===v?600:400,transition:"all .2s"}}>{label}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Date Range ── */}
            <SectionLabel>回测区间 · Date Range</SectionLabel>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <div style={{flex:1}}>
                <MiniLabel>开始日期</MiniLabel>
                <Input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} />
              </div>
              <span style={{color:"#444",marginTop:14}}>→</span>
              <div style={{flex:1}}>
                <MiniLabel>结束日期</MiniLabel>
                <Input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} />
              </div>
            </div>
            {rangeInfo && (
              <div style={{marginTop:8,fontSize:10,color:"#555",display:"flex",gap:12,flexWrap:"wrap"}}>
                <span>K线可用: <b style={{color:"#6b7280"}}>{rangeInfo.earliest_date}</b> ~ <b style={{color:"#6b7280"}}>{rangeInfo.latest_date}</b></span>
                <span>节点: {rangeInfo.kline_points}</span>
                {rangeInfo.csv_available && <span style={{color:"#818cf8"}}>CSV 可用</span>}
              </div>
            )}
            <div style={{display:"flex",gap:6,marginTop:8}}>
              {[["近1年",1],["近3年",3],["近5年",5],["近10年",10],["最大范围",99]].map(([label,yrs])=>(
                <button key={label} onClick={()=>{
                  if(yrs===99 && rangeInfo?.earliest_date){setStartDate(rangeInfo.earliest_date);}
                  else{const d=new Date();d.setFullYear(d.getFullYear()-yrs);setStartDate(d.toISOString().slice(0,10));}
                  setEndDate(new Date().toISOString().slice(0,10));
                }} style={{fontSize:10,padding:"2px 8px",borderRadius:4,cursor:"pointer",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",color:"#9ca3af"}}>{label}</button>
              ))}
            </div>
          </div>

          {/* RIGHT: Strategy selection */}
          <div style={{...panelStyle}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <SectionLabel style={{marginBottom:0}}>策略选择 · Strategies</SectionLabel>
              <button onClick={()=>setSelStrats(Object.keys(STRATS))} style={smallBtn("#6366f1")}>全选</button>
              <button onClick={()=>setSelStrats([])} style={smallBtn("#ef4444")}>清空</button>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {Object.entries(STRATS).map(([k,st])=>{
                const on=selStrats.includes(k);
                return(
                  <button key={k} onClick={()=>toggleStrat(k)} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",fontSize:11,borderRadius:5,cursor:"pointer",border:on?`1px solid ${st.color}55`:"1px solid rgba(255,255,255,.06)",background:on?`${st.color}18`:"rgba(255,255,255,.02)",color:on?st.color:"#4b5563",transition:"all .2s"}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:on?st.color:"#333",display:"inline-block"}}/>
                    {st.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── RUN BUTTON ── */}
        <button onClick={run} disabled={loading||!selStrats.length} style={{width:"100%",padding:12,fontSize:14,fontWeight:700,borderRadius:8,cursor:loading?"wait":"pointer",background:loading?"rgba(255,255,255,.05)":"linear-gradient(90deg,#f97316,#fb923c)",border:"none",color:loading?"#6b7280":"#0a0a0f",letterSpacing:2,marginBottom:20,opacity:selStrats.length?1:.4}}>
          {loading ? "⏳ 回测中..." : `▶ 开始回测 · ${stockName} · ${startDate} → ${endDate}`}
        </button>

        {/* ── CHART ── */}
        {chartData.length>0 && (
          <div style={{...panelStyle,padding:"20px 16px 10px",marginBottom:20}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,padding:"0 8px"}}>
              <div>
                <span style={{fontSize:15,fontWeight:700,color:"#f97316"}}>{stockName}</span>
                <span style={{fontSize:11,color:"#6b7280",marginLeft:10}}>{activeSymbol} · 资金曲线 (万元)</span>
              </div>
              <span style={{fontSize:10,color:"#4b5563"}}>{rawData&&`${rawData[0]?.day} → ${rawData[rawData.length-1]?.day} · ${rawData.length} 交易日`}</span>
            </div>
            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={chartData} margin={{top:5,right:20,left:10,bottom:5}}>
                <XAxis dataKey="date" fontSize={9} stroke="#333" tick={{fill:"#555"}} tickFormatter={v=>v.slice(2,7)} interval={Math.floor(chartData.length/12)}/>
                <YAxis fontSize={9} stroke="#333" tick={{fill:"#555"}} tickFormatter={v=>`${v}万`} domain={["auto","auto"]}/>
                <Tooltip contentStyle={{background:"rgba(10,10,15,.95)",border:"1px solid rgba(255,255,255,.1)",borderRadius:8,fontSize:11,color:"#e8e6e3"}} labelStyle={{color:"#6b7280",marginBottom:4}} formatter={(v,n)=>[`${fmt(v)}万`,STRATS[n]?.name||n]} itemSorter={(a)=>-a.value}/>
                <ReferenceLine y={capital} stroke="#444" strokeDasharray="4 4"/>
                {selStrats.map(k=>results[k]&&<Line key={k} type="monotone" dataKey={k} stroke={STRATS[k].color} strokeWidth={k==="ma20"?2.5:1.5} dot={false} isAnimationActive={false}/>)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── RESULTS TABLE ── */}
        {sorted.length>0 && (
          <div style={{...panelStyle,padding:0,overflow:"hidden",marginBottom:20}}>
            <div style={{padding:"14px 18px",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
              <span style={{fontSize:12,fontWeight:600,color:"#9ca3af",letterSpacing:1}}>📊 回测排名 PERFORMANCE RANKING</span>
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr style={{borderBottom:"1px solid rgba(255,255,255,.08)"}}>
                  <TH>#</TH><TH>策略</TH>
                  <TH sort onClick={()=>handleSort("finalValue")}>最终资产(万) {sortCol==="finalValue"?(sortAsc?"↑":"↓"):""}</TH>
                  <TH sort onClick={()=>handleSort("totalReturn")}>总收益率 {sortCol==="totalReturn"?(sortAsc?"↑":"↓"):""}</TH>
                  <TH sort onClick={()=>handleSort("maxDrawdown")}>最大回撤 {sortCol==="maxDrawdown"?(sortAsc?"↑":"↓"):""}</TH>
                  <TH sort onClick={()=>handleSort("trades")}>交易次数 {sortCol==="trades"?(sortAsc?"↑":"↓"):""}</TH>
                  <TH sort onClick={()=>handleSort("winRate")}>胜率 {sortCol==="winRate"?(sortAsc?"↑":"↓"):""}</TH>
                </tr></thead>
                <tbody>{sorted.map((r,i)=>{
                  const st=STRATS[r.key],ret=+r.totalReturn;
                  return(
                    <tr key={r.key} style={{borderBottom:"1px solid rgba(255,255,255,.04)",background:i===0?"rgba(249,115,22,.06)":"transparent"}}>
                      <TD style={{color:i===0?"#f97316":"#555",fontWeight:700}}>{i+1}</TD>
                      <TD><span style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:st.color,marginRight:8,verticalAlign:"middle"}}/><span style={{color:st.color,fontWeight:500}}>{st.name}</span></TD>
                      <TD style={{color:"#fbbf24",fontWeight:700}}>{fmt(r.finalValue)}</TD>
                      <TD style={{fontWeight:700,color:ret>0?"#22c55e":ret<0?"#ef4444":"#6b7280"}}>{ret>0?"+":""}{r.totalReturn}%</TD>
                      <TD style={{color:"#ef4444"}}>-{r.maxDrawdown}%</TD>
                      <TD style={{color:"#9ca3af"}}>{r.trades}</TD>
                      <TD style={{color:+r.winRate>50?"#22c55e":"#f97316"}}>{r.winRate}%</TD>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── FOOTER ── */}
        <div style={{marginTop:20,padding:"14px 0",borderTop:"1px solid rgba(255,255,255,.04)",fontSize:10,color:"#333",textAlign:"center",letterSpacing:1}}>
          数据采集: sina-real-time (Rust WebSocket) · 历史数据: Sina HTTP API · 回测结果仅供参考，不构成投资建议
        </div>
      </div>
    </div>
  );
}

/* ── Styled sub-components ── */
const panelStyle = {background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.06)",borderRadius:10,padding:18};
const SectionLabel = ({children,style:s}) => <div style={{fontSize:10,color:"#6b7280",letterSpacing:2,marginBottom:12,textTransform:"uppercase",...s}}>{children}</div>;
const MiniLabel = ({children}) => <label style={{fontSize:10,color:"#6b7280",display:"block",marginBottom:4}}>{children}</label>;
const Input = (props) => <input {...props} style={{width:"100%",padding:"8px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box",...(props.style||{})}} />;
const Chip = ({children,active,onClick}) => <button onClick={onClick} style={{padding:"5px 12px",fontSize:12,borderRadius:5,cursor:"pointer",border:active?"1px solid #f97316":"1px solid rgba(255,255,255,.1)",background:active?"rgba(249,115,22,.15)":"rgba(255,255,255,.04)",color:active?"#fb923c":"#9ca3af",transition:"all .2s"}}>{children}</button>;
const smallBtn = (c) => ({fontSize:10,padding:"2px 8px",borderRadius:4,cursor:"pointer",background:`${c}22`,border:`1px solid ${c}44`,color:c});
const TH = ({children,sort,onClick}) => <th onClick={onClick} style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#6b7280",fontWeight:500,letterSpacing:1,textTransform:"uppercase",whiteSpace:"nowrap",cursor:sort?"pointer":"default"}}>{children}</th>;
const TD = ({children,style:s}) => <td style={{padding:"10px 14px",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",...s}}>{children}</td>;
