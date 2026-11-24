// TV Bet Tracker server: phone page, bet API, TV overlay feed.
// Plain node:http, no framework. Start with `npm start`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore, newId } from './store.js';
import { createEspnClient } from './espn.js';
import { createTracker } from './tracker.js';
import { listGames } from './games.js';
import { overlay, dayPnl } from './evaluate.js';
import { validateBet, validateSettle } from './validate.js';
import { readSlip, matchLegs, hasKey, ExtractError, MEDIA_TYPES, NO_KEY_MESSAGE } from './extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const JSON_LIMIT = 64 * 1024;
const EXTRACT_LIMIT = 8 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, `Request body too large (max ${Math.round(limit / 1024 / 1024 * 10) / 10}MB)`));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp({ store, espn, tracker, now = () => Date.now(), log = console, extract = {} }) {
  const doRead = extract.readSlip || readSlip;
  const keyPresent = extract.hasKey || hasKey;

  async function gamesFor(sport) {
    return listGames(espn, sport, now());
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
    }
    if (m === 'GET' && p === '/api/overlay') {
      return send(res, 200, overlay(tracker.views(), now()));
    }
    if (m === 'GET' && p === '/api/games') {
      const sport = url.searchParams.get('sport');
      if (!['nba', 'nfl'].includes(sport)) throw new HttpError(400, 'sport must be nba or nfl');
      try {
        return send(res, 200, await gamesFor(sport));
      } catch (err) {
        throw new HttpError(502, err.message);
      }
    }
    if (m === 'GET' && p === '/api/bets') {
      const views = tracker.views().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return send(res, 200, { dayPnl: dayPnl(views, now()), currency: '$', bets: views });
    }
    if (m === 'POST' && p === '/api/bets') {
      const body = await readBody(req, JSON_LIMIT);
      const { bet, error } = validateBet(body);
      if (error) throw new HttpError(400, error);
      const saved = store.add({ id: newId(), createdAt: new Date(now()).toISOString(), ...bet });
      tracker.tick();
      const view = tracker.views().find((v) => v.id === saved.id);
      return send(res, 201, view);
    }
    const betMatch = p.match(/^\/api\/bets\/([A-Za-z0-9_-]+)(\/settle)?$/);
    if (betMatch) {
      const id = betMatch[1];
      if (m === 'DELETE' && !betMatch[2]) {
        if (!store.remove(id)) throw new HttpError(404, 'Bet not found');
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && betMatch[2]) {
        const body = await readBody(req, JSON_LIMIT);
        const { status, error } = validateSettle(body);
        if (error) throw new HttpError(400, error);
        const bet = store.update(id, (b) => {
          if (status === 'auto') {
            delete b.manual;
            delete b.result;
          } else {
            b.manual = { status, at: new Date(now()).toISOString() };
          }
        });
        if (!bet) throw new HttpError(404, 'Bet not found');
        if (status === 'auto') tracker.tick();
        return send(res, 200, tracker.views().find((v) => v.id === id));
      }
    }
    if (m === 'POST' && p === '/api/extract') {
      const body = await readBody(req, EXTRACT_LIMIT);
      if (!keyPresent()) throw new HttpError(503, NO_KEY_MESSAGE);
      const { imageBase64, mediaType } = body;
      if (typeof imageBase64 !== 'string' || imageBase64.length < 100) throw new HttpError(400, 'imageBase64 is required');
      if (!MEDIA_TYPES.includes(mediaType)) throw new HttpError(400, `mediaType must be one of ${MEDIA_TYPES.join(', ')}`);
      const clean = imageBase64.replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
      let slip;
      try {
        slip = await doRead({ imageBase64: clean, mediaType });
      } catch (err) {
        if (err instanceof ExtractError) throw new HttpError(err.status, err.message);
        throw err;
      }
      const [nba, nfl] = await Promise.all([
        gamesFor('nba').catch(() => []),
        gamesFor('nfl').catch(() => []),
      ]);
      return send(res, 200, matchLegs(slip, { nba, nfl }));
    }
    if (p.startsWith('/api/')) throw new HttpError(404, 'Not found');
    throw new HttpError(404, 'Not found');
  }

  return async function requestHandler(req, res) {
    const started = Date.now();
    res.on('finish', () => {
      log.info?.(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      log.error?.(`[server] ${req.method} ${req.url} failed: ${err.stack || err.message}`);
      if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
    }
  };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function main() {
  const port = Number(process.env.PORT) || 8787;
  const dataFile = process.env.DATA_FILE || path.join(here, '..', 'data', 'bets.json');
  const log = {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  };
  const store = createStore(dataFile);
  const espn = createEspnClient({ log });
  const tracker = createTracker({ store, espn, log });
  const server = http.createServer(createApp({ store, espn, tracker, log }));
  server.listen(port, '0.0.0.0', () => {
    console.log(`TV Bet Tracker listening on port ${port} (data: ${dataFile})`);
    for (const ip of lanAddresses()) console.log(`  phone page: http://${ip}:${port}/   TV feed: http://${ip}:${port}/api/overlay`);
    if (!hasKey()) console.log('  ANTHROPIC_API_KEY not set: screenshot reading is off, manual entry works.');
  });
  tracker.start();
  process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
