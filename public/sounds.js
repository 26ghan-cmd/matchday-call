'use strict';
// Soundboard: football sounds everyone in the room hears. Every sound is made
// in code with Web Audio (no recordings), so there's nothing to download and no
// copyright to worry about. Sounds from friends whose TV is ahead of yours are
// held back by the spoiler shield, just like reactions.
//
// Uses globals from app.js: socket, audioCtx, myId, tileEl, floatEmoji, afterShield, toast.

const SOUND_LIST = [
  { id: 'whistle', icon: '🔔', label: 'Whistle' },
  { id: 'fulltime', icon: '🏁', label: 'Full-time' },
  { id: 'airhorn', icon: '📯', label: 'Air horn' },
  { id: 'goalhorn', icon: '🚨', label: 'Goal horn' },
  { id: 'roar', icon: '🏟️', label: 'Crowd roar' },
  { id: 'ooh', icon: '😮', label: 'Ooh!' },
  { id: 'boo', icon: '👎', label: 'Boo' },
  { id: 'drums', icon: '🥁', label: 'Drums' },
];

const soundPrefs = { volume: 0.7, muted: false };
try {
  const v = localStorage.getItem('mc-sound-volume');
  if (v != null) soundPrefs.volume = Number(v);
  soundPrefs.muted = localStorage.getItem('mc-sound-muted') === '1';
} catch {}

let soundOut = null;   // master gain for the soundboard
let noise = null;      // a couple of seconds of white noise, reused

function soundOutput() {
  if (!audioCtx) return null;
  if (!soundOut) {
    soundOut = audioCtx.createGain();
    soundOut.connect(audioCtx.destination);
  }
  soundOut.gain.value = soundPrefs.muted ? 0 : soundPrefs.volume * 0.6;
  return soundOut;
}

