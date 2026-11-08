import AppKit
import SwiftUI
import Foundation

enum McpGoPaths {
    static let userHome = FileManager.default.homeDirectoryForCurrentUser
    /// Distributable builds copy their signed runtime into writable Application Support.
    /// Local developer bundles without RuntimeSeed keep their original source root.
    static let root: String = {
        let sourceRoot = Bundle.main.bundleURL.deletingLastPathComponent().standardizedFileURL.path
        guard let seed = Bundle.main.resourceURL?.appendingPathComponent("RuntimeSeed", isDirectory: true),
              FileManager.default.fileExists(atPath: seed.appendingPathComponent("onboarding/cli.py").path),
              FileManager.default.fileExists(atPath: seed.appendingPathComponent("release-manifest.json").path)
        else { return sourceRoot }

        let fm = FileManager.default
        let support = userHome.appendingPathComponent("Library/Application Support/McpGo", isDirectory: true)
        let installed = support.appendingPathComponent("Runtime", isDirectory: true)
        let check = installed.appendingPathComponent("onboarding/cli.py")
        if fm.fileExists(atPath: check.path) { return installed.standardizedFileURL.path }
        if fm.fileExists(atPath: installed.path) {
            // Never overwrite an existing runtime or follow a symlink.
            return installed.standardizedFileURL.path
        }
        do {
            try fm.createDirectory(at: support, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            let staging = support.appendingPathComponent(".runtime-staging-\(UUID().uuidString)", isDirectory: true)
            try fm.copyItem(at: seed, to: staging)
            do {
                try fm.moveItem(at: staging, to: installed)
            } catch {
                try? fm.removeItem(at: staging)
                if !fm.fileExists(atPath: check.path) { throw error }
            }
        } catch {
            NSLog("McpGo runtime preparation failed: %@", error.localizedDescription)
        }
        return installed.standardizedFileURL.path
    }()
    static let agentDirectory = userHome.appendingPathComponent("Library/LaunchAgents").path
    static var shouldShowOnboarding: Bool {
        let file=userHome.appendingPathComponent(
            "Library/Application Support/McpGo/Onboarding/state.json")
        guard let data=try? Data(contentsOf:file),
              let json=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
              let phase=json["phase"] as? String,
              !phase.isEmpty,
              let source=json["installationRoot"] as? String,
              URL(fileURLWithPath:source).standardizedFileURL.path==root
        else { return true }
        return json["wizardDismissed"] as? Bool != true
    }
}

enum Palette {
    static let background = Color(hex: 0x0D1016)
    static let sidebar = Color(hex: 0x11151D)
    static let panel = Color(hex: 0x191E28)
    static let inner = Color(hex: 0x131822)
    static let stroke = Color(hex: 0x303747)
    static let ink = Color(hex: 0xF1F3F9)
    static let muted = Color(hex: 0xA1AABA)
    static let quiet = Color(hex: 0x778196)
    static let accent = Color(hex: 0x8795FF)
    static let accentSoft = Color(hex: 0x252B48)
    static let online = Color(hex: 0x56D4C5)
    static let warning = Color(hex: 0xF0B771)
    static let red = Color(hex: 0xFF8A92)
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: 1)
    }
}

struct AgentState: Decodable { let loaded:Bool; let running:Bool; let pid:Int? }
struct TerminalState: Decodable { let server:AgentState; let oneshot:AgentState; let tunnel:AgentState }
struct BrowserState: Decodable { let browser:AgentState; let proxy:AgentState; let tunnel:AgentState; let backend:Bool; let proxyReady:Bool; let mcpReady:Bool?; let configured:Bool }
struct HubState: Decodable { let installationRoot:String?; let busy:Bool; let terminal:TerminalState; let playwright:BrowserState }
struct ActionResult: Decodable { let ok:Bool?; let error:String? }

