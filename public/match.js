'use strict';
// Match centre: live score, stats, play-by-play, odds and lineups for the match
// the room is following. Uses `socket`, `$`, `toast`, `openPanel`, `panelOpen`,
// `activeTab` and `floatEmoji` from app.js.

const mc = {
  fixtureId: null,
  buffer: [],         // [{ at, data }] — updates waiting out the spoiler delay
  shown: null,        // the update currently on screen
  delay: 0,           // seconds
  tab: 'stats',
  picking: false,
  seenLines: new Set(),
  oddsFormat: 'decimal',
};

try {
  mc.delay = Number(localStorage.getItem('mc-delay')) || 0;
  mc.oddsFormat = localStorage.getItem('mc-odds') || 'decimal';
} catch {}
$('#delaySelect').value = String(mc.delay);

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const minuteLabel = (m, x) => (m == null ? '' : x ? `${m}+${x}'` : `${m}'`);

// =====================================================================
// Where the match centre lives: on the telly, or in the side panel
// =====================================================================
function placeMatchCentre() {
  const node = $('#matchCentre');
  const host = panelOpen() && activeTab === 'match' ? $('#matchPane') : $('#stageMatchHost');
  if (node.parentElement !== host) host.appendChild(node);
  $('#stageMatchHost').classList.toggle('moved', host !== $('#stageMatchHost'));
}

function matchCentreOnTelly() {
  return !document.body.classList.contains('has-stage') && !document.body.classList.contains('halftime');
}

function showMatchCentre() {
  if (matchCentreOnTelly()) {
    if (panelOpen() && activeTab === 'match') closePanel();
  } else {
    openPanel('match');
  }
}

$('#scorebug').onclick = showMatchCentre;

// Switch between one column with tabs, and two columns with play-by-play
// always on the right, depending on how much room we have.
new ResizeObserver(([entry]) => {
  $('#matchCentre').classList.toggle('wide', entry.contentRect.width >= 720);
  applyTab();
}).observe($('#matchCentre'));

// =====================================================================
// Choosing a match
// =====================================================================
async function openPicker() {
  mc.picking = true;
  $('#mcPick').hidden = false;
  $('#mcLive').hidden = true;
  $('#mcPickBack').hidden = !mc.fixtureId;
  $('#mcNote').textContent = 'Loading fixtures…';
  $('#mcFixtures').replaceChildren();
  let data = { configured: false, fixtures: [] };
  try {
    data = await (await fetch('/api/fixtures')).json();
  } catch {
    data.error = 'Could not load fixtures.';
  }
  if (!mc.picking) return;
  renderPicker(data);
}

function closePicker() {
  mc.picking = false;
  $('#mcPick').hidden = !!mc.fixtureId;
  $('#mcLive').hidden = !mc.fixtureId;
}

function renderPicker({ configured, fixtures = [], error }) {
  const note = !configured
    ? 'Live Premier League data isn’t switched on for this app yet. Try the demo match to see how it works.'
    : error && /free plans? do not have access/i.test(error)
      ? 'Your API-Football plan doesn’t include the current season, so today’s games can’t be followed live. Replay a past match below, or upgrade to a paid plan for live games.'
    : error ? `Couldn’t refresh fixtures (${error}).`
    : fixtures.length ? 'Pick a match. Everyone in the room will follow it.'
    : 'No Premier League matches in the next few days.';
  $('#mcNote').textContent = note;

  const live = fixtures.filter((f) => ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'].includes(f.status.short));
  const upcoming = fixtures.filter((f) => ['NS', 'TBD'].includes(f.status.short))
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const finished = fixtures.filter((f) => !live.includes(f) && !upcoming.includes(f))
    .sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff));

  const groups = [];
  if (live.length) groups.push(['Live now', live]);
  // Upcoming matches grouped by day.
  const byDay = new Map();
  upcoming.forEach((f) => {
    const day = new Date(f.kickoff).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(f);
  });
  byDay.forEach((list, day) => groups.push([day, list]));
  if (finished.length) groups.push(['Recent results', finished.slice(0, 10)]);

  const box = $('#mcFixtures');
  box.replaceChildren();
  groups.forEach(([title, list]) => {
    box.appendChild(el('h4', 'mc-group', title));
    const grid = el('div', 'mc-fixture-grid');
    list.forEach((f) => grid.appendChild(fixtureButton(f)));
    box.appendChild(grid);
  });

  box.appendChild(el('h4', 'mc-group', 'Try it out'));
  const demo = el('button', 'mc-fixture demo');
  demo.append(el('span', 'mc-fx-teams', 'Demo match'),
    el('span', 'mc-fx-when', 'A simulated game between two made-up clubs, sped up so a full match takes about 7 minutes.'));
  demo.onclick = () => selectMatch('demo');
  const grid = el('div', 'mc-fixture-grid');
  grid.appendChild(demo);
  box.appendChild(grid);

  if (configured) {
    const replayBox = el('div', 'mc-replays');
    box.appendChild(replayBox);
    renderReplayPicker(replayBox);
  }
}

// ---------- Replays: a finished match played back as if live ----------
const replayState = { season: 2024, team: '', speed: 'fast', lists: new Map() };

