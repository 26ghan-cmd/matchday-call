'use strict';
// Sync with your TV + spoiler shield.
//
// Everyone watches the match on their own TV or stream, each with a different
// delay. People tap when their TV's match clock hits a known time; the server
// works out how far behind each TV is (match/sync.js). Then, for each friend
// whose TV is AHEAD of yours, we hold back their audio, video, chat and
// reactions by the difference, so you never hear a cheer before you see the goal.
//
// Uses globals from app.js (socket, peers, myId, tileEl, toast, setAudioDelay,
// renderPeople, renderStage) and match.js (mc).

const sync = {
  offset: 0,           // server clock minus our clock, in ms
  bestRtt: Infinity,
  lags: {},            // socket id -> seconds behind the furthest-ahead TV (or null)
  syncedHalves: {},    // socket id -> [1, 2]
  shield: true,
  tap: null,           // pending clock tap waiting for the minute to be confirmed
  delayers: new Map(), // socket id -> VideoDelayer
  stageTarget: null,   // { id } when the telly shows a held-back camera
  lastStatus: null,
  myTaps: {},          // half -> our last tap, re-sent after a reconnect
};
try { sync.shield = localStorage.getItem('mc-shield') !== 'off'; } catch {}

const serverNow = () => Date.now() + sync.offset;
// High-resolution time of a tap, on the server's clock.
const tapTime = (e) => (e?.timeStamp ? performance.timeOrigin + e.timeStamp : Date.now()) + sync.offset;

// =====================================================================
// Shared clock: a few pings to learn the gap between our clock and the server's
// =====================================================================
function measureClock(rounds = 6) {
  sync.bestRtt = Infinity;
  for (let i = 0; i < rounds; i++) setTimeout(() => socket.emit('time-ping', { t0: Date.now() }), i * 300);
}
socket.on('time-pong', ({ t0, server }) => {
  const now = Date.now();
  const rtt = now - t0;
  if (rtt < sync.bestRtt) {      // the quickest round trip gives the best estimate
    sync.bestRtt = rtt;
    sync.offset = server - (t0 + rtt / 2);
  }
});
socket.on('connect', () => measureClock());
setInterval(() => { if (socket.connected) measureClock(3); }, 5 * 60 * 1000);

// =====================================================================
// Room sync state from the server
// =====================================================================
function applySyncState(state) {
  if (!state) return;
  sync.lags = state.lags || {};
  sync.flagged = state.flagged || [];
  sync.syncedHalves = Object.fromEntries((state.synced || []).map((s) => [s.id, s.halves]));
  applyDelays();
  renderSyncButton();
  renderSyncStatus();
  if (typeof renderPeople === 'function') renderPeople();
}
socket.on('joined', ({ sync: state }) => {
  applySyncState(state);
  // After a reconnect the server has forgotten our TV sync; send it again.
  Object.values(sync.myTaps).forEach((tap, i) => setTimeout(() => socket.emit('sync', tap), i * 600));
});
socket.on('sync-state', applySyncState);
socket.on('sync-error', ({ message }) => toast(message));

