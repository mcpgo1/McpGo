import AppKit
import SwiftUI
import Security
import Foundation
import Darwin

enum TunnelPaths {
    static let terminalProfile = McpGoPaths.userHome.appendingPathComponent(".config/tunnel-client/chat-terminal-hub.yaml").path
    static let browserID = McpGoPaths.userHome.appendingPathComponent("Library/Application Support/McpGo/playwright/tunnel.id").path
    static let browserOldKey = McpGoPaths.userHome.appendingPathComponent("Library/Application Support/McpGo/playwright/tunnel.key").path
    static let terminalService = "com.chat-terminal-hub.openai.tunnel"
    static let browserService = "com.mcphub.playwright.openai.tunnel"
}

private enum TunnelCredentialError: LocalizedError {
    case invalidTunnelID
    case invalidKey
    case fileSecurity
    case missingProfile
    case noMatchingProfileField
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidTunnelID: return "Tunnel ID должен начинаться с tunnel_ и содержать только латинские буквы, цифры, дефис или _."
        case .invalidKey: return "API-ключ не должен содержать пробелы, переносы строк или управляющие символы."
        case .fileSecurity: return "Проверка защищённого файла не прошла (ссылка или неподходящие права)."
        case .missingProfile: return "Конфигурационный профиль терминального туннеля не найден."
        case .noMatchingProfileField: return "Не удалось найти ровно одно поле tunnel_id в профиле терминала."
        case .keychain(let status): return "Не удалось сохранить API-ключ в Связке ключей macOS (код \(status))."
        }
    }
}

enum PrivateKeychain {
    static let account = NSUserName()

    private static func query(_ service: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func exists(_ service: String) -> Bool {
        var q = query(service)
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        q[kSecReturnAttributes as String] = true
        var found: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &found) == errSecSuccess
    }

    static func read(service:String) -> String? {
        var q=query(service)
        q[kSecMatchLimit as String]=kSecMatchLimitOne
        q[kSecReturnData as String]=true
        var result:CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary,&result)==errSecSuccess,
              let data=result as? Data else {return nil}
        return String(data:data,encoding:.utf8)
    }

    static func save(service: String, value: String) throws {
        guard !value.isEmpty, value.count < 4096,
              value.unicodeScalars.allSatisfy({ !$0.properties.isWhitespace && $0.value >= 0x21 && $0.value != 0x7f }) else {
            throw TunnelCredentialError.invalidKey
        }
        let bytes = Data(value.utf8)
        let query = query(service)
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String:bytes] as CFDictionary)
        if updated == errSecSuccess { return }
        if updated != errSecItemNotFound { throw TunnelCredentialError.keychain(updated) }
        var props = query
        props[kSecValueData as String] = bytes
        props[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(props as CFDictionary, nil)
        guard added == errSecSuccess else { throw TunnelCredentialError.keychain(added) }
    }
}

private enum TunnelFiles {
    static func validateID(_ value: String) throws -> String {
        let id = value.trimmingCharacters(in:.whitespacesAndNewlines)
        guard id.range(of:"^tunnel_[A-Za-z0-9_-]{3,180}$",options:.regularExpression) != nil else {
            throw TunnelCredentialError.invalidTunnelID
        }
        return id
    }