async function renderReplayPicker(box) {
  box.replaceChildren(el('h4', 'mc-group', 'Replay a past match'));
  box.appendChild(el('p', 'mc-note', 'Plays a finished Premier League match through the match centre as if it were live: real goals, cards, subs and lineups at the right minutes. Stats build up evenly and the odds are modelled.'));

  const controls = el('div', 'replay-controls');
  const seasonSel = el('select');
  seasonSel.setAttribute('aria-label', 'Season');
  [[2024, '2024/25'], [2023, '2023/24'], [2022, '2022/23']].forEach(([y, label]) => {
    const o = new Option(label, y);
    o.selected = y === replayState.season;
    seasonSel.appendChild(o);
  });
  const teamSel = el('select');
  teamSel.setAttribute('aria-label', 'Team');
  const speedSel = el('select');
  speedSel.setAttribute('aria-label', 'Speed');
  [['fast', 'Fast (about 7 minutes)'], ['real', 'Real time (about 2 hours)']].forEach(([v, label]) => {
    const o = new Option(label, v);
    o.selected = v === replayState.speed;
    speedSel.appendChild(o);
  });
  controls.append(seasonSel, teamSel, speedSel);
  box.appendChild(controls);
  const listBox = el('div', 'mc-fixture-grid replay-list');
  box.appendChild(listBox);

  seasonSel.onchange = () => { replayState.season = Number(seasonSel.value); replayState.team = ''; renderReplayPicker(box); };
  speedSel.onchange = () => { replayState.speed = speedSel.value; };
  teamSel.onchange = () => { replayState.team = teamSel.value; fillList(); };

  let data = replayState.lists.get(replayState.season);
  if (!data) {
    listBox.appendChild(el('p', 'mc-empty', 'Loading matches…'));
    try {
      data = await (await fetch(`/api/replays?season=${replayState.season}`)).json();
      if (!data.error) replayState.lists.set(replayState.season, data);
    } catch {
      data = { fixtures: [], error: 'Could not load past matches.' };
    }
  }
  const fixtures = data.fixtures || [];
  const teams = [...new Set(fixtures.flatMap((f) => [f.home.name, f.away.name]))].sort();
  teamSel.replaceChildren(new Option('All teams', ''), ...teams.map((t) => new Option(t, t)));
  teamSel.value = replayState.team;

  function fillList() {
    listBox.replaceChildren();
    if (data.error) {
      listBox.appendChild(el('p', 'mc-empty', `Couldn’t load past matches (${data.error}).`));
      return;
    }
    const shown = fixtures
      .filter((f) => !replayState.team || f.home.name === replayState.team || f.away.name === replayState.team)
      .sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff))
      .slice(0, replayState.team ? 40 : 20);
    if (!shown.length) listBox.appendChild(el('p', 'mc-empty', 'No matches found.'));
    shown.forEach((f) => {
      const b = el('button', 'mc-fixture');
      const teamsRow = el('span', 'mc-fx-teams');
      teamsRow.append(el('span', '', f.home.name), el('strong', 'mc-fx-score', `${f.home.goals}–${f.away.goals}`), el('span', '', f.away.name));
      const when = el('span', 'mc-fx-when', `${new Date(f.kickoff).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · ${f.round.replace('Regular Season - ', 'Matchweek ')}`);
      b.append(teamsRow, when);
      b.onclick = () => selectMatch(`replay:${f.id}:${replayState.speed}`);
      listBox.appendChild(b);
    });
    if (!replayState.team) listBox.appendChild(el('p', 'mc-note replay-hint', 'Showing the 20 most recent. Pick a team to see all their matches.'));
  }
  fillList();
}