@MainActor final class HubModel: ObservableObject {
    @Published var state: HubState?
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    @Published var updated: Date?
    private let base=URL(string:"http://127.0.0.1:8969")!
    private let root=McpGoPaths.root
    private var poller:Timer?
    private var triedBootstrap=false
    init() {
        poller=Timer.scheduledTimer(withTimeInterval:4, repeats:true){ [weak self] _ in
            Task { @MainActor in guard let self, !self.busy else { return }; await self.refresh() }
        }
        Task { await refresh() }
    }
    private func startDashboard() {
        let uid=String(getuid())
        let svc="gui/\(uid)/com.mcphub.dashboard"
        let plistPath=McpGoPaths.agentDirectory + "/com.mcphub.dashboard.plist"
        guard let raw=FileManager.default.contents(atPath:plistPath),
              let plist=(try? PropertyListSerialization.propertyList(from:raw,format:nil))
                    as? [String:Any],
              let arguments=plist["ProgramArguments"] as? [String],
              arguments.contains(where: {
                  URL(fileURLWithPath:$0).standardizedFileURL.path.hasPrefix(root + "/")
              }) else {
            // Never bootstrap an existing LaunchAgent from another McpGo copy.
            return
        }
        let p=Process(); p.executableURL=URL(fileURLWithPath:"/bin/launchctl")
        p.arguments=["bootstrap","gui/\(uid)",plistPath]
        p.standardOutput=Pipe(); p.standardError=Pipe()
        do { try p.run(); p.waitUntilExit() } catch { print("Dashboard bootstrap: \(error)") }
        print("McpGo dashboard bootstrap checked: \(svc)")
    }
    func refresh() async {
        do {
            var req=URLRequest(url:base.appendingPathComponent("api/status"))
            req.cachePolicy = .reloadIgnoringLocalCacheData; req.timeoutInterval=4
            let (bytes,res)=try await URLSession.shared.data(for:req)
            guard (res as? HTTPURLResponse)?.statusCode==200 else {throw URLError(.badServerResponse)}
            let incoming=try JSONDecoder().decode(HubState.self,from:bytes)
            guard let remoteRoot=incoming.installationRoot,
                  URL(fileURLWithPath: remoteRoot).standardizedFileURL.path==root else {
                state=nil
                self.error="Обнаружена другая установка McpGo. Откройте «Первое подключение», чтобы проверить конфликт и выбрать безопасное действие."
                return
            }
            state=incoming
            updated=Date(); error=nil; triedBootstrap=false
        } catch {
            self.error="Локальная служба не отвечает. Откройте «Первое подключение», чтобы завершить настройку и запустить службы."
            if !triedBootstrap {
                triedBootstrap=true; startDashboard()
                try? await Task.sleep(for:.milliseconds(700))
                await refresh()
            }
        }
    }
    func perform(_ action:String, group:String) async {
        guard !busy, state?.installationRoot == root else {self.error="Подключение к этой установке McpGo не подтверждено.";return}; busy=true; notice=nil
        defer {busy=false}
        do {
            var req=URLRequest(url:base.appendingPathComponent("api/action"))
            req.httpMethod="POST"; req.timeoutInterval=100
            req.setValue("application/json",forHTTPHeaderField:"Content-Type")
            req.setValue("dashboard",forHTTPHeaderField:"X-MCP-Hub")
            req.setValue("http://127.0.0.1:8969",forHTTPHeaderField:"Origin")
            req.httpBody=try JSONSerialization.data(withJSONObject:["group":group,"action":action])
            let (bytes,res)=try await URLSession.shared.data(for:req)
            let output=try JSONDecoder().decode(ActionResult.self,from:bytes)
            guard (res as? HTTPURLResponse)?.statusCode==200 && output.ok==true else {
                throw NSError(domain:"MCPHub",code:1,userInfo:[NSLocalizedDescriptionKey:output.error ?? "Действие не выполнено"])
            }
            notice=action=="stop" ? "Службы остановлены" : "Команда выполнена"; error=nil
        } catch {self.error=error.localizedDescription}
        await refresh()
    }
    func openFolder(_ path:String) {
        openLocalURL(URL(fileURLWithPath:root).appendingPathComponent(path),
                     title:"Папка MCP")
    }

    func openLogs() {
        // Logs belong to ~/Library/Logs/McpGo, not Runtime/logs.
        let folder=McpGoPaths.userHome.appendingPathComponent(
            "Library/Logs/McpGo", isDirectory:true)
        do {
            try FileManager.default.createDirectory(
                at:folder, withIntermediateDirectories:true)
            openLocalURL(folder,title:"Журналы")
        } catch {
            self.error="Не удалось открыть журналы: " + error.localizedDescription
        }
    }

