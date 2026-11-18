; Earliest installer events, before Electron and Python exist.
; This staging log is imported into the shared JSONL stream on first launch.
; No environment values, credentials or personal paths are written.
!macro customInit
  CreateDirectory "$APPDATA\McpGo\Onboarding\Logs"
  FileOpen $0 "$APPDATA\McpGo\Onboarding\Logs\installer-events.log" a
  FileWrite $0 "nsis.init$\r$\n"
  FileClose $0
!macroend

!macro customInstall
  CreateDirectory "$APPDATA\McpGo\Onboarding\Logs"
  FileOpen $0 "$APPDATA\McpGo\Onboarding\Logs\installer-events.log" a
  FileWrite $0 "nsis.install.files-copied$\r$\n"
  FileClose $0
!macroend
