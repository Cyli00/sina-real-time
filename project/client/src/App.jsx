import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import "./styles.css";

/* ══════════════════════════════════════════
   Responsive hook
   ══════════════════════════════════════════ */

function useIsMobile(bp = 760) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.innerWidth < bp);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp - 1}px)`);
    const h = (e) => setM(e.matches);
    mq.addEventListener("change", h);
    setM(mq.matches);
    return () => mq.removeEventListener("change", h);
  }, [bp]);
  return m;
}

/* ══════════════════════════════════════════
   Auth helpers
   ══════════════════════════════════════════ */

let _token = localStorage.getItem("token") || "";
function setAuthToken(t) { _token = t; if (t) localStorage.setItem("token", t); else localStorage.removeItem("token"); }
function authHeaders() { return _token ? { "Authorization": `Bearer ${_token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" }; }

let _onUnauth = null;
function handleResponse(r) {
  if (r.status === 401) { _onUnauth?.(); return null; }
  if (!r.ok) throw new Error(r.status);
  return r;
}

/* ══════════════════════════════════════════
   API Layer
   ══════════════════════════════════════════ */

async function apiFetchKLine(symbol, start, end) {
  const p = new URLSearchParams({ symbol });
  if (start) p.set("start", start);
  if (end) p.set("end", end);
  try {
    const r = handleResponse(await fetch(`/api/kline?${p}`, { headers: authHeaders() }));
    if (!r) return null;
    return await r.json();
  } catch { return null; }
}

async function apiFetchRange(symbol) {
  try {
    const r = handleResponse(await fetch(`/api/range?symbol=${symbol}`, { headers: authHeaders() }));
    if (!r) return null;
    return await r.json();
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
   Strategies
   ══════════════════════════════════════════ */

import { MA_STRATS } from "./utils/ma";
import { MACD_STRATS } from "./utils/macd";

const STRATS = {
  buy_hold: { name: "一直持有", color: "#525252", cat: "基准", fn: (c) => { const s = Array(c.length).fill(0); s[0] = 1; return s; } },
  ...Object.fromEntries(Object.entries(MA_STRATS).map(([k, v]) => [k, { ...v, cat: k.includes("break") ? "均线突破" : "均线拐头" }])),
  ...Object.fromEntries(Object.entries(MACD_STRATS).map(([k, v]) => [k, { ...v, cat: "MACD" }])),
};

/* ══════════════════════════════════════════
   Backtester
   ══════════════════════════════════════════ */

function backtest(data, stratFn, capital, execMode="close", commRate=0, stampRate=0, minComm=0, slipBps=0, limitRate=0, isIndex=false) {
  const C=data.map(d=>+d.close), H=data.map(d=>+d.high), L=data.map(d=>+d.low), O=data.map(d=>+d.open);
  const sig=stratFn(C,H,L);
  let cash=capital, shares=0, completedTrades=0, wins=0, lastBuyCost=0;
  let pendingBuy=false, pendingSell=false, lastBuyBar=-2;
  const eq=[];
  function isLimitUp(bar, price) { if (bar===0||limitRate<=0) return false; return price>=Math.round(C[bar-1]*(1+limitRate)*100)/100; }
  function isLimitDown(bar, price) { if (bar===0||limitRate<=0) return false; return price<=Math.round(C[bar-1]*(1-limitRate)*100)/100; }
  function slip(price, isBuy) { return slipBps>0?price*(1+(isBuy?1:-1)*slipBps/10000):price; }
  function doBuy(rawPrice, bar) {
    if (shares>0||cash<=0||isLimitUp(bar,rawPrice)) return;
    const price=slip(rawPrice,true);
    let n=isIndex?Math.floor(cash/(price*(1+commRate))):Math.floor(cash/(price*(1+commRate))/100)*100;
    if (n<=0) return;
    let cost=n*price, fee=Math.max(cost*commRate,minComm);
    while (cost+fee>cash&&n>0) { n-=isIndex?1:100; cost=n*price; fee=Math.max(cost*commRate,minComm); }
    if (n<=0) return;
    cash-=cost+fee; shares=n; lastBuyCost=cost+fee; lastBuyBar=bar;
  }
  function doSell(rawPrice, bar) {
    if (shares<=0||bar<=lastBuyBar) return;
    if (isLimitDown(bar,rawPrice)) return;
    const price=slip(rawPrice,false), gross=shares*price;
    const fee=Math.min(Math.max(gross*commRate,minComm)+gross*stampRate,gross);
    completedTrades++; if (gross-fee>lastBuyCost) wins++;
    cash+=gross-fee; shares=0;
  }
  for(let i=0;i<data.length;i++){
    if(execMode==="nextOpen"&&i>0){ if(pendingBuy){doBuy(O[i],i);pendingBuy=false;} else if(pendingSell){doSell(O[i],i);pendingSell=false;} }
    if(execMode==="close"){ if(sig[i]===1) doBuy(C[i],i); else if(sig[i]===-1) doSell(C[i],i); }
    else { if(sig[i]===1) pendingBuy=true; else if(sig[i]===-1) pendingSell=true; }
    eq.push(+((cash+shares*C[i])/10000).toFixed(2));
  }
  const fv=cash+shares*C[C.length-1];
  let peak=-Infinity,maxDD=0;
  eq.forEach(v=>{if(v>peak)peak=v;const dd=peak>0?(peak-v)/peak:0;if(dd>maxDD)maxDD=dd;});
  return{equity:eq,totalReturn:((fv-capital)/capital*100).toFixed(1),trades:completedTrades,winRate:completedTrades?((wins/completedTrades)*100).toFixed(1):"0",maxDrawdown:(maxDD*100).toFixed(1),finalValue:+(fv/10000).toFixed(2)};
}

/* ══════════════════════════════════════════
   Utilities
   ══════════════════════════════════════════ */

const DEFAULT_PRESETS = [
  {code:"sh000001",label:"上证指数"},{code:"sz399001",label:"深证成指"},
  {code:"sz399006",label:"创业板指"},{code:"sh000688",label:"科创50"},
  {code:"sh000905",label:"中证500"},{code:"sh000300",label:"沪深300"},
  {code:"sh000015",label:"红利指数"},
];

const fmtNum = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const signed = n => (n >= 0 ? `+${n}` : `${n}`);

function normalizeSymbol(input) {
  const s = input.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  const dotMatch = s.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (dotMatch) return dotMatch[2] + dotMatch[1];
  const pureDigit = s.match(/^(\d{6})$/);
  if (pureDigit) {
    const code = pureDigit[1];
    if (code[0] === '6' || code[0] === '5') return 'sh' + code;
    if (code[0] === '8' || code[0] === '4') return 'bj' + code;
    if (code.startsWith('000')) return 'sh' + code;
    if (code.startsWith('399')) return 'sz' + code;
    return 'sz' + code;
  }
  return s;
}

function getLimitRate(symbol) {
  const code = symbol.slice(2);
  if (code.startsWith("688")) return 0.2;
  if (code.startsWith("300")) return 0.2;
  if (code[0] === "8" || code[0] === "4") return 0.3;
  return 0.1;
}

/* ══════════════════════════════════════════
   SVG Equity Chart
   ══════════════════════════════════════════ */

function EquityChart({ data, results, selected, capital, isMobile }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 380 });

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      setSize({ w: Math.max(320, Math.floor(width)), h: isMobile ? 240 : 380 });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [isMobile]);

  const { w, h } = size;
  const pad = { top: 16, right: isMobile ? 12 : 20, bottom: 26, left: isMobile ? 44 : 56 };
  const iw = w - pad.left - pad.right;
  const ih = h - pad.top - pad.bottom;

  const series = selected
    .filter(k => results[k])
    .map(k => ({ key: k, color: STRATS[k].color, name: STRATS[k].name, eq: results[k].equity }));

  let yMin = capital / 10000, yMax = capital / 10000;
  series.forEach(s => s.eq.forEach(v => { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }));
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad10 = (yMax - yMin) * 0.08;
  yMin -= pad10; yMax += pad10;

  const n = data.length;
  const x = i => pad.left + (i / Math.max(1, n - 1)) * iw;
  const y = v => pad.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

  const xTicks = [];
  const labelCount = isMobile ? 4 : 7;
  for (let t = 0; t < labelCount; t++) {
    const i = Math.floor((t / (labelCount - 1)) * (n - 1));
    xTicks.push({ i, d: data[i]?.day });
  }
  const yTicks = [];
  const step = (yMax - yMin) / 4;
  for (let t = 0; t <= 4; t++) yTicks.push(yMin + step * t);

  const [hover, setHover] = useState(null);
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < pad.left || px > pad.left + iw) { setHover(null); return; }
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.left) / iw) * (n - 1))));
    setHover(i);
  };
  const baselineY = y(capital / 10000);

  return (
    <div ref={wrapRef} style={{ width: "100%", position: "relative" }}>
      <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        <line x1={pad.left} x2={pad.left + iw} y1={baselineY} y2={baselineY} stroke="var(--border)" strokeDasharray="2 4" strokeWidth="1" />
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={pad.left} x2={pad.left + iw} y1={y(v)} y2={y(v)} stroke="var(--border-subtle)" strokeWidth="1" />
            <text x={pad.left - 8} y={y(v) + 3} textAnchor="end" fontSize={isMobile ? 9 : 10} fill="var(--ink-40)" fontFamily="var(--font-mono)">{v.toFixed(0)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t.i)} y={h - 6} textAnchor="middle" fontSize={isMobile ? 9 : 10} fill="var(--ink-40)" fontFamily="var(--font-mono)">{t.d?.slice(2, 7)}</text>
        ))}
        {series.map(s => (
          <path key={s.key} d={s.eq.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={s.key === "ma20" || series.length <= 3 ? 1.75 : 1.25} strokeLinejoin="round" strokeLinecap="round" opacity={hover != null ? 0.9 : 1} />
        ))}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + ih} stroke="var(--ink-30)" strokeWidth="1" strokeDasharray="2 2" />
            {series.map(s => <circle key={s.key} cx={x(hover)} cy={y(s.eq[hover])} r="3" fill="var(--bg)" stroke={s.color} strokeWidth="1.5" />)}
          </g>
        )}
      </svg>
      {hover != null && (
        <div style={{ position: "absolute", left: Math.min(x(hover) + 10, w - (isMobile ? 180 : 240)), top: pad.top, background: "var(--bg-surface)", border: "1px solid var(--border)", padding: "8px 10px", fontSize: 11, fontFamily: "var(--font-mono)", pointerEvents: "none", minWidth: isMobile ? 160 : 220, boxShadow: "var(--shadow-sm)", borderRadius: "var(--radius)", zIndex: 5 }}>
          <div style={{ color: "var(--ink-60)", marginBottom: 6, letterSpacing: 0.5 }}>{data[hover]?.day}</div>
          {series.map(s => ({ ...s, val: s.eq[hover] })).sort((a, b) => b.val - a.val).slice(0, 6).map(s => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ width: 8, height: 2, background: s.color, flexShrink: 0 }} />
              <span style={{ color: "var(--ink-70)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
              <span style={{ color: "var(--ink)", fontFeatureSettings: "'tnum'" }}>{s.val.toFixed(1)}</span>
            </div>
          ))}
          {series.length > 6 && <div style={{ color: "var(--ink-40)", fontSize: 10 }}>+{series.length - 6} more…</div>}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   Theme Toggle
   ══════════════════════════════════════════ */

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") || "light");
  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  };
  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved) { setTheme(saved); document.documentElement.setAttribute("data-theme", saved); }
  }, []);
  const isDark = theme === "dark";
  return (
    <button className="btn btn-ghost btn-sm theme-toggle" onClick={toggle} aria-label={isDark ? "浅色模式" : "深色模式"} title={isDark ? "浅色模式" : "深色模式"}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {isDark ? <g><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></g>
                 : <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />}
      </svg>
    </button>
  );
}

