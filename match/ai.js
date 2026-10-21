'use strict';
// Optional: richer match analysis written by Claude. Only used when the
// ANTHROPIC_API_KEY environment variable is set; otherwise the rule-based
// analysis in feed.js is used. One analysis is shared by every room watching
// the match, so costs stay tiny (a few short requests per match).

const { minuteLabel } = require('./feed');

const API_URL = 'https://api.anthropic.com/v1/messages';

const REASONS = {
  goal: 'A goal has just been scored.',
  red: 'A player has just been sent off.',
  var: 'VAR has just ruled a goal out.',
  miss: 'A penalty has just been missed.',
  halftime: 'It is half-time.',
  fulltime: 'The match has just finished. Give a short verdict.',
  interval: 'Regular in-play check-in.',
};

function statsTable(snap) {
  if (!snap.stats) return 'No stats yet.';
  const rows = [
    ['Possession %', 'possession'], ['Expected goals (xG)', 'xg'], ['Shots', 'shots'],
    ['Shots on target', 'shotsOn'], ['Corners', 'corners'], ['Keeper saves', 'saves'],
    ['Fouls', 'fouls'], ['Yellow cards', 'yellow'], ['Red cards', 'red'], ['Pass accuracy %', 'passPct'],
  ];
  return rows
    .filter(([, k]) => snap.stats.home[k] != null || snap.stats.away[k] != null)
    .map(([label, k]) => `${label}: ${snap.stats.home[k] ?? '-'} vs ${snap.stats.away[k] ?? '-'}`)
    .join('\n');
}

async function claudeAnalysis(snap, reason, recentLines) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const prompt = [
    `Match: ${snap.home.name} (home) vs ${snap.away.name} (away)`,
    `Score: ${snap.home.goals}–${snap.away.goals}`,
    `Clock: ${minuteLabel(snap.status.elapsed, snap.status.extra) || snap.status.short} (${snap.status.long || snap.status.short})`,
    `Moment: ${REASONS[reason] || REASONS.interval}`,
    '',
    'Stats (home vs away):',
    statsTable(snap),
    '',
    'Recent live text feed (oldest first):',
    ...recentLines.map((l) => `${l.minute || ''} ${l.text}`.trim()),
  ].join('\n');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      max_tokens: 200,
      system:
        'You write the analysis lines in a live football text commentary that fans read while watching the match on TV. ' +
        'Write 2 or 3 short, punchy sentences (under 60 words) in British English, like a sharp pundit. ' +
        'Use ONLY the facts in the data provided: never invent players, chances, tactics or incidents that are not stated. ' +
        'Interpret the numbers (who is on top, whether the scoreline is fair, what to watch for). ' +
        'No betting advice, no hashtags, no emoji, no preamble.',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`);
  const body = await res.json();
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
  return text || null;
}

module.exports = { claudeAnalysis, aiEnabled: () => !!process.env.ANTHROPIC_API_KEY };
