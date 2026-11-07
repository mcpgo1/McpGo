# McpGo Skills

Навыки для повторяемой работы с существующими MCP-инструментами. Каждый навык — отдельная папка с `SKILL.md` и YAML frontmatter (name, description).

1. terminalhub-operations — безопасные команды Mac и длительные jobs
2. playwrighthub-qa — браузерное QA через PlaywrightHub
3. agent-coordination — связь агентов и handoff оркестратору
4. tunnel-diagnostics — восстановление двух Secure MCP Tunnel, Chrome CDP и AutoSend

В приложении есть вкладка **Навыки** для просмотра и копирования текста в ChatGPT. Они **не устанавливаются автоматически в ChatGPT** простым присутствием на Mac и не дают дополнительных полномочий. Для использования передайте инструкцию в конкретный чат или подключите навык отдельно в поддерживаемом Plugin.

## Текущая архитектура · 06.11.2026
PlaywrightHub использует уже открытый личный Chrome по CDP. AutoSend доставляет сообщения по расписанию через Playwright MCP и safe proxy, а не через Chrome Extension. ChatTerminalHub tunnel запускается из ~/Library/Application Support/ChatTerminalHub. Тексты навыков следует встраивать в ресурсы и заново подписывать McpGo.app после обновления.
