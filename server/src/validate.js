// Input validation for POST /api/bets. Returns { bet } or { error }.
import { PROP_STATS } from './evaluate.js';

const SPORTS = ['nba', 'nfl'];
const MARKETS = ['h2h', 'line', 'total', 'prop'];
const MAX_LEGS = 20;

class ValidationError extends Error {}

function fail(msg) {
  throw new ValidationError(msg);
}

function finiteNumber(v, what) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${what} must be a number`);
  return n;
}

function cleanString(v, what, max) {
  if (typeof v !== 'string' || !v.trim()) fail(`${what} is required`);
  const s = v.trim();
  if (s.length > max) fail(`${what} is too long (max ${max} characters)`);
  return s;
}

function teamsFromLabel(label) {
  const m = String(label).match(/^\s*([A-Z0-9]{1,5})\s*(?:@|vs\.?|v)\s*([A-Z0-9]{1,5})\s*$/i);
  return m ? [m[1].toUpperCase(), m[2].toUpperCase()] : null;
}

function validateLeg(raw, i) {
  const where = `Leg ${i + 1}`;
  if (!raw || typeof raw !== 'object') fail(`${where} must be an object`);
  const sport = raw.sport;
  if (!SPORTS.includes(sport)) fail(`${where}: sport must be "nba" or "nfl"`);
  const gameId = String(raw.gameId ?? '').trim();
  if (!/^\d{1,15}$/.test(gameId)) fail(`${where}: gameId must be an ESPN event id (digits)`);
  const gameLabel = cleanString(raw.gameLabel, `${where}: gameLabel`, 40);
  const startMs = Date.parse(raw.gameStart);
  if (!raw.gameStart || Number.isNaN(startMs)) fail(`${where}: gameStart must be an ISO date`);
  const market = raw.market;
  if (!MARKETS.includes(market)) fail(`${where}: market must be one of ${MARKETS.join(', ')}`);

  const leg = { sport, gameId, gameLabel, gameStart: new Date(startMs).toISOString(), market };

  if (market === 'h2h' || market === 'line') {
    const team = cleanString(raw.team, `${where}: team`, 5).toUpperCase();
    if (!/^[A-Z0-9]{1,5}$/.test(team)) fail(`${where}: team must be a team abbreviation like LAL`);
    const teams = teamsFromLabel(gameLabel);
    if (teams && !teams.includes(team)) fail(`${where}: team ${team} is not playing in ${gameLabel}`);
    leg.team = team;
  }
  if (market === 'line') {
    leg.line = finiteNumber(raw.line, `${where}: line`);
    if (Math.abs(leg.line) > 100) fail(`${where}: line looks wrong (${leg.line})`);
  }
  if (market === 'total') {
    leg.line = finiteNumber(raw.line, `${where}: total line`);
    if (leg.line <= 0) fail(`${where}: total line must be above 0`);
    if (!['over', 'under'].includes(raw.side)) fail(`${where}: side must be "over" or "under"`);
    leg.side = raw.side;
  }
  if (market === 'prop') {
    leg.player = cleanString(raw.player, `${where}: player`, 60);
    const stats = Object.keys(PROP_STATS[sport]);
    if (!stats.includes(raw.stat)) fail(`${where}: stat must be one of ${stats.join(', ')} for ${sport.toUpperCase()}`);
    leg.stat = raw.stat;
    if (raw.stat === 'anytimeTD') {
      leg.line = 0.5;
      leg.side = 'over';
    } else {
      leg.line = finiteNumber(raw.line, `${where}: prop line`);
      if (leg.line < 0) fail(`${where}: prop line cannot be negative`);
      if (!['over', 'under'].includes(raw.side)) fail(`${where}: side must be "over" or "under"`);
      leg.side = raw.side;
    }
  }
  if (raw.odds !== undefined && raw.odds !== null && raw.odds !== '') {
    leg.odds = finiteNumber(raw.odds, `${where}: odds`);
    if (leg.odds <= 1) fail(`${where}: odds must be decimal odds above 1.00`);
  }
  return leg;
}

export function validateBet(body) {
  try {
    if (!body || typeof body !== 'object') fail('Body must be a JSON object');
    const type = body.type;
    if (!['single', 'multi'].includes(type)) fail('type must be "single" or "multi"');
    if (!Array.isArray(body.legs) || body.legs.length === 0) fail('legs must be a non-empty array');
    if (type === 'single' && body.legs.length !== 1) fail('A single bet must have exactly 1 leg');
    if (type === 'multi' && body.legs.length < 2) fail('A multi needs at least 2 legs');
    if (body.legs.length > MAX_LEGS) fail(`Too many legs (max ${MAX_LEGS})`);
    const stake = finiteNumber(body.stake, 'stake');
    if (stake <= 0) fail('stake must be above 0');
    if (stake > 1_000_000) fail('stake looks too large');
    const odds = finiteNumber(body.odds, 'odds');
    if (odds <= 1) fail('odds must be decimal odds above 1.00');
    if (odds > 100_000) fail('odds look too large');
    const legs = body.legs.map(validateLeg);
    return { bet: { type, stake: Math.round(stake * 100) / 100, odds, legs } };
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.message };
    throw err;
  }
}

export function validateSettle(body) {
  const s = body?.status;
  if (!['won', 'lost', 'void', 'auto'].includes(s)) return { error: 'status must be one of won, lost, void, auto' };
  return { status: s };
}
