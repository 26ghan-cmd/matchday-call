// Matchday Call — signaling server.
// Video and audio flow directly between browsers (WebRTC). This server only
// introduces people in the same room and relays their connection details.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PEERS = 6; // mesh calls work well up to ~6 people

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

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
      ? [...members].map((id) => ({ id, name: io.sockets.sockets.get(id)?.data.name || 'Fan' }))
      : [];

    socket.data.room = room;
    socket.data.name = name;
    socket.join(room);
    socket.emit('joined', { id: socket.id, peers });
    socket.to(room).emit('peer-joined', { id: socket.id, name });
  });

  // Relay WebRTC offers/answers/ICE candidates between two people in the same room.
  socket.on('signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    if (!target || !socket.data.room || target.data.room !== socket.data.room) return;
    target.emit('signal', { from: socket.id, name: socket.data.name, data });
  });

  // Mic/camera on-off status, so others can show a muted icon.
  socket.on('state', ({ mic, cam } = {}) => {
    if (!socket.data.room) return;
    socket.to(socket.data.room).emit('peer-state', { id: socket.id, mic: !!mic, cam: !!cam });
  });

  socket.on('disconnect', () => {
    if (socket.data.room) socket.to(socket.data.room).emit('peer-left', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Matchday Call running at http://localhost:${PORT}`);
});
