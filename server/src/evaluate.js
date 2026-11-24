// Pure bet evaluation: given a bet and the latest game data, work out every
// leg's label, detail line and status, the bet status, profit and the overlay feed.
// No I/O here, so everything is easy to unit test.

export const SETTLED = new Set(['won', 'lost', 'void']);
export const LABEL_MAX = 28;
export const DETAIL_MAX = 48;
export const DROP_OFF_MS = 30 * 60 * 1000;
export const OVERLAY_MAX = 8;

export const PROP_STATS = {
  nba: {
    points: 'PTS', rebounds: 'REB', assists: 'AST', threes: '3PM', steals: 'STL', blocks: 'BLK',
    pra: 'PRA', pr: 'P+R', pa: 'P+A', ra: 'R+A',
  },
  nfl: {
    passingYards: 'Pass Yds', passingTDs: 'Pass TD', rushingYards: 'Rush Yds', receivingYards: 'Rec Yds',
    receptions: 'Rec', rushRecYards: 'Rush+Rec', anytimeTD: 'Anytime TD',
  },
};

export function isSettled(status) {
  return SETTLED.has(status);
}

export function fmtNum(n) {
  const r = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function fmtLine(n) {
  if (Number(n) === 0) return '+0';
  return Number(n) > 0 ? `+${fmtNum(n)}` : fmtNum(n);
}

export function truncate(s, max) {
  s = String(s);
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`;
}

// ---------- names ----------

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

export function normaliseName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join(' ');
}

export function findPlayer(players, name) {
  if (!players || !name) return null;
  const target = normaliseName(name);
  if (!target) return null;
  const exact = players.filter((p) => normaliseName(p.name) === target);
  if (exact.length >= 1) return exact[0];
  const tokens = target.split(' ');
  const last = tokens[tokens.length - 1];
  const initial = tokens.length > 1 ? tokens[0][0] : null;
  const loose = players.filter((p) => {
    const t = normaliseName(p.name).split(' ');
    if (t[t.length - 1] !== last) return false;
    return initial ? t[0][0] === initial : true;
  });
  return loose.length === 1 ? loose[0] : null;
}

function lastName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter((t) => !SUFFIXES.has(normaliseName(t)));
  return parts.length ? parts[parts.length - 1] : String(name || '');
}

// ---------- labels and detail prefix ----------

function compactGame(label) {
  return String(label || '').replace(/\s*@\s*/, '@');
}

export function legLabel(leg) {
  let s;
  switch (leg.market) {
    case 'h2h': s = `${leg.team} to win`; break;
    case 'line': s = `${leg.team} ${fmtLine(leg.line)}`; break;
    case 'total': s = `${leg.side === 'under' ? 'Under' : 'Over'} ${fmtNum(leg.line)} ${compactGame(leg.gameLabel)}`; break;
    case 'prop': {
      const who = lastName(leg.player);
      if (leg.stat === 'anytimeTD') s = `${who} anytime TD`;
      else {
        const short = PROP_STATS[leg.sport]?.[leg.stat] || leg.stat;
        s = `${who} ${leg.side === 'under' ? 'u' : 'o'}${fmtNum(leg.line)} ${short}`;
      }
      break;
    }
    default: s = String(leg.market);
  }
  return truncate(s, LABEL_MAX);
}

function periodName(sport, period) {
  if (period <= 4) return `Q${period}`;
  const ot = period - 4;
  return ot === 1 ? 'OT' : `${ot}OT`;
}

export function clockText(game) {
  if (game.state === 'post') return 'FINAL';
  if (game.state !== 'in') return '';
  const name = game.statusName || '';
  if (/HALFTIME/.test(name)) return 'HALF';
  if (/END_PERIOD/.test(name)) return `End ${periodName(game.sport, game.period)}`;
  const clock = game.clock ? ` ${game.clock}` : '';
  return `${periodName(game.sport, game.period)}${clock}`;
}

export function scorePrefix(game) {
  return `${game.away.abbr} ${game.away.score}-${game.home.score} ${game.home.abbr} ${clockText(game)}`.trim();
}

export function startText(startIso, now) {
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return 'Not started';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const time = `${h}:${m}${ampm}`;
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `Starts ${time}`;
  const day = d.toLocaleDateString('en-AU', { weekday: 'short' });
  return `Starts ${day} ${time}`;
}

function result(leg, status, detail) {
  return { label: legLabel(leg), detail: truncate(detail, DETAIL_MAX), status };
}

function withScore(game, text) {
  return `${scorePrefix(game)} | ${text}`;
}

// ---------- leg evaluation ----------

export function evaluateLeg(leg, game, now = Date.now()) {
  if (!game) return result(leg, 'pending', leg.gameStart ? startText(leg.gameStart, now) : 'Waiting for game data');
  if (/POSTPONED|CANCELED|CANCELLED|SUSPENDED/.test(game.statusName || '')) {
    return result(leg, 'pending', `${leg.gameLabel || game.label} postponed, settle manually`);
  }
  if (game.state === 'pre') return result(leg, 'pending', startText(game.start || leg.gameStart, now));

  const post = game.state === 'post';
  switch (leg.market) {
    case 'h2h': return evalH2h(leg, game, post);
    case 'line': return evalLine(leg, game, post);
    case 'total': return evalTotal(leg, game, post);
    case 'prop': return evalProp(leg, game, post);
    default: return result(leg, 'pending', `Unknown market ${leg.market}`);
  }
}

function sides(leg, game) {
  const team = String(leg.team || '').toUpperCase();
  if (game.home.abbr === team) return { mine: game.home.score, opp: game.away.score };
  if (game.away.abbr === team) return { mine: game.away.score, opp: game.home.score };
  return null;
}

function evalH2h(leg, game, post) {
  const s = sides(leg, game);
  if (!s) return result(leg, 'pending', withScore(game, `team ${leg.team} not in game`));
  const diff = s.mine - s.opp;
  if (post) {
    if (diff > 0) return result(leg, 'won', withScore(game, `won by ${diff}`));
    if (diff < 0) return result(leg, 'lost', withScore(game, `lost by ${-diff}`));
    return result(leg, 'void', withScore(game, 'tie'));
  }
  if (diff > 0) return result(leg, 'winning', withScore(game, `leading by ${diff}`));
  if (diff < 0) return result(leg, 'losing', withScore(game, `trailing by ${-diff}`));
  return result(leg, 'pending', withScore(game, 'tied'));
}

function evalLine(leg, game, post) {
  const s = sides(leg, game);
  if (!s) return result(leg, 'pending', withScore(game, `team ${leg.team} not in game`));
  const margin = s.mine + Number(leg.line) - s.opp;
  if (post) {
    if (margin > 0) return result(leg, 'won', withScore(game, `covered by ${fmtNum(margin)}`));
    if (margin < 0) return result(leg, 'lost', withScore(game, `missed by ${fmtNum(-margin)}`));
    return result(leg, 'void', withScore(game, 'push'));
  }
  if (margin > 0) return result(leg, 'winning', withScore(game, `covering by ${fmtNum(margin)}`));
  if (margin < 0) return result(leg, 'losing', withScore(game, `needs ${fmtNum(-margin)}`));
  return result(leg, 'pending', withScore(game, 'on the line'));
}

// Smallest whole number of extra points/units needed to go over `line`.
function neededToBeat(line, current) {
  return Math.floor(Number(line)) + 1 - current;
}

function evalTotal(leg, game, post) {
  const total = game.home.score + game.away.score;
  const line = Number(leg.line);
  const lineTxt = fmtNum(line);
  if (leg.side === 'under') {
    if (total > line) return result(leg, 'lost', withScore(game, `${total}, over ${lineTxt}`));
    if (post) {
      if (total === line) return result(leg, 'void', withScore(game, `${total}, push`));
      return result(leg, 'won', withScore(game, `${total}, under ${lineTxt}`));
    }
    if (total === line) return result(leg, 'pending', withScore(game, `${total}, on the line`));
    return result(leg, 'winning', withScore(game, `${total}, ${fmtNum(line - total)} to spare`));
  }
  if (total > line) return result(leg, 'won', withScore(game, `${total}, over ${lineTxt}`));
  if (post) {
    if (total === line) return result(leg, 'void', withScore(game, `${total}, push`));
    return result(leg, 'lost', withScore(game, `${total}, under ${lineTxt}`));
  }
  return result(leg, 'pending', withScore(game, `${total}, needs ${neededToBeat(line, total)} more`));
}

function evalProp(leg, game, post) {
  const isTd = leg.stat === 'anytimeTD';
  const line = isTd ? 0.5 : Number(leg.line);
  const side = isTd ? 'over' : leg.side;
  const players = game.players;
  if (!players) return result(leg, 'pending', withScore(game, 'waiting for stats'));
  const p = findPlayer(players, leg.player);
  if (!p) {
    // NFL box scores leave out players with no stats, so a missing player at
    // full time most likely did not play. NBA box scores list everyone.
    if (post && game.sport === 'nfl') return result(leg, 'void', withScore(game, `${lastName(leg.player)} no stats (DNP)`));
    return result(leg, 'pending', withScore(game, 'player not found'));
  }
  if (p.dnp || !p.stats) {
    if (post) return result(leg, 'void', withScore(game, `${lastName(p.name)} DNP`));
    return result(leg, 'pending', withScore(game, `${lastName(p.name)} no stats yet`));
  }
  const v = Number(p.stats[leg.stat] ?? 0);
  const of = isTd ? `${v} TD${v === 1 ? '' : 's'}` : `${fmtNum(v)} of ${fmtNum(line)}`;
  if (side === 'under') {
    if (v > line) return result(leg, 'lost', withScore(game, of));
    if (post) return result(leg, v === line ? 'void' : 'won', withScore(game, v === line ? `${of}, push` : of));
    return result(leg, 'winning', withScore(game, of));
  }
  if (v > line) return result(leg, 'won', withScore(game, of));
  if (post) return result(leg, v === line ? 'void' : 'lost', withScore(game, v === line ? `${of}, push` : of));
  return result(leg, 'pending', withScore(game, isTd ? `${of} yet` : `${of}, needs ${fmtNum(neededToBeat(line, v))}`));
}

// ---------- bet level ----------

export function combineStatus(type, legStatuses) {
  if (type === 'single' || legStatuses.length === 1) return legStatuses[0] || 'pending';
  if (legStatuses.includes('lost')) return 'lost';
  const live = legStatuses.filter((s) => s !== 'void');
  if (live.length === 0) return 'void';
  if (live.every((s) => s === 'won')) return 'won';
  if (live.includes('losing')) return 'losing';
  if (live.every((s) => s === 'won' || s === 'winning') && live.includes('winning')) return 'winning';
  return 'pending';
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function toWin(bet) {
  return round2(bet.stake * bet.odds - bet.stake);
}

export function profit(status, bet) {
  if (status === 'won') return toWin(bet);
  if (status === 'lost') return -round2(bet.stake);
  return 0;
}

export function betTitle(bet) {
  if (bet.type === 'multi' && bet.legs.length > 1) return `Multi (${bet.legs.length} legs)`;
  return legLabel(bet.legs[0]);
}

// games: Map keyed by `${sport}:${gameId}`
export function gameKey(sport, id) {
  return `${sport}:${id}`;
}

// Full computed view of one bet. Uses the stored settlement snapshot when present.
export function viewBet(bet, games, now = Date.now()) {
  const legs = bet.result?.legs
    ? bet.legs.map((leg, i) => ({ ...leg, ...bet.result.legs[i] }))
    : bet.legs.map((leg) => ({ ...leg, ...evaluateLeg(leg, games.get(gameKey(leg.sport, leg.gameId)), now) }));
  const computed = bet.result?.status || combineStatus(bet.type, legs.map((l) => l.status));
  const status = bet.manual?.status || computed;
  const settled = isSettled(status);
  let settledAt = null;
  if (bet.manual) settledAt = bet.manual.at;
  else if (bet.result) settledAt = bet.result.at;
  return {
    id: bet.id,
    createdAt: bet.createdAt,
    type: bet.type,
    stake: bet.stake,
    odds: bet.odds,
    title: betTitle(bet),
    toWin: toWin(bet),
    status,
    computedStatus: computed,
    manual: bet.manual || null,
    settled,
    settledAt,
    profit: settled ? profit(status, bet) : 0,
    legs,
  };
}

export function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function dayPnl(views, now = Date.now()) {
  let sum = 0;
  for (const v of views) if (v.settled && v.settledAt && sameLocalDay(v.settledAt, now)) sum += v.profit;
  return round2(sum);
}

export function overlay(views, now = Date.now()) {
  const visible = views
    .filter((v) => !v.settled || (v.settledAt && now - Date.parse(v.settledAt) <= DROP_OFF_MS))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, OVERLAY_MAX);
  return {
    updatedAt: new Date(now).toISOString(),
    dayPnl: dayPnl(views, now),
    currency: '$',
    bets: visible.map((v) => ({
      id: v.id,
      title: truncate(v.title, LABEL_MAX),
      stake: v.stake,
      odds: v.odds,
      toWin: v.toWin,
      status: v.status,
      legs: v.legs.map((l) => ({ label: l.label, detail: l.detail, status: l.status })),
    })),
  };
}