    func openDocumentation() {
        // Ship a readable offline HTML manual inside the signed app bundle.
        guard let page=Bundle.main.resourceURL?
            .appendingPathComponent("Documentation/index.html"),
              FileManager.default.isReadableFile(atPath:page.path) else {
            self.error="Не найдена локальная документация McpGo. " +
                       "Проверь установку приложения."
            return
        }
        openLocalURL(page,title:"Документация")
    }

    private func openLocalURL(_ url:URL,title:String) {
        guard FileManager.default.fileExists(atPath:url.path) else {
            self.error="Не найдена папка или файл «" + title + "»."
            return
        }
        guard NSWorkspace.shared.open(url) else {
            self.error="Не удалось открыть «" + title +
                       "». Проверь приложение по умолчанию для этого типа файла."
            return
        }
        self.error=nil
    }
}


private struct ServiceLine: Identifiable {
    let id: String
    let name: String
    let up: Bool
    let status: String
    var caution = false
}

private struct StatusPill: View {
    let up: Bool
    let partial: Bool
    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(up ? Palette.online : partial ? Palette.warning : Palette.quiet)
                .frame(width: 7, height: 7)
                .shadow(color: up ? Palette.online.opacity(0.35) : .clear, radius: 5)
            Text(up ? "Активен" : partial ? "Частично" : "Отключён")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(up ? Palette.online : partial ? Palette.warning : Palette.muted)
        }
        .padding(.horizontal, 12)
        .frame(height: 29)
        .background(up ? Palette.online.opacity(0.085) : partial ? Palette.warning.opacity(0.085) : Palette.inner,
                    in: Capsule())
        .overlay(Capsule().stroke(up ? Palette.online.opacity(0.20) : Palette.stroke.opacity(0.55), lineWidth: 1))
    }
}

private struct ComponentTile: View {
    let item: ServiceLine
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(item.name)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
            HStack(spacing: 7) {
                Circle().fill(item.up ? Palette.online : item.caution ? Palette.warning : Palette.quiet)
                    .frame(width: 6, height: 6)
                Text(item.status)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(item.up ? Palette.ink : item.caution ? Palette.warning : Palette.quiet)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.inner, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(Palette.stroke.opacity(0.65), lineWidth: 1))
    }
}

private struct ActionButton: View {
    let title: String
    let symbol: String
    let kind: String
    let disabled: Bool
    let action: () -> Void
    var body: some View {
        let primary = kind == "primary"
        let foreground = disabled ? Palette.muted : primary ? Color(hex: 0x101426) : kind == "danger" ? Palette.red : Palette.ink
        let background = disabled ? Palette.inner : primary ? Palette.accent : kind == "danger" ? Palette.red.opacity(0.095) : Palette.inner
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 13)
                .frame(height: 35)
                .foregroundStyle(foreground)
                .background(background, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9)
                    .stroke(disabled ? Palette.stroke : primary ? Palette.accent.opacity(0.2) : kind == "danger" ? Palette.red.opacity(0.27) : Palette.stroke, lineWidth: 1))
                .opacity(disabled ? 0.83 : 1)
        }
        .buttonStyle(HubInteractiveButtonStyle(accent: kind == "danger" ? Palette.red : Palette.accent))
        .disabled(disabled)
    }
}

