package au.home.betoverlay;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Builds the corner panel programmatically. Sizes are in dp/sp so a 1080p and a 4K TV
 * (both usually 960x540 dp) look the same.
 */
final class Panel {
    static final int PANEL_WIDTH_DP = 300;
    static final int MAX_BETS = 5;
    static final int MAX_LEGS = 6;

    private static final int BG = 0xB3101418;
    private static final int TEXT = 0xFFFFFFFF;
    private static final int TEXT_LEG = 0xFFE6E6E6;
    private static final int TEXT_DIM = 0xFFA8A8A8;

    private final Context ctx;
    private final float density;
    final Root root;

    Panel(Context ctx) {
        this.ctx = ctx;
        this.density = ctx.getResources().getDisplayMetrics().density;
        root = new Root(ctx);
        root.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(BG);
        bg.setCornerRadius(dp(10));
        root.setBackground(bg);
        int p = dp(12);
        root.setPadding(p, p, p, p);
        root.setFocusable(false);
    }

    /** LinearLayout that can be forced to an exact width while the window stays WRAP_CONTENT. */
    static final class Root extends LinearLayout {
        int fixedWidthPx;

        Root(Context c) {
            super(c);
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            if (fixedWidthPx > 0) {
                widthSpec = MeasureSpec.makeMeasureSpec(fixedWidthPx, MeasureSpec.EXACTLY);
            }
            super.onMeasure(widthSpec, heightSpec);
        }
    }

    /** A single small grey line, used for "Server offline" with no data and "Set server URL". */
    void renderMessage(String msg) {
        root.removeAllViews();
        root.fixedWidthPx = 0;
        root.addView(text(msg, 13, TEXT_DIM, false));
        root.requestLayout();
    }

    /**
     * @param offline     true when the last polls failed; data (if any) is the last good copy
     * @param maxHeightPx bets are dropped (and counted in "+N more") beyond this height
     */
    void render(OverlayData data, boolean offline, int maxHeightPx) {
        root.removeAllViews();
        if (data == null) {
            renderMessage(offline ? "Server offline" : "Connecting...");
            return;
        }
        if (data.bets.isEmpty()) {
            root.fixedWidthPx = 0;
            TextView t = text("No live bets | " + data.todayText(), 13,
                    offline ? TEXT_DIM : TEXT_LEG, false);
            root.addView(t);
            if (offline) root.addView(text("Server offline", 12, OverlayData.GREY, false));
            root.requestLayout();
            return;
        }

        root.fixedWidthPx = dp(PANEL_WIDTH_DP);
        int innerWidth = root.fixedWidthPx - root.getPaddingLeft() - root.getPaddingRight();

        // Header: BETS ............ Today +$12.50
        LinearLayout header = row();
        TextView label = text("BETS", 13, TEXT, true);
        label.setLetterSpacing(0.12f);
        header.addView(label, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        header.addView(text(data.todayText(), 14, data.todayColor(), true));
        root.addView(header);
        if (offline) {
            TextView off = text("Server offline", 12, OverlayData.GREY, false);
            root.addView(off);
        }

        int used = measure(root, innerWidth); // header plus top and bottom padding
        int footerReserve = dp(22);
        List<View> blocks = new ArrayList<>();
        int shown = 0;
        for (OverlayData.Bet bet : data.bets) {
            if (shown >= MAX_BETS) break;
            View block = betBlock(data.currency, bet);
            int h = measure(block, innerWidth) + dp(8);
            boolean last = shown == data.bets.size() - 1;
            int limit = maxHeightPx - (last ? 0 : footerReserve);
            if (shown > 0 && used + h > limit) break;
            used += h;
            blocks.add(block);
            shown++;
        }
        for (View b : blocks) {
            if (offline) b.setAlpha(0.45f);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(8);
            root.addView(b, lp);
        }
        int more = data.bets.size() - shown;
        if (more > 0) {
            TextView m = text("+" + more + " more", 12, TEXT_DIM, false);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(6);
            root.addView(m, lp);
        }
        root.requestLayout();
    }

    private View betBlock(String currency, OverlayData.Bet bet) {
        LinearLayout block = new LinearLayout(ctx);
        block.setOrientation(LinearLayout.VERTICAL);

        LinearLayout title = row();
        title.setGravity(Gravity.CENTER_VERTICAL);
        View dot = dot(OverlayData.statusColor(bet.status), 9, 9, 4.5f);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(9), dp(9));
        dlp.rightMargin = dp(6);
        title.addView(dot, dlp);
        String titleText = bet.title.isEmpty() && !bet.legs.isEmpty() ? bet.legs.get(0).label : bet.title;
        TextView tt = text(titleText, 15, TEXT, true);
        title.addView(tt, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        boolean settled = OverlayData.isSettled(bet.status);
        TextView sum = text(OverlayData.betSummary(currency, bet), 12,
                settled ? OverlayData.statusColor(bet.status) : TEXT_DIM, settled);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        slp.leftMargin = dp(6);
        title.addView(sum, slp);
        block.addView(title);

        // A single whose only leg repeats the title just shows the detail line.
        boolean single = bet.legs.size() == 1 && bet.legs.get(0).label.equalsIgnoreCase(titleText);
        int legCount = Math.min(bet.legs.size(), MAX_LEGS);
        for (int i = 0; i < legCount; i++) {
            OverlayData.Leg leg = bet.legs.get(i);
            if (single) {
                if (!leg.detail.isEmpty()) {
                    TextView d = text(leg.detail, 12, TEXT_DIM, false);
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                    lp.leftMargin = dp(15);
                    block.addView(d, lp);
                }
                continue;
            }
            block.addView(legRow(leg));
        }
        if (bet.legs.size() > legCount) {
            TextView m = text("+" + (bet.legs.size() - legCount) + " more legs", 12, TEXT_DIM, false);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(15);
            block.addView(m, lp);
        }
        return block;
    }

    private View legRow(OverlayData.Leg leg) {
        LinearLayout r = row();
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rlp.topMargin = dp(3);
        rlp.leftMargin = dp(15);
        r.setLayoutParams(rlp);

        View marker = dot(OverlayData.statusColor(leg.status), 4, 14, 2);
        LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(dp(4), dp(14));
        mlp.rightMargin = dp(7);
        mlp.topMargin = dp(2);
        r.addView(marker, mlp);

        LinearLayout col = new LinearLayout(ctx);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(text(leg.label, 13, TEXT_LEG, false));
        if (!leg.detail.isEmpty()) col.addView(text(leg.detail, 12, TEXT_DIM, false));
        r.addView(col, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        return r;
    }

    private LinearLayout row() {
        LinearLayout r = new LinearLayout(ctx);
        r.setOrientation(LinearLayout.HORIZONTAL);
        return r;
    }

    private View dot(int color, int wDp, int hDp, float radiusDp) {
        View v = new View(ctx);
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(radiusDp * density);
        g.setSize(dp(wDp), dp(hDp));
        v.setBackground(g);
        return v;
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(ctx);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setIncludeFontPadding(false);
        t.setPadding(0, dp(1), 0, dp(1));
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setShadowLayer(2f, 0f, 1f, 0xCC000000);
        return t;
    }

    private static int measure(View v, int widthPx) {
        v.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        return v.getMeasuredHeight();
    }

    private int dp(float v) {
        return Math.round(v * density);
    }
}