/* ══════════════════════════════════════════
   Login Screen
   ══════════════════════════════════════════ */

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      if (!r.ok) { const d = await r.json().catch(() => null); setError(d?.detail || "登录失败"); setLoading(false); return; }
      const data = await r.json();
      onLogin(data.token, { username: data.username, is_admin: data.is_admin, must_setup: data.must_setup });
    } catch { setError("无法连接服务器"); }
    setLoading(false);
  };

  return (
    <div className="auth-wrap">
      <form onSubmit={submit} className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">QB</div>
          <div>
            <div className="brand-name">策略回测</div>
            <div className="brand-sub">Quantum Backtest</div>
          </div>
        </div>
        <div className="field-row">
          <label className="field-label">用户名</label>
          <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoFocus placeholder="username" />
        </div>
        <div className="field-row">
          <label className="field-label">密码</label>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
        {error && <div className="alert-err">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" disabled={loading || !username || !password}>
          {loading ? "登录中…" : "登 录"}
        </button>
        <div className="auth-hint">默认管理员 <code>admin</code> / <code>admin123</code></div>
      </form>
    </div>
  );
}

/* ══════════════════════════════════════════
   Setup Screen
   ══════════════════════════════════════════ */

function SetupScreen({ onComplete }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setError("");
    if (password !== confirm) { setError("两次密码不一致"); return; }
    if (password.length < 6) { setError("密码至少 6 位"); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/setup", { method: "POST", headers: authHeaders(), body: JSON.stringify({ new_username: username, new_password: password }) });
      const d = await r.json();
      if (!r.ok) { setError(d.detail || "设置失败"); setLoading(false); return; }
      onComplete(d.token, { username: d.username, is_admin: true, must_setup: false });
    } catch { setError("无法连接服务器"); }
    setLoading(false);
  };

  return (
    <div className="auth-wrap">
      <form onSubmit={submit} className="auth-card setup">
        <div className="auth-brand">
          <div className="brand-mark">QB</div>
          <div>
            <div className="brand-name">初始设置</div>
            <div className="brand-sub">Admin Setup Required</div>
          </div>
        </div>
        <p style={{ fontSize: 12, color: "var(--ink-60)", marginBottom: 20, lineHeight: 1.6 }}>
          首次使用，请设置管理员用户名和密码。<br />设置完成后默认账户将失效。
        </p>
        <div className="field-row">
          <label className="field-label">新管理员用户名</label>
          <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoFocus placeholder="请勿使用 admin" />
        </div>
        <div className="field-row">
          <label className="field-label">新密码</label>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 6 位" />
        </div>
        <div className="field-row">
          <label className="field-label">确认密码</label>
          <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="再次输入密码" />
        </div>
        {error && <div className="alert-err">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" disabled={loading || !username.trim() || !password || !confirm}>
          {loading ? "设置中…" : "完成设置"}
        </button>
      </form>
    </div>
  );
}