function fixtureButton(f) {
  const b = el('button', 'mc-fixture');
  const st = f.status.short;
  const isLive = !['NS', 'TBD'].includes(st) && f.home.goals != null && !['FT', 'AET', 'PEN'].includes(st);
  const teams = el('span', 'mc-fx-teams');
  teams.append(
    el('span', '', f.home.name),
    el('strong', 'mc-fx-score', f.home.goals != null && st !== 'NS' ? `${f.home.goals}–${f.away.goals}` : 'v'),
    el('span', '', f.away.name),
  );
  const when = el('span', 'mc-fx-when');
  if (isLive) {
    when.append(el('span', 'live-dot'), document.createTextNode(st === 'HT' ? 'Half-time' : `${f.status.elapsed ?? ''}'`));
  } else if (['FT', 'AET', 'PEN'].includes(st)) {
    when.textContent = 'Full-time';
  } else if (['PST', 'CANC', 'ABD'].includes(st)) {
    when.textContent = { PST: 'Postponed', CANC: 'Cancelled', ABD: 'Abandoned' }[st];
  } else {
    when.textContent = new Date(f.kickoff).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  b.append(teams, when);
  if (f.id === mc.fixtureId) b.classList.add('current');
  b.onclick = () => selectMatch(f.id);
  return b;
}

function selectMatch(id) {
  socket.emit('select-match', { fixtureId: id });
  $('#mcNote').textContent = 'Loading match…';
}

$('#mcChange').onclick = openPicker;
$('#mcPickBack').onclick = closePicker;

// =====================================================================
// Receiving updates (and holding them back to avoid spoilers)
// =====================================================================
function setFixture(id, data) {
  mc.fixtureId = id;
  mc.buffer = [];
  mc.shown = null;
  mc.seenLines = new Set();
  mc.firstRender = true;
  mc.picking = false;
  if (!id) {
    $('#scorebug').hidden = true;
    openPicker();
    return;
  }
  $('#mcPick').hidden = true;
  $('#mcLive').hidden = false;
  // The first snapshot shows straight away; later ones wait out the delay.
  if (data) mc.buffer.push({ at: 0, data });
  renderLoading();
  tick();
}

socket.on('joined', ({ match }) => setFixture(match?.fixtureId || null, match?.data || null));

socket.on('match-selected', ({ fixtureId, by, data }) => {
  setFixture(fixtureId, data);
  if (fixtureId && data) toast(`${by} picked ${data.fixture.home.name} v ${data.fixture.away.name}`);
  else if (fixtureId) toast(`${by} picked a new match`);
});

socket.on('match', (payload) => {
  if (payload.fixtureId !== mc.fixtureId) return;
  mc.buffer.push({ at: Date.now(), data: payload });
});

socket.on('match-error', ({ message }) => {
  toast(message);
  $('#mcNote').textContent = message;
});

function tick() {
  if (!mc.fixtureId) return;
  const cutoff = Date.now() - mc.delay * 1000;
  let idx = -1;
  for (let i = 0; i < mc.buffer.length; i++) if (mc.buffer[i].at <= cutoff) idx = i;
  if (idx >= 0) {
    const item = mc.buffer[idx];
    mc.buffer = mc.buffer.slice(idx); // drop anything older
    if (item.data !== mc.shown) {
      mc.shown = item.data;
      render(item.data);
    }
  }
  updateDelayChip();
}
setInterval(tick, 500);

function renderLoading() {
  if (mc.buffer.length) return;
  $('#mcHomeName').textContent = '';
  $('#mcAwayName').textContent = '';
  $('#mcClock').textContent = 'Loading match…';
}

// Spoiler delay setting
$('#delaySelect').onchange = (e) => {
  mc.delay = Number(e.target.value) || 0;
  try { localStorage.setItem('mc-delay', String(mc.delay)); } catch {}
  tick();
};
$('#mcDelay').onclick = () => $('#settingsBtn').click();

function updateDelayChip() {
  const chip = $('#mcDelay');
  chip.hidden = mc.delay === 0;
  chip.textContent = `⏱ ${mc.delay}s delay`;
}

// =====================================================================
// Rendering
// =====================================================================
const STATUS_TEXT = {
  NS: 'Not started', TBD: 'Time to be confirmed', HT: 'Half-time', FT: 'Full-time',
  AET: 'Full-time (after extra time)', PEN: 'Full-time (penalties)', BT: 'Break before extra time',
  P: 'Penalties', SUSP: 'Suspended', INT: 'Interrupted', PST: 'Postponed', CANC: 'Cancelled',
  ABD: 'Abandoned', AWD: 'Awarded', WO: 'Walkover',
};
const PLAYING = ['1H', '2H', 'ET', 'LIVE'];

function render(data) {
  const f = data.fixture;
  const st = f.status.short;

  // Scorebug in the top bar
  const bug = $('#scorebug');
  bug.hidden = false;
  const clock = PLAYING.includes(st) ? minuteLabel(f.status.elapsed, f.status.extra)
    : st === 'NS' ? new Date(f.kickoff).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : st === 'HT' ? 'HT' : st === 'FT' ? 'FT' : st;
  bug.replaceChildren(
    el('span', 'sb-team', f.home.short),
    el('strong', 'sb-score', st === 'NS' ? 'v' : `${f.home.goals}–${f.away.goals}`),
    el('span', 'sb-team', f.away.short),
    el('span', 'sb-clock' + (PLAYING.includes(st) ? ' live' : ''), clock),
  );

  // Score panel
  $('#mcHomeBadge').textContent = f.home.short;
  $('#mcAwayBadge').textContent = f.away.short;
  $('#mcHomeName').textContent = f.home.name;
  $('#mcAwayName').textContent = f.away.name;
  $('#mcHomeGoals').textContent = st === 'NS' ? '–' : f.home.goals;
  $('#mcAwayGoals').textContent = st === 'NS' ? '–' : f.away.goals;
  const clockEl = $('#mcClock');
  clockEl.replaceChildren();
  if (PLAYING.includes(st)) {
    clockEl.append(el('span', 'live-dot'), document.createTextNode(minuteLabel(f.status.elapsed, f.status.extra)));
  } else if (st === 'NS') {
    const ko = new Date(f.kickoff);
    clockEl.textContent = `Kick-off ${ko.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    clockEl.textContent = STATUS_TEXT[st] || f.status.long || st;
  }
  $('#mcMeta').textContent = [f.league.round, f.venue].filter(Boolean).join(' · ');
  renderScorers(f, 'home');
  renderScorers(f, 'away');

  renderStats(f);
  renderProbChart(data.oddsHistory || [], f);
  renderFeed(data.feed);
  renderOdds(data.odds, f);
  renderLineups(f);
  mc.firstRender = false;
}

function renderScorers(f, side) {
  const list = $(side === 'home' ? '#mcHomeScorers' : '#mcAwayScorers');
  list.replaceChildren();
  // Own goals count for the other team.
  const goals = f.events.filter((e) =>
    (['goal', 'penalty'].includes(e.type) && e.team === side) || (e.type === 'owngoal' && e.team !== side));
  const cancelled = f.events.filter((e) => e.type === 'var' && /cancel|disallow/i.test(e.detail));
  const byPlayer = new Map();
  goals.forEach((e) => {
    // A goal VAR later cancelled (same team, same or next minute) isn't shown.
    if (cancelled.some((c) => c.team === e.team && c.minute - e.minute >= 0 && c.minute - e.minute <= 3)) return;
    const name = e.player || 'Goal';
    const tag = minuteLabel(e.minute, e.extra) + (e.type === 'penalty' ? ' pen' : e.type === 'owngoal' ? ' og' : '');
    if (!byPlayer.has(name)) byPlayer.set(name, []);
    byPlayer.get(name).push(tag);
  });
  byPlayer.forEach((mins, name) => list.appendChild(el('li', '', `${name} ${mins.join(', ')}`)));
  f.events.filter((e) => e.type === 'red' && e.team === side)
    .forEach((e) => list.appendChild(el('li', 'red', `🟥 ${e.player || 'Red card'} ${minuteLabel(e.minute, e.extra)}`)));
}

// ---------- Stats ----------
const STAT_ROWS = [
  ['Possession', 'possession', (v) => `${v}%`],
  ['Expected goals (xG)', 'xg', (v) => v.toFixed(2)],
  ['Shots', 'shots'],
  ['Shots on target', 'shotsOn'],
  ['Corners', 'corners'],
  ['Saves', 'saves'],
  ['Fouls', 'fouls'],
  ['Offsides', 'offsides'],
  ['Yellow cards', 'yellow'],
  ['Red cards', 'red'],
  ['Passes', 'passes'],
  ['Pass accuracy', 'passPct', (v) => `${v}%`],
];

function renderStats(f) {
  const box = $('#mcStats');
  box.replaceChildren();
  if (!f.stats) {
    box.appendChild(el('p', 'mc-empty', f.status.short === 'NS'
      ? 'Stats appear once the match kicks off.'
      : 'Stats aren’t available for this match yet.'));
    return;
  }
  const head = el('div', 'stat-head');
  head.append(el('span', 'home', f.home.short), el('span', '', ''), el('span', 'away', f.away.short));
  box.appendChild(head);
  STAT_ROWS.forEach(([label, key, fmt = (v) => String(v)]) => {
    const h = f.stats.home[key], a = f.stats.away[key];
    if (h == null && a == null) return;
    const hv = h ?? 0, av = a ?? 0;
    const total = hv + av;
    const share = total > 0 ? (hv / total) * 100 : 50;
    const row = el('div', 'stat-row');
    const hEl = el('span', 'stat-val home' + (hv > av ? ' lead' : ''), h == null ? '–' : fmt(h));
    const aEl = el('span', 'stat-val away' + (av > hv ? ' lead' : ''), a == null ? '–' : fmt(a));
    const mid = el('div', 'stat-mid');
    const bar = el('div', 'stat-bar');
    const hb = el('span', 'bar-home');
    hb.style.width = `${share}%`;
    const ab = el('span', 'bar-away');
    ab.style.width = `${100 - share}%`;
    bar.append(hb, ab);
    mid.append(el('span', 'stat-label', label), bar);
    row.append(hEl, mid, aEl);
    box.appendChild(row);
  });
}

// ---------- Play-by-play ----------
const LINE_ICONS = {
  goal: '⚽', miss: '❌', yellow: '🟨', red: '🟥', sub: '🔄', var: '📺',
  chance: '🎯', corner: '🚩', phase: '⏱️', info: 'ℹ️', analysis: '🧠',
};

function renderFeed(lines = []) {
  const list = $('#mcFeed');
  const wasAtTop = list.scrollTop < 40;
  list.replaceChildren();
  if (!lines.length) {
    list.appendChild(el('li', 'mc-empty', 'Updates will appear here as the match goes on.'));
    return;
  }
  const fresh = [];
  [...lines].reverse().forEach((l) => {
    const li = el('li', `line ${l.kind}${l.team ? ` ${l.team}` : ''}`);
    li.append(el('span', 'line-min', l.minute || ''), el('span', 'line-icon', LINE_ICONS[l.kind] || '•'));
    const body = el('div', 'line-text');
    if (l.kind === 'analysis') body.appendChild(el('span', 'line-tag', l.by === 'ai' ? 'AI analysis' : 'Analysis'));
    body.appendChild(document.createTextNode(l.text));
    li.appendChild(body);
    if (!mc.seenLines.has(l.id)) {
      mc.seenLines.add(l.id);
      if (!mc.firstRender) { li.classList.add('new'); fresh.push(l); }
    }
    list.appendChild(li);
  });
  if (wasAtTop) list.scrollTop = 0;

  // Celebrate goals as they appear (after the spoiler delay).
  fresh.filter((l) => l.kind === 'goal').forEach((l) => {
    toast(`⚽ ${l.text.split('.')[0]}`);
    if (typeof floatEmoji === 'function') {
      for (let i = 0; i < 6; i++) setTimeout(() => floatEmoji($('#stageFloat'), '⚽', true), i * 150);
    }
    $('#scorebug').classList.remove('flash');
    void $('#scorebug').offsetWidth; // restart the animation
    $('#scorebug').classList.add('flash');
  });
  fresh.filter((l) => l.kind === 'red').forEach((l) => toast(`🟥 ${l.text.split('—')[0]}`));
}

// ---------- Odds ----------
const FRACTIONS = [
  [1, 10], [1, 8], [1, 7], [1, 6], [1, 5], [2, 9], [1, 4], [2, 7], [3, 10], [1, 3], [4, 11], [2, 5],
  [4, 9], [1, 2], [8, 15], [4, 7], [8, 13], [4, 6], [8, 11], [4, 5], [5, 6], [10, 11], [1, 1],
  [11, 10], [6, 5], [5, 4], [11, 8], [6, 4], [13, 8], [7, 4], [15, 8], [2, 1], [9, 4], [5, 2],
  [11, 4], [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1], [13, 2], [7, 1],
  [15, 2], [8, 1], [17, 2], [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1], [20, 1],
  [25, 1], [33, 1], [40, 1], [50, 1], [66, 1], [80, 1], [100, 1],
];

function formatOdd(d) {
  if (mc.oddsFormat === 'fractional') {
    let best = FRACTIONS[0];
    FRACTIONS.forEach((f) => { if (Math.abs(f[0] / f[1] + 1 - d) < Math.abs(best[0] / best[1] + 1 - d)) best = f; });
    return best[0] === best[1] ? 'Evs' : `${best[0]}/${best[1]}`;
  }
  if (mc.oddsFormat === 'american') {
    return d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`;
  }
  return d.toFixed(2);
}

function renderOdds(odds, f) {
  const box = $('#mcOdds');
  box.replaceChildren();

  const head = el('div', 'odds-head');
  const title = el('span', 'odds-title', !odds ? 'Odds' : odds.live ? 'Live odds' : `Pre-match odds${odds.bookmaker ? ` · ${odds.bookmaker}` : ''}`);
  if (odds?.live) title.prepend(el('span', 'live-dot'));
  const fmt = el('select', 'odds-format');
  fmt.setAttribute('aria-label', 'Odds format');
  [['decimal', 'Decimal'], ['fractional', 'Fractional'], ['american', 'American']].forEach(([v, t]) => {
    const o = new Option(t, v);
    o.selected = v === mc.oddsFormat;
    fmt.appendChild(o);
  });
  fmt.onchange = () => {
    mc.oddsFormat = fmt.value;
    try { localStorage.setItem('mc-odds', fmt.value); } catch {}
    renderOdds(odds, f);
  };
  head.append(title, fmt);
  box.appendChild(head);

  if (!odds || !odds.markets?.length) {
    const st = f.status.short;
    box.appendChild(el('p', 'mc-empty', ['FT', 'AET', 'PEN'].includes(st)
      ? 'The match is over, so the markets are closed.'
      : 'No odds available for this match right now.'));
    return;
  }
  if (odds.suspended) box.appendChild(el('p', 'odds-suspended', 'Markets suspended: something just happened.'));

  odds.markets.forEach((m) => {
    const sec = el('section', 'market');
    sec.appendChild(el('h5', '', m.name));
    const row = el('div', 'market-row');
    // Implied chances, with the bookmaker's margin taken out.
    const inv = m.values.map((v) => 1 / v.odd);
    const sum = inv.reduce((s, x) => s + x, 0);
    m.values.forEach((v, i) => {
      const cell = el('div', 'odd' + (v.suspended || odds.suspended ? ' suspended' : ''));
      cell.append(
        el('span', 'odd-label', v.label),
        el('strong', 'odd-price', formatOdd(v.odd)),
        el('span', 'odd-pct', `${Math.round((inv[i] / sum) * 100)}% chance`),
      );
      row.appendChild(cell);
    });
    sec.appendChild(row);
    box.appendChild(sec);
  });

  const updated = odds.updatedAt ? new Date(odds.updatedAt) : null;
  box.appendChild(el('p', 'odds-foot',
    `${updated && !isNaN(updated) ? `Updated ${updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}. ` : ''}` +
    'For information only. Chances are worked out from the odds. 18+, please gamble responsibly.'));
}

// ---------- Lineups ----------
function renderLineups(f) {
  const box = $('#mcLineups');
  box.replaceChildren();
  if (!f.lineups) {
    box.appendChild(el('p', 'mc-empty', 'Lineups are usually announced about an hour before kick-off.'));
    return;
  }
  const subbedOn = new Set(f.events.filter((e) => e.type === 'sub').flatMap((e) => [e.player, e.assist]));
  const sentOff = new Set(f.events.filter((e) => e.type === 'red').map((e) => e.player));
  const booked = new Set(f.events.filter((e) => e.type === 'yellow').map((e) => e.player));
  const POS = { G: 'GK', D: 'DEF', M: 'MID', F: 'FWD' };

  ['home', 'away'].forEach((side) => {
    const l = f.lineups[side];
    const col = el('div', 'lineup');
    const h = el('h5', '');
    h.append(el('span', 'mc-badge small', f[side].short), document.createTextNode(` ${f[side].name}`));
    col.append(h, el('p', 'lineup-meta', [l.formation, l.coach && `Manager: ${l.coach}`].filter(Boolean).join(' · ')));
    const player = (p) => {
      const li = el('li', '');
      li.append(el('span', 'num', p.number ?? ''), el('span', 'pname', p.name), el('span', 'pos', POS[p.pos] || p.pos || ''));
      const marks = [booked.has(p.name) && '🟨', sentOff.has(p.name) && '🟥', subbedOn.has(p.name) && '🔄'].filter(Boolean);
      if (marks.length) li.appendChild(el('span', 'marks', marks.join('')));
      return li;
    };
    const xi = el('ol', 'xi');
    l.xi.forEach((p) => xi.appendChild(player(p)));
    col.appendChild(xi);
    if (l.subs.length) {
      col.appendChild(el('p', 'lineup-sub-title', 'Substitutes'));
      const subs = el('ol', 'xi subs');
      l.subs.forEach((p) => subs.appendChild(player(p)));
      col.appendChild(subs);
    }
    box.appendChild(col);
  });
}

// =====================================================================
// Tabs inside the match centre
// =====================================================================
document.querySelectorAll('.mc-tabs button').forEach((b) => {
  b.onclick = () => { mc.tab = b.dataset.mc; applyTab(); };
});

function applyTab() {
  const wide = $('#matchCentre').classList.contains('wide');
  // In the wide layout play-by-play always has its own column.
  const tab = wide && mc.tab === 'pbp' ? 'stats' : mc.tab;
  document.querySelectorAll('.mc-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mc === tab));
  document.querySelectorAll('.mc-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.pane === tab || (wide && p.dataset.pane === 'pbp'));
  });
}
applyTab();

// =====================================================================
// Kalshi: prediction-market prices for this match (read-only)
// Prices jump the moment a goal goes in, so they wait out the same spoiler
// delay as the rest of the match centre.
// =====================================================================
const kalshi = { buffer: [], shown: null, fixtureId: null, timer: null, loading: false };

async function fetchKalshi() {
  if (!mc.fixtureId || kalshi.loading) return;
  kalshi.loading = true;
  const id = mc.fixtureId;
  try {
    const res = await fetch(`/api/kalshi?fixture=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (id === mc.fixtureId) kalshi.buffer.push({ at: Date.now(), data });
  } catch {
    if (id === mc.fixtureId) kalshi.buffer.push({ at: Date.now(), data: { error: 'Couldn’t reach Kalshi.' } });
  } finally {
    kalshi.loading = false;
  }
}

// Fetch every 30s while a match is followed; show the newest result that has waited out the delay.
setInterval(() => {
  if (kalshi.fixtureId !== mc.fixtureId) {
    kalshi.fixtureId = mc.fixtureId;
    kalshi.buffer = [];
    kalshi.shown = null;
    if (mc.fixtureId) fetchKalshi();
    renderKalshi(null);
  }
}, 500);
setInterval(fetchKalshi, 30000);
setInterval(() => {
  if (!kalshi.buffer.length) return;
  const cutoff = Date.now() - mc.delay * 1000;
  let idx = -1;
  kalshi.buffer.forEach((b, i) => { if (b.at <= cutoff) idx = i; });
  if (idx < 0 && !kalshi.shown) idx = 0; // first load shows straight away, like the rest of the match centre
  if (idx >= 0 && kalshi.buffer[idx].data !== kalshi.shown) {
    kalshi.shown = kalshi.buffer[idx].data;
    kalshi.buffer = kalshi.buffer.slice(idx);
    renderKalshi(kalshi.shown);
  }
}, 1000);

const cents = (p) => (p == null ? '–' : `${Math.round(p * 100)}¢`);

function renderKalshi(data) {
  const box = $('#mcKalshi');
  box.replaceChildren();
  const head = el('div', 'odds-head');
  const title = el('span', 'odds-title', 'Kalshi prediction market');
  head.appendChild(title);
  box.appendChild(head);

  if (!data) {
    box.appendChild(el('p', 'mc-empty', mc.fixtureId ? 'Loading Kalshi prices…' : 'Pick a match to see Kalshi prices.'));
    return;
  }
  if (data.error && !data.match && !(data.upcoming || []).length) {
    box.appendChild(el('p', 'mc-empty', `Couldn’t load Kalshi right now. (${data.error})`));
    return;
  }

  if (data.match) {
    const sec = el('section', 'market');
    sec.appendChild(el('h5', '', 'Who wins? (price of a $1 “yes”)'));
    const row = el('div', 'market-row');
    data.match.outcomes.forEach((o) => {
      const cell = el('div', 'odd');
      cell.append(
        el('span', 'odd-label', o.side === 'draw' ? 'Draw' : o.label),
        el('strong', 'odd-price', cents(o.price)),
        el('span', 'odd-pct', o.price != null ? `${Math.round(o.price * 100)}% chance` : 'no trades yet'),
      );
      if (o.bid != null && o.ask != null && o.ask > 0) {
        cell.appendChild(el('span', 'odd-spread', `buy ${cents(o.ask)} · sell ${cents(o.bid)}`));
      }
      row.appendChild(cell);
    });
    sec.appendChild(row);
    box.appendChild(sec);
  } else {
    box.appendChild(el('p', 'mc-empty', data.demo
      ? (mc.shown?.fixture?.source === 'replay'
        ? 'Replays aren’t on Kalshi (the match has already been played). Upcoming Premier League games are listed below.'
        : 'The demo match isn’t on Kalshi (the clubs are made up). Real Premier League games are listed below.')
      : 'Kalshi doesn’t have a market for this match right now.'));
  }

  if ((data.upcoming || []).length) {
    box.appendChild(el('h5', 'kalshi-sub', data.match ? 'Other Premier League games on Kalshi' : 'Premier League games on Kalshi'));
    const list = el('ul', 'kalshi-list');
    data.upcoming.forEach((g) => {
      const li = el('li', '');
      li.appendChild(el('span', 'kalshi-game', g.title || g.eventTicker));
      li.appendChild(el('span', 'kalshi-prices', g.outcomes.map((o) => `${o.label} ${cents(o.price)}`).join(' · ')));
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  const link = el('a', 'kalshi-link', 'Trade on Kalshi ↗');
  link.href = data.match?.url || data.seriesUrl || 'https://kalshi.com';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  box.appendChild(link);
  const updated = data.updatedAt ? new Date(data.updatedAt) : null;
  box.appendChild(el('p', 'odds-foot',
    `${updated && !isNaN(updated) ? `Prices as of ${updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${mc.delay ? ` (shown ${mc.delay}s later, to match your spoiler delay)` : ''}. ` : ''}` +
    'Kalshi is a regulated US exchange; trading needs a Kalshi account (18+, not available everywhere). For information only, not financial advice.'));
}

// =====================================================================
// Win-probability chart: how the chance of a home win / draw / away win has
// moved through the match, from the live odds (bookmaker margin removed).
// Hand-drawn SVG: three 2px lines (draw dashed), direct labels at the end,
// goal and red-card markers, and a crosshair tooltip on hover.
// =====================================================================
const PROB_SERIES = [
  { key: 'home', cls: 'home' },
  { key: 'draw', cls: 'draw', dash: '5 4' },
  { key: 'away', cls: 'away' },
];
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  return e;
};
const probChart = { history: [], fixture: null, width: 0, hoverX: null, tableOpen: false };

function renderProbChart(history, f) {
  probChart.history = history;
  probChart.fixture = f;
  drawProbChart();
}

new ResizeObserver(() => {
  const w = $('#mcProb').clientWidth;
  if (w && Math.abs(w - probChart.width) > 4) drawProbChart();
}).observe($('#mcProb'));

function seriesName(key, f) {
  return key === 'home' ? f.home.short : key === 'away' ? f.away.short : 'Draw';
}

function drawProbChart() {
  const box = $('#mcProb');
  const f = probChart.fixture;
  const h = probChart.history;
  box.replaceChildren();
  if (!f) return;

  const head = el('div', 'prob-head');
  head.appendChild(el('h4', 'prob-title', 'Win probability'));
  const legend = el('div', 'prob-legend');
  PROB_SERIES.forEach((s) => {
    const item = el('span', 'prob-key');
    item.append(el('span', `prob-swatch ${s.cls}`), document.createTextNode(s.key === 'draw' ? 'Draw' : f[s.key].name));
    legend.appendChild(item);
  });
  head.appendChild(legend);
  box.appendChild(head);
  if (f.source === 'demo' || f.source === 'replay') {
    box.appendChild(el('p', 'prob-note', 'Modelled from the score and time, not real odds.'));
  }

  if (h.length < 1) {
    box.appendChild(el('p', 'prob-empty', 'The chart fills in from the live odds once they’re available for this match.'));
    return;
  }

  const width = Math.max(260, box.clientWidth || 400);
  probChart.width = width;
  const height = 150;
  const pad = { l: 34, r: 74, t: 14, b: 22 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const x = (min) => pad.l + (Math.min(Math.max(min, 0), 90) / 90) * iw;
  const y = (pct) => pad.t + (1 - pct / 100) * ih;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'prob-svg', role: 'img' });
  const latest = h[h.length - 1];
  svg.setAttribute('aria-label', `Win probability at ${latest.minute} minutes: ${f.home.name} ${latest.home}%, draw ${latest.draw}%, ${f.away.name} ${latest.away}%.`);

  // Recessive grid: 0 / 50 / 100%, half-time line, 15-minute ticks.
  [0, 50, 100].forEach((p) => {
    svg.appendChild(svgEl('line', { x1: pad.l, x2: pad.l + iw, y1: y(p), y2: y(p), class: p === 0 ? 'prob-axis' : 'prob-grid' }));
    const t = svgEl('text', { x: pad.l - 6, y: y(p) + 4, class: 'prob-tick', 'text-anchor': 'end' });
    t.textContent = `${p}%`;
    svg.appendChild(t);
  });
  [0, 15, 30, 45, 60, 75, 90].forEach((m) => {
    const t = svgEl('text', { x: x(m), y: height - 6, class: 'prob-tick', 'text-anchor': 'middle' });
    t.textContent = m === 45 ? 'HT' : m === 0 ? 'KO' : `${m}'`;
    svg.appendChild(t);
  });
  svg.appendChild(svgEl('line', { x1: x(45), x2: x(45), y1: pad.t, y2: pad.t + ih, class: 'prob-grid' }));

  // Goals and red cards, as faint verticals with a small icon at the top.
  const cancelled = f.events.filter((e) => e.type === 'var' && /cancel|disallow/i.test(e.detail));
  f.events.filter((e) => ['goal', 'penalty', 'owngoal', 'red'].includes(e.type)).forEach((e) => {
    if (e.type !== 'red' && cancelled.some((c) => c.team === e.team && c.minute - e.minute >= 0 && c.minute - e.minute <= 3)) return;
    const mx = x(Math.min(e.minute, e.minute <= 45 ? 45 : 90));
    svg.appendChild(svgEl('line', { x1: mx, x2: mx, y1: pad.t, y2: pad.t + ih, class: 'prob-event' }));
    const icon = svgEl('text', { x: mx, y: pad.t - 2, class: 'prob-event-icon', 'text-anchor': 'middle' });
    icon.textContent = e.type === 'red' ? '🟥' : '⚽';
    svg.appendChild(icon);
  });

  // The three lines. A lone pre-match point is drawn as a short flat stub.
  const pts = h.length === 1 ? [h[0], { ...h[0], minute: 1 }] : h;
  PROB_SERIES.forEach((s) => {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.minute).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ');
    const path = svgEl('path', { d, class: `prob-line ${s.cls}` });
    if (s.dash) path.setAttribute('stroke-dasharray', s.dash);
    svg.appendChild(path);
    svg.appendChild(svgEl('circle', { cx: x(latest.minute), cy: y(latest[s.key]), r: 4, class: `prob-dot ${s.cls}` }));
  });

  // Direct labels at the line ends, nudged apart so they never overlap.
  const labels = PROB_SERIES.map((s) => ({ s, y: y(latest[s.key]), text: `${seriesName(s.key, f)} ${Math.round(latest[s.key])}%` }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
  const over = labels[labels.length - 1].y - (pad.t + ih);
  if (over > 0) labels.forEach((l) => { l.y -= over; });
  labels.forEach((l) => {
    const t = svgEl('text', { x: x(latest.minute) + 8, y: l.y + 4, class: 'prob-label' });
    t.textContent = l.text;
    svg.appendChild(t);
  });

  // Hover: crosshair + tooltip with all three values at that minute.
  const cross = svgEl('line', { y1: pad.t, y2: pad.t + ih, class: 'prob-cross', visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: pad.l, y: 0, width: iw + 8, height: height, class: 'prob-hit' });
  svg.appendChild(hit);
  const tip = el('div', 'prob-tip');
  tip.hidden = true;

  const showAt = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * width;
    const minute = ((px - pad.l) / iw) * 90;
    let p = h[0];
    for (const q of h) { if (q.minute <= minute + 0.5) p = q; else break; }
    cross.setAttribute('x1', x(p.minute));
    cross.setAttribute('x2', x(p.minute));
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(el('strong', '', p.minute === 0 ? 'Before kick-off' : p.minute === 45 && h.some((q) => q.minute > 45) ? 'Half-time' : `${p.minute}'`));
    PROB_SERIES.forEach((s) => {
      const row = el('div', 'prob-tip-row');
      row.append(el('span', `prob-swatch ${s.cls}`), el('span', '', s.key === 'draw' ? 'Draw' : f[s.key].name), el('b', '', `${p[s.key].toFixed(0)}%`));
      tip.appendChild(row);
    });
    tip.hidden = false;
    const left = (x(p.minute) / width) * r.width;
    tip.style.left = `${Math.min(Math.max(left + 12, 0), r.width - 150)}px`;
  };
  // Remember the pointer so a data update doesn't close the tooltip.
  hit.addEventListener('pointermove', (e) => { probChart.hoverX = e.clientX; showAt(e.clientX); });
  hit.addEventListener('pointerdown', (e) => { probChart.hoverX = e.clientX; showAt(e.clientX); });
  hit.addEventListener('pointerleave', () => { probChart.hoverX = null; tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });

  const wrap = el('div', 'prob-wrap');
  wrap.append(svg, tip);
  box.appendChild(wrap);
  if (probChart.hoverX != null) showAt(probChart.hoverX);

  // Table view: the same numbers at kick-off, each goal / red card, and now.
  const details = el('details', 'prob-table');
  details.open = probChart.tableOpen;
  details.addEventListener('toggle', () => { probChart.tableOpen = details.open; });
  details.appendChild(el('summary', '', 'Show as table'));
  const table = el('table');
  const thead = el('tr');
  ['Minute', f.home.short, 'Draw', f.away.short].forEach((t) => thead.appendChild(el('th', '', t)));
  table.appendChild(thead);
  const moments = new Set([h[0]]);
  f.events.filter((e) => ['goal', 'penalty', 'owngoal', 'red'].includes(e.type)).forEach((e) => {
    const after = h.find((p) => p.minute >= Math.min(e.minute, 90) + 1) || latest;
    moments.add(after);
  });
  moments.add(latest);
  [...moments].sort((a, b) => a.at - b.at).forEach((p) => {
    const tr = el('tr');
    [p.minute === 0 ? 'KO' : `${p.minute}'`, `${Math.round(p.home)}%`, `${Math.round(p.draw)}%`, `${Math.round(p.away)}%`]
      .forEach((t) => tr.appendChild(el('td', '', t)));
    table.appendChild(tr);
  });
  details.appendChild(table);
  box.appendChild(details);
}
