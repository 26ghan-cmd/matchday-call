'use strict';
// API-Football (api-sports.io) provider: fetches Premier League fixtures, live
// match details and odds, and converts them into the app's own simple format
// (see normalizeFixture / normalizeOdds), so the rest of the app never depends
// on this provider's quirks.

const BASE = 'https://v3.football.api-sports.io';
const PREMIER_LEAGUE = 39;

const SHORT_NAMES = {
  'Arsenal': 'ARS', 'Aston Villa': 'AVL', 'Bournemouth': 'BOU', 'Brentford': 'BRE',
  'Brighton': 'BHA', 'Burnley': 'BUR', 'Chelsea': 'CHE', 'Crystal Palace': 'CRY',
  'Everton': 'EVE', 'Fulham': 'FUL', 'Ipswich': 'IPS', 'Leeds': 'LEE', 'Leicester': 'LEI',
  'Liverpool': 'LIV', 'Luton': 'LUT', 'Manchester City': 'MCI', 'Manchester United': 'MUN',
  'Middlesbrough': 'MID', 'Newcastle': 'NEW', 'Norwich': 'NOR', 'Nottingham Forest': 'NFO',
  'Sheffield Utd': 'SHU', 'Southampton': 'SOU', 'Sunderland': 'SUN', 'Tottenham': 'TOT',
  'Watford': 'WAT', 'West Brom': 'WBA', 'West Ham': 'WHU', 'Wolves': 'WOL',
  'Coventry': 'COV', 'Hull City': 'HUL', 'Millwall': 'MIL', 'Stoke City': 'STK',
};

const shortName = (name = '') =>
  SHORT_NAMES[name] || name.replace(/[^A-Za-z ]/g, '').trim().slice(0, 3).toUpperCase() || '???';

const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP']);
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'CANC', 'ABD', 'AWD', 'WO', 'PST']);

