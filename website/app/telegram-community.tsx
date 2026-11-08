import { ArrowUpRight, LifeBuoy, Megaphone, MessageCircleMore, Send } from "lucide-react";
import { TELEGRAM_COMMUNITY_URL } from "./data";

export function TelegramCommunity() {
  return (
    <section className="telegram-community-section" id="community" aria-labelledby="telegram-community-title">
      <div className="container">
        <div className="telegram-community-card">
          <div className="telegram-community-glow" aria-hidden="true" />
          <div className="telegram-community-copy">
            <div className="telegram-community-eyebrow"><span className="telegram-community-icon"><Send size={17} aria-hidden="true" /></span> TELEGRAM / MCPGO</div>
            <h2 id="telegram-community-title">Все обсуждения и поддержка — <span>в Telegram.</span></h2>
            <p>Общение, вопросы по установке и настройке, помощь с возникающими проблемами, идеи и новости проекта — всё будет в нашем Telegram-канале. <strong>Подписывайтесь, будем на связи!</strong></p>
            <a className="telegram-community-cta" href={TELEGRAM_COMMUNITY_URL} target="_blank" rel="noopener noreferrer">
              <Send size={20} aria-hidden="true" />
              Подписаться на канал
              <ArrowUpRight size={18} aria-hidden="true" />
            </a>
          </div>
          <div className="telegram-community-topics" aria-label="Темы сообщества">
            <span className="telegram-community-topics-label">ЧТО БУДЕМ ОБСУЖДАТЬ</span>
            <div className="telegram-community-topic"><span className="telegram-community-topic-icon"><MessageCircleMore size={20} aria-hidden="true" /></span><div><strong>Вопросы и обсуждения</strong><span>Общение с участниками и идеи для McpGo</span></div></div>
            <div className="telegram-community-topic"><span className="telegram-community-topic-icon"><LifeBuoy size={20} aria-hidden="true" /></span><div><strong>Помощь и поддержка</strong><span>Установка, подключение и разбор ошибок</span></div></div>
            <div className="telegram-community-topic"><span className="telegram-community-topic-icon"><Megaphone size={20} aria-hidden="true" /></span><div><strong>Новости и обновления</strong><span>Релизы, новые возможности и планы</span></div></div>
          </div>
        </div>
      </div>
    </section>
  );
}
