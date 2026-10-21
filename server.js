// Matchday Call — server.
// Video and audio flow directly between browsers (WebRTC). This server
// introduces people in the same room, relays chat and reactions, and serves
// live match data (score, stats, play-by-play, odds) to each room.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { MatchHub } = require('./match/hub');

const PORT = process.env.PORT || 3000;
const MAX_PEERS = 6; // mesh calls work well up to ~6 people
const CHAT_HISTORY = 100; // messages kept per room for people who join late
const REACTIONS = ['⚽', '🔥', '😱', '👏', '😂', '🟥'];
const DEFAULT_STATE = { mic: true, cam: true, screen: false };
const chatHistory = new Map(); // room -> [{ id, name, text, ts }]

// Simple per-person rate limit so nobody can flood the room.
function tooSoon(socket, key, ms) {
  const now = Date.now();
  const last = socket.data['last_' + key] || 0;
  socket.data['last_' + key] = now;
  return now - last < ms;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Match data ----------
// Each room follows at most one match; the hub fetches each match once and we
// send every update to all the rooms following it.
const hub = new MatchHub();
const roomMatch = new Map(); // room -> fixture id

hub.on('update', (fixtureId, payload) => {
  if (!payload) return;
  hub.watchersOf(fixtureId).forEach((room) => io.to(room).emit('match', payload));
});

app.get('/api/fixtures', async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await hub.listFixtures());
});

function followMatch(room, fixtureId) {
  const previous = roomMatch.get(room);
  if (previous) hub.unwatch(previous, room);
  if (!fixtureId) { roomMatch.delete(room); return null; }
  const id = hub.watch(fixtureId, room);
  roomMatch.set(room, id);
  return id;
}

// ---------- ICE servers (STUN + TURN relay) ----------
// TURN relays video when two people's networks block a direct connection.
// Configure ONE provider with environment variables (e.g. on Render):
//   Metered:    METERED_APP_NAME, METERED_API_KEY
//   Cloudflare: CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN
//   Any other:  TURN_URLS (comma-separated), TURN_USERNAME, TURN_CREDENTIAL
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceCache = { servers: null, expires: 0 };

async function fetchIceServers() {
  const env = process.env;

  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );
    if (!res.ok) throw new Error(`Cloudflare TURN returned ${res.status}`);
    const { iceServers } = await res.json();
    // Port 53 URLs tend to time out in browsers; drop them.
    const list = (Array.isArray(iceServers) ? iceServers : [iceServers]).map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    }));
    return { servers: list, ttlMs: 12 * 3600e3 };
  }

  if (env.METERED_APP_NAME && env.METERED_API_KEY) {
    const res = await fetch(
      `https://${env.METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`
    );
    if (!res.ok) throw new Error(`Metered TURN returned ${res.status}`);
    return { servers: await res.json(), ttlMs: 3600e3 };
  }

  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    return {
      servers: [
        ...FALLBACK_ICE,
        {
          urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL,
        },
      ],
      ttlMs: 24 * 3600e3,
    };
  }

  return { servers: FALLBACK_ICE, ttlMs: 24 * 3600e3 };
}

app.get('/ice', async (req, res) => {
  try {
    if (!iceCache.servers || Date.now() > iceCache.expires) {
      const { servers, ttlMs } = await fetchIceServers();
      iceCache = { servers, expires: Date.now() + ttlMs };
    }
    res.set('Cache-Control', 'no-store').json(iceCache.servers);
  } catch (err) {
    console.error('TURN setup failed:', err.message);
    res.json(FALLBACK_ICE); // the call still works for people on friendly networks
  }
});

