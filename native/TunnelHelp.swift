import SwiftUI
import AppKit

/// Local setup help. Verified against the official Secure MCP Tunnel guide on 2026-10-30.
/// Never reads or displays credentials.
enum TunnelGuideKind: String, Identifiable {
    case terminal, playwright
    var id: String { rawValue }
    var name: String { self == .terminal ? "TerminalHub" : "Playwright" }
    var icon: String { self == .terminal ? "terminal" : "globe" }
    var proposedName: String { self == .terminal ? "McpGo — TerminalHub" : "McpGo — Playwright" }
    var keyName: String { self == .terminal ? "McpGo TerminalHub runtime" : "McpGo Playwright runtime" }
    var pluginName: String { self == .terminal ? "ChatTerminalHub" : "PlaywrightHub" }
}

private enum GuideLinks {
    static let tunnels = URL(string: "https://platform.openai.com/settings/organization/tunnels")!
    static let keys = URL(string: "https://platform.openai.com/settings/organization/api-keys")!
    static let roles = URL(string: "https://platform.openai.com/settings/organization/people/roles")!
    static let plugins = URL(string: "https://chatgpt.com/#settings/Connectors")!
    static let docs = URL(string: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels")!
}

private struct GuideStep: Identifiable {
    let id: Int
    let title: String
    let detail: String
    var warning: String? = nil
    var action: String? = nil
    var url: URL? = nil
}

private struct GuideStepCard: View {
    let step: GuideStep
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(String(format: "%02d", step.id))
                .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                .foregroundStyle(Palette.accent)
                .frame(width: 39, height: 39)
                .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 9) {
                Text(step.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.ink)
                Text(step.detail)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Palette.muted)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if let warning = step.warning {
                    Label(warning, systemImage: "exclamationmark.shield")
                        .font(.system(size: 11.5))
                        .foregroundStyle(Palette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let label = step.action, let url = step.url {
                    Button { NSWorkspace.shared.open(url) } label: {
                        Label(label, systemImage: "arrow.up.right.square")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(Palette.accent)
                    }
                    .buttonStyle(HubInteractiveButtonStyle(treatment: .bordered))
                    .help(url.absoluteString)
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.panel, in: RoundedRectangle(cornerRadius: 13))
        .overlay(RoundedRectangle(cornerRadius: 13).stroke(Palette.stroke.opacity(0.8)))
    }
}

struct TunnelInstructionView: View {
    let kind: TunnelGuideKind
    @Environment(\.dismiss) private var dismiss

    private var localServer: String {
        kind == .terminal
        ? "ChatTerminalHub уже установлен: Command server, OneShot/jobs и профиль chat-terminal-hub.yaml. Новый локальный MCP-сервер создавать не надо."
        : "Личный Chrome через CDP (порт MCP 8931) и Safe proxy (127.0.0.1:8940/mcp) уже настроены. В туннель подключается только Safe proxy, не прямой браузерный MCP."
    }

