package au.home.betoverlay;

import android.accessibilityservice.AccessibilityService;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;

/**
 * The whole app at runtime: draws the bet panel as an accessibility overlay window (no
 * SYSTEM_ALERT_WINDOW needed, and streaming apps cannot hide it with setHideOverlayWindows),
 * listens for the two configured remote keys, and polls the home server.
 *
 * The system rebinds an enabled accessibility service after boot, so no boot receiver or
 * foreground service is needed.
 */
public class OverlayService extends AccessibilityService
        implements SharedPreferences.OnSharedPreferenceChangeListener {

    static final String TAG = "BetOverlay";
    private static final long POLL_VISIBLE_MS = 3000;
    private static final long POLL_HIDDEN_MS = 15000;
    /** Consecutive failed polls before the panel says "Server offline". */
    private static final int OFFLINE_AFTER_FAILURES = 2;

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread pollThread;
    private Handler pollHandler;
    private SharedPreferences prefs;
    private WindowManager wm;
    private Panel panel;
    private boolean attached;

    // Read on the main thread (onKeyEvent) and written by the pref listener (also main thread).
    private int toggleKey = Prefs.DEFAULT_TOGGLE;
    private int cycleKey = Prefs.DEFAULT_CYCLE;
    private boolean logKeys = Prefs.DEFAULT_LOG_KEYS;
    private String learnTarget;
    private long learnUntil;
    /** Key code whose ACTION_UP must still be swallowed after we consumed its ACTION_DOWN. */
    private int swallowUp = -1;

    // Poll state: endpoint and visible are read by the poll thread.
    private volatile String endpoint;
    private volatile boolean visible = true;
    private int corner;

    // Render state, main thread only.
    private OverlayData lastData;
    private int failures;
    private String renderedKey = "";

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            pollOnce();
            Handler h = pollHandler;
            if (h != null) h.postDelayed(this, visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
        }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        prefs = Prefs.get(this);
        loadPrefs();
        prefs.registerOnSharedPreferenceChangeListener(this);
        panel = new Panel(this);
        render();
        if (visible) attach();

        pollThread = new HandlerThread("BetOverlayPoll");
        pollThread.start();
        pollHandler = new Handler(pollThread.getLooper());
        pollHandler.post(pollTask);
        Log.i(TAG, "service connected; toggle=" + Prefs.describeKey(toggleKey)
                + " cycle=" + Prefs.describeKey(cycleKey) + " endpoint=" + endpoint
                + " visible=" + visible + " corner=" + Prefs.cornerName(corner));
    }

    private void loadPrefs() {
        toggleKey = prefs.getInt(Prefs.TOGGLE_KEY, Prefs.DEFAULT_TOGGLE);
        cycleKey = prefs.getInt(Prefs.CYCLE_KEY, Prefs.DEFAULT_CYCLE);
        logKeys = prefs.getBoolean(Prefs.LOG_KEYS, Prefs.DEFAULT_LOG_KEYS);
        visible = prefs.getBoolean(Prefs.VISIBLE, true);
        corner = Math.floorMod(prefs.getInt(Prefs.CORNER, 0), Prefs.CORNER_COUNT);
        endpoint = OverlayClient.endpoint(prefs.getString(Prefs.SERVER_URL, ""));
        learnTarget = prefs.getString(Prefs.LEARN_TARGET, null);
        learnUntil = prefs.getLong(Prefs.LEARN_UNTIL, 0);
    }

    @Override
    public void onSharedPreferenceChanged(SharedPreferences sp, String key) {
        if (key == null) {
            loadPrefs();
            return;
        }
        switch (key) {
            case Prefs.TOGGLE_KEY:
                toggleKey = sp.getInt(key, Prefs.DEFAULT_TOGGLE);
                break;
            case Prefs.CYCLE_KEY:
                cycleKey = sp.getInt(key, Prefs.DEFAULT_CYCLE);
                break;
            case Prefs.LOG_KEYS:
                logKeys = sp.getBoolean(key, Prefs.DEFAULT_LOG_KEYS);
                break;
            case Prefs.LEARN_TARGET:
            case Prefs.LEARN_UNTIL:
                learnTarget = sp.getString(Prefs.LEARN_TARGET, null);
                learnUntil = sp.getLong(Prefs.LEARN_UNTIL, 0);
                break;
            case Prefs.SERVER_URL:
                endpoint = OverlayClient.endpoint(sp.getString(key, ""));
                lastData = null;
                failures = 0;
                render();
                pollNow();
                break;
            default:
                break;
        }
    }

    // ---------------------------------------------------------------- keys

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        final int code = event.getKeyCode();
        final int action = event.getAction();

        if (action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && logKeys) {
            Log.i(TAG, "key " + code + " " + KeyEvent.keyCodeToString(code));
        }

        if (action == KeyEvent.ACTION_UP && code == swallowUp) {
            swallowUp = -1;
            return true;
        }

        // Learn mode (started from the setup screen): take the next non-reserved key.
        if (learnTarget != null && action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0
                && System.currentTimeMillis() < learnUntil && !Prefs.isReservedKey(code)) {
            String prefKey = "cycle".equals(learnTarget) ? Prefs.CYCLE_KEY : Prefs.TOGGLE_KEY;
            Log.i(TAG, "learned " + learnTarget + " key " + Prefs.describeKey(code));
            learnTarget = null;
            prefs.edit().putInt(prefKey, code).remove(Prefs.LEARN_TARGET).remove(Prefs.LEARN_UNTIL).apply();
            swallowUp = code;
            return true;
        }

        if (code != toggleKey && code != cycleKey) return false;

        if (action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            final boolean isToggle = code == toggleKey;
            main.post(() -> {
                if (isToggle) toggleVisible();
                else cycleCorner();
            });
        }
        return true; // consume down, repeats and up for our two keys only
    }

    private void toggleVisible() {
        visible = !visible;
        prefs.edit().putBoolean(Prefs.VISIBLE, visible).apply();
        if (visible) {
            attach();
            pollNow();
        } else {
            detach();
        }
    }

    private void cycleCorner() {
        corner = (corner + 1) % Prefs.CORNER_COUNT;
        prefs.edit().putInt(Prefs.CORNER, corner).apply();
        if (!visible) {
            // Pressing the corner key while hidden brings the panel back in the new corner.
            visible = true;
            prefs.edit().putBoolean(Prefs.VISIBLE, true).apply();
            attach();
            pollNow();
        } else if (attached) {
            try {
                wm.updateViewLayout(panel.root, layoutParams());
            } catch (RuntimeException e) {
                Log.w(TAG, "updateViewLayout failed", e);
            }
        }
    }

    // ---------------------------------------------------------------- window

    private WindowManager.LayoutParams layoutParams() {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        DisplayMetrics dm = getResources().getDisplayMetrics();
        lp.x = Math.round(dm.widthPixels * 0.025f);
        lp.y = Math.round(dm.heightPixels * 0.025f);
        switch (corner) {
            case 1: lp.gravity = Gravity.BOTTOM | Gravity.RIGHT; break;
            case 2: lp.gravity = Gravity.BOTTOM | Gravity.LEFT; break;
            case 3: lp.gravity = Gravity.TOP | Gravity.LEFT; break;
            default: lp.gravity = Gravity.TOP | Gravity.RIGHT; break;
        }
        lp.setTitle("BetOverlay");
        return lp;
    }

    private void attach() {
        if (attached || wm == null || panel == null) return;
        try {
            wm.addView(panel.root, layoutParams());
            attached = true;
        } catch (RuntimeException e) {
            Log.e(TAG, "addView failed", e);
        }
    }

    private void detach() {
        if (!attached) return;
        try {
            wm.removeView(panel.root);
        } catch (RuntimeException e) {
            Log.w(TAG, "removeView failed", e);
        }
        attached = false;
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (attached) {
            renderedKey = "";
            render();
            try {
                wm.updateViewLayout(panel.root, layoutParams());
            } catch (RuntimeException e) {
                Log.w(TAG, "updateViewLayout failed", e);
            }
        }
    }

    // ---------------------------------------------------------------- polling

    private void pollNow() {
        Handler h = pollHandler;
        if (h == null) return;
        // Runs on the single poll thread, so any in-flight poll has already rescheduled itself
        // and that pending run is dropped here: there is only ever one poll chain.
        h.post(() -> {
            h.removeCallbacks(pollTask);
            pollTask.run();
        });
    }

    /** Runs on the poll thread. */
    private void pollOnce() {
        final String ep = endpoint;
        if (ep == null) {
            main.post(this::render);
            return;
        }
        OverlayData data = null;
        String error = null;
        try {
            data = OverlayData.parse(OverlayClient.fetch(ep));
        } catch (Exception e) {
            error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        final OverlayData d = data;
        final String err = error;
        main.post(() -> onPollResult(ep, d, err));
    }

    private void onPollResult(String ep, OverlayData data, String error) {
        if (!ep.equals(endpoint)) return; // URL changed while this request was in flight
        if (data != null) {
            if (failures >= OFFLINE_AFTER_FAILURES) Log.i(TAG, "server back online");
            lastData = data;
            failures = 0;
        } else {
            failures++;
            if (failures == OFFLINE_AFTER_FAILURES) Log.w(TAG, "server offline: " + ep + " " + error);
        }
        render();
    }

    /** Main thread. Rebuilds the panel only when something visible changed. */
    private void render() {
        if (panel == null) return;
        boolean offline = failures >= OFFLINE_AFTER_FAILURES;
        String key;
        if (endpoint == null) {
            key = "nourl";
        } else {
            key = (offline ? "off|" : "on|") + (lastData == null ? "nodata" : lastData.signature);
        }
        if (key.equals(renderedKey)) return;
        renderedKey = key;
        if (endpoint == null) {
            panel.renderMessage("Bet Overlay: set the server URL in the app");
        } else {
            int maxHeight = Math.round(getResources().getDisplayMetrics().heightPixels * 0.65f);
            panel.render(lastData, offline, maxHeight);
        }
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Not used; events are kept to the minimum the system allows.
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onDestroy() {
        if (prefs != null) prefs.unregisterOnSharedPreferenceChangeListener(this);
        Handler h = pollHandler;
        pollHandler = null;
        if (h != null) h.removeCallbacksAndMessages(null);
        if (pollThread != null) pollThread.quitSafely();
        main.removeCallbacksAndMessages(null);
        detach();
        super.onDestroy();
    }
}
