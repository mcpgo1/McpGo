import AppKit
import SwiftUI
import Foundation

/// The wizard talks to a local Python setup engine over stdin/stdout.
/// Admin credentials travel only in stdin, never in process args or saved state.
private enum WizardBridge {
    enum Failure: LocalizedError {
        case failed(String)
        var errorDescription: String? { if case .failed(let s) = self { return s }; return nil }
    }
    static func perform(_ action: String, _ data: [String: Any] = [:]) async throws -> [String: Any] {
        let root = McpGoPaths.root
        let payload = try JSONSerialization.data(withJSONObject: data)
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
                p.arguments = [root + "/onboarding/cli.py", action]
                var environment=ProcessInfo.processInfo.environment
                environment["PATH"]="/opt/homebrew/bin:/usr/local/bin:" +
                    (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
                p.environment=environment
                let input = Pipe(), output = Pipe(), errors = Pipe()
                p.standardInput = input
                p.standardOutput = output
                p.standardError = errors
                do {
                    try p.run()
                    input.fileHandleForWriting.write(payload)
                    try? input.fileHandleForWriting.close()
                    let bytes = output.fileHandleForReading.readDataToEndOfFile()
                    p.waitUntilExit()
                    let answer = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] ?? [:]
                    if (answer["ok"] as? Bool) != true {
                        throw Failure.failed(answer["error"] as? String ?? "Настройка не выполнена.")
                    }
                    continuation.resume(returning: answer["result"] as? [String:Any] ?? [:])
                } catch {
                    // Never relay raw stderr from subprocesses: it may include user input.
                    continuation.resume(throwing: Failure.failed(
                        "Мастер не смог выполнить действие: " + error.localizedDescription))
                }
            }
        }
    }
}

@MainActor final class WizardModel: ObservableObject {
    @Published var page = 0
    @Published var busy = false
    @Published var note = ""
    @Published var error = ""
    @Published var phase = ""
    @Published var checks: [[String:Any]] = []
    @Published var terminalID = ""
    @Published var browserID = ""
    @Published var terminalReady = false
    @Published var browserReady = false
    @Published var chatgptVerified = false
    @Published var localConfigured = false
    @Published var localServicesInstalled = false
    @Published var remoteVerified = false
    @Published var pending = false
    private var restoredPage = false

