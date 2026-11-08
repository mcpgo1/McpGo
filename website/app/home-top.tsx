"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, CheckCircle2, Code2, Coins, Download, Github, Globe2, Laptop, Menu, MessageCircleMore, Monitor, Sparkles, Terminal, UsersRound, X, Zap } from "lucide-react";
import { Brand } from "./components";
import { ChatSiteExamplePreview } from "./chat-preview";
import { GITHUB, DMG_DOWNLOAD_URL, features } from "./data";

export function Header(){
 const [menu,setMenu]=useState(false);
 return <header className="site-header"><div className="container header-inner">
  <Brand/>
  <nav aria-label="Навигация" className={`header-nav ${menu?"is-open":""}`}>
   <Link href="/#features" onClick={()=>setMenu(false)}>Возможности</Link><Link href="/#how-it-works" onClick={()=>setMenu(false)}>Как работает</Link><Link href="/#install" onClick={()=>setMenu(false)}>Установка</Link><Link href="/#plans" onClick={()=>setMenu(false)}>Планы</Link><Link href="/#community" onClick={()=>setMenu(false)}>Сообщество</Link><Link href="/#faq" onClick={()=>setMenu(false)}>FAQ</Link>
   <div className="header-nav-postscript">
     <Link className="header-postscript" href="/career" onClick={()=>setMenu(false)} aria-label="P.S. Я ищу работу"><span className="header-postscript-label">P.S.</span><span className="header-postscript-text">Я ищу работу</span><ArrowUpRight size={14} aria-hidden="true"/></Link>
   </div>
  </nav>
  <div className="header-actions"><Link className="header-postscript header-postscript-desktop" href="/career" aria-label="P.S. Я ищу работу"><span className="header-postscript-label">P.S.</span><span className="header-postscript-text">Я ищу работу</span><ArrowUpRight size={14} aria-hidden="true"/></Link><a className="header-github" href={GITHUB} target="_blank" rel="noopener noreferrer"><Github size={17}/> GitHub <ArrowUpRight size={15}/></a><button className="mobile-toggle" type="button" aria-label={menu?"Закрыть меню":"Открыть меню"} aria-expanded={menu} onClick={()=>setMenu(!menu)}>{menu?<X size={22}/>:<Menu size={22}/>}</button></div>
 </div></header>;
}

export function Hero(){
 return <><section className="hero container"><div className="hero-grid">
  <div className="hero-copy">
   <Link href="/#how-it-works" className="hero-announcement"><span className="announce-dot"><Sparkles size={14}/></span><span>Настоящие инструменты для AI — без отдельного API-счёта</span><ArrowRight size={14}/></Link>
   <h1>Коди как с Codex.<br/><span>0 токенов на любые<br/>задачи.</span></h1>
   <p className="hero-lead"><strong>McpGo</strong> подключает инструменты твоего Mac к привычному ChatGPT. Рефакторь проекты, исправляй ошибки, запускай тесты, сборки и автоматизации — <strong>без расхода токенов: ни API, ни из лимитов твоей подписки.</strong> Продолжай работу в том же чате с любого устройства.</p>
   <div className="hero-benefits">
    <div className="hero-benefit hero-benefit-highlight"><span className="hero-benefit-icon infinity-mark">∞</span><div><strong>0 токенов</strong><small>вообще никаких</small></div></div>
    <div className="hero-benefit"><span className="hero-benefit-icon"><Zap size={22}/></span><div><strong>Кодинг как с Codex</strong><small>те же возможности</small></div></div>
    <div className="hero-benefit"><span className="hero-benefit-icon"><Monitor size={22}/></span><div><strong>Один чат везде</strong><small>без лагов и сопряжений</small></div></div>
   </div>
   <div className="hero-ctas"><a href={DMG_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary"><Download size={18}/> Скачать McpGo 2.0.3 <ArrowRight size={17}/></a><a href={GITHUB} target="_blank" rel="noopener noreferrer" className="btn btn-secondary"><Github size={19}/> Смотреть на GitHub</a></div>
   <div className="hero-reassurance"><span><CheckCircle2 size={15}/> Бесплатно</span><span><CheckCircle2 size={15}/> Open source / MIT</span><span><CheckCircle2 size={15}/> macOS 14+ / Apple Silicon</span></div>
  </div>
  <div className="hero-visual"><div className="visual-mesh"/><div className="orbit orbit-one"/><div className="orbit orbit-two"/><ChatSiteExamplePreview/><p className="hero-shot-caption"><Sparkles size={16} aria-hidden="true"/><span>На создание этого сайта и <strong>приложения McpGo не было потрачено ни одного токена :D</strong></span></p></div>
 </div></section>
 <div className="ticker"><div className="container ticker-inner"><div className="ticker-intro"><span className="ticker-mini">MCP GO</span> Один чат. Реальные действия.</div><div className="ticker-items"><span><Code2 size={15}/> Coding</span><span><MessageCircleMore size={15}/> Same chat</span><span><Coins size={15}/> No extra Codex API</span><span><Globe2 size={15}/> Browser</span></div></div></div></>;
}

const icons = {code:Code2,messages:MessageCircleMore,parallel:UsersRound,coins:Coins,terminal:Terminal,devices:Laptop,chrome:Globe2};
export function Features(){
 return <section id="features" className="section features-section container">
  <div className="section-heading"><div><div className="section-eyebrow"><span className="slash">{"//"}</span> ВОЗМОЖНОСТИ</div><h2>Коди как с агентом.<br/><span className="muted-heading">Оставайся в своём чате.</span></h2></div><p>Основная идея McpGo: AI пишет и проверяет код на твоём компьютере, а ты продолжаешь работу в одном привычном диалоге ChatGPT — даже с другого устройства.</p></div>
  <div className="features-grid">{features.map((f)=>{const Icon=icons[f.icon];return <article className={`feature-card tone-${f.color} ${f.id === "03" ? "feature-parallel" : ""}`} key={f.id}>
    <div className="feature-head"><span className="feature-icon"><Icon size={22} strokeWidth={1.7}/></span><span className="feature-index">/ {f.id}</span></div>
    <div className="feature-info"><span className="feature-subtitle">{f.label}</span><h3>{f.title}</h3><p>{f.text}</p>{f.id === "03" && <p className="feature-parallel-caveat">Чаты независимы, но CPU, память, сеть и файлы Mac остаются общими. При одновременном изменении одного проекта лучше использовать отдельные ветки или рабочие папки.</p>}</div>
    {f.id === "03" && <div className="feature-parallel-agents" aria-label="Пять параллельных чатов"><span><i/>Агент 01 · Код</span><span><i/>Агент 02 · Тесты</span><span><i/>Агент 03 · Браузер</span><span><i/>Агент 04 · Документы</span><span><i/>Агент 05 · Анализ</span></div>}
    <div className="feature-foot"><span>{f.tag}</span><ArrowUpRight size={16}/></div>
  </article>})}</div>
  <p className="features-disclaimer">McpGo не отменяет лимиты и стоимость доступа к ChatGPT. Первое подключение, разрешения macOS и работающий туннель необходимы; скорость зависит от сети, сервиса и компьютера.</p>
 </section>;
}
