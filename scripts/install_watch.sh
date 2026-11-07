#!/bin/bash
# Build, sign, install and launch PocketWatch on a connected Apple Watch (via its paired iPhone).
#
#   scripts/install_watch.sh            # first available watch
#   scripts/install_watch.sh <ID>       # a specific watch: CoreDevice id or hardware UDID
#
# Needs: iPhone connected to the Mac with a DATA cable (trusted), Developer Mode on for the iPhone AND the
# watch, Secrets.xcconfig with POCKET_SHARED_KEY and POCKET_TEAM_ID, Xcode signed in to your Apple ID.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f Secrets.xcconfig ] || { echo "Missing Secrets.xcconfig (copy Secrets.example.xcconfig)"; exit 1; }
grep -qE '^POCKET_TEAM_ID *= *[A-Z0-9]{10}' Secrets.xcconfig || { echo "POCKET_TEAM_ID is empty in Secrets.xcconfig"; exit 1; }

# devicectl uses the CoreDevice identifier, xcodebuild uses the hardware UDID. Resolve both.
WANT="${1:-}"
TMP="$(mktemp)"
xcrun devicectl list devices --json-output "$TMP" >/dev/null 2>&1 || true
IDS="$(python3 -I - "$TMP" "$WANT" <<'PYEND'
import json, sys
want = sys.argv[2]
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    devices = []
for d in devices:
    hw = d.get("hardwareProperties", {})
    state = d.get("connectionProperties", {}).get("tunnelState")
    is_watch = hw.get("deviceType") == "appleWatch" or hw.get("platform") == "watchOS"
    if want:
        match = want in (d.get("identifier"), hw.get("udid"))
    else:
        match = is_watch and state != "unavailable"
    if match:
        print(d["identifier"], hw.get("udid", ""))
        break
PYEND
)"
rm -f "$TMP"
DEVICE="${IDS%% *}"
UDID="${IDS##* }"

if [ -z "$DEVICE" ]; then
  echo "No Apple Watch is available to Xcode."
  echo "  1. Connect the iPhone to this Mac with a data cable, unlock it, tap Trust."
  echo "  2. Xcode > Window > Devices and Simulators: the watch should appear under the iPhone."
  echo "  3. Watch: Settings > Privacy & Security > Developer Mode."
  echo "Current devices:"; xcrun devicectl list devices 2>&1 | sed 's/^/  /'
  exit 2
fi

echo "Watch: $DEVICE (udid $UDID)"
xcodegen generate -q
xcodebuild -project PocketWatch.xcodeproj -scheme PocketWatch \
  -destination "id=$UDID" -derivedDataPath build -allowProvisioningUpdates build \
  | grep -E "error:|BUILD|Signing" || true

APP="build/Build/Products/Debug-watchos/PocketWatch.app"
[ -d "$APP" ] || { echo "Build failed: $APP not found"; exit 1; }

xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" com.wolfai.pocketwatch
echo "Installed and launched. If the watch says 'Untrusted Developer': iPhone > Settings > General > VPN & Device Management."
