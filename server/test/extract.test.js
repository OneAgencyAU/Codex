import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { matchLegs, teamMatches, readSlip, ExtractError, MODEL, SLIP_SCHEMA, SYSTEM_PROMPT } from '../src/extract.js';

const games = {
  nba: [
    { id: '10', label: 'LAL @ SAC', start: '2026-11-25T03:00:00.000Z', state: 'pre', home: { abbr: 'SAC', name: 'Sacramento Kings', short: 'Kings' }, away: { abbr: 'LAL', name: 'Los Angeles Lakers', short: 'Lakers' } },
    { id: '11', label: 'BOS @ WSH', start: '2026-11-25T01:00:00.000Z', state: 'pre', home: { abbr: 'WSH', name: 'Washington Wizards', short: 'Wizards' }, away: { abbr: 'BOS', name: 'Boston Celtics', short: 'Celtics' } },
    { id: '12', label: 'BOS @ PHI', start: '2026-11-27T01:00:00.000Z', state: 'pre', home: { abbr: 'PHI', name: 'Philadelphia 76ers', short: '76ers' }, away: { abbr: 'BOS', name: 'Boston Celtics', short: 'Celtics' } },
  ],
  nfl: [
    { id: '20', label: 'PIT @ PHI', start: '2026-11-29T18:00:00.000Z', state: 'pre', home: { abbr: 'PHI', name: 'Philadelphia Eagles', short: 'Eagles' }, away: { abbr: 'PIT', name: 'Pittsburgh Steelers', short: 'Steelers' } },
  ],
};

const rawLeg = (o) => ({ sport: 'nba', homeTeam: null, awayTeam: null, market: 'h2h', selectionTeam: null, line: null, side: null, player: null, stat: null, odds: null, ...o });

describe('matching slip legs to ESPN games', () => {
  test('team name forms', () => {
    const lakers = games.nba[0].away;
    for (const s of ['Los Angeles Lakers', 'LA Lakers', 'Lakers', 'LAL', 'lakers']) assert.ok(teamMatches(s, lakers), s);
    assert.ok(!teamMatches('Kings', lakers));
    assert.ok(teamMatches('Philadelphia 76ers', games.nba[2].home));
  });
  test('unique match fills game and team', () => {
    const out = matchLegs({ type: 'single', stake: 20, totalOdds: null, warnings: [], legs: [rawLeg({ homeTeam: 'Sacramento Kings', awayTeam: 'LA Lakers', market: 'line', selectionTeam: 'LA Lakers', line: -4.5, odds: 1.9 })] }, games);
    assert.equal(out.type, 'single');
    assert.equal(out.odds, 1.9);
    assert.equal(out.stake, 20);
    const l = out.legs[0];
    assert.equal(l.gameId, '10');
    assert.equal(l.gameLabel, 'LAL @ SAC');
    assert.equal(l.gameStart, '2026-11-25T03:00:00.000Z');
    assert.equal(l.team, 'LAL');
    assert.equal(l.line, -4.5);
    assert.deepEqual(out.warnings, []);
  });
  test('ambiguous match returns candidates and a warning', () => {
    const out = matchLegs({ type: 'single', stake: 5, totalOdds: 1.5, warnings: [], legs: [rawLeg({ selectionTeam: 'Boston Celtics' })] }, games);
    assert.equal(out.legs[0].gameId, null);
    assert.deepEqual(out.legs[0].candidates.map((c) => c.id).sort(), ['11', '12']);
    assert.match(out.warnings[0], /more than one game/);
  });
  test('NFL sport, multi, unknown game and model warnings pass through', () => {
    const out = matchLegs({
      type: 'multi', stake: 10, totalOdds: 6.2, warnings: ['Stake partly cropped'],
      legs: [
        rawLeg({ sport: 'unknown', homeTeam: 'Philadelphia Eagles', awayTeam: 'Pittsburgh Steelers', market: 'prop', player: 'Saquon Barkley', stat: 'anytimeTD' }),
        rawLeg({ homeTeam: 'Denver Nuggets', awayTeam: 'Dallas Mavericks', market: 'total', line: 230.5, side: 'over' }),
      ],
    }, games);
    assert.equal(out.type, 'multi');
    assert.equal(out.odds, 6.2);
    assert.equal(out.legs[0].sport, 'nfl');
    assert.equal(out.legs[0].gameId, '20');
    assert.equal(out.legs[1].gameId, null);
    assert.equal(out.warnings[0], 'Stake partly cropped');
    assert.match(out.warnings[1], /Leg 2: no upcoming or live game found for Dallas Mavericks at Denver Nuggets/);
  });
});

describe('Claude request', () => {
  let server;
  let baseURL;
  let lastRequest;
  let reply;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        const [status, payload] = reply();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const client = () => new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 });
  const message = (text, stop = 'end_turn') => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, stop_reason: stop, stop_sequence: null,
    content: text === null ? [] : [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 },
  });

  test('sends model, image, structured output schema, low effort and fallbacks', async () => {
    const slip = { type: 'single', stake: 10, totalOdds: 1.9, legs: [rawLeg({ selectionTeam: 'Lakers' })], warnings: [] };
    reply = () => [200, message(JSON.stringify(slip))];
    const out = await readSlip({ imageBase64: 'aGVsbG8=', mediaType: 'image/jpeg' }, { anthropic: client() });
    assert.deepEqual(out, slip);
    const b = lastRequest.body;
    assert.match(lastRequest.url, /^\/v1\/messages/);
    assert.match(lastRequest.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(b.model, 'claude-opus-5-5');
    assert.equal(b.fallbacks, 'default');
    assert.equal(b.thinking, undefined);
    assert.deepEqual(b.output_config, { effort: 'low', format: { type: 'json_schema', schema: SLIP_SCHEMA } });
    assert.equal(b.system, SYSTEM_PROMPT);
    assert.deepEqual(b.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } });
  });
  test('refusal gives a clear error', async () => {
    reply = () => [200, message(null, 'refusal')];
    await assert.rejects(() => readSlip({ imageBase64: 'x', mediaType: 'image/png' }, { anthropic: client() }),
      (e) => e instanceof ExtractError && e.status === 422 && /declined/.test(e.message));
  });
  test('typed SDK errors map to clear messages', async () => {
    reply = () => [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }];
    await assert.rejects(() => readSlip({ imageBase64: 'x', mediaType: 'image/png' }, { anthropic: client() }),
      (e) => e.status === 429 && /rate limited/.test(e.message));
    reply = () => [401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }];
    await assert.rejects(() => readSlip({ imageBase64: 'x', mediaType: 'image/png' }, { anthropic: client() }),
      (e) => e.status === 502 && /key was rejected/.test(e.message));
    const dead = new Anthropic({ apiKey: 'k', baseURL: 'http://127.0.0.1:1', maxRetries: 0 });
    await assert.rejects(() => readSlip({ imageBase64: 'x', mediaType: 'image/png' }, { anthropic: dead }),
      (e) => e.status === 502 && /Could not reach/.test(e.message));
  });
  test('prompt and schema contain no em dashes', () => {
    assert.ok(!SYSTEM_PROMPT.includes('—'));
    assert.ok(!JSON.stringify(SLIP_SCHEMA).includes('—'));
  });
});
