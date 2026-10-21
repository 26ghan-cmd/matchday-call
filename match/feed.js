'use strict';
// Turns successive match snapshots into a written play-by-play feed, and writes
// short analysis paragraphs from the stats. Everything here is based only on the
// data we receive: we never invent incidents the data doesn't show.

const MAX_LINES = 250;
const PLAYING = new Set(['1H', '2H', 'ET']);

const minuteLabel = (minute, extra) =>
  minute == null ? '' : extra ? `${minute}+${extra}'` : `${minute}'`;

const teamName = (snap, side) => snap[side].name;
const other = (side) => (side === 'home' ? 'away' : 'home');
const scoreLine = (s) => `${s.home.name} ${s.home.goals}–${s.away.goals} ${s.away.name}`;
const plural = (n, word) => (n === 1 ? `a ${word}` : `${n} ${word}s`);
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);

class Feed {
  constructor() {
    this.lines = [];
    this.prev = null;
    this.seen = new Set();
    this.reds = { home: 0, away: 0 };
    this.nextId = 1;
    this.lastAnalysisMinute = 0;
  }

  add(line) {
    const full = { id: this.nextId++, ts: Date.now(), team: null, ...line };
    this.lines.push(full);
    if (this.lines.length > MAX_LINES) this.lines.shift();
    return full;
  }

  // Compare the new snapshot with the previous one. Returns the reasons (if any)
  // to write a fresh analysis, e.g. ['goal'] or ['halftime'].
  update(snap) {
    const prev = this.prev;
    const triggers = [];
    const now = minuteLabel(snap.status.elapsed, snap.status.extra);
    const st = snap.status.short;

    if (!prev) {
      // First look at this match. If it's already under way, tell the story so far.
      if (st === 'NS' || st === 'TBD') {
        this.add({ kind: 'info', minute: '', text: `Pre-match: ${snap.home.name} v ${snap.away.name}${snap.venue ? ` at ${snap.venue}` : ''}. Kick-off is coming up.` });
      }
      snap.events.forEach((e) => this.eventLine(e, snap, { backfill: true }));
      if (PLAYING.has(st) || st === 'HT') {
        this.add({ kind: 'info', minute: st === 'HT' ? 'HT' : now, text: `Joining live. ${scoreLine(snap)}.` });
      }
      if (snap.status.elapsed) this.lastAnalysisMinute = snap.status.elapsed;
      if (st === 'FT' || st === 'AET' || st === 'PEN') this.add({ kind: 'phase', minute: 'FT', text: `Full-time: ${scoreLine(snap)}.` });
      this.prev = snap;
      return triggers;
    }

    // Phase changes
    const ps = prev.status.short;
    if (ps !== st) {
      if ((ps === 'NS' || ps === 'TBD') && st === '1H') {
        this.add({ kind: 'phase', minute: "1'", text: `Kick-off! ${snap.home.name} v ${snap.away.name} is under way${snap.referee ? `, with ${snap.referee} refereeing` : ''}.` });
      } else if (st === 'HT') {
        this.add({ kind: 'phase', minute: 'HT', text: `Half-time: ${scoreLine(snap)}.` });
        triggers.push('halftime');
      } else if (st === '2H') {
        this.add({ kind: 'phase', minute: "46'", text: 'The second half is under way.' });
      } else if (st === 'ET') {
        this.add({ kind: 'phase', minute: now, text: 'Extra time begins.' });
      } else if (st === 'P') {
        this.add({ kind: 'phase', minute: '', text: "It's going to penalties." });
      } else if (st === 'FT' || st === 'AET' || st === 'PEN') {
        this.add({ kind: 'phase', minute: 'FT', text: `Full-time: ${scoreLine(snap)}.` });
        triggers.push('fulltime');
      } else if (st === 'SUSP' || st === 'INT') {
        this.add({ kind: 'info', minute: now, text: 'Play has been stopped.' });
      }
    }

    // New events (goals, cards, subs, VAR)
    const newEvents = snap.events.filter((e) => !this.seen.has(e.key));
    newEvents.forEach((e) => {
      const reason = this.eventLine(e, snap, { backfill: false });
      if (reason && !triggers.includes(reason)) triggers.push(reason);
    });

    // Chances, saves and corners, worked out from changes in the stats.
    if (PLAYING.has(st) && prev.stats && snap.stats) {
      ['home', 'away'].forEach((side) => this.statLines(side, prev, snap, now));
    }

    // A regular analysis every 15 minutes of play.
    const m = snap.status.elapsed || 0;
    if (PLAYING.has(st) && m - this.lastAnalysisMinute >= 15 && !triggers.length) triggers.push('interval');
    if (triggers.length) this.lastAnalysisMinute = m;

    this.prev = snap;
    return triggers;
  }

