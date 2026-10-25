'use strict';
// Replay: plays back a finished Premier League match through the match centre
// as if it were live. Uses one request for the season's fixture list and one for
// the match itself (both cached), so it works on API-Football's free plan, which
// covers past seasons only.
//
// What's real: score, goals, cards, subs, VAR (each revealed at its minute),
// lineups, venue, referee, and the final stats.
// What's approximated: counting stats (shots, corners…) climb evenly through
// the replay, because only full-time stats are kept for old matches; odds are
// modelled from the score and time, because old odds aren't kept either.

const { _internals: { normalizeFixture } } = require('./api-football');
const { _internals: { modelOdds } } = require('./demo');

const REPLAY_SEASONS = [2024, 2023, 2022];
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const rawCache = new Map(); // fixture id -> raw API response (finished matches never change)

const COUNT_STATS = ['shots', 'shotsOn', 'shotsOff', 'blocked', 'corners', 'fouls', 'offsides', 'saves', 'passes'];

function seasonLabel(season) {
  return `${season}/${String(season + 1).slice(2)}`;
}

// Order events (and the clock) on one line, keeping first-half stoppage time
// before the second half: 45+3' comes before 46'.
const timeIndex = (minute, extra, secondHalf) =>
  (secondHalf ? 1000 : 0) + minute + (extra || 0) / 100;
const eventIndex = (e) => timeIndex(e.minute, e.extra, e.minute > 45);

class ReplayMatch {
  constructor({ id, fixtureId, api, secondsPerMinute = 4, onUpdate = () => {}, onError = () => {} }) {
    Object.assign(this, { id, fixtureId, api, secondsPerMinute, onUpdate, onError });
    this.status = 'NS';
    this.elapsed = null;
    this.extra = null;
    this.minute = 0;
    this.phaseTicks = 0;
    this.timer = null;
  }

  async start() {
    try {
      if (!rawCache.has(this.fixtureId)) rawCache.set(this.fixtureId, await this.api.rawFixture(this.fixtureId));
    } catch (err) {
      this.onError(err);
      return;
    }
    this.full = normalizeFixture(rawCache.get(this.fixtureId));
    this.fixOwnGoalTeams();
    const lastExtra = (half) => Math.max(0, ...this.full.events
      .filter((e) => e.minute === (half === 1 ? 45 : 90)).map((e) => e.extra || 0));
    this.stoppage = { first: Math.max(2, lastExtra(1)), second: Math.max(3, lastExtra(2)) };
    this.teams = [{ name: this.full.home.name, attack: 1.1 }, { name: this.full.away.name, attack: 1.0 }];
    this.emit();
    this.timer = setInterval(() => this.tick(), this.secondsPerMinute * 1000);
  }

