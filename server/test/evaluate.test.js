process.env.TZ = 'Australia/Sydney';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLeg, combineStatus, profit, toWin, viewBet, dayPnl, overlay, normaliseName, findPlayer,
  legLabel, startText, clockText, LABEL_MAX, DETAIL_MAX, DROP_OFF_MS, gameKey,
} from '../src/evaluate.js';
import { game, leg, nbaPlayer } from './helpers.js';

const NOW = Date.parse('2026-11-24T04:00:00.000Z'); // 3pm Sydney

describe('pre game', () => {
  test('every market is pending with a start time in server local time', () => {
    const g = game({ state: 'pre', start: '2026-11-24T00:30:00.000Z', away: ['LAL', 0], home: ['SAC', 0] });
    for (const l of [leg(), leg({ market: 'line', line: -4.5 }), leg({ market: 'total', line: 220.5, side: 'over' }),
      leg({ market: 'prop', player: 'LeBron James', stat: 'points', line: 24.5, side: 'over' })]) {
      const r = evaluateLeg(l, g, NOW);
      assert.equal(r.status, 'pending');
      assert.equal(r.detail, 'Starts 11:30am');
    }
  });
  test('start on another day shows the weekday', () => {
    const r = evaluateLeg(leg(), game({ state: 'pre', start: '2026-11-26T09:00:00.000Z' }), NOW);
    assert.equal(r.detail, 'Starts Thu 8:00pm');
  });
  test('no game data yet falls back to the leg start time', () => {
    const r = evaluateLeg(leg({ gameStart: '2026-11-24T08:15:00.000Z' }), undefined, NOW);
    assert.equal(r.status, 'pending');
    assert.equal(r.detail, 'Starts 7:15pm');
  });
  test('postponed game stays pending with a note', () => {
    const r = evaluateLeg(leg(), game({ state: 'post', statusName: 'STATUS_POSTPONED' }), NOW);
    assert.equal(r.status, 'pending');
    assert.match(r.detail, /postponed/);
  });
});

describe('head to head', () => {
  test('in game leading, trailing, tied', () => {
    assert.deepEqual(evaluateLeg(leg(), game(), NOW), { label: 'LAL to win', detail: 'LAL 88-80 SAC Q3 5:12 | leading by 8', status: 'winning' });
    assert.equal(evaluateLeg(leg({ team: 'SAC' }), game(), NOW).status, 'losing');
    assert.equal(evaluateLeg(leg({ team: 'SAC' }), game(), NOW).detail, 'LAL 88-80 SAC Q3 5:12 | trailing by 8');
    assert.equal(evaluateLeg(leg(), game({ home: ['SAC', 88] }), NOW).status, 'pending');
  });
  test('post won, lost, tie void', () => {
    const fin = game({ state: 'post', statusName: 'STATUS_FINAL' });
    const won = evaluateLeg(leg(), fin, NOW);
    assert.equal(won.status, 'won');
    assert.equal(won.detail, 'LAL 88-80 SAC FINAL | won by 8');
    assert.equal(evaluateLeg(leg({ team: 'SAC' }), fin, NOW).status, 'lost');
    assert.equal(evaluateLeg(leg(), game({ state: 'post', home: ['SAC', 88] }), NOW).status, 'void');
  });
  test('team not in game stays pending', () => {
    assert.equal(evaluateLeg(leg({ team: 'BOS' }), game(), NOW).status, 'pending');
  });
});

