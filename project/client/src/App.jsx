import { useState, useEffect, useCallback, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

/* ══════════════════════════════════════════
   Auth helpers
   ══════════════════════════════════════════ */

let _token = localStorage.getItem("token") || "";
function setAuthToken(t) { _token = t; if (t) localStorage.setItem("token", t); else localStorage.removeItem("token"); }
function authHeaders() { return _token ? { "Authorization": `Bearer ${_token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" }; }

let _onUnauth = null; // App 组件设置的 401 回调
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
   Strategies (imported from utils/)
   ══════════════════════════════════════════ */

import { MA_STRATS } from "./utils/ma";
import { MACD_STRATS } from "./utils/macd";

const STRATS = {
  buy_hold: { name: "一直持有", color: "#78716c", fn: (c) => { const s = Array(c.length).fill(0); s[0] = 1; return s; } },
  ...MA_STRATS,
  ...MACD_STRATS,
};

/* ══════════════════════════════════════════
   Backtester
   ══════════════════════════════════════════ */

function backtest(data, stratFn, capital, execMode="close", commRate=0, stampRate=0, minComm=0, slipBps=0, limitRate=0, isIndex=false) {
  const C=data.map(d=>+d.close), H=data.map(d=>+d.high), L=data.map(d=>+d.low), O=data.map(d=>+d.open);
  const sig=stratFn(C,H,L);
  let cash=capital, shares=0, completedTrades=0, wins=0, lastBuyCost=0;
  let pendingBuy=false, pendingSell=false;
  let lastBuyBar=-2;
  const eq=[];

  function isLimitUp(bar, price) {
    if (bar === 0 || limitRate <= 0) return false;
    return price >= Math.round(C[bar-1] * (1 + limitRate) * 100) / 100;
  }
  function isLimitDown(bar, price) {
    if (bar === 0 || limitRate <= 0) return false;
    return price <= Math.round(C[bar-1] * (1 - limitRate) * 100) / 100;
  }
  function slip(price, isBuy) {
    return slipBps > 0 ? price * (1 + (isBuy ? 1 : -1) * slipBps / 10000) : price;
  }

  function doBuy(rawPrice, bar) {
    if (shares > 0 || cash <= 0 || isLimitUp(bar, rawPrice)) return;
    const price = slip(rawPrice, true);
    let n = isIndex
      ? Math.floor(cash / (price * (1 + commRate)))
      : Math.floor(cash / (price * (1 + commRate)) / 100) * 100;
    if (n <= 0) return;
    let cost = n * price;
    let fee = Math.max(cost * commRate, minComm);
    while (cost + fee > cash && n > 0) { n -= isIndex ? 1 : 100; cost = n * price; fee = Math.max(cost * commRate, minComm); }
    if (n <= 0) return;
    cash -= cost + fee;
    shares = n;
    lastBuyCost = cost + fee;
    lastBuyBar = bar;
  }

  function doSell(rawPrice, bar) {
    if (shares <= 0 || bar <= lastBuyBar) return;  // T+1
    if (isLimitDown(bar, rawPrice)) return;
    const price = slip(rawPrice, false);
    const gross = shares * price;
    const fee = Math.min(Math.max(gross * commRate, minComm) + gross * stampRate, gross);
    const net = gross - fee;
    completedTrades++;
    if (net > lastBuyCost) wins++;
    cash += net;
    shares = 0;
  }

  for(let i=0;i<data.length;i++){
    if(execMode==="nextOpen"&&i>0){
      if(pendingBuy){ doBuy(O[i], i); pendingBuy=false; }
      else if(pendingSell){ doSell(O[i], i); pendingSell=false; }
    }
    if(execMode==="close"){
      if(sig[i]===1) doBuy(C[i], i);
      else if(sig[i]===-1) doSell(C[i], i);
    } else {
      if(sig[i]===1) pendingBuy=true;
      else if(sig[i]===-1) pendingSell=true;
    }
    eq.push(+((cash+shares*C[i])/10000).toFixed(2));
  }
  const fv=cash+shares*C[C.length-1];
  let peak=-Infinity,maxDD=0;
  eq.forEach(v=>{if(v>peak)peak=v;const dd=peak>0?(peak-v)/peak:0;if(dd>maxDD)maxDD=dd;});
  return{equity:eq,totalReturn:((fv-capital)/capital*100).toFixed(1),trades:completedTrades,winRate:completedTrades?((wins/completedTrades)*100).toFixed(1):"0",maxDrawdown:(maxDD*100).toFixed(1),finalValue:+(fv/10000).toFixed(2)};
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
   Login Screen
   ══════════════════════════════════════════ */

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const r = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setError(d?.detail || "登录失败"); setLoading(false); return;
      }
      const data = await r.json();
      onLogin(data.token, { username: data.username, is_admin: data.is_admin, must_setup: data.must_setup });
    } catch { setError("无法连接服务器"); }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(145deg,#0a0a0f,#111118,#0d0d14)",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <form onSubmit={submit} style={{width:340,background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.08)",borderRadius:12,padding:32}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:48,height:48,borderRadius:10,background:"linear-gradient(135deg,#f97316,#6366f1)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:900,color:"#fff",marginBottom:12}}>量</div>
          <h2 style={{margin:0,fontSize:18,fontWeight:700,color:"#e8e6e3",letterSpacing:1}}>策略回测平台</h2>
          <p style={{margin:"4px 0 0",fontSize:11,color:"#6b7280",letterSpacing:2}}>STRATEGY BACKTESTING</p>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:11,color:"#6b7280",display:"block",marginBottom:4}}>用户名</label>
          <input value={username} onChange={e=>setUsername(e.target.value)} autoFocus
            style={{width:"100%",padding:"10px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
        </div>
        <div style={{marginBottom:20}}>
          <label style={{fontSize:11,color:"#6b7280",display:"block",marginBottom:4}}>密码</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
            style={{width:"100%",padding:"10px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
        </div>
        {error && <div style={{marginBottom:14,fontSize:12,color:"#ef4444",textAlign:"center"}}>{error}</div>}
        <button type="submit" disabled={loading || !username || !password}
          style={{width:"100%",padding:12,fontSize:14,fontWeight:700,borderRadius:8,cursor:loading?"wait":"pointer",background:"linear-gradient(90deg,#f97316,#fb923c)",border:"none",color:"#0a0a0f",letterSpacing:2,opacity:(username&&password)?1:.5}}>
          {loading ? "登录中..." : "登 录"}
        </button>
      </form>
    </div>
  );
}

/* ══════════════════════════════════════════
   Setup Screen (首次登录强制设置)
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
      const r = await fetch("/api/setup", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ new_username: username, new_password: password }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.detail || "设置失败"); setLoading(false); return; }
      onComplete(d.token, { username: d.username, is_admin: true, must_setup: false });
    } catch { setError("无法连接服务器"); }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(145deg,#0a0a0f,#111118,#0d0d14)",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <form onSubmit={submit} style={{width:380,background:"rgba(255,255,255,.03)",border:"1px solid rgba(99,102,241,.25)",borderRadius:12,padding:32}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:48,height:48,borderRadius:10,background:"linear-gradient(135deg,#6366f1,#f97316)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:900,color:"#fff",marginBottom:12}}>设</div>
          <h2 style={{margin:0,fontSize:18,fontWeight:700,color:"#818cf8",letterSpacing:1}}>初始设置</h2>
          <p style={{margin:"8px 0 0",fontSize:11,color:"#9ca3af",lineHeight:1.6}}>首次使用，请设置管理员用户名和密码<br/>设置完成后默认账户将失效</p>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:11,color:"#6b7280",display:"block",marginBottom:4}}>新管理员用户名</label>
          <input value={username} onChange={e=>setUsername(e.target.value)} autoFocus placeholder="请勿使用 admin"
            style={{width:"100%",padding:"10px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
        </div>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:11,color:"#6b7280",display:"block",marginBottom:4}}>新密码</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="至少 6 位"
            style={{width:"100%",padding:"10px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
        </div>
        <div style={{marginBottom:20}}>
          <label style={{fontSize:11,color:"#6b7280",display:"block",marginBottom:4}}>确认密码</label>
          <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
            style={{width:"100%",padding:"10px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
        </div>
        {error && <div style={{marginBottom:14,fontSize:12,color:"#ef4444",textAlign:"center"}}>{error}</div>}
        <button type="submit" disabled={loading || !username.trim() || !password || !confirm}
          style={{width:"100%",padding:12,fontSize:14,fontWeight:700,borderRadius:8,cursor:loading?"wait":"pointer",background:"linear-gradient(90deg,#6366f1,#818cf8)",border:"none",color:"#fff",letterSpacing:2,opacity:(username.trim()&&password&&confirm)?1:.5}}>
          {loading ? "设置中..." : "完成设置"}
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

  const loadUsers = async () => {
    try {
      const r = handleResponse(await fetch("/api/admin/users", { headers: authHeaders() }));
      if (r) setUsers(await r.json());
    } catch {}
  };

  useEffect(() => { loadUsers(); }, []);

  const addUser = async (e) => {
    e.preventDefault();
    setMsg("");
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username: newUser, password: newPass }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.detail || "创建失败"); return; }
      setMsg(`用户 "${d.username}" 创建成功`);
      setNewUser(""); setNewPass("");
      loadUsers();
    } catch { setMsg("请求失败"); }
  };

  const [resetId, setResetId] = useState(null);
  const [resetPass, setResetPass] = useState("");

  const resetPassword = async (id) => {
    if (!resetPass.trim()) return;
    try {
      const r = await fetch(`/api/admin/users/${id}/reset-password`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ new_password: resetPass }),
      });
      const d = await r.json();
      if (r.ok) { setMsg("密码已重置"); setResetId(null); setResetPass(""); }
      else setMsg(d.detail || "重置失败");
    } catch { setMsg("请求失败"); }
  };

  const deleteUser = async (id, name) => {
    if (!confirm(`确定删除用户 "${name}"？其监控列表也将被删除。`)) return;
    try {
      const r = await fetch(`/api/admin/users/${id}`, { method: "DELETE", headers: authHeaders() });
      if (r.ok) loadUsers();
      else { const d = await r.json().catch(()=>null); setMsg(d?.detail || "删除失败"); }
    } catch { setMsg("请求失败"); }
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(145deg,#0a0a0f,#111118,#0d0d14)",color:"#e8e6e3",fontFamily:"'JetBrains Mono','SF Mono','Fira Code',monospace"}}>
      <div style={{background:"linear-gradient(90deg,rgba(99,102,241,.12),rgba(249,115,22,.08))",borderBottom:"1px solid rgba(99,102,241,.2)",padding:"20px 28px",display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:40,height:40,borderRadius:8,background:"linear-gradient(135deg,#6366f1,#f97316)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:900,color:"#fff"}}>管</div>
        <div>
          <h1 style={{margin:0,fontSize:22,fontWeight:700,color:"#818cf8",letterSpacing:1}}>用户管理</h1>
          <p style={{margin:0,fontSize:11,color:"#6b7280",letterSpacing:2,marginTop:2}}>USER MANAGEMENT</p>
        </div>
        <button onClick={onBack} style={{marginLeft:"auto",fontSize:12,padding:"6px 16px",borderRadius:6,cursor:"pointer",background:"rgba(249,115,22,.15)",border:"1px solid rgba(249,115,22,.3)",color:"#fb923c"}}>返回回测</button>
      </div>

      <div style={{padding:"20px 28px",maxWidth:700}}>
        {/* 添加用户 */}
        <div style={{...panelStyle,marginBottom:20}}>
          <div style={{fontSize:11,color:"#6b7280",letterSpacing:2,marginBottom:12,textTransform:"uppercase"}}>添加用户 · Add User</div>
          <form onSubmit={addUser} style={{display:"flex",gap:10,alignItems:"flex-end"}}>
            <div style={{flex:1}}>
              <label style={{fontSize:10,color:"#6b7280",display:"block",marginBottom:4}}>用户名</label>
              <input value={newUser} onChange={e=>setNewUser(e.target.value)}
                style={{width:"100%",padding:"8px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:10,color:"#6b7280",display:"block",marginBottom:4}}>密码</label>
              <input type="password" value={newPass} onChange={e=>setNewPass(e.target.value)}
                style={{width:"100%",padding:"8px 12px",fontSize:13,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:6,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
            </div>
            <button type="submit" disabled={!newUser.trim()||!newPass.trim()}
              style={{padding:"8px 20px",fontSize:12,borderRadius:6,cursor:"pointer",background:"rgba(34,197,94,.15)",border:"1px solid rgba(34,197,94,.4)",color:"#22c55e",whiteSpace:"nowrap",opacity:(newUser.trim()&&newPass.trim())?1:.5}}>+ 添加</button>
          </form>
          {msg && <div style={{marginTop:10,fontSize:12,color:msg.includes("成功")?"#22c55e":"#ef4444"}}>{msg}</div>}
        </div>

        {/* 用户列表 */}
        <div style={{...panelStyle,padding:0,overflow:"hidden"}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
            <span style={{fontSize:11,color:"#6b7280",letterSpacing:2,textTransform:"uppercase"}}>用户列表 · Users ({users.length})</span>
          </div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{borderBottom:"1px solid rgba(255,255,255,.08)"}}>
              <th style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#6b7280",fontWeight:500,letterSpacing:1}}>ID</th>
              <th style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#6b7280",fontWeight:500,letterSpacing:1}}>用户名</th>
              <th style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#6b7280",fontWeight:500,letterSpacing:1}}>角色</th>
              <th style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#6b7280",fontWeight:500,letterSpacing:1}}>创建时间</th>
              <th style={{padding:"10px 14px",textAlign:"left",fontSize:10,color:"#6b7280",fontWeight:500,letterSpacing:1}}>操作</th>
            </tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id} style={{borderBottom:"1px solid rgba(255,255,255,.04)"}}>
                <td style={{padding:"10px 14px",color:"#555"}}>{u.id}</td>
                <td style={{padding:"10px 14px",color:"#e8e6e3",fontWeight:500}}>{u.username}</td>
                <td style={{padding:"10px 14px"}}>{u.is_admin
                  ? <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,background:"rgba(99,102,241,.15)",border:"1px solid rgba(99,102,241,.3)",color:"#818cf8"}}>管理员</span>
                  : <span style={{fontSize:10,padding:"2px 8px",borderRadius:4,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",color:"#9ca3af"}}>普通用户</span>
                }</td>
                <td style={{padding:"10px 14px",color:"#6b7280",fontSize:11}}>{u.created_at}</td>
                <td style={{padding:"10px 14px",display:"flex",gap:6,alignItems:"center"}}>
                  {resetId===u.id ? (
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      <input type="password" placeholder="新密码" value={resetPass} onChange={e=>setResetPass(e.target.value)}
                        style={{width:100,padding:"4px 8px",fontSize:11,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:4,color:"#e8e6e3",outline:"none"}} />
                      <button onClick={()=>resetPassword(u.id)} disabled={!resetPass.trim()}
                        style={{fontSize:10,padding:"3px 8px",borderRadius:4,cursor:"pointer",background:"rgba(34,197,94,.1)",border:"1px solid rgba(34,197,94,.3)",color:"#22c55e"}}>确认</button>
                      <button onClick={()=>{setResetId(null);setResetPass("");}}
                        style={{fontSize:10,padding:"3px 8px",borderRadius:4,cursor:"pointer",background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",color:"#9ca3af"}}>取消</button>
                    </div>
                  ) : (
                    <>
                      <button onClick={()=>{setResetId(u.id);setResetPass("");}}
                        style={{fontSize:10,padding:"3px 10px",borderRadius:4,cursor:"pointer",background:"rgba(251,191,36,.1)",border:"1px solid rgba(251,191,36,.3)",color:"#fbbf24"}}>重置密码</button>
                      {!u.is_admin && <button onClick={()=>deleteUser(u.id,u.username)}
                        style={{fontSize:10,padding:"3px 10px",borderRadius:4,cursor:"pointer",background:"rgba(239,68,68,.1)",border:"1px solid rgba(239,68,68,.3)",color:"#ef4444"}}>删除</button>}
                    </>
                  )}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   Main Component
   ══════════════════════════════════════════ */

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem("token") || "");
  const [user, setUser] = useState(() => { try { return JSON.parse(localStorage.getItem("user")); } catch { return null; } });
  const [showAdmin, setShowAdmin] = useState(false);

  const doLogin = (tok, usr) => {
    setAuthToken(tok);
    setToken(tok);
    setUser(usr);
    localStorage.setItem("user", JSON.stringify(usr));
  };

  const doLogout = () => {
    setAuthToken("");
    setToken("");
    setUser(null);
    localStorage.removeItem("user");
  };

  // 注册 401 回调
  useEffect(() => { _onUnauth = doLogout; return () => { _onUnauth = null; }; }, []);

  if (!token) return <LoginScreen onLogin={doLogin} />;
  if (user?.must_setup) return <SetupScreen onComplete={doLogin} />;
  if (showAdmin && user?.is_admin) return <AdminPanel onBack={() => setShowAdmin(false)} />;

  return <MainApp user={user} onLogout={doLogout} onShowAdmin={() => setShowAdmin(true)} />;
}

/* ══════════════════════════════════════════
   Main App (回测界面)
   ══════════════════════════════════════════ */

function MainApp({ user, onLogout, onShowAdmin }) {
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [pwdMsg, setPwdMsg] = useState("");

  const changePassword = async (e) => {
    e.preventDefault(); setPwdMsg("");
    try {
      const r = await fetch("/api/change-password", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
      });
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

  useEffect(() => {
    (async () => {
      try {
        const r = handleResponse(await fetch("/api/presets", { headers: authHeaders() }));
        if (r) { const data = await r.json(); if (data.length) setPresets(data); }
      } catch {}
    })();
  }, []);

  const savePresets = async (list) => {
    setPresets(list);
    try {
      const r = await fetch("/api/presets", { method: "POST", headers: authHeaders(), body: JSON.stringify(list) });
      if (!r.ok) console.warn("[presets] save failed:", r.status);
    } catch (e) { console.warn("[presets] save error:", e); }
  };

  const addPreset = async () => {
    const code = normalizeSymbol(custom);
    if (!code || presets.some(p => p.code === code)) return;
    const info = await apiFetchRange(code);
    const name = info?.name || code;
    savePresets([...presets, { code, label: name }]);
    setStockName(name);
    setCustom("");
  };

  const removePreset = (code) => {
    savePresets(presets.filter(p => p.code !== code));
    if (symbol === code && presets.length > 1) setSymbol(presets.find(p => p.code !== code)?.code || "sh000001");
  };

  const [startDate, setStartDate] = useState("2015-01-01");
  const [endDate, setEndDate]   = useState(new Date().toISOString().slice(0,10));
  const [rangeInfo, setRangeInfo] = useState(null);

  const [rawData, setRawData] = useState(null);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stockName, setStockName] = useState("上证指数");
  const [dataSource, setDataSource] = useState("");
  const [execMode, setExecMode] = useState("close");
  const [commission, setCommission] = useState(5);
  const [stampTax, setStampTax] = useState(10);
  const [minComm, setMinComm] = useState(5);
  const [slippage, setSlippage] = useState(0);
  const [sortCol, setSortCol] = useState("finalValue");
  const [sortAsc, setSortAsc] = useState(false);

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

    const apiResp = await apiFetchKLine(sym, startDate, endDate);
    if (apiResp && apiResp.data?.length > 20) {
      data = apiResp.data;
      src = apiResp.source;
      name = apiResp.name;
    }

    if (!data) {
      const sina = await fallbackSina(sym);
      if (sina && sina.length > 20) {
        data = sina.map(d => ({...d, day: d.day.slice(0,10)}));
        if (startDate) data = data.filter(d => d.day >= startDate);
        if (endDate) data = data.filter(d => d.day <= endDate);
        src = "sina_direct";
      }
    }

    if (!data || data.length < 20) {
      const demo = generateDemo(sym, startDate, endDate);
      data = demo.data; name = demo.name; src = "demo";
    }

    setRawData(data); setStockName(name); setDataSource(src);

    const cap = capital * 10000;
    const code = activeSymbol.slice(2);
    const isIdx = (activeSymbol.startsWith("sh") && code.startsWith("000")) || (activeSymbol.startsWith("sz") && code.startsWith("399"));
    const isEtf = (activeSymbol.startsWith("sh") && (code.startsWith("51") || code.startsWith("56") || code.startsWith("58")))
               || (activeSymbol.startsWith("sz") && (code.startsWith("15") || code.startsWith("16")));
    const noFee = isIdx || isEtf;
    const cr = noFee ? 0 : commission / 10000;
    const sr = noFee ? 0 : stampTax / 10000;
    const mc = noFee ? 0 : minComm;
    const sl = noFee ? 0 : slippage;
    const lr = noFee ? 0 : getLimitRate(activeSymbol);
    const res = {};
    for (const key of selStrats) {
      res[key] = backtest(data, STRATS[key].fn, cap, execMode, cr, sr, mc, sl, lr, noFee);
    }
    setResults(res);
    setLoading(false);
  }, [activeSymbol, startDate, endDate, capital, selStrats, stockName, execMode, commission, stampTax, minComm, slippage]);

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
      <div style={{background:"linear-gradient(90deg,rgba(249,115,22,.12),rgba(99,102,241,.08))",borderBottom:"1px solid rgba(249,115,22,.2)",padding:"14px 28px",display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:40,height:40,borderRadius:8,background:"linear-gradient(135deg,#f97316,#6366f1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:900,color:"#fff",flexShrink:0}}>量</div>
        <div style={{flexShrink:0}}>
          <h1 style={{margin:0,fontSize:22,fontWeight:700,letterSpacing:1,background:"linear-gradient(90deg,#f97316,#fb923c,#fbbf24)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>策略回测平台</h1>
          <p style={{margin:0,fontSize:11,color:"#6b7280",letterSpacing:2,marginTop:2}}>STRATEGY BACKTESTING</p>
        </div>
        <div style={{marginLeft:"auto",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
          {dataSource && <span style={{fontSize:10,padding:"3px 10px",background:srcBadge.bg,color:srcBadge.c,borderRadius:4,border:`1px solid ${srcBadge.b}`}}>{srcBadge.t}</span>}
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:11,color:"#6b7280"}}>{user?.username}</span>
            <button onClick={()=>{setShowChangePwd(!showChangePwd);setPwdMsg("");setOldPwd("");setNewPwd("");}} style={{fontSize:10,padding:"4px 10px",borderRadius:4,cursor:"pointer",background:"rgba(251,191,36,.1)",border:"1px solid rgba(251,191,36,.3)",color:"#fbbf24"}}>改密</button>
            {user?.is_admin && <button onClick={onShowAdmin} style={{fontSize:10,padding:"4px 10px",borderRadius:4,cursor:"pointer",background:"rgba(99,102,241,.15)",border:"1px solid rgba(99,102,241,.3)",color:"#818cf8"}}>管理</button>}
            <button onClick={onLogout} style={{fontSize:10,padding:"4px 10px",borderRadius:4,cursor:"pointer",background:"rgba(239,68,68,.1)",border:"1px solid rgba(239,68,68,.3)",color:"#ef4444"}}>登出</button>
          </div>
        </div>
      </div>
      {showChangePwd && (
        <div style={{background:"rgba(0,0,0,.4)",borderBottom:"1px solid rgba(251,191,36,.15)",padding:"12px 28px"}}>
          <form onSubmit={changePassword} style={{display:"flex",gap:10,alignItems:"flex-end",maxWidth:500}}>
            <div style={{flex:1}}>
              <label style={{fontSize:10,color:"#6b7280",display:"block",marginBottom:3}}>旧密码</label>
              <input type="password" value={oldPwd} onChange={e=>setOldPwd(e.target.value)}
                style={{width:"100%",padding:"6px 10px",fontSize:12,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:4,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
            </div>
            <div style={{flex:1}}>
              <label style={{fontSize:10,color:"#6b7280",display:"block",marginBottom:3}}>新密码</label>
              <input type="password" value={newPwd} onChange={e=>setNewPwd(e.target.value)}
                style={{width:"100%",padding:"6px 10px",fontSize:12,background:"rgba(0,0,0,.3)",border:"1px solid rgba(255,255,255,.1)",borderRadius:4,color:"#e8e6e3",outline:"none",boxSizing:"border-box"}} />
            </div>
            <button type="submit" disabled={!oldPwd||!newPwd}
              style={{padding:"6px 14px",fontSize:11,borderRadius:4,cursor:"pointer",background:"rgba(34,197,94,.15)",border:"1px solid rgba(34,197,94,.4)",color:"#22c55e",whiteSpace:"nowrap",opacity:(oldPwd&&newPwd)?1:.5}}>确认修改</button>
            {pwdMsg && <span style={{fontSize:11,color:pwdMsg.includes("已修改")?"#22c55e":"#ef4444",whiteSpace:"nowrap"}}>{pwdMsg}</span>}
          </form>
        </div>
      )}

      <div style={{padding:"20px 28px"}}>
        {/* ── CONTROLS: 2-column ── */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>

          {/* LEFT: Symbol + Capital + Date Range */}
          <div style={{...panelStyle}}>
            <SectionLabel>标的选择 · Symbol</SectionLabel>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
              {presets.map(p=>(
                <div key={p.code} style={{position:"relative",display:"inline-flex"}}>
                  <Chip active={symbol===p.code&&!custom} onClick={()=>{setSymbol(p.code);setCustom("");setStockName(p.label);}}>{p.label}</Chip>
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
              <div style={{width:90}}>
                <MiniLabel>佣金(万分)</MiniLabel>
                <Input type="number" value={commission} onChange={e=>setCommission(+e.target.value)} style={{color:"#9ca3af"}} />
              </div>
              <div style={{width:90}}>
                <MiniLabel>印花税(万分)</MiniLabel>
                <Input type="number" value={stampTax} onChange={e=>setStampTax(+e.target.value)} style={{color:"#9ca3af"}} />
              </div>
              <div style={{width:90}}>
                <MiniLabel>最低佣金(元)</MiniLabel>
                <Input type="number" value={minComm} onChange={e=>setMinComm(+e.target.value)} style={{color:"#9ca3af"}} />
              </div>
              <div style={{width:80}}>
                <MiniLabel>滑点(万分)</MiniLabel>
                <Input type="number" value={slippage} onChange={e=>setSlippage(+e.target.value)} style={{color:"#9ca3af"}} />
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
          数据采集: Python + akshare · 历史数据: 东方财富 · 回测结果仅供参考，不构成投资建议
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
