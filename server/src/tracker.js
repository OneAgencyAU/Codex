// Keeps live game data for games that still have unsettled legs, fetching
// politely from ESPN, and records settlement on bets once they are decided.
//
// Polling policy per game:
//   - first sight: one summary fetch (gives status, scores, players)
//   - pre:  re-check via the (cached) scoreboard every 5 minutes, every
//           60 seconds once the start time is close
//   - in:   one summary fetch every 20 seconds while it has unsettled legs
//   - post: stop (the summary that first showed "post" has the final stats)
// Failures are logged and retried on a later cycle; nothing here throws.
import { espnDate } from './espn.js';
import { viewBet, isSettled, gameKey } from './evaluate.js';

export const TICK_MS = 5_000;
const IN_GAME_MS = 20_000;
const PRE_GAME_MS = 5 * 60_000;
const NEAR_START_MS = 60_000;
const RETRY_MS = 30_000;
const FORGET_MS = 12 * 60 * 60_000;

export function createTracker({ store, espn, now = () => Date.now(), log = console }) {
  const games = new Map(); // key -> parsed game
  const meta = new Map(); // key -> { lastSummary, nextCheck, retryAt, touched }
  let running = false;
  let timer = null;

  function views() {
    const t = now();
    return store.all().map((b) => viewBet(b, games, t));
  }

  // Record settlement for bets that have just become decided.
  function settle() {
    const t = now();
    let changed = false;
    for (const bet of store.all()) {
      if (bet.result || bet.manual) continue;
      const v = viewBet(bet, games, t);
      if (isSettled(v.computedStatus)) {
        bet.result = {
          status: v.computedStatus,
          at: new Date(t).toISOString(),
          legs: v.legs.map((l) => ({ label: l.label, detail: l.detail, status: l.status })),
        };
        changed = true;
        log.info?.(`[tracker] bet ${bet.id} settled ${v.computedStatus}`);
      }
    }
    if (changed) store.save();
  }

  // Games that still have at least one undecided leg on an undecided bet.
  function neededGames() {
    const t = now();
    const out = new Map();
    for (const bet of store.all()) {
      if (bet.result || bet.manual) continue;
      const v = viewBet(bet, games, t);
      v.legs.forEach((leg) => {
        if (isSettled(leg.status)) return;
        const key = gameKey(leg.sport, leg.gameId);
        if (!out.has(key)) out.set(key, { key, sport: leg.sport, id: leg.gameId, gameStart: leg.gameStart });
      });
    }
    return [...out.values()];
  }

  async function fetchSummary(need, m) {
    const g = await espn.summary(need.sport, need.id);
    games.set(need.key, g);
    m.lastSummary = now();
    return g;
  }

  async function refresh(need) {
    const t = now();
    const m = meta.get(need.key) || {};
    meta.set(need.key, m);
    m.touched = t;
    if (m.retryAt && t < m.retryAt) return;
    try {
      let g = games.get(need.key);
      if (!g) {
        g = await fetchSummary(need, m);
        m.nextCheck = t + PRE_GAME_MS;
        return;
      }
      if (g.state === 'pre') {
        const start = Date.parse(g.start || need.gameStart);
        if (m.nextCheck && t < m.nextCheck) return;
        const list = await espn.scoreboard(need.sport, espnDate(new Date(start || t)));
        const ev = list.find((e) => e.id === String(need.id));
        if (!ev) {
          await fetchSummary(need, m);
        } else if (ev.state !== 'pre') {
          await fetchSummary(need, m);
        } else {
          games.set(need.key, { ...ev, players: g.players });
        }
        const startNow = Date.parse(games.get(need.key).start || need.gameStart);
        m.nextCheck = now() + (now() >= startNow - 2 * 60_000 ? NEAR_START_MS : PRE_GAME_MS);
        return;
      }
      if (g.state === 'in') {
        if (!m.lastSummary || t - m.lastSummary >= IN_GAME_MS) await fetchSummary(need, m);
      }
      // post: the summary that reported "post" already has the final box score.
    } catch (err) {
      m.retryAt = now() + RETRY_MS;
      log.warn?.(`[tracker] ${need.key} refresh failed, retrying later: ${err.message}`);
    }
  }

  function forgetOld() {
    const t = now();
    for (const [key, m] of meta) {
      if (t - (m.touched || 0) > FORGET_MS) {
        meta.delete(key);
        games.delete(key);
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      settle();
      await Promise.all(neededGames().map(refresh));
      settle();
      forgetOld();
    } catch (err) {
      log.error?.(`[tracker] tick failed: ${err.stack || err.message}`);
    } finally {
      running = false;
    }
  }

  return {
    games,
    views,
    settle,
    tick,
    neededGames,
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
