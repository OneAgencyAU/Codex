package au.home.betoverlay;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.KeyEvent;

/** Shared preference keys and defaults used by both the service and the setup screen. */
final class Prefs {
    static final String FILE = "bet_overlay";

    static final String SERVER_URL = "server_url";
    static final String TOGGLE_KEY = "toggle_key";
    static final String CYCLE_KEY = "cycle_key";
    static final String LOG_KEYS = "log_keys";
    static final String VISIBLE = "visible";
    static final String CORNER = "corner";
    /** "toggle" or "cycle" while the setup screen is waiting for a key; absent otherwise. */
    static final String LEARN_TARGET = "learn_target";
    /** System.currentTimeMillis() after which a pending learn request is ignored. */
    static final String LEARN_UNTIL = "learn_until";

    static final int DEFAULT_TOGGLE = KeyEvent.KEYCODE_PROG_RED;   // 183
    static final int DEFAULT_CYCLE = KeyEvent.KEYCODE_PROG_GREEN;  // 184
    static final boolean DEFAULT_LOG_KEYS = true;

    /** Corners in cycle order: top right (default), bottom right, bottom left, top left. */
    static final int CORNER_COUNT = 4;

    private Prefs() {}

    static SharedPreferences get(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String cornerName(int corner) {
        switch (corner) {
            case 1: return "bottom right";
            case 2: return "bottom left";
            case 3: return "top left";
            default: return "top right";
        }
    }

    /** Keys that must never be learned as overlay keys (they are needed to navigate or watch). */
    static boolean isReservedKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_HOME:
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_VOLUME_UP:
            case KeyEvent.KEYCODE_VOLUME_DOWN:
            case KeyEvent.KEYCODE_VOLUME_MUTE:
            case KeyEvent.KEYCODE_POWER:
            case KeyEvent.KEYCODE_UNKNOWN:
                return true;
            default:
                return false;
        }
    }

    static String describeKey(int code) {
        return code + " (" + KeyEvent.keyCodeToString(code) + ")";
    }
}