  // Own goals: the rest of the app treats an own goal's team as the scorer's
  // team (so the goal counts for the other side). If the data means the team
  // that benefits instead, the official final score tells us; flip them.
  fixOwnGoalTeams() {
    const f = this.full;
    const total = (ogForOther) => {
      const g = { home: 0, away: 0 };
      f.events.forEach((e) => {
        if (e.type === 'goal' || e.type === 'penalty') g[e.team]++;
        if (e.type === 'owngoal') g[ogForOther ? (e.team === 'home' ? 'away' : 'home') : e.team]++;
      });
      return g.home === f.home.goals && g.away === f.away.goals;
    };
    if (!total(true) && total(false)) {
      f.events.forEach((e) => { if (e.type === 'owngoal') e.team = e.team === 'home' ? 'away' : 'home'; });
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  emit() { this.onUpdate(this.fixture(), this.odds()); }

  // Same clock as the demo match: kick-off, first half + stoppage, half-time, second half + stoppage, full time.
  tick() {
    this.phaseTicks++;
    if (this.status === 'NS' && this.phaseTicks >= 2) this.setPhase('1H', 1);
    else if (this.status === '1H') this.advance(45, this.stoppage.first, 'HT');
    else if (this.status === 'HT' && this.phaseTicks >= 5) this.setPhase('2H', 46);
    else if (this.status === '2H') this.advance(90, this.stoppage.second, 'FT');
    this.emit();
    if (this.status === 'FT') this.stop();
  }

  setPhase(status, minute) {
    this.status = status;
    this.phaseTicks = 0;
    if (minute != null) { this.minute = minute; this.elapsed = minute; this.extra = null; }
    if (status === 'HT' || status === 'FT') this.extra = null;
  }

  advance(regulation, stoppage, next) {
    if (this.elapsed < regulation) { this.elapsed++; this.minute++; }
    else if ((this.extra || 0) < stoppage) { this.extra = (this.extra || 0) + 1; this.minute++; }
    else this.setPhase(next);
  }

  clockIndex() {
    if (this.status === 'NS') return -1;
    if (this.status === 'HT') return timeIndex(45, 99, false);
    if (this.status === 'FT') return Infinity;
    return timeIndex(this.elapsed, this.extra, this.status === '2H');
  }

  progress() {
    if (this.status === 'NS') return 0;
    if (this.status === 'FT') return 1;
    if (this.status === 'HT') return 0.5;
    return Math.min(this.elapsed, 90) / 90;
  }

  fixture() {
    const f = this.full;
    const now = this.clockIndex();
    const events = f.events.filter((e) => eventIndex(e) <= now);

    // Score from the goals revealed so far (own goals count for the other side).
    const goals = { home: 0, away: 0 };
    events.forEach((e) => {
      if (e.type === 'goal' || e.type === 'penalty') goals[e.team]++;
      if (e.type === 'owngoal') goals[e.team === 'home' ? 'away' : 'home']++;
    });
    if (this.status === 'FT') { goals.home = f.home.goals; goals.away = f.away.goals; }

    let stats = null;
    if (f.stats && this.status !== 'NS') {
      const p = this.progress();
      stats = {};
      ['home', 'away'].forEach((side) => {
        const fin = f.stats[side];
        const s = { ...fin };
        COUNT_STATS.forEach((k) => { if (fin[k] != null) s[k] = Math.round(fin[k] * p); });
        if (fin.xg != null) s.xg = Math.round(fin.xg * p * 100) / 100;
        // Shots on target can't be fewer than goals scored.
        if (s.shotsOn != null) s.shotsOn = Math.max(s.shotsOn, goals[side]);
        s.yellow = events.filter((e) => e.type === 'yellow' && e.team === side).length;
        s.red = events.filter((e) => e.type === 'red' && e.team === side).length;
        stats[side] = s;
      });
    }

    const LONG = { NS: 'Not Started', '1H': 'First Half', HT: 'Halftime', '2H': 'Second Half', FT: 'Match Finished' };
    const date = new Date(f.kickoff);
    return {
      ...f,
      id: this.id,
      source: 'replay',
      league: {
        name: 'Replay',
        round: `Replay · ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} · ${f.league.round.replace('Regular Season - ', 'Matchweek ')}`,
      },
      kickoff: date.toISOString(),
      status: { short: this.status, long: LONG[this.status], elapsed: this.elapsed, extra: this.extra },
      home: { ...f.home, goals: goals.home },
      away: { ...f.away, goals: goals.away },
      events,
      stats,
    };
  }

  odds() {
    if (this.status === 'FT') return null;
    const f = this.fixture();
    const model = {
      minute: this.minute,
      status: this.status,
      goals: { home: f.home.goals, away: f.away.goals },
      stats: { home: { red: f.stats?.home.red || 0 }, away: { red: f.stats?.away.red || 0 } },
    };
    return {
      live: this.status !== 'NS',
      suspended: false,
      finished: false,
      bookmaker: 'Modelled for the replay',
      modelled: true,
      updatedAt: new Date().toISOString(),
      markets: modelOdds(model, this.teams),
    };
  }
}

module.exports = { ReplayMatch, REPLAY_SEASONS, FINISHED, seasonLabel };
