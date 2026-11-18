"""Crash-resilient, local-only, secret-scrubbed first-run diagnostics.

JSON Lines in Onboarding/Logs/onboarding.log. No telemetry uploads.
Both macOS and Windows Python/Electron/Swift append to the same stream.
"""
from __future__ import annotations
import contextlib
from datetime import datetime, timezone
import functools
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
import zipfile

MAX_LOG = 8 * 1024 * 1024
KEEP_ARCHIVES = 12
SENSITIVE = re.compile(
    r"(?:secret|token|password|passwd|credential|api.?key|private.?key|"
    r"authorization|cookie|session.?key|access.?key|refresh.?key|admin.?key|runtime.?key)",
    re.I,
)
PATTERNS = [
    re.compile(r"(?i)\b(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,})\b"),
    re.compile(r"(?i)(bearer\s+)\S+"),
    re.compile(r'(?i)((?:password|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*["\']?)[^\s,;"\']+'),
    re.compile(r'(?i)("(?:[^"]*(?:password|token|secret|api.?key|authorization|cookie)[^"]*)"\s*:\s*")[^"]*'),
    re.compile(r"(?i)([?&](?:token|key|secret|password|code)=)[^&#\s]+"),
]
_SECRET_VALUES: set[str] = set()


def base_dir() -> Path:
    configured = os.environ.get("MCPGO_USER_DATA", "")
    if configured and Path(configured).is_absolute():
        return Path(configured)
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "McpGo"
    return Path.home() / "Library" / "Application Support" / "McpGo"


def log_dir() -> Path:
    return base_dir() / "Onboarding" / "Logs"


def register_secrets(value, key: str = ""):
    if isinstance(value, dict):
        for field, child in value.items():
            register_secrets(child, str(field))
    elif isinstance(value, (list, tuple)):
        for child in value:
            register_secrets(child, key)
    elif SENSITIVE.search(key) and isinstance(value, str) and len(value) >= 5:
        _SECRET_VALUES.add(value)


def scrub_text(value: str) -> str:
    limit = 512 * 1024
    value = value[:limit] + ("...[TRUNCATED]" if len(value) > limit else "")
    for secret in sorted(_SECRET_VALUES, key=len, reverse=True):
        value = value.replace(secret, "[REDACTED]")
    for pattern in PATTERNS:
        value = pattern.sub(lambda m: (m.group(1) if m.lastindex else "") + "[REDACTED]", value)
    # Control characters are handled by the JSON serializer.
    return value


def safe(value, key: str = "", depth: int = 0):
    if SENSITIVE.search(key):
        return "[REDACTED]"
    if depth > 10:
        return "[MAX_DEPTH]"
    if isinstance(value, dict):
        return {scrub_text(str(k))[:200]: safe(v, str(k), depth + 1)
                for k, v in list(value.items())[:150]}
    if isinstance(value, (list, tuple)):
        return [safe(v, key, depth + 1) for v in value[:150]]
    if isinstance(value, str):
        return scrub_text(value)
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, bytes):
        return scrub_text(value.decode("utf-8", errors="replace"))
    return scrub_text(repr(value))


@contextlib.contextmanager
def _lock(directory: Path):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise OSError("Diagnostic directory cannot be a symlink")
    lockfile = directory / ".lock"
    if lockfile.is_symlink():
        raise OSError("Diagnostic lock cannot be a symlink")
    with lockfile.open("a+b") as fh:
        if os.name == "nt":
            import msvcrt
            if fh.seek(0, 2) == 0:
                fh.write(b"0")
                fh.flush()
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _attempt(directory: Path) -> str:
    file = directory / "attempt.id"
    if file.is_symlink():
        raise OSError("Diagnostic attempt cannot be a symlink")
    if file.is_file():
        value = file.read_text("ascii").strip()
        if re.fullmatch(r"[a-f0-9]{32}", value):
            return value
    attempt_id = uuid.uuid4().hex
    with file.open("w", encoding="ascii") as fh:
        fh.write(attempt_id)
        fh.flush()
        os.fsync(fh.fileno())
    return attempt_id


def _rotate(directory: Path):
    source = directory / "onboarding.log"
    if source.is_symlink():
        raise OSError("Diagnostic log cannot be a symlink")
    if source.exists() and source.stat().st_size >= MAX_LOG:
        archive = directory / "archive"
        archive.mkdir(mode=0o700, exist_ok=True)
        filename = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:8] + ".log"
        os.replace(source, archive / filename)
        history = sorted(archive.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in history[KEEP_ARCHIVES:]:
            if old.is_file() and not old.is_symlink():
                old.unlink()


def event(name: str, **details):
    """Never propagate logger failures into provisioning or run user secrets to disk."""
    try:
        directory = log_dir()
        with _lock(directory):
            _rotate(directory)
            entry = {
                "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "attempt": _attempt(directory),
                "pid": os.getpid(),
                "platform": sys.platform,
                "event": scrub_text(str(name))[:160],
                "details": safe(details),
            }
            blob = (json.dumps(entry, ensure_ascii=False, default=str, separators=(",", ":")) + "\n").encode("utf-8")
            target = directory / "onboarding.log"
            flags = os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(target, flags, 0o600)
            try:
                os.write(fd, blob)
                os.fsync(fd)
            finally:
                os.close(fd)
    except Exception:
        # Setup must remain functional when disk is full or diagnostics are blocked.
        pass


def environment_snapshot():
    event("environment.snapshot", os=platform.platform(), architecture=platform.machine(),
          python=sys.version.split()[0], executable=sys.executable,
          root=str(Path(__file__).resolve().parents[1]), userData=str(base_dir()),
          cwd=os.getcwd())


def log_exception(label: str, exc: BaseException):
    event(label, errorType=type(exc).__name__, error=str(exc),
          stack="".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))