function noiseSource() {
  if (!noise) {
    noise = audioCtx.createBuffer(1, audioCtx.sampleRate * 3, audioCtx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  return src;
}

// Volume envelope: rise, hold, fade.
function envelope(param, t, { attack = 0.01, hold = 0.3, release = 0.2, peak = 1 }) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return t + attack + hold + release;
}

function osc(type, freq, t, end) {
  const o = audioCtx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.start(t);
  o.stop(end + 0.05);
  return o;
}

const SYNTHS = {
  // Pea whistle: a high tone with a fast warble from the pea rattling around.
  whistle(out, t, length = 0.7) {
    const g = audioCtx.createGain();
    const end = envelope(g.gain, t, { attack: 0.02, hold: length, release: 0.08, peak: 0.5 });
    const tone = osc('sine', 2900, t, end);
    const trill = osc('square', 26, t, end);
    const depth = audioCtx.createGain();
    depth.gain.value = 120;
    trill.connect(depth).connect(tone.frequency);
    const am = audioCtx.createGain();
    am.gain.value = 0.7;
    const amDepth = audioCtx.createGain();
    amDepth.gain.value = 0.3;
    trill.connect(amDepth).connect(am.gain);
    tone.connect(am).connect(g).connect(out);
  },

  // Three blasts: short, short, long.
  fulltime(out, t) {
    SYNTHS.whistle(out, t, 0.3);
    SYNTHS.whistle(out, t + 0.5, 0.3);
    SYNTHS.whistle(out, t + 1.0, 1.1);
  },

  // A brassy three-note chord with a little pitch lift at the start.
  airhorn(out, t) {
    const g = audioCtx.createGain();
    const end = envelope(g.gain, t, { attack: 0.03, hold: 1.0, release: 0.25, peak: 0.25 });
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2600;
    [466, 587, 698].forEach((f) => {
      const o = osc('sawtooth', f * 0.94, t, end);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
      o.connect(filter);
    });
    filter.connect(g).connect(out);
  },

  // Deep stadium horn with a slow wobble.
  goalhorn(out, t) {
    const g = audioCtx.createGain();
    const end = envelope(g.gain, t, { attack: 0.08, hold: 1.8, release: 0.5, peak: 0.35 });
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const wobble = osc('sine', 5, t, end);
    const wobbleDepth = audioCtx.createGain();
    wobbleDepth.gain.value = 2.5;
    wobble.connect(wobbleDepth);
    [110, 138.6, 164.8].forEach((f) => {
      const o = osc('sawtooth', f, t, end);
      wobbleDepth.connect(o.frequency);
      o.connect(filter);
    });
    filter.connect(g).connect(out);
  },

  // Thousands of voices: shaped noise that swells and surges.
  roar(out, t) {
    const g = audioCtx.createGain();
    const end = envelope(g.gain, t, { attack: 0.5, hold: 2.0, release: 1.2, peak: 0.9 });
    [[650, 0.7, 1], [1400, 1.2, 0.45]].forEach(([freq, q, level]) => {
      const n = noiseSource();
      const band = audioCtx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = freq;
      band.Q.value = q;
      const lvl = audioCtx.createGain();
      lvl.gain.value = level;
      n.connect(band).connect(lvl).connect(g);
      n.start(t);
      n.stop(end + 0.05);
    });
    const surge = osc('sine', 2.3, t, end);
    const surgeDepth = audioCtx.createGain();
    surgeDepth.gain.value = 0.25;
    surge.connect(surgeDepth).connect(g.gain);
    g.connect(out);
  },

  // A near miss: voices that rise into "oooh" and fall away.
  ooh(out, t) {
    const g = audioCtx.createGain();
    const end = envelope(g.gain, t, { attack: 0.15, hold: 0.8, release: 0.6, peak: 1.6 });
    const vowel = audioCtx.createBiquadFilter();
    vowel.type = 'bandpass';
    vowel.Q.value = 2.5;
    vowel.frequency.setValueAtTime(520, t);
    vowel.frequency.linearRampToValueAtTime(360, end);
    const n = noiseSource();
    n.connect(vowel);
    n.start(t);
    n.stop(end + 0.05);
    for (let i = 0; i < 6; i++) {
      const base = 170 + Math.random() * 90;
      const o = osc('sawtooth', base * 0.92, t, end);
      o.frequency.linearRampToValueAtTime(base * 1.05, t + 0.35);
      o.frequency.linearRampToValueAtTime(base * 0.8, end);
      const v = audioCtx.createGain();
      v.gain.value = 0.05;
      o.connect(v).connect(vowel);
    }
    vowel.connect(g).connect(out);
  },

  // Low, sustained booing from the stands.
  boo(out, t) {
    const g = audioCtx.createGain();
    const end = envelope(g.gain, t, { attack: 0.3, hold: 1.6, release: 0.6, peak: 2.6 });
    const vowel = audioCtx.createBiquadFilter();
    vowel.type = 'bandpass';
    vowel.frequency.value = 330;
    vowel.Q.value = 1.8;
    const n = noiseSource();
    const nl = audioCtx.createGain();
    nl.gain.value = 0.5;
    n.connect(nl).connect(vowel);
    n.start(t);
    n.stop(end + 0.05);
    for (let i = 0; i < 8; i++) {
      const base = 105 + Math.random() * 70;
      const o = osc('sawtooth', base, t, end);
      const vib = osc('sine', 4 + Math.random() * 3, t, end);
      const vd = audioCtx.createGain();
      vd.gain.value = 3;
      vib.connect(vd).connect(o.frequency);
      const v = audioCtx.createGain();
      v.gain.value = 0.045;
      o.connect(v).connect(vowel);
    }
    vowel.connect(g).connect(out);
  },

  // Terrace drum: boom … boom … boom-boom-boom.
  drums(out, t) {
    [0, 0.5, 1.0, 1.25, 1.5].forEach((at, i) => {
      const s = t + at;
      const g = audioCtx.createGain();
      const end = envelope(g.gain, s, { attack: 0.005, hold: 0.02, release: 0.35, peak: i > 1 ? 0.8 : 1 });
      const o = osc('sine', 150, s, end);
      o.frequency.exponentialRampToValueAtTime(48, s + 0.3);
      o.connect(g).connect(out);
      // a slap of skin on top
      const n = noiseSource();
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const ng = audioCtx.createGain();
      envelope(ng.gain, s, { attack: 0.002, hold: 0.005, release: 0.06, peak: 0.25 });
      n.connect(hp).connect(ng).connect(out);
      n.start(s);
      n.stop(s + 0.1);
    });
  },
};

function playSound(id) {
  const out = soundOutput();
  if (!out || !SYNTHS[id] || soundPrefs.muted) return;
  if (audioCtx.state !== 'running') audioCtx.resume();
  try {
    SYNTHS[id](out, audioCtx.currentTime + 0.02);
  } catch (err) {
    console.warn('Sound failed', id, err);
  }
}

// ---------- Sending and receiving ----------
socket.on('sound', ({ id, name, sound }) => afterShield(id, () => {
  playSound(sound);
  const entry = SOUND_LIST.find((s) => s.id === sound);
  const tileId = id === myId ? 'me' : id;
  if (entry) floatEmoji(tileEl(tileId)?.querySelector('.float-layer'), entry.icon);
}));

let lastSoundAt = 0;
function sendSound(id) {
  if (Date.now() - lastSoundAt < 1200) { toast('Easy! One sound at a time.'); return; }
  lastSoundAt = Date.now();
  socket.emit('sound', { sound: id });
}

// ---------- The sounds section of the React tray ----------
function buildSoundTray() {
  const box = $('#reactionTray .tray-sounds');
  if (!box || box.children.length) return;
  SOUND_LIST.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sound-btn';
    b.title = `Play "${s.label}" for everyone`;
    b.innerHTML = `<span class="sound-icon"></span><span class="sound-label"></span>`;
    b.querySelector('.sound-icon').textContent = s.icon;
    b.querySelector('.sound-label').textContent = s.label;
    b.onclick = (e) => { e.stopPropagation(); sendSound(s.id); };
    b.dataset.index = i;
    box.appendChild(b);
  });
  const vol = $('#soundVolume');
  vol.value = Math.round(soundPrefs.volume * 100);
  vol.oninput = () => {
    soundPrefs.volume = vol.value / 100;
    try { localStorage.setItem('mc-sound-volume', String(soundPrefs.volume)); } catch {}
    soundOutput();
  };
  const mute = $('#soundMute');
  const renderMute = () => {
    mute.textContent = soundPrefs.muted ? 'Sounds off' : 'Sounds on';
    mute.setAttribute('aria-pressed', String(!soundPrefs.muted));
    mute.classList.toggle('off', soundPrefs.muted);
  };
  mute.onclick = (e) => {
    e.stopPropagation();
    soundPrefs.muted = !soundPrefs.muted;
    try { localStorage.setItem('mc-sound-muted', soundPrefs.muted ? '1' : '0'); } catch {}
    soundOutput();
    renderMute();
  };
  renderMute();
}
$('#reactBtn').addEventListener('click', buildSoundTray);
