import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createTracker } from '../src/tracker.js';
import { parseScoreboard } from '../src/espn.js';
import { game } from './helpers.js';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', n), 'utf8'));
const quiet = { info() {}, warn() {}, error() {} };

let server;
let base;
let dir;
let file;
let store;
const NOW = Date.parse('2026-11-24T10:00:00Z');

const espn = {
  async scoreboard(sport) { return sport === 'nba' ? parseScoreboard('nba', fixture('nba_sb.json')) : parseScoreboard('nfl', fixture('nfl_sb.json')); },
  async summary(sport, id) { return game({ id, state: 'in', away: ['OKC', 60], home: ['IND', 50] }); },
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bets-'));
  file = path.join(dir, 'nested', 'bets.json');
  store = createStore(file);
  const tracker = createTracker({ store, espn, now: () => NOW, log: quiet });
  server = http.createServer(createApp({ store, espn, tracker, now: () => NOW, log: quiet, extract: { hasKey: () => false } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const req = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, type: res.headers.get('content-type') };
};

const okcLeg = { sport: 'nba', gameId: '401910038', gameLabel: 'OKC @ IND', gameStart: '2026-11-24T00:30Z', market: 'h2h', team: 'OKC' };

test('phone page is served', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.text, /<title>/);
});

test('games list: upcoming and live only, sorted, with the spec fields', async () => {
  const r = await req('GET', '/api/games?sport=nba');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((g) => g.id), ['401909314', '401909315', '401909316']);
  assert.deepEqual(Object.keys(r.json[0]).slice(0, 4), ['id', 'label', 'start', 'state']);
  const nfl = await req('GET', '/api/games?sport=nfl');
  assert.deepEqual(nfl.json, []); // fixture week is all finals
  assert.equal((await req('GET', '/api/games?sport=mlb')).status, 400);
});

test('create, list, overlay, settle, delete', async () => {
  const bad = await req('POST', '/api/bets', { type: 'single', stake: -1, odds: 2, legs: [okcLeg] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'stake must be above 0');
  assert.equal((await req('POST', '/api/bets', '{not json')).status, 400);

  const created = await req('POST', '/api/bets', { type: 'single', stake: 10, odds: 1.9, legs: [okcLeg] });
  assert.equal(created.status, 201);
  const id = created.json.id;
  assert.match(id, /^b_[0-9a-f]{10}$/);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.bets[0].id, id);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['bets.json'], 'no temp files left behind');

  await new Promise((r) => setTimeout(r, 20)); // let the background tick fetch the summary
  const list = await req('GET', '/api/bets');
  assert.equal(list.json.bets[0].status, 'winning');
  assert.equal(list.json.bets[0].legs[0].detail, 'OKC 60-50 IND Q3 5:12 | leading by 10');

  const ov = await req('GET', '/api/overlay');
  assert.deepEqual(Object.keys(ov.json), ['updatedAt', 'dayPnl', 'currency', 'bets']);
  assert.deepEqual(ov.json.bets[0], {
    id, title: 'OKC to win', stake: 10, odds: 1.9, toWin: 9, status: 'winning',
    legs: [{ label: 'OKC to win', detail: 'OKC 60-50 IND Q3 5:12 | leading by 10', status: 'winning' }],
  });

  const s = await req('POST', `/api/bets/${id}/settle`, { status: 'lost' });
  assert.equal(s.status, 200);
  assert.equal(s.json.status, 'lost');
  assert.equal((await req('GET', '/api/overlay')).json.dayPnl, -10);
  assert.equal((await req('POST', `/api/bets/${id}/settle`, { status: 'nope' })).status, 400);
  const auto = await req('POST', `/api/bets/${id}/settle`, { status: 'auto' });
  assert.equal(auto.json.status, 'winning');
  assert.equal(auto.json.manual, null);

  assert.equal((await req('DELETE', `/api/bets/${id}`)).status, 200);
  assert.equal((await req('DELETE', `/api/bets/${id}`)).status, 404);
  assert.equal((await req('POST', '/api/bets/b_missing/settle', { status: 'won' })).status, 404);
  assert.deepEqual((await req('GET', '/api/bets')).json.bets, []);
});

test('extract without a key returns 503 with the message', async () => {
  const r = await req('POST', '/api/extract', { imageBase64: 'a'.repeat(200), mediaType: 'image/jpeg' });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'Screenshot reading needs ANTHROPIC_API_KEY set on the server' });
});

test('extract body limit is 8MB', async () => {
  const r = await req('POST', '/api/extract', { imageBase64: 'a'.repeat(8 * 1024 * 1024 + 10), mediaType: 'image/jpeg' });
  assert.equal(r.status, 413);
});

test('unknown routes 404 as JSON', async () => {
  const r = await req('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Not found');
});
