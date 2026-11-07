import Foundation
import Security
import Darwin

// Install full-length API key without putting it into process argv, environment,
// files, shell history, or the 128-character interactive security CLI prompt.
func fail(_ message: String) -> Never {
    fputs("Ошибка: \(message)\n", stderr)
    exit(1)
}
func readHiddenLine() -> String? {
    let fd = STDIN_FILENO
    let tty = isatty(fd) != 0
    var original = termios()
    if tty {
        guard tcgetattr(fd, &original) == 0 else { fail("Не удалось прочитать состояние терминала") }
        var hidden = original
        hidden.c_lflag &= ~tcflag_t(ECHO)
        guard tcsetattr(fd, TCSANOW, &hidden) == 0 else { fail("Не удалось скрыть ввод") }
    }
    print("Вставь полный OpenAI API key и нажми Enter (ввод скрыт): ", terminator: "")
    fflush(stdout)
    let line = readLine(strippingNewline: true)
    if tty {
        _ = tcsetattr(fd, TCSANOW, &original)
        print("")
    }
    return line
}
let selfTest = CommandLine.arguments.contains("--self-test")
guard let token = readHiddenLine() else { fail("Ключ не введён") }
let data = Data(token.utf8)
guard token.hasPrefix("sk-") else { fail("Некорректный префикс OpenAI API key") }
guard data.count > 128 else { fail("Ключ содержит только \(data.count) байт (ожидается больше 128). Проверь, что скопировал его полностью.") }
guard data.count < 4096 else { fail("Неожиданно большая длина ключа") }
guard token.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else { fail("Ключ содержит пробелы или недопустимые символы; скопируй без пробелов и переводов строки") }
if selfTest {
    print("SELF_TEST_OK: считано \(data.count) байт без обрезки. Реальная Связка ключей не изменена.")
    exit(0)
}
let service = "com.chat-terminal-hub.openai.tunnel"
let account = NSUserName()
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account
]
let update: [String: Any] = [kSecValueData as String: data]
let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
if status == errSecItemNotFound {
    var item = query
    item[kSecAttrLabel as String] = "ChatTerminalHub OpenAI runtime tunnel key"
    item[kSecValueData as String] = data
    let addStatus = SecItemAdd(item as CFDictionary, nil)
    guard addStatus == errSecSuccess else { fail("Не удалось создать запись в Keychain: OSStatus \(addStatus)") }
} else if status != errSecSuccess {
    fail("Не удалось обновить Keychain: OSStatus \(status)")
}
var checkQuery = query
checkQuery[kSecReturnData as String] = true
checkQuery[kSecMatchLimit as String] = kSecMatchLimitOne
var stored: CFTypeRef?
let readStatus = SecItemCopyMatching(checkQuery as CFDictionary, &stored)
guard readStatus == errSecSuccess, let check = stored as? Data, check == data else {
    fail("Проверка Keychain не прошла. Не запускай туннель, пока не исправим сохранение.")
}
print("УСПЕХ: Keychain сохранил все \(check.count) байт без обрезки.")
print("Последние четыре символа для сверки с OpenAI Platform: \(String(token.suffix(4)))")
print("API-ключ целиком никуда не выводился.")
