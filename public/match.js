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
