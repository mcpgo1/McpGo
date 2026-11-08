"use client";
import { useState } from "react";
import { ArrowUpRight, Check, CheckCircle2, ChevronDown, Cpu, Download, Globe2, LockKeyhole, ShieldCheck, Terminal } from "lucide-react";
import { CopySnippet } from "./components";
import { DOCS, DMG_DOWNLOAD_URL, steps } from "./data";
import { ArchitectureFlow } from "./architecture-flow";

export function HowItWorks(){
 return <section id="how-it-works" className="section how-section"><div className="container">
   <div className="section-heading centered architecture-heading">
     <div className="section-eyebrow"><span className="slash">{"//"}</span> КАК ЭТО РАБОТАЕТ</div>
     <h2>Пишешь в ChatGPT.<br/><span className="gradient-word">Работает твой Mac.</span></h2>
     <p>Показываем весь путь: от сообщения в чате до настоящего действия на компьютере — и обратно. Переключай сценарии, чтобы увидеть разницу.</p>
   </div>
   <ArchitectureFlow/>
 </div></section>;
}

export function Install(){
 const [active,setActive] = useState<number | null>(0);
 return <section id="install" className="section install-section container"><div className="install-grid">
   <aside className="install-intro">
    <div className="section-eyebrow"><span className="slash">{"//"}</span> УСТАНОВКА</div>
    <h2>Скачай DMG.<br/>Подключи <span className="gradient-word">ChatGPT.</span></h2>
    <p>Никакой сборки из исходников и команд в терминале. Установи приложение, а затем настрой Secure MCP Tunnels через встроенный мастер.</p>
    <div className="requirements-card">
     <div className="requirements-heading"><Cpu size={18}/> Что потребуется</div>
     <div className="requirement"><Check size={15}/> Mac с Apple Silicon и macOS 14+</div>
     <div className="requirement"><Check size={15}/> ChatGPT с доступом к пользовательским MCP</div>
     <div className="requirement"><Check size={15}/> OpenAI Platform с правами на Tunnels</div>
     <div className="requirement"><Check size={15}/> Google Chrome — только для браузерных задач</div>
     <div className="requirements-bundled"><CheckCircle2 size={16}/> Node.js, Python и локальные компоненты уже включены в DMG.</div>
     <a href={`${DOCS}/ONBOARDING.md`} target="_blank" rel="noopener noreferrer">Подробно о мастере подключения <ArrowUpRight size={15}/></a>
    </div>
    <p className="install-caution"><span>!</span> McpGo 2.0.3 уже опубликован: DMG подписан и нотарифицирован Apple. Версия рассчитана на macOS 14+ и Apple Silicon.</p>
   </aside>
   <div className="steps">
     <div className="dmg-install-guide">
       <div className="dmg-install-label"><ShieldCheck size={16}/> ПОДПИСАНО И НОТАРИФИЦИРОВАНО APPLE</div>
       <h3>Три действия — и можно настраивать.</h3>
       <div className="dmg-install-items">
         <div><strong>01</strong><span><b>Скачай</b> McpGo 2.0.3 (.dmg) по кнопке ниже.</span></div>
         <div><strong>02</strong><span><b>Перетащи</b> McpGo.app в папку «Программы».</span></div>
         <div><strong>03</strong><span><b>Открой</b> приложение и выбери «Первое подключение».</span></div>
       </div>
       <a href={DMG_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary"><Download size={17}/> Скачать McpGo 2.0.3 (.dmg) <ArrowUpRight size={16}/></a>
     </div>
     <div className="tunnel-focus">
       <div className="tunnel-focus-head"><LockKeyhole size={19}/><div><strong>Самое главное — два Secure MCP Tunnel</strong><span>Мастер проведёт через их создание, ключи доступа и подключение к ChatGPT.</span></div></div>
       <div className="tunnel-focus-grid">
         <div><Terminal size={18}/><strong>TerminalHub</strong><span>Код, файлы, команды и тесты</span></div>
         <div><Globe2 size={18}/><strong>PlaywrightHub</strong><span>Личный Chrome и браузерные задачи</span></div>
       </div>
       <p>У каждого подключения свой Tunnel ID. Создание туннелей и сохранение ключей выполняются только с твоего подтверждения.</p>
     </div>
     <div className="dmg-advanced"><span>ПОШАГОВАЯ НАСТРОЙКА ПОДКЛЮЧЕНИЯ</span></div>
     {steps.map((step,i)=>{const open=active===i; return <article className={`step ${open?"open":""}`} key={step.title}>
    <button type="button" className="step-trigger" aria-expanded={open} aria-controls={`step-panel-${i}`} onClick={()=>setActive(open?null:i)}>
     <span className="step-num">{String(i+1).padStart(2,"0")}</span><span className="step-title-area"><span className="step-label">{step.label}</span><strong>{step.title}</strong><span className="step-short">{step.short}</span></span><span className="step-chevron"><ChevronDown size={19}/></span>
    </button>
    {open && <div className="step-panel" id={`step-panel-${i}`}><div className="step-prose">{step.paragraphs.map((p,n)=><p key={n}>{p}</p>)}</div>{step.code && <CopySnippet code={step.code}/>} {step.note && <div className="step-note"><ShieldCheck size={16}/><span>{step.note}</span></div>}{step.links && <div className="step-links">{step.links.map((l)=><a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}<ArrowUpRight size={14}/></a>)}</div>}</div>}
   </article>})}
   <div className="after-steps"><CheckCircle2 size={22}/><div><strong>Готово — можно работать.</strong><p>Если инструменты ответили из ChatGPT, McpGo подключён. Теперь можно настроить сценарии под себя.</p></div></div></div>
 </div></section>;
}