    static func secureRead(_ path: String) throws -> String {
        let url = URL(fileURLWithPath:path)
        let attrs = try FileManager.default.attributesOfItem(atPath:path)
        guard attrs[.type] as? FileAttributeType == .typeRegular,
              ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 999) & 0o077 == 0,
              !((try? url.resourceValues(forKeys:[.isSymbolicLinkKey]))?.isSymbolicLink ?? true) else {
            throw TunnelCredentialError.fileSecurity
        }
        return try String(contentsOf:url,encoding:.utf8)
    }

    static func secureReplace(_ content: String, at path: String) throws {
        let destination = URL(fileURLWithPath:path)
        _ = try secureRead(path)
        let folder = destination.deletingLastPathComponent().path
        let template = folder + "/.mcphub-settings-XXXXXX"
        var chars = Array(template.utf8CString)
        let fd = chars.withUnsafeMutableBufferPointer { mkstemp($0.baseAddress!) }
        guard fd >= 0 else { throw TunnelCredentialError.fileSecurity }
        let temporary = String(cString:chars)
        var success = false
        defer {
            close(fd)
            if !success { unlink(temporary) }
        }
        guard fchmod(fd, S_IRUSR | S_IWUSR) == 0 else { throw TunnelCredentialError.fileSecurity }
        let bytes = [UInt8](content.utf8)
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { ptr in
                write(fd, ptr.baseAddress!.advanced(by:offset), bytes.count - offset)
            }
            guard written > 0 else { throw TunnelCredentialError.fileSecurity }
            offset += written
        }
        guard fsync(fd) == 0, rename(temporary,path) == 0 else { throw TunnelCredentialError.fileSecurity }
        success = true
    }

    static func terminalID() throws -> String {
        guard FileManager.default.fileExists(atPath:TunnelPaths.terminalProfile) else {
            throw TunnelCredentialError.missingProfile
        }
        let content = try secureRead(TunnelPaths.terminalProfile)
        return try profileMatch(in:content).id
    }

    private static func profileMatch(in content: String) throws -> (range:Range<String.Index>, id:String) {
        let pattern = #"(?m)^([ \t]*tunnel_id:[ \t]*)["']?(tunnel_[A-Za-z0-9_-]+)["']?([ \t]*(?:#[^\r\n]*)?)$"#
        let regex = try NSRegularExpression(pattern:pattern)
        let nsRange = NSRange(content.startIndex..<content.endIndex,in:content)
        let matches = regex.matches(in:content,range:nsRange)
        guard matches.count == 1,
              let range = Range(matches[0].range(at:2),in:content) else {
            throw TunnelCredentialError.noMatchingProfileField
        }
        return (range,String(content[range]))
    }

    static func updateTerminal(id:String) throws {
        let normalized = try validateID(id)
        let content = try secureRead(TunnelPaths.terminalProfile)
        let match = try profileMatch(in:content)
        if normalized != match.id {
            let updated = content.replacingCharacters(in:match.range,with:normalized)
            try secureReplace(updated,at:TunnelPaths.terminalProfile)
        }
    }

    static func playwrightID() throws -> String {
        try secureRead(TunnelPaths.browserID).trimmingCharacters(in:.whitespacesAndNewlines)
    }

    static func updatePlaywright(id:String) throws {
        let normalized = try validateID(id)
        if try playwrightID() != normalized {
            try secureReplace(normalized,at:TunnelPaths.browserID)
        }
    }

    static func legacyBrowserKeyExists() -> Bool {
        (try? secureRead(TunnelPaths.browserOldKey)).map { !$0.isEmpty } ?? false
    }

    static func migrateBrowserKey() throws {
        if PrivateKeychain.exists(TunnelPaths.browserService) { return }
        let previous = try secureRead(TunnelPaths.browserOldKey).trimmingCharacters(in:.whitespacesAndNewlines)
        try PrivateKeychain.save(service:TunnelPaths.browserService,value:previous)
    }
}

@MainActor final class TunnelSettingsModel: ObservableObject {
    @Published var terminalID = ""
    @Published var browserID = ""
    @Published var terminalNewKey = ""
    @Published var browserNewKey = ""
    @Published var terminalHasKey = false
    @Published var browserHasKey = false
    @Published var browserUsesLegacyKey = false
    @Published var notice: String?
    @Published var error: String?
    @Published var busy = false
    @Published var terminalNeedsRestart = false
    @Published var browserNeedsRestart = false

    func load() {
        do {
            terminalID = try TunnelFiles.terminalID()
            browserID = try TunnelFiles.playwrightID()
            terminalHasKey = PrivateKeychain.exists(TunnelPaths.terminalService)
            browserUsesLegacyKey = !PrivateKeychain.exists(TunnelPaths.browserService) && TunnelFiles.legacyBrowserKeyExists()
            browserHasKey = PrivateKeychain.exists(TunnelPaths.browserService) || browserUsesLegacyKey
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func save(_ kind:String) {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            if kind == "terminal" {
                let validID = try TunnelFiles.validateID(terminalID)
                if !terminalNewKey.isEmpty { try PrivateKeychain.save(service:TunnelPaths.terminalService,value:terminalNewKey) }
                try TunnelFiles.updateTerminal(id:validID)
                terminalNewKey = ""
                terminalNeedsRestart = true
            } else {
                let validID = try TunnelFiles.validateID(browserID)
                if !browserNewKey.isEmpty {
                    try PrivateKeychain.save(service:TunnelPaths.browserService,value:browserNewKey)
                } else if browserUsesLegacyKey {
                    try TunnelFiles.migrateBrowserKey()
                }
                try TunnelFiles.updatePlaywright(id:validID)
                // Only retire the legacy plaintext credential once Keychain confirms
                // the item exists. Old running processes retain their own credentials.
                if PrivateKeychain.exists(TunnelPaths.browserService),
                   FileManager.default.fileExists(atPath:TunnelPaths.browserOldKey) {
                    _ = try TunnelFiles.secureRead(TunnelPaths.browserOldKey)
                    try FileManager.default.removeItem(atPath:TunnelPaths.browserOldKey)
                }
                browserNewKey = ""
                browserNeedsRestart = true
            }
            notice = "Настройки сохранены. Чтобы применить их к запущенному туннелю, используй «Переподключить»."
            error = nil
            load()
        } catch { self.error = error.localizedDescription }
    }

    func didRestart(_ kind: String) {
        if kind=="terminal" { terminalNeedsRestart=false }
        else { browserNeedsRestart=false }
        notice = "Команда переподключения отправлена. Проверь состояние туннеля."
    }
}

private struct CredentialPanel: View {
    let title:String
    let subtitle:String
    let symbol:String
    let guideKind:TunnelGuideKind
    @State private var showingGuide = false
    @Binding var tunnelID:String
    @Binding var newKey:String
    let hasKey:Bool
    let keyDetail:String
    let endpoint:String
    let profile:String
    let isBusy:Bool
    let needsRestart:Bool
    let save:()->Void
    let apply:()->Void

