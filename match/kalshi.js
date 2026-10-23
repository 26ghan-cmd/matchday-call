'use strict';
// Kalshi: live prediction-market prices for Premier League games, from Kalshi's
// public market-data API (no account or key needed). Read-only: trading happens
// on Kalshi itself, so we never handle anyone's Kalshi credentials.
//
// Each game is an "event" with one market per outcome (each team, and the tie).
// A Yes contract pays $1 if that outcome happens, so its price is the market's
// estimate of the chance, e.g. 56¢ ≈ 56%.

const { teamCode, teamsIn } = require('./teams');

const BASE = process.env.KALSHI_API_BASE || 'https://external-api.kalshi.com/trade-api/v2';
const SERIES = 'KXEPLGAME';
const CACHE_MS = 20 * 1000;
const SERIES_URL = 'https://kalshi.com/markets/kxeplgame';

let cache = { at: 0, games: null, error: null, pending: null };

// Prices come as dollar strings ("0.5600") in newer responses, cents in older ones.
function dollars(m, name) {
  const d = m[`${name}_dollars`];
  if (d != null && d !== '') {
    const n = parseFloat(d);
    return Number.isFinite(n) ? n : null;
  }
  const c = m[name];
  return typeof c === 'number' ? c / 100 : null;
}

function outcomeFrom(m) {
  const bid = dollars(m, 'yes_bid');
  const ask = dollars(m, 'yes_ask');
  const last = dollars(m, 'last_price');
  // Best guess at the current price: middle of bid/ask if there's a real market, else last trade.
  let price = null;
  if (bid != null && ask != null && bid > 0 && ask > 0 && ask < 1) price = (bid + ask) / 2;
  else if (last != null && last > 0) price = last;
  else if (bid != null && bid > 0) price = bid;
  const label = m.yes_sub_title || m.subtitle || m.no_sub_title || m.ticker;
  const volume = parseFloat(m.volume_fp ?? m.volume ?? 0) || 0;
  return { ticker: m.ticker, label, price, bid, ask, last, volume, status: m.status };
}

async function fetchAllOpen() {
  const markets = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${BASE}/markets`);
    url.searchParams.set('series_ticker', SERIES);
    url.searchParams.set('status', 'open');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Kalshi returned ${res.status}`);
    const body = await res.json();
    markets.push(...(body.markets || []));
    cursor = body.cursor || '';
    if (!cursor) break;
  }
  // Group the per-outcome markets into games.
  const games = new Map();
  markets.forEach((m) => {
    const key = m.event_ticker || m.ticker;
    if (!games.has(key)) {
      games.set(key, {
        eventTicker: key,
        title: String(m.title || '').replace(/\s*(winner|who will win)\??\s*$/i, '').trim(),
        closes: m.expected_expiration_time || m.close_time || null,
        outcomes: [],
      });
    }
    games.get(key).outcomes.push(outcomeFrom(m));
  });
  return [...games.values()];
}

async function games() {
  if (cache.games && Date.now() - cache.at < CACHE_MS) return cache;
  if (!cache.pending) {
    cache.pending = fetchAllOpen()
      .then((list) => { cache = { at: Date.now(), games: list, error: null, pending: null }; })
      .catch((err) => {
        console.error('Kalshi:', err.message);
        cache = { at: Date.now() - CACHE_MS + 30e3, games: cache.games, error: err.message, pending: null };
      });
  }
  await cache.pending;
  return cache;
}

// Which side of our fixture is each outcome? (home / draw / away)
function sideOf(outcome, homeCode, awayCode) {
  if (/^(tie|draw)$/i.test(String(outcome.label).trim()) || /-TIE$/i.test(outcome.ticker || '')) return 'draw';
  const code = teamCode(outcome.label);
  if (code && code === homeCode) return 'home';
  if (code && code === awayCode) return 'away';
  return null;
}

function forFixture(list, home, away) {
  const homeCode = teamCode(home), awayCode = teamCode(away);
  if (!homeCode || !awayCode) return null;
  const game = list.find((g) => {
    const named = new Set([...teamsIn(g.title), ...g.outcomes.map((o) => teamCode(o.label)).filter(Boolean)]);
    return named.has(homeCode) && named.has(awayCode);
  });
  if (!game) return null;
  const order = { home: 0, draw: 1, away: 2 };
  const outcomes = game.outcomes
    .map((o) => ({ ...o, side: sideOf(o, homeCode, awayCode) }))
    .filter((o) => o.side)
    .sort((a, b) => order[a.side] - order[b.side]);
  return outcomes.length ? { eventTicker: game.eventTicker, title: game.title, outcomes, url: SERIES_URL } : null;
}

// What the browser gets: this match (if Kalshi lists it) plus other open games.
async function kalshiFor(home, away) {
  const c = await games();
  const list = c.games || [];
  const match = home && away ? forFixture(list, home, away) : null;
  const upcoming = list
    .filter((g) => !match || g.eventTicker !== match.eventTicker)
    .sort((a, b) => new Date(a.closes || 0) - new Date(b.closes || 0))
    .slice(0, 8)
    .map((g) => ({ eventTicker: g.eventTicker, title: g.title, outcomes: g.outcomes.map(({ label, price }) => ({ label, price })) }));
  return { match, upcoming, seriesUrl: SERIES_URL, error: c.games ? null : c.error, updatedAt: new Date(c.at).toISOString() };
}

module.exports = { kalshiFor, _internals: { outcomeFrom, forFixture, dollars } };
