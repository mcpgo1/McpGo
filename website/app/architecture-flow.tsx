"use client";

import { useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Cloud,
  Code2,
  FileCode2,
  Globe2,
  KeyRound,
  LockKeyhole,
  Monitor,
  MousePointer2,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";

type Scenario = "code" | "browser";

const scenes = {
  code: {
    prompt: "Проверь мой проект и запусти тесты.",
    tool: "terminal_exec",
    action: "pnpm test",
    returnText: "Логи тестов и итог выполнения",
    service: "TerminalHub",
    steps: [
      ["Ты даёшь задачу", "В обычном чате ChatGPT"],
      ["ChatGPT выбирает инструмент", "Вызывает terminal_exec через MCP"],
      ["Туннель передаёт команду", "По защищённому исходящему каналу"],
      ["Mac выполняет действие", "TerminalHub запускает тесты"],
      ["Результат возвращается", "Логи видны агенту в том же чате"],
    ],
  },
  browser: {
    prompt: "Посмотри открытую вкладку Chrome и проверь страницу.",
    tool: "browser_snapshot",
    action: "Чтение активной вкладки Chrome",
    returnText: "Снимок страницы и данные браузера",
    service: "PlaywrightHub",
    steps: [
      ["Ты даёшь задачу", "В обычном чате ChatGPT"],
      ["ChatGPT выбирает инструмент", "Вызывает browser_snapshot через MCP"],
      ["Туннель передаёт вызов", "По защищённому исходящему каналу"],
      ["Mac работает с Chrome", "PlaywrightHub использует CDP"],
      ["Результат возвращается", "Содержимое страницы доступно агенту"],
    ],
  },
} as const;

export function ArchitectureFlow() {
  const [scenario, setScenario] = useState<Scenario>("code");
  const scene = scenes[scenario];

  return (
    <div className={"journey journey--" + scenario}>
      <div className="journey-toolbar">
        <div className="journey-toolbar-copy">
          <div className="journey-live-dot" aria-hidden="true" />
          <div>
            <strong>Разберём один запрос по шагам</strong>
            <span>Выбери задачу — схема покажет путь команды и ответа.</span>
          </div>
        </div>
        <div className="journey-switch" role="group" aria-label="Сценарий работы McpGo">
          <button type="button" aria-pressed={scenario === "code"} className={scenario === "code" ? "is-selected" : ""} onClick={() => setScenario("code")}>
            <Code2 size={16} aria-hidden="true" /> Код и тесты
          </button>
          <button type="button" aria-pressed={scenario === "browser"} className={scenario === "browser" ? "is-selected" : ""} onClick={() => setScenario("browser")}>
            <Globe2 size={16} aria-hidden="true" /> Chrome и сайты
          </button>
        </div>
      </div>

      <div className="journey-board">
        <article className="journey-panel journey-panel-chat">
          <div className="journey-panel-top">
            <span className="journey-panel-index">01</span>
            <span className="journey-panel-type">ОБЛАКО / CHATGPT</span>
            <Cloud size={16} aria-hidden="true" />
          </div>
          <h3>Всё начинается в чате</h3>
          <p className="journey-panel-intro">Ты пишешь обычное сообщение. ChatGPT выбирает подключённый инструмент.</p>

          <div className="journey-conversation">
            <div className="journey-chat-user"><span className="journey-chat-avatar">ВЫ</span><span>{scene.prompt}</span></div>
            <div className="journey-chat-tool">
              <Sparkles size={17} aria-hidden="true" />
              <div><span>Вызов MCP-инструмента</span><code>{scene.tool}</code></div>
            </div>
            <div className="journey-chat-result">
              <CheckCircle2 size={17} aria-hidden="true" />
              <div><strong>Ответ в том же чате</strong><span>{scene.returnText}</span></div>
            </div>
          </div>
          <div className="journey-panel-bottom"><span className="journey-color-dot" /> Никакого отдельного окна для задач</div>
        </article>

        <div className="journey-connector" aria-label="MCP-запрос идёт к Mac, результат возвращается в ChatGPT">
          <div className="journey-direction journey-direction-request">
            <span>ЗАПРОС</span>
            <ArrowRight size={19} aria-hidden="true" />
            <ArrowDown size={19} aria-hidden="true" />
          </div>
          <div className="journey-direction journey-direction-return">
            <ArrowLeft size={19} aria-hidden="true" />
            <ArrowUp size={19} aria-hidden="true" />
            <span>ОТВЕТ</span>
          </div>
        </div>

        <article className="journey-panel journey-panel-tunnel">
          <div className="journey-panel-top">
            <span className="journey-panel-index">02</span>
            <span className="journey-panel-type">МОСТ / SECURE MCP</span>
            <LockKeyhole size={16} aria-hidden="true" />
          </div>
          <h3>Защищённый мост</h3>
          <p className="journey-panel-intro">OpenAI передаёт вызов по туннелю к локальной службе.</p>

          <div className="journey-tunnel-core">
            <div className="journey-cloud-node"><Cloud size={18} aria-hidden="true" /><div><strong>OpenAI</strong><span>Облачная сторона</span></div></div>
            <div className="journey-tunnel-spine"><span /><ArrowDown size={15} aria-hidden="true" /><span /></div>
            <div className="journey-tunnel-hub">
              <ShieldCheck size={18} aria-hidden="true" />
              <div><strong>Secure MCP Tunnel</strong><small>Два независимых подключения</small></div>
            </div>
            <div className="journey-tunnel-lanes">
              <div className={"journey-tunnel-lane " + (scenario === "code" ? "is-active" : "")}>
                <Terminal size={15} aria-hidden="true" /><span>Terminal Tunnel</span><span className="journey-lane-light" />
              </div>
              <div className={"journey-tunnel-lane " + (scenario === "browser" ? "is-active" : "")}>
                <Globe2 size={15} aria-hidden="true" /><span>Browser Tunnel</span><span className="journey-lane-light" />
              </div>
            </div>
          </div>
          <div className="journey-tunnel-outbound"><LockKeyhole size={14} aria-hidden="true"/> <span><strong>tunnel-client на Mac</strong> сам устанавливает исходящее соединение с OpenAI.</span></div>
        </article>

        <div className="journey-connector" aria-label="Вызов инструмента идёт на Mac, результат возвращается по туннелю">
          <div className="journey-direction journey-direction-request">
            <span>ВЫЗОВ</span>
            <ArrowRight size={19} aria-hidden="true" />
            <ArrowDown size={19} aria-hidden="true" />
          </div>
          <div className="journey-direction journey-direction-return">
            <ArrowLeft size={19} aria-hidden="true" />
            <ArrowUp size={19} aria-hidden="true" />
            <span>РЕЗУЛЬТАТ</span>
          </div>
        </div>

        <article className="journey-panel journey-panel-mac">
          <div className="journey-panel-top">
            <span className="journey-panel-index">03</span>
            <span className="journey-panel-type">ЛОКАЛЬНО / ТВОЙ MAC</span>
            <Monitor size={16} aria-hidden="true" />
          </div>
          <h3>Mac делает работу</h3>
          <p className="journey-panel-intro">McpGo управляет службами, а команды выполняются на твоём компьютере.</p>

          <div className="journey-mac-shell">
            <div className="journey-mac-title"><Monitor size={16} aria-hidden="true"/><strong>McpGo</strong><span>локальные службы</span></div>
            <div className={"journey-service " + (scenario === "code" ? "is-active" : "")}>
              <Terminal size={17} aria-hidden="true"/>
              <div><strong>TerminalHub</strong><span>Файлы, команды, тесты</span></div>
              <span className="journey-service-indicator" />
            </div>
            <div className={"journey-service " + (scenario === "browser" ? "is-active" : "")}>
              <Globe2 size={17} aria-hidden="true"/>
              <div><strong>PlaywrightHub</strong><span>Chrome через CDP и MCP-прокси</span></div>
              <span className="journey-service-indicator" />
            </div>
            <div className="journey-mac-action">
              <span><span className="journey-color-dot" /> ПРИМЕР ДЕЙСТВИЯ</span>
              <code>{scene.action}</code>
            </div>
          </div>
          <div className="journey-panel-bottom"><FileCode2 size={14} aria-hidden="true"/> Приложения и файлы остаются на Mac</div>
        </article>
      </div>

      <div className="journey-explain">
        <div className="journey-explain-heading">
          <div><span className="journey-mini-eyebrow">ПОЛНЫЙ ЦИКЛ</span><h3>Что происходит после твоего сообщения</h3></div>
          <span className="journey-explain-caption">Пример сценария, не реальный запуск</span>
        </div>
        <div className="journey-steps">
          {scene.steps.map((step, i) => (
            <div className="journey-step" key={i}>
              <span className="journey-step-number">{String(i + 1).padStart(2, "0")}</span>
              <strong>{step[0]}</strong>
              <span>{step[1]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="journey-facts">
        <div><ShieldCheck size={17} aria-hidden="true"/><span>Не нужны публичный IP и входящие порты</span></div>
        <div><KeyRound size={17} aria-hidden="true"/><span>Ключи доступа — в macOS Keychain</span></div>
        <div><MousePointer2 size={17} aria-hidden="true"/><span>Подключения и разрешения выбираешь ты</span></div>
      </div>
      <p className="journey-privacy">Важно: исходные файлы и приложения работают локально, но результаты вызванных инструментов передаются ChatGPT для обработки. McpGo не означает, что данные никогда не покидают компьютер.</p>
    </div>
  );
}