describe('line', () => {
  test('in game covering, needs, exactly on', () => {
    const r = evaluateLeg(leg({ market: 'line', line: -4.5 }), game(), NOW);
    assert.equal(r.status, 'winning');
    assert.equal(r.detail, 'LAL 88-80 SAC Q3 5:12 | covering by 3.5');
    assert.equal(r.label, 'LAL -4.5');
    const n = evaluateLeg(leg({ market: 'line', line: -10.5 }), game(), NOW);
    assert.equal(n.status, 'losing');
    assert.equal(n.detail, 'LAL 88-80 SAC Q3 5:12 | needs 2.5');
    assert.equal(evaluateLeg(leg({ market: 'line', line: -8 }), game(), NOW).status, 'pending');
    const dog = evaluateLeg(leg({ market: 'line', team: 'SAC', line: 7.5 }), game(), NOW);
    assert.equal(dog.status, 'losing');
    assert.equal(dog.label, 'SAC +7.5');
  });
  test('post won, lost, push void', () => {
    const fin = (h) => game({ state: 'post', home: ['SAC', h] });
    assert.equal(evaluateLeg(leg({ market: 'line', line: -4.5 }), fin(80), NOW).status, 'won');
    assert.equal(evaluateLeg(leg({ market: 'line', line: -4.5 }), fin(85), NOW).status, 'lost');
    assert.equal(evaluateLeg(leg({ market: 'line', line: -4 }), fin(84), NOW).status, 'void');
    assert.equal(evaluateLeg(leg({ market: 'line', team: 'SAC', line: 10 }), fin(80), NOW).status, 'won');
  });
});

describe('total', () => {
  const over = (line) => leg({ market: 'total', line, side: 'over' });
  const under = (line) => leg({ market: 'total', line, side: 'under' });
  test('over in game pending with needs, won as soon as total passes the line', () => {
    const r = evaluateLeg(over(220.5), game(), NOW);
    assert.equal(r.status, 'pending');
    assert.equal(r.detail, 'LAL 88-80 SAC Q3 5:12 | 168, needs 53 more');
    assert.equal(r.label, 'Over 220.5 LAL@SAC');
    assert.equal(evaluateLeg(over(160.5), game(), NOW).status, 'won');
    assert.equal(evaluateLeg(over(168), game(), NOW).status, 'pending');
  });
  test('over post lost, push void', () => {
    assert.equal(evaluateLeg(over(220.5), game({ state: 'post' }), NOW).status, 'lost');
    assert.equal(evaluateLeg(over(168), game({ state: 'post' }), NOW).status, 'void');
    assert.equal(evaluateLeg(over(150.5), game({ state: 'post' }), NOW).status, 'won');
  });
  test('under in game winning with spare, lost as soon as total passes', () => {
    const r = evaluateLeg(under(220.5), game(), NOW);
    assert.equal(r.status, 'winning');
    assert.equal(r.detail, 'LAL 88-80 SAC Q3 5:12 | 168, 52.5 to spare');
    assert.equal(evaluateLeg(under(160.5), game(), NOW).status, 'lost');
    assert.equal(evaluateLeg(under(168), game(), NOW).status, 'pending');
  });
  test('under post won, push void, lost', () => {
    assert.equal(evaluateLeg(under(220.5), game({ state: 'post' }), NOW).status, 'won');
    assert.equal(evaluateLeg(under(168), game({ state: 'post' }), NOW).status, 'void');
    assert.equal(evaluateLeg(under(150.5), game({ state: 'post' }), NOW).status, 'lost');
  });
});

