'use strict';
// Demo match: a simulated game between two fictional clubs, sped up so a full
// match takes a few minutes. It produces data in exactly the same format as the
// live provider, so every part of the dashboard can be tried without an API key.

const FIRST = ['Alex', 'Ben', 'Callum', 'Danny', 'Eli', 'Finn', 'George', 'Harvey', 'Isaac', 'Jack',
  'Kai', 'Leo', 'Mason', 'Noah', 'Owen', 'Rhys', 'Sam', 'Theo', 'Tom', 'Zac', 'Jordan', 'Luca'];
const LAST = ['Ashworth', 'Barnes', 'Carver', 'Doyle', 'Ellison', 'Fenwick', 'Garner', 'Hollis',
  'Ingram', 'Jessop', 'Keane', 'Lowther', 'Mabry', 'Norbury', 'Okafor', 'Pryce', 'Quarry', 'Radley',
  'Stokes', 'Thorne', 'Upton', 'Vance', 'Whitlock', 'Yardley', 'Ziegler', 'Mensah', 'Costa', 'Silva'];

const TEAMS = [
  { name: 'Northbridge United', short: 'NBU', attack: 1.15, coach: 'Graham Holt', formation: '4-3-3' },
  { name: 'Riverside City', short: 'RVC', attack: 1.0, coach: 'Marta Reyes', formation: '4-2-3-1' },
];
const SHAPE = { '4-3-3': 'GDDDDMMMFFF', '4-2-3-1': 'GDDDDMMMMMF' };

const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeSquad(team, used) {
  const name = () => {
    let n;
    do { n = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(n));
    used.add(n);
    return n;
  };
  const shape = SHAPE[team.formation];
  const xi = [...shape].map((pos, i) => ({ name: name(), number: i === 0 ? 1 : i + 1, pos }));
  const subs = ['G', 'D', 'D', 'M', 'M', 'F', 'F'].map((pos, i) => ({ name: name(), number: 12 + i, pos }));
  return { xi, subs };
}

// ---------- Odds model (Poisson goals for the time remaining) ----------
function poisson(lambda, maxGoals = 10) {
  const p = [];
  let term = Math.exp(-lambda);
  for (let k = 0; k <= maxGoals; k++) {
    p.push(term);
    term = (term * lambda) / (k + 1);
  }
  return p;
}
const toOdds = (p, margin = 1.06) => Math.round(clamp(1 / Math.max(p * margin, 1e-4), 1.01, 101) * 100) / 100;

function modelOdds(m, teams = TEAMS) {
  const minutesLeft = Math.max(0, 93 - m.minute);
  const factor = (side) => teams[side === 'home' ? 0 : 1].attack * 0.75 ** m.stats[side].red;
  const lh = 1.35 * factor('home') * (minutesLeft / 93);
  const la = 1.35 * factor('away') * (minutesLeft / 93);
  const ph = poisson(lh), pa = poisson(la);
  const gh = m.goals.home, ga = m.goals.away;
  let home = 0, draw = 0, away = 0;
  ph.forEach((x, i) => pa.forEach((y, j) => {
    const d = gh + i - (ga + j);
    if (d > 0) home += x * y; else if (d < 0) away += x * y; else draw += x * y;
  }));

  const markets = [{
    key: 'result', name: 'Full-time result',
    values: [
      { key: 'home', label: teams[0].name, odd: toOdds(home) },
      { key: 'draw', label: 'Draw', odd: toOdds(draw) },
      { key: 'away', label: teams[1].name, odd: toOdds(away) },
    ],
  }];

  const lt = lh + la;
  if (m.status !== 'NS' && lt > 0.05) {
    const none = Math.exp(-lt);
    markets.push({
      key: 'next', name: 'Next goal',
      values: [
        { key: 'home', label: teams[0].name, odd: toOdds((1 - none) * (lh / lt)) },
        { key: 'none', label: 'No more goals', odd: toOdds(none) },
        { key: 'away', label: teams[1].name, odd: toOdds((1 - none) * (la / lt)) },
      ],
    });
  }

  const current = gh + ga;
  const line = Math.max(0.5, Math.floor(current + lt) + 0.5);
  const need = Math.ceil(line - current); // goals still needed for "over"
  const pt = poisson(lt);
  const under = pt.slice(0, need).reduce((s, x) => s + x, 0);
  if (under > 0.02 && under < 0.98) {
    markets.push({
      key: 'total', name: `Total goals ${line}`,
      values: [
        { key: 'over', label: `Over ${line}`, odd: toOdds(1 - under) },
        { key: 'under', label: `Under ${line}`, odd: toOdds(under) },
      ],
    });
  }

  if (!(gh > 0 && ga > 0)) {
    const homeScores = gh > 0 ? 1 : 1 - ph[0];
    const awayScores = ga > 0 ? 1 : 1 - pa[0];
    const yes = homeScores * awayScores;
    if (yes > 0.02 && yes < 0.98) {
      markets.push({
        key: 'btts', name: 'Both teams to score',
        values: [{ key: 'yes', label: 'Yes', odd: toOdds(yes) }, { key: 'no', label: 'No', odd: toOdds(1 - yes) }],
      });
    }
  }
  return markets;
}