    func refresh() async {
        do {
            let data = try await WizardBridge.perform("status")
            let preflight = data["preflight"] as? [String:Any] ?? [:]
            checks = preflight["checks"] as? [[String:Any]] ?? []
            phase = data["phase"] as? String ?? "preflight"
            if !restoredPage {
                restoredPage = true
                page = ["preflight":0, "authorization":1, "tunnels":2,
                        "local":3, "chrome":4, "chatgpt":5,
                        "verification":6][phase] ?? 0
            }
            localConfigured = data["localConfigured"] as? Bool ?? false
            localServicesInstalled = data["localServicesInstalled"] as? Bool ?? false
            pending = !(data["pending"] is NSNull) && data["pending"] != nil
            let tunnels = data["tunnels"] as? [String: [String:Any]] ?? [:]
            terminalID = tunnels["terminal"]?["id"] as? String ?? ""
            browserID = tunnels["browser"]?["id"] as? String ?? ""
            remoteVerified = ["terminal","browser"].allSatisfy {
                tunnels[$0]?["remoteVerified"] as? Bool == true
            }
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }
    func perform(_ action: String, data: [String:Any] = [:], onSuccess: Int? = nil) async {
        guard !busy else { return }
        busy = true
        note = ""
        error = ""
        defer { busy = false }
        do {
            let result = try await WizardBridge.perform(action, data)
            if action == "doctor" {
                let checks = result["checks"] as? [String:[String:Any]] ?? [:]
                note = "Doctor — Terminal: " +
                    ((checks["terminal"]?["ready"] as? Bool == true) ? "OK" : "нужна настройка") +
                    "; Browser: " +
                    ((checks["browser"]?["ready"] as? Bool == true) ? "OK" : "нужна настройка")
            } else if action == "verify-local" {
                terminalReady = result["terminal"] as? Bool ?? false
                browserReady = result["browser"] as? Bool ?? false
                note = result["blocker"] as? String ?? "Локальная диагностика выполнена."
            } else if action == "discover" {
                let arr = result["tunnels"] as? [[String:Any]] ?? []
                note = "В выбранной области найдено туннелей: " + String(arr.count)
            } else {
                note = action == "provision" ? "Туннели созданы или безопасно восстановлены." :
                       action == "import" ? "Tunnel ID сохранены. Подтвердите права на их использование." :
                       action == "configure" ? "Локальные профили созданы." :
                       action == "install" ? "Службы McpGo установлены." :
                       "Действие выполнено."
            }
            await refresh()
            if let onSuccess { page = onSuccess }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct OnboardingView: View {
    @StateObject private var model = WizardModel()
    @State private var mode = "create"
    @State private var organizationID = ""
    @State private var workspaceID = ""
    @State private var adminKey = ""
    @State private var runtimeKey = ""
    @State private var importedTerminal = ""
    @State private var importedBrowser = ""
    private let titles = [
        "Проверка Mac", "OpenAI и права", "Туннели",
        "Локальные службы", "Google Chrome", "ChatGPT", "Проверка"
    ]
    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:22) {
                HStack {
                    VStack(alignment:.leading,spacing:6) {
                        Text("FIRST RUN SETUP").font(.system(size:11,weight:.bold,design:.monospaced))
                            .tracking(1.8).foregroundStyle(Palette.accent)
                        Text("Подключение McpGo").font(.system(size:30,weight:.bold))
                            .foregroundStyle(Palette.ink)
                        Text("Шаг \(model.page+1) из \(titles.count) · \(titles[model.page])")
                            .foregroundStyle(Palette.muted)
                    }
                    Spacer()
                    Button { Task { await model.refresh() } } label: {
                        Label("Обновить",systemImage:"arrow.clockwise")
                    }.buttonStyle(HubInteractiveButtonStyle())
                }
                HStack(spacing:7) {
                    ForEach(titles.indices,id:\.self) { index in
                        Button { model.page=index } label: {
                            RoundedRectangle(cornerRadius:3)
                                .fill(index <= model.page ? Palette.accent : Palette.stroke)
                                .frame(height:6)
                        }.buttonStyle(.plain).help(titles[index])
                    }
                }
                VStack(alignment:.leading,spacing:15) {
                    switch model.page {
                    case 0: systemStep
                    case 1: accountStep
                    case 2: tunnelStep
                    case 3: localStep
                    case 4: chromeStep
                    case 5: chatgptStep
                    default: finalStep
                    }
                }
                .padding(22)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(Palette.panel,in:RoundedRectangle(cornerRadius:16))
                .overlay(RoundedRectangle(cornerRadius:16).stroke(Palette.stroke))
                if !model.error.isEmpty {
                    Label(model.error,systemImage:"exclamationmark.triangle.fill")
                        .foregroundStyle(Palette.red).textSelection(.enabled)
                }
                if !model.note.isEmpty {
                    Label(model.note,systemImage:"info.circle")
                        .foregroundStyle(Palette.online).textSelection(.enabled)
                }
                HStack {
                    Button("Назад") { model.page=max(0,model.page-1) }
                        .disabled(model.page==0||model.busy)
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    Button(model.page == titles.count-1 ? "К началу" : "Далее") {
                        model.page = model.page == titles.count-1 ? 0 : model.page+1
                    }.disabled(model.busy)
                }
                .font(.system(size:13))
            }
            .padding(28)
        }
        .background(Palette.background)
        .task { await model.refresh() }
    }

    private var systemStep: some View {
        VStack(alignment:.leading,spacing:12) {
            heading("1. Проверка системы", "Не устанавливаем ничего без подтверждения.")
            ForEach(Array(model.checks.enumerated()),id:\.offset) { _,check in
                HStack(spacing:9) {
                    Image(systemName:(check["ok"] as? Bool == true) ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .foregroundStyle(check["ok"] as? Bool == true ? Palette.online : Palette.warning)
                    Text(check["detail"] as? String ?? "Компонент")
                        .foregroundStyle(Palette.ink)
                    Spacer()
                }.font(.system(size:12))
            }
            Button("Проверить снова") { Task { await model.refresh() } }
            Button("Установить Playwright из package-lock.json") {
                Task {
                    await model.perform("install-deps",data:["confirmed":true])
                }
            }.disabled(model.busy)
            Text("Зависимости загружаются только после нажатия этой кнопки. При конфликте с другой локальной установкой загрузка блокируется.")
                .font(.system(size:11)).foregroundStyle(Palette.muted)

            Text("Если Node.js или Playwright не установлены, мастер покажет действия; ничего не скачивает скрытно.")
                .font(.system(size:11)).foregroundStyle(Palette.quiet)
        }
    }

    private var accountStep: some View {
        VStack(alignment:.leading,spacing:13) {
            heading("2. OpenAI Platform","Для создания требуется Tunnels Read + Manage. Для работы — Read + Use.")
            TextField("Organization ID · org_…",text:$organizationID)
                .textFieldStyle(.roundedBorder)
            TextField("Workspace ID · ws_… (если нужен)",text:$workspaceID)
                .textFieldStyle(.roundedBorder)
            SecureField("Admin API Key — только на время создания",text:$adminKey)
                .textFieldStyle(.roundedBorder).privacySensitive()
            HStack {
                Button("Открыть туннели Platform") {
                    NSWorkspace.shared.open(URL(string:"https://platform.openai.com/settings/organization/tunnels")!)
                }
                Button("Проверить список") {
                    Task {
                        await model.perform("discover",data:[
                            "organizationId":organizationID,"workspaceId":workspaceID,"adminKey":adminKey
                        ])
                    }
                }.disabled(adminKey.isEmpty||model.busy)
            }
            Text("Admin key не сохраняется в конфигурации, логах или командной строке. Вход в ChatGPT не предоставляет права Platform API автоматически.")
                .font(.system(size:11)).foregroundStyle(Palette.muted)
        }
    }

    private func heading(_ title:String,_ detail:String) -> some View {
        VStack(alignment:.leading,spacing:6) {
            Text(title).font(.system(size:20,weight:.semibold)).foregroundStyle(Palette.ink)
            Text(detail).font(.system(size:12)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)
        }
    }

    private var tunnelStep: some View {
        VStack(alignment:.leading,spacing:14) {
            heading("3. Туннели","Используйте два независимых Tunnel ID для терминала и Chrome.")
            Picker("Режим",selection:$mode) {
                Text("Создать автоматически").tag("create")
                Text("Подключить существующие").tag("import")
            }.pickerStyle(.segmented)
            if mode == "create" {
                Text("McpGo сначала ищет существующие туннели. При неизвестном результате создания автоматический повтор запрещён.")
                    .font(.system(size:12)).foregroundStyle(Palette.muted)
                Button("Создать или найти туннели") {
                    Task {
                        await model.perform("provision",data:[
                            "confirmed":true,"organizationId":organizationID,
                            "workspaceId":workspaceID,"adminKey":adminKey
                        ])
                        adminKey=""
                    }
                }.disabled(model.busy || adminKey.isEmpty || (organizationID.isEmpty && workspaceID.isEmpty))
                if model.pending {
                    Label("Предыдущая операция требует сверки с OpenAI Platform.",systemImage:"exclamationmark.triangle")
                        .foregroundStyle(Palette.warning)
                }
            } else {
                TextField("Terminal Tunnel ID · tunnel_…",text:$importedTerminal)
                    .textFieldStyle(.roundedBorder)
                TextField("Browser Tunnel ID · tunnel_…",text:$importedBrowser)
                    .textFieldStyle(.roundedBorder)
                Button("Импортировать Tunnel ID") {
                    Task {
                        await model.perform("import",data:[
                            "confirmed":true,"terminalId":importedTerminal,"browserId":importedBrowser
                        ])
                    }
                }.disabled(importedTerminal.isEmpty||importedBrowser.isEmpty||model.busy)
            }
            if !model.terminalID.isEmpty || !model.browserID.isEmpty {
                Divider()
                Text("Терминал: \(model.terminalID.isEmpty ? "не настроен" : model.terminalID)")
                    .textSelection(.enabled)
                Text("Браузер: \(model.browserID.isEmpty ? "не настроен" : model.browserID)")
                    .textSelection(.enabled)
                Label(model.remoteVerified ? "OpenAI metadata проверены" :
                      "Импортированные ID требуют отдельной проверки прав",
                      systemImage:model.remoteVerified ? "checkmark.shield" : "info.circle")
                    .foregroundStyle(model.remoteVerified ? Palette.online : Palette.warning)
            }
            Divider()
            SecureField("Runtime API Key · Tunnels Read + Use",text:$runtimeKey)
                .textFieldStyle(.roundedBorder).privacySensitive()
            HStack {
                Button("Проверить Tunnel ID") {
                    Task {
                        await model.perform("verify-remote",data:[
                            "runtimeKey":runtimeKey,"adminKey":adminKey
                        ])
                    }
                }.disabled((runtimeKey.isEmpty&&adminKey.isEmpty)||model.busy)
                Button("Сохранить доступ и настроить профили") { configureTunnelProfiles() }
                    .disabled(model.terminalID.isEmpty||model.browserID.isEmpty||model.busy)
            }
            Text("Runtime key сохраняется в Keychain. Профили содержат ссылку env:CONTROL_PLANE_API_KEY; admin key не сохраняется.")
                .font(.system(size:11)).foregroundStyle(Palette.muted)
            if model.localConfigured {
                Label("Локальные профили созданы",systemImage:"checkmark.circle")
                    .foregroundStyle(Palette.online)
            }
        }
    }

    private func configureTunnelProfiles() {
        Task {
            do {
                // Before touching shared Keychain services, verify this install
                // owns the local LaunchAgents and ports.
                _ = try await WizardBridge.perform("check-ownership")
                if !runtimeKey.isEmpty {
                    try PrivateKeychain.save(service:TunnelPaths.terminalService,value:runtimeKey)
                    try PrivateKeychain.save(service:TunnelPaths.browserService,value:runtimeKey)
                    runtimeKey=""
                } else if !PrivateKeychain.exists(TunnelPaths.terminalService) ||
                            !PrivateKeychain.exists(TunnelPaths.browserService) {
                    model.error="Укажите ограниченный runtime API key для обоих туннелей."
                    return
                }
                await model.perform("configure",data:["confirmed":true],onSuccess:3)
            } catch {
                model.error = "Keychain: " + error.localizedDescription
            }
        }
    }

    private var localStep: some View {
        VStack(alignment:.leading,spacing:13) {
            heading("4. Службы macOS","Только пользовательские LaunchAgents, без sudo.")
            Text(model.localConfigured ? "Профили готовы. Можно установить локальные службы." :
                 "Сначала настройте профили туннелей на предыдущем шаге.")
                .foregroundStyle(Palette.muted)
            Label("Проверяются конфликты портов и принадлежность каждой службы.",
                  systemImage:"lock.shield").font(.system(size:12))
            Label("Другие установки McpGo не перезаписываются и не останавливаются.",
                  systemImage:"info.circle").font(.system(size:12))
            Button("Установить локальные службы") {
                Task { await model.perform("install",data:["confirmed":true],onSuccess:4) }
            }.disabled(!model.localConfigured||model.busy)
            if model.localServicesInstalled {
                Label("Службы установлены",systemImage:"checkmark.circle")
                    .foregroundStyle(Palette.online)
            }
            Text("При конфликте другой установки операция блокируется. Миграция — отдельное явное действие.")
                .font(.system(size:11)).foregroundStyle(Palette.quiet)
        }
    }

    private var chromeStep: some View {
        VStack(alignment:.leading,spacing:13) {
            heading("5. Личный Chrome","Playwright использует уже открытый Google Chrome.")
            Text("Разрешите remote debugging вручную. McpGo не обходит системные подтверждения.")
                .foregroundStyle(Palette.muted)
            HStack {
                Button("Запустить Terminal MCP") {
                    Task { await model.perform("start-local",
                        data:["confirmed":true,"group":"terminal"]) }
                }
                Button("Запустить Playwright и туннель") {
                    Task { await model.perform("start-local",
                        data:["confirmed":true,"group":"playwright"]) }
                }
            }.disabled(model.busy || !model.localServicesInstalled)
            Button("Открыть настройки Chrome CDP") {
                NSWorkspace.shared.open(URL(string:"chrome://inspect/#remote-debugging")!)
            }
            Button("Проверить локальные MCP") {
                Task { await model.perform("verify-local") }
            }.disabled(model.busy)
            HStack {
                Label("Terminal: \(model.terminalReady ? "готов" : "не подтверждён")",
                      systemImage:model.terminalReady ? "checkmark.circle" : "circle.dotted")
                Spacer()
                Label("Browser: \(model.browserReady ? "готов" : "не подтверждён")",
                      systemImage:model.browserReady ? "checkmark.circle" : "circle.dotted")
            }.font(.system(size:12))
            Text("Открытый локальный порт НЕ подтверждает удалённый вызов из ChatGPT.")
                .font(.system(size:11)).foregroundStyle(Palette.warning)
        }
    }

    private var chatgptStep: some View {
        VStack(alignment:.leading,spacing:13) {
            heading("6. Подключение в ChatGPT","Подтверждение выполняется в ChatGPT Plugins.")
            Text("Откройте Plugins → Add custom MCP server → Connection: Tunnel. Выберите туннель и разрешите инструменты.")
                .foregroundStyle(Palette.muted)
            HStack {
                Button("Открыть ChatGPT") {
                    NSWorkspace.shared.open(URL(string:"https://chatgpt.com/#settings/Connectors")!)
                }
                Button("Я ознакомился с инструкцией") {
                    Task { await model.perform("chatgpt-instructions",
                        data:["confirmed":true],onSuccess:6) }
                }
            }
            Text("Terminal выполняет команды с правами пользователя Mac. Browser может работать в уже авторизованных вкладках.")
                .font(.system(size:12)).foregroundStyle(Palette.warning)
            Text("Вход в ChatGPT не является административной API-авторизацией. Cookies не извлекаются.")
                .font(.system(size:11)).foregroundStyle(Palette.quiet)
        }
    }

    private var finalStep: some View {
        VStack(alignment:.leading,spacing:13) {
            heading("7. Проверка готовности","Только безопасные read-only MCP-вызовы.")
            HStack {
                Button("Проверить локальные MCP") {
                    Task { await model.perform("verify-local") }
                }
                Button("Проверить tunnel-client doctor") {
                    Task { await model.perform("doctor") }
                }
            }.disabled(model.busy)
            Label("Terminal: \(model.terminalReady ? "MCP tools/list доступен" : "ожидает проверки")",
                  systemImage:model.terminalReady ? "checkmark.circle" : "circle")
            Label("Browser: \(model.browserReady ? "MCP tools/list доступен" : "ожидает проверки")",
                  systemImage:model.browserReady ? "checkmark.circle" : "circle")
            Divider()
            Label("ChatGPT: требуется фактический вызов инструмента из подключённого разговора",
                  systemImage:"exclamationmark.shield").foregroundStyle(Palette.warning)
            Text("Локальный MCP, работающий туннель и вызов из ChatGPT — три разные проверки. Мастер не объявляет полное подключение по одному открытому порту.")
                .font(.system(size:12)).foregroundStyle(Palette.muted)
            Text("Для проверки вызовите read-only terminal_exec (pwd) или browser_tabs(list) из ChatGPT. Если не работает — проверьте права и workspace.")
                .font(.system(size:12)).foregroundStyle(Palette.ink)
            Button("Продолжить без подтверждения ChatGPT") {
                Task { await model.perform("dismiss",data:["confirmed":true]) }
            }
            .disabled(model.busy)
            Text("Эта кнопка только скрывает мастер при следующем запуске. Доступность ChatGPT остаётся неподтверждённой.")
                .font(.system(size:11)).foregroundStyle(Palette.quiet)
        }
    }
}