describe('player props', () => {
  const players = [nbaPlayer('LeBron James', { points: 18, rebounds: 7, assists: 9, threes: 2 }),
    nbaPlayer('Kelly Oubre Jr.', { points: 20 }), nbaPlayer('Luka Dončić', { points: 31 }),
    nbaPlayer('Injured Guy', {}, { dnp: true, stats: null })];
  const g = (state = 'in') => game({ state, players });
  const prop = (o) => leg({ market: 'prop', player: 'LeBron James', stat: 'points', line: 24.5, side: 'over', ...o });

  test('over in game pending with how many needed', () => {
    const r = evaluateLeg(prop(), g(), NOW);
    assert.equal(r.status, 'pending');
    assert.equal(r.detail, 'LAL 88-80 SAC Q3 5:12 | 18 of 24.5, needs 7');
    assert.equal(r.label, 'James o24.5 PTS');
  });
  test('over won as soon as it passes the line, even in game', () => {
    assert.equal(evaluateLeg(prop({ line: 17.5 }), g(), NOW).status, 'won');
  });
  test('over post lost, push void', () => {
    assert.equal(evaluateLeg(prop(), g('post'), NOW).status, 'lost');
    assert.equal(evaluateLeg(prop({ line: 18 }), g('post'), NOW).status, 'void');
  });
  test('under in game winning, lost once passed, post won', () => {
    const r = evaluateLeg(prop({ side: 'under' }), g(), NOW);
    assert.equal(r.status, 'winning');
    assert.equal(r.detail, 'LAL 88-80 SAC Q3 5:12 | 18 of 24.5');
    assert.equal(evaluateLeg(prop({ side: 'under', line: 15.5 }), g(), NOW).status, 'lost');
    assert.equal(evaluateLeg(prop({ side: 'under' }), g('post'), NOW).status, 'won');
    assert.equal(r.label, 'James u24.5 PTS');
  });
  test('combo stats', () => {
    assert.equal(evaluateLeg(prop({ stat: 'pra', line: 33.5 }), g(), NOW).status, 'won');
    assert.equal(evaluateLeg(prop({ stat: 'pra', line: 34.5 }), g(), NOW).detail, 'LAL 88-80 SAC Q3 5:12 | 34 of 34.5, needs 1');
    assert.equal(evaluateLeg(prop({ stat: 'ra', line: 15.5 }), g(), NOW).status, 'won');
    assert.equal(evaluateLeg(prop({ stat: 'threes', line: 2.5, side: 'under' }), g(), NOW).status, 'winning');
  });
  test('DNP at post is void, in game pending', () => {
    assert.equal(evaluateLeg(prop({ player: 'Injured Guy' }), g('post'), NOW).status, 'void');
    assert.equal(evaluateLeg(prop({ player: 'Injured Guy' }), g('in'), NOW).status, 'pending');
  });
  test('player not found stays pending with a clear detail', () => {
    const r = evaluateLeg(prop({ player: 'Nobody Here' }), g(), NOW);
    assert.equal(r.status, 'pending');
    assert.match(r.detail, /player not found/);
    assert.equal(evaluateLeg(prop({ player: 'Nobody Here' }), g('post'), NOW).status, 'pending');
  });
  test('NFL player missing from the final box score is void (no stats)', () => {
    const nfl = game({ sport: 'nfl', state: 'post', players: [] });
    const r = evaluateLeg(leg({ sport: 'nfl', market: 'prop', player: 'Some Guy', stat: 'rushingYards', line: 50.5, side: 'over' }), nfl, NOW);
    assert.equal(r.status, 'void');
  });
  test('waiting for stats when only scoreboard data is known', () => {
    assert.match(evaluateLeg(prop(), game({ players: undefined }), NOW).detail, /waiting for stats/);
  });
  test('NFL anytime TD is over 0.5 of rushing plus receiving TDs', () => {
    const p = (r, c) => ({ id: 'x', name: 'Saquon Barkley', team: 'PHI', dnp: false, stats: { anytimeTD: r + c, rushingTDs: r, receivingTDs: c } });
    const l = leg({ sport: 'nfl', market: 'prop', player: 'Saquon Barkley', stat: 'anytimeTD' });
    assert.equal(evaluateLeg(l, game({ sport: 'nfl', players: [p(0, 0)] }), NOW).status, 'pending');
    assert.equal(evaluateLeg(l, game({ sport: 'nfl', players: [p(0, 1)] }), NOW).status, 'won');
    assert.equal(evaluateLeg(l, game({ sport: 'nfl', state: 'post', players: [p(0, 0)] }), NOW).status, 'lost');
    assert.equal(legLabel(l), 'Barkley anytime TD');
  });
});

