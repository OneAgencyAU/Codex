// Upcoming and live games for the bet entry form and screenshot matching.
import { espnDate } from './espn.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function listGames(espn, sport, now = Date.now()) {
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(espnDate(new Date(now + i * DAY_MS)));
  const unique = [...new Set(dates)];
  // One scoreboard per ESPN day (date ranges are rejected by ESPN). NFL also
  // gets the current week scoreboard, which needs no date.
  const requests = unique.map((d) => espn.scoreboard(sport, d));
  if (sport === 'nfl') requests.push(espn.scoreboard('nfl'));
  const settled = await Promise.allSettled(requests);
  const ok = settled.filter((r) => r.status === 'fulfilled');
  if (ok.length === 0) throw new Error(`Could not load ${sport.toUpperCase()} games from ESPN`);
  const byId = new Map();
  for (const r of ok) for (const g of r.value) byId.set(g.id, g);
  return [...byId.values()]
    .filter((g) => g.state === 'pre' || g.state === 'in')
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((g) => ({
      id: g.id,
      label: g.label,
      start: g.start,
      state: g.state,
      home: { abbr: g.home.abbr, name: g.home.name, short: g.home.short },
      away: { abbr: g.away.abbr, name: g.away.name, short: g.away.short },
    }));
}
