// Read a Sportsbet bet slip screenshot with Claude and pre-match each leg to
// an ESPN game. Never saves anything: the phone shows the result for editing.
import Anthropic from '@anthropic-ai/sdk';
import { PROP_STATS, normaliseName } from './evaluate.js';

export const MODEL = 'claude-opus-5-5';
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const NO_KEY_MESSAGE = 'Screenshot reading needs ANTHROPIC_API_KEY set on the server';

const ALL_STATS = [...new Set([...Object.keys(PROP_STATS.nba), ...Object.keys(PROP_STATS.nfl)])];
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

export const SLIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'stake', 'totalOdds', 'legs', 'warnings'],
  properties: {
    type: { type: 'string', enum: ['single', 'multi'] },
    stake: nullable({ type: 'number' }),
    totalOdds: nullable({ type: 'number' }),
    legs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sport', 'homeTeam', 'awayTeam', 'market', 'selectionTeam', 'line', 'side', 'player', 'stat', 'odds'],
        properties: {
          sport: { type: 'string', enum: ['nba', 'nfl', 'unknown'] },
          homeTeam: nullable({ type: 'string' }),
          awayTeam: nullable({ type: 'string' }),
          market: { type: 'string', enum: ['h2h', 'line', 'total', 'prop'] },
          selectionTeam: nullable({ type: 'string' }),
          line: nullable({ type: 'number' }),
          side: nullable({ type: 'string', enum: ['over', 'under'] }),
          player: nullable({ type: 'string' }),
          stat: nullable({ type: 'string', enum: ALL_STATS }),
          odds: nullable({ type: 'number' }),
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

export const SYSTEM_PROMPT = `You read screenshots of Sportsbet (Australia) bet slips and bet history entries for NBA and NFL bets, and turn them into structured data. The user checks and edits your result before saving, so accuracy matters more than completeness: if you cannot read something, leave it null and say so in warnings rather than guessing.

For the whole bet:
- type: "multi" if the slip is a multi (several legs combined into one bet, including Same Game Multis), otherwise "single". If the screenshot shows several separate single bets, return type "single" with only the first one and add a warning saying that only the first bet was read.
- stake: the amount staked in dollars, as a number.
- totalOdds: the decimal odds for the whole bet (for a single, the leg's odds). If only the potential return is shown, totalOdds = return / stake.

For each leg (selection):
- sport: "nba" or "nfl", from team names, players or markets; "unknown" if you cannot tell.
- homeTeam and awayTeam: the two teams as written on the slip. Sportsbet usually writes "Away Team At Home Team" or "Away v Home"; the second team is normally the home team. Null if the game is not shown.
- market: "h2h" for head to head / match winner / moneyline; "line" for line / handicap / spread; "total" for total points (game total over/under); "prop" for any player market.
- selectionTeam: the team picked, for h2h and line.
- line: for line, the handicap of the picked team (for example -4.5 or +7.5); for total, the points line; for prop, the player line. Sportsbet often writes player markets as "25+ Points", which means over 24.5: return line 24.5 and side "over". "To score 2+ touchdowns" style markets are not supported: describe them in a warning.
- side: "over" or "under" for total and prop.
- player: the player's full name as written, for prop.
- stat: for prop, one of these keys. NBA: points, rebounds, assists, threes (three pointers made), steals, blocks, pra (points + rebounds + assists), pr (points + rebounds), pa (points + assists), ra (rebounds + assists). NFL: passingYards, passingTDs, rushingYards, receivingYards, receptions, rushRecYards (rushing + receiving yards), anytimeTD (anytime touchdown scorer). Null if the market is none of these, with a warning.
- odds: that leg's decimal odds if shown, else null.

Put every doubt in warnings as a short plain sentence: unreadable or cropped text, a market that is not in the list, a guessed sport or home/away order, legs from other sports, or odds and stake you could not find. Never use em dash characters in any text you return.`;

// ---------- matching legs to ESPN games ----------

function teamNames(t) {
  const names = [t.abbr, t.name, t.short, t.name?.split(' ').slice(-1)[0]].filter(Boolean).map(normaliseName);
  return [...new Set(names)];
}

export function teamMatches(text, team) {
  const n = normaliseName(text);
  if (!n) return false;
  const names = teamNames(team);
  if (names.includes(n)) return true;
  // "LA Lakers" vs "Los Angeles Lakers", "Philadelphia 76ers" vs "76ers"
  const nick = normaliseName(team.short || '');
  if (nick && n.split(' ').length > 1 && n.endsWith(` ${nick}`)) return true;
  const full = normaliseName(team.name || '');
  return n.length >= 4 && (full.includes(n) || n.includes(full));
}

function gameMatchScore(leg, game) {
  const named = [leg.homeTeam, leg.awayTeam, leg.selectionTeam].filter(Boolean);
  if (named.length === 0) return 0;
  let score = 0;
  for (const text of new Set(named)) {
    if (teamMatches(text, game.home) || teamMatches(text, game.away)) score++;
    else return -1; // names a team that is not in this game
  }
  return score;
}

function pickTeam(text, game) {
  if (!text || !game) return null;
  if (teamMatches(text, game.home)) return game.home.abbr;
  if (teamMatches(text, game.away)) return game.away.abbr;
  return null;
}

export function matchLegs(slip, gamesBySport) {
  const warnings = [...(slip.warnings || [])];
  const legs = (slip.legs || []).map((raw, i) => {
    const where = `Leg ${i + 1}`;
    const sports = raw.sport === 'nba' || raw.sport === 'nfl' ? [raw.sport] : ['nba', 'nfl'];
    const scored = [];
    for (const sport of sports) {
      for (const g of gamesBySport[sport] || []) {
        const s = gameMatchScore(raw, g);
        if (s > 0) scored.push({ g: { ...g, sport }, s });
      }
    }
    const best = scored.length ? Math.max(...scored.map((x) => x.s)) : 0;
    const top = scored.filter((x) => x.s === best).map((x) => x.g);
    const leg = {
      sport: top.length === 1 ? top[0].sport : (raw.sport === 'unknown' ? null : raw.sport),
      gameId: null,
      gameLabel: null,
      gameStart: null,
      market: raw.market,
      team: null,
      line: raw.line,
      side: raw.side,
      player: raw.player,
      stat: raw.stat,
      odds: raw.odds,
      candidates: [],
      slipText: { home: raw.homeTeam, away: raw.awayTeam, selection: raw.selectionTeam },
    };
    if (top.length === 1) {
      const g = top[0];
      leg.gameId = g.id;
      leg.gameLabel = g.label;
      leg.gameStart = g.start;
      if (raw.market === 'h2h' || raw.market === 'line') {
        leg.team = pickTeam(raw.selectionTeam, g);
        if (!leg.team) warnings.push(`${where}: could not tell which team was picked, please choose it`);
      }
    } else if (top.length > 1) {
      leg.candidates = top.slice(0, 6).map((g) => ({ id: g.id, sport: g.sport, label: g.label, start: g.start }));
      warnings.push(`${where}: more than one game matches, please pick the right one`);
    } else {
      const what = [raw.awayTeam, raw.homeTeam].filter(Boolean).join(' at ') || raw.player || 'this leg';
      warnings.push(`${where}: no upcoming or live game found for ${what}, please pick the game`);
    }
    if (raw.market === 'prop' && raw.sport !== 'unknown' && raw.stat && !PROP_STATS[leg.sport || raw.sport]?.[raw.stat]) {
      warnings.push(`${where}: stat ${raw.stat} does not fit ${String(leg.sport || raw.sport).toUpperCase()}`);
    }
    return leg;
  });
  let odds = slip.totalOdds;
  if (!odds && legs.length === 1 && legs[0].odds) odds = legs[0].odds;
  return {
    type: legs.length > 1 ? 'multi' : 'single',
    stake: slip.stake ?? null,
    odds: odds ?? null,
    legs,
    warnings: warnings.map((w) => String(w).replace(/\u2014/g, '-')),
  };
}

// ---------- Claude call ----------

export class ExtractError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function hasKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export async function readSlip({ imageBase64, mediaType }, { anthropic } = {}) {
  const c = anthropic || getClient();
  let response;
  try {
    response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SLIP_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: `Read this bet slip. Today is ${new Date().toDateString()}.` },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new ExtractError(502, 'The Anthropic API key was rejected, check ANTHROPIC_API_KEY on the server');
    if (err instanceof Anthropic.PermissionDeniedError) throw new ExtractError(502, 'The Anthropic API key is not allowed to use this model');
    if (err instanceof Anthropic.RateLimitError) throw new ExtractError(429, 'Claude is rate limited right now, try again in a minute');
    if (err instanceof Anthropic.BadRequestError) throw new ExtractError(502, `Claude rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionTimeoutError) throw new ExtractError(504, 'Claude took too long to answer, try again');
    if (err instanceof Anthropic.APIConnectionError) throw new ExtractError(502, 'Could not reach the Anthropic API, check the internet connection');
    if (err instanceof Anthropic.APIError) throw new ExtractError(502, `Claude API error ${err.status ?? ''}: ${err.message}`.trim());
    throw err;
  }
  if (response.stop_reason === 'refusal') {
    throw new ExtractError(422, 'Claude declined to read this image. Enter the bet manually instead.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ExtractError(502, 'Claude ran out of room reading this slip. Try a tighter crop.');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtractError(502, 'Claude returned something that was not valid bet data. Try again or enter it manually.');
  }
}
