#!/usr/bin/python3
"""One persistent real macOS PTY per terminal session. IPC: newline-delimited JSON."""
import os
import sys
import json
import base64
import errno
import pty
import select
import signal
import fcntl
import termios
import struct
import time

def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()

pid, master = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["HISTFILE"] = "/dev/null"
    os.execv("/bin/zsh", ["zsh", "-i"])

input_bytes = b""
alive = True
exit_code = None
emit({"event": "ready", "pid": pid})
while alive:
    try:
        readable, _, _ = select.select([0, master], [], [], 0.25)
    except InterruptedError:
        continue
    if master in readable:
        try:
            chunk = os.read(master, 8192)
        except OSError as exc:
            if exc.errno == errno.EIO:
                chunk = b""
            else:
                raise
        if chunk:
            emit({"event": "data", "base64": base64.b64encode(chunk).decode("ascii")})
        else:
            alive = False
    if 0 in readable:
        chunk = os.read(0, 65536)
        if not chunk:
            # The controlling server disappeared: close the shell, too.
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            break
        input_bytes += chunk
        if len(input_bytes) > 131072:
            break
        while b"\n" in input_bytes:
            raw, input_bytes = input_bytes.split(b"\n", 1)
            try:
                msg = json.loads(raw)
                action = msg.get("action")
                if action == "write":
                    data = msg.get("text", "")
                    if isinstance(data, str):
                        payload = data.encode("utf-8")
                        if msg.get("enter"):
                            payload += b"\n"
                        os.write(master, payload)
                elif action == "interrupt":
                    os.write(master, b"\x03")
                elif action == "resize":
                    cols = min(300, max(20, int(msg.get("cols", 100))))
                    rows = min(100, max(8, int(msg.get("rows", 32))))
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                elif action == "close":
                    try:
                        os.killpg(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    alive = False
                    break
            except Exception as exc:
                emit({"event": "error", "message": str(exc)[:160]})
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        exit_code = os.waitstatus_to_exitcode(status)
        alive = False
try:
    os.close(master)
except OSError:
    pass
if exit_code is None:
    try:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            exit_code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        pass
emit({"event": "exit", "code": exit_code})