  eventLine(e, snap, { backfill }) {
    this.seen.add(e.key);
    const team = teamName(snap, e.team);
    const minute = minuteLabel(e.minute, e.extra);
    const score = backfill ? '' : ` ${scoreLine(snap)}.`;
    const base = { minute, team: e.team };
    switch (e.type) {
      case 'goal':
        this.add({ ...base, kind: 'goal', text: `GOAL! ${e.player || team} scores for ${team}${e.assist ? `, set up by ${e.assist}` : ''}.${score}` });
        return 'goal';
      case 'penalty':
        this.add({ ...base, kind: 'goal', text: `GOAL! ${e.player || team} scores from the penalty spot for ${team}.${score}` });
        return 'goal';
      case 'owngoal':
        this.add({ ...base, kind: 'goal', text: `OWN GOAL! ${e.player ? `${e.player} puts it into his own net` : 'An own goal'}.${score}` });
        return 'goal';
      case 'misspen':
        this.add({ ...base, kind: 'miss', text: `Penalty missed! ${e.player || team} fails to score from the spot for ${team}.` });
        return backfill ? null : 'miss';
      case 'yellow':
        this.add({ ...base, kind: 'yellow', text: `Yellow card: ${e.player || 'a player'} (${team}).` });
        return null;
      case 'red': {
        this.reds[e.team]++;
        const left = 11 - this.reds[e.team];
        const second = /second yellow/i.test(e.detail) ? 'a second yellow, ' : '';
        this.add({ ...base, kind: 'red', text: `RED CARD! ${e.player || 'A player'} is sent off — ${second}${team} are down to ${left === 10 ? 'ten' : left === 9 ? 'nine' : left} men.` });
        return 'red';
      }
      case 'sub':
        this.add({ ...base, kind: 'sub', text: `Substitution, ${team}: ${[e.player, e.assist].filter(Boolean).join(' ⇄ ') || 'change made'}.` });
        return null;
      case 'var':
        this.add({ ...base, kind: 'var', text: /cancel|disallow/i.test(e.detail)
          ? `VAR: goal ruled out for ${team}!${score}`
          : `VAR check: ${e.detail || 'incident under review'}${e.player ? ` (${e.player})` : ''}.` });
        return /cancel|disallow/i.test(e.detail) && !backfill ? 'var' : null;
      default:
        return null;
    }
  }

  statLines(side, prev, snap, minute) {
    const a = prev.stats[side], b = snap.stats[side];
    const team = teamName(snap, side);
    const opp = teamName(snap, other(side));
    const goalsUp = Math.max(0, snap[side].goals - prev[side].goals);
    const diff = (k) => Math.max(0, (b[k] ?? 0) - (a[k] ?? 0));

    const oppSaves = Math.max(0, (snap.stats[other(side)].saves ?? 0) - (prev.stats[other(side)].saves ?? 0));
    const onTarget = Math.max(0, diff('shotsOn') - goalsUp);
    const denied = Math.max(oppSaves, onTarget);
    if (denied) this.add({ kind: 'chance', minute, team: side, text: denied === 1 ? `Save! The ${opp} keeper keeps out a shot from ${team}.` : `${team} force ${denied} saves from the ${opp} keeper.` });
    const off = diff('shotsOff');
    if (off) this.add({ kind: 'chance', minute, team: side, text: off === 1 ? `${team} shoot, but it's off target.` : `${team} have ${off} more efforts off target.` });
    const blocked = diff('blocked');
    if (blocked) this.add({ kind: 'chance', minute, team: side, text: blocked === 1 ? `A ${team} shot is blocked.` : `${blocked} ${team} shots blocked.` });
    const corners = diff('corners');
    if (corners) this.add({ kind: 'corner', minute, team: side, text: `${capitalize(plural(corners, 'corner'))} to ${team}.` });
  }
}

// ---------------------------------------------------------------------------
// Rule-based analysis: a few sentences that read the numbers like a pundit.
// ---------------------------------------------------------------------------
// Returns { text, tags }. Pass the tags from the previous analysis as `avoid`
// so the same observation isn't repeated every time.
const NUM_WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];
const goalsWord = (n) => (n === 1 ? 'a goal' : `${NUM_WORDS[n] || n} goals`);