private struct ServicePanel: View {
    @EnvironmentObject private var model: HubModel
    let name: String
    let sub: String
    let symbol: String
    let group: String
    let components: [ServiceLine]
    let up: Bool
    let partial: Bool
    let footnote: String

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 13) {
                Image(systemName: symbol)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Palette.accent)
                    .frame(width: 44, height: 44)
                    .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.accent.opacity(0.18)))
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
                    Text(sub).font(.system(size: 12)).foregroundStyle(Palette.muted)
                }
                Spacer(minLength: 12)
                StatusPill(up: up, partial: partial)
            }
            HStack(spacing: 9) {
                ForEach(components) { item in ComponentTile(item: item) }
            }
            HStack(alignment: .center, spacing: 12) {
                Text(footnote)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Palette.quiet)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ActionButton(title: "Запустить", symbol: "play.fill", kind: "primary", disabled: model.busy || model.state == nil || up) {
                    Task { await model.perform("start", group: group) }
                }
                ActionButton(title: "Стоп", symbol: "stop.fill", kind: "danger", disabled: model.busy || !partial) {
                    Task { await model.perform("stop", group: group) }
                }
                ActionButton(title: "Рестарт", symbol: "arrow.clockwise", kind: "normal", disabled: model.busy || !partial) {
                    Task { await model.perform("restart", group: group) }
                }
            }
        }
        .padding(19)
        .background(Palette.panel, in: RoundedRectangle(cornerRadius: 17))
        .overlay(RoundedRectangle(cornerRadius: 17).stroke(Palette.stroke.opacity(0.85), lineWidth: 1))
    }
}

private struct SidebarLink: View {
    let name: String
    let symbol: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 13) {
                Image(systemName: symbol).font(.system(size: 15, weight: .medium)).frame(width: 18)
                Text(name).font(.system(size: 13, weight: .medium))
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .medium)).foregroundStyle(Palette.quiet)
            }
            .foregroundStyle(Palette.muted)
            .padding(.horizontal, 14)
            .frame(height: 42)
            .contentShape(Rectangle())
        }
        .buttonStyle(HubInteractiveButtonStyle(treatment: .navigation))
    }
}

