// Matchday Call — browser client.
// Each person connects directly to every other person in the room (a "mesh").

// STUN lets browsers discover their public address. For friends behind strict
// firewalls/mobile networks you'll also want a TURN server — see README.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const $ = (s) => document.querySelector(s);
const socket = io({ autoConnect: false });
const peers = new Map(); // socketId -> { pc, name, queue, pending }
let localStream = null;
let screenTrack = null; // set while sharing your screen
let audioCtx = null;

const cameraTrack = () => localStream.getVideoTracks()[0];
const outgoingVideo = () => screenTrack || cameraTrack();
let myName = '';

// ---------- Lobby ----------
const params = new URLSearchParams(location.search);
$('#room').value = params.get('room') || 'matchday-' + Math.random().toString(36).slice(2, 6);
try { $('#name').value = localStorage.getItem('mc-name') || ''; } catch {}

async function startPreview() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
      // Echo cancellation + noise suppression matter here: everyone has a TV
      // blaring commentary, and we don't want it fed back into the call.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    $('#preview').srcObject = localStream;
  } catch (err) {
    $('#lobbyError').textContent =
      'Camera/mic unavailable (' + err.name + '). Allow access in your browser and reload.';
    $('#joinBtn').disabled = true;
  }
}
startPreview();

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!localStream) return;
  myName = $('#name').value.trim() || 'Fan';
  const room = $('#room').value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64);
  try { localStorage.setItem('mc-name', myName); } catch {}
  history.replaceState(null, '', '?room=' + encodeURIComponent(room));

  audioCtx = new (window.AudioContext || window.webkitAudioContext)(); // needs a click to start
  $('#roomLabel').textContent = room;
  $('#lobby').hidden = true;
  $('#call').hidden = false;
  document.body.className = 'match';

  addTile('me', myName + ' (you)', localStream, true);
  socket.connect();
  socket.emit('join', { room, name: myName });
});

// ---------- Video tiles ----------
function addTile(id, name, stream, isLocal = false) {
  let tile = document.getElementById('tile-' + id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile' + (isLocal ? ' local' : '');
    tile.id = 'tile-' + id;
    tile.dataset.initial = (name || '?').trim().charAt(0).toUpperCase();
    tile.innerHTML =
      '<video autoplay playsinline></video>' +
      '<div class="label"><span class="name"></span><span class="mute-icon" title="Muted">🔇</span></div>';
    tile.querySelector('.name').textContent = name;
    const video = tile.querySelector('video');
    if (isLocal) video.muted = true; // never play your own mic back
    $('#tiles').appendChild(tile);
    updateCount();
  }
  if (stream) {
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    watchSpeaking(tile, stream);
  }
  return tile;
}

function removeTile(id) {
  document.getElementById('tile-' + id)?.remove();
  updateCount();
}

function updateCount() {
  const n = $('#tiles').children.length;
  $('#tiles').dataset.count = n;
  $('#countLabel').textContent = n + (n === 1 ? ' fan' : ' fans');
}

// Green ring around whoever is talking (or shouting at the ref).
function watchSpeaking(tile, stream) {
  if (!audioCtx || tile._analyser || !stream.getAudioTracks().length) return;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  tile._analyser = analyser;
  const buf = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!tile.isConnected) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    tile.classList.toggle('speaking', Math.sqrt(sum / buf.length) > 0.04 && !tile.classList.contains('muted'));
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------- WebRTC peers ----------
function createPeer(id, name, initiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = { pc, name, queue: Promise.resolve(), pending: [] };
  peers.set(id, peer);

  // Send mic + whatever video we're currently showing (camera or shared screen).
  localStream.getAudioTracks().forEach((t) => pc.addTrack(t, localStream));
  if (outgoingVideo()) pc.addTrack(outgoingVideo(), localStream);
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => addTile(id, name, e.streams[0]);
  pc.onconnectionstatechange = () => {
    const tile = document.getElementById('tile-' + id);
    if (tile) tile.dataset.state = pc.connectionState;
    if (pc.connectionState === 'failed') {
      toast(`Couldn't reach ${name}. Their network may need a TURN server.`);
    }
  };

  addTile(id, name, null);

  if (initiator) {
    enqueue(peer, async () => {
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('signal', { to: id, data: { description: pc.localDescription } });
    });
  }
  return peer;
}

// Process each peer's signaling messages strictly in order.
function enqueue(peer, fn) {
  peer.queue = peer.queue.then(fn).catch((err) => console.error('signaling error', err));
}

function closePeer(id) {
  const peer = peers.get(id);
  if (peer) peer.pc.close();
  peers.delete(id);
  removeTile(id);
}

// ---------- Signaling events ----------
socket.on('joined', ({ peers: list }) => {
  list.forEach((p) => createPeer(p.id, p.name, true)); // newcomer calls everyone
  toast(list.length ? `You're in. ${list.length} already here.` : "You're first in. Share the invite link!");
  sendState();
});