describe('names', () => {
  test('normalise strips accents, punctuation and suffixes', () => {
    assert.equal(normaliseName('Luka Dončić'), 'luka doncic');
    assert.equal(normaliseName('Kelly Oubre Jr.'), 'kelly oubre');
    assert.equal(normaliseName('T.J. McConnell'), 'tj mcconnell');
    assert.equal(normaliseName("De'Aaron Fox III"), 'deaaron fox');
    assert.equal(normaliseName('Shai Gilgeous-Alexander'), 'shai gilgeous alexander');
  });
  test('exact, then last name plus first initial', () => {
    const players = [nbaPlayer('Luka Dončić'), nbaPlayer('Kelly Oubre Jr.'), nbaPlayer('Jalen Williams'), nbaPlayer('Jaylin Williams'), nbaPlayer('Kenrich Williams')];
    assert.equal(findPlayer(players, 'luka doncic').name, 'Luka Dončić');
    assert.equal(findPlayer(players, 'Kelly Oubre').name, 'Kelly Oubre Jr.');
    assert.equal(findPlayer(players, 'K. Oubre Jr').name, 'Kelly Oubre Jr.');
    assert.equal(findPlayer(players, 'K Williams').name, 'Kenrich Williams');
    assert.equal(findPlayer(players, 'J Williams'), null); // ambiguous
    assert.equal(findPlayer(players, 'Nobody'), null);
  });
});

describe('format limits', () => {
  test('labels <= 28 and details <= 48 characters', () => {
    const long = game({ away: ['UTAH', 123], home: ['WSH', 119], period: 6, clock: '10:00', players: [nbaPlayer('Shai Gilgeous-Alexander', { points: 3 })] });
    const l = leg({ gameLabel: 'UTAH @ WSH', market: 'prop', player: 'Shai Gilgeous-Alexander', stat: 'pra', line: 129.5, side: 'over' });
    const r = evaluateLeg(l, long, NOW);
    assert.ok(r.label.length <= LABEL_MAX, r.label);
    assert.ok(r.detail.length <= DETAIL_MAX, r.detail);
    assert.ok(r.detail.startsWith('UTAH 123-119 WSH 2OT 10:00 | '));
  });
  test('clock text for NFL, halftime, end of period and final', () => {
    assert.equal(clockText(game({ sport: 'nfl', period: 2, clock: '3:01' })), 'Q2 3:01');
    assert.equal(clockText(game({ statusName: 'STATUS_HALFTIME', period: 2 })), 'HALF');
    assert.equal(clockText(game({ statusName: 'STATUS_END_PERIOD', period: 3, clock: '0.0' })), 'End Q3');
    assert.equal(clockText(game({ period: 5 })), 'OT 5:12');
    assert.equal(clockText(game({ state: 'post' })), 'FINAL');
  });
  test('start text', () => {
    assert.equal(startText('2026-11-24T00:30:00.000Z', NOW), 'Starts 11:30am');
    assert.equal(startText('2026-11-24T02:05:00.000Z', NOW), 'Starts 1:05pm');
  });
});

describe('bet status', () => {
  test('single takes its leg status', () => {
    for (const s of ['pending', 'winning', 'losing', 'won', 'lost', 'void']) assert.equal(combineStatus('single', [s]), s);
  });
  test('multi rules', () => {
    assert.equal(combineStatus('multi', ['won', 'lost', 'winning']), 'lost');
    assert.equal(combineStatus('multi', ['won', 'won']), 'won');
    assert.equal(combineStatus('multi', ['won', 'void']), 'won');
    assert.equal(combineStatus('multi', ['void', 'void']), 'void');
    assert.equal(combineStatus('multi', ['winning', 'losing', 'won']), 'losing');
    assert.equal(combineStatus('multi', ['winning', 'won']), 'winning');
    assert.equal(combineStatus('multi', ['winning', 'void', 'winning']), 'winning');
    assert.equal(combineStatus('multi', ['winning', 'pending']), 'pending');
    assert.equal(combineStatus('multi', ['won', 'pending']), 'pending');
    assert.equal(combineStatus('multi', ['pending', 'pending']), 'pending');
  });
  test('manual override wins over computed', () => {
    const games = new Map([[gameKey('nba', '1'), game()]]);
    const bet = { id: 'b1', createdAt: new Date(NOW).toISOString(), type: 'single', stake: 10, odds: 1.9, legs: [leg()], manual: { status: 'lost', at: new Date(NOW).toISOString() } };
    const v = viewBet(bet, games, NOW);
    assert.equal(v.computedStatus, 'winning');
    assert.equal(v.status, 'lost');
    assert.equal(v.profit, -10);
  });
});