/* ══════════════════════════════════════════
   Admin Panel
   ══════════════════════════════════════════ */

function AdminPanel({ onBack }) {
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [msg, setMsg] = useState("");
  const [resetId, setResetId] = useState(null);
  const [resetPass, setResetPass] = useState("");

  const loadUsers = async () => {
    try { const r = handleResponse(await fetch("/api/admin/users", { headers: authHeaders() })); if (r) setUsers(await r.json()); } catch {}
  };
  useEffect(() => { loadUsers(); }, []);

  const addUser = async (e) => {
    e.preventDefault(); setMsg("");
    try {
      const r = await fetch("/api/admin/users", { method: "POST", headers: authHeaders(), body: JSON.stringify({ username: newUser, password: newPass }) });
      const d = await r.json();
      if (!r.ok) { setMsg(d.detail || "创建失败"); return; }
      setMsg(`用户 "${d.username}" 创建成功`); setNewUser(""); setNewPass(""); loadUsers();
    } catch { setMsg("请求失败"); }
  };

  const resetPassword = async (id) => {
    if (!resetPass.trim()) return;
    try {
      const r = await fetch(`/api/admin/users/${id}/reset-password`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ new_password: resetPass }) });
      if (r.ok) { setMsg("密码已重置"); setResetId(null); setResetPass(""); } else { const d = await r.json(); setMsg(d.detail || "重置失败"); }
    } catch { setMsg("请求失败"); }
  };

  const deleteUser = async (id, name) => {
    if (!confirm(`确定删除用户 "${name}"？其监控列表也将被删除。`)) return;
    try {
      const r = await fetch(`/api/admin/users/${id}`, { method: "DELETE", headers: authHeaders() });
      if (r.ok) loadUsers(); else { const d = await r.json().catch(() => null); setMsg(d?.detail || "删除失败"); }
    } catch { setMsg("请求失败"); }
  };

  return (
    <div className="admin-wrap">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-mark sm">QB</div>
          <div className="brand-text">
            <div className="brand-name sm">用户管理</div>
            <div className="brand-sub sm">User Management</div>
          </div>
        </div>
        <div className="topbar-right">
          <ThemeToggle />
          <button className="btn btn-ghost btn-sm" onClick={onBack}>返回回测</button>
        </div>
      </header>

      <div className="admin-content">
        <section className="card" style={{ marginBottom: 20 }}>
          <header className="card-head">
            <h2 className="card-title">添加用户</h2>
            <span className="card-sub">Add User</span>
          </header>
          <div className="card-body">
            <form className="admin-form" onSubmit={addUser}>
              <div className="field-col">
                <label className="field-label">用户名</label>
                <input className="input" value={newUser} onChange={e => setNewUser(e.target.value)} />
              </div>
              <div className="field-col">
                <label className="field-label">密码</label>
                <input className="input" type="password" value={newPass} onChange={e => setNewPass(e.target.value)} />
              </div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!newUser.trim() || !newPass.trim()}>+ 添加</button>
            </form>
            {msg && <div className={msg.includes("成功") || msg.includes("重置") ? "alert-ok" : "alert-err"} style={{ marginTop: 12 }}>{msg}</div>}
          </div>
        </section>

        <section className="card">
          <header className="card-head">
            <h2 className="card-title">用户列表</h2>
            <span className="card-sub">Users ({users.length})</span>
          </header>
          <div className="card-body-table">
            <table className="admin-table">
              <thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead>
              <tbody>{users.map(u => (
                <tr key={u.id}>
                  <td className="mono" style={{ color: "var(--ink-40)" }}>{u.id}</td>
                  <td style={{ fontWeight: 500 }}>{u.username}</td>
                  <td>{u.is_admin ? <span className="role-badge admin">管理员</span> : <span className="role-badge user">用户</span>}</td>
                  <td style={{ color: "var(--ink-60)", fontSize: 12 }}>{u.created_at}</td>
                  <td>
                    {resetId === u.id ? (
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input className="input" type="password" placeholder="新密码" value={resetPass} onChange={e => setResetPass(e.target.value)} style={{ width: 120, padding: "4px 8px", fontSize: 12 }} />
                        <button className="btn btn-primary btn-sm" onClick={() => resetPassword(u.id)} disabled={!resetPass.trim()}>确认</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setResetId(null); setResetPass(""); }}>取消</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setResetId(u.id); setResetPass(""); }}>重置密码</button>
                        {!u.is_admin && <button className="btn btn-danger btn-sm" onClick={() => deleteUser(u.id, u.username)}>删除</button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   App Root
   ══════════════════════════════════════════ */

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [user, setUser] = useState(() => { try { return JSON.parse(localStorage.getItem("user")); } catch { return null; } });
  const [showAdmin, setShowAdmin] = useState(false);

  const doLogin = (tok, usr) => { setAuthToken(tok); setToken(tok); setUser(usr); localStorage.setItem("user", JSON.stringify(usr)); };
  const doLogout = () => { setAuthToken(""); setToken(""); setUser(null); localStorage.removeItem("user"); };
  useEffect(() => { _onUnauth = doLogout; return () => { _onUnauth = null; }; }, []);

  if (!token) return <LoginScreen onLogin={doLogin} />;
  if (user?.must_setup) return <SetupScreen onComplete={doLogin} />;
  if (showAdmin && user?.is_admin) return <AdminPanel onBack={() => setShowAdmin(false)} />;
  return <MainApp user={user} onLogout={doLogout} onShowAdmin={() => setShowAdmin(true)} />;
}

/* ══════════════════════════════════════════
   Main App
   ══════════════════════════════════════════ */

function MainApp({ user, onLogout, onShowAdmin }) {
  const mob = useIsMobile();
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [pwdMsg, setPwdMsg] = useState("");

  const changePassword = async (e) => {
    e.preventDefault(); setPwdMsg("");
    try {
      const r = await fetch("/api/change-password", { method: "POST", headers: authHeaders(), body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }) });
      const d = await r.json();
      if (r.ok) { if (d.token) setAuthToken(d.token); setPwdMsg("密码已修改"); setOldPwd(""); setNewPwd(""); setTimeout(() => setShowChangePwd(false), 1000); }
      else setPwdMsg(d.detail || "修改失败");
    } catch { setPwdMsg("请求失败"); }
  };

  const [presets, setPresets] = useState(DEFAULT_PRESETS);
  const [symbol, setSymbol] = useState("sh000001");
  const [custom, setCustom] = useState("");
  const [capital, setCapital] = useState(100);
  const [selStrats, setSelStrats] = useState(Object.keys(STRATS));
  const [execMode, setExecMode] = useState("close");
  const [commission, setCommission] = useState(5);
  const [stampTax, setStampTax] = useState(10);
  const [minComm, setMinComm] = useState(5);
  const [slippage, setSlippage] = useState(0);

  useEffect(() => {
    (async () => {
      try { const r = handleResponse(await fetch("/api/presets", { headers: authHeaders() })); if (r) { const data = await r.json(); if (data.length) setPresets(data); } } catch {}
    })();
  }, []);

  const savePresets = async (list) => {
    setPresets(list);
    try { await fetch("/api/presets", { method: "POST", headers: authHeaders(), body: JSON.stringify(list) }); } catch {}
  };

  const addPreset = async () => {
    const code = normalizeSymbol(custom);
    if (!code || presets.some(p => p.code === code)) return;
    const info = await apiFetchRange(code);
    const name = info?.name || code;
    savePresets([...presets, { code, label: name }]);
    setStockName(name); setCustom("");
  };

  const removePreset = (code) => {
    savePresets(presets.filter(p => p.code !== code));
    if (symbol === code && presets.length > 1) setSymbol(presets.find(p => p.code !== code)?.code || "sh000001");
  };

  const [startDate, setStartDate] = useState("2015-01-01");
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [rangeInfo, setRangeInfo] = useState(null);
  const [rawData, setRawData] = useState(null);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stockName, setStockName] = useState("上证指数");
  const [dataSource, setDataSource] = useState("");
  const [sortCol, setSortCol] = useState("finalValue");
  const [sortAsc, setSortAsc] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showStratModal, setShowStratModal] = useState(false);

  const activeSymbol = custom.trim() ? normalizeSymbol(custom) : symbol;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await apiFetchRange(activeSymbol);
      if (cancelled) return;
      if (info) {
        setRangeInfo(info);
        const name = info.name || activeSymbol;
        setStockName(name);
        if (name !== activeSymbol) {
          const p = presets.find(p => p.code === activeSymbol && p.label === p.code);
          if (p) savePresets(presets.map(x => x.code === activeSymbol ? { ...x, label: name } : x));
        }
      } else setRangeInfo(null);
    })();
    return () => { cancelled = true; };
  }, [activeSymbol]);

  const toggleStrat = k => setSelStrats(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k]);

  const run = useCallback(async () => {
    setLoading(true);
    const sym = activeSymbol;
    let data = null, src = "demo", name = stockName;
    const apiResp = await apiFetchKLine(sym, startDate, endDate);
    if (apiResp && apiResp.data?.length > 20) { data = apiResp.data; src = apiResp.source; name = apiResp.name; }
    if (!data) {
      const sina = await fallbackSina(sym);
      if (sina && sina.length > 20) { data = sina.map(d => ({ ...d, day: d.day.slice(0, 10) })); if (startDate) data = data.filter(d => d.day >= startDate); if (endDate) data = data.filter(d => d.day <= endDate); src = "sina_direct"; }
    }
    if (!data || data.length < 20) { const demo = generateDemo(sym, startDate, endDate); data = demo.data; name = demo.name; src = "demo"; }
    setRawData(data); setStockName(name); setDataSource(src);
    const cap = capital * 10000;
    const code = activeSymbol.slice(2);
    const isIdx = (activeSymbol.startsWith("sh") && code.startsWith("000")) || (activeSymbol.startsWith("sz") && code.startsWith("399"));
    const isEtf = (activeSymbol.startsWith("sh") && (code.startsWith("51") || code.startsWith("56") || code.startsWith("58"))) || (activeSymbol.startsWith("sz") && (code.startsWith("15") || code.startsWith("16")));
    const noFee = isIdx || isEtf;
    const cr = noFee ? 0 : commission / 10000, sr = noFee ? 0 : stampTax / 10000;
    const mc = noFee ? 0 : minComm, sl = noFee ? 0 : slippage, lr = noFee ? 0 : getLimitRate(activeSymbol);
    const res = {};
    for (const key of selStrats) res[key] = backtest(data, STRATS[key].fn, cap, execMode, cr, sr, mc, sl, lr, noFee);
    setResults(res); setLoading(false);
  }, [activeSymbol, startDate, endDate, capital, selStrats, stockName, execMode, commission, stampTax, minComm, slippage]);

  useEffect(() => { run(); }, []);

  const sorted = useMemo(() => {
    if (!results) return [];
    const a = Object.entries(results).map(([k, r]) => ({ key: k, ...r, name: STRATS[k].name, color: STRATS[k].color }));
    a.sort((x, y) => { const va = +x[sortCol] || 0, vb = +y[sortCol] || 0; return sortAsc ? va - vb : vb - va; });
    return a;
  }, [results, sortCol, sortAsc]);

  const handleSort = c => { if (sortCol === c) setSortAsc(!sortAsc); else { setSortCol(c); setSortAsc(false); } };

  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  const srcBadge = {
    "akshare_qfq":  { bg: "var(--accent-soft)", c: "var(--pos)", t: "akshare · 前复权" },
    "akshare_index": { bg: "var(--accent-soft)", c: "var(--accent-ink)", t: "akshare · 指数" },
    "sina_direct":  { bg: "var(--accent-soft)", c: "var(--ink-60)", t: "新浪直连" },
    "demo":         { bg: "var(--accent-soft)", c: "var(--neg)", t: "DEMO" },
  }[dataSource] || { bg: "transparent", c: "var(--ink-60)", t: dataSource };

  /* ── STRATEGY CATEGORIES ── */
  const stratCats = ["基准", "均线拐头", "均线突破", "MACD"];

  return (
    <div className="app">
      {/* ── TOP BAR ── */}
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-mark sm">QB</div>
          <div className="brand-text">
            <div className="brand-name sm">策略回测</div>
            <div className="brand-sub sm">Quantum Backtest</div>
          </div>
        </div>
        <div className="topbar-right">
          {dataSource && <span className="src-badge" style={{ background: srcBadge.bg, color: srcBadge.c }}>{srcBadge.t}</span>}
          <span className="user-name">{user?.username}</span>
          <ThemeToggle />
          <button className="btn btn-ghost btn-sm" onClick={() => { setShowChangePwd(!showChangePwd); setPwdMsg(""); setOldPwd(""); setNewPwd(""); }}>改密</button>
          {user?.is_admin && <button className="btn btn-ghost btn-sm" onClick={onShowAdmin}>管理</button>}
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>登出</button>
        </div>
      </header>

      {/* ── PASSWORD CHANGE BAR ── */}
      {showChangePwd && (
        <div className="pwd-bar">
          <form className="pwd-form" onSubmit={changePassword}>
            <div className="field-col">
              <label className="field-label">旧密码</label>
              <input className="input" type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} />
            </div>
            <div className="field-col">
              <label className="field-label">新密码</label>
              <input className="input" type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!oldPwd || !newPwd}>确认修改</button>
            {pwdMsg && <span style={{ fontSize: 12, color: pwdMsg.includes("已修改") ? "var(--pos)" : "var(--neg)" }}>{pwdMsg}</span>}
          </form>
        </div>
      )}

      <main className="main">
        {/* ── SYMBOL & PARAMS ── */}
        <section className="card">
          <header className="card-head">
            <h2 className="card-title">标的与回测参数</h2>
            <span className="card-sub">Symbol & Parameters</span>
          </header>
          <div className="card-body">
            <div className="subhead">常用标的</div>
            <div className="chip-row">
              {presets.map(p => (
                <span key={p.code} className={`chip ${symbol === p.code && !custom ? "chip-on" : ""}`}>
                  <button className="chip-main" onClick={() => { setSymbol(p.code); setCustom(""); setStockName(p.label); }}>{p.label}</button>
                  <button className="chip-x" onClick={e => { e.stopPropagation(); removePreset(p.code); }}>×</button>
                </span>
              ))}
            </div>

            <div className="form-grid form-grid-top">
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span className="field-label">自定义代码</span>
                <div className="input-with-btn">
                  <input className="input" value={custom} onChange={e => setCustom(e.target.value)} placeholder="sh600036" />
                  <button className="btn btn-ghost btn-sm" onClick={addPreset} disabled={!custom.trim()}>+ 收藏</button>
                </div>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span className="field-label">初始资金（万）</span>
                <input className="input" type="number" value={capital} onChange={e => setCapital(+e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span className="field-label">成交价格</span>
                <div className="seg">
                  <button className={`seg-btn ${execMode === "close" ? "on" : ""}`} onClick={() => setExecMode("close")}>当日收盘</button>
                  <button className={`seg-btn ${execMode === "nextOpen" ? "on" : ""}`} onClick={() => setExecMode("nextOpen")}>次日开盘</button>
                </div>
              </label>
            </div>

            <div className="form-grid form-grid-dates">
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span className="field-label">开始日期</span>
                <input className="input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span className="field-label">结束日期</span>
                <input className="input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
              </label>
            </div>

            <div className="preset-range">
              {[["近1年", 1], ["近3年", 3], ["近5年", 5], ["近10年", 10]].map(([l, yrs]) => (
                <button key={l} className="pill" onClick={() => {
                  const d = new Date(); d.setFullYear(d.getFullYear() - yrs);
                  setStartDate(d.toISOString().slice(0, 10)); setEndDate(new Date().toISOString().slice(0, 10));
                }}>{l}</button>
              ))}
              {rangeInfo?.earliest_date && (
                <button className="pill" onClick={() => { setStartDate(rangeInfo.earliest_date); setEndDate(new Date().toISOString().slice(0, 10)); }}>最大范围</button>
              )}
            </div>
            {rangeInfo && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--ink-60)" }}>
                K线可用: <span className="mono">{rangeInfo.earliest_date}</span> → <span className="mono">{rangeInfo.latest_date}</span> · {rangeInfo.kline_points} 节点
              </div>
            )}

            <button className="disclosure" onClick={() => setShowAdvanced(!showAdvanced)}>
              <span>{showAdvanced ? "▾" : "▸"}</span> 高级参数（佣金、印花税、滑点）
            </button>
            {showAdvanced && (
              <div className="form-grid form-grid-advanced">
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span className="field-label">佣金（万分）</span>
                  <input className="input" type="number" value={commission} onChange={e => setCommission(+e.target.value)} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span className="field-label">印花税（万分）</span>
                  <input className="input" type="number" value={stampTax} onChange={e => setStampTax(+e.target.value)} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span className="field-label">最低佣金（元）</span>
                  <input className="input" type="number" value={minComm} onChange={e => setMinComm(+e.target.value)} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span className="field-label">滑点（万分）</span>
                  <input className="input" type="number" value={slippage} onChange={e => setSlippage(+e.target.value)} />
                </label>
              </div>
            )}
          </div>
        </section>

        {/* ── RUN BUTTON ── */}
        <div className="run-row">
          <button className="btn btn-primary btn-run" onClick={run} disabled={loading || !selStrats.length}>
            {loading ? "回测中…" : `运行回测  ·  ${stockName}`}
          </button>
          <div className="run-meta">{startDate} → {endDate} · {selStrats.length} 策略</div>
        </div>

        {/* ── RESULTS ── */}
        {results && rawData && (
          <>
            {best && worst && (
              <div className="summary-grid">
                <div className="summary-card">
                  <div className="summary-label">最佳策略</div>
                  <div className="summary-value" style={{ color: best.color }}>{best.name}</div>
                  <div className="summary-stat pos">{signed(best.totalReturn)}%</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">最差策略</div>
                  <div className="summary-value">{worst.name}</div>
                  <div className={`summary-stat ${worst.totalReturn >= 0 ? "pos" : "neg"}`}>{signed(worst.totalReturn)}%</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">回测区间</div>
                  <div className="summary-value">{rawData.length} 个交易日</div>
                  <div className="summary-stat muted mono">{rawData[0]?.day} → {rawData[rawData.length - 1]?.day}</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">标的</div>
                  <div className="summary-value">{stockName}</div>
                  <div className="summary-stat muted mono">{activeSymbol}</div>
                </div>
              </div>
            )}

            {/* ── CHART ── */}
            <section className="card">
              <header className="card-head">
                <h2 className="card-title">资金曲线</h2>
                <span className="card-sub">Equity Curve · 万元</span>
                <div className="card-head-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowStratModal(true)}>⚙ 策略 · {selStrats.length}</button>
                </div>
              </header>
              <div className="card-body card-body-chart">
                <EquityChart data={rawData} results={results} selected={selStrats} capital={capital * 10000} isMobile={mob} />
              </div>
            </section>

            {/* ── RANKING ── */}
            <section className="card">
              <header className="card-head">
                <h2 className="card-title">策略排名</h2>
                <span className="card-sub">Ranking</span>
              </header>
              <div className="card-body-table">
                {mob ? (
                  <div className="rank-cards">
                    {sorted.map((r, idx) => (
                      <div key={r.key} className="rank-card">
                        <div className="rank-card-head">
                          <span className="rank-num">#{idx + 1}</span>
                          <span className="rank-swatch" style={{ background: r.color }} />
                          <span className="rank-name">{r.name}</span>
                        </div>
                        <div className="rank-card-stats">
                          <div><div className="stat-label">总收益</div><div className={`stat-val ${r.totalReturn >= 0 ? "pos" : "neg"}`}>{signed(r.totalReturn)}%</div></div>
                          <div><div className="stat-label">最终资金</div><div className="stat-val mono">{fmtNum(r.finalValue)}万</div></div>
                          <div><div className="stat-label">最大回撤</div><div className="stat-val mono">{r.maxDrawdown}%</div></div>
                          <div><div className="stat-label">交易次数</div><div className="stat-val mono">{r.trades}</div></div>
                          <div><div className="stat-label">胜率</div><div className="stat-val mono">{r.winRate}%</div></div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <table className="rank-table">
                    <thead><tr>
                      <th style={{ width: 40 }}>#</th>
                      <th>策略</th>
                      <th className="th-sort" onClick={() => handleSort("totalReturn")}>总收益 {sortCol === "totalReturn" ? (sortAsc ? "↑" : "↓") : ""}</th>
                      <th className="th-sort" onClick={() => handleSort("finalValue")}>最终资金 {sortCol === "finalValue" ? (sortAsc ? "↑" : "↓") : ""}</th>
                      <th className="th-sort" onClick={() => handleSort("maxDrawdown")}>最大回撤 {sortCol === "maxDrawdown" ? (sortAsc ? "↑" : "↓") : ""}</th>
                      <th className="th-sort" onClick={() => handleSort("trades")}>交易 {sortCol === "trades" ? (sortAsc ? "↑" : "↓") : ""}</th>
                      <th className="th-sort" onClick={() => handleSort("winRate")}>胜率 {sortCol === "winRate" ? (sortAsc ? "↑" : "↓") : ""}</th>
                    </tr></thead>
                    <tbody>{sorted.map((r, idx) => (
                      <tr key={r.key}>
                        <td className="rank-num-cell">{idx + 1}</td>
                        <td><div className="rank-name-cell"><span className="rank-swatch" style={{ background: r.color }} />{r.name}</div></td>
                        <td className={`mono ${r.totalReturn >= 0 ? "pos" : "neg"}`}>{signed(r.totalReturn)}%</td>
                        <td className="mono">{fmtNum(r.finalValue)}</td>
                        <td className="mono">{r.maxDrawdown}%</td>
                        <td className="mono">{r.trades}</td>
                        <td className="mono">{r.winRate}%</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            </section>
          </>
        )}

        <footer className="footer">基于 akshare · 数据仅供参考，不构成投资建议</footer>
      </main>

      {/* ── STRATEGY MODAL (portal) ── */}
      {showStratModal && createPortal(
        <div className="modal-backdrop" onClick={() => setShowStratModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2 className="card-title">策略</h2>
                <span className="card-sub">Strategies · 实时更新</span>
              </div>
              <div className="modal-head-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setSelStrats(Object.keys(STRATS))}>全选</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelStrats([])}>清空</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowStratModal(false)} aria-label="关闭" style={{ fontFamily: "var(--font-mono)" }}>✕</button>
              </div>
            </header>
            <div className="modal-body">
              {stratCats.map(cat => {
                const items = Object.entries(STRATS).filter(([, s]) => s.cat === cat);
                if (!items.length) return null;
                return (
                  <div key={cat} className="strat-group">
                    <div className="subhead">{cat}</div>
                    <div className="strat-chips">
                      {items.map(([k, s]) => {
                        const on = selStrats.includes(k);
                        return (
                          <button key={k} className={`strat-chip ${on ? "on" : ""}`} onClick={() => toggleStrat(k)} style={on ? { borderColor: s.color, color: s.color } : {}}>
                            <span className="strat-dot" style={{ background: on ? s.color : "var(--ink-20)" }} />
                            {s.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <footer className="modal-foot">
              <span className="modal-foot-hint">修改后图表实时更新，点击外部关闭</span>
              <button className="btn btn-primary btn-sm" onClick={() => { setShowStratModal(false); run(); }}>重新回测</button>
            </footer>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
