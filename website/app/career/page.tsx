import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, AtSign, FileText, Send } from "lucide-react";
import { Header } from "../home-top";
import { Footer } from "../home-bottom";

export const metadata: Metadata = {
  title: "Я ищу работу — Андрей Смотров",
  description: "Андрей Смотров — AI-first / Full-stack разработчик. Опыт GAFUS, McpGo, SaaS и мобильной разработки. Резюме для просмотра и скачивания.",
  alternates: { canonical: "/career" },
  openGraph: { title: "Я ищу работу — Андрей Смотров", url: "/career" },
};

const resumePdf = "/resume.pdf";

const resumePages = [
  { src: "/resume-page-1.png", number: "01", alt: "Первая страница резюме Андрея Смотрова: профиль, опыт разработки GAFUS и Статзавода." },
  { src: "/resume-page-2.png", number: "02", alt: "Вторая страница резюме Андрея Смотрова: McpGo, Telegram-проект, предыдущий опыт, навыки и образование." },
];

export default function CareerPage() {
  return (
    <div className="page-shell career-page">
      <div className="global-glow" aria-hidden="true" />
      <Header />
      <main id="career">
        <section className="container career-page-hero">
          <Link href="/" className="career-page-back"><ArrowLeft size={16} aria-hidden="true" /> На главную</Link>
          <div className="career-page-eyebrow">
            <span className="slash">{"//"}</span> О СОЗДАТЕЛЕ McpGo
            <span className="career-availability"><span className="career-pulse" /> Открыт к предложениям</span>
          </div>
          <div className="career-page-hero-layout">
            <div>
              <h1>Я ищу <span className="gradient-word">работу.</span></h1>
              <p>Привет! Я создаю цифровые продукты — от идеи и архитектуры до мобильных приложений, инфраструктуры и релиза. Развиваю <strong>McpGo</strong> и <strong>GAFUS</strong>, работаю с AI-агентами и открыт к интересным предложениям.</p>
              <div className="career-page-actions">
                <a className="btn btn-primary" href={resumePdf} download="Smotrov_Andrey_Resume.pdf"><ArrowDownToLine size={18} aria-hidden="true" /> Скачать резюме</a>
                <a className="btn btn-secondary" href={resumePdf} target="_blank" rel="noopener noreferrer"><FileText size={18} aria-hidden="true" /> Открыть PDF <ArrowUpRight size={15} aria-hidden="true" /></a>
              </div>
            </div>
            <div className="career-page-profile">
              <div className="career-profile-label">МОЙ ФОКУС</div>
              <strong>AI-FIRST<br />FULL-STACK<br />WEB & MOBILE<span className="career-profile-dot">.</span></strong>
              <p>TypeScript · React · Vite · React Native · Expo · Hono · Go · PostgreSQL · MCP</p>
              <a href="mailto:asmtv1@ya.ru"><AtSign size={15} aria-hidden="true" /> asmtv1@ya.ru <ArrowUpRight size={14} aria-hidden="true" /></a>
            </div>
          </div>
        </section>

        <section className="container career-doc-section" aria-labelledby="career-resume-heading">
          <div className="career-doc-intro">
            <div>
              <span className="career-doc-kicker"><span className="slash">{"//"}</span> РЕЗЮМЕ</span>
              <h2 id="career-resume-heading">Опыт и <span className="gradient-word">проекты.</span></h2>
              <p>Обе страницы в читаемом масштабе. Прокручивай вниз — без встроенного просмотрщика PDF.</p>
            </div>
            <span className="career-doc-count"><FileText size={15} aria-hidden="true" /> PDF · 2 страницы</span>
          </div>

          <div className="career-document-layout">
            <aside className="career-document-aside">
              <div className="career-aside-card">
                <span className="career-aside-kicker">КРАТКО</span>
                <h3>Создаю продукты целиком.</h3>
                <p>Разработка интерфейсов и backend, архитектура, мобильные приложения, CI/CD и AI-инструменты — от прототипа до рабочих релизов.</p>
                <div className="career-aside-divider" />
                <div className="career-aside-links">
                  <a className="career-aside-action" href="mailto:asmtv1@ya.ru">
                    <span className="career-aside-action-icon"><AtSign size={17} aria-hidden="true" /></span>
                    <span className="career-aside-action-label">Написать на почту</span>
                    <ArrowUpRight className="career-aside-action-arrow" size={15} aria-hidden="true" />
                  </a>
                  <a className="career-aside-action" href="https://t.me/bipbub63" target="_blank" rel="noopener noreferrer">
                    <span className="career-aside-action-icon"><Send size={17} aria-hidden="true" /></span>
                    <span className="career-aside-action-label">Написать в Telegram</span>
                    <ArrowUpRight className="career-aside-action-arrow" size={15} aria-hidden="true" />
                  </a>
                </div>
                <div className="career-aside-divider" />
                <a className="career-aside-action career-aside-download" href={resumePdf} download="Smotrov_Andrey_Resume.pdf">
                  <span className="career-aside-action-icon"><ArrowDownToLine size={17} aria-hidden="true" /></span>
                  <span className="career-aside-action-label">Скачать оригинал PDF</span>
                  <ArrowUpRight className="career-aside-action-arrow" size={15} aria-hidden="true" />
                </a>
              </div>
            </aside>

            <div className="career-document-pages">
              {resumePages.map((page, index) => (
                <figure className="career-document-page" key={page.number}>
                  <figcaption><span>РЕЗЮМЕ / СМОТРОВ АНДРЕЙ</span><span>СТРАНИЦА {page.number} / 02</span></figcaption>
                  <a href={page.src} target="_blank" rel="noopener noreferrer" className="career-page-image-link" title="Открыть страницу в полном размере"><Image src={page.src} width={1600} height={2262} unoptimized alt={page.alt} sizes="(max-width: 920px) 100vw, 820px" priority={index === 0} /></a>
                </figure>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
