// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow all origins - tighten this in production if needed
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

// rooms: { [roomId]: { players: [socketId], ready: {id:bool}, choices: {id:choice}, scores: {id:score} } }
const rooms = {};

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId) {
      socket.emit('no-room');
      return;
    }
    socket.join(roomId);
    socket.data.name = name || ('Player' + Math.floor(Math.random()*999));
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], ready: {}, choices: {}, scores: {} };
    }

    if (!rooms[roomId].players.includes(socket.id)) {
      rooms[roomId].players.push(socket.id);
      rooms[roomId].ready[socket.id] = false;
      rooms[roomId].scores[socket.id] = rooms[roomId].scores[socket.id] || 0;
    }

    emitPlayers(roomId);
  });

  socket.on('player-ready', ({ roomId }) => {
    if (!rooms[roomId]) return;
    rooms[roomId].ready[socket.id] = true;
    emitPlayers(roomId);

    const allReady = rooms[roomId].players.length > 0 && rooms[roomId].players.every(id => rooms[roomId].ready[id]);
    if (allReady) {
      io.to(roomId).emit('start-countdown', { seconds: 10 });
    }
  });

  socket.on('player-unready', ({ roomId }) => {
    if (!rooms[roomId]) return;
    rooms[roomId].ready[socket.id] = false;
    emitPlayers(roomId);
  });

  // receive choice
  socket.on('player-choice', ({ roomId, choice }) => {
    if (!rooms[roomId]) return;
    rooms[roomId].choices[socket.id] = choice; // may be 'stone'|'paper'|'scissor' or null

    const r = rooms[roomId];
    // If all players have submitted a choice (or we want to base on player count)
    if (Object.keys(r.choices).length === r.players.length) {
      // Determine plays: default to 'stone' if null/undefined
      const [p1, p2] = r.players;
      const c1 = r.choices[p1] ?? 'stone';
      const c2 = r.choices[p2] ?? 'stone';
      const n1 = io.sockets.sockets.get(p1)?.data.name || 'Player 1';
      const n2 = io.sockets.sockets.get(p2)?.data.name || 'Player 2';

      const result = decideWinner({ id1: p1, id2: p2, n1, n2, c1, c2 });

      // update scores
      if (result.winnerId) {
        r.scores[result.winnerId] = (r.scores[result.winnerId] || 0) + 1;
      }

      // attach choices and scores
      result.choices = { [n1]: c1, [n2]: c2 };
      result.scores = { [n1]: r.scores[p1] || 0, [n2]: r.scores[p2] || 0 };

      io.to(roomId).emit('round-result', result);

      // reset for next round
      r.choices = {};
      r.ready = r.players.reduce((acc,id)=>{ acc[id]=false; return acc; }, {});
      emitPlayers(roomId);
    }
  });

  socket.on('send_emoji', ({ roomId, emoji }) => {
    if (!rooms[roomId]) return;
    const payload = { id: socket.id, name: socket.data.name, emoji };
    // broadcast to everyone in room (including sender) for consistent display
    io.to(roomId).emit('receive_emoji', payload);
  });

  socket.on('disconnect', () => {
    // remove from rooms
    for (const rid in rooms) {
      const room = rooms[rid];
      if (room.players.includes(socket.id)) {
        room.players = room.players.filter(id => id !== socket.id);
        delete room.ready[socket.id];
        delete room.choices[socket.id];
        delete room.scores[socket.id];
        io.to(rid).emit('player-left', { id: socket.id, name: socket.data.name });
        emitPlayers(rid);
      }
      if (room.players.length === 0) delete rooms[rid];
    }
    console.log('Disconnected:', socket.id);
  });
});

function emitPlayers(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  const players = r.players.map(id => ({
    id,
    name: io.sockets.sockets.get(id)?.data.name || 'Player',
    ready: r.ready[id] || false,
    score: r.scores[id] || 0
  }));
  io.to(roomId).emit('update-players', { players });
}

function decideWinner({ id1, id2, n1, n2, c1, c2 }) {
  // normalize to lower-case
  const a = String(c1).toLowerCase();
  const b = String(c2).toLowerCase();

  // if both same choice -> draw
  if (a === b) {
    return { text: `Draw — both chose ${a}`, winnerId: null, draw: true };
  }

  const winMap = { stone: 'scissor', scissor: 'paper', paper: 'stone' };
  if (winMap[a] === b) {
    return { text: `${n1} wins — ${a} beats ${b}`, winnerId: id1, loserId: id2, draw: false, winnerName: n1 };
  } else {
    return { text: `${n2} wins — ${b} beats ${a}`, winnerId: id2, loserId: id1, draw: false, winnerName: n2 };
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
