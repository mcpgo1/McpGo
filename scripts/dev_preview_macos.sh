#!/bin/zsh
# Fast local SwiftUI preview: no DMG, Developer ID signing, notarization, or release publish.
# Does not change /Applications/McpGo.app, installed LaunchAgents, profiles or Keychain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_APP="/Applications/McpGo.app"
DEV_DIR="$ROOT/release/dev"
DEV_APP="$DEV_DIR/McpGo Dev.app"
SDK="$(xcrun --show-sdk-path)"
mkdir -p "$DEV_DIR"

if [[ ! -d "$DEV_APP" ]]; then
  if [[ ! -f "$SOURCE_APP/Contents/Resources/RuntimeSeed/onboarding/cli.py" ]]; then
    print -u2 "Missing the installed McpGo runtime. Install the signed DMG once before starting dev previews."
    exit 2
  fi
  echo "[dev] Creating isolated copy of the installed app..."
  if ! cp -cR "$SOURCE_APP" "$DEV_APP"; then
    /usr/bin/ditto "$SOURCE_APP" "$DEV_APP"
  fi
  PLIST="$DEV_APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.mcphub.native.dev" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName McpGo Dev" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName McpGo Dev" "$PLIST" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string McpGo Dev" "$PLIST"
fi

if [[ ! -f "$DEV_APP/Contents/Resources/RuntimeSeed/onboarding/cli.py" ]]; then
  print -u2 "The dev bundle has no runtime; refusing an incomplete preview."
  exit 3
fi

# Never replace the executable of a still-running Dev application.
if /usr/bin/pgrep -f "$DEV_APP/Contents/MacOS/MCPHub" >/dev/null; then
  echo "[dev] Closing the previous preview (installed release is untouched)..."
  /usr/bin/osascript -e 'tell application id "local.mcphub.native.dev" to quit' >/dev/null 2>&1 || true
  for attempt in {1..30}; do
    /usr/bin/pgrep -f "$DEV_APP/Contents/MacOS/MCPHub" >/dev/null || break
    sleep 0.2
  done
  if /usr/bin/pgrep -f "$DEV_APP/Contents/MacOS/MCPHub" >/dev/null; then
    print -u2 "Close McpGo Dev manually before rebuilding."
    exit 4
  fi
fi

echo "[dev] Compiling SwiftUI in debug mode (no Xcode project needed)..."
TEMP_EXE="$DEV_DIR/MCPHub.compile"
trap 'rm -f "$TEMP_EXE"' EXIT
xcrun swiftc -parse-as-library \
  -sdk "$SDK" -target arm64-apple-macosx14.0 -Onone \
  -o "$TEMP_EXE" \
  "$ROOT/native/main.swift" \
  "$ROOT/native/Messaging.swift" \
  "$ROOT/native/TunnelSettings.swift" \
  "$ROOT/native/TunnelHelp.swift" \
  "$ROOT/native/InteractiveButtonStyle.swift" \
  "$ROOT/native/SkillsView.swift" \
  "$ROOT/native/ScheduledMessages.swift" \
  "$ROOT/native/OnboardingView.swift"
echo "[dev] Updating only the isolated preview application..."
install -m 755 "$TEMP_EXE" "$DEV_APP/Contents/MacOS/MCPHub"
# Refresh bundled tutorial images before signing the Dev copy. The release
# in /Applications and all user settings are left untouched.
HELP_SRC="$ROOT/assets/onboarding"
HELP_DST="$DEV_APP/Contents/Resources/HelpImages"
mkdir -p "$HELP_DST"
for image_name in admin-key-list.png admin-key-dialog.png chatgpt-plugin-menu.png chatgpt-server-form.png chatgpt-connect-confirmation.png; do
  if [[ ! -f "$HELP_SRC/$image_name" || -L "$HELP_SRC/$image_name" ]]; then
    print -u2 "[dev] Missing tutorial image: $image_name"
    exit 7
  fi
  if ! cmp -s "$HELP_SRC/$image_name" "$HELP_DST/$image_name"; then
    cp -p "$HELP_SRC/$image_name" "$HELP_DST/$image_name"
  fi
