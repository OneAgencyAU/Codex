import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBet, validateSettle } from '../src/validate.js';

const base = { sport: 'nba', gameId: '401910038', gameLabel: 'OKC @ IND', gameStart: '2026-11-24T00:30Z' };
const single = (leg, extra = {}) => ({ type: 'single', stake: 10, odds: 1.9, legs: [{ ...base, ...leg }], ...extra });

test('valid bets of every market are accepted and cleaned', () => {
  let r = validateBet(single({ market: 'h2h', team: 'okc' }));
  assert.equal(r.error, undefined);
  assert.equal(r.bet.legs[0].team, 'OKC');
  assert.equal(r.bet.legs[0].gameStart, '2026-11-24T00:30:00.000Z');
  r = validateBet(single({ market: 'line', team: 'IND', line: '-4.5' }));
  assert.equal(r.bet.legs[0].line, -4.5);
  r = validateBet(single({ market: 'total', line: 225.5, side: 'under' }));
  assert.equal(r.bet.legs[0].side, 'under');
  r = validateBet(single({ market: 'prop', player: 'Shai Gilgeous-Alexander', stat: 'pra', line: 45.5, side: 'over', odds: 1.85 }));
  assert.equal(r.bet.legs[0].odds, 1.85);
  r = validateBet(single({ sport: 'nfl', market: 'prop', player: 'Saquon Barkley', stat: 'anytimeTD' }));
  assert.equal(r.bet.legs[0].line, 0.5);
  assert.equal(r.bet.legs[0].side, 'over');
  r = validateBet({ type: 'multi', stake: 5, odds: 6.2, legs: [{ ...base, market: 'h2h', team: 'IND' }, { ...base, market: 'total', line: 230.5, side: 'over' }] });
  assert.equal(r.bet.legs.length, 2);
});

test('bad input gets a clear message', () => {
  const cases = [
    [null, /JSON object/],
    [{ ...single({ market: 'h2h', team: 'OKC' }), type: 'double' }, /type must be/],
    [{ type: 'single', stake: 10, odds: 2, legs: [] }, /non-empty/],
    [single({ market: 'h2h', team: 'OKC' }, { stake: 0 }), /stake must be above 0/],
    [single({ market: 'h2h', team: 'OKC' }, { stake: 'abc' }), /stake must be a number/],
    [single({ market: 'h2h', team: 'OKC' }, { odds: 1 }), /odds must be decimal odds above 1/],
    [single({ market: 'h2h', team: 'BOS' }), /BOS is not playing in OKC @ IND/],
    [single({ market: 'h2h' }), /team is required/],
    [single({ market: 'line', team: 'OKC' }), /line must be a number/],
    [single({ market: 'total', line: 220 }), /side must be/],
    [single({ market: 'prop', player: 'X', stat: 'rushingYards', line: 1, side: 'over' }), /stat must be one of points/],
    [single({ market: 'prop', stat: 'points', line: 1, side: 'over' }), /player is required/],
    [single({ market: 'moneyline' }), /market must be/],
    [single({ market: 'h2h', team: 'OKC', sport: 'nhl' }), /sport must be/],
    [single({ market: 'h2h', team: 'OKC', gameId: 'abc' }), /ESPN event id/],
    [single({ market: 'h2h', team: 'OKC', gameStart: 'tomorrow' }), /ISO date/],
    [single({ market: 'h2h', team: 'OKC', odds: 0.5 }), /Leg 1: odds/],
    [{ type: 'multi', stake: 5, odds: 3, legs: [{ ...base, market: 'h2h', team: 'IND' }] }, /at least 2 legs/],
    [{ type: 'single', stake: 5, odds: 3, legs: [{ ...base, market: 'h2h', team: 'IND' }, { ...base, market: 'h2h', team: 'IND' }] }, /exactly 1 leg/],
  ];
  for (const [body, re] of cases) {
    const r = validateBet(body);
    assert.match(r.error || '', re, JSON.stringify(body));
  }
});

test('settle validation', () => {
  assert.equal(validateSettle({ status: 'won' }).status, 'won');
  assert.equal(validateSettle({ status: 'auto' }).status, 'auto');
  assert.match(validateSettle({ status: 'meh' }).error, /won, lost, void, auto/);
});
