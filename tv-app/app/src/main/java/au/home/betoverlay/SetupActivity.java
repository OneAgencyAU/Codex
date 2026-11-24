package au.home.betoverlay;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.text.TextUtils;
import android.util.Log;
import android.util.TypedValue;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * D-pad friendly setup screen. Also configurable headlessly over adb:
 * am start -n au.home.betoverlay/.SetupActivity --es server_url http://192.168.1.20:8787
 *     --ei toggle_key 183 --ei cycle_key 184 --ez log_keys true --ez headless true
 */
public class SetupActivity extends Activity implements SharedPreferences.OnSharedPreferenceChangeListener {

    private static final long LEARN_WINDOW_MS = 60_000;

    private SharedPreferences prefs;
    private EditText urlField;
    private TextView urlStatus;
    private TextView serviceStatus;
    private TextView toggleText;
    private TextView cycleText;
    private TextView learnStatus;
    private CheckBox logBox;
    private TextView testResult;
    /** "toggle", "cycle" or null. */
    private String learning;
    private int swallowUp = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = Prefs.get(this);
        if (applyExtras(getIntent())) {
            finish();
            return;
        }
        buildUi();
        prefs.registerOnSharedPreferenceChangeListener(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (applyExtras(intent)) {
            finish();
            return;
        }
        refresh();
    }

    /** Applies adb extras. Returns true when the activity should finish (headless). */
    private boolean applyExtras(Intent i) {
        if (i == null || i.getExtras() == null) return false;
        SharedPreferences.Editor e = prefs.edit();
        boolean changed = false;
        if (i.hasExtra("server_url")) {
            String url = i.getStringExtra("server_url");
            e.putString(Prefs.SERVER_URL, url == null ? "" : url.trim());
            changed = true;
        }
        if (i.hasExtra("toggle_key")) {
            e.putInt(Prefs.TOGGLE_KEY, i.getIntExtra("toggle_key", Prefs.DEFAULT_TOGGLE));
            changed = true;
        }
        if (i.hasExtra("cycle_key")) {
            e.putInt(Prefs.CYCLE_KEY, i.getIntExtra("cycle_key", Prefs.DEFAULT_CYCLE));
            changed = true;
        }
        if (i.hasExtra("log_keys")) {
            e.putBoolean(Prefs.LOG_KEYS, i.getBooleanExtra("log_keys", Prefs.DEFAULT_LOG_KEYS));
            changed = true;
        }
        if (changed) {
            e.apply();
            Log.i(OverlayService.TAG, "config from intent: server_url=" + prefs.getString(Prefs.SERVER_URL, "")
                    + " toggle=" + Prefs.describeKey(prefs.getInt(Prefs.TOGGLE_KEY, Prefs.DEFAULT_TOGGLE))
                    + " cycle=" + Prefs.describeKey(prefs.getInt(Prefs.CYCLE_KEY, Prefs.DEFAULT_CYCLE))
                    + " log_keys=" + prefs.getBoolean(Prefs.LOG_KEYS, Prefs.DEFAULT_LOG_KEYS));
        }
        return i.getBooleanExtra("headless", false);
    }

    // ---------------------------------------------------------------- UI

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(48); // TV overscan safe area
        col.setPadding(pad, dp(27), pad, dp(27));
        scroll.addView(col);

        col.addView(heading("Bet Overlay setup", 26));