private struct SidebarView: View {
    @EnvironmentObject private var model: HubModel
    let activeCount: Int
    @Binding var section: String
    let unreadCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                if let markURL = Bundle.main.url(forResource: "McpGoMark", withExtension: "png"),
                   let mark = NSImage(contentsOf: markURL) {
                    Image(nsImage: mark)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 43, height: 43)
                        .accessibilityLabel("McpGo")
                } else {
                    Image(systemName: "infinity")
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(Palette.accent)
                        .frame(width: 43, height: 43)
                        .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 12))
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("McpGo")
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                    if Bundle.main.bundleIdentifier == "local.mcphub.native.dev" {
                        Text("DEV PREVIEW · НЕ РЕЛИЗ")
                            .font(.system(size: 9, weight: .bold, design: .monospaced))
                            .foregroundStyle(Palette.warning)
                    } else {
                        Text("DESKTOP CONTROL")
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .tracking(0.6)
                            .foregroundStyle(Palette.quiet)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 31)
            .padding(.bottom, 45)

            Text("ПРОСТРАНСТВО")
                .font(.system(size: 10, weight: .bold))
                .tracking(1.4)
                .foregroundStyle(Palette.quiet)
                .padding(.leading, 22)
                .padding(.bottom, 13)

            Button { section = "overview" } label: {
                HStack(spacing: 13) {
                    Image(systemName: "square.grid.2x2.fill").font(.system(size: 14)).frame(width: 18)
                    Text("Обзор").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if section == "overview" { Circle().fill(Palette.accent).frame(width: 5, height: 5) }
                }
                .foregroundStyle(section == "overview" ? Palette.accent : Palette.muted)
                .padding(.horizontal, 14).frame(height: 42)
                .background(section == "overview" ? Palette.accent.opacity(0.105) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
            }
            .buttonStyle(HubInteractiveButtonStyle(treatment: .navigation))
            .padding(.horizontal, 11)

            Button { section = "onboarding" } label: {
                HStack(spacing: 13) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 14)).frame(width: 18)
                    Text("Первое подключение").font(.system(size: 13, weight: .semibold))
                    Spacer()
                }
                .foregroundStyle(section == "onboarding" ? Palette.accent : Palette.muted)
                .padding(.horizontal, 14).frame(height: 42)
                .background(section == "onboarding" ? Palette.accent.opacity(0.105) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(HubInteractiveButtonStyle(treatment: .navigation))
            .padding(.horizontal, 11)

            Button { section = "messages" } label: {
                HStack(spacing: 13) {
                    Image(systemName: "bubble.left.and.bubble.right.fill").font(.system(size: 14)).frame(width: 18)
                    Text("Связь агентов").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if unreadCount > 0 {
                        Text(String(unreadCount)).font(.system(size: 10, weight: .bold)).padding(.horizontal, 7)
                            .frame(height: 20).background(Palette.accentSoft, in: Capsule())
                    }
                }
                .foregroundStyle(section == "messages" ? Palette.accent : Palette.muted)
                .padding(.horizontal, 14).frame(height: 42)
                .background(section == "messages" ? Palette.accent.opacity(0.105) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
            }
            .buttonStyle(HubInteractiveButtonStyle(treatment: .navigation))
            .padding(.horizontal, 11)

            Button { section = "settings" } label: {
                HStack(spacing:13) {
                    Image(systemName:"gearshape.fill").font(.system(size:14)).frame(width:18)
                    Text("Настройки туннелей").font(.system(size:13,weight:.semibold))
                    Spacer()
                    if section=="settings" { Circle().fill(Palette.accent).frame(width:5,height:5) }
                }
                .foregroundStyle(section=="settings" ? Palette.accent : Palette.muted)
                .padding(.horizontal,14).frame(height:42)
                .background(section=="settings" ? Palette.accent.opacity(0.105) : Color.clear,
                            in:RoundedRectangle(cornerRadius:10))
                .contentShape(Rectangle())
            }
            .buttonStyle(HubInteractiveButtonStyle(treatment: .navigation)).padding(.horizontal,11)

            Button { section = "skills" } label: {
                HStack(spacing: 13) {
                    Image(systemName: "sparkles.rectangle.stack.fill")
                        .font(.system(size: 14)).frame(width: 18)
                    Text("Навыки").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    if section == "skills" { Circle().fill(Palette.accent).frame(width: 5, height: 5) }
                }
                .foregroundStyle(section == "skills" ? Palette.accent : Palette.muted)
                .padding(.horizontal, 14).frame(height: 42)
                .background(section == "skills" ? Palette.accent.opacity(0.105) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
            }
            .buttonStyle(HubInteractiveButtonStyle(treatment: .navigation))
            .padding(.horizontal, 11)

            Button { section = "autosend" } label: {
                HStack(spacing:13) {
                    Image(systemName:"clock.badge.checkmark").font(.system(size:14)).frame(width:18)
                    Text("Сообщения по таймеру").font(.system(size:12.5,weight:.semibold))
                    Spacer()
                    if section=="autosend" { Circle().fill(Palette.accent).frame(width:5,height:5) }
                }
                .foregroundStyle(section=="autosend" ? Palette.accent : Palette.muted)
                .padding(.horizontal,14).frame(height:42)
                .background(section=="autosend" ? Palette.accent.opacity(0.105) : Color.clear,
                            in:RoundedRectangle(cornerRadius:10))
                .contentShape(Rectangle())
            }
            .buttonStyle(HubInteractiveButtonStyle(treatment:.navigation))
            .padding(.horizontal,11)

            Text("ИНСТРУМЕНТЫ")
                .font(.system(size: 10, weight: .bold))
                .tracking(1.4)
                .foregroundStyle(Palette.quiet)
                .padding(.leading, 22)
                .padding(.top, 36)
                .padding(.bottom, 10)

            SidebarLink(name: "Папка MCP", symbol: "folder") { model.openFolder("") }
            SidebarLink(name: "Журналы", symbol: "text.alignleft") { model.openLogs() }
            SidebarLink(name: "Документация", symbol: "book.closed") { model.openDocumentation() }

            Spacer(minLength: 20)

            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Circle().fill(activeCount > 0 ? Palette.online : Palette.quiet)
                        .frame(width: 7, height: 7)
                    Text("СОСТОЯНИЕ MCP")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.0).foregroundStyle(Palette.muted)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(activeCount)")
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                    Text("/ 2 системы активны")
                        .font(.system(size: 11)).foregroundStyle(Palette.quiet)
                }
                Rectangle().fill(Palette.stroke).frame(height: 1)
                HStack(spacing: 7) {
                    Image(systemName: "lock.shield")
                    Text("Локальное соединение")
                }
                .font(.system(size: 10.5)).foregroundStyle(Palette.quiet)
            }
            .padding(15)
            .background(Palette.inner, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.stroke.opacity(0.70)))
            .padding(.horizontal, 12)
            .padding(.bottom, 21)
        }
        .frame(width: 220)
        .background(Palette.sidebar)
        .overlay(alignment: .trailing) { Rectangle().fill(Palette.stroke.opacity(0.70)).frame(width: 1) }
    }
}

