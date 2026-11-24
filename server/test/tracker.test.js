import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/tracker.js';
import { game, leg, nbaPlayer } from './helpers.js';

function memStore(bets) {
  let saves = 0;
  return { all: () => bets, save: () => { saves++; }, get saves() { return saves; } };
}

const quiet = { info() {}, warn() {}, error() {} };

test('polling cadence follows pre / in / post and settles the bet', async () => {
  const START = Date.parse('2026-11-24T09:00:00Z');
  let t = START - 60 * 60_000; // one hour before start
  let current = game({ state: 'pre', start: new Date(START).toISOString(), away: ['LAL', 0], home: ['SAC', 0] });
  const calls = { summary: 0, scoreboard: 0 };
  const espn = {
    async summary() { calls.summary++; return { ...current }; },
    async scoreboard() { calls.scoreboard++; const { players, ...rest } = current; return [rest]; },
  };
  const bet = { id: 'b1', createdAt: new Date(t).toISOString(), type: 'single', stake: 10, odds: 2, legs: [leg({ gameStart: new Date(START).toISOString() })] };
  const store = memStore([bet]);
  const tr = createTracker({ store, espn, now: () => t, log: quiet });

  await tr.tick();
  assert.deepEqual(calls, { summary: 1, scoreboard: 0 }, 'first sight: one summary');
  t += 5_000; await tr.tick();
  assert.deepEqual(calls, { summary: 1, scoreboard: 0 }, 'pre: nothing within 5 minutes');
  t += 5 * 60_000; await tr.tick();
  assert.deepEqual(calls, { summary: 1, scoreboard: 1 }, 'pre: scoreboard re-check after 5 minutes');
  t += 60_000; await tr.tick();
  assert.equal(calls.scoreboard, 1, 'still far from start, still 5 minute cadence');

  t = START - 60_000; await tr.tick();
  assert.equal(calls.scoreboard, 2);
  t += 60_000; await tr.tick();
  assert.equal(calls.scoreboard, 3, 'near start: every 60 seconds');

  current = game({ state: 'in', period: 1, clock: '11:00', away: ['LAL', 2], home: ['SAC', 0], start: current.start, players: [nbaPlayer('LeBron James')] });
  t += 60_000; await tr.tick();
  assert.equal(calls.scoreboard, 4);
  assert.equal(calls.summary, 2, 'went live: summary fetched straight away');
  assert.equal(tr.views()[0].status, 'winning');

  t += 5_000; await tr.tick();
  assert.equal(calls.summary, 2, 'in game: not more than every 20 seconds');
  t += 15_000; await tr.tick();
  assert.equal(calls.summary, 3);

  current = game({ state: 'post', statusName: 'STATUS_FINAL', away: ['LAL', 110], home: ['SAC', 100], start: current.start, players: [] });
  t += 20_000; await tr.tick();
  assert.equal(calls.summary, 4);
  assert.equal(bet.result.status, 'won');
  assert.equal(bet.result.at, new Date(t).toISOString());
  assert.equal(bet.result.legs[0].detail, 'LAL 110-100 SAC FINAL | won by 10');
  const settledAt = bet.result.at;

  for (let i = 0; i < 10; i++) { t += 20_000; await tr.tick(); }
  assert.deepEqual(calls, { summary: 4, scoreboard: 4 }, 'post and settled: no more fetching');
  assert.equal(bet.result.at, settledAt, 'settledAt recorded once');
  assert.equal(tr.views()[0].profit, 10);
});

test('fetch failures are logged, never thrown, and retried later', async () => {
  let t = 0;
  let fail = true;
  let calls = 0;
  const warnings = [];
  const espn = {
    async summary() { calls++; if (fail) throw new Error('timeout'); return game({ state: 'in' }); },
    async scoreboard() { return []; },
  };
  const bet = { id: 'b1', createdAt: new Date(0).toISOString(), type: 'single', stake: 10, odds: 2, legs: [leg()] };
  const tr = createTracker({ store: memStore([bet]), espn, now: () => t, log: { ...quiet, warn: (m) => warnings.push(m) } });
  await tr.tick();
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  t += 5_000; await tr.tick();
  assert.equal(calls, 1, 'waits before retrying');
  fail = false;
  t += 30_000; await tr.tick();
  assert.equal(calls, 2);
  assert.equal(tr.views()[0].status, 'winning');
});

test('multi: once one leg loses the bet settles and the other games stop polling', async () => {
  let t = 0;
  const fetched = [];
  const g1 = game({ id: '1', state: 'post', away: ['LAL', 90], home: ['SAC', 100] });
  const g2 = game({ id: '2', state: 'in', away: ['BOS', 50], home: ['NYK', 40] });
  const espn = {
    async summary(sport, id) { fetched.push(id); return id === '1' ? g1 : g2; },
    async scoreboard() { return []; },
  };
  const bet = { id: 'm', createdAt: new Date(0).toISOString(), type: 'multi', stake: 10, odds: 4,
    legs: [leg({ gameId: '1' }), leg({ gameId: '2', gameLabel: 'BOS @ NYK', team: 'BOS' })] };
  const tr = createTracker({ store: memStore([bet]), espn, now: () => t, log: quiet });
  await tr.tick();
  assert.equal(bet.result.status, 'lost');
  t += 60_000; await tr.tick();
  assert.deepEqual(fetched.sort(), ['1', '2']);
});

test('manual settles are not overwritten', async () => {
  const espn = { async summary() { return game({ state: 'post' }); }, async scoreboard() { return []; } };
  const bet = { id: 'x', createdAt: new Date(0).toISOString(), type: 'single', stake: 10, odds: 2, legs: [leg({ team: 'SAC' })], manual: { status: 'won', at: new Date(0).toISOString() } };
  const tr = createTracker({ store: memStore([bet]), espn, now: () => 1000, log: quiet });
  await tr.tick();
  assert.equal(bet.result, undefined);
  assert.equal(tr.views()[0].status, 'won');
});
