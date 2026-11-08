"use client";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowDown, ArrowUpRight, Code2, Github, Heart, X } from "lucide-react";
import { Brand } from "./components";
import { DOCS, faqs, GITHUB, TELEGRAM_COMMUNITY_URL } from "./data";

export function OpenSource(){
 return <section className="open-source-section section"><div className="container open-source-grid">
   <div className="open-source-copy"><div className="section-eyebrow"><span className="slash">{"//"}</span> OPEN SOURCE</div><div className="open-source-mark"><Code2 size={32}/></div><h2>Свободный код.<br/><span className="gradient-word">Без платы за McpGo.</span></h2><p>McpGo создаётся как бесплатный проект с открытым исходным кодом. Изучай архитектуру, предлагай улучшения, собирай свою версию и участвуй в развитии.</p><div className="license-line"><span className="license-symbol">MIT</span><span>Лицензия MIT <small>Для собственного кода. У сторонних компонентов — свои условия.</small></span></div><a className="btn btn-outline" href={GITHUB} target="_blank" rel="noopener noreferrer"><Github size={19}/> Исходный код на GitHub <ArrowUpRight size={17}/></a></div>
   <div className="opensource-art" aria-hidden="true"><div className="art-glow"/><div className="art-center"><Image src="/mcpgo-mark.svg" alt="" width={183} height={183}/></div><div className="art-ring art-ring-one"/><div className="art-ring art-ring-two"/><div className="art-label label-top"><span className="small-square"/> PUBLIC SOURCE</div><div className="art-label label-bottom"><Heart size={14}/> BUILT WITH CURIOSITY</div><div className="art-code art-code-1">&lt;/&gt;</div><div className="art-code art-code-2">{"{ }"}</div></div>
 </div></section>;
}

export function Plans(){
 return <section id="plans" className="section plans-section"><div className="container">
  <div className="section-heading"><div><div className="section-eyebrow"><span className="slash">{"//"}</span> ПЛАНЫ РАЗВИТИЯ</div><h2>Это только <span className="gradient-word">начало.</span></h2></div><p>McpGo развивается открыто: без обещаний идеальной работы там, где функциональность ещё требует доработки.</p></div>
  <div className="plans-layout">
   <div className="plans-feature">
    <div className="plans-status"><span className="plans-status-dot"/> РАННЯЯ СТАДИЯ</div>
    <h3>Оркестрация агентов пока <span>очень сырая.</span></h3>
    <p>Хочу сказать об этом прямо: взаимодействие нескольких агентов, передача задач и управление их выполнением ещё далеки от того уровня, которого я хочу добиться.</p>
    <p className="plans-promise">Я планирую <strong>активно развивать оркестрацию</strong>, улучшать её стабильность, удобство и предсказуемость. Это одно из важных направлений развития McpGo.</p>
   </div>
   <div className="plans-timer">
    <div className="plans-timer-status"><span className="plans-status-dot"/> АКТИВНО ДОРАБАТЫВАЕТСЯ</div>
    <h3>Отправка сообщений по таймеру <span>пока не идеальна.</span></h3>
    <p>Многие сценарии уже реализованы, но стабильность ещё требует улучшений. Я активно работаю над тем, чтобы McpGo точнее определял готовность агента, не зависал в ожидании и надёжнее отправлял сообщения в нужный момент.</p>
   </div>
   <div className="plans-roadmap">
    <div className="plans-roadmap-header"><span>НАПРАВЛЕНИЯ РАБОТЫ</span><span>ROADMAP / 01—04</span></div>
    <div className="plans-roadmap-row"><span className="plans-roadmap-no">01</span><div><strong>Надёжность взаимодействия</strong><p>Более устойчивый обмен задачами и сообщениями между агентами.</p></div></div>
    <div className="plans-roadmap-row"><span className="plans-roadmap-no">02</span><div><strong>Контроль выполнения</strong><p>Понятные состояния задач, обработка зависаний и восстановление работы.</p></div></div>
    <div className="plans-roadmap-row"><span className="plans-roadmap-no">03</span><div><strong>Удобная оркестрация</strong><p>Проще настраивать совместную работу агентов и видеть, что происходит.</p></div></div>
    <div className="plans-roadmap-row plans-roadmap-future"><span className="plans-roadmap-no">04</span><div><strong>Клиент McpGo для Windows</strong><p>В планах — отдельная версия приложения для Windows, чтобы пользоваться McpGo не только на Mac. Сроки выпуска пока не объявлены.</p><span className="plans-future-label">В ПЛАНАХ</span></div></div>
    <p className="plans-roadmap-footnote">Это направления развития, а не готовые функции или обещание конкретных сроков.</p>
   </div>
  </div>
 </div></section>;
}

export function FAQ(){
 const [active,setActive]=useState<number|null>(0);
 return <section id="faq" className="section faq-section container"><div className="section-heading"><div><div className="section-eyebrow"><span className="slash">{"//"}</span> FAQ</div><h2>Коротко <span className="muted-heading">о важном.</span></h2></div><p>Самые частые вопросы перед началом работы. Если нужна техническая глубина — загляни в документацию проекта.</p></div><div className="faq-list">{faqs.map((faq,i)=><article className={`faq-item ${active===i?"open":""}`} key={faq.q}><button type="button" className="faq-question" aria-expanded={active===i} aria-controls={`faq-panel-${i}`} onClick={()=>setActive(active===i?null:i)}><span>{faq.q}</span><span className="faq-plus">{active===i?<X size={19}/>:<ArrowDown size={19}/>}</span></button>{active===i && <p className="faq-answer" id={`faq-panel-${i}`}>{faq.a}</p>}</article>)}</div></section>;
}

export function Footer(){
 return <footer className="footer"><div className="container"><div className="footer-main"><div><Brand minimal/><p>Инструменты для твоего AI.<br/>Контроль остаётся у тебя.</p></div><div className="footer-links"><div><strong>Навигация</strong><Link href="/#features">Возможности</Link><Link href="/#install">Установка</Link><Link href="/#plans">Планы</Link><Link href="/#community">Сообщество</Link><Link href="/career">Я ищу работу</Link><Link href="/#faq">Вопросы и ответы</Link></div><div><strong>Проект</strong><a href={GITHUB} target="_blank" rel="noopener noreferrer">GitHub <ArrowUpRight size={12}/></a><a href={`${GITHUB}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">Лицензия MIT <ArrowUpRight size={12}/></a><a href={`${DOCS}/README.md`} target="_blank" rel="noopener noreferrer">Документация <ArrowUpRight size={12}/></a></div><div><strong>Сообщество</strong><a href={TELEGRAM_COMMUNITY_URL} target="_blank" rel="noopener noreferrer">Telegram-канал <ArrowUpRight size={12}/></a><a href={`${GITHUB}/issues`} target="_blank" rel="noopener noreferrer">Предложить идею <ArrowUpRight size={12}/></a></div></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} McpGo. Бесплатный проект с открытым исходным кодом.</span><span>Сделано для тех, кто любит создавать. <Heart size={13}/></span></div></div></footer>;
}
