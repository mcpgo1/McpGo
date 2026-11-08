"use client";
import { useState } from "react";
import Image from "next/image";
import { Check, Clipboard, Globe2, Layers3, LockKeyhole, ShieldCheck, Terminal, TimerReset, Zap } from "lucide-react";

export function Brand({ minimal=false }:{ minimal?:boolean }) {
  return <a className="brand" href="#top" aria-label="McpGo — наверх"><span className="brand-icon"><Image src="/mcpgo-mark.svg" alt="" width={35} height={35}/></span><span className="brand-word">mcp<span>go</span></span>{!minimal && <span className="brand-tag">OPEN SOURCE</span>}</a>;
}

export function CopySnippet({ code }:{ code:string }) {
 const [copied,setCopied] = useState(false);
 async function copy() {
   try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(()=>setCopied(false),1800); } catch { setCopied(false); }
 }
 return <div className="code-block"><div className="code-head"><span className="code-dots"><i/><i/><i/></span><span>TERMINAL / INFO</span><button aria-label="Копировать команду" className="copy-button" onClick={copy} type="button">{copied?<Check size={14}/>:<Clipboard size={14}/>} {copied?"Скопировано":"Копировать"}</button></div><pre><code>{code}</code></pre></div>;
}

export function DashboardPreview(){
 return <div className="app-demo" role="img" aria-label="Иллюстрация: панель McpGo с локальными службами, туннелями и терминалом">
  <div className="demo-top"><div className="demo-dots"><i/><i/><i/></div><div className="demo-top-name"><span className="tiny-mark">∞</span> McpGo <span>/ Dashboard</span></div><span className="demo-top-trailing"><i className="glow-dot"/> Local</span></div>
  <div className="demo-content">
   <aside className="demo-sidebar"><div className="demo-sidebar-title">WORKSPACE</div><div className="demo-sidenav active"><Layers3 size={13}/> Обзор</div><div className="demo-sidenav"><Terminal size={13}/> Терминал</div><div className="demo-sidenav"><Globe2 size={13}/> Браузер</div><div className="demo-sidenav"><TimerReset size={13}/> Расписания</div><div className="demo-sidebar-bottom"><div className="demo-avatar">M</div><span>My Mac <small>Local machine</small></span></div></aside>
   <div className="demo-main">
    <div className="demo-heading"><div><span className="demo-kicker">OVERVIEW / 01</span><h3>Панель управления</h3><p>Все инструменты. Одно место.</p></div><div className="demo-live"><i className="glow-dot"/> Локально</div></div>
    <div className="demo-metrics"><div className="demo-metric"><span>Терминал</span><strong><Terminal size={13}/> Ready</strong><small>Terminal MCP</small></div><div className="demo-metric"><span>Браузер</span><strong><Globe2 size={13}/> Ready</strong><small>Chrome CDP</small></div><div className="demo-metric"><span>Туннели</span><strong><LockKeyhole size={13}/> 02 / 02</strong><small>Secure connection</small></div></div>
    <div className="demo-console"><div className="demo-console-head"><div><i className="glow-dot"/> Live activity</div><span>terminal_session</span></div><div className="demo-console-lines"><div><span className="console-time">10:42:01</span><span className="console-accent">›</span> MCP tool connected</div><div><span className="console-time">10:42:02</span><span className="console-accent">›</span> terminal_exec <span className="console-muted">{"{command: 'pwd'}"}</span></div><div><span className="console-time">10:42:02</span><span className="console-success">✓</span> Process exited successfully</div><div><span className="console-time">10:42:02</span><span className="console-muted">↳</span> /Users/you/projects<span className="cursor-mark"/></div></div></div>
    <div className="demo-foot"><div className="demo-foot-icon"><ShieldCheck size={13}/></div> Подключение под твоим контролем <span>MCP READY <Check size={12}/></span></div>
   </div>
  </div>
  <div className="demo-floating floating-one"><span className="floating-icon"><Zap size={16}/></span><span><strong>Меньше рутины</strong><small>Больше времени на важное</small></span></div>
  <div className="demo-floating floating-two"><span className="floating-icon purple"><LockKeyhole size={15}/></span><span><strong>Твой компьютер</strong><small>Твои правила доступа</small></span></div>
 </div>;
}