    var body:some View {
        VStack(alignment:.leading,spacing:17) {
            HStack(spacing:12) {
                Image(systemName:symbol)
                    .font(.system(size:20,weight:.medium)).foregroundStyle(Palette.accent)
                    .frame(width:44,height:44)
                    .background(Palette.accentSoft,in:RoundedRectangle(cornerRadius:11))
                VStack(alignment:.leading,spacing:4) {
                    Text(title).font(.system(size:16,weight:.semibold)).foregroundStyle(Palette.ink)
                    Text(subtitle).font(.system(size:11.5)).foregroundStyle(Palette.muted)
                }
                Spacer()
                HStack(spacing:7) {
                    Circle().fill(hasKey ? Palette.online : Palette.warning).frame(width:7,height:7)
                    Text(hasKey ? "Ключ сохранён" : "Ключ отсутствует")
                        .font(.system(size:10.5,weight:.semibold)).foregroundStyle(hasKey ? Palette.online : Palette.warning)
                }
                Button { showingGuide = true } label: {
                    Label("Инструкция",systemImage:"questionmark.circle")
                        .font(.system(size:11.5,weight:.semibold))
                        .foregroundStyle(Palette.accent)
                        .padding(.horizontal,12)
                        .frame(height:32)
                        .background(Palette.accentSoft,in:RoundedRectangle(cornerRadius:9))
                        .overlay(RoundedRectangle(cornerRadius:9).stroke(Palette.accent.opacity(0.27)))
                }
                .buttonStyle(HubInteractiveButtonStyle())
                .help("Как получить Tunnel ID и runtime API-ключ")
            }
            VStack(alignment:.leading,spacing:7) {
                Text("TUNNEL ID").font(.system(size:10,weight:.bold,design:.monospaced))
                    .tracking(1.4).foregroundStyle(Palette.quiet)
                HStack(spacing:9) {
                    TextField("tunnel_...",text:$tunnelID)
                        .textFieldStyle(.plain)
                        .font(.system(size:12,design:.monospaced))
                        .foregroundStyle(Palette.ink)
                        .textSelection(.enabled)
                        .autocorrectionDisabled()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(tunnelID,forType:.string)
                    } label: {
                        Image(systemName:"doc.on.doc").font(.system(size:12)).foregroundStyle(Palette.muted)
                    }.buttonStyle(HubInteractiveButtonStyle()).help("Копировать Tunnel ID")
                }
                .padding(12)
                .background(Palette.inner,in:RoundedRectangle(cornerRadius:9))
                .overlay(RoundedRectangle(cornerRadius:9).stroke(Palette.stroke))
            }
            VStack(alignment:.leading,spacing:7) {
                Text("API KEY").font(.system(size:10,weight:.bold,design:.monospaced))
                    .tracking(1.4).foregroundStyle(Palette.quiet)
                SecureField(hasKey ? "Новый ключ (оставь пустым, чтобы сохранить текущий)" : "Вставь API-ключ",text:$newKey)
                    .textFieldStyle(.plain)
                    .font(.system(size:12))
                    .foregroundStyle(Palette.ink)
                    .textContentType(.password)
                    .privacySensitive()
                    .padding(12)
                    .background(Palette.inner,in:RoundedRectangle(cornerRadius:9))
                    .overlay(RoundedRectangle(cornerRadius:9).stroke(Palette.stroke))
                Label(keyDetail,systemImage:"lock.shield")
                    .font(.system(size:10.5)).foregroundStyle(Palette.quiet)
            }
            HStack(alignment:.top,spacing:12) {
                VStack(alignment:.leading,spacing:4) {
                    Text("Локальный MCP").font(.system(size:10.5)).foregroundStyle(Palette.quiet)
                    Text(endpoint).font(.system(size:11,design:.monospaced)).foregroundStyle(Palette.muted)
                        .textSelection(.enabled)
                }
                Spacer(minLength:8)
                VStack(alignment:.trailing,spacing:4) {
                    Text("Конфигурация").font(.system(size:10.5)).foregroundStyle(Palette.quiet)
                    Text(profile).font(.system(size:11)).foregroundStyle(Palette.muted)
                }
            }
            .padding(12)
            .background(Palette.inner,in:RoundedRectangle(cornerRadius:10))
            HStack(spacing:10) {
                Button(action:save) {
                    Label("Сохранить",systemImage:"checkmark")
                        .font(.system(size:12,weight:.semibold))
                        .foregroundStyle(Color(hex:0x121526))
                        .padding(.horizontal,16).frame(height:36)
                        .background(Palette.accent,in:RoundedRectangle(cornerRadius:9))
                }.buttonStyle(HubInteractiveButtonStyle()).disabled(isBusy || tunnelID.isEmpty)
                Button(action:apply) {
                    Label("Переподключить туннель",systemImage:"arrow.triangle.2.circlepath")
                        .font(.system(size:12,weight:.medium))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal,12).frame(height:36)
                        .background(Palette.inner,in:RoundedRectangle(cornerRadius:9))
                        .overlay(RoundedRectangle(cornerRadius:9).stroke(Palette.stroke))
                }.buttonStyle(HubInteractiveButtonStyle()).disabled(isBusy)
                Spacer()
                if needsRestart {
                    Label("Нужен перезапуск",systemImage:"clock.arrow.circlepath")
                        .font(.system(size:10.5)).foregroundStyle(Palette.warning)
                }
            }
        }
        .padding(19)
        .background(Palette.panel,in:RoundedRectangle(cornerRadius:15))
        .overlay(RoundedRectangle(cornerRadius:15).stroke(Palette.stroke.opacity(0.85)))
        .sheet(isPresented: $showingGuide) { TunnelInstructionView(kind: guideKind) }
    }
}

