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
                let bundledPython = root + "/vendor/python/bin/python3"
                let executable = FileManager.default.isExecutableFile(atPath: bundledPython)
                    ? bundledPython : "/usr/bin/python3"
                p.executableURL = URL(fileURLWithPath: executable)
                p.arguments = [root + "/onboarding/cli.py", action]
                var environment=ProcessInfo.processInfo.environment
                let bundledBins = ["/vendor/node/bin", "/vendor/python/bin", "/vendor/tunnel/bin"]
                    .map { root + $0 }.joined(separator: ":")
                environment["PATH"]=bundledBins + ":/opt/homebrew/bin:/usr/local/bin:" +
                    (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
                environment["MCPGO_PYTHON_BIN"] = executable
                environment["MCPGO_TUNNEL_CLIENT"] = root + "/vendor/tunnel/bin/tunnel-client"
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
    @Published var browserMcpReady = false
    @Published var browserDetail = ""
    @Published var chatgptVerified = false
    @Published var localConfigured = false
    @Published var localServicesInstalled = false
    @Published var remoteVerified = false
    @Published var pending = false
    @Published var runtimeProjectSelected = false
    @Published var runtimeOperationPending = ""
    @Published var runtimeKeyIssuanceStatus = ""
    @Published var runtimeKeyRecoveryAttempted = false
    private var restoredPage = false

    func navigate(to target: Int) {
        page = max(0, min(6, target))
        note = ""
        error = ""
    }

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
            let runtimeProgress = data["runtimeProvision"] as? [String:Any] ?? [:]
            runtimeProjectSelected = runtimeProgress["projectSelected"] as? Bool ?? false
            runtimeOperationPending = runtimeProgress["pending"] as? String ?? ""
            runtimeKeyIssuanceStatus = runtimeProgress["status"] as? String ?? ""
            runtimeKeyRecoveryAttempted = runtimeProgress["keyRecoveryAttempted"] as? Bool ?? false
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
                browserMcpReady = result["browserMcp"] as? Bool ?? false
                browserDetail = result["browserDetail"] as? String ?? ""
                note = result["blocker"] as? String ??
                       (browserReady ? "Локальные MCP и доступ к вкладкам Chrome подтверждены."
                        : browserDetail.isEmpty ? "Локальная диагностика выполнена."
                        : browserDetail)
            } else if action == "discover" {
                let arr = result["tunnels"] as? [[String:Any]] ?? []
                note = "В выбранной области найдено туннелей: " + String(arr.count)
            } else if action == "start-local" {
                // Launching a service does not automatically mean its local
                // MCP endpoint is healthy. Immediately perform a read-only
                // MCP handshake so step 5 reflects what actually works.
                if let checks = try? await WizardBridge.perform("verify-local") {
                    terminalReady = checks["terminal"] as? Bool ?? false
                    browserReady = checks["browser"] as? Bool ?? false
                    browserMcpReady = checks["browserMcp"] as? Bool ?? false
                    browserDetail = checks["browserDetail"] as? String ?? ""
                    let group = data["group"] as? String ?? ""
                    let expectedReady = group == "terminal" ? terminalReady : browserReady
                    note = expectedReady
                        ? (group == "terminal"
                            ? "Terminal MCP работает локально. Туннель к ChatGPT проверяется отдельно."
                            : "Browser MCP и доступ к вкладкам Chrome подтверждены.")
                        : (browserMcpReady && group == "playwright"
                            ? browserDetail
                            : "Команда запуска выполнена, но MCP ещё не ответил. " +
                              "Нажми «Проверить локальные MCP».")
                } else {
                    note = "Команда запуска выполнена, но проверка MCP временно недоступна."
                }
            } else {
                note = action == "provision" ? "Туннели созданы или безопасно восстановлены." :
                       action == "import" ? "Tunnel ID сохранены. Подтвердите права на их использование." :
                       action == "configure" ? "Runtime API Key сохранён в Keychain, профили настроены. Теперь запускаем локальные службы." :
                       action == "install" ? "Службы McpGo установлены." :
                       action == "install-deps" ? "Зависимости Playwright проверены и установлены." :
                       action == "start-local" ? "Команда запуска локальных служб выполнена. Проверьте их доступность." :
                       action == "chatgpt-instructions" ? "Инструкция ChatGPT подтверждена." :
                       action == "dismiss" ? "Мастер можно открыть снова из McpGo." : ""
            }
            await refresh()
            if let onSuccess { page = onSuccess }
        } catch {
            self.error = error.localizedDescription
            // A failed browser startup must not make an already working
            // Terminal appear offline. Refresh read-only MCP readiness after
            // any failed start, without retrying the launch action.
            if action == "start-local",
               let verified = try? await WizardBridge.perform("verify-local") {
                terminalReady = verified["terminal"] as? Bool ?? false
                browserReady = verified["browser"] as? Bool ?? false
                browserMcpReady = verified["browserMcp"] as? Bool ?? false
                browserDetail = verified["browserDetail"] as? String ?? ""
            }
        }
    }
}

private struct RuntimeProject: Identifiable {
    let id: String
    let name: String
}

