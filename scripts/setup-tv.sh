#!/usr/bin/env bash
# Installs and configures the Bet Overlay app on an Android TV / Google TV over adb.
# Works with bash 3.2 (macOS) and newer.
#
# Usage: scripts/setup-tv.sh <TV_IP[:PORT]> <SERVER_URL>
#   e.g. scripts/setup-tv.sh 192.168.1.50 http://192.168.1.20:8787
#
# Before running: on the TV enable Developer options (Settings > System > About >
# tap "Android TV OS build" 7 times), then turn on USB debugging (Android TV 11/12 TCL
# models also listen on port 5555 over the network once it is on). On Android 14 Google TV
# you may need Settings > System > Developer options > Wireless debugging, then
# "adb pair <ip>:<pair-port> <code>" once, and use the port shown there.

# shellcheck disable=SC2001  # sed is used on purpose to indent multi-line output
set -u

PKG="au.home.betoverlay"
SERVICE_FULL="$PKG/$PKG.OverlayService"
SERVICE_SHORT="$PKG/.OverlayService"
TAG="BetOverlay"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APK="$SCRIPT_DIR/../tv-app/dist/bet-overlay-debug.apk"

FAILS=0
ok()   { printf '[ OK ] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf '       %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { fail "$*"; printf '\nStopping: fix the problem above and run the script again.\n'; exit 1; }

if [ $# -ne 2 ]; then
    echo "Usage: $0 <TV_IP[:PORT]> <SERVER_URL>"
    echo "  e.g. $0 192.168.1.50 http://192.168.1.20:8787"
    exit 2
fi

TARGET="$1"
SERVER_URL="$2"
case "$TARGET" in
    *:*) SERIAL="$TARGET" ;;
    *)   SERIAL="$TARGET:5555" ;;
esac
case "$SERVER_URL" in
    http://*|https://*) ;;
    *) SERVER_URL="http://$SERVER_URL" ;;
esac

if ! command -v adb >/dev/null 2>&1; then
    echo "adb not found. Install Android platform-tools and put adb on your PATH:"
    echo "  macOS: brew install --cask android-platform-tools"
    echo "  Linux: sudo apt install adb   (or download platform-tools from developer.android.com)"
    exit 1
fi

# adb shell output can carry \r on some adb versions; strip it.
ash() { adb -s "$SERIAL" shell "$@" 2>/dev/null | tr -d '\r'; }

# ---------------------------------------------------------------------------
step "1. Connect to $SERIAL"
note "If the TV shows an 'Allow debugging?' prompt, choose Always allow / OK."
adb connect "$SERIAL" >/dev/null 2>&1
STATE=""
i=0
while [ $i -lt 60 ]; do
    STATE="$(adb -s "$SERIAL" get-state 2>&1 | tr -d '\r')"
    case "$STATE" in
        device) break ;;
        *unauthorized*) [ $((i % 10)) -eq 0 ] && note "Waiting for you to accept the prompt on the TV..." ;;
        *) [ $((i % 10)) -eq 5 ] && adb connect "$SERIAL" >/dev/null 2>&1 ;;
    esac
    sleep 1
    i=$((i + 1))
done
if [ "$STATE" = "device" ]; then
    ok "Connected to $SERIAL"
else
    note "adb state: $STATE"
    note "Check the IP, that USB/network debugging is on, and that the prompt was accepted."
    note "Android 14: use Wireless debugging, run 'adb pair <ip>:<port> <code>', then pass <ip>:<port>."
    die "Could not connect to $SERIAL"
fi

# ---------------------------------------------------------------------------
step "2. Device info"
printf '       manufacturer: %s\n' "$(ash getprop ro.product.manufacturer)"
printf '       model:        %s\n' "$(ash getprop ro.product.model)"
printf '       android:      %s (SDK %s)\n' "$(ash getprop ro.build.version.release)" "$(ash getprop ro.build.version.sdk)"
printf '       fingerprint:  %s\n' "$(ash getprop ro.build.fingerprint)"
printf '       %s\n' "$(ash wm size | tr '\n' ' ')"
printf '       %s\n' "$(ash wm density | tr '\n' ' ')"
SDK="$(ash getprop ro.build.version.sdk)"
case "$SDK" in
    ''|*[!0-9]*) fail "Could not read SDK level" ;;
    *) if [ "$SDK" -lt 28 ]; then die "Android SDK $SDK is too old (needs 28+)"; else ok "SDK $SDK is supported"; fi ;;
esac

# ---------------------------------------------------------------------------
step "3. Streaming apps installed"
APPS="$(ash pm list packages | sed 's/^package://' | grep -iE 'kayo|nba|foxtel|sport' | sort)"
if [ -n "$APPS" ]; then
    echo "$APPS" | while IFS= read -r p; do note "$p"; done
    ok "Found matching packages"
else
    note "No packages matching kayo|nba|foxtel|sport (not a problem for the overlay)."
    ok "Package scan done"
