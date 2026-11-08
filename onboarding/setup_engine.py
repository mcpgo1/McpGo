#!/usr/bin/env python3
"""McpGo onboarding engine. Safe by default: read operations never provision resources.

No admin key is persisted. Changes require explicit action + confirmation.
Local state is source-scoped and owner-only. Remote create is reconciled before retry.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TUNNEL_ID = re.compile(r"^tunnel_[A-Za-z0-9_-]{3,180}$")
SCOPE_ID = re.compile(r"^(?:org|ws|workspace)[-_][A-Za-z0-9_-]{3,180}$")
STAGES = ("preflight", "authorization", "tunnels", "local", "chrome", "chatgpt", "verification")
PLATFORM_URL = "https://platform.openai.com/settings/organization/tunnels"
CHATGPT_URL = "https://chatgpt.com/#settings/Connectors"


class SetupError(Exception):
    pass


def atomic_write(path: Path, data: bytes, mode: int = 0o600):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.is_symlink():
        raise SetupError("Небезопасная директория конфигурации: ссылка.")
    if path.exists() and path.is_symlink():
        raise SetupError("Отказ: целевой файл является символической ссылкой.")
    fd, filename = tempfile.mkstemp(prefix=".mcpgo-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            os.fchmod(f.fileno(), mode)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(filename, path)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


class SetupEngine:
    def __init__(self, root: Path = ROOT, home: Path | None = None,
                 client: str | None = None):
        self.root = root.resolve()
        self.home = home or Path.home()
        self.client = client or shutil.which("tunnel-client") or "/opt/homebrew/bin/tunnel-client"
        self.appdata = self.home / "Library/Application Support/McpGo"
        self.store = self.appdata / "Onboarding/state.json"

    def read_state(self) -> dict[str, Any]:
        if not self.store.exists():
            return {"version": 1, "installationRoot": str(self.root),
                    "phase": "preflight", "tunnels": {}, "pending": None,
                    "chatgpt": {"terminal": False, "browser": False}}
        import stat
        if self.store.is_symlink() or not stat.S_ISREG(self.store.stat().st_mode):
            raise SetupError("Небезопасный файл состояния.")
        if self.store.stat().st_mode & 0o077:
            raise SetupError("Файл состояния должен быть доступен только владельцу (0600).")
        state = json.loads(self.store.read_text("utf-8"))
        if state.get("installationRoot") != str(self.root):
            raise SetupError("Состояние относится к другой установке McpGo. Импорт требует подтверждения.")
        if state.get("version") != 1:
            raise SetupError("Неподдерживаемая версия состояния мастера.")
        return state

    def write_state(self, state: dict[str, Any]):
        state["installationRoot"] = str(self.root)
        atomic_write(self.store, (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode())

    def preflight(self) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []
        import platform
        version = platform.mac_ver()[0]
        supported_os = sys.platform == "darwin" and bool(version) and int(version.split(".")[0]) >= 14
        supported_arch = platform.machine().lower() == "arm64"
        for name, valid, detail in [
            ("macos", supported_os, "macOS 14+"),
            ("architecture", supported_arch, "Apple Silicon arm64"),
            ("platform", sys.platform == "darwin", "macOS 14+ (Windows adapter запланирован)"),
            ("node", bool(shutil.which("node")), "Node.js"),
            ("npm", bool(shutil.which("npm")), "npm для Playwright MCP"),
            ("python", bool(shutil.which("python3")), "Python 3"),
            ("tunnel-client", Path(self.client).is_file() and os.access(self.client, os.X_OK),
             "OpenAI tunnel-client (используйте официальный дистрибутив)"),
            ("bundle", (self.root / "McpGo.app/Contents/Info.plist").is_file() or
             (self.root / "release-manifest.json").is_file(), "McpGo.app"),
            ("source", (self.root / "terminal/stateless_server.js").is_file() and
             (self.root / "playwright/restricted-proxy.mjs").is_file(), "MCP исходники"),
            ("browser-deps", (self.root / "playwright/node_modules/@playwright/mcp/cli.js").exists(),
             "npm ci в playwright"),
        ]:
            checks.append({"name": name, "ok": bool(valid), "detail": detail})
        return {"checks": checks, "ready": all(c["ok"] for c in checks),
                "installReady": all(c["ok"] for c in checks if c["name"] != "browser-deps")}

    def status(self) -> dict[str, Any]:
        state = self.read_state()
        return {"state": state, "preflight": self.preflight(),
                "local": self.local_check(), "platformUrl": PLATFORM_URL,
                "chatgptUrl": CHATGPT_URL}

    def local_check(self) -> dict[str, bool]:
        def port_open(port: int) -> bool:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=.2):
                    return True
            except OSError:
                return False
        return {"terminal": port_open(12848), "browser": port_open(8931),
                "proxy": port_open(8940), "dashboard": port_open(8969)}

    @staticmethod
    def scope_args(data: dict) -> list[str]:
        org, ws = str(data.get("organizationId") or "").strip(), str(data.get("workspaceId") or "").strip()
        if not org and not ws:
            raise SetupError("Укажите организацию OpenAI Platform или workspace ChatGPT.")
        args = []
        if org:
            if not SCOPE_ID.fullmatch(org) or not org.startswith(("org-", "org_")):
                raise SetupError("Неверный Organization ID.")
            args += ["--organization-id", org]
        if ws:
            if not SCOPE_ID.fullmatch(ws) or not ws.startswith(("ws-", "ws_", "workspace-", "workspace_")):
                raise SetupError("Неверный Workspace ID.")
            args += ["--workspace-id", ws]
        return args

    def run_cli(self, args: list[str], *, admin: str | None = None, runtime: str | None = None,
                timeout: int = 20) -> str:
        if not Path(self.client).is_file():
            raise SetupError("Не установлен tunnel-client.")
        env = os.environ.copy()
        env.pop("OPENAI_ADMIN_KEY", None)
        env.pop("CONTROL_PLANE_API_KEY", None)
        if admin:
            env["OPENAI_ADMIN_KEY"] = admin
        if runtime:
            env["CONTROL_PLANE_API_KEY"] = runtime
        try:
            proc = subprocess.run([self.client, *args], capture_output=True, text=True,
                                  env=env, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SetupError("Вызов tunnel-client не завершился; проверьте подключение и права.") from None
        if proc.returncode != 0:
            # Never relay raw stderr: providers may echo credentials.
            raise SetupError(f"tunnel-client завершился с кодом {proc.returncode}; проверьте права Tunnels, scope и сеть.")
        return proc.stdout

    @staticmethod
    def tunnel_rows(output: str) -> list[dict]:
        try:
            parsed = json.loads(output)
        except (ValueError, TypeError):
            raise SetupError("Ответ списка туннелей не является JSON; создание остановлено.") from None
        if isinstance(parsed, list):
            rows = parsed
        elif isinstance(parsed, dict):
            if isinstance(parsed.get("tunnels"), list):
                rows = parsed["tunnels"]
            elif isinstance(parsed.get("data"), list):
                rows = parsed["data"]
            elif isinstance(parsed.get("items"), list):
                rows = parsed["items"]
            else:
                raise SetupError("Неизвестная структура списка туннелей — автоматическое создание остановлено.")
        else:
            raise SetupError("Некорректный ответ о туннелях.")
        return [x for x in rows if isinstance(x, dict)]

    @staticmethod
    def tunnel_id(item: dict) -> str:
        candidate = item.get("tunnel_id") or item.get("tunnelId") or item.get("id") or ""
        return candidate if isinstance(candidate, str) and TUNNEL_ID.fullmatch(candidate) else ""

    def discover(self, data: dict) -> dict:
        admin = str(data.get("adminKey") or "")
        if not admin or len(admin) > 4096:
            raise SetupError("Для discovery требуется административный ключ с Tunnels Read + Manage.")
        args = self.scope_args(data)
        output = self.run_cli(["admin", "tunnels", "list", "--json", *args], admin=admin)
        rows = self.tunnel_rows(output)
        return {"tunnels": [{"name": str(x.get("name") or "")[:120],
                             "id": self.tunnel_id(x)} for x in rows if self.tunnel_id(x)]}

    def runtime_projects(self, data: dict) -> dict:
        """Read-only project selection; does not provision anything."""
        from runtime_provision import RuntimeAutoProvisioner, RuntimeAdminError
        try:
            return RuntimeAutoProvisioner(self).projects(data)
        except RuntimeAdminError as exc:
            raise SetupError(str(exc)) from None

    def runtime_inspect(self, data: dict) -> dict:
        """Read-only check of previously attempted runtime resources."""
        from runtime_provision import RuntimeAutoProvisioner, RuntimeAdminError
        try:
            return RuntimeAutoProvisioner(self).inspect(data)
        except RuntimeAdminError as exc:
            raise SetupError(str(exc)) from None

    def runtime_recover_key(self, data: dict) -> dict:
        """Explicit one-time recovery from an uncertain Service Account key POST."""
        from runtime_provision import RuntimeAutoProvisioner, RuntimeAdminError
        self.ensure_installation_ownership()
        try:
            return RuntimeAutoProvisioner(self).recover_key(data)
        except RuntimeAdminError as exc:
            raise SetupError(str(exc)) from None

    def runtime_auto(self, data: dict) -> dict:
        """Explicit opt-in. One-time secret is returned only to local SwiftUI."""
        from runtime_provision import RuntimeAutoProvisioner, RuntimeAdminError
        self.ensure_installation_ownership()
        try:
            return RuntimeAutoProvisioner(self).provision(data)
        except RuntimeAdminError as exc:
            raise SetupError(str(exc)) from None

    def import_tunnels(self, data: dict) -> dict:
        if data.get("confirmed") is not True:
            raise SetupError("Подтвердите импорт Tunnel ID.")
        ids = {k: str(data.get(k + "Id") or "").strip() for k in ("terminal", "browser")}
        if any(not TUNNEL_ID.fullmatch(v) for v in ids.values()) or ids["terminal"] == ids["browser"]:
            raise SetupError("Нужны два разных действительных Tunnel ID.")
        state = self.read_state()
        state["tunnels"] = {k: {"id": v, "origin": "imported", "remoteVerified": False}
                            for k, v in ids.items()}
        state["phase"] = "tunnels"
        state["pending"] = None
        self.write_state(state)
        return {"tunnels": ids, "verification": "pending (проверить в OpenAI Platform)"}
    def provision(self, data: dict) -> dict:
        if data.get("confirmed") is not True:
            raise SetupError("Создание туннелей требует явного подтверждения.")
        admin = str(data.get("adminKey") or "")
        if len(admin) < 8 or len(admin) > 4096 or "\n" in admin or "\r" in admin:
            raise SetupError("Укажите действительный admin key локально в мастере.")
        scope = self.scope_args(data)
        state = self.read_state()
        if not state.get("installationId"):
            state["installationId"] = secrets.token_hex(8)
            self.write_state(state)
        if state.get("pending") and state["pending"].get("status") == "unknown":
            # A timed-out create may have succeeded. Always reconcile with list.
            pass
        created = {}
        for service in ("terminal", "browser"):
            record = state.setdefault("tunnels", {}).get(service, {})
            if TUNNEL_ID.fullmatch(record.get("id", "")):
                created[service] = record["id"]
                continue
            name = "McpGo " + service.capitalize() + " " + state["installationId"]
            previous = state.get("pending")
            uncertain = bool(previous and previous.get("service") == service
                             and previous.get("status") in ("creating", "unknown"))
            state["pending"] = {"service": service, "name": name,
                                "scope": scope,
                                "status": "unknown" if uncertain else "reconciling"}
            self.write_state(state)
            rows = self.tunnel_rows(self.run_cli(
                ["admin", "tunnels", "list", "--json", *scope], admin=admin))
            matches = [x for x in rows if x.get("name") == name and self.tunnel_id(x)]
            if len(matches) > 1:
                state["pending"]["status"] = "unknown"
                self.write_state(state)
                raise SetupError("Найдено несколько одноимённых туннелей. Требуется ручная проверка.")
            if matches:
                tid = self.tunnel_id(matches[0])
                origin = "reconciled"
            else:
                if uncertain:
                    state["pending"]["status"] = "unknown"
                    self.write_state(state)
                    raise SetupError("Результат предыдущего создания остаётся неизвестным. "
                                     "Проверьте туннели в Platform вручную; повтор запрещён.")
                # Atomic local write BEFORE the non-idempotent remote call.
                state["pending"]["status"] = "creating"
                self.write_state(state)
                try:
                    result = self.run_cli(
                        ["admin", "tunnels", "create", "--json",
                         "--name", name,
                         "--description", "Private " + service + " MCP endpoint for McpGo "
                                         + state["installationId"], *scope],
                        admin=admin, timeout=35)
                    value = json.loads(result)
                    if isinstance(value, dict) and isinstance(value.get("tunnel"), dict):
                        value = value["tunnel"]
                    if not isinstance(value, dict):
                        raise ValueError("Unexpected response")
                    tid = self.tunnel_id(value)
                    if not tid:
                        raise ValueError("Tunnel ID not present")
                except (SetupError, ValueError):
                    state["pending"]["status"] = "unknown"
                    self.write_state(state)
                    raise SetupError("Результат создания туннеля неизвестен. "
                                     "Проверьте Platform, затем выполните discovery; "
                                     "автоматический повтор отключён.") from None
                origin = "created"
            state["tunnels"][service] = {"id": tid, "origin": origin,
                                         "remoteVerified": True, "name": name}
            state["pending"] = None
            state["phase"] = "tunnels"
            self.write_state(state)
            created[service] = tid
        return {"tunnels": created, "remoteVerified": all(
            state.get("tunnels", {}).get(name, {}).get("remoteVerified", False)
            for name in ("terminal", "browser"))}

    def ensure_installation_ownership(self):
        # Never overwrite Keychain-backed identities or profile files belonging
        # to another active McpGo installation on the same macOS user account.
        script = self.root / "scripts/setup_macos.py"
        if not script.is_file():
            raise SetupError("Не найден установщик служб McpGo.")
        result = subprocess.run([sys.executable, str(script), "--check"],
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise SetupError("Конфликт: другая локальная установка или занят порт. "
                             "Сначала выполните контролируемую миграцию.")

    def install_dependencies(self, data: dict) -> dict:
        if data.get("confirmed") is not True:
            raise SetupError("Для загрузки зависимостей нужно подтверждение.")
        self.ensure_installation_ownership()
        folder = self.root / "playwright"
        if not (folder / "package-lock.json").is_file():
            raise SetupError("Нет Playwright package-lock.json.")
        npm = shutil.which("npm")
        if not npm:
            raise SetupError("Сначала установите Node.js/npm.")
        try:
            result = subprocess.run([npm, "ci"], cwd=folder, capture_output=True,
                                    text=True, timeout=240)
        except (OSError, subprocess.TimeoutExpired):
            raise SetupError("npm ci не завершился. Повторите после проверки подключения.") from None
        if result.returncode or not (folder / "node_modules/@playwright/mcp/cli.js").is_file():
            raise SetupError("Не удалось установить зависимости по package-lock.")
        return {"installed": True}

    def configure(self, data: dict) -> dict:
        if data.get("confirmed") is not True:
            raise SetupError("Подтвердите настройку локальных профилей.")
        self.ensure_installation_ownership()
        state = self.read_state()
        records = state.get("tunnels", {})
        ids = [records.get(name, {}).get("id", "") for name in ("terminal", "browser")]
        if not all(TUNNEL_ID.fullmatch(x) for x in ids) or ids[0] == ids[1]:
            raise SetupError("Сначала импортируйте или создайте два разных Tunnel ID.")
        # This route is generated by the local stateless MCP server and must be
        # kept stable across restarts. It is not an OpenAI tunnel credential.
        conf = self.appdata / "terminal/stateless-config.json"
        if conf.exists():
            if conf.is_symlink():
                raise SetupError("Небезопасный stateless-config.json.")
            contents = json.loads(conf.read_text())
            route = contents.get("mcpPath", "")
            if not re.fullmatch(r"exec/[a-f0-9]{64}", route):
                raise SetupError("Неподдерживаемый private MCP route.")
        else:
            route = "exec/" + secrets.token_hex(32)
        targets = {
            "terminal": ("chat-terminal-hub", ids[0], "http://127.0.0.1:12848/" + route),
            "browser": ("mcpgo-browser", ids[1], "http://127.0.0.1:8940/mcp"),
        }
        browser_file = self.appdata / "playwright/tunnel.id"
        if browser_file.exists():
            if browser_file.is_symlink() or browser_file.read_text().strip() != ids[1]:
                raise SetupError("Обнаружен иной Browser Tunnel ID. Миграция требует ручного подтверждения.")
        profiles = self.home / ".config/tunnel-client"
        profiles.mkdir(parents=True, exist_ok=True, mode=0o700)
        if profiles.is_symlink():
            raise SetupError("Каталог профилей tunnel-client не должен быть ссылкой.")
        outputs = {}
        for name, (profile, tid, endpoint) in targets.items():
            dest = profiles / (profile + ".yaml")
            if dest.exists():
                if dest.is_symlink():
                    raise SetupError("Небезопасный профиль туннеля.")
                existing = dest.read_text("utf-8")
                if tid not in existing or endpoint not in existing:
                    raise SetupError("Существующий профиль " + profile +
                                     " отличается. Не перезаписываем чужую настройку.")
                outputs[name] = str(dest)
                continue
            with tempfile.TemporaryDirectory(prefix="mcpgo-profile-") as temp:
                self.run_cli(["init", "--profile", profile, "--profile-dir", temp,
                              "--tunnel-id", tid, "--mcp-server-url", endpoint,
                              "--control-plane-api-key-ref", "env:CONTROL_PLANE_API_KEY",
                              "--health-listen-addr", "127.0.0.1:0"])
                built = Path(temp) / (profile + ".yaml")
                if not built.is_file():
                    raise SetupError("tunnel-client init не создал ожидаемый профиль.")
                payload = built.read_text("utf-8")
                if tid not in payload or endpoint not in payload:
                    raise SetupError("Неподходящий конфигурационный профиль от tunnel-client.")
                atomic_write(dest, payload.encode(), mode=0o600)
                outputs[name] = str(dest)
        if not conf.exists():
            atomic_write(conf, (json.dumps({"mcpPath": route}) + "\n").encode())
        browser_file = self.appdata / "playwright/tunnel.id"
        if browser_file.exists() and browser_file.read_text().strip() != ids[1]:
            raise SetupError("Уже есть другой Browser Tunnel ID — обновление требует ручной миграции.")
        atomic_write(browser_file, (ids[1] + "\n").encode())
        state["phase"] = "local"
        state["localConfigured"] = True
        state["chatgpt"] = {"terminal": False, "browser": False}
        self.write_state(state)
        return {"profiles": outputs, "runtimeKey": "store in macOS Keychain",
                "terminalMcpRoute": "private (kept locally)"}

    def install_services(self, data: dict) -> dict:
        if data.get("confirmed") is not True:
            raise SetupError("Для установки служб требуется явное подтверждение.")
        if not self.read_state().get("localConfigured"):
            raise SetupError("Сначала завершите настройку MCP-профилей.")
        if not self.preflight()["ready"]:
            raise SetupError("Не все компоненты готовы: завершите preflight и npm ci.")
        # setup_macos owns all collision and ownership checks; no forced takeover.
        script = self.root / "scripts/setup_macos.py"
        for mode in ("--check", "--install"):
            try:
                result = subprocess.run([sys.executable, str(script), mode],
                                        capture_output=True, text=True, timeout=35)
            except (OSError, subprocess.TimeoutExpired):
                raise SetupError("Установка служб не завершилась, проверьте launchd.") from None
            if result.returncode:
                raise SetupError("Установка заблокирована: обнаружена другая установка или конфликт портов.")
        state = self.read_state()
        state["phase"] = "chrome"
        state["localServicesInstalled"] = True
        self.write_state(state)
        return {"installed": True, "note": "Запуск внешних туннелей требует runtime key в Keychain."}

    def status_without_secrets(self) -> dict:
        state = self.read_state()
        return {
            "version": state["version"], "phase": state["phase"],
            "tunnels": {name: {"id": rec.get("id", ""), "origin": rec.get("origin", ""),
                               "remoteVerified": bool(rec.get("remoteVerified"))}
                        for name, rec in state.get("tunnels", {}).items()},
            "pending": state.get("pending"),
            "runtimeProvision": {
                # Safe wizard progress metadata only; no IDs, API key values,
                # group membership or external resource names.
                "projectSelected": bool((state.get("runtimeProvision") or {}).get("projectId")),
                "pending": str((state.get("runtimeProvision") or {}).get("pending") or "")[:64],
                "status": str((state.get("runtimeProvision") or {}).get("status") or "")[:64],
                "keyRecoveryAttempted": bool((state.get("runtimeProvision") or {}).get("keyRecoveryAttempted")),
            },
            "localConfigured": state.get("localConfigured", False),
            "localServicesInstalled": state.get("localServicesInstalled", False),
            "chatgpt": state.get("chatgpt", {}),
            "preflight": self.preflight(), "local": self.local_check(),
            "platformUrl": PLATFORM_URL, "chatgptUrl": CHATGPT_URL,
            "chatgptVerification": "Requires actual MCP tool call in ChatGPT, not a checkbox",
        }

    def note_chatgpt(self, data: dict) -> dict:
        # Record user guidance progress, NOT a false end-to-end verification.
        if data.get("confirmed") is not True:
            raise SetupError("Подтвердите, что посмотрели инструкцию подключения.")
        state = self.read_state()
        state["chatgptInstructionsViewed"] = True
        state["phase"] = "verification"
        self.write_state(state)
        return {"next": "Perform a safe tool call from ChatGPT and verify it externally.",
                "chatgptVerified": False}
    def verify_remote(self, data: dict) -> dict:
        runtime = str(data.get("runtimeKey") or "")
        admin = str(data.get("adminKey") or "")
        if not runtime and not admin:
            raise SetupError("Для проверки существующих Tunnel ID требуется runtime или admin key.")
        state = self.read_state()
        verified = {}
        for service, item in state.get("tunnels", {}).items():
            tid = item.get("id", "")
            if not TUNNEL_ID.fullmatch(tid):
                raise SetupError("Недействительный Tunnel ID.")
            raw = self.run_cli(["admin", "tunnels", "get", tid, "--json"],
                               runtime=runtime or None, admin=admin or None)
            try:
                obj = json.loads(raw)
                if isinstance(obj.get("tunnel"), dict):
                    obj = obj["tunnel"]
                if self.tunnel_id(obj) != tid:
                    raise ValueError("ID mismatch")
            except (ValueError, AttributeError, TypeError):
                raise SetupError("Не удалось подтвердить Tunnel ID по ответу OpenAI.") from None
            item["remoteVerified"] = True
            verified[service] = True
        self.write_state(state)
        return {"verified": verified}

    def start_local(self, data: dict) -> dict:
        """Only explicitly start managed services, never stop/restart existing user tasks."""
        import urllib.request
        import urllib.error
        group = data.get("group")
        if data.get("confirmed") is not True or group not in ("terminal", "playwright"):
            raise SetupError("Выберите Terminal или Playwright и подтвердите запуск.")
        self.ensure_installation_ownership()
        if not self.read_state().get("localServicesInstalled"):
            raise SetupError("Сначала установите локальные службы.")
        base = "http://127.0.0.1:8969"
        try:
            with urllib.request.urlopen(base + "/api/status", timeout=4) as res:
                status = json.loads(res.read(32768))
            if Path(status.get("installationRoot", "")).resolve() != self.root:
                raise SetupError("Dashboard принадлежит другой установке McpGo.")
            req = urllib.request.Request(
                base + "/api/action",
                data=json.dumps({"group": group, "action": "start"}).encode(),
                method="POST",
                headers={"Origin": base, "X-MCP-Hub": "dashboard",
                         "Content-Type": "application/json"})
            # Browser startup can include CDP consent and MCP health checks.
            # Do not report a client-side timeout as if services definitely failed.
            with urllib.request.urlopen(req, timeout=180) as res:
                outcome = json.loads(res.read(32768))
            if not outcome.get("ok"):
                raise SetupError("Службы не прошли проверку готовности; проверь Dashboard.")
            return {"started": group, "ready": True}
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                raise SetupError("Dashboard уже запускает или проверяет службы. " +
                                 "Не отправляй повторную команду; проверь состояние позже.") from None
            # Messages originate only from this local Dashboard. Never pass
            # arbitrary response data or credential-looking strings to SwiftUI.
            try:
                payload = json.loads(exc.read(4096))
                message = str(payload.get("error") or "")
            except (ValueError, TypeError, UnicodeError):
                message = ""
            safe_reasons = (
                "Playwright не открыл порт 8931",
                "MCP proxy не открыл порт 8940",
                "Браузер открыл порт, но MCP не готов",
                "Туннель не запустился",
                "Playwright не прошёл проверку готовности",
                "Playwright CDP не видит вкладки Chrome",
                "Не все службы запустились",
                "Служба завершилась сразу после запуска",
                "Не найден run-tunnel.sh",
            )
            if any(message.startswith(prefix) for prefix in safe_reasons):
                raise SetupError("Dashboard: " + message[:220]) from None
            raise SetupError("Dashboard отказал в запуске (HTTP " + str(exc.code) +
                             "). Открой Dashboard для диагностики.") from None
        except SetupError:
            raise
        except (OSError, ValueError, TimeoutError):
            raise SetupError("Dashboard не подтвердил запуск. Он может ещё выполнять " +
                             "проверки — нажми «Проверить локальные MCP», " +
                             "не перезапускай службы вслепую.") from None

    def doctor(self, data: dict) -> dict:
        """Read-only tunnel-client diagnostics; never returns key or raw CLI output."""
        state = self.read_state()
        if not state.get("localConfigured"):
            raise SetupError("Сначала создайте локальные профили.")
        import getpass
        username = getpass.getuser()
        results = {}
        services = {
            "terminal": ("chat-terminal-hub", "com.chat-terminal-hub.openai.tunnel"),
            "browser": ("mcpgo-browser", "com.mcphub.playwright.openai.tunnel"),
        }
        for name, (profile, secret_service) in services.items():
            try:
                password = subprocess.run(
                    ["/usr/bin/security", "find-generic-password",
                     "-a", username, "-s", secret_service, "-w"],
                    capture_output=True, text=True, timeout=5)
                if password.returncode:
                    results[name] = {"ready": False, "reason": "runtime key not in Keychain"}
                    continue
                self.run_cli(["doctor", "--profile", profile, "--explain", "--json"],
                             runtime=password.stdout.strip(),
                             timeout=25)
                results[name] = {"ready": True}
            except SetupError:
                results[name] = {"ready": False, "reason": "doctor failed; inspect profile, workspace and local MCP"}
            except (OSError, subprocess.TimeoutExpired):
                results[name] = {"ready": False, "reason": "Keychain unavailable"}
        return {"checks": results, "note": "doctor validates transport locally, not ChatGPT plugin"}

    def verify_local(self) -> dict:
        # Verification is read-only. Reachability != remote ChatGPT bookability.
        import urllib.request
        import urllib.error
        state = self.read_state()
        status: dict[str, Any] = {"terminal": False, "browser": False,
                                  "browserMcp": False, "chrome": False,
                                  "chatgptVerified": False}
        # Refuse to attribute another installed McpGo's listener to this copy.
        # Dashboard can briefly block its event loop while querying launchctl
        # and Keychain. A 2-second HTTP timeout produced false negatives even
        # though the actual terminal MCP server was responsive.
        req = urllib.request.Request("http://127.0.0.1:8969/api/status",
                                     headers={"Accept": "application/json"})
        hub = None
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=6) as response:
                    hub = json.loads(response.read(16384))
                break
            except (OSError, ValueError, KeyError):
                if attempt == 0:
                    time.sleep(0.25)
        if not isinstance(hub, dict):
            status["blocker"] = ("Dashboard временно не ответил. Это не доказывает " +
                                 "остановку MCP; повтори проверку.")
            return status
        if Path(hub.get("installationRoot", "")).resolve() != self.root:
            status["blocker"] = "Службы принадлежат другой установке McpGo."
            return status
        config = self.appdata / "terminal/stateless-config.json"
        if config.is_file():
            try:
                mcp = json.loads(config.read_text("utf-8")).get("mcpPath", "")
                status["terminal"] = self.probe_tools(
                    "http://127.0.0.1:12848/" + mcp, {"terminal_exec"})
            except (OSError, ValueError, KeyError):
                pass
        browser_detail: dict[str, Any] = {}
        status["browser"] = self.probe_tools(
            "http://127.0.0.1:8940/mcp", {"browser_tabs"}, verify_browser=True,
            details=browser_detail)
        # MCP initialization/tools-list is different from Chrome CDP tab
        # enumeration. A frozen/discarded Chrome tab may delay CDP long after
        # MCP itself has successfully initialized. Don't hide that distinction.
        status["browserMcp"] = bool(browser_detail.get("mcpReady"))
        status["chrome"] = bool(status["browser"])
        if status["browserMcp"] and not status["browser"]:
            status["browserDetail"] = (
                "Playwright MCP работает, но запрос вкладок Chrome не завершился. "
                "Проверь разрешение Remote Debugging в Chrome; если в браузере "
                "много спящих вкладок, попробуй открыть одну из них и проверить снова."
            )
        elif not status["browserMcp"]:
            status["browserDetail"] = (
                "Playwright MCP пока не подтвердил initialize/tools-list. "
                "Проверь запуск службы Browser и proxy."
            )
        return status

    @staticmethod
    def probe_tools(url: str, mandatory: set[str], verify_browser: bool = False,
                    details: dict | None = None) -> bool:
        import urllib.request
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.hostname != "127.0.0.1" or parsed.scheme != "http":
            return False
        session = ""
        def send(method: str, params: dict | None = None, request_id: int | None = 1):
            nonlocal session
            packet: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
            if request_id is not None:
                packet["id"] = request_id
            if params is not None:
                packet["params"] = params
            headers = {"Content-Type": "application/json",
                       "Accept": "application/json, text/event-stream",
                       "MCP-Protocol-Version": "2025-03-26"}
            if session:
                headers["mcp-session-id"] = session
            data = json.dumps(packet).encode()
            req = urllib.request.Request(url, data=data, method="POST", headers=headers)
            # Chrome can take several seconds to enumerate tabs in an
            # already-running personal profile. A fixed four-second timeout
            # caused false "Browser: not confirmed" statuses on healthy CDP.
            timeout_seconds = 15 if verify_browser and method == "tools/call" else (6 if verify_browser else 4)
            with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                session = resp.headers.get("Mcp-Session-Id", session)
                contents = resp.read(1048576).decode("utf-8", errors="replace")
                if request_id is None:
                    return {}
                if contents.startswith("{"):
                    return json.loads(contents)
                for line in contents.splitlines():
                    if line.startswith("data: "):
                        return json.loads(line[6:])
                raise ValueError("MCP response absent")
        try:
            init = send("initialize", {"protocolVersion": "2025-03-26",
                       "capabilities": {}, "clientInfo": {"name": "McpGo-Setup", "version": "1"}})
            if "result" not in init:
                return False
            send("notifications/initialized", request_id=None)
            names = {t.get("name") for t in send("tools/list", request_id=2)
                     .get("result", {}).get("tools", [])}
            if not mandatory.issubset(names) or "browser_run_code_unsafe" in names:
                return False
            if details is not None:
                details["mcpReady"] = True
            if verify_browser:
                result = send("tools/call", {
                    "name": "browser_tabs", "arguments": {"action": "list"}}, request_id=3)
                if result.get("error") or result.get("result", {}).get("isError"):
                    return False
                content = " ".join(str(x.get("text", "")) for x in
                                   result.get("result", {}).get("content", [])
                                   if isinstance(x, dict))
                if "### Result" not in content:
                    return False
            return True
        except (OSError, TimeoutError, ValueError, KeyError):
            return False

    def dismiss(self, data: dict) -> dict:
        if data.get("confirmed") is not True:
            raise SetupError("Для выхода из мастера необходимо подтверждение.")
        state = self.read_state()
        state["wizardDismissed"] = True
        self.write_state(state)
        return {"dismissed": True, "chatgptVerified": False}