struct OnboardingView: View {
    @StateObject private var model = WizardModel()
    @State private var mode = "create"
    @State private var organizationID = ""
    @State private var workspaceID = ""
    @State private var adminKey = ""
    @State private var runtimeKey = ""
    @State private var showTunnelDetails = false
    @State private var changeTunnels = false
    @State private var replaceRuntimeKey = false
    @State private var runtimeMode = "auto"
    @State private var runtimeProjects: [RuntimeProject] = []
    @State private var showAdminKeyGuide = false
    @State private var showChatGPTFormGuide = false
    @State private var showChatGPTNextSteps = false
    @State private var runtimeProjectsLoaded = false
    @State private var keyInventoryChecked = false
    @State private var keyInventoryCount = 0
    @State private var keyAccountReady = false
    @State private var keyRecoveryConsent = false
    @State private var recoveryInspected = false
    @State private var recoveryLastFailure: [String: Any] = [:]
    @State private var showRecoveryDetails = false
    @State private var recoveryRetryExhausted = false
    @State private var recoveryReplacementRoleValid = false
    @State private var recoveryDefaultProject = false
    @State private var recoveryProjectAvailable = false
    @State private var recoveryRoleFound = false
    @State private var recoveryRoleValid = false
    @State private var recoveryRolePermissionsValid = false
    @State private var recoveryRoleHasValidID = false
    @State private var recoveryRoleResponseShape: [String:Any] = [:]
    @State private var recoveryRoleIDDiagnostic: [String:Any] = [:]
    @State private var recoveryMissingPermissions: [String] = []
    @State private var recoveryUnexpectedPermissions: [String] = []
    @State private var recoveryRoleReplacementConfirmed = false
    @State private var recoveryRoleRetryConfirmed = false
    @State private var runtimeProjectMode = "create"
    @State private var chosenRuntimeProject = ""
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
                        Text(Bundle.main.bundleIdentifier == "local.mcphub.native.dev"
                             ? "FIRST RUN SETUP · DEV PREVIEW" : "FIRST RUN SETUP")
                            .font(.system(size:11,weight:.bold,design:.monospaced))
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
                        Button { model.navigate(to:index) } label: {
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
                    Button("Назад") { model.navigate(to:model.page-1) }
                        .disabled(model.page==0||model.busy)
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    Button(model.page == titles.count-1 ? "К началу" : "Далее") {
                        model.navigate(to:model.page == titles.count-1 ? 0 : model.page+1)
                    }.disabled(model.busy || (model.page == 2 && !tunnelSetupComplete))
                }
                .font(.system(size:13))
            }
            .padding(28)
        }
        .background(Palette.background)
        .task { await model.refresh() }
    }

    @State private var showPreflightDetails = false

    /// Group low-level preflight diagnostics into things a first-time user understands.
    /// The full check list is still available below for troubleshooting.
    private func preflightPassed(_ names: [String]) -> Bool {
        names.allSatisfy { name in
            model.checks.first(where: { $0["name"] as? String == name })?["ok"] as? Bool == true
        }
    }

    private var preflightLoaded: Bool { !model.checks.isEmpty }
    private var browserDependenciesReady: Bool { preflightPassed(["browser-deps"]) }
    private var allPreflightPassed: Bool {
        preflightLoaded && model.checks.allSatisfy { $0["ok"] as? Bool == true }
    }

    private func preflightSummaryRow(_ title: String, detail: String, checks: [String]) -> some View {
        let ready = preflightPassed(checks)
        return HStack(alignment: .top, spacing: 13) {
            Image(systemName:ready ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .font(.system(size: 19))
                .foregroundStyle(ready ? Palette.online : Palette.warning)
                .frame(width: 22)
            VStack(alignment:.leading,spacing:4) {
                Text(title)
                    .font(.system(size:14,weight:.semibold))
                    .foregroundStyle(Palette.ink)
                Text(ready ? detail : "Требуется проверка или настройка")
                    .font(.system(size:11))
                    .foregroundStyle(ready ? Palette.muted : Palette.warning)
                    .fixedSize(horizontal:false,vertical:true)
            }
            Spacer(minLength:0)
        }
        .padding(.vertical,9)
    }

    private var systemStep: some View {
        VStack(alignment:.leading,spacing:18) {
            heading("1. Проверяем Mac", "Убедимся, что всё готово к подключению ChatGPT.")

            if !preflightLoaded {
                HStack(spacing:10) {
                    ProgressView().controlSize(.small)
                    Text("Проверяем компоненты…")
                        .font(.system(size:12))
                        .foregroundStyle(Palette.muted)
                }
            } else {
                VStack(alignment:.leading,spacing:2) {
                    preflightSummaryRow("Mac поддерживается",
                        detail:"macOS 14+ и Apple Silicon",
                        checks:["macos","architecture","platform"])
                    Divider().overlay(Palette.stroke)
                    preflightSummaryRow("Компоненты McpGo готовы",
                        detail:"Не нужно устанавливать Node.js или Python отдельно",
                        checks:["node","npm","python","tunnel-client","bundle","source"])
                    Divider().overlay(Palette.stroke)
                    preflightSummaryRow("Браузерные инструменты готовы",
                        detail:"Playwright включён — можно подключать Chrome",
                        checks:["browser-deps"])
                }
                .padding(.horizontal,15)
                .padding(.vertical,6)
                .background(Palette.background.opacity(0.45),in:RoundedRectangle(cornerRadius:12))

                if allPreflightPassed {
                    Label("Всё готово! Нажми «Далее», чтобы подключить ChatGPT.",
                          systemImage:"checkmark.seal.fill")
                        .font(.system(size:12,weight:.medium))
                        .foregroundStyle(Palette.online)
                } else {
                    Label("Некоторые компоненты требуют внимания. Открой диагностику ниже.",
                          systemImage:"exclamationmark.triangle")
                        .font(.system(size:12))
                        .foregroundStyle(Palette.warning)
                    if !browserDependenciesReady {
                        Button("Установить браузерные инструменты") {
                            Task { await model.perform("install-deps",data:["confirmed":true]) }
                        }
                        .disabled(model.busy)
                        Text("Потребуется подключение к интернету. Установка начнётся только после нажатия кнопки.")
                            .font(.system(size:11))
                            .foregroundStyle(Palette.muted)
                    }
                }
            }

            HStack(spacing:10) {
                Button("Проверить ещё раз") { Task { await model.refresh() } }
                    .disabled(model.busy)
                if model.busy { ProgressView().controlSize(.small) }
            }

            DisclosureGroup(isExpanded:$showPreflightDetails) {
                VStack(alignment:.leading,spacing:9) {
                    ForEach(Array(model.checks.enumerated()),id:\.offset) { _,check in
                        HStack(alignment:.top,spacing:8) {
                            Image(systemName:check["ok"] as? Bool == true
                                  ? "checkmark.circle.fill" : "exclamationmark.circle")
                                .foregroundStyle(check["ok"] as? Bool == true ? Palette.online : Palette.warning)
                            Text(check["detail"] as? String ?? "Компонент")
                                .foregroundStyle(Palette.muted)
                            Spacer(minLength:0)
                        }
                        .font(.system(size:11))
                    }
                }
                .padding(.top,12)
            } label: {
                Text("Техническая диагностика")
                    .font(.system(size:11,weight:.medium))
                    .foregroundStyle(Palette.quiet)
            }
            .tint(Palette.muted)
        }
    }

    private var accountStep: some View {
        VStack(alignment:.leading,spacing:15) {
            heading("2. Подключаем OpenAI",
                    "Не нужно разбираться с API заранее. Выбери свой сценарий — мастер покажет, где взять нужные данные.")

            Picker("Как будем подключать?",selection:$mode) {
                Text("Создать два туннеля").tag("create")
                Text("Туннели уже есть").tag("import")
            }
            .pickerStyle(.segmented)
            .onChange(of:mode) { _, selected in
                if selected == "import" { adminKey = "" }
                model.note = ""
                model.error = ""
            }

            if mode == "create" {
                Label("Понадобится доступ к OpenAI Platform. Это отдельный кабинет, не окно ChatGPT.",
                      systemImage:"info.circle")
                    .foregroundStyle(Palette.muted)
                    .font(.system(size:12))
                    .fixedSize(horizontal:false,vertical:true)

                setupGuideCard(
                    "01", "Найди Organization ID",
                    "Открой настройки своей организации OpenAI Platform. Скопируй Organization ID — он обычно начинается с org- (старый формат org_ тоже поддерживается).",
                    linkTitle:"Открыть настройки организации",
                    url:"https://platform.openai.com/settings/organization/general"
                ) {
                    TextField("Вставь Organization ID: org-...",text:$organizationID)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.none)
                }

                setupGuideCard(
                    "02", "Workspace ID — при необходимости",
                    "Для личного подключения это поле можно оставить пустым. Если работаешь в отдельном ChatGPT Workspace, укажи его ID (ws_...), чтобы туннель был связан с нужным пространством.",
                    linkTitle:"Открыть настройки ChatGPT",
                    url:"https://chatgpt.com/#settings"
                ) {
                    TextField("Workspace ID: ws_... (необязательно)",text:$workspaceID)
                        .textFieldStyle(.roundedBorder)
                        .textContentType(.none)
                    Text("Не знаешь Workspace ID? Оставь пустым. При необходимости связь с workspace можно уточнить в Platform.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.quiet)
                        .fixedSize(horizontal:false,vertical:true)
                }

                setupGuideCard(
                    "03", "Создай ключ для настройки туннелей",
                    "Открой Admin API Keys в OpenAI Platform, создай ключ и вставь его ниже. Для создания туннелей нужны права Tunnels: Read + Manage.",
                    linkTitle:"Открыть Admin API Keys",
                    url:"https://platform.openai.com/settings/organization/admin-keys"
                ) {
                    DisclosureGroup(isExpanded:$showAdminKeyGuide) {
                        VStack(alignment:.leading,spacing:14) {
                            Text("1. В разделе Admin keys нажми «Create new Admin key».")
                                .font(.system(size:12,weight:.medium))
                                .foregroundStyle(Palette.ink)
                            adminHelpImage(
                                "admin-key-list",
                                description:"Список Admin keys с выделенной кнопкой Create new Admin key",
                                maxWidth:800
                            )

                            Text("2. Введи понятное название, например McpGo, выбери срок действия и нужные разрешения. Нажми «Create admin key».")
                                .font(.system(size:12,weight:.medium))
                                .foregroundStyle(Palette.ink)
                                .fixedSize(horizontal:false,vertical:true)
                            adminHelpImage(
                                "admin-key-dialog",
                                description:"Форма создания ключа с выделенной кнопкой Create admin key",
                                maxWidth:520
                            )
                            Label("Скопируй созданный ключ сразу: OpenAI может показать его только один раз. Не отправляй его в чат и не оставляй в документах.",
                                  systemImage:"lock.shield")
                                .font(.system(size:11))
                                .foregroundStyle(Palette.muted)
                                .fixedSize(horizontal:false,vertical:true)
                        }
                        .padding(.top,12)
                    } label: {
                        Label("Как создать Admin API Key — инструкция со скриншотами",
                              systemImage:"photo.on.rectangle.angled")
                            .font(.system(size:12,weight:.semibold))
                            .foregroundStyle(Palette.accent)
                    }
                    .tint(Palette.accent)

                    SecureField("Вставь Admin API Key (временный)",text:$adminKey)
                        .textFieldStyle(.roundedBorder)
                        .privacySensitive()
                    Label("Это не подписка ChatGPT и не ключ для постоянной работы. McpGo передаёт его только на время проверки и создания туннелей.",
                          systemImage:"lock.shield")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                }

                VStack(alignment:.leading,spacing:9) {
                    HStack(spacing:8) {
                        Image(systemName:"person.crop.circle.badge.exclamationmark")
                            .foregroundStyle(Palette.warning)
                        Text("Не получается создать ключ?")
                            .font(.system(size:12,weight:.semibold))
                            .foregroundStyle(Palette.ink)
                    }
                    Text("Попроси владельца организации или администратора OpenAI Platform предоставить права Tunnels Read + Manage и право создавать Admin API Keys. Без этих прав автоматическое создание может вернуть ошибку 403.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                    setupExternalLink("Посмотреть роли и разрешения",
                                      "https://platform.openai.com/settings/organization/people/roles")
                }
                .padding(13)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(Palette.background.opacity(0.5),in:RoundedRectangle(cornerRadius:10))

                HStack(spacing:12) {
                    Button("Проверить доступ и список туннелей") {
                        Task {
                            await model.perform("discover",data:[
                                "organizationId":organizationID.trimmingCharacters(in:.whitespacesAndNewlines),
                                "workspaceId":workspaceID.trimmingCharacters(in:.whitespacesAndNewlines),
                                "adminKey":adminKey
                            ])
                        }
                    }
                    .disabled(!canCheckPlatform || model.busy)
                    if model.busy { ProgressView().controlSize(.small) }
                }
                if !canCheckPlatform {
                    Text(!isOrganizationIDValid
                         ? "Вставь Organization ID в формате org-... (или org_...). После этого кнопка проверки станет доступна, если ключ тоже заполнен."
                         : "Вставь Admin API Key — затем можно проверить доступ и список туннелей.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.quiet)
                        .fixedSize(horizontal:false,vertical:true)
                }
                Label("Проверка только показывает доступные туннели. Создание выполняется отдельно на следующем шаге — после подтверждения.",
                      systemImage:"checkmark.shield")
                    .font(.system(size:11))
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal:false,vertical:true)
            } else {
                VStack(alignment:.leading,spacing:14) {
                    Label("Отлично, заново создавать ничего не нужно.",
                          systemImage:"checkmark.circle.fill")
                        .font(.system(size:14,weight:.semibold))
                        .foregroundStyle(Palette.online)
                    Text("Открой список туннелей в OpenAI Platform. На следующем шаге вставишь два готовых Tunnel ID: один для TerminalHub и один для PlaywrightHub.")
                        .font(.system(size:12))
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal:false,vertical:true)
                    setupExternalLink("Открыть мои туннели",
                                      "https://platform.openai.com/settings/organization/tunnels")
                    Text("Административный API-ключ для импорта готовых Tunnel ID не нужен. Для запуска понадобится отдельный Runtime API Key с правами Tunnels Read + Use — мастер попросит его на следующем шаге.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                }
                .padding(18)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(Palette.background.opacity(0.5),in:RoundedRectangle(cornerRadius:12))
            }
        }
    }

    private var isOrganizationIDValid: Bool {
        let id = organizationID.trimmingCharacters(in:.whitespacesAndNewlines)
        return id.range(of:#"^org[-_][A-Za-z0-9_-]{3,180}$"#,
                        options:.regularExpression) != nil
    }

    private var canCheckPlatform: Bool {
        let key = adminKey.trimmingCharacters(in:.whitespacesAndNewlines)
        return isOrganizationIDValid && !key.isEmpty
    }

    private func adminHelpImage(_ name: String, description: String,
                                maxWidth: CGFloat) -> some View {
        let path = Bundle.main.resourceURL?
            .appendingPathComponent("HelpImages")
            .appendingPathComponent(name + ".png")
        return Group {
            if let path, let screenshot = NSImage(contentsOf: path) {
                Image(nsImage:screenshot)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth:maxWidth)
                    .clipShape(RoundedRectangle(cornerRadius:9))
                    .overlay(RoundedRectangle(cornerRadius:9)
                        .stroke(Palette.stroke.opacity(0.7)))
                    .accessibilityLabel(description)
            } else {
                Label("Скриншот недоступен. Открой ссылку Admin API Keys выше.",
                      systemImage:"photo.badge.exclamationmark")
                    .font(.system(size:11))
                    .foregroundStyle(Palette.warning)
            }
        }
    }

    private func setupExternalLink(_ title: String, _ url: String) -> some View {
        Link(destination:URL(string:url)!) {
            Label(title,systemImage:"arrow.up.right.square")
                .font(.system(size:12,weight:.medium))
                .foregroundStyle(Palette.accent)
        }
        .buttonStyle(.plain)
    }

    private func setupGuideCard<Content: View>(
        _ number: String, _ title: String, _ detail: String,
        linkTitle: String, url: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment:.leading,spacing:10) {
            HStack(alignment:.center,spacing:10) {
                Text(number)
                    .font(.system(size:12,weight:.bold,design:.monospaced))
                    .foregroundStyle(Palette.accent)
                    .padding(7)
                    .background(Palette.accentSoft,in:RoundedRectangle(cornerRadius:7))
                Text(title)
                    .font(.system(size:14,weight:.semibold))
                    .foregroundStyle(Palette.ink)
            }
            Text(detail)
                .font(.system(size:12))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)
            setupExternalLink(linkTitle,url)
            content()
        }
        .padding(14)
        .frame(maxWidth:.infinity,alignment:.leading)
        .background(Palette.background.opacity(0.5),in:RoundedRectangle(cornerRadius:11))
        .overlay(RoundedRectangle(cornerRadius:11).stroke(Palette.stroke.opacity(0.7)))
    }

    private func heading(_ title:String,_ detail:String) -> some View {
        VStack(alignment:.leading,spacing:6) {
            Text(title).font(.system(size:20,weight:.semibold)).foregroundStyle(Palette.ink)
            Text(detail).font(.system(size:12)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)
        }
    }

    private var tunnelsExist: Bool {
        !model.terminalID.isEmpty && !model.browserID.isEmpty
    }

    private var savedRuntimeKeyExists: Bool {
        PrivateKeychain.exists(TunnelPaths.terminalService) &&
        PrivateKeychain.exists(TunnelPaths.browserService)
    }

    private var keyIssuanceNeedsRecovery: Bool {
        !savedRuntimeKeyExists &&
        ["key-issuing", "key-issued", "recovery-key-issuing",
         "key-recovery-rejected"].contains(model.runtimeKeyIssuanceStatus)
    }

    private var tunnelSetupComplete: Bool {
        tunnelsExist && model.localConfigured && savedRuntimeKeyExists
    }

    private var canSaveTunnelAccess: Bool {
        tunnelsExist && !model.busy &&
        (!runtimeKey.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || savedRuntimeKeyExists)
    }

    private var runtimeKeyRecoverySection: some View {
        VStack(alignment:.leading,spacing:12) {
            Label("Проект и Service Account уже созданы",
                  systemImage:"checkmark.shield.fill")
                .font(.system(size:14,weight:.semibold))
                .foregroundStyle(Palette.online)
            Text("Мастер дошёл до выпуска Runtime API Key, но ключ не оказался " +
                 "в Keychain. Возвращаться к созданию проекта, роли или Service Account не нужно.")
                .font(.system(size:12))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)

            Text("OpenAI показывает секрет ключа только при его создании. " +
                 "Если ответ потерялся, старый ключ восстановить нельзя.")
                .font(.system(size:11))
                .foregroundStyle(Palette.warning)
                .fixedSize(horizontal:false,vertical:true)

            Button {
                inspectRuntimeRecovery()
            } label: {
                Label(recoveryInspected ? "Проверить существующие ключи ещё раз"
                      : "Проверить Service Account и ключи (только чтение)",
                      systemImage:"arrow.clockwise")
                    .font(.system(size:12,weight:.semibold))
            }
            .disabled(adminKey.isEmpty || model.busy)

            if recoveryInspected {
                if keyAccountReady && keyInventoryChecked {
                    Label("Существующий Service Account подтверждён. " +
                          "Найдено его ключей: " + String(keyInventoryCount) + ".",
                          systemImage:"checkmark.circle.fill")
                        .font(.system(size:12))
                        .foregroundStyle(Palette.online)
                    Text("Возможно, один из них был выпущен при прежней попытке. " +
                         "Содержимое таких ключей OpenAI больше не показывает.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                } else {
                    Text("Проверка ключей не завершена. Не создавай новый ключ, " +
                         "пока не подтвердится существующий Service Account.")
                        .font(.system(size:12))
                        .foregroundStyle(Palette.warning)
                }
            }

            if recoveryInspected && keyAccountReady && keyInventoryChecked &&
               !model.runtimeKeyRecoveryAttempted &&
               ["key-issuing","key-issued"].contains(model.runtimeKeyIssuanceStatus) {
                Toggle(
                    "Подтверждаю выпуск одного нового ключа для существующего " +
                    "Service Account. Прежний ключ может остаться активным.",
                    isOn:$keyRecoveryConsent
                )
                .toggleStyle(.checkbox)
                .font(.system(size:11))
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal:false,vertical:true)
                Button {
                    recoverRuntimeKey()
                } label: {
                    Label("Выпустить новый Runtime API Key и сохранить в Keychain",
                          systemImage:"key.fill")
                        .font(.system(size:12,weight:.semibold))
                }
                .disabled(!keyRecoveryConsent || adminKey.isEmpty || model.busy)
            } else if model.runtimeKeyRecoveryAttempted {
                Text("Одна попытка восстановления ключа уже была выполнена. " +
                     "Повторное создание заблокировано. Используй ручной режим.")
                    .font(.system(size:11))
                    .foregroundStyle(Palette.warning)
                    .fixedSize(horizontal:false,vertical:true)
            }

            Button("Ввести Runtime API Key вручную") {
                runtimeMode = "manual"
            }
            .buttonStyle(.plain)
            .font(.system(size:11,weight:.semibold))
            .foregroundStyle(Palette.accent)
        }
        .padding(15)
        .frame(maxWidth:.infinity,alignment:.leading)
        .background(Palette.background.opacity(0.5),
                    in:RoundedRectangle(cornerRadius:12))
    }

    private var tunnelStep: some View {
        VStack(alignment:.leading,spacing:17) {
            heading("3. Подключаем туннели",
                    "Туннели соединяют ChatGPT с твоим Mac. Выполни два действия: создай подключения и сохрани ключ для их работы.")

            if tunnelsExist {
                VStack(alignment:.leading,spacing:12) {
                    Label("Шаг 1 из 2 · Туннели уже созданы",
                          systemImage:"checkmark.circle.fill")
                        .font(.system(size:14,weight:.semibold))
                        .foregroundStyle(Palette.online)
                    HStack(spacing:10) {
                        Image(systemName:"terminal")
                            .frame(width:22).foregroundStyle(Palette.accent)
                        Text("Терминал").font(.system(size:12,weight:.medium))
                        Spacer()
                        Text("Подключён").foregroundStyle(Palette.online)
                    }
                    HStack(spacing:10) {
                        Image(systemName:"globe")
                            .frame(width:22).foregroundStyle(Palette.accent)
                        Text("Chrome / Playwright").font(.system(size:12,weight:.medium))
                        Spacer()
                        Text("Подключён").foregroundStyle(Palette.online)
                    }
                    .font(.system(size:12))
                    Text(model.remoteVerified
                         ? "Оба Tunnel ID подтверждены OpenAI. Создавать туннели повторно не нужно."
                         : "Оба Tunnel ID сохранены. Проверка прав на их использование выполняется отдельно.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                    DisclosureGroup(isExpanded:$showTunnelDetails) {
                        VStack(alignment:.leading,spacing:8) {
                            Text("Терминал: \(model.terminalID)")
                            Text("Браузер: \(model.browserID)")
                        }
                        .font(.system(size:11,design:.monospaced))
                        .foregroundStyle(Palette.muted)
                        .textSelection(.enabled)
                        .padding(.top,8)
                    } label: {
                        Text("Показать Tunnel ID")
                            .font(.system(size:11))
                            .foregroundStyle(Palette.accent)
                    }
                    .tint(Palette.accent)
                }
                .padding(17)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(Palette.background.opacity(0.45),in:RoundedRectangle(cornerRadius:12))
                Button(changeTunnels ? "Скрыть изменение туннелей" : "Использовать другие туннели") {
                    changeTunnels.toggle()
                }
                .font(.system(size:11))
                .buttonStyle(.plain)
                .foregroundStyle(Palette.quiet)
            } else {
                Label("Шаг 1 из 2 · Создать или подключить два туннеля",
                      systemImage:"1.circle.fill")
                    .font(.system(size:14,weight:.semibold))
                    .foregroundStyle(Palette.ink)
            }

            if !tunnelsExist || changeTunnels {
                VStack(alignment:.leading,spacing:12) {
                    Picker("Режим",selection:$mode) {
                        Text("Создать автоматически").tag("create")
                        Text("Подключить существующие").tag("import")
                    }
                    .pickerStyle(.segmented)
                    if mode == "create" {
                        Text("McpGo сначала ищет твои туннели в OpenAI и создаёт только недостающие. Admin API Key нужен только для этого действия.")
                            .font(.system(size:12)).foregroundStyle(Palette.muted)
                            .fixedSize(horizontal:false,vertical:true)
                        Button("Найти или создать туннели") {
                            Task {
                                await model.perform("provision",data:[
                                    "confirmed":true,"organizationId":organizationID,
                                    "workspaceId":workspaceID,"adminKey":adminKey
                                ])
                                // Keep the one-time admin key in SwiftUI memory until the
                                // runtime provisioning step finishes. Never persist it.
                            }
                        }
                        .disabled(model.busy || adminKey.isEmpty ||
                                  (organizationID.isEmpty && workspaceID.isEmpty))
                        if adminKey.isEmpty {
                            Text("Если нужен новый туннель, вернись на шаг 2 и введи Admin API Key.")
                                .font(.system(size:11)).foregroundStyle(Palette.quiet)
                        }
                        if model.pending {
                            Label("Результат предыдущего создания неизвестен. Сначала проверь туннели в Platform — автоматический повтор запрещён.",
                                  systemImage:"exclamationmark.triangle")
                                .font(.system(size:11))
                                .foregroundStyle(Palette.warning)
                        }
                    } else {
                        Text("Вставь два разных Tunnel ID, если уже создал их раньше.")
                            .font(.system(size:12))
                            .foregroundStyle(Palette.muted)
                        TextField("Терминал · tunnel_...",text:$importedTerminal)
                            .textFieldStyle(.roundedBorder)
                        TextField("Браузер · tunnel_...",text:$importedBrowser)
                            .textFieldStyle(.roundedBorder)
                        Button("Подключить указанные туннели") {
                            Task {
                                await model.perform("import",data:[
                                    "confirmed":true,
                                    "terminalId":importedTerminal,
                                    "browserId":importedBrowser
                                ])
                                changeTunnels = false
                            }
                        }
                        .disabled(importedTerminal.isEmpty || importedBrowser.isEmpty || model.busy)
                    }
                }
                .padding(16)
                .background(Palette.background.opacity(0.45),in:RoundedRectangle(cornerRadius:12))
            }

            if tunnelsExist {
                Divider()
                VStack(alignment:.leading,spacing:12) {
                    if tunnelSetupComplete && !replaceRuntimeKey {
                        Label("Шаг 2 из 2 · Ключ сохранён, настройка готова",
                              systemImage:"checkmark.circle.fill")
                            .font(.system(size:14,weight:.semibold))
                            .foregroundStyle(Palette.online)
                        Text("McpGo уже сохранил ключ доступа в macOS Keychain и создал локальные профили. Теперь нажми «Далее» — перейдём к запуску служб.")
                            .font(.system(size:12))
                            .foregroundStyle(Palette.muted)
                            .fixedSize(horizontal:false,vertical:true)
                        Button("Заменить Runtime API Key") {
                            replaceRuntimeKey = true
                            runtimeKey = ""
                        }
                        .font(.system(size:11))
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.accent)
                    } else {
                        Label("Шаг 2 из 2 · Осталось сохранить ключ доступа",
                              systemImage:"key.fill")
                            .font(.system(size:14,weight:.semibold))
                            .foregroundStyle(Palette.ink)
                        Text("Туннели готовы. Можешь дать McpGo создать отдельный ключ автоматически — не нужно искать настройки API Keys вручную.")
                            .font(.system(size:12))
                            .foregroundStyle(Palette.muted)
                            .fixedSize(horizontal:false,vertical:true)

                        Picker("Настройка ключа",selection:$runtimeMode) {
                            Text("Автоматически").tag("auto")
                            Text("Ввести вручную").tag("manual")
                        }
                        .pickerStyle(.segmented)

                        if runtimeMode == "auto" {
                            Label("С твоего подтверждения McpGo создаст отдельный Service Account с доступом только Tunnels Read + Use, выпустит ключ и сохранит его в Keychain.",
                                  systemImage:"wand.and.stars")
                                .font(.system(size:12))
                                .foregroundStyle(Palette.ink)
                                .fixedSize(horizontal:false,vertical:true)

                            Text("Нужны права администратора OpenAI Platform на проекты, роли, группы и служебные аккаунты. Если организация не разрешает это, используй ручной способ.")
                                .font(.system(size:11))
                                .foregroundStyle(Palette.muted)
                                .fixedSize(horizontal:false,vertical:true)

                            if adminKey.isEmpty {
                                SecureField("Вставь Admin API Key с шага 2",text:$adminKey)
                                    .textFieldStyle(.roundedBorder)
                                    .privacySensitive()
                            } else {
                                Label("Временный Admin API Key уже введён на предыдущем шаге",
                                      systemImage:"checkmark.circle.fill")
                                    .font(.system(size:11))
                                    .foregroundStyle(Palette.online)
                            }

                            if keyIssuanceNeedsRecovery {
                                runtimeKeyRecoverySection
                            } else {
                                VStack(alignment:.leading,spacing:10) {
                                    Text("Где взять проект?")
                                    .font(.system(size:13,weight:.semibold))
                                    .foregroundStyle(Palette.ink)
                                Text("В каждой организации OpenAI уже есть Default project, но он не поддерживает прямое создание Service Account. Для McpGo нужен обычный проект. Можем создать его прямо здесь.")
                                    .font(.system(size:11))
                                    .foregroundStyle(Palette.muted)
                                    .fixedSize(horizontal:false,vertical:true)

                                if model.runtimeProjectSelected &&
                                   !model.runtimeOperationPending.isEmpty {
                                    VStack(alignment:.leading,spacing:10) {
                                        Label("Предыдущая настройка не завершена. " +
                                              "Сначала проверим реальные ресурсы в OpenAI " +
                                              "без создания новых.",
                                              systemImage:"exclamationmark.triangle")
                                            .font(.system(size:12))
                                            .foregroundStyle(Palette.warning)
                                            .fixedSize(horizontal:false,vertical:true)
                                        Button {
                                            inspectRuntimeRecovery()
                                        } label: {
                                            Label(recoveryInspected
                                                  ? "Повторно проверить ресурсы (только чтение)"
                                                  : "Проверить ресурсы OpenAI (без изменений)",
                                                  systemImage:"arrow.clockwise")
                                                .font(.system(size:12,weight:.semibold))
                                        }
                                        .disabled(adminKey.isEmpty || model.busy)
                                        if recoveryInspected && recoveryRoleFound &&
                                           !recoveryRoleIDDiagnostic.isEmpty {
                                            VStack(alignment:.leading,spacing:6) {
                                                Text("Диагностика Role ID (режим тестирования)")
                                                    .font(.system(size:12,weight:.semibold))
                                                    .foregroundStyle(Palette.ink)
                                                Text("Role ID: " +
                                                     (recoveryRoleIDDiagnostic["id"] as? String ?? "отсутствует"))
                                                    .font(.system(size:11,design:.monospaced))
                                                    .foregroundStyle(Palette.ink)
                                                    .textSelection(.enabled)
                                                Text("resource_type: " +
                                                     (recoveryRoleIDDiagnostic["resourceType"] as? String ?? "отсутствует"))
                                                    .font(.system(size:11,design:.monospaced))
                                                    .foregroundStyle(Palette.muted)
                                                Text("object: " +
                                                     (recoveryRoleIDDiagnostic["object"] as? String ?? "отсутствует"))
                                                    .font(.system(size:11,design:.monospaced))
                                                    .foregroundStyle(Palette.muted)
                                                Text("Проверка ID: " +
                                                     (recoveryRoleIDDiagnostic["reason"] as? String ?? "нет данных"))
                                                    .font(.system(size:11,design:.monospaced))
                                                    .foregroundStyle(recoveryRoleHasValidID
                                                        ? Palette.online : Palette.warning)
                                                Text("Это ответ на чтение, он не сохраняется в журнал. " +
                                                     "API-ключи не показываются.")
                                                    .font(.system(size:10))
                                                    .foregroundStyle(Palette.quiet)
                                            }
                                            .padding(10)
                                            .frame(maxWidth:.infinity,alignment:.leading)
                                            .background(Palette.background.opacity(0.6),
                                                        in:RoundedRectangle(cornerRadius:9))
                                        }

                                        if recoveryInspected && recoveryRoleFound &&
                                           recoveryRolePermissionsValid && !recoveryRoleHasValidID {
                                            Text("Разрешения роли уже правильные. " +
                                                 "Проблема именно в отсутствующем или некорректном Role ID. " +
                                                 "Новые роли не создаём; используй ручной Runtime API Key.")
                                                .font(.system(size:12))
                                                .foregroundStyle(Palette.warning)
                                                .fixedSize(horizontal:false,vertical:true)
                                            Button("Ввести Runtime API Key вручную") {
                                                runtimeMode = "manual"
                                            }
                                            .buttonStyle(.plain)
                                            .font(.system(size:11,weight:.semibold))
                                            .foregroundStyle(Palette.accent)
                                        }
                                        if recoveryInspected &&
                                           !recoveryLastFailure.isEmpty {
                                            DisclosureGroup(isExpanded:$showRecoveryDetails) {
                                                VStack(alignment:.leading,spacing:6) {
                                                    Text("Предыдущая операция: " +
                                                         (recoveryLastFailure["operation"] as? String ?? "неизвестно"))
                                                    Text("Источник: " +
                                                         (recoveryLastFailure["source"] as? String == "post"
                                                          ? "ответ создания (POST)"
                                                          : "полученный ресурс (GET)"))
                                                    if let status = recoveryLastFailure["httpStatus"] as? Int {
                                                        Text("HTTP-статус создания: " + String(status))
                                                    }
                                                    if let shape = recoveryLastFailure["responseShape"] as? [String:Any] {
                                                        Text("Тип идентификатора: " +
                                                             (shape["idType"] as? String ?? "неизвестно"))
                                                        Text("Тип ответа: " +
                                                             (shape["objectKind"] as? String ?? "неизвестно"))
                                                        if let keys = shape["fields"] as? [String], !keys.isEmpty {
                                                            Text("Поля ответа: " +
                                                                 keys.joined(separator:", "))
                                                        }
                                                        if let keys = shape["nestedFields"] as? [String], !keys.isEmpty {
                                                            Text("Поля вложенного объекта: " +
                                                                 keys.joined(separator:", "))
                                                        }
                                                        if shape["containsErrorField"] as? Bool == true {
                                                            Text("В ответе присутствует поле error. " +
                                                                 "Секретные данные не выводятся.")
                                                        }
                                                    }
                                                    let found = recoveryLastFailure["matchingNamesAfter"] as? Int ?? 0
                                                    Text("Совпадений по точному имени после запроса: " + String(found))
                                                    Text("Это только структура данных OpenAI; " +
                                                         "ключи и значения полей не сохраняются.")
                                                        .foregroundStyle(Palette.quiet)
                                                }
                                                .font(.system(size:11,design:.monospaced))
                                                .foregroundStyle(Palette.muted)
                                                .fixedSize(horizontal:false,vertical:true)
                                                .padding(.top,9)
                                            } label: {
                                                Label("Диагностика предыдущего ответа (без секретов)",
                                                      systemImage:"info.circle")
                                                    .font(.system(size:11))
                                                    .foregroundStyle(Palette.accent)
                                            }
                                            .tint(Palette.accent)
                                        } else if recoveryInspected {
                                            Text("Предыдущий ответ не сохранил диагностику. " +
                                                 "Новое создание ради диагностики не запускаем.")
                                                .font(.system(size:11))
                                                .foregroundStyle(Palette.quiet)
                                            Button("Продолжить с ручным Runtime API Key") {
                                                runtimeMode = "manual"
                                            }
                                            .buttonStyle(.plain)
                                            .font(.system(size:11,weight:.semibold))
                                            .foregroundStyle(Palette.accent)
                                        }
                                    }
                                    .padding(12)
                                    .background(Palette.warning.opacity(0.07),
                                                in:RoundedRectangle(cornerRadius:10))
                                }

                                Picker("Проект OpenAI",selection:$runtimeProjectMode) {
                                    Text("Создать проект McpGo").tag("create")
                                    Text("Использовать существующий").tag("existing")
                                }
                                .pickerStyle(.segmented)

                                if runtimeProjectMode == "create" {
                                    if model.runtimeProjectSelected {
                                        Label("В прошлой попытке уже был выбран проект. " +
                                              "Сначала проверим его и состояние роли.",
                                              systemImage:"checkmark.shield.fill")
                                            .font(.system(size:12))
                                            .foregroundStyle(Palette.muted)
                                            .fixedSize(horizontal:false,vertical:true)
                                        if recoveryInspected {
                                            if recoveryDefaultProject {
                                                Label("Ранее выбран Default project. " +
                                                      "Он не подходит для Service Account. " +
                                                      "Создадим отдельный проект McpGo " +
                                                      "после твоего подтверждения.",
                                                      systemImage:"exclamationmark.triangle")
                                                    .font(.system(size:12))
                                                    .foregroundStyle(Palette.warning)
                                                    .fixedSize(horizontal:false,vertical:true)
                                            } else if !recoveryProjectAvailable {
                                                Label("Прежний проект недоступен. " +
                                                      "Открой OpenAI Platform и проверь его " +
                                                      "наличие и права, прежде чем продолжать.",
                                                      systemImage:"exclamationmark.triangle")
                                                    .font(.system(size:12))
                                                    .foregroundStyle(Palette.warning)
                                                    .fixedSize(horizontal:false,vertical:true)
                                            } else {
                                                Label("Прежний проект подходит. McpGo " +
                                                      "использует его повторно, без создания нового.",
                                                      systemImage:"checkmark.circle.fill")
                                                    .font(.system(size:12))
                                                    .foregroundStyle(Palette.online)
                                                    .fixedSize(horizontal:false,vertical:true)
                                            }
                                            if recoveryRoleFound {
                                                Label(recoveryRoleValid
                                                      ? "Роль McpGo найдена и подтверждена. " +
                                                        "Повторное создание не требуется."
                                                      : (recoveryRolePermissionsValid && !recoveryRoleHasValidID
                                                         ? "Разрешения роли правильные, но OpenAI " +
                                                           "не вернул её корректный ID. " +
                                                           "Создавать новую роль нельзя."
                                                         : "Роль найдена, но её разрешения не подходят. " +
                                                           "McpGo может создать новую ограниченную роль " +
                                                           "после подтверждения."),
                                                      systemImage:recoveryRoleValid
                                                        ? "checkmark.circle.fill"
                                                        : "exclamationmark.triangle")
                                                    .font(.system(size:12))
                                                    .foregroundStyle(recoveryRoleValid
                                                        ? Palette.online : Palette.warning)
                                                    .fixedSize(horizontal:false,vertical:true)
                                                if !recoveryRoleValid {
                                                    if recoveryRolePermissionsValid &&
                                                       !recoveryRoleHasValidID {
                                                        Text("Это ошибка формата данных OpenAI, " +
                                                             "а не недостаток прав. " +
                                                             "Автоматическое создание остановлено. " +
                                                             "Можно выбрать «Ввести вручную» выше.")
                                                            .font(.system(size:11))
                                                            .foregroundStyle(Palette.warning)
                                                            .fixedSize(horizontal:false,vertical:true)
                                                        if let keys = recoveryRoleResponseShape["fields"] as? [String] {
                                                            Text("Поля объекта роли: " +
                                                                 (keys.isEmpty ? "нет" : keys.joined(separator:", ")))
                                                                .font(.system(size:10,design:.monospaced))
                                                                .foregroundStyle(Palette.quiet)
                                                        }
                                                        Button("Перейти к ручному вводу Runtime API Key") {
                                                            runtimeMode = "manual"
                                                        }
                                                        .font(.system(size:11,weight:.semibold))
                                                        .buttonStyle(.plain)
                                                        .foregroundStyle(Palette.accent)
                                                    }
                                                    if !recoveryMissingPermissions.isEmpty {
                                                        Text("Не хватает: " +
                                                             recoveryMissingPermissions.joined(separator:", "))
                                                            .font(.system(size:11))
                                                            .foregroundStyle(Palette.warning)
                                                            .fixedSize(horizontal:false,vertical:true)
                                                    }
                                                    if !recoveryUnexpectedPermissions.isEmpty {
                                                        Text("Лишние разрешения: " +
                                                             recoveryUnexpectedPermissions.joined(separator:", "))
                                                            .font(.system(size:11))
                                                            .foregroundStyle(Palette.warning)
                                                            .fixedSize(horizontal:false,vertical:true)
                                                    }
                                                    if !recoveryRolePermissionsValid {
                                                        Toggle(
                                                            "Разрешаю создать отдельную роль McpGo " +
                                                            "с Tunnels Read + Use. Прежнюю роль не изменять.",
                                                            isOn:$recoveryRoleReplacementConfirmed
                                                        )
                                                        .toggleStyle(.checkbox)
                                                        .font(.system(size:11))
                                                        .foregroundStyle(Palette.ink)
                                                        .fixedSize(horizontal:false,vertical:true)
                                                    }
                                                }
                                            } else if model.runtimeOperationPending == "role" {
                                                if recoveryRetryExhausted {
                                                    Text("Автоматический повтор создания роли уже " +
                                                         "использован. Больше не отправляем POST. " +
                                                         "Выбери «Ввести вручную» выше, либо " +
                                                         "проверь роль в OpenAI Platform.")
                                                        .font(.system(size:12))
                                                        .foregroundStyle(Palette.warning)
                                                        .fixedSize(horizontal:false,vertical:true)
                                                } else {
                                                    Text("OpenAI не показывает роль из предыдущей " +
                                                         "попытки. Повторный запрос допустим " +
                                                         "только один раз после твоего согласия.")
                                                        .font(.system(size:12))
                                                        .foregroundStyle(Palette.warning)
                                                        .fixedSize(horizontal:false,vertical:true)
                                                    Toggle(
                                                        "Разрешаю один повтор создания отсутствующей роли",
                                                        isOn:$recoveryRoleRetryConfirmed
                                                    )
                                                    .toggleStyle(.checkbox)
                                                    .font(.system(size:11))
                                                    .foregroundStyle(Palette.ink)
                                                }
                                            }
                                        }
                                    } else {
                                        Label("McpGo создаст отдельный проект, а затем " +
                                              "ограниченный ключ для туннелей. " +
                                              "Не нужно создавать проект заранее.",
                                              systemImage:"plus.circle.fill")
                                            .font(.system(size:12))
                                            .foregroundStyle(Palette.online)
                                            .fixedSize(horizontal:false,vertical:true)
                                    }
                                    if !model.runtimeProjectSelected || recoveryInspected {
                                        Button {
                                            configureRuntimeAutomatically()
                                        } label: {
                                            Label(model.runtimeProjectSelected &&
                                                  recoveryRoleFound && !recoveryRoleValid
                                                  ? "Создать безопасную роль и продолжить"
                                                  : (model.runtimeProjectSelected
                                                     ? "Продолжить проверенную настройку"
                                                     : "Создать проект McpGo и ключ доступа"),
                                                  systemImage:"wand.and.stars")
                                                .font(.system(size:13,weight:.semibold))
                                        }
                                        .disabled(adminKey.isEmpty || model.busy ||
                                            (model.runtimeProjectSelected &&
                                                (!recoveryProjectAvailable ||
                                                 (recoveryRoleFound && !recoveryRoleValid &&
                                                  (recoveryRolePermissionsValid ||
                                                   !recoveryRoleReplacementConfirmed)))) ||
                                            (model.runtimeOperationPending == "role" &&
                                                !recoveryRoleFound &&
                                                (recoveryRetryExhausted ||
                                                 !recoveryRoleRetryConfirmed)))
                                    }
                                } else {
                                    if !runtimeProjectsLoaded {
                                        Button {
                                            loadRuntimeProjects()
                                        } label: {
                                            Label("Найти доступные проекты",systemImage:"magnifyingglass")
                                        }
                                        .disabled(adminKey.isEmpty || model.busy)
                                    } else if runtimeProjects.isEmpty {
                                        Text("Подходящих проектов не найдено. Default project использовать нельзя. Выбери «Создать проект McpGo» выше.")
                                            .font(.system(size:12))
                                            .foregroundStyle(Palette.warning)
                                            .fixedSize(horizontal:false,vertical:true)
                                        Button("Проверить список ещё раз") {
                                            loadRuntimeProjects()
                                        }
                                        .disabled(adminKey.isEmpty || model.busy)
                                    } else {
                                        Picker("Выбери проект",selection:$chosenRuntimeProject) {
                                            ForEach(runtimeProjects) { project in
                                                Text(project.name).tag(project.id)
                                            }
                                        }
                                        .pickerStyle(.menu)
                                        Button {
                                            configureRuntimeAutomatically()
                                        } label: {
                                            Label("Использовать проект и создать ключ",
                                                  systemImage:"wand.and.stars")
                                                .font(.system(size:13,weight:.semibold))
                                        }
                                        .disabled(chosenRuntimeProject.isEmpty || adminKey.isEmpty || model.busy ||
                                            (model.runtimeProjectSelected &&
                                             (!recoveryInspected || !recoveryProjectAvailable ||
                                              (recoveryRoleFound && !recoveryRoleValid &&
                                               (recoveryRolePermissionsValid ||
                                                !recoveryRoleReplacementConfirmed)) ||
                                              (model.runtimeOperationPending == "role" &&
                                               !recoveryRoleFound &&
                                               (recoveryRetryExhausted ||
                                                !recoveryRoleRetryConfirmed)))))
                                    }
                                }
                                Text("Создание проекта и ключа выполняется только после нажатия кнопки. Нужны права владельца организации OpenAI Platform; проекты не удаляются автоматически.")
                                    .font(.system(size:11))
                                    .foregroundStyle(Palette.quiet)
                                    .fixedSize(horizontal:false,vertical:true)
                            }
                            .padding(14)
                                .background(Palette.background.opacity(0.5),
                                            in:RoundedRectangle(cornerRadius:10))
                            }

                            if savedRuntimeKeyExists && !model.localConfigured {
                                Button("Повторно проверить сохранённый ключ") {
                                    checkSavedRuntimeAndConfigure()
                                }
                                .disabled(model.busy)
                            }
                            Text("Если OpenAI откажет в правах, появится объяснение ошибки. Никаких ключей повторно без подтверждения не создаём.")
                                .font(.system(size:11))
                                .foregroundStyle(Palette.quiet)
                                .fixedSize(horizontal:false,vertical:true)
                        } else {
                            Text("Ручной вариант: создай Restricted API Key в OpenAI Platform с разрешениями Tunnels Read + Use.")
                                .font(.system(size:12))
                                .foregroundStyle(Palette.muted)
                                .fixedSize(horizontal:false,vertical:true)
                            setupExternalLink("Открыть API Keys в OpenAI Platform",
                                              "https://platform.openai.com/settings/organization/api-keys")
                            SecureField("Вставь Runtime API Key",text:$runtimeKey)
                                .textFieldStyle(.roundedBorder)
                                .privacySensitive()
                            Text("Ключ сохраняется только в macOS Keychain, не в конфигурации и не в логах.")
                                .font(.system(size:11))
                                .foregroundStyle(Palette.quiet)
                            Button {
                                configureTunnelProfiles()
                            } label: {
                                Label(replaceRuntimeKey ? "Сохранить новый ключ и продолжить"
                                      : "Сохранить ключ и перейти к запуску служб",
                                      systemImage:"arrow.right.circle.fill")
                                    .font(.system(size:13,weight:.semibold))
                            }
                            .disabled(!canSaveTunnelAccess)
                            if !canSaveTunnelAccess {
                                Text("Вставь Runtime API Key, чтобы продолжить.")
                                    .font(.system(size:11))
                                    .foregroundStyle(Palette.warning)
                            }
                        }
                    }
                }
                .padding(17)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(Palette.background.opacity(0.45),in:RoundedRectangle(cornerRadius:12))
                .overlay(RoundedRectangle(cornerRadius:12).stroke(
                    tunnelSetupComplete ? Palette.online.opacity(0.5) : Palette.stroke))
            }

            if !tunnelSetupComplete {
                Label("Кнопка «Далее» станет доступна, когда сохраним Runtime API Key и настроим профили.",
                      systemImage:"info.circle")
                    .font(.system(size:11))
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal:false,vertical:true)
            }
        }
    }

    private func loadRuntimeProjects() {
        Task {
            model.busy = true
            model.error = ""
            model.note = ""
            defer { model.busy = false }
            do {
                let result = try await WizardBridge.perform("runtime-projects",
                                                             ["adminKey":adminKey])
                let list = result["projects"] as? [[String:Any]] ?? []
                let parsed = list.compactMap { item -> RuntimeProject? in
                    guard let id = item["id"] as? String,
                          let name = item["name"] as? String else { return nil }
                    return RuntimeProject(id:id,name:name)
                }
                runtimeProjects = parsed
                runtimeProjectsLoaded = true
                chosenRuntimeProject = parsed.first?.id ?? ""
                if parsed.isEmpty {
                    model.note = "Среди доступных проектов нет подходящих. " +
                                 "Default project не поддерживает Service Accounts. " +
                                 "Выбери «Создать проект McpGo»."
                } else {
                    model.note = "Найдены подходящие проекты. Выбери нужный или " +
                                 "создай отдельный проект McpGo."
                }
            } catch {
                model.error = error.localizedDescription
            }
        }
    }

    private func checkSavedRuntimeAndConfigure() {
        Task {
            model.busy = true
            model.error = ""
            model.note = ""
            defer { model.busy = false }
            do {
                _ = try await WizardBridge.perform("check-ownership")
                guard let secret = PrivateKeychain.read(service:TunnelPaths.terminalService),
                      PrivateKeychain.exists(TunnelPaths.browserService) else {
                    model.error = "В Keychain нет сохранённого Runtime API Key."
                    return
                }
                // A real per-tunnel GET is mandatory before setting up the profiles.
                _ = try await WizardBridge.perform("verify-remote",["runtimeKey":secret])
                _ = try await WizardBridge.perform("configure",["confirmed":true])
                await model.refresh()
                model.navigate(to:3)
                model.note = "Ключ проверен, профили созданы. Переходим к службам."
            } catch {
                model.error = "Ключ есть в Keychain, но OpenAI пока не подтвердил доступ. " +
                              "Роли могут применяться до 30 минут. Нажми «Повторно проверить» позже. " +
                              error.localizedDescription
            }
        }
    }

    private func inspectRuntimeRecovery() {
        Task {
            model.busy = true
            model.error = ""
            model.note = ""
            defer { model.busy = false }
            do {
                let result = try await WizardBridge.perform(
                    "runtime-inspect",["adminKey":adminKey])
                recoveryLastFailure = result["lastFailure"] as? [String:Any] ?? [:]
                keyInventoryChecked = result["serviceAccountKeyInventoryChecked"] as? Bool ?? false
                keyInventoryCount = result["serviceAccountKeyCount"] as? Int ?? 0
                keyAccountReady = result["serviceAccountReady"] as? Bool ?? false
                keyRecoveryConsent = false
                recoveryRetryExhausted = result["roleRetryAlreadyUsed"] as? Bool ?? false
                recoveryReplacementRoleValid = result["replacementRoleValid"] as? Bool ?? false
                recoveryDefaultProject = result["priorProjectIsDefault"] as? Bool ?? false
                recoveryProjectAvailable = result["priorProjectAvailable"] as? Bool ?? false
                recoveryRoleFound = result["roleFound"] as? Bool ?? false
                recoveryRoleValid = result["roleValid"] as? Bool ?? false
                recoveryRolePermissionsValid = result["rolePermissionsValid"] as? Bool ?? false
                recoveryRoleHasValidID = result["roleHasValidID"] as? Bool ?? false
                recoveryRoleResponseShape = result["roleResponseShape"] as? [String:Any] ?? [:]
                recoveryRoleIDDiagnostic = result["roleIDDiagnostic"] as? [String:Any] ?? [:]
                recoveryMissingPermissions = result["roleMissingPermissions"] as? [String] ?? []
                recoveryUnexpectedPermissions = result["roleUnexpectedPermissions"] as? [String] ?? []
                recoveryRoleRetryConfirmed = false
                recoveryRoleReplacementConfirmed = false
                recoveryInspected = true
                model.note = recoveryRoleFound
                    ? (recoveryRoleValid
                        ? "Проверили: роль найдена с нужными разрешениями."
                        : (recoveryRolePermissionsValid
                           ? "Разрешения роли правильные, но API не вернул " +
                             "корректный ID. Повторное создание остановлено."
                           : "Проверили: роль создана, но права не подходят. " +
                             "Можно создать отдельную ограниченную роль после подтверждения."))
                    : "Проверили: нужная роль не найдена. " +
                      "Для повторного создания требуется отдельное подтверждение."
            } catch {
                recoveryInspected = false
                recoveryRoleIDDiagnostic = [:]
                model.error = "Не удалось проверить незавершённую настройку: " +
                              error.localizedDescription
            }
        }
    }

    private func recoverRuntimeKey() {
        Task {
            guard keyRecoveryConsent && recoveryInspected &&
                  keyAccountReady && keyInventoryChecked &&
                  !model.runtimeKeyRecoveryAttempted else {
                model.error = "Сначала проверь существующий Service Account и " +
                              "подтверди выпуск нового ключа."
                return
            }
            model.busy = true
            model.error = ""
            model.note = ""
            defer { model.busy = false }
            do {
                _ = try await WizardBridge.perform("check-ownership")
                let result = try await WizardBridge.perform("runtime-recover-key",[
                    "confirmed":true,
                    "acknowledgePossiblePreviousKey":true,
                    "adminKey":adminKey
                ])
                guard let secret = result["runtimeKey"] as? String,
                      secret.hasPrefix("sk-") else {
                    model.error = "OpenAI не вернул секрет нового ключа. " +
                                  "Повторное создание запрещено."
                    await model.refresh()
                    return
                }
                try PrivateKeychain.save(service:TunnelPaths.terminalService,value:secret)
                try PrivateKeychain.save(service:TunnelPaths.browserService,value:secret)
                adminKey = ""
                keyRecoveryConsent = false
                await model.refresh()
                do {
                    _ = try await WizardBridge.perform("verify-remote",
                                                       ["runtimeKey":secret])
                    _ = try await WizardBridge.perform("configure",
                                                       ["confirmed":true])
                    await model.refresh()
                    model.navigate(to:3)
                    model.note = "Новый Runtime API Key сохранён в Keychain. " +
                                 "Профили настроены."
                } catch {
                    model.error = "Новый ключ сохранён в Keychain, но его права " +
                                  "или профили пока не подтверждены: " +
                                  error.localizedDescription +
                                  " Используй проверку сохранённого ключа. " +
                                  "Ещё один ключ не создавай."
                }
            } catch {
                await model.refresh()
                keyRecoveryConsent = false
                recoveryInspected = false
                model.error = "Восстановление ключа не завершено: " +
                              error.localizedDescription +
                              " Новый запрос автоматически не повторяется."
            }
        }
    }

    private func configureRuntimeAutomatically() {
        Task {
            if model.runtimeProjectSelected && !recoveryInspected {
                model.error = "Предыдущая настройка не завершена. " +
                              "Сначала нажми «Проверить ресурсы OpenAI (без изменений)»."
                return
            }
            if recoveryRoleFound && recoveryRolePermissionsValid &&
               !recoveryRoleHasValidID {
                model.error = "Роль имеет нужные права, но OpenAI не подтвердил её ID. " +
                              "Не создаём новую роль. Выбери ручной Runtime API Key."
                return
            }
            model.busy = true
            model.error = ""
            model.note = ""
            defer { model.busy = false }
            do {
                _ = try await WizardBridge.perform("check-ownership")
                let data = try await WizardBridge.perform("runtime-auto",[
                    "confirmed":true,
                    "adminKey":adminKey,
                    "projectId": runtimeProjectMode == "existing" ?
                                 chosenRuntimeProject : "",
                    "createProject": runtimeProjectMode == "create",
                    "replaceDefaultProject": recoveryInspected &&
                                             recoveryDefaultProject &&
                                             runtimeProjectMode == "create",
                    "retryMissingRole": recoveryInspected &&
                                        model.runtimeOperationPending == "role" &&
                                        !recoveryRoleFound &&
                                        recoveryRoleRetryConfirmed,
                    "replaceInvalidRole": recoveryInspected &&
                                          recoveryRoleFound &&
                                          !recoveryRolePermissionsValid &&
                                          recoveryRoleReplacementConfirmed
                ])
                guard let secret = data["runtimeKey"] as? String,
                      secret.hasPrefix("sk-") else {
                    model.error = "OpenAI не выдал ключ. Используй ручную настройку."
                    return
                }
                // Credential travels only over the local Python -> Swift pipe,
                // directly into Keychain. It is never shown or logged.
                try PrivateKeychain.save(service:TunnelPaths.terminalService,value:secret)
                try PrivateKeychain.save(service:TunnelPaths.browserService,value:secret)
                adminKey = ""
                runtimeProjects = []
                chosenRuntimeProject = ""
                // Verification can fail temporarily while organization roles
                // propagate. In that case the issued key remains in Keychain;
                // do NOT create another service account or key.
                do {
                    _ = try await WizardBridge.perform("verify-remote",["runtimeKey":secret])
                    _ = try await WizardBridge.perform("configure",["confirmed":true])
                    await model.refresh()
                    model.navigate(to:3)
                    model.note = "Ограниченный ключ создан и сохранён в Keychain. Профили готовы."
                } catch {
                    model.error = "Ключ создан и сохранён в Keychain. Но OpenAI пока " +
                                  "не подтвердил доступ к туннелям: " +
                                  error.localizedDescription +
                                  " Повтори проверку ниже, не создавая ещё один ключ."
                }
            } catch {
                let description = error.localizedDescription
                // Failed POSTs may have changed the local operation journal.
                // Refresh the exact state and require another READ-only
                // inspection instead of letting the user press POST again.
                await model.refresh()
                recoveryInspected = false
                recoveryRoleReplacementConfirmed = false
                recoveryRoleRetryConfirmed = false
                model.error = "Автоматическая настройка не завершена: " +
                              description +
                              " Используй «Проверить ресурсы OpenAI» или " +
                              "переключись на ручной Runtime API Key."
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
                if model.error.isEmpty { replaceRuntimeKey = false }
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
            heading("5. Личный Chrome",
                    "Playwright подключается к твоему открытому Google Chrome, а не создаёт отдельный профиль.")

            Text("1. Разреши подключение к Chrome")
                .font(.system(size:13,weight:.semibold))
                .foregroundStyle(Palette.ink)
            Text("Открой chrome://inspect/#remote-debugging в Google Chrome, " +
                 "включи «Allow remote debugging for this browser instance» " +
                 "и подтверди запрос Chrome, если он появится.")
                .font(.system(size:12))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)
            Button {
                guard let url = URL(string:"chrome://inspect/#remote-debugging"),
                      let chrome = NSWorkspace.shared.urlForApplication(
                        withBundleIdentifier:"com.google.Chrome"
                      ) else {
                    model.error = "Google Chrome не найден. Установи Google Chrome " +
                                  "или открой chrome://inspect/#remote-debugging в его адресной строке."
                    return
                }
                // Explicitly dispatch the chrome:// URL to Chrome. Sending this
                // scheme to the macOS default handler triggers "No application
                // is set to open the URL" even when Chrome is installed.
                NSWorkspace.shared.open(
                    [url], withApplicationAt:chrome,
                    configuration:NSWorkspace.OpenConfiguration()
                ) { _, error in
                    if let error {
                        DispatchQueue.main.async {
                            model.error = "Chrome не смог открыть настройки: " +
                                          error.localizedDescription +
                                          ". Вставь chrome://inspect/#remote-debugging " +
                                          "в адресную строку Google Chrome."
                        }
                    }
                }
            } label: {
                Label("Открыть разрешение Remote Debugging в Chrome",
                      systemImage:"arrow.up.right.square")
                    .font(.system(size:12,weight:.semibold))
            }

            Divider()

            Text("2. Запусти локальные службы")
                .font(.system(size:13,weight:.semibold))
                .foregroundStyle(Palette.ink)
            HStack {
                Button("Запустить Terminal MCP") {
                    Task { await model.perform("start-local",
                        data:["confirmed":true,"group":"terminal"]) }
                }
                Button("Запустить Playwright и туннель") {
                    Task { await model.perform("start-local",
                        data:["confirmed":true,"group":"playwright"]) }
                }
            }
            .disabled(model.busy || !model.localServicesInstalled)

            Text("3. Проверь доступность MCP")
                .font(.system(size:13,weight:.semibold))
                .foregroundStyle(Palette.ink)
            Button("Проверить локальные MCP") {
                Task { await model.perform("verify-local") }
            }
            .disabled(model.busy)
            VStack(alignment:.leading,spacing:9) {
                HStack {
                    Label("Terminal: \(model.terminalReady ? "готов" : "не подтверждён")",
                          systemImage:model.terminalReady ? "checkmark.circle" : "circle.dotted")
                    Spacer()
                    Label("Browser MCP: \(model.browserMcpReady ? "готов" : "не подтверждён")",
                          systemImage:model.browserMcpReady ? "checkmark.circle" : "circle.dotted")
                }
                Label("Вкладки Chrome CDP: \(model.browserReady ? "доступны" : "не подтверждены")",
                      systemImage:model.browserReady ? "checkmark.circle" : "circle.dotted")
            }
            .font(.system(size:12))
            if model.browserMcpReady && !model.browserReady {
                Text(model.browserDetail.isEmpty
                     ? "Playwright MCP запущен, но Chrome пока не отдал список вкладок. " +
                       "Проверь Remote Debugging. Терминал перезапускать не нужно."
                     : model.browserDetail)
                    .font(.system(size:11))
                    .foregroundStyle(Palette.warning)
                    .fixedSize(horizontal:false,vertical:true)
            } else if model.terminalReady && !model.browserMcpReady {
                Text("Terminal MCP уже доступен. Запусти Playwright и proxy, " +
                     "после чего проверь Browser MCP. Терминал перезапускать не нужно.")
                    .font(.system(size:11))
                    .foregroundStyle(Palette.warning)
                    .fixedSize(horizontal:false,vertical:true)
            }
            Text("Проверка здесь локальная. Для полного подтверждения подключения " +
                 "на следующем этапе нужен реальный вызов MCP из ChatGPT.")
                .font(.system(size:11))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)
        }
        .onAppear {
            if !model.busy {
                Task { await model.perform("verify-local") }
            }
        }
    }

    private var chatgptStep: some View {
        VStack(alignment:.leading,spacing:13) {
            heading("6. Подключение в ChatGPT",
                    "Добавь два персональных MCP-плагина — отдельно для терминала и браузера.")
            Text("ChatGPT создаёт подключения на сайте. McpGo не получает доступ к твоему аккаунту ChatGPT.")
                .font(.system(size:12)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)

            Button {
                NSWorkspace.shared.open(URL(string:"https://chatgpt.com/plugins")!)
            } label: {
                Label("Открыть плагины ChatGPT",systemImage:"arrow.up.right.square")
            }

            VStack(alignment:.leading,spacing:9) {
                Label("1. На странице плагинов нажми «Добавить» (справа сверху).",
                      systemImage:"1.circle")
                Label("2. Выбери «Добавить пользовательский сервер MCP».",
                      systemImage:"2.circle")
                Label("3. Укажи имя плагина и в разделе «Подключение» выбери «Туннель».",
                      systemImage:"3.circle")
                Label("4. Выбери нужный туннель из списка или вставь Tunnel ID ниже.",
                      systemImage:"4.circle")
                Label("5. Выбери «Без аутентификации», подтверди предупреждение и нажми «Создать в виде плагина».",
                      systemImage:"5.circle")
                Label("6. ChatGPT автоматически откроет окно «Подключить». Нажми кнопку подключения — искать плагин в «Личные» не нужно.",
                      systemImage:"6.circle")
            }
            .font(.system(size:12))
            .foregroundStyle(Palette.ink)
            .fixedSize(horizontal:false,vertical:true)

            DisclosureGroup(isExpanded:$showChatGPTFormGuide) {
                VStack(alignment:.leading,spacing:10) {
                    Text("1–2. На странице ChatGPT Plugins нажми «Добавить» → «Добавить пользовательский сервер MCP».")
                        .font(.system(size:12,weight:.semibold))
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal:false,vertical:true)
                    chatgptHelpImage(
                        "chatgpt-plugin-menu",
                        description:"Страница ChatGPT Plugins с раскрытым меню «Добавить» и пунктом «Добавить пользовательский сервер MCP»"
                    )
                    Text("3–5. Заполни форму подключения. Ниже пример для McpGo Terminal. Название и описание можно изменить. Вместо Tunnel ID на скриншоте используй ID, который создал твой мастер.")
                        .font(.system(size:12))
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                    chatgptHelpImage(
                        "chatgpt-server-form",
                        description:"Форма добавления пользовательского MCP-сервера: название McpGo-Terminal, описание Терминал, подключение Туннель, Tunnel ID, без аутентификации и кнопка Создать в виде плагина"
                    )
                    Text("Для локальных серверов McpGo с доступом через Secure MCP Tunnel выбери «Без аутентификации»: это означает отсутствие дополнительного OAuth на уровне самого MCP-сервера, а не публичный доступ к туннелю.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                }
                .padding(.top,12)
            } label: {
                Label("Как подключить MCP — инструкция со скриншотами",
                      systemImage:"photo.on.rectangle.angled")
                    .font(.system(size:12,weight:.semibold))
                    .foregroundStyle(Palette.accent)
            }
            .tint(Palette.accent)

            DisclosureGroup(isExpanded:$showChatGPTNextSteps) {
                VStack(alignment:.leading,spacing:9) {
                    Label("После «Создать в виде плагина» ChatGPT автоматически предложит подключить новый McpGo-Terminal.",
                          systemImage:"checkmark.circle")
                    chatgptHelpImage(
                        "chatgpt-connect-confirmation",
                        description:"Автоматическое окно подключения только что созданного плагина McpGo-Terminal с выделенной кнопкой «Подключить»"
                    )
                    Label("Нажми «Подключить» в появившемся окне. Переходить в раздел «Личные» и искать там плагин не требуется.",
                          systemImage:"checkmark.shield")
                    Label("Повтори создание и подключение для McpGo-Browser, выбрав второй Tunnel ID.",
                          systemImage:"arrow.2.circlepath")
                    Text("На шаге 7 проверь оба подключения реальными read-only вызовами инструментов.")
                        .font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                }
                .font(.system(size:12))
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal:false,vertical:true)
                .padding(.top,12)
            } label: {
                Label("После создания: автоматическое подключение",
                      systemImage:"list.bullet.rectangle")
                    .font(.system(size:12,weight:.semibold))
                    .foregroundStyle(Palette.accent)
            }
            .tint(Palette.accent)

            VStack(alignment:.leading,spacing:10) {
                Text("Создай два отдельных подключения")
                    .font(.system(size:13,weight:.semibold))
                    .foregroundStyle(Palette.ink)
                chatgptTunnelRow(name:"McpGo Terminal", description:"Терминал", tunnelID:model.terminalID)
                chatgptTunnelRow(name:"McpGo Browser", description:"Chrome / Playwright", tunnelID:model.browserID)
            }
            .padding(13)
            .frame(maxWidth:.infinity,alignment:.leading)
            .background(Palette.background.opacity(0.45),
                        in:RoundedRectangle(cornerRadius:12))

            Text("Прямой ссылки для открытия формы добавления MCP-сервера у ChatGPT нет: меню «Добавить» нужно нажать вручную.")
                .font(.system(size:11)).foregroundStyle(Palette.quiet)
                .fixedSize(horizontal:false,vertical:true)
            Text("Если туннель не появляется в списке, проверь выбранный ChatGPT Workspace и права Tunnels Read + Use.")
                .font(.system(size:11)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal:false,vertical:true)
            HStack {
                Button("Я добавил плагины — к проверке") {
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

    private func chatgptHelpImage(_ name: String, description: String) -> some View {
        let path = Bundle.main.resourceURL?
            .appendingPathComponent("HelpImages")
            .appendingPathComponent(name + ".png")
        return Group {
            if let path, let screenshot = NSImage(contentsOf:path) {
                Image(nsImage:screenshot)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth:620)
                    .clipShape(RoundedRectangle(cornerRadius:9))
                    .overlay(RoundedRectangle(cornerRadius:9)
                        .stroke(Palette.stroke.opacity(0.7)))
                    .accessibilityLabel(description)
            } else {
                Label("Изображение справки не найдено в приложении.",
                      systemImage:"photo.badge.exclamationmark")
                    .font(.system(size:11))
                    .foregroundStyle(Palette.warning)
            }
        }
    }

    private func chatgptTunnelRow(name: String, description: String, tunnelID: String) -> some View {
        VStack(alignment:.leading,spacing:5) {
            HStack {
                VStack(alignment:.leading,spacing:2) {
                    Text(name).font(.system(size:12,weight:.semibold))
                        .foregroundStyle(Palette.ink)
                    Text(description).font(.system(size:11))
                        .foregroundStyle(Palette.muted)
                }
                Spacer()
                Button("Скопировать Tunnel ID") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(tunnelID, forType:.string)
                }
                .disabled(tunnelID.isEmpty)
                .font(.system(size:11))
            }
            Text(tunnelID.isEmpty ? "Tunnel ID ещё не создан — вернись к шагу 3." : tunnelID)
                .font(.system(size:11,design:.monospaced))
                .foregroundStyle(tunnelID.isEmpty ? Palette.warning : Palette.muted)
                .lineLimit(2)
                .textSelection(.enabled)
        }
        .padding(.vertical,4)
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
