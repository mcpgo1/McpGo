"""Generate a source-only inventory of McpGo code for documentation/auditing.

Never reads local runtime configuration or includes caches, logs, history binaries.
Use --check in CI to detect a stale generated inventory.
"""
from pathlib import Path
import hashlib
import sys

ROOT = Path(__file__).resolve().parents[1]
DIRECTORIES = {
    "native": {".swift", ".py", ".svg"},
    "onboarding": {".py"},
    "scripts": {".py", ".sh"},
    "dashboard": {".mjs", ".js", ".html", ".css"},
    "terminal": {".js", ".cjs", ".mjs", ".py", ".sh", ".html", ".css"},
    "playwright": {".mjs", ".sh"},
    "autosend": {".mjs", ".js", ".py", ".swift", ".html"},
    "messaging": {".py", ".mjs"},
    "launchers": {".mjs", ".sh"},
    "launchagents": {".plist"},
    "tests": {".py"},
    "tools": {".py"},
    "windows": {".cjs", ".js", ".html", ".css", ".json", ".md", ".py"},
}
EXCLUDE_PATH_PARTS = {
    "legacy", "node_modules", ".cache", "artifacts", "logs", "vendor",
    "__pycache__", "rename-backup-20261106",
    "icon-backup-20261107", "doc-revision-backup-20261107",
}
EXCLUDE_NAMES = {"config.json", "stateless-config.json", "AppIcon.icns"}
OUT = ROOT / "docs/SOURCE_INVENTORY.md"

def source_files():
    for dir_name, extensions in DIRECTORIES.items():
        for p in sorted((ROOT / dir_name).rglob("*")):
            if not p.is_file() or p.is_symlink() or p.suffix not in extensions:
                continue
            if set(p.relative_to(ROOT).parts) & EXCLUDE_PATH_PARTS:
                continue
            if p.name in EXCLUDE_NAMES or ".before-" in p.name:
                continue
            yield p

def content():
    rows = []
    for p in source_files():
        b = p.read_bytes()
        digest = hashlib.sha256(b).hexdigest()[:16]
        lines = b.count(b"\n") + (1 if b and not b.endswith(b"\n") else 0)
        rel = p.relative_to(ROOT).as_posix()
        rows.append(f"| `{rel}` | {lines} | `{digest}` |")
    header = """# McpGo — source code inventory

Этот файл сгенерирован из **исходных файлов**, без локальных данных, compiled app, node_modules, логов, исторических backup и private configuration. SHA-256 здесь усечён до первых 16 hex **только для сравнения версий**, не для release integrity. Для проверяемых релизов нужны полные хэши артефактов и подписанные теги.

Генерация: `python3 tools/generate_source_inventory.py`. Проверка: `python3 tools/generate_source_inventory.py --check`.

| Исходный файл | Строки | SHA-256 prefix |
|---|---:|---|
"""
    return header + "\n".join(rows) + "\n\nВсего файлов в выбранном source-only срезе: **" + str(len(rows)) + "**.\n\nВажно: отсутствие файла в этом инвентаре не доказывает отсутствие выполняемого кода где-либо на диске. Исторические или генерируемые компоненты намеренно исключены; для публичного исходного архива требуется отдельный полный аудит tree.\n"

if __name__ == "__main__":
    expected = content()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != expected:
            print("SOURCE_INVENTORY stale", file=sys.stderr)
            sys.exit(1)
        print("SOURCE_INVENTORY up to date")
    else:
        OUT.write_text(expected, encoding="utf-8")
        print("SOURCE_INVENTORY generated:", len(list(source_files())), "files")