private struct DashboardView: View {
    @EnvironmentObject private var model: HubModel
    @StateObject private var bus = AgentBus()
    @State private var section = McpGoPaths.shouldShowOnboarding ? "onboarding" : "overview"

    private var terminalOn: Bool {
        guard let t=model.state?.terminal else {return false}
        return t.server.running && t.oneshot.running && t.tunnel.running
    }
    private var browserOn: Bool {
        guard let p=model.state?.playwright else {return false}
        return p.browser.running && p.backend && p.proxy.running && p.proxyReady && (p.mcpReady == true) && p.tunnel.running
    }
    private var activeCount: Int { (terminalOn ? 1 : 0) + (browserOn ? 1 : 0) }
    private var terminalParts: [ServiceLine] {
        guard let t=model.state?.terminal else {
            return ["Command server", "OneShot / jobs", "Secure MCP tunnel"].enumerated().map {
                ServiceLine(id:"t\($0.offset)",name:$0.element,up:false,status:"Ожидание")
            }
        }
        return [
            ServiceLine(id:"command", name:"Command server", up:t.server.running, status:t.server.running ? "Работает" : "Остановлен"),
            ServiceLine(id:"oneshot", name:"OneShot / jobs", up:t.oneshot.running, status:t.oneshot.running ? "Работает" : "Остановлен"),
            ServiceLine(id:"terminal-tunnel", name:"Secure MCP tunnel", up:t.tunnel.running, status:t.tunnel.running ? "Процесс запущен" : "Остановлен")
        ]
    }
    private var browserParts: [ServiceLine] {
        guard let p=model.state?.playwright else {
            return ["Google Chrome CDP · 8931", "Safe proxy · 8940", "Secure MCP tunnel"].enumerated().map {
                ServiceLine(id:"p\($0.offset)",name:$0.element,up:false,status:"Ожидание")
            }
        }
        return [
            ServiceLine(id:"browser", name:"Google Chrome CDP · 8931", up:p.backend && p.browser.running,
                        status:p.backend ? "Порт открыт" : "Остановлен", caution:p.browser.running && !p.backend),
            ServiceLine(id:"proxy", name:"Safe proxy · 8940", up:p.proxyReady && p.proxy.running && p.mcpReady == true,
                        status:!p.proxyReady ? "Остановлен" : (p.mcpReady == true ? "MCP работает" : "MCP недоступен"), caution:p.proxy.running && p.mcpReady != true),
            ServiceLine(id:"browser-tunnel", name:"Secure MCP tunnel", up:p.tunnel.running,
                        status:!p.configured ? "Не настроен" : p.tunnel.running ? "Процесс запущен" : "Остановлен", caution:!p.configured)
        ]
    }

