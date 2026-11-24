// Shared test helpers.
export function game({
  sport = 'nba', state = 'in', away = ['LAL', 88], home = ['SAC', 80],
  period = 3, clock = '5:12', statusName = 'STATUS_IN_PROGRESS', players, start = '2026-11-24T03:00:00.000Z', id = '1',
} = {}) {
  return {
    sport, id, start, state, statusName, period, clock,
    label: `${away[0]} @ ${home[0]}`,
    away: { abbr: away[0], score: away[1], name: away[0], short: away[0] },
    home: { abbr: home[0], score: home[1], name: home[0], short: home[0] },
    players,
  };
}

export function leg(over = {}) {
  return {
    sport: 'nba', gameId: '1', gameLabel: 'LAL @ SAC', gameStart: '2026-11-24T03:00:00.000Z',
    market: 'h2h', team: 'LAL', ...over,
  };
}

export function nbaPlayer(name, s = {}, extra = {}) {
  const stats = { points: 0, rebounds: 0, assists: 0, threes: 0, steals: 0, blocks: 0, ...s };
  stats.pra = stats.points + stats.rebounds + stats.assists;
  stats.pr = stats.points + stats.rebounds;
  stats.pa = stats.points + stats.assists;
  stats.ra = stats.rebounds + stats.assists;
  return { id: name, name, team: 'LAL', dnp: false, stats, ...extra };
}
