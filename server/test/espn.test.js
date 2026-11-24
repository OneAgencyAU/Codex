process.env.TZ = 'Australia/Sydney';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScoreboard, parseSummary, espnDate, scoreboardUrl, summaryUrl, createEspnClient } from '../src/espn.js';
import { evaluateLeg, findPlayer } from '../src/evaluate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', n), 'utf8'));

describe('scoreboard fixtures', () => {
  test('NBA today: scheduled games', () => {
    const games = parseScoreboard('nba', fixture('nba_sb.json'));
    assert.equal(games.length, 3);
    const g = games.find((x) => x.id === '401909314');
    assert.equal(g.label, 'DET @ ORL');
    assert.equal(g.state, 'pre');
    assert.equal(g.start, '2026-11-25T00:00:00.000Z');
    assert.equal(g.home.abbr, 'ORL');
    assert.equal(g.home.name, 'Orlando Magic');
    assert.equal(g.away.short, 'Pistons');
  });
  test('NBA yesterday: finals with scores, OT period', () => {
    const games = parseScoreboard('nba', fixture('nba_sb_y.json'));
    assert.equal(games.length, 10);
    const okc = games.find((x) => x.id === '401910038');
    assert.equal(okc.state, 'post');
    assert.equal(okc.label, 'OKC @ IND');
    assert.equal(okc.home.score, 125);
    assert.equal(okc.away.score, 120);
    const ot = games.find((x) => x.id === '401910042');
    assert.equal(ot.period, 5);
    assert.equal(ot.away.abbr, 'PHX');
    assert.equal(ot.away.score, 123);
    assert.equal(ot.home.score, 119);
  });
  test('NFL current week, including a neutral site game', () => {
    const games = parseScoreboard('nfl', fixture('nfl_sb.json'));
    assert.equal(games.length, 13);
    const phi = games.find((x) => x.id === '401873076');
    assert.equal(phi.label, 'PIT @ PHI');
    assert.equal(phi.state, 'post');
    assert.equal(phi.home.score, 19);
    assert.equal(phi.away.score, 16);
    const sf = games.find((x) => x.id === '401873077');
    assert.equal(sf.label, 'MIN @ SF');
    assert.equal(sf.home.score, 35);
  });
});

describe('NBA summary fixture', () => {
  const g = parseSummary('nba', fixture('nba_sum.json'));
  test('header status and scores', () => {
    assert.equal(g.id, '401910038');
    assert.equal(g.state, 'post');
    assert.equal(g.home.abbr, 'IND');
    assert.equal(g.home.score, 125);
    assert.equal(g.away.score, 120);
  });
  test('real player stats are read by key, not position', () => {
    const sga = findPlayer(g.players, 'Shai Gilgeous-Alexander');
    // MIN 38, PTS 38, FG 13-30, 3PT 4-10, FT 8-10, REB 5, AST 7, TO 2, STL 0, BLK 1
    assert.deepEqual(
      { ...sga.stats },
      { points: 38, rebounds: 5, assists: 7, threes: 4, steals: 0, blocks: 1, pra: 50, pr: 43, pa: 45, ra: 12 },
    );
    assert.equal(sga.team, 'OKC');
    const slawson = findPlayer(g.players, 'Jalen Slawson');
    assert.equal(slawson.stats.blocks, 4);
    assert.equal(slawson.stats.threes, 3);
    assert.equal(slawson.stats.rebounds, 10);
  });
  test('suffix and initial matching on real names', () => {
    assert.equal(findPlayer(g.players, 'Kelly Oubre').stats.points, 20);
    assert.equal(findPlayer(g.players, 'TJ McConnell').name, 'T.J. McConnell');
  });
  test('DNP players have no stats and void at full time', () => {
    const caruso = findPlayer(g.players, 'Alex Caruso');
    assert.equal(caruso.dnp, true);
    const leg = { sport: 'nba', gameId: g.id, gameLabel: g.label, gameStart: g.start, market: 'prop', player: 'Alex Caruso', stat: 'points', line: 6.5, side: 'over' };
    assert.equal(evaluateLeg(leg, g).status, 'void');
  });
  test('end to end leg results on the real final', () => {
    const base = { sport: 'nba', gameId: g.id, gameLabel: 'OKC @ IND', gameStart: g.start };
    const sgaOver = evaluateLeg({ ...base, market: 'prop', player: 'Shai Gilgeous-Alexander', stat: 'points', line: 30.5, side: 'over' }, g);
    assert.equal(sgaOver.status, 'won');
    assert.equal(sgaOver.detail, 'OKC 120-125 IND FINAL | 38 of 30.5');
    assert.equal(evaluateLeg({ ...base, market: 'h2h', team: 'IND' }, g).status, 'won');
    assert.equal(evaluateLeg({ ...base, market: 'line', team: 'OKC', line: 4.5 }, g).status, 'lost');
    assert.equal(evaluateLeg({ ...base, market: 'line', team: 'OKC', line: 5.5 }, g).status, 'won');
    assert.equal(evaluateLeg({ ...base, market: 'line', team: 'OKC', line: 5 }, g).status, 'void');
    assert.equal(evaluateLeg({ ...base, market: 'total', line: 240.5, side: 'over' }, g).status, 'won');
  });
});