    var body: some View {
        HStack(spacing: 0) {
            SidebarView(activeCount: activeCount, section: $section, unreadCount: bus.unreadCount)
            if section == "onboarding" {
                OnboardingView()
            } else if section == "messages" {
                MessagingView().environmentObject(bus)
            } else if section == "settings" {
                TunnelSettingsView().environmentObject(model)
            } else if section == "skills" {
                SkillsView()
            } else if section == "autosend" {
                ScheduledMessagesView()
            } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("CONTROL CENTER")
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .tracking(2).foregroundStyle(Palette.accent)
                            Text("Сервисы MCP")
                                .font(.system(size: 29, weight: .bold, design: .rounded))
                                .foregroundStyle(Palette.ink)
                            Text("Управление подключениями ChatGPT на этом Mac")
                                .font(.system(size: 12.5)).foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        Button {
                            Task { await model.refresh() }
                        } label: {
                            Label("Обновить", systemImage: "arrow.clockwise")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Palette.muted)
                                .padding(.horizontal, 15)
                                .frame(height: 36)
                                .background(Palette.panel, in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.stroke))
                        }
                        .buttonStyle(HubInteractiveButtonStyle())
                        .help("Обновить статусы подключений")
                    }
                    .padding(.bottom, 3)

                    HStack(spacing: 13) {
                        Image(systemName: "waveform.path")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Palette.accent)
                            .frame(width: 40, height: 40)
                            .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Локальные подключения")
                                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Palette.ink)
                            Text(activeCount == 2 ? "Все системы работают" : activeCount == 1 ? "Одна система активна" : "Подключения остановлены")
                                .font(.system(size: 11.5)).foregroundStyle(Palette.muted)
                        }
                        Spacer(minLength: 8)
                        Text("\(activeCount) / 2")
                            .font(.system(size: 23, weight: .semibold, design: .rounded))
                            .monospacedDigit().foregroundStyle(Palette.ink)
                        Rectangle().fill(Palette.stroke).frame(width: 1, height: 30).padding(.horizontal, 4)
                        Label("127.0.0.1", systemImage: "lock.fill")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(Palette.quiet)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(Palette.panel, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.stroke.opacity(0.75)))

                    HStack(spacing: 8) {
                        Text("ПОДКЛЮЧЕНИЯ")
                            .font(.system(size: 10, weight: .bold))
                            .tracking(1.5).foregroundStyle(Palette.quiet)
                        Rectangle().fill(Palette.stroke.opacity(0.70)).frame(height: 1)
                    }
                    .padding(.top, 3)

                    let t=model.state?.terminal
                    ServicePanel(name:"Терминал", sub:"ChatTerminalHub  ·  Команды и задачи Mac", symbol:"terminal", group:"terminal",
                                 components:terminalParts, up:terminalOn,
                                 partial:(t.map{$0.server.running || $0.oneshot.running || $0.tunnel.running} ?? false),
                                 footnote:"Автозапуск при входе в macOS")

                    let p=model.state?.playwright
                    ServicePanel(name:"Playwright", sub:"Личный Google Chrome  ·  CDP", symbol:"globe", group:"playwright",
                                 components:browserParts, up:browserOn,
                                 partial:(p.map{$0.browser.running || $0.proxy.running || $0.tunnel.running} ?? false),
                                 footnote:"Запускается вручную по необходимости")

                    HStack(spacing: 8) {
                        if model.busy {
                            ProgressView().controlSize(.small).tint(Palette.accent)
                            Text("Выполняется действие…")
                        } else if let error=model.error {
                            Image(systemName:"exclamationmark.triangle.fill").foregroundStyle(Palette.red)
                            VStack(alignment:.leading,spacing:7) {
                                Text(error).foregroundStyle(Palette.red)
                                    .fixedSize(horizontal:false,vertical:true)
                                Button {
                                    section = "onboarding"
                                } label: {
                                    Label("Открыть «Первое подключение»",systemImage:"arrow.up.right")
                                        .font(.system(size:12,weight:.semibold))
                                        .foregroundStyle(Palette.accent)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Перейти к мастеру настройки McpGo")
                            }
                        } else if let notice=model.notice {
                            Image(systemName:"checkmark.circle.fill").foregroundStyle(Palette.online)
                            Text(notice).foregroundStyle(Palette.muted)
                        } else {
                            Image(systemName:"checkmark.shield").foregroundStyle(Palette.quiet)
                            Text("Все команды выполняются только на этом Mac")
                        }
                        Spacer()
                        if let date=model.updated {
                            Text("Обновлено \(date.formatted(date:.omitted,time:.standard))")
                                .monospacedDigit()
                        }
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.quiet)
                    .padding(.top, 2)
                }
                .padding(.horizontal, 27)
                .padding(.top, 31)
                .padding(.bottom, 27)
            }
            .scrollIndicators(.hidden)
            .background(Palette.background)
            }
        }
        .background(Palette.background)
        .task { await bus.refresh() }
    }
}

@main struct McpGo: App {
    @StateObject private var model = HubModel()
    var body: some Scene {
        WindowGroup("McpGo") {
            DashboardView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .frame(minWidth: 990, minHeight: 690)
                .onAppear { NSApp.appearance = NSAppearance(named: .darkAqua) }
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1100, height: 800)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Обновить состояние") { Task { await model.refresh() } }
                    .keyboardShortcut("r", modifiers:[.command])
            }
        }
    }
}