const myLag = () => (myId ? sync.lags[myId] ?? null : null);
const fmtSecs = (s) => (s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`);

// How many seconds to hold back this person for you (0 = live).
function spoilerDelayFor(id) {
  if (!sync.shield) return 0;
  const mine = myLag();
  const theirs = sync.lags[id];
  if (mine == null || theirs == null) return 0;
  const d = mine - theirs;
  return d > 0.3 ? d : 0;
}

function syncLabelFor(id) {
  const sid = id === 'me' ? myId : id;
  const lag = sync.lags[sid];
  if (sync.flagged?.includes(sid)) return '📺 Sync needs checking';
  let text = lag == null ? '📺 TV not synced' : lag === 0 ? '📺 TV furthest ahead' : `📺 TV ${fmtSecs(lag)} behind`;
  if (id !== 'me') {
    const d = spoilerDelayFor(id);
    if (d > 0) text += ` · you hear them ${fmtSecs(d)} later`;
  }
  return text;
}

// =====================================================================
// Applying the delays
// =====================================================================
function applyDelays() {
  const signature = [...peers.keys()].map((id) => `${id}:${spoilerDelayFor(id).toFixed(1)}`).join('|');
  const changed = signature !== sync.lastSignature;
  sync.lastSignature = signature;
  peers.forEach((peer, id) => {
    const d = spoilerDelayFor(id);
    setAudioDelay(id, d);
    delayerFor(id).setDelay(d);
    const tile = tileEl(id);
    if (tile) {
      tile.classList.toggle('delayed', d > 0);
      const badge = tile.querySelector('.delay-badge');
      if (badge) badge.textContent = d > 0 ? `⏳ ${fmtSecs(d)}` : '';
    }
  });
  if (changed && typeof renderStage === 'function') renderStage();
}
// New people, new tiles and new audio tracks all pick up their delay here.
setInterval(() => { if (peers.size) applyDelays(); }, 2000);

function onPeerClosed(id) {
  sync.delayers.get(id)?.stop();
  sync.delayers.delete(id);
}

// ---------------------------------------------------------------------
// Delayed video: we keep a rolling buffer of small JPEG snapshots of the
// person's camera and show the one from N seconds ago. (Buffering raw video
// for a minute would take gigabytes; this takes a few megabytes.)
// ---------------------------------------------------------------------
const CAPTURE_FPS = 12;
const CAPTURE_WIDTH = 480;

class VideoDelayer {
  constructor(id) {
    this.id = id;
    this.seconds = 0;
    this.frames = [];          // [{ t, blob }]
    this.timer = null;
    this.busy = false;
    this.shown = null;
    this.work = document.createElement('canvas');
  }

  setDelay(seconds) {
    this.seconds = seconds;
    if (seconds > 0 && !this.timer) {
      this.timer = setInterval(() => this.capture(), 1000 / CAPTURE_FPS);
    } else if (seconds <= 0 && this.timer) {
      this.stop();
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.frames = [];
    this.shown = null;
  }

  capture() {
    const video = tileEl(this.id)?.querySelector('video');
    if (!video || video.readyState < 2 || !video.videoWidth || this.busy) return;
    const w = Math.min(CAPTURE_WIDTH, video.videoWidth);
    const h = Math.round((w * video.videoHeight) / video.videoWidth);
    if (this.work.width !== w || this.work.height !== h) { this.work.width = w; this.work.height = h; }
    this.work.getContext('2d').drawImage(video, 0, 0, w, h);
    const t = performance.now();
    this.busy = true;
    this.work.toBlob((blob) => {
      this.busy = false;
      if (!blob || !this.timer) return;
      this.frames.push({ t, blob });
      // Keep just enough history: one frame older than we need, plus everything newer.
      const target = performance.now() - this.seconds * 1000;
      while (this.frames.length > 1 && this.frames[1].t <= target) this.frames.shift();
    }, 'image/jpeg', 0.65);
  }

  frameNow() {
    const target = performance.now() - this.seconds * 1000;
    let found = null;
    for (const f of this.frames) { if (f.t <= target) found = f; else break; }
    return found;
  }
}

function delayerFor(id) {
  if (!sync.delayers.has(id)) sync.delayers.set(id, new VideoDelayer(id));
  return sync.delayers.get(id);
}

function draw(canvas, bitmap) {
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
}

// Show the right delayed frame on each tile (and on the telly if needed).
function renderDelayed() {
  sync.delayers.forEach((d, id) => {
    if (!d.timer) return;
    const tile = tileEl(id);
    const frame = d.frameNow();
    tile?.classList.toggle('catching-up', !frame);
    const onStage = sync.stageTarget?.id === id;
    $('#pitch').classList.toggle('catching-up', onStage && !frame);
    if (!frame || frame === d.shown) return;
    d.shown = frame;
    createImageBitmap(frame.blob).then((bmp) => {
      const tileCanvas = tile?.querySelector('.delayed-view');
      if (tileCanvas) draw(tileCanvas, bmp);
      if (sync.stageTarget?.id === id) draw($('#stageCanvas'), bmp);
      bmp.close?.();
    }).catch(() => {});
  });
  requestAnimationFrame(renderDelayed);
}
requestAnimationFrame(renderDelayed);

// Called by renderStage(): if the telly shows a held-back camera, use the delayed picture.
function syncStage(src) {
  const held = src && src.kind === 'camera' && src.id !== 'me' && spoilerDelayFor(src.id) > 0;
  sync.stageTarget = held ? { id: src.id } : null;
  $('#pitch').classList.toggle('delayed-stage', !!held);
  if (!held) $('#pitch').classList.remove('catching-up');
  else delayerFor(src.id).shown = null; // redraw straight away
}

// =====================================================================
// Top-bar button
// =====================================================================
function liveStatus() {
  return mc?.shown?.fixture?.status?.short || null;
}

function renderSyncButton() {
  const btn = $('#syncBtn');
  const lag = myLag();
  const synced = lag != null;
  btn.classList.toggle('synced', synced);
  if (sync.flagged?.includes(myId)) {
    btn.classList.add('nudge');
    btn.querySelector('span').textContent = 'Check sync';
    return;
  }
  const live = ['1H', '2H'].includes(liveStatus());
  btn.classList.toggle('nudge', !synced && live);
  btn.querySelector('span').textContent = synced ? (lag === 0 ? 'Synced' : `Synced · ${fmtSecs(lag)} behind`) : 'Sync TV';
  btn.title = synced ? 'Synced with your TV. Click to re-sync or change settings.' : 'Sync with your TV so nobody spoils a goal';
}

// Nudge people to sync at kick-off and at the start of the second half.
setInterval(() => {
  const st = liveStatus();
  if (st && st !== sync.lastStatus) {
    const halves = sync.syncedHalves[myId] || [];
    if (sync.lastStatus && st === '1H' && !halves.length) toast('Kick-off! Tap ⏱ Sync TV the moment your TV shows it.');
    if (sync.lastStatus === 'HT' && st === '2H' && !halves.includes(2)) toast('Second half! Re-sync ⏱ as your TV kicks off to stay spot on.');
    sync.lastStatus = st;
    renderSyncButton();
  }
}, 1000);

// =====================================================================
// Sync dialog
// =====================================================================
$('#syncBtn').onclick = openSync;

function openSync() {
  setSyncMode(sync.mode || 'clock');
  resetClockTap();
  $('#shieldToggle').checked = sync.shield;
  renderSyncStatus();
  $('#syncDialog').showModal();
}

function setSyncMode(mode) {
  sync.mode = mode;
  document.querySelectorAll('#syncModes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#syncClockPane').hidden = mode !== 'clock';
  $('#syncKickoffPane').hidden = mode !== 'kickoff';
  if (mode === 'kickoff') {
    const st = liveStatus();
    setKickoffHalf(['HT', '2H'].includes(st) ? 2 : 1);
  }
}
document.querySelectorAll('#syncModes button').forEach((b) => { b.onclick = () => setSyncMode(b.dataset.mode); });

// ---- Match clock: tap as the minute ticks over, then confirm which minute ----
function resetClockTap() {
  sync.tap = null;
  $('#syncResult').textContent = '';
  $('#syncResult').classList.remove('warn');
  $('#syncTap').hidden = false;
  $('#syncConfirm').hidden = true;
}

$('#syncTap').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sync.tap = { at: tapTime(e) };
  $('#syncResult').textContent = '';
  // Best guess at the minute, from the match data if we have it.
  const f = mc?.shown?.fixture;
  const st = f?.status?.short;
  let minute = Number($('#syncMinute').value) || 0;
  let half = minute >= 45 ? 2 : 1;
  if (f && ['1H', '2H'].includes(st) && f.status.elapsed != null) {
    minute = f.status.elapsed;
    half = st === '2H' ? 2 : 1;
  } else if (st === 'HT') {
    minute = 45; half = 2;
  }
  $('#syncMinute').value = minute;
  setConfirmHalf(half);
  $('#syncTap').hidden = true;
  $('#syncConfirm').hidden = false;
  $('#syncMinute').focus();
});

function setConfirmHalf(half) {
  sync.confirmHalf = half;
  document.querySelectorAll('#syncHalf button').forEach((b) => b.classList.toggle('active', Number(b.dataset.half) === half));
}
document.querySelectorAll('#syncHalf button').forEach((b) => { b.onclick = () => setConfirmHalf(Number(b.dataset.half)); });

const nudgeMinute = (n) => {
  const input = $('#syncMinute');
  input.value = Math.max(0, Math.min(105, (Number(input.value) || 0) + n));
  if (Number(input.value) > 45 && sync.confirmHalf === 1 && Number(input.value) > 50) setConfirmHalf(2);
};
$('#minDown').onclick = () => nudgeMinute(-1);
$('#minUp').onclick = () => nudgeMinute(1);
$('#syncRetap').onclick = resetClockTap;

$('#syncSave').onclick = () => {
  const minute = Number($('#syncMinute').value);
  const half = sync.confirmHalf;
  if (!sync.tap || !Number.isFinite(minute)) return;
  if (half === 2 && minute < 45) { toast('The second half starts at 45:00. Check the minute.'); return; }
  if (half === 1 && minute > 60) { toast('That looks like a second-half time. Pick "Second half".'); return; }
  sendSync(half, minute * 60, sync.tap.at);
  resetClockTap();
};

// ---- Kick-off: tap the moment the referee starts the half ----
function setKickoffHalf(half) {
  sync.kickHalf = half;
  document.querySelectorAll('#kickHalf button').forEach((b) => b.classList.toggle('active', Number(b.dataset.half) === half));
}
document.querySelectorAll('#kickHalf button').forEach((b) => { b.onclick = () => setKickoffHalf(Number(b.dataset.half)); });

$('#syncKickTap').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sendSync(sync.kickHalf || 1, sync.kickHalf === 2 ? 45 * 60 : 0, tapTime(e));
});

function sendSync(half, clockSec, tapAt) {
  sync.myTaps[half] = { half, clockSec, tapAt }; // kept so we can re-send after a reconnect
  socket.emit('sync', { half, clockSec, tapAt });
  $('#syncResult').textContent = 'Synced! Checking against everyone else…';
  sync.awaitingResult = true;
}

$('#syncReset').onclick = () => {
  sync.myTaps = {};
  socket.emit('sync-clear');
  $('#syncResult').textContent = 'Your sync has been cleared.';
};

$('#shieldToggle').onchange = (e) => {
  sync.shield = e.target.checked;
  try { localStorage.setItem('mc-shield', sync.shield ? 'on' : 'off'); } catch {}
  applyDelays();
  renderSyncStatus();
};

function renderSyncStatus() {
  const list = $('#syncPeople');
  if (!list) return;
  list.replaceChildren();
  const rows = [['me', `${myName || 'You'} (you)`], ...[...peers.entries()].map(([id, p]) => [id, p.name])];
  rows.forEach(([id, name]) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'sync-name';
    n.textContent = name;
    const v = document.createElement('span');
    v.className = 'sync-val';
    v.textContent = syncLabelFor(id).replace('📺 ', '');
    li.append(n, v);
    list.appendChild(li);
  });

  const mine = myLag();
  const behindCount = [...peers.keys()].filter((id) => spoilerDelayFor(id) > 0).length;
  const anyoneSynced = Object.values(sync.lags).some((l) => l != null);
  let summary;
  if (mine == null) summary = 'You haven’t synced yet.';
  else if (!sync.shield) summary = 'Spoiler shield is off: you hear everyone live.';
  else if (behindCount) summary = `Your TV is behind, so ${behindCount === 1 ? '1 friend is' : `${behindCount} friends are`} held back to match it.`;
  else if (mine === 0 && Object.values(sync.lags).filter((l) => l != null).length > 1) summary = 'Your TV is furthest ahead. Friends behind you hear you a little later.';
  else if (!anyoneSynced || Object.values(sync.lags).filter((l) => l != null).length < 2) summary = 'Waiting for friends to sync too.';
  else summary = 'You’re in sync with everyone.';
  $('#syncSummary').textContent = summary;

  if (sync.flagged?.includes(myId)) {
    sync.awaitingResult = false;
    $('#syncResult').textContent = 'That sync is more than 2½ minutes away from everyone else’s, so it isn’t being used. Check the minute you picked and tap again.';
    $('#syncResult').classList.add('warn');
  } else if (sync.awaitingResult && mine != null) {
    $('#syncResult').classList.remove('warn');
    sync.awaitingResult = false;
    $('#syncResult').textContent = mine === 0 ? 'Synced.' : `Synced. Your TV is ${fmtSecs(mine)} behind the furthest-ahead TV in the room.`;
  }
}