socket.on('peer-joined', ({ id, name }) => {
  if (!peers.has(id)) createPeer(id, name, false);
  toast(`${name} joined`);
  sendState(); // so they see whether we're muted
});

socket.on('signal', ({ from, name, data }) => {
  const peer = peers.get(from) || createPeer(from, name, false);
  const { pc } = peer;
  enqueue(peer, async () => {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  });
});

socket.on('peer-state', ({ id, mic, cam, screen }) => {
  const tile = document.getElementById('tile-' + id);
  if (!tile) return;
  const wasSharing = tile.classList.contains('sharing');
  tile.classList.toggle('muted', !mic);
  tile.classList.toggle('cam-off', !cam && !screen);
  tile.classList.toggle('sharing', !!screen);
  if (screen && !wasSharing) toast(`${peers.get(id)?.name || 'Someone'} is sharing their screen`);
});

socket.on('peer-left', ({ id }) => {
  const name = peers.get(id)?.name;
  closePeer(id);
  if (name) toast(`${name} left`);
});

socket.on('room-full', ({ max }) => {
  toast(`That room is full (max ${max}). Try another room name.`);
  setTimeout(() => location.reload(), 2500);
});

socket.on('disconnect', (reason) => {
  if (reason !== 'io client disconnect') toast('Connection lost. Reload to rejoin.');
});

// ---------- Controls ----------
function sendState() {
  const mic = localStream.getAudioTracks()[0]?.enabled ?? false;
  const cam = cameraTrack()?.enabled ?? false;
  const screen = !!screenTrack;
  socket.emit('state', { mic, cam, screen });

  const me = document.getElementById('tile-me');
  me?.classList.toggle('muted', !mic);
  me?.classList.toggle('cam-off', !cam && !screen);
  me?.classList.toggle('sharing', screen);
  setBtn('#micBtn', mic, 'Mic on', 'Muted');
  setBtn('#camBtn', cam, 'Camera on', 'Camera off');
  const shareBtn = $('#shareBtn');
  shareBtn.classList.toggle('sharing', screen);
  shareBtn.querySelector('span').textContent = screen ? 'Stop sharing' : 'Share screen';
}

function setBtn(sel, on, onText, offText) {
  const b = $(sel);
  b.classList.toggle('on', on);
  b.querySelector('span').textContent = on ? onText : offText;
}

function toggleTrack(kind) {
  const track = kind === 'audio' ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  sendState();
}

$('#micBtn').onclick = () => toggleTrack('audio');
$('#camBtn').onclick = () => toggleTrack('video');

// ---------- Screen sharing ----------
// Swaps the video we send to everyone from camera to screen (no reconnect needed).
async function setOutgoingVideo(track) {
  await Promise.all([...peers.values()].map(({ pc }) => {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) return sender.replaceTrack(track).catch(console.error);
  }));
  const meVideo = document.querySelector('#tile-me video');
  if (meVideo) meVideo.srcObject = track === cameraTrack() ? localStream : new MediaStream([track]);
}

async function startShare() {
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false, // the call already has your mic; shared audio would echo the TV
    });
    screenTrack = display.getVideoTracks()[0];
    screenTrack.contentHint = 'detail'; // keep text (stats, tables) sharp
    screenTrack.onended = stopShare;    // browser's own "Stop sharing" bar
    await setOutgoingVideo(screenTrack);
    sendState();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Screen sharing failed: ' + err.message);
  }
}

async function stopShare() {
  if (!screenTrack) return;
  const t = screenTrack;
  screenTrack = null;
  t.onended = null;
  t.stop();
  await setOutgoingVideo(cameraTrack());
  sendState();
}

const canShare = !!navigator.mediaDevices?.getDisplayMedia;
if (!canShare) $('#shareBtn').hidden = true; // phones don't support it
$('#shareBtn').onclick = () => (screenTrack ? stopShare() : startShare());

$('#inviteBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Invite link copied');
  } catch {
    prompt('Copy this invite link:', location.href);
  }
};

$('#leaveBtn').onclick = () => {
  socket.disconnect();
  [...peers.keys()].forEach(closePeer);
  screenTrack?.stop();
  localStream.getTracks().forEach((t) => t.stop());
  location.reload();
};

// Match = compact strip of faces, eyes on the TV. Halftime = big grid, time to chat.
document.querySelectorAll('.mode-switch button').forEach((btn) => {
  btn.onclick = () => setMode(btn.dataset.mode);
});
function setMode(mode) {
  document.body.className = mode;
  document.querySelectorAll('.mode-switch button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode));
}

document.addEventListener('keydown', (e) => {
  if ($('#call').hidden || e.target.tagName === 'INPUT') return;
  if (e.key === 'm' || e.key === 'M') toggleTrack('audio');
  if (e.key === 'v' || e.key === 'V') toggleTrack('video');
  if ((e.key === 's' || e.key === 'S') && canShare) screenTrack ? stopShare() : startShare();
  if (e.key === 'h' || e.key === 'H') setMode(document.body.className === 'match' ? 'halftime' : 'match');
});

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
