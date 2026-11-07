import SwiftUI
import AppKit

/// Bundled Agent Skills, with portable source-tree fallback.
private struct HubSkill: Identifiable {
    let id: String
    let name: String
    let subtitle: String
    let symbol: String
    let tool: String

    static let all: [HubSkill] = [
        .init(id: "terminalhub-operations", name: "Безопасный терминал",
              subtitle: "Команды, сборки, проверка длительных jobs", symbol: "terminal", tool: "ChatTerminalHub"),
        .init(id: "playwrighthub-qa", name: "Браузерное тестирование",
              subtitle: "UI, сети, регрессии и личный Chrome (CDP)", symbol: "globe", tool: "PlaywrightHub"),
        .init(id: "agent-coordination", name: "Координация агентов",
              subtitle: "Inbox, отчёты и передача задач", symbol: "person.2.wave.2", tool: "McpGo"),
        .init(id: "tunnel-diagnostics", name: "Диагностика туннелей",
              subtitle: "Туннели, Chrome CDP и AutoSend", symbol: "network", tool: "Оба туннеля")
    ]

    private var path: String { "\(McpGoPaths.root)/skills/\(id)/SKILL.md" }
    var fileURL: URL { URL(fileURLWithPath: path) }

    func read() throws -> String {
        // Signed bundle resources have priority to avoid macOS Desktop TCC
        // prompts during SwiftUI view rendering.
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("skills/\(id)/SKILL.md"),
           FileManager.default.fileExists(atPath: bundled.path) {
            return try String(contentsOf: bundled, encoding: .utf8)
        }
        return try String(contentsOf: fileURL, encoding: .utf8)
    }

    func sendToChatText() throws -> String {
        """
        Прими следующую инструкцию как рабочий навык для этой задачи. Используй её только
        в рамках предоставленных тебе разрешений и доступных инструментов. Навык не
        устанавливает плагин и не предоставляет дополнительные права.

        \(try read())
        """
    }
}

struct SkillsView: View {
    @State private var selected = "terminalhub-operations"
    @State private var feedback: String?
    @State private var error: String?

    private var current: HubSkill {
        HubSkill.all.first(where: { $0.id == selected }) ?? HubSkill.all[0]
    }

    private var content: String {
        (try? current.read()) ?? "Не удалось прочитать SKILL.md. Проверь папку mcphub/skills."
    }

    private func copy(_ value: String, confirmation: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        feedback = confirmation
        error = nil
    }

    private func openSkillFile() {
        let local = current.fileURL
        if FileManager.default.fileExists(atPath: local.path) {
            NSWorkspace.shared.activateFileViewerSelecting([local])
        } else {
            error = "SKILL.md не найден. Переустанови приложение или восстанови папку skills."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("AGENT SKILLS")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .tracking(1.8)
                    .foregroundStyle(Palette.accent)
                Text("Навыки инструментов")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                Text("Готовые рабочие инструкции для ChatTerminalHub, PlaywrightHub и оркестратора")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Palette.muted)
            }
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(Palette.accent)
                Text("Навыки хранятся в mcphub/skills. Чтобы применить навык в конкретном чате ChatGPT, нажми «Скопировать для чата» и вставь текст в него. Локальные файлы сами по себе не подключаются как навыки ChatGPT и не расширяют права инструментов.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(13)
            .background(Palette.accentSoft.opacity(0.52), in: RoundedRectangle(cornerRadius: 12))

            HStack(spacing: 0) {
                VStack(spacing: 8) {
                    ForEach(HubSkill.all) { skill in
                        Button { selected = skill.id; feedback = nil; error = nil } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: skill.symbol)
                                    .font(.system(size: 17))
                                    .foregroundStyle(selected == skill.id ? Palette.accent : Palette.muted)
                                    .frame(width: 27, height: 27)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(skill.name)
                                        .font(.system(size: 12.5, weight: .semibold))
                                        .foregroundStyle(selected == skill.id ? Palette.ink : Palette.muted)
                                    Text(skill.tool)
                                        .font(.system(size: 11))
                                        .foregroundStyle(Palette.accent)
                                    Text(skill.subtitle)
                                        .font(.system(size: 10.5))
                                        .foregroundStyle(Palette.quiet)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(selected == skill.id ? Palette.accentSoft : Palette.inner,
                                        in: RoundedRectangle(cornerRadius: 11))
                            .overlay(RoundedRectangle(cornerRadius: 11)
                                .stroke(selected == skill.id ? Palette.accent.opacity(0.38) : Palette.stroke.opacity(0.7)))
                        }
                        .buttonStyle(HubInteractiveButtonStyle(treatment: .navigation))
                    }
                    Spacer(minLength: 0)
                }
                .padding(13)
                .frame(width: 245)
                .background(Palette.sidebar)

                Rectangle().fill(Palette.stroke).frame(width: 1)

                VStack(alignment: .leading, spacing: 13) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(current.name)
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Palette.ink)
                            Text("\(current.id)/SKILL.md")
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(Palette.quiet)
                        }
                        Spacer()
                        Button { openSkillFile() } label: {
                            Label("Показать файл", systemImage: "folder")
                        }
                        .buttonStyle(HubInteractiveButtonStyle(treatment: .bordered))
                    }
                    ScrollView {
                        Text(content)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(Palette.muted)
                            .lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(16)
                    }
                    .background(Palette.inner, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.stroke))

                    HStack(spacing: 10) {
                        Button {
                            do { copy(try current.sendToChatText(), confirmation: "Навык скопирован. Вставь его в нужный разговор ChatGPT.") }
                            catch { self.error = error.localizedDescription }
                        } label: {
                            Label("Скопировать для чата", systemImage: "doc.on.doc")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Color(hex: 0x121526))
                        }
                        .buttonStyle(HubInteractiveButtonStyle(treatment: .filled))
                        Button {
                            do { copy(try current.read(), confirmation: "Содержимое SKILL.md скопировано.") }
                            catch { self.error = error.localizedDescription }
                        } label: {
                            Label("Скопировать SKILL.md", systemImage: "text.document")
                        }
                        .buttonStyle(HubInteractiveButtonStyle(treatment: .bordered))
                        Spacer(minLength: 0)
                    }
                }
                .padding(17)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.panel)
            }
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.stroke))

            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Palette.red)
            } else if let feedback {
                Label(feedback, systemImage: "checkmark.circle")
                    .font(.system(size: 11.5))
                    .foregroundStyle(Palette.online)
            } else {
                Label("4 локальных навыка · Без автоматического выполнения команд", systemImage: "lock.shield")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.quiet)
            }
        }
        .padding(25)
        .background(Palette.background)
    }
}