describe('profit and P&L', () => {
  const bet = { stake: 10, odds: 6.2 };
  test('profit per status', () => {
    assert.equal(toWin(bet), 52);
    assert.equal(profit('won', bet), 52);
    assert.equal(profit('lost', bet), -10);
    assert.equal(profit('void', bet), 0);
    assert.equal(profit('winning', bet), 0);
    assert.equal(toWin({ stake: 7.5, odds: 1.87 }), 6.53);
  });
  test('dayPnl only counts bets settled on the local today', () => {
    const today = '2026-11-24T02:00:00.000Z'; // 1pm Sydney 24th
    const yesterday = '2026-11-23T10:00:00.000Z'; // 9pm Sydney 23rd
    const earlyToday = '2026-11-23T13:30:00.000Z'; // 00:30 Sydney 24th
    const views = [
      { settled: true, settledAt: today, profit: 52 },
      { settled: true, settledAt: earlyToday, profit: -10 },
      { settled: true, settledAt: yesterday, profit: 100 },
      { settled: false, settledAt: null, profit: 0 },
    ];
    assert.equal(dayPnl(views, NOW), 42);
  });
});

describe('overlay', () => {
  const mkBet = (id, createdMin, result) => ({
    id, createdAt: new Date(NOW - createdMin * 60000).toISOString(), type: 'single', stake: 10, odds: 2, legs: [leg()], result,
  });
  const settledAt = (minAgo) => ({ status: 'won', at: new Date(NOW - minAgo * 60000).toISOString(), legs: [{ label: 'LAL to win', detail: 'LAL 100-90 SAC FINAL | won by 10', status: 'won' }] });
  test('settled bets drop off 30 minutes after settling; newest first; max 8', () => {
    const games = new Map([[gameKey('nba', '1'), game()]]);
    const bets = [
      mkBet('old_settled', 200, settledAt(31)),
      mkBet('fresh_settled', 100, settledAt(29)),
      ...Array.from({ length: 9 }, (_, i) => mkBet(`open${i}`, i)),
    ];
    const views = bets.map((b) => viewBet(b, games, NOW));
    const o = overlay(views, NOW);
    assert.equal(o.bets.length, 8);
    assert.deepEqual(o.bets.map((b) => b.id), ['open0', 'open1', 'open2', 'open3', 'open4', 'open5', 'open6', 'open7']);
    const few = overlay(views.filter((v) => !v.id.startsWith('open') || v.id === 'open0'), NOW);
    assert.deepEqual(few.bets.map((b) => b.id), ['open0', 'fresh_settled']);
    assert.equal(few.dayPnl, 20);
    const later = overlay(views, NOW + DROP_OFF_MS);
    assert.ok(!later.bets.some((b) => b.id === 'fresh_settled'));
  });
  test('contract shape', () => {
    const games = new Map([[gameKey('nba', '1'), game()]]);
    const multi = { id: 'b_m', createdAt: new Date(NOW).toISOString(), type: 'multi', stake: 10, odds: 6.2, legs: [leg(), leg({ market: 'line', line: -4.5 }), leg({ market: 'total', line: 200.5, side: 'under' })] };
    const o = overlay([viewBet(multi, games, NOW)], NOW);
    assert.deepEqual(Object.keys(o), ['updatedAt', 'dayPnl', 'currency', 'bets']);
    assert.equal(o.currency, '$');
    const b = o.bets[0];
    assert.deepEqual(Object.keys(b), ['id', 'title', 'stake', 'odds', 'toWin', 'status', 'legs']);
    assert.equal(b.title, 'Multi (3 legs)');
    assert.equal(b.toWin, 52);
    assert.equal(b.status, 'winning');
    assert.deepEqual(b.legs[1], { label: 'LAL -4.5', detail: 'LAL 88-80 SAC Q3 5:12 | covering by 3.5', status: 'winning' });
    assert.ok(!JSON.stringify(o).includes('—'));
  });
});