done

# Keep the offline documentation in the Dev app and include it in the
# signature. Never reference the developer's project path at runtime.
DOC_SRC="$ROOT/assets/docs/index.html"
DOC_DEST="$DEV_APP/Contents/Resources/Documentation/index.html"
if [[ ! -f "$DOC_SRC" || -L "$DOC_SRC" ]]; then
  print -u2 "[dev] Missing offline documentation."
  exit 11
fi
mkdir -p "$(dirname "$DOC_DEST")"
if ! cmp -s "$DOC_SRC" "$DOC_DEST"; then
  cp -p "$DOC_SRC" "$DOC_DEST"
fi

# Sign only this app, never the Release DMG or installed copy.
codesign --force --sign - --options runtime "$DEV_APP"
codesign --verify --deep --strict "$DEV_APP"

# The wizard executes its Python engine from Application Support, not the
# repository. Updating only SwiftUI would leave the old org_ validator active
# and make the now-enabled button fail on the next step. Synchronize ONLY the
# Python onboarding code for this user's local first-run DEV test.
# Do not copy secrets, state, configuration, keys, services or LaunchAgents.
RUNTIME="$HOME/Library/Application Support/McpGo/Runtime"
ENGINE="$RUNTIME/onboarding/setup_engine.py"
if [[ -f "$ENGINE" && ! -L "$ENGINE" && ! -L "$RUNTIME" ]]; then
  mkdir -p "$DEV_DIR/runtime-code-backup"
  BACKUP="$DEV_DIR/runtime-code-backup/setup_engine.py.before-dev-sync"
  if [[ ! -f "$BACKUP" ]]; then
    cp -p "$ENGINE" "$BACKUP"
  fi
  if ! cmp -s "$ROOT/onboarding/setup_engine.py" "$ENGINE"; then
    cp -p "$ROOT/onboarding/setup_engine.py" "$ENGINE"
    echo "[dev] Updated first-run Python validation in the writable test runtime."
  fi
else
  print -u2 "[dev] No safe writable runtime engine found; refusing a partial UI-only update."
  exit 5
fi

# Keep opt-in runtime provisioning module in the writable test runtime.
# Copy source code ONLY, never settings, tokens or user data.
MODULE_SRC="$ROOT/onboarding/runtime_provision.py"
MODULE_DEST="$RUNTIME/onboarding/runtime_provision.py"
if [[ -f "$MODULE_SRC" && ! -L "$MODULE_DEST" ]]; then
  if ! cmp -s "$MODULE_SRC" "$MODULE_DEST"; then
    cp -p "$MODULE_SRC" "$MODULE_DEST"
    echo "[dev] Synced scoped runtime key provisioning code."
  fi
fi

# The SwiftUI wizard invokes the CLI from the user's mutable runtime.
# Always sync the CLI action registry alongside its Python engine and module.
CLI_SRC="$ROOT/onboarding/cli.py"
CLI_DEST="$RUNTIME/onboarding/cli.py"
if [[ ! -f "$CLI_DEST" || -L "$CLI_DEST" ]]; then
  print -u2 "[dev] Missing or unsafe onboarding CLI in runtime."
  exit 6
fi
if ! cmp -s "$CLI_SRC" "$CLI_DEST"; then
  CLI_BACKUP="$DEV_DIR/runtime-code-backup/cli.py.before-dev-sync"
  if [[ ! -f "$CLI_BACKUP" ]]; then
    cp -p "$CLI_DEST" "$CLI_BACKUP"
  fi
  cp -p "$CLI_SRC" "$CLI_DEST"
  echo "[dev] Synced onboarding CLI actions."
fi