fi

# ---------------------------------------------------------------------------
step "4. Install $APK"
if [ ! -f "$APK" ]; then
    die "APK not found at $APK (build it with: cd tv-app && ./gradlew assembleDebug)"
fi
OUT="$(adb -s "$SERIAL" install -r "$APK" 2>&1 | tr -d '\r')"
if echo "$OUT" | grep -q "Success"; then
    ok "Installed"
else
    echo "$OUT" | sed 's/^/       /'
    if echo "$OUT" | grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE"; then
        note "An older copy signed with a different key is installed. Remove it with:"
        note "  adb -s $SERIAL uninstall $PKG"
    fi
    die "adb install failed"
fi

# ---------------------------------------------------------------------------
step "5. Enable the accessibility service"
CURRENT="$(ash settings get secure enabled_accessibility_services)"
case "$CURRENT" in
    ""|null) CURRENT="" ;;
esac
HAVE=0
OLDIFS="$IFS"; IFS=':'
for s in $CURRENT; do
    if [ "$s" = "$SERVICE_FULL" ] || [ "$s" = "$SERVICE_SHORT" ]; then HAVE=1; fi
done
IFS="$OLDIFS"
if [ $HAVE -eq 1 ]; then
    ok "Already in enabled_accessibility_services"
else
    if [ -n "$CURRENT" ]; then NEW="$CURRENT:$SERVICE_FULL"; else NEW="$SERVICE_FULL"; fi
    # Quote for the device shell so other services' names survive intact.
    ash "settings put secure enabled_accessibility_services '$NEW'" >/dev/null
    ok "Set enabled_accessibility_services"
    [ -n "$CURRENT" ] && note "kept existing: $CURRENT"
fi
ash settings put secure accessibility_enabled 1 >/dev/null
if [ "$(ash settings get secure accessibility_enabled)" = "1" ]; then
    ok "accessibility_enabled = 1"
else
    fail "accessibility_enabled is not 1"
fi

# ---------------------------------------------------------------------------
step "6. Keep the app alive (TCL specific, failures are fine)"
if adb -s "$SERIAL" shell appops set "$PKG" AUTO_START allow >/dev/null 2>&1; then
    ok "appops AUTO_START allow"
else
    note "appops AUTO_START not supported on this firmware (fine; accessibility services restart anyway)"
fi
if adb -s "$SERIAL" shell dumpsys deviceidle whitelist +"$PKG" 2>&1 | grep -qi "added"; then
    ok "Added to deviceidle whitelist"
else
    note "deviceidle whitelist did not confirm (fine on most TVs)"
fi

# ---------------------------------------------------------------------------
step "7. Configure server URL: $SERVER_URL"
# Quoted for the device shell in case the URL contains & or ?.
OUT="$(adb -s "$SERIAL" shell "am start -n $PKG/.SetupActivity --es server_url '$SERVER_URL' --ez headless true" 2>&1 | tr -d '\r')"
if echo "$OUT" | grep -qi "error"; then
    echo "$OUT" | sed 's/^/       /'
    fail "am start failed"
else
    ok "Sent configuration"
fi

# ---------------------------------------------------------------------------
step "8. Verify"
sleep "${SETUP_VERIFY_DELAY:-3}"
NOW="$(ash settings get secure enabled_accessibility_services)"
case ":$NOW:" in
    *":$SERVICE_FULL:"*|*":$SERVICE_SHORT:"*) ok "Service listed in enabled_accessibility_services" ;;
    *) fail "Service missing from enabled_accessibility_services: $NOW" ;;
esac
DUMP="$(ash dumpsys accessibility)"
BOUND="$(echo "$DUMP" | grep -i "bound services")"
if echo "$BOUND" | grep -qi -e "$PKG" -e "Bet Overlay panel"; then
    ok "Service is bound (dumpsys accessibility)"
elif echo "$DUMP" | grep -q "$PKG"; then
    ok "dumpsys accessibility lists $PKG (bound state not shown on this firmware)"
else
    fail "Service not bound yet. Open Settings > Accessibility on the TV and turn on 'Bet Overlay panel'."
fi
echo "       Last $TAG log lines:"
adb -s "$SERIAL" logcat -d -s "$TAG" 2>/dev/null | tr -d '\r' | tail -n 20 | sed 's/^/       /'

echo
if [ $FAILS -eq 0 ]; then
    echo "All steps OK. The panel should be in the top right corner of the TV."
else
    echo "$FAILS step(s) failed; see [FAIL] lines above."
fi
echo "Next: run scripts/tv-keylog.sh $SERIAL and press remote buttons to find their key codes,"
echo "then set them with:"
echo "  adb -s $SERIAL shell am start -n $PKG/.SetupActivity --ei toggle_key <code> --ei cycle_key <code> --ez headless true"
[ $FAILS -eq 0 ]
