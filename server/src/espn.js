// ESPN unofficial JSON: URL building, polite fetching with a small cache, and
// parsing into the plain game objects that evaluate.js works with.
// All JSON paths here were checked against the real responses in test/fixtures/.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const PATHS = { nba: 'basketball/nba', nfl: 'football/nfl' };
const USER_AGENT = 'Mozilla/5.0 (compatible; TVBetTracker/1.0; personal use)';
const TIMEOUT_MS = 10_000;
const SCOREBOARD_CACHE_MS = 60_000;

export function scoreboardUrl(sport, dates) {
  const base = `${BASE}/${PATHS[sport]}/scoreboard`;
  return dates ? `${base}?dates=${dates}` : base;
}

export function summaryUrl(sport, eventId) {
  return `${BASE}/${PATHS[sport]}/summary?event=${encodeURIComponent(eventId)}`;
}

// ESPN groups games by US Eastern calendar date.
export function espnDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseTeam(c) {
  return {
    abbr: c?.team?.abbreviation || '?',
    name: c?.team?.displayName || c?.team?.abbreviation || '?',
    short: c?.team?.shortDisplayName || c?.team?.name || '',
    location: c?.team?.location || '',
    score: num(c?.score),
  };
}

function parseStatus(status) {
  const type = status?.type || {};
  return {
    state: ['pre', 'in', 'post'].includes(type.state) ? type.state : 'pre',
    statusName: type.name || '',
    completed: !!type.completed,
    period: num(status?.period),
    clock: status?.displayClock || '',
    shortDetail: type.shortDetail || type.detail || '',
  };
}

function parseCompetition(sport, id, date, comp, status) {
  const comps = comp?.competitors || [];
  const home = parseTeam(comps.find((c) => c.homeAway === 'home') || comps[0]);
  const away = parseTeam(comps.find((c) => c.homeAway === 'away') || comps[1]);
  return {
    sport,
    id: String(id),
    start: date ? new Date(date).toISOString() : null,
    label: `${away.abbr} @ ${home.abbr}`,
    home,
    away,
    ...parseStatus(status),
  };
}

// Scoreboard -> array of games (no player stats).
export function parseScoreboard(sport, json) {
  return (json?.events || []).map((e) => {
    const comp = e.competitions?.[0];
    return parseCompetition(sport, e.id, e.date || comp?.date, comp, e.status || comp?.status);
  });
}

// NBA box score: one statistics group per team, columns described by `keys`
// (with `names`/`labels` as a fallback). Values are strings, 3PT is "made-attempted".
const NBA_COLUMNS = {
  points: ['points', 'PTS'],
  rebounds: ['rebounds', 'REB'],
  assists: ['assists', 'AST'],
  threes: ['threePointFieldGoalsMade-threePointFieldGoalsAttempted', '3PT'],
  steals: ['steals', 'STL'],
  blocks: ['blocks', 'BLK'],
};

function columnIndex(group, [key, name]) {
  let i = (group.keys || []).indexOf(key);
  if (i < 0) i = (group.names || []).indexOf(name);
  if (i < 0) i = (group.labels || []).indexOf(name);
  return i;
}

function leadingNumber(v) {
  const m = String(v ?? '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

function parseNbaPlayers(boxscore) {
  const players = [];
  for (const team of boxscore?.players || []) {
    const abbr = team.team?.abbreviation || '';
    for (const group of team.statistics || []) {
      const idx = Object.fromEntries(Object.entries(NBA_COLUMNS).map(([k, spec]) => [k, columnIndex(group, spec)]));
      for (const a of group.athletes || []) {
        const name = a.athlete?.displayName || '';
        const hasStats = Array.isArray(a.stats) && a.stats.length > 0 && !a.didNotPlay;
        let stats = null;
        if (hasStats) {
          stats = {};
          for (const [k, i] of Object.entries(idx)) stats[k] = i >= 0 ? leadingNumber(a.stats[i]) : 0;
          stats.pra = stats.points + stats.rebounds + stats.assists;
          stats.pr = stats.points + stats.rebounds;
          stats.pa = stats.points + stats.assists;
          stats.ra = stats.rebounds + stats.assists;
        }
        players.push({ id: String(a.athlete?.id || name), name, team: abbr, dnp: !hasStats, stats });
      }
    }
  }
  return players;
}

// NFL box score: several groups per team (passing, rushing, receiving, ...),
// each with its own `keys`. A player appears only in groups he recorded stats in.
const NFL_COLUMNS = {
  passing: { passingYards: 'passingYards', passingTDs: 'passingTouchdowns' },
  rushing: { rushingYards: 'rushingYards', rushingTDs: 'rushingTouchdowns' },
  receiving: { receivingYards: 'receivingYards', receptions: 'receptions', receivingTDs: 'receivingTouchdowns' },
};

function parseNflPlayers(boxscore) {
  const byId = new Map();
  for (const team of boxscore?.players || []) {
    const abbr = team.team?.abbreviation || '';
    for (const group of team.statistics || []) {
      const cols = NFL_COLUMNS[group.name];
      if (!cols) continue;
      const keys = group.keys || [];
      for (const a of group.athletes || []) {
        const name = a.athlete?.displayName || '';
        const id = String(a.athlete?.id || name);
        if (!byId.has(id)) {
          byId.set(id, {
            id, name, team: abbr, dnp: false,
            stats: { passingYards: 0, passingTDs: 0, rushingYards: 0, rushingTDs: 0, receivingYards: 0, receptions: 0, receivingTDs: 0 },
          });
        }
        const p = byId.get(id);
        for (const [stat, key] of Object.entries(cols)) {
          const i = keys.indexOf(key);
          if (i >= 0) p.stats[stat] = leadingNumber(a.stats?.[i]);
        }
      }
    }
  }
  const players = [...byId.values()];
  for (const p of players) {
    p.stats.rushRecYards = p.stats.rushingYards + p.stats.receivingYards;
    p.stats.anytimeTD = p.stats.rushingTDs + p.stats.receivingTDs;
  }
  return players;
}

// Summary -> one game with player stats.
export function parseSummary(sport, json) {
  const comp = json?.header?.competitions?.[0];
  const id = json?.header?.id || comp?.id;
  const game = parseCompetition(sport, id, comp?.date, comp, comp?.status);
  game.players = sport === 'nba' ? parseNbaPlayers(json?.boxscore) : parseNflPlayers(json?.boxscore);
  return game;
}

// ---------- fetching ----------

export function createEspnClient({ fetchImpl = globalThis.fetch, log = console, now = () => Date.now() } = {}) {
  const cache = new Map(); // url -> { at, json }

  async function getJson(url) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function cachedJson(url, maxAge) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < maxAge) return hit.json;
    const json = await getJson(url);
    cache.set(url, { at: now(), json });
    // keep the cache small
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return json;
  }

  return {
    async scoreboard(sport, dates) {
      const url = scoreboardUrl(sport, dates);
      try {
        return parseScoreboard(sport, await cachedJson(url, SCOREBOARD_CACHE_MS));
      } catch (err) {
        log.warn?.(`[espn] scoreboard ${sport} ${dates || 'current'} failed: ${err.message}`);
        throw err;
      }
    },
    async summary(sport, eventId) {
      const url = summaryUrl(sport, eventId);
      try {
        return parseSummary(sport, await getJson(url));
      } catch (err) {
        log.warn?.(`[espn] summary ${sport} ${eventId} failed: ${err.message}`);
        throw err;
      }
    },
  };
}