    private var steps: [GuideStep] {
        [
            GuideStep(id: 1, title: "Подготовь организацию и права",
                detail: "Войди в OpenAI Platform под нужным аккаунтом. Выбери организацию Platform и целевое пространство ChatGPT. Для создания туннеля требуются Tunnels Read + Manage, для запуска и использования — Tunnels Read + Use. Если раздел недоступен, попроси владельца организации назначить роль через Organization → People → Roles / Groups. Изменения прав могут распространяться до 30 минут.",
                action: "Проверить роли в Platform", url: GuideLinks.roles),
            GuideStep(id: 2, title: "Создай Tunnel ID для \(kind.name)",
                detail: "Platform → Settings → Organization → Tunnels → Create tunnel. Введи название «\(kind.proposedName)» и описание «Private MCP on my Mac · \(kind.name)». В ассоциациях укажи организацию Platform и ChatGPT workspace, в котором планируешь использовать плагин. Сохрани туннель и скопируй выданный идентификатор tunnel_…. Если подходящий туннель уже создан, его можно переиспользовать вместо создания нового.",
                warning: "Для TerminalHub и Playwright рекомендуется по одному отдельному Tunnel ID. Публичный домен и входящие порты для Secure MCP Tunnel не нужны.",
                action: "Открыть управление туннелями", url: GuideLinks.tunnels),
            GuideStep(id: 3, title: "Создай runtime API-ключ",
                detail: "Platform → Settings → Organization → API keys (Runtime API keys) → Create. Имя ключа «\(kind.keyName)». Выбери Restricted. Разрешения для Tunnels: Read + Use. Остальные API-разрешения не требуются. Скопируй секретный ключ при создании и сохрани его только в McpGo. Лучше выдать отдельный ключ для каждого из двух туннелей.",
                warning: "Не выбирай All permissions и не используй Organization Admin API key. Admin-ключ нужен лишь для административного создания или изменения туннелей.",
                action: "Открыть runtime API keys", url: GuideLinks.keys),
            GuideStep(id: 4, title: "Заполни настройки McpGo",
                detail: "Вернись в Настройки туннелей → \(kind.name). В поле TUNNEL ID вставь идентификатор из шага 2, а в API KEY — ключ из шага 3. Нажми «Сохранить». McpGo хранит новый ключ в Keychain macOS, а Tunnel ID — в защищённой конфигурации. Если изменяешь только Tunnel ID, оставь поле нового API-ключа пустым.",
                warning: "Никому не отправляй API-ключ в чат, скриншот, Git или лог. Нажатие «Сохранить» само по себе не перезапускает работающий туннель."),
            GuideStep(id: 5, title: "Примени конфигурацию и проверь локальный MCP",
                detail: "Нажми «Переподключить туннель» и подтверди действие. В разделе «Обзор» проверь активные процессы. \(kind == .terminal ? "Для TerminalHub должны работать Command server, OneShot/jobs и Secure MCP tunnel." : "Для Playwright должны работать Личный Chrome по CDP (8931), Safe proxy (8940) и Secure MCP tunnel. Внешний туннель должен направляться на 127.0.0.1:8940/mcp.") Также нужен исходящий HTTPS к api.openai.com:443.",
                warning: kind == .terminal ? "Переподключение терминального туннеля может временно прервать доступ текущего чата к Mac." : "Не подключай ChatGPT напрямую к браузерному MCP на порту 8931 — используется безопасный прокси на 8940."),
            GuideStep(id: 6, title: "Подключи туннель к ChatGPT",
                detail: "В ChatGPT открой Plugins → «+» → Add custom MCP server. Название: «\(kind.pluginName)». В Connection выбери Tunnel, затем нужный туннель из списка или вставь тот же tunnel_…. Настрой Authentication по требованиям самого MCP-сервера (это НЕ runtime API-ключ tunnel-client). Прочитай предупреждение о рисках, отметь «I understand and want to continue», нажми «Create as a plugin». Если плагин уже подключён, сначала проверь его существующие настройки.",
                action: "Открыть настройки Plugins в ChatGPT", url: GuideLinks.plugins),
            GuideStep(id: 7, title: "Проверь инструменты и соединение",
                detail: "В ChatGPT выбери этот плагин и проверь безопасный инструмент. Если туннель не отображается, проверь его ассоциацию с workspace и Tunnels Read + Use. Если список инструментов пуст или запросы не проходят, проверь логи соответствующего туннеля в McpGo и документацию. Статус «Процесс запущен» подтверждает только локальный процесс, но не полноценную связь с OpenAI.",
                action: "Официальное руководство Secure MCP Tunnel", url: GuideLinks.docs)
        ]
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 13) {
                Image(systemName: kind.icon)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(Palette.accent)
                    .frame(width: 49, height: 49)
                    .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 13))
                VStack(alignment: .leading, spacing: 5) {
                    Text("SECURE MCP TUNNEL · ПОШАГОВО")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .tracking(1.2)
                        .foregroundStyle(Palette.accent)
                    Text("Инструкция · \(kind.name)")
                        .font(.system(size: 21, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                }
                Spacer()
                Button("Готово") { dismiss() }
                    .buttonStyle(HubInteractiveButtonStyle(treatment: .bordered))
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)

            Rectangle().fill(Palette.stroke).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 13) {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "checkmark.shield.fill")
                            .foregroundStyle(Palette.online)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Что уже готово на этом Mac")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Palette.ink)
                            Text(localServer)
                                .font(.system(size: 12))
                                .foregroundStyle(Palette.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(14)
                    .background(Palette.accentSoft.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))

                    ForEach(steps) { step in
                        GuideStepCard(step: step)
                    }

                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "info.circle")
                            .foregroundStyle(Palette.accent)
                        Text("Руководство сверено с официальной документацией OpenAI на 30.10.2026. Интерфейс OpenAI Platform/ChatGPT со временем может меняться. Приложение не создаёт туннели и API-ключи за тебя — только помогает настроить уже созданные.")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Palette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 17)
            }
            Rectangle().fill(Palette.stroke).frame(height: 1)
            HStack {
                Label("API-ключи не отображаются в инструкции", systemImage: "lock.shield")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.quiet)
                Spacer()
                Button("Закрыть инструкцию") { dismiss() }
                    .buttonStyle(HubInteractiveButtonStyle(treatment: .bordered))
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
        }
        .frame(width: 770, height: 735)
        .background(Palette.background)
        .preferredColorScheme(.dark)
    }
}
