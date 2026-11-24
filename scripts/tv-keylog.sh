#!/usr/bin/env bash
# Streams the Bet Overlay key log so you can press remote buttons and see their key codes.
# Usage: scripts/tv-keylog.sh [TV_IP[:PORT]]
# Requires the app to be installed with its accessibility service enabled and log_keys on
# (the default). Lines look like: I BetOverlay: key 183 KEYCODE_PROG_RED

set -u

ADB=(adb)
if [ $# -ge 1 ]; then
    case "$1" in
        *:*) SERIAL="$1" ;;
        *)   SERIAL="$1:5555" ;;
    esac
    adb connect "$SERIAL" >/dev/null 2>&1
    ADB=(adb -s "$SERIAL")
fi

echo "Press buttons on the TV remote. Each press prints its key code. Ctrl+C to stop."
echo "Buttons that print nothing never reach apps (the TV firmware handles them)."
echo "To see raw input events instead (shows scan codes even for those):"
echo "  ${ADB[*]} shell getevent -lt"
echo
"${ADB[@]}" logcat -c 2>/dev/null
exec "${ADB[@]}" logcat -v time -s BetOverlay