function templateAnalysis(snap, reason, avoid = []) {
  const s = snap.stats;
  const H = snap.home, A = snap.away;
  const m = snap.status.elapsed || 0;
  const lead = H.goals - A.goals;
  const leader = lead > 0 ? 'home' : lead < 0 ? 'away' : null;
  const trailer = leader && other(leader);
  const left = Math.max(0, 90 - m);
  const margin = Math.abs(lead);

  // 1. What just happened (always included when there's a reason).
  let headline = null;
  if (reason === 'fulltime') {
    headline = leader
      ? `${snap[leader].name} take the win, ${Math.max(H.goals, A.goals)}–${Math.min(H.goals, A.goals)}.`
      : `Honours even: ${H.goals}–${A.goals}.`;
  } else if (reason === 'halftime') {
    headline = leader
      ? `${snap[leader].name} go in at the break ${goalsWord(margin)} to the good.`
      : `All square at half-time, ${H.goals}–${A.goals}.`;
  } else if (reason === 'goal') {
    headline = leader
      ? `${snap[leader].name} ${margin === 1 ? 'lead by one' : `are ${NUM_WORDS[margin] || margin} up`}${left > 0 ? ` with about ${left} minutes to go` : ''}.`
      : `We're level at ${H.goals}–${A.goals}${left > 0 ? ` with about ${left} minutes left` : ''}.`;
  } else if (reason === 'red') {
    const short = s && s.home.red > s.away.red ? 'home' : 'away';
    headline = `${snap[short].name} face ${left > 0 ? `the last ${left} minutes` : 'the rest of the game'} a player light, and that changes everything.`;
  } else if (reason === 'var') {
    headline = `A huge VAR call. It's ${H.goals}–${A.goals}.`;
  } else if (reason === 'miss') {
    headline = `A big let-off. It stays ${H.goals}–${A.goals}.`;
  }

  // 2. Observations from the numbers, most interesting first.
  const notes = [];
  if (s) {
    const ph = s.home.possession, pa = s.away.possession;
    const sh = s.home.shots || 0, sa = s.away.shots || 0;
    const xh = s.home.xg, xa = s.away.xg;
    const hasXg = xh != null && xa != null;

    if (hasXg && leader && s[trailer].xg - s[leader].xg >= 0.5) {
      notes.push(['xg-unfair', `${snap[trailer].name} can feel hard done by: they lead on expected goals, ${s[trailer].xg.toFixed(2)} to ${s[leader].xg.toFixed(2)}.`]);
    } else if (hasXg && leader && s[leader].xg - s[trailer].xg >= 0.8) {
      notes.push(['xg-deserved', `The lead is deserved: ${snap[leader].name} are well ahead on xG (${s[leader].xg.toFixed(2)} to ${s[trailer].xg.toFixed(2)}).`]);
    } else if (hasXg && !leader && Math.abs(xh - xa) >= 0.7) {
      const better = xh > xa ? 'home' : 'away';
      notes.push(['xg-better', `${snap[better].name} have created the better chances (${Math.max(xh, xa).toFixed(2)} xG to ${Math.min(xh, xa).toFixed(2)}).`]);
    }

    if (ph != null && Math.abs(ph - pa) >= 14) {
      const dom = ph > pa ? 'home' : 'away';
      const text = leader && dom === trailer
        ? `${snap[dom].name} have the ball (${Math.max(ph, pa)}%) but not the lead.`
        : `${snap[dom].name} are dominating the ball with ${Math.max(ph, pa)}% possession.`;
      notes.push(['possession', text]);
    }

    if (sh + sa >= 5) {
      const more = sh >= sa ? 'home' : 'away';
      const hi = Math.max(sh, sa), lo = Math.min(sh, sa);
      if (hi - lo >= 5 && hi >= lo * 1.5) notes.push(['shots-more', `${snap[more].name} are getting the shots away: ${hi} to ${lo}.`]);
      else if (m >= 20) notes.push(['shots-even', `Not much between them in front of goal: ${sh} shots to ${sa}.`]);
    }

    const onH = s.home.shotsOn || 0, onA = s.away.shotsOn || 0;
    if (m >= 30 && onH + onA <= 2 && reason !== 'fulltime') notes.push(['quiet', 'Clear-cut chances have been rare so far.']);

    const savesH = s.home.saves || 0, savesA = s.away.saves || 0;
    if (Math.max(savesH, savesA) >= 4) {
      const busy = savesH >= savesA ? 'home' : 'away';
      notes.push(['keeper', `The ${snap[busy].name} keeper has been busy, with ${Math.max(savesH, savesA)} saves.`]);
    }

    const yellows = (s.home.yellow || 0) + (s.away.yellow || 0);
    if (yellows >= 5) notes.push(['cards', reason === 'fulltime' ? `${yellows} bookings in a feisty game.` : `${yellows} bookings already. The referee has been busy.`]);
  }

  // Skip anything we said last time, so the analysis doesn't repeat itself.
  const chosen = notes.filter(([tag]) => !avoid.includes(tag)).slice(0, headline ? 2 : 3);
  const sentences = [headline, ...chosen.map(([, t]) => t)].filter(Boolean);
  if (!sentences.length) {
    sentences.push(leader
      ? `${snap[leader].name} still ${margin === 1 ? 'lead by one' : `lead by ${NUM_WORDS[margin] || margin}`}${left > 0 ? `, ${left} minutes to go` : ''}.`
      : `Still ${H.goals}–${A.goals}${left > 0 ? ` with ${left} minutes to go` : ''}.`);
  }
  return { text: sentences.join(' '), tags: chosen.map(([tag]) => tag) };
}

module.exports = { Feed, templateAnalysis, minuteLabel, scoreLine };