struct TunnelSettingsView: View {
    @EnvironmentObject private var hub:HubModel
    @StateObject private var config=TunnelSettingsModel()
    @State private var restartTarget:String?

    var body:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:19) {
                HStack {
                    VStack(alignment:.leading,spacing:7) {
                        Text("CONNECTION SETTINGS")
                            .font(.system(size:10,weight:.bold,design:.monospaced))
                            .tracking(1.8).foregroundStyle(Palette.accent)
                        Text("Настройки туннелей")
                            .font(.system(size:28,weight:.bold,design:.rounded)).foregroundStyle(Palette.ink)
                        Text("Обновляй Tunnel ID и API-ключи без редактирования скриптов")
                            .font(.system(size:12)).foregroundStyle(Palette.muted)
                    }
                    Spacer()
                    Button {config.load()} label: {
                        Label("Обновить",systemImage:"arrow.clockwise")
                            .font(.system(size:12)).foregroundStyle(Palette.ink)
                    }.buttonStyle(HubInteractiveButtonStyle(treatment: .bordered))
                }
                HStack(alignment:.top,spacing:10) {
                    Image(systemName:"lock.shield.fill").foregroundStyle(Palette.accent)
                    Text("Секреты не показываются на экране. Новые API-ключи сохраняются в Связке ключей macOS, а Tunnel ID — в конфигурации соответствующего сервиса. Кнопка «Сохранить» не прерывает работающие подключения.")
                        .font(.system(size:11.5)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                }
                .padding(13)
                .frame(maxWidth:.infinity,alignment:.leading)
                .background(Palette.accentSoft.opacity(0.55),in:RoundedRectangle(cornerRadius:11))

                CredentialPanel(title:"TerminalHub",subtitle:"Терминал · Secure MCP Tunnel",symbol:"terminal",guideKind:.terminal,
                                tunnelID:$config.terminalID,newKey:$config.terminalNewKey,
                                hasKey:config.terminalHasKey,keyDetail:"Keychain · com.chat-terminal-hub.openai.tunnel",
                                endpoint:"Профиль: chat-terminal-hub",profile:"chat-terminal-hub.yaml",
                                isBusy:config.busy,needsRestart:config.terminalNeedsRestart,
                                save:{config.save("terminal")},apply:{restartTarget="terminal"})

                CredentialPanel(title:"Playwright",subtitle:"Личный Chrome · CDP · Secure MCP Tunnel",symbol:"globe",guideKind:.playwright,
                                tunnelID:$config.browserID,newKey:$config.browserNewKey,
                                hasKey:config.browserHasKey,
                                keyDetail:config.browserUsesLegacyKey ? "Защищённый файл · будет перенесён в Keychain при сохранении" : "Keychain · com.mcphub.playwright.openai.tunnel",
                                endpoint:"http://127.0.0.1:8940/mcp",profile:"playwright/.cache/tunnel.id",
                                isBusy:config.busy,needsRestart:config.browserNeedsRestart,
                                save:{config.save("playwright")},apply:{restartTarget="playwright"})

                HStack(alignment:.top,spacing:8) {
                    Image(systemName:"info.circle").foregroundStyle(Palette.accent)
                    Text("Переподключение терминального туннеля может временно прервать текущий доступ ChatGPT к Mac. Playwright перезапускает только свой туннель. При ошибке верни прежние значения или проверь журналы.")
                        .fixedSize(horizontal:false,vertical:true)
                        .foregroundStyle(Palette.muted)
                }
                .font(.system(size:11))

                if let error=config.error {
                    Label(error,systemImage:"exclamationmark.triangle.fill")
                        .font(.system(size:11.5)).foregroundStyle(Palette.red)
                        .textSelection(.enabled)
                } else if let notice=config.notice {
                    Label(notice,systemImage:"checkmark.circle.fill")
                        .font(.system(size:11.5)).foregroundStyle(Palette.online)
                }
            }
            .padding(25)
        }
        .scrollIndicators(.hidden)
        .background(Palette.background)
        .onAppear {config.load()}
        .alert("Переподключить туннель?",isPresented:Binding(
            get:{restartTarget != nil},
            set:{if !$0 {restartTarget=nil}}
        )) {
            Button("Отмена",role:.cancel) {restartTarget=nil}
            Button("Переподключить") {
                guard let target=restartTarget else{return}
                restartTarget=nil
                Task {
                    do {
                        try await restartOnlyTunnel(target)
                        config.didRestart(target)
                        await hub.refresh()
                    } catch { config.error=error.localizedDescription }
                }
            }
        } message: {
            Text(restartTarget == "terminal" ?
                 "Текущий терминальный MCP-туннель будет перезапущен. Этот чат ChatGPT может временно потерять доступ к терминалу." :
                 "Перезапустится только внешний туннель Playwright, без остановки браузера и безопасного прокси.")
        }
    }

    private func restartOnlyTunnel(_ target:String) async throws {
        if target == "terminal" {
            var request=URLRequest(url:URL(string:"http://127.0.0.1:8969/api/action")!)
            request.httpMethod="POST"
            request.timeoutInterval=35
            request.setValue("application/json",forHTTPHeaderField:"Content-Type")
            request.setValue("dashboard",forHTTPHeaderField:"X-MCP-Hub")
            request.setValue("http://127.0.0.1:8969",forHTTPHeaderField:"Origin")
            request.httpBody=try JSONSerialization.data(withJSONObject:["group":"terminal-tunnel","action":"restart"])
            let (data,response)=try await URLSession.shared.data(for:request)
            let result=try JSONDecoder().decode(ActionResult.self,from:data)
            guard (response as? HTTPURLResponse)?.statusCode==200 && result.ok==true else {
                throw NSError(domain:"MCPHub",code:1,
                    userInfo:[NSLocalizedDescriptionKey:result.error ?? "Туннель не запустился"])
            }
            return
        }
        try await Task.detached(priority:.userInitiated) {
            let process=Process()
            process.executableURL=URL(fileURLWithPath:"/bin/launchctl")
            process.arguments=["kickstart","-k","gui/\(getuid())/com.mcphub.playwright.tunnel"]
            let sink=Pipe()
            process.standardOutput=sink
            process.standardError=sink
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus==0 else {
                throw NSError(domain:"MCPHub",code:Int(process.terminationStatus),
                              userInfo:[NSLocalizedDescriptionKey:"Не удалось перезапустить туннель. Проверь состояние launchd и журналы."])
            }
        }.value
    }

}
