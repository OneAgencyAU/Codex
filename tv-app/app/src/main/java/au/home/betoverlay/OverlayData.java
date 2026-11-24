package au.home.betoverlay;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Parsed GET /api/overlay response (see CONTRACT.json.txt). Plain Java plus org.json so it
 * has no Android view dependencies.
 */
final class OverlayData {
    static final int GREEN = 0xFF3DDC84;
    static final int RED = 0xFFFF5A5F;
    static final int GREY = 0xFFB0B0B0;
    static final int AMBER = 0xFFFFB020;

    double dayPnl;
    String currency = "$";
    final List<Bet> bets = new ArrayList<>();
    /** Everything that affects rendering, so unchanged polls can skip a rebuild. */
    String signature = "";

    static final class Bet {
        String id = "";
        String title = "";
        double stake;
        double odds;
        double toWin;
        String status = "pending";
        final List<Leg> legs = new ArrayList<>();
    }

    static final class Leg {
        String label = "";
        String detail = "";
        String status = "pending";
    }

    static OverlayData parse(String json) throws JSONException {
        JSONObject o = new JSONObject(json);
        OverlayData d = new OverlayData();
        d.dayPnl = o.optDouble("dayPnl", 0);
        if (Double.isNaN(d.dayPnl)) d.dayPnl = 0;
        d.currency = clean(o.optString("currency", "$"));
        if (d.currency.isEmpty()) d.currency = "$";
        StringBuilder sig = new StringBuilder();
        sig.append(d.dayPnl).append('|').append(d.currency);
        JSONArray bets = o.optJSONArray("bets");
        if (bets != null) {
            for (int i = 0; i < bets.length(); i++) {
                JSONObject b = bets.optJSONObject(i);
                if (b == null) continue;
                Bet bet = new Bet();
                bet.id = clean(b.optString("id", ""));
                bet.title = clean(b.optString("title", ""));
                bet.stake = num(b, "stake");
                bet.odds = num(b, "odds");
                bet.toWin = num(b, "toWin");
                bet.status = clean(b.optString("status", "pending")).toLowerCase(Locale.US);
                sig.append("#").append(bet.id).append('|').append(bet.title).append('|')
                        .append(bet.stake).append('|').append(bet.odds).append('|')
                        .append(bet.toWin).append('|').append(bet.status);
                JSONArray legs = b.optJSONArray("legs");
                if (legs != null) {
                    for (int j = 0; j < legs.length(); j++) {
                        JSONObject l = legs.optJSONObject(j);
                        if (l == null) continue;
                        Leg leg = new Leg();
                        leg.label = clean(l.optString("label", ""));
                        leg.detail = clean(l.optString("detail", ""));
                        leg.status = clean(l.optString("status", "pending")).toLowerCase(Locale.US);
                        bet.legs.add(leg);
                        sig.append('~').append(leg.label).append('|').append(leg.detail)
                                .append('|').append(leg.status);
                    }
                }
                d.bets.add(bet);
            }
        }
        d.signature = sig.toString();
        return d;
    }

    private static double num(JSONObject o, String key) {
        double v = o.optDouble(key, 0);
        return Double.isNaN(v) || Double.isInfinite(v) ? 0 : v;
    }

    /** Server text is shown as is, except em dashes (never allowed on screen) and newlines. */
    static String clean(String s) {
        if (s == null || "null".equals(s)) return "";
        return s.replace((char) 0x2014, '-').replace('\n', ' ').replace('\r', ' ').trim();
    }

    static int statusColor(String status) {
        if (status == null) return GREY;
        switch (status) {
            case "winning":
            case "won":
                return GREEN;
            case "losing":
            case "lost":
                return RED;
            case "void":
                return AMBER;
            default:
                return GREY;
        }
    }

    static boolean isSettled(String status) {
        return "won".equals(status) || "lost".equals(status) || "void".equals(status);
    }

    /** "+$12.50" or "-$3.20". */
    static String signedMoney(String currency, double v) {
        double r = Math.round(v * 100) / 100.0;
        String sign = r < 0 ? "-" : "+";
        return sign + currency + String.format(Locale.US, "%.2f", Math.abs(r));
    }

    /** "$10" for whole amounts, "$7.50" otherwise. */
    static String stake(String currency, double v) {
        if (Math.abs(v - Math.rint(v)) < 0.005) {
            return currency + String.format(Locale.US, "%.0f", v);
        }
        return currency + String.format(Locale.US, "%.2f", v);
    }

    /** Right-hand text on a bet's title row. */
    static String betSummary(String currency, Bet b) {
        switch (b.status) {
            case "won":
                return "Won " + signedMoney(currency, b.toWin);
            case "lost":
                return "Lost " + signedMoney(currency, -b.stake);
            case "void":
                return "Void " + stake(currency, b.stake);
            default:
                return stake(currency, b.stake) + " @ " + String.format(Locale.US, "%.2f", b.odds);
        }
    }

    String todayText() {
        return "Today " + signedMoney(currency, dayPnl);
    }

    int todayColor() {
        return Math.round(dayPnl * 100) < 0 ? RED : GREEN;
    }
}