        col.addView(heading("Server URL", 18));
        LinearLayout urlRow = row();
        urlField = new EditText(this);
        urlField.setSingleLine(true);
        urlField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlField.setImeOptions(EditorInfo.IME_ACTION_DONE);
        urlField.setHint("http://192.168.1.20:8787");
        urlField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        urlField.setText(prefs.getString(Prefs.SERVER_URL, ""));
        urlField.setOnEditorActionListener((v, actionId, ev) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                saveUrl();
                return true;
            }
            return false;
        });
        urlRow.addView(urlField, new LinearLayout.LayoutParams(dp(420), LinearLayout.LayoutParams.WRAP_CONTENT));
        Button save = button("Save", v -> saveUrl());
        urlRow.addView(save);
        Button test = button("Test server", v -> testServer());
        urlRow.addView(test);
        col.addView(urlRow);
        urlStatus = body("");
        col.addView(urlStatus);
        testResult = body("");
        col.addView(testResult);

        col.addView(heading("Accessibility service", 18));
        serviceStatus = body("");
        col.addView(serviceStatus);
        Button open = button("Open accessibility settings", v -> {
            try {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            } catch (RuntimeException ex) {
                serviceStatus.setText("Could not open settings on this TV. Use the setup script (adb) instead.");
            }
        });
        col.addView(wrap(open));

        col.addView(heading("Remote keys", 18));
        toggleText = body("");
        col.addView(toggleText);
        cycleText = body("");
        col.addView(cycleText);
        LinearLayout keyRow = row();
        keyRow.addView(button("Learn toggle key", v -> startLearning("toggle")));
        keyRow.addView(button("Learn corner key", v -> startLearning("cycle")));
        col.addView(keyRow);
        learnStatus = body("");
        col.addView(learnStatus);

        logBox = new CheckBox(this);
        logBox.setText("Log key presses (adb logcat -s BetOverlay)");
        logBox.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        logBox.setOnCheckedChangeListener((b, checked) ->
                prefs.edit().putBoolean(Prefs.LOG_KEYS, checked).apply());
        col.addView(logBox);

        col.addView(body("The panel appears in a screen corner over any app once the service is enabled. "
                + "Toggle key shows or hides it; corner key moves it (top right, bottom right, bottom left, top left)."));

        setContentView(scroll);
        save.requestFocus();
        refresh();
    }

    private void refresh() {
        if (serviceStatus == null) return;
        boolean enabled = isServiceEnabled();
        serviceStatus.setText(enabled
                ? "Overlay service: ENABLED"
                : "Overlay service: NOT ENABLED. Turn on \"Bet Overlay panel\" in accessibility settings.");
        serviceStatus.setTextColor(enabled ? OverlayData.GREEN : OverlayData.RED);
        toggleText.setText("Show/hide key: " + Prefs.describeKey(prefs.getInt(Prefs.TOGGLE_KEY, Prefs.DEFAULT_TOGGLE)));
        cycleText.setText("Corner key: " + Prefs.describeKey(prefs.getInt(Prefs.CYCLE_KEY, Prefs.DEFAULT_CYCLE))
                + "   (panel now " + Prefs.cornerName(prefs.getInt(Prefs.CORNER, 0)) + ", "
                + (prefs.getBoolean(Prefs.VISIBLE, true) ? "shown" : "hidden") + ")");
        logBox.setChecked(prefs.getBoolean(Prefs.LOG_KEYS, Prefs.DEFAULT_LOG_KEYS));
        if (learning == null) learnStatus.setText("");
    }

    private void saveUrl() {
        String url = urlField.getText().toString().trim();
        prefs.edit().putString(Prefs.SERVER_URL, url).apply();
        String ep = OverlayClient.endpoint(url);
        urlStatus.setText(ep == null ? "Cleared" : "Saved. Polling " + ep);
    }

    private void testServer() {
        final String ep = OverlayClient.endpoint(urlField.getText().toString());
        if (ep == null) {
            testResult.setText("Enter a server URL first");
            return;
        }
        testResult.setText("Testing " + ep + " ...");
        new Thread(() -> {
            String msg;
            try {
                OverlayData d = OverlayData.parse(OverlayClient.fetch(ep));
                msg = "OK: " + d.bets.size() + " bets, " + d.todayText();
            } catch (Exception e) {
                msg = "Failed: " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : " " + e.getMessage());
            }
            final String m = msg;
            runOnUiThread(() -> testResult.setText(m));
        }, "BetOverlayTest").start();
    }

    // ---------------------------------------------------------------- key learning

    private void startLearning(String target) {
        learning = target;
        // The service also watches this so it can learn keys that never reach an activity.
        prefs.edit().putString(Prefs.LEARN_TARGET, target)
                .putLong(Prefs.LEARN_UNTIL, System.currentTimeMillis() + LEARN_WINDOW_MS).apply();
        learnStatus.setText("Press the remote button to use as the "
                + ("cycle".equals(target) ? "corner" : "show/hide") + " key now (Back cancels)");
    }

    private void stopLearning() {
        learning = null;
        prefs.edit().remove(Prefs.LEARN_TARGET).remove(Prefs.LEARN_UNTIL).apply();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (event.getAction() == KeyEvent.ACTION_UP && code == swallowUp) {
            swallowUp = -1;
            return true;
        }
        if (learning != null && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            if (code == KeyEvent.KEYCODE_BACK) {
                stopLearning();
                learnStatus.setText("Cancelled");
                swallowUp = code;
                return true;
            }
            if (!Prefs.isReservedKey(code)) {
                String target = learning;
                learning = null;
                prefs.edit().putInt("cycle".equals(target) ? Prefs.CYCLE_KEY : Prefs.TOGGLE_KEY, code)
                        .remove(Prefs.LEARN_TARGET).remove(Prefs.LEARN_UNTIL).apply();
                learnStatus.setText("Saved " + Prefs.describeKey(code));
                swallowUp = code;
                refresh();
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onSharedPreferenceChanged(SharedPreferences sp, String key) {
        if (learning != null && (Prefs.TOGGLE_KEY.equals(key) || Prefs.CYCLE_KEY.equals(key))) {
            // The service caught the key first.
            learning = null;
            learnStatus.setText("Saved " + Prefs.describeKey(sp.getInt(key, 0)));
        }
        refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (learning != null) stopLearning();
    }

    @Override
    protected void onDestroy() {
        if (prefs != null) prefs.unregisterOnSharedPreferenceChangeListener(this);
        super.onDestroy();
    }

    private boolean isServiceEnabled() {
        String enabled = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        ComponentName mine = new ComponentName(this, OverlayService.class);
        for (String s : enabled.split(":")) {
            ComponentName c = ComponentName.unflattenFromString(s.trim());
            if (mine.equals(c)) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- view helpers

    private TextView heading(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(0xFFFFFFFF);
        t.setPadding(0, dp(16), 0, dp(4));
        return t;
    }

    private TextView body(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        t.setTextColor(0xFFCCCCCC);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private Button button(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setFocusable(true);
        b.setOnClickListener(l);
        return b;
    }

    private LinearLayout row() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        return r;
    }

    private LinearLayout wrap(View v) {
        LinearLayout r = row();
        r.addView(v);
        return r;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