# The Dashboard copies its terminal runner from the installed runtime into
# Application Support/ChatTerminalHub at start time. In the Dev preview,
# synchronize the fixed runner source too; never overwrite profiles, tokens,
# plists or LaunchAgent state. Its content is public script code only.
TUNNEL_RUN_SRC="$ROOT/terminal/run-tunnel.sh"
TUNNEL_RUN_DEST="$RUNTIME/terminal/run-tunnel.sh"
if [[ -f "$TUNNEL_RUN_DEST" && ! -L "$TUNNEL_RUN_DEST" &&
      ! -L "$RUNTIME/terminal" && -f "$TUNNEL_RUN_SRC" ]]; then
  /bin/zsh -n "$TUNNEL_RUN_SRC"
  if ! cmp -s "$TUNNEL_RUN_SRC" "$TUNNEL_RUN_DEST"; then
    mkdir -p "$DEV_DIR/runtime-code-backup"
    TUNNEL_BACKUP="$DEV_DIR/runtime-code-backup/run-tunnel.sh.before-dev-sync"
    if [[ ! -f "$TUNNEL_BACKUP" ]]; then
      cp -p "$TUNNEL_RUN_DEST" "$TUNNEL_BACKUP"
    fi
    cp -p "$TUNNEL_RUN_SRC" "$TUNNEL_RUN_DEST"
    echo "[dev] Synced terminal tunnel runner for first-run testing."
  fi
else
  print -u2 "[dev] Terminal runner cannot be safely synchronized; check runtime installation."
  exit 8
fi

# Keep the ownership validator paired with the runner it validates.
# Both are public source-code files in this installation's runtime.
SETUP_SRC="$ROOT/scripts/setup_macos.py"
SETUP_DEST="$RUNTIME/scripts/setup_macos.py"
if [[ -f "$SETUP_DEST" && ! -L "$SETUP_DEST" &&
      ! -L "$RUNTIME/scripts" && -f "$SETUP_SRC" ]]; then
  if ! cmp -s "$SETUP_SRC" "$SETUP_DEST"; then
    SETUP_BACKUP="$DEV_DIR/runtime-code-backup/setup_macos.py.before-dev-sync"
    if [[ ! -f "$SETUP_BACKUP" ]]; then
      cp -p "$SETUP_DEST" "$SETUP_BACKUP"
    fi
    cp -p "$SETUP_SRC" "$SETUP_DEST"
    echo "[dev] Synced ownership validator for first-run testing."
  fi
else
  print -u2 "[dev] Ownership validator cannot be safely synchronized."
  exit 9
fi

# Sync the browser launcher too. A file:// URL pathname contains %20 for
# Application Support; using fileURLToPath is essential in the installed
# runtime, not just in the repository source.
BROWSER_SRC="$ROOT/launchers/browser.mjs"
BROWSER_DEST="$RUNTIME/launchers/browser.mjs"
if [[ -f "$BROWSER_DEST" && ! -L "$BROWSER_DEST" &&
      ! -L "$RUNTIME/launchers" && -f "$BROWSER_SRC" ]]; then
  "$RUNTIME/vendor/node/bin/node" --check "$BROWSER_SRC"
  if ! cmp -s "$BROWSER_SRC" "$BROWSER_DEST"; then
    BROWSER_BACKUP="$DEV_DIR/runtime-code-backup/browser.mjs.before-dev-sync"
    if [[ ! -f "$BROWSER_BACKUP" ]]; then
      cp -p "$BROWSER_DEST" "$BROWSER_BACKUP"
    fi
    cp -p "$BROWSER_SRC" "$BROWSER_DEST"
    echo "[dev] Synced Playwright launcher for paths containing spaces."
  fi
else
  print -u2 "[dev] Browser launcher cannot be safely synchronized."
  exit 10
fi

echo "[dev] Preview ready: $DEV_APP"
echo "[dev] This app shares the current user's McpGo test state; no services are installed by the build."
if [[ "${1:-}" == "--launch" ]]; then
  # Allow multiple instances while retaining the unmodified installed original.
  open -n "$DEV_APP"
  echo "[dev] Launched McpGo Dev (installed McpGo is untouched)."
fi