def run_logged(*args, **kwargs):
    # E.g. macOS "security find-generic-password -w" emits a plaintext secret
    # which is unknown until the subprocess returns. Never persist those bytes.
    secret_output = bool(kwargs.pop("diagnostic_secret_output", False))
    cmd = args[0] if args else kwargs.get("args", [])
    visible_cmd = {"executable": Path(str(cmd[0])).name, "argumentCount": len(cmd) - 1} if (
        secret_output and isinstance(cmd, (list, tuple)) and cmd) else (
        "[SENSITIVE_COMMAND]" if secret_output else cmd)
    started = time.monotonic()
    event("subprocess.start", command=visible_cmd, cwd=kwargs.get("cwd"), timeout=kwargs.get("timeout"),
          stdinMode="provided" if kwargs.get("input") is not None else "inherited",
          sensitiveOutput=secret_output)
    try:
        result = subprocess.run(*args, **kwargs)
        event("subprocess.complete", command=visible_cmd, elapsedMs=round((time.monotonic() - started) * 1000, 1),
              exitCode=getattr(result, "returncode", None),
              stdout="[SENSITIVE_OUTPUT]" if secret_output else getattr(result, "stdout", None),
              stderr="[SENSITIVE_OUTPUT]" if secret_output else getattr(result, "stderr", None))
        return result
    except Exception as exc:
        event("subprocess.failure.details",
              stdout="[SENSITIVE_OUTPUT]" if secret_output else getattr(exc, "stdout", None),
              stderr="[SENSITIVE_OUTPUT]" if secret_output else getattr(exc, "stderr", None),
              output="[SENSITIVE_OUTPUT]" if secret_output else getattr(exc, "output", None))
        if secret_output:
            event("subprocess.failure", errorType=type(exc).__name__,
                  elapsedMs=round((time.monotonic() - started) * 1000, 1))
        else:
            log_exception("subprocess.failure", exc)
        raise


def urlopen_logged(request, *args, **kwargs):
    import urllib.request
    started = time.monotonic()
    url = request.full_url if hasattr(request, "full_url") else str(request)
    method = request.get_method() if hasattr(request, "get_method") else "GET"
    event("http.request", method=method, url=url, timeout=kwargs.get("timeout"))
    try:
        response = urllib.request.urlopen(request, *args, **kwargs)
        headers = getattr(response, "headers", {})
        selected = {key: headers.get(key) for key in
                    ("Content-Type", "X-Request-ID", "Retry-After", "Date")
                    if headers.get(key)}
        event("http.response", method=method, url=url,
              status=getattr(response, "status", None), headers=selected,
              durationMs=round((time.monotonic() - started) * 1000, 1))
        return response
    except Exception as exc:
        event("http.failure", method=method, url=url, code=getattr(exc, "code", None),
              errorType=type(exc).__name__, error=str(exc),
              durationMs=round((time.monotonic() - started) * 1000, 1))
        raise


def instrument_public_methods(cls):
    for name, method in list(vars(cls).items()):
        if name.startswith("_") or not callable(method) or isinstance(method, (staticmethod, classmethod)):
            continue
        @functools.wraps(method)
        def traced(self, *args, __method=method, __name=name, **kwargs):
            started = time.monotonic()
            event("engine.step.start", step=cls.__name__ + "." + __name,
                  argumentsCount=len(args), keywordNames=list(kwargs))
            try:
                result = __method(self, *args, **kwargs)
                event("engine.step.finish", step=cls.__name__ + "." + __name,
                      durationMs=round((time.monotonic() - started) * 1000, 1), result=result)
                return result
            except Exception as exc:
                log_exception("engine.step.failure:" + cls.__name__ + "." + __name, exc)
                raise
        setattr(cls, name, traced)
    return cls


def export_zip(destination: str) -> dict:
    target = Path(destination).expanduser().absolute()
    if not target.name.lower().endswith(".zip") or not target.parent.is_dir() or target.is_symlink():
        raise ValueError("Choose an existing directory and a .zip diagnostic filename")
    directory = log_dir()
    event("diagnostics.export.requested", targetName=target.name)
    files = [directory / "onboarding.log"]
    archive = directory / "archive"
    if archive.is_dir():
        files.extend(sorted(archive.glob("*.log")))
    files = [p for p in files if p.is_file() and not p.is_symlink()]
    if not files:
        raise ValueError("No diagnostics available")
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w+b", prefix=".mcpgo-diagnostics-",
                                         suffix=".zip", dir=target.parent, delete=False) as out:
            temp_path = Path(out.name)
            try:
                os.chmod(temp_path, 0o600)
            except OSError:
                pass
            with zipfile.ZipFile(out, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                for entry in files:
                    zf.write(entry, "logs/" + ("archive/" + entry.name if entry.parent == archive else entry.name))
                zf.writestr("manifest.json", json.dumps({
                    "format": "mcpgo-onboarding-diagnostics-v1",
                    "exportedAt": datetime.now(timezone.utc).isoformat(),
                    "platform": platform.system(),
                    "logFiles": len(files),
                    "redaction": "best-effort; inspect before sharing",
                }, ensure_ascii=False, indent=2))
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp_path, target)
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()
    event("diagnostics.export.complete", fileCount=len(files), destinationName=target.name)
    return {"fileName": target.name, "files": len(files)}