describe('NFL summary fixture', () => {
  const g = parseSummary('nfl', fixture('nfl_sum.json'));
  test('header status and scores', () => {
    assert.equal(g.id, '401873076');
    assert.equal(g.state, 'post');
    assert.equal(g.label, 'PIT @ PHI');
    assert.equal(g.home.score, 19);
    assert.equal(g.away.score, 16);
  });
  test('real player stats merged across passing, rushing and receiving groups', () => {
    const rodgers = findPlayer(g.players, 'Aaron Rodgers');
    assert.equal(rodgers.stats.passingYards, 227);
    assert.equal(rodgers.stats.passingTDs, 1);
    assert.equal(rodgers.stats.rushingYards, 29);
    const barkley = findPlayer(g.players, 'Saquon Barkley');
    assert.equal(barkley.stats.rushingYards, 75);
    assert.equal(barkley.stats.rushingTDs, 1);
    assert.equal(barkley.stats.anytimeTD, 1);
    const dowdle = findPlayer(g.players, 'Rico Dowdle');
    assert.equal(dowdle.stats.rushingYards, 15);
    assert.equal(dowdle.stats.receivingYards, 19);
    assert.equal(dowdle.stats.receptions, 4);
    assert.equal(dowdle.stats.rushRecYards, 34);
    const hurleman = findPlayer(g.players, 'Max Hurleman');
    assert.equal(hurleman.stats.receivingYards, 61);
    assert.equal(hurleman.stats.anytimeTD, 1);
  });
  test('end to end NFL legs on the real final', () => {
    const base = { sport: 'nfl', gameId: g.id, gameLabel: 'PIT @ PHI', gameStart: g.start };
    assert.equal(evaluateLeg({ ...base, market: 'prop', player: 'Saquon Barkley', stat: 'anytimeTD', line: 0.5, side: 'over' }, g).status, 'won');
    assert.equal(evaluateLeg({ ...base, market: 'prop', player: 'Aaron Rodgers', stat: 'passingYards', line: 245.5, side: 'under' }, g).status, 'won');
    assert.equal(evaluateLeg({ ...base, market: 'prop', player: 'DeVonta Smith', stat: 'receptions', line: 5.5, side: 'over' }, g).status, 'lost');
    assert.equal(evaluateLeg({ ...base, market: 'line', team: 'PIT', line: 3 }, g).status, 'void');
    assert.equal(evaluateLeg({ ...base, market: 'line', team: 'PHI', line: -2.5 }, g).status, 'won');
    const r = evaluateLeg({ ...base, market: 'total', line: 41.5, side: 'under' }, g);
    assert.equal(r.status, 'won');
    assert.equal(r.detail, 'PIT 16-19 PHI FINAL | 35, under 41.5');
  });
});

describe('urls and dates', () => {
  test('urls', () => {
    assert.equal(scoreboardUrl('nba', '20261124'), 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261124');
    assert.equal(scoreboardUrl('nfl'), 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
    assert.equal(summaryUrl('nfl', '401873076'), 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401873076');
  });
  test('ESPN date is the US Eastern date', () => {
    assert.equal(espnDate(new Date('2026-11-25T00:00:00Z')), '20261124');
    assert.equal(espnDate(new Date('2026-11-25T06:00:00Z')), '20261125');
  });
});

describe('client', () => {
  test('caches scoreboard for 60s, sends a User-Agent, and surfaces failures', async () => {
    let t = 0;
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('summary')) return { ok: false, status: 500 };
      return { ok: true, json: async () => fixture('nba_sb.json') };
    };
    const c = createEspnClient({ fetchImpl, now: () => t, log: { warn() {} } });
    await c.scoreboard('nba', '20261124');
    await c.scoreboard('nba', '20261124');
    assert.equal(calls.length, 1);
    assert.match(calls[0].opts.headers['User-Agent'], /Mozilla/);
    assert.ok(calls[0].opts.signal);
    t = 61_000;
    await c.scoreboard('nba', '20261124');
    assert.equal(calls.length, 2);
    await assert.rejects(() => c.summary('nba', '1'), /HTTP 500/);
  });
});