function currentSeason(now = new Date()) {
  // Premier League seasons start in August and are named by their first year.
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

class ApiFootball {
  constructor({ key, season, log = console } = {}) {
    this.key = key;
    this.season = Number(season) || currentSeason();
    this.log = log;
    this.remaining = null; // requests left today, from the API's headers
  }

  get configured() { return !!this.key; }

  async get(path, params = {}) {
    const url = new URL(BASE + path);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const res = await fetch(url, {
      headers: { 'x-apisports-key': this.key },
      signal: AbortSignal.timeout(12000),
    });
    const left = res.headers.get('x-ratelimit-requests-remaining');
    if (left != null) this.remaining = Number(left);
    if (!res.ok) throw new Error(`API-Football ${path} returned ${res.status}`);
    const body = await res.json();
    const errors = body.errors && (Array.isArray(body.errors) ? body.errors : Object.values(body.errors));
    if (errors && errors.length) throw new Error(`API-Football ${path}: ${errors.join('; ')}`);
    return body.response || [];
  }

  // Premier League fixtures from yesterday to a week ahead.
  async fixtures(now = new Date()) {
    const day = (offset) => new Date(now.getTime() + offset * 864e5).toISOString().slice(0, 10);
    const list = await this.get('/fixtures', {
      league: PREMIER_LEAGUE, season: this.season, from: day(-1), to: day(7), timezone: 'UTC',
    });
    return list.map(summarizeFixture);
  }

  async fixture(id) {
    const [raw] = await this.get('/fixtures', { id });
    if (!raw) throw new Error(`Fixture ${id} not found`);
    return normalizeFixture(raw);
  }

  async liveOdds(id, fixture) {
    const [raw] = await this.get('/odds/live', { fixture: id });
    return raw ? normalizeLiveOdds(raw, fixture) : null;
  }

  async preMatchOdds(id, fixture) {
    const [raw] = await this.get('/odds', { fixture: id });
    return raw ? normalizePreMatchOdds(raw, fixture) : null;
  }
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------
function summarizeFixture(raw) {
  return {
    id: String(raw.fixture.id),
    kickoff: raw.fixture.date,
    round: raw.league?.round || '',
    status: {
      short: raw.fixture.status?.short || 'NS',
      elapsed: raw.fixture.status?.elapsed ?? null,
    },
    home: { name: raw.teams.home.name, short: shortName(raw.teams.home.name), goals: raw.goals?.home ?? null },
    away: { name: raw.teams.away.name, short: shortName(raw.teams.away.name), goals: raw.goals?.away ?? null },
  };
}

const STAT_KEYS = {
  'Ball Possession': 'possession',
  'Total Shots': 'shots',
  'Shots on Goal': 'shotsOn',
  'Shots off Goal': 'shotsOff',
  'Blocked Shots': 'blocked',
  'Corner Kicks': 'corners',
  'Fouls': 'fouls',
  'Offsides': 'offsides',
  'Yellow Cards': 'yellow',
  'Red Cards': 'red',
  'Goalkeeper Saves': 'saves',
  'Total passes': 'passes',
  'Passes %': 'passPct',
  'expected_goals': 'xg',
};

function statNumber(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeStats(raw, homeId) {
  if (!Array.isArray(raw.statistics) || !raw.statistics.length) return null;
  const out = { home: {}, away: {} };
  raw.statistics.forEach((block) => {
    const side = block.team?.id === homeId ? 'home' : 'away';
    (block.statistics || []).forEach(({ type, value }) => {
      const key = STAT_KEYS[type];
      if (key) out[side][key] = statNumber(value);
    });
  });
  // Cards are often missing (null) rather than 0.
  ['home', 'away'].forEach((s) => {
    ['yellow', 'red'].forEach((k) => { if (out[s][k] == null) out[s][k] = 0; });
  });
  return out;
}

function eventType(type = '', detail = '') {
  const t = type.toLowerCase();
  const d = detail.toLowerCase();
  if (t === 'goal') {
    if (d.includes('own')) return 'owngoal';
    if (d.includes('missed')) return 'misspen';
    if (d.includes('penalty')) return 'penalty';
    return 'goal';
  }
  if (t === 'card') {
    if (d.includes('red') || d.includes('second yellow')) return 'red';
    return 'yellow';
  }
  if (t === 'subst') return 'sub';
  if (t === 'var') return 'var';
  return 'other';
}

function normalizeEvents(raw, homeId) {
  return (raw.events || []).map((e) => {
    const minute = e.time?.elapsed ?? 0;
    const extra = e.time?.extra ?? null;
    const team = e.team?.id === homeId ? 'home' : 'away';
    const type = eventType(e.type, e.detail);
    return {
      key: [type, minute, extra, team, e.player?.id || e.player?.name || '', e.assist?.id || ''].join('|'),
      minute, extra, team, type,
      player: e.player?.name || null,
      assist: e.assist?.name || null,
      detail: e.detail || '',
    };
  }).filter((e) => e.type !== 'other');
}

function normalizeLineups(raw, homeId) {
  if (!Array.isArray(raw.lineups) || !raw.lineups.length) return null;
  const out = {};
  raw.lineups.forEach((l) => {
    const side = l.team?.id === homeId ? 'home' : 'away';
    const player = ({ player: p }) => ({ name: p.name, number: p.number, pos: p.pos });
    out[side] = {
      formation: l.formation || '',
      coach: l.coach?.name || '',
      xi: (l.startXI || []).map(player),
      subs: (l.substitutes || []).map(player),
    };
  });
  return out.home && out.away ? out : null;
}

function normalizeFixture(raw) {
  const homeId = raw.teams.home.id;
  const venue = [raw.fixture.venue?.name, raw.fixture.venue?.city].filter(Boolean).join(', ');
  return {
    id: String(raw.fixture.id),
    source: 'api-football',
    league: { name: raw.league?.name || 'Premier League', round: raw.league?.round || '' },
    kickoff: raw.fixture.date,
    venue,
    referee: raw.fixture.referee || '',
    status: {
      short: raw.fixture.status?.short || 'NS',
      long: raw.fixture.status?.long || '',
      elapsed: raw.fixture.status?.elapsed ?? null,
      extra: raw.fixture.status?.extra ?? null,
    },
    home: { name: raw.teams.home.name, short: shortName(raw.teams.home.name), goals: raw.goals?.home ?? 0 },
    away: { name: raw.teams.away.name, short: shortName(raw.teams.away.name), goals: raw.goals?.away ?? 0 },
    stats: normalizeStats(raw, homeId),
    events: normalizeEvents(raw, homeId),
    lineups: normalizeLineups(raw, homeId),
  };
}

// ---- Odds ----
const MARKET_MATCHERS = [
  { key: 'result', name: 'Full-time result', re: /^(match winner|fulltime result|full time result|1x2)$/i },
  { key: 'next', name: 'Next goal', re: /next goal|to score next|which team will score/i },
  { key: 'total', name: 'Total goals', re: /^(goals over\/under|over\/under line|over\/under|match goals)$/i },
  { key: 'btts', name: 'Both teams to score', re: /^both teams (to )?score$/i },
];

function labelFor(value, fixture) {
  const v = String(value).trim();
  if (/^(home|1)$/i.test(v)) return { key: 'home', label: fixture?.home.name || 'Home' };
  if (/^(away|2)$/i.test(v)) return { key: 'away', label: fixture?.away.name || 'Away' };
  if (/^(draw|x)$/i.test(v)) return { key: 'draw', label: 'Draw' };
  if (/^no ?goal$/i.test(v)) return { key: 'none', label: 'No more goals' };
  return { key: v.toLowerCase(), label: v };
}

const toOdd = (o) => { const n = parseFloat(o); return Number.isFinite(n) && n > 1 ? n : null; };

// Pick one over/under line: the bookmaker's "main" line if marked, else 2.5, else the first.
function pickTotalLine(values) {
  const withLine = values.map((v) => {
    const m = String(v.value).match(/(over|under)\s*([\d.]+)?/i);
    const line = parseFloat(v.handicap ?? (m && m[2]));
    return m ? { side: m[1].toLowerCase(), line, odd: toOdd(v.odd), main: v.main, suspended: !!v.suspended } : null;
  }).filter((v) => v && Number.isFinite(v.line) && v.odd);
  if (!withLine.length) return null;
  const main = withLine.find((v) => v.main === true);
  const line = main ? main.line : withLine.some((v) => v.line === 2.5) ? 2.5 : withLine[0].line;
  const pair = ['over', 'under'].map((side) => withLine.find((v) => v.side === side && v.line === line)).filter(Boolean);
  if (pair.length < 2) return null;
  return {
    key: 'total', name: `Total goals ${line}`,
    values: pair.map((v) => ({ key: v.side, label: `${v.side === 'over' ? 'Over' : 'Under'} ${line}`, odd: v.odd, suspended: v.suspended })),
  };
}

function buildMarkets(bets, fixture) {
  const markets = [];
  MARKET_MATCHERS.forEach((m) => {
    const bet = bets.find((b) => m.re.test(String(b.name || '').trim()));
    if (!bet || !Array.isArray(bet.values)) return;
    if (m.key === 'total') {
      const t = pickTotalLine(bet.values);
      if (t) markets.push(t);
      return;
    }
    const values = bet.values
      .map((v) => ({ ...labelFor(v.value, fixture), odd: toOdd(v.odd), suspended: !!v.suspended }))
      .filter((v) => v.odd);
    if (values.length >= 2) markets.push({ key: m.key, name: m.name, values });
  });
  return markets;
}

function normalizeLiveOdds(raw, fixture) {
  const markets = buildMarkets(raw.odds || [], fixture);
  if (!markets.length) return null;
  const s = raw.status || {};
  return {
    live: true,
    suspended: !!(s.stopped || s.blocked),
    finished: !!s.finished,
    updatedAt: raw.update || new Date().toISOString(),
    markets,
  };
}

function normalizePreMatchOdds(raw, fixture) {
  const bookmakers = raw.bookmakers || [];
  // Prefer a big, widely known bookmaker if present; otherwise the first one.
  const book = bookmakers.find((b) => /bet365|william hill|pinnacle|betfair/i.test(b.name)) || bookmakers[0];
  if (!book) return null;
  const markets = buildMarkets(book.bets || [], fixture);
  if (!markets.length) return null;
  return {
    live: false,
    suspended: false,
    finished: false,
    bookmaker: book.name,
    updatedAt: raw.update || new Date().toISOString(),
    markets,
  };
}

module.exports = {
  ApiFootball,
  LIVE_STATUSES,
  FINISHED_STATUSES,
  shortName,
  currentSeason,
  _internals: { normalizeFixture, normalizeLiveOdds, normalizePreMatchOdds, summarizeFixture },
};