// ---------- The match ----------
class DemoMatch {
  constructor({ id, secondsPerMinute = 4, onUpdate = () => {} } = {}) {
    this.id = id;
    this.secondsPerMinute = secondsPerMinute;
    this.onUpdate = onUpdate;
    const used = new Set();
    this.squads = { home: makeSquad(TEAMS[0], used), away: makeSquad(TEAMS[1], used) };
    this.onPitch = { home: [...this.squads.home.xi], away: [...this.squads.away.xi] };
    this.bench = { home: [...this.squads.home.subs], away: [...this.squads.away.subs] };
    this.subsMade = { home: 0, away: 0 };
    this.subPlan = {
      home: [Math.round(rand(56, 66)), Math.round(rand(67, 76)), Math.round(rand(77, 85))],
      away: [Math.round(rand(55, 65)), Math.round(rand(66, 75)), Math.round(rand(76, 86))],
    };
    this.kickoff = new Date(Date.now() + 2 * secondsPerMinute * 1000).toISOString();
    this.status = 'NS';
    this.minute = 0;          // match clock (used by the odds model)
    this.elapsed = null;      // what the scoreboard shows
    this.extra = null;        // stoppage-time minutes shown as 45+2
    this.stoppage = { first: Math.round(rand(1, 4)), second: Math.round(rand(3, 6)) };
    this.phaseTicks = 0;
    this.goals = { home: 0, away: 0 };
    const blank = () => ({
      possession: 50, shots: 0, shotsOn: 0, shotsOff: 0, blocked: 0, corners: 0, fouls: 0,
      offsides: 0, yellow: 0, red: 0, saves: 0, passes: 0, passOk: 0, xg: 0,
    });
    this.stats = { home: blank(), away: blank() };
    this.possession = 54;
    this.events = [];
    this.suspendTicks = 0;
    this.pendingVar = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.emit();
    this.timer = setInterval(() => this.tick(), this.secondsPerMinute * 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  emit() { this.onUpdate(this.fixture(), this.odds()); }

  // Advance one match minute.
  tick() {
    this.phaseTicks++;
    if (this.suspendTicks > 0) this.suspendTicks--;

    switch (this.status) {
      case 'NS':
        if (this.phaseTicks >= 2) this.setPhase('1H', 1);
        break;
      case '1H':
        this.advanceClock(45, this.stoppage.first, 'HT');
        break;
      case 'HT':
        if (this.phaseTicks >= 5) this.setPhase('2H', 46);
        break;
      case '2H':
        this.advanceClock(90, this.stoppage.second, 'FT');
        break;
      default:
        break;
    }
    if (this.status === '1H' || this.status === '2H') this.play();
    this.emit();
    if (this.status === 'FT') this.stop();
  }

  setPhase(status, minute) {
    this.status = status;
    this.phaseTicks = 0;
    if (minute != null) { this.minute = minute; this.elapsed = minute; this.extra = null; }
    if (status === 'HT' || status === 'FT') this.extra = null;
  }

  advanceClock(regulation, stoppage, next) {
    if (this.phaseTicks === 0) return;
    if (this.elapsed < regulation) {
      this.elapsed++;
      this.minute++;
    } else if ((this.extra || 0) < stoppage) {
      this.extra = (this.extra || 0) + 1;
      this.minute++;
    } else {
      this.setPhase(next);
    }
  }

  play() {
    // A VAR check on the previous minute's goal.
    if (this.pendingVar) {
      const { side } = this.pendingVar;
      this.pendingVar = null;
      if (chance(0.25)) {
        this.goals[side]--;
        this.addEvent(side, 'var', null, null, 'Goal cancelled');
        this.suspendTicks = 2;
      }
    }

    // Possession drifts around a slight home advantage.
    this.possession = clamp(this.possession + rand(-3, 3) + (54 - this.possession) * 0.15, 34, 70);
    this.stats.home.possession = Math.round(this.possession);
    this.stats.away.possession = 100 - this.stats.home.possession;

    ['home', 'away'].forEach((side, i) => {
      const s = this.stats[side];
      const other = side === 'home' ? 'away' : 'home';
      const share = s.possession / 50;
      const attack = TEAMS[i].attack * 0.75 ** s.red;

      const passes = Math.round(rand(4.5, 6.5) * share);
      s.passes += passes;
      s.passOk += Math.round(passes * rand(side === 'home' ? 0.8 : 0.76, side === 'home' ? 0.9 : 0.86));

      if (chance(0.105 * attack * Math.sqrt(share))) this.shot(side, other);
      if (chance(0.055 * attack)) s.corners++;
      if (chance(0.12)) this.stats[other].fouls++;
      if (chance(0.025)) s.offsides++;
      if (chance(0.016 + this.minute * 0.0001)) this.card(other, 'yellow');
      if (chance(0.0006)) this.card(other, 'red');
      if (this.subsMade[side] < 3 && this.minute >= this.subPlan[side][this.subsMade[side]]) this.sub(side);
    });
  }

  shot(side, other) {
    const s = this.stats[side];
    s.shots++;
    const penalty = chance(0.015);
    const xg = penalty ? 0.76 : 0.02 + Math.random() ** 3 * 0.42; // averages ~0.12, like real shots
    s.xg = Math.round((s.xg + xg) * 100) / 100;
    const shooter = this.pickPlayer(side, { F: 5, M: 3, D: 1 });
    const assister = chance(0.7) ? this.pickPlayer(side, { F: 2, M: 4, D: 2 }, shooter) : null;

    if (chance(xg)) {
      s.shotsOn++;
      this.goals[side]++;
      this.addEvent(side, penalty ? 'penalty' : 'goal', shooter.name, penalty ? null : assister?.name,
        penalty ? 'Penalty' : 'Normal Goal');
      this.suspendTicks = 2;
      if (!penalty && chance(0.08)) this.pendingVar = { side };
    } else if (penalty) {
      s.shotsOn++;
      this.stats[other].saves++;
      this.addEvent(side, 'misspen', shooter.name, null, 'Missed Penalty');
    } else {
      const r = Math.random();
      if (r < 0.32) { s.shotsOn++; this.stats[other].saves++; }
      else if (r < 0.75) s.shotsOff++;
      else s.blocked++;
    }
  }

  card(side, colour) {
    const player = this.pickPlayer(side, { D: 4, M: 3, F: 1 });
    if (!player) return;
    const already = this.events.some((e) => e.type === 'yellow' && e.player === player.name && e.team === side);
    const secondYellow = colour === 'yellow' && already;
    if (secondYellow) colour = 'red';
    this.stats[side][colour]++;
    this.addEvent(side, colour, player.name, null,
      colour === 'red' ? (secondYellow ? 'Second Yellow card' : 'Red Card') : 'Yellow Card');
    if (colour === 'red') {
      this.onPitch[side] = this.onPitch[side].filter((p) => p !== player);
      this.suspendTicks = 2;
    }
  }

  sub(side) {
    this.subsMade[side]++;
    const off = this.pickPlayer(side, { F: 4, M: 4, D: 1 });
    const on = this.bench[side].find((p) => p.pos === off?.pos && p.pos !== 'G') ||
      this.bench[side].find((p) => p.pos !== 'G');
    if (!off || !on) return;
    this.onPitch[side] = this.onPitch[side].map((p) => (p === off ? on : p));
    this.bench[side] = this.bench[side].filter((p) => p !== on);
    this.addEvent(side, 'sub', off.name, on.name, `Substitution ${this.subsMade[side]}`);
  }

  pickPlayer(side, weights, exclude) {
    const pool = this.onPitch[side].filter((p) => p !== exclude && p.pos !== 'G');
    const total = pool.reduce((s, p) => s + (weights[p.pos] || 0), 0);
    let r = Math.random() * total;
    for (const p of pool) { r -= weights[p.pos] || 0; if (r <= 0) return p; }
    return pool[0] || null;
  }

  addEvent(team, type, player, assist, detail) {
    const minute = this.elapsed;
    const extra = this.extra;
    this.events.push({
      key: [type, minute, extra, team, player || '', assist || '', this.events.length].join('|'),
      minute, extra, team, type, player, assist, detail,
    });
  }

  fixture() {
    const stats = this.status === 'NS' ? null : Object.fromEntries(['home', 'away'].map((side) => {
      const { passOk, ...s } = this.stats[side];
      return [side, { ...s, passPct: s.passes ? Math.round((passOk / s.passes) * 100) : null }];
    }));
    const lineup = (side, i) => ({
      formation: TEAMS[i].formation, coach: TEAMS[i].coach, xi: this.squads[side].xi, subs: this.squads[side].subs,
    });
    const LONG = { NS: 'Not Started', '1H': 'First Half', HT: 'Halftime', '2H': 'Second Half', FT: 'Match Finished' };
    return {
      id: this.id,
      source: 'demo',
      league: { name: 'Demo match', round: 'Simulated · fictional clubs' },
      kickoff: this.kickoff,
      venue: 'Harbour Lane, Northbridge',
      referee: 'P. Ashdown',
      status: { short: this.status, long: LONG[this.status], elapsed: this.elapsed, extra: this.extra },
      home: { name: TEAMS[0].name, short: TEAMS[0].short, goals: this.goals.home },
      away: { name: TEAMS[1].name, short: TEAMS[1].short, goals: this.goals.away },
      stats,
      events: this.events.map((e) => ({ ...e })),
      lineups: { home: lineup('home', 0), away: lineup('away', 1) },
    };
  }

  odds() {
    if (this.status === 'FT') return null;
    return {
      live: this.status !== 'NS',
      suspended: this.suspendTicks > 0,
      finished: false,
      bookmaker: this.status === 'NS' ? 'Demo odds' : undefined,
      updatedAt: new Date().toISOString(),
      markets: modelOdds(this),
    };
  }
}

module.exports = { DemoMatch, DEMO_TEAMS: TEAMS, _internals: { modelOdds, poisson } };