io.on('connection', (socket) => {
  socket.on('join', ({ room, name } = {}) => {
    room = String(room || '').trim().slice(0, 64);
    name = String(name || 'Fan').trim().slice(0, 32) || 'Fan';
    if (!room || socket.data.room) return;

    const members = io.sockets.adapter.rooms.get(room);
    if (members && members.size >= MAX_PEERS) {
      socket.emit('room-full', { max: MAX_PEERS });
      return;
    }

    const peers = members
      ? [...members].map((id) => {
          const s = io.sockets.sockets.get(id);
          return { id, name: s?.data.name || 'Fan', state: s?.data.state || DEFAULT_STATE };
        })
      : [];

    socket.data.room = room;
    socket.data.name = name;
    socket.data.state = { ...DEFAULT_STATE };
    socket.join(room);
    const matchId = roomMatch.get(room) || null;
    socket.emit('joined', {
      id: socket.id, peers, history: chatHistory.get(room) || [],
      match: matchId ? { fixtureId: matchId, data: hub.payload(matchId) } : null,
    });
    socket.to(room).emit('peer-joined', { id: socket.id, name, state: socket.data.state });
  });

  // Text chat. The server keeps the last messages so late joiners can catch up;
  // history is forgotten once the room empties.
  socket.on('chat', ({ text } = {}) => {
    const room = socket.data.room;
    if (!room) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text || tooSoon(socket, 'chat', 300)) return;
    const msg = { id: socket.id, name: socket.data.name, text, ts: Date.now() };
    const list = chatHistory.get(room) || [];
    list.push(msg);
    if (list.length > CHAT_HISTORY) list.shift();
    chatHistory.set(room, list);
    io.to(room).emit('chat', msg);
  });

  // Anyone in the room can choose which match the room is following.
  socket.on('select-match', async ({ fixtureId } = {}) => {
    const room = socket.data.room;
    if (!room || tooSoon(socket, 'select', 1500)) return;
    let id = fixtureId == null ? null : String(fixtureId).slice(0, 32);
    if (id && id !== 'demo') {
      await hub.listFixtures(); // make sure the fixture list is loaded
      if (!socket.connected || socket.data.room !== room) return;
      if (!hub.isKnownFixture(id)) {
        socket.emit('match-error', { message: "Couldn't find that match." });
        return;
      }
    }
    id = followMatch(room, id);
    io.to(room).emit('match-selected', { fixtureId: id, by: socket.data.name, data: id ? hub.payload(id) : null });
  });

  // Quick emoji reactions.
  socket.on('reaction', ({ emoji } = {}) => {
    const room = socket.data.room;
    if (!room || !REACTIONS.includes(emoji) || tooSoon(socket, 'reaction', 250)) return;
    io.to(room).emit('reaction', { id: socket.id, emoji });
  });

  // Relay WebRTC offers/answers/ICE candidates between two people in the same room.
  socket.on('signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    if (!target || !socket.data.room || target.data.room !== socket.data.room) return;
    target.emit('signal', { from: socket.id, name: socket.data.name, data });
  });

  // Mic/camera/screen-share status, so others can show icons and size tiles.
  socket.on('state', ({ mic, cam, screen } = {}) => {
    if (!socket.data.room) return;
    socket.data.state = { mic: !!mic, cam: !!cam, screen: !!screen };
    socket.to(socket.data.room).emit('peer-state', { id: socket.id, ...socket.data.state });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room) return;
    socket.to(room).emit('peer-left', { id: socket.id });
    if (!io.sockets.adapter.rooms.get(room)) {
      chatHistory.delete(room);
      followMatch(room, null); // stop fetching data nobody is watching
    }
  });
});

server.listen(PORT, () => {
  console.log(`Matchday Call running at http://localhost:${PORT}`);
  const env = process.env;
  const provider =
    env.CLOUDFLARE_TURN_KEY_ID ? 'Cloudflare' :
    env.METERED_APP_NAME ? 'Metered' :
    env.TURN_URLS ? 'custom TURN' : null;
  console.log(provider
    ? `TURN relay: ${provider}`
    : 'TURN relay: not configured (some friends may fail to connect; see README)');
  console.log(env.API_FOOTBALL_KEY
    ? 'Match data: API-Football'
    : 'Match data: demo only (set API_FOOTBALL_KEY for live Premier League data)');
  console.log(env.ANTHROPIC_API_KEY
    ? 'Match analysis: Claude'
    : 'Match analysis: stats-based (set ANTHROPIC_API_KEY for AI-written analysis)');
});
