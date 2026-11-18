#!/usr/bin/env python3
"""Onboarding CLI bridge for SwiftUI. Request data on stdin, never in process args."""
from __future__ import annotations
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from setup_engine import SetupEngine, SetupError
from diagnostics import event, register_secrets, log_exception, environment_snapshot, export_zip

ACTIONS = {
    'status': lambda e,d: e.status_without_secrets(),
    'preflight': lambda e,d: e.preflight(),
    'discover': lambda e,d: e.discover(d),
    'provision': lambda e,d: e.provision(d),
    'import': lambda e,d: e.import_tunnels(d),
    'runtime-projects': lambda e,d: e.runtime_projects(d),
    'runtime-inspect': lambda e,d: e.runtime_inspect(d),
    'runtime-recover-key': lambda e,d: e.runtime_recover_key(d),
    'runtime-auto': lambda e,d: e.runtime_auto(d),
    'verify-remote': lambda e,d: e.verify_remote(d),
    'configure': lambda e,d: e.configure(d),
    'activate-browser-extension': lambda e,d: e.activate_browser_extension(d),
    'check-ownership': lambda e,d: (e.ensure_installation_ownership() or {"allowed": True}),
    'install-deps': lambda e,d: e.install_dependencies(d),
    'install': lambda e,d: e.install_services(d),
    'verify-local': lambda e,d: e.verify_local(),
    'doctor': lambda e,d: e.doctor(d),
    'start-local': lambda e,d: e.start_local(d),
    'chatgpt-instructions': lambda e,d: e.note_chatgpt(d),
    'dismiss': lambda e,d: e.dismiss(d),
    'export-diagnostics': lambda e,d: export_zip(d.get('destination', '')),
}

def main() -> int:
    environment_snapshot()
    action = sys.argv[1] if len(sys.argv) > 1 else '<missing>'
    event('cli.invoked', action=action, argc=len(sys.argv))
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ACTIONS:
            raise SetupError('Неизвестное действие мастера.')
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise SetupError('Слишком большой запрос настройки.')
        payload = json.loads(raw) if raw else {}
        if not isinstance(payload, dict):
            raise SetupError('Ожидается JSON-объект.')
        register_secrets(payload)
        event('cli.request', action=action, payload=payload, bytes=len(raw))
        result = ACTIONS[sys.argv[1]](SetupEngine(), payload)
        event('cli.success', action=action, result=result)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
        return 0
    except (SetupError, ValueError, OSError) as exc:
        log_exception('cli.failure:' + action, exc)
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 2
    except Exception as exc:
        log_exception('cli.unexpected:' + action, exc)
        print(json.dumps({'ok': False, 'error': 'Внутренняя ошибка мастера (подробности в диагностике).'}, ensure_ascii=False))
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
