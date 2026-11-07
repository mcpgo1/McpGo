# McpGo Messaging

This module provides a local SQLite queue and HTTP/CLI interface. Its runtime data
is created per-user at `~/Library/Application Support/McpGo/Messaging/`, not in
the source checkout. It never reads private ChatGPT chat transcripts.

**Technical documentation:** [docs/MESSAGING.md](../docs/MESSAGING.md).

On macOS, use **Запустить McpGo.command** from the project root for first-run setup.
For local isolated tests: `python3 -m unittest discover -s messaging/tests -v`.
