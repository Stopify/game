const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const BOT_COUNT = 5;
const BOT_NAMES = ['Chomper', 'Gooey', 'Nibbles', 'Blorp', 'Wiggles', 'Snapper'];
const BOT_COLORS = ['#8888aa', '#aa8866', '#66aa88', '#aa6688', '#88aa66', '#6688aa'];
const WORLD = 2400;

const rooms = {}; // code -> { bots: [...], interval }

function makeBot(i) {
  return {
    id: 'bot-' + i,
    x: 200 + Math.random() * (WORLD - 400),
    y: 200 + Math.random() * (WORLD - 400),
    tx: 200 + Math.random() * (WORLD - 400),
    ty: 200 + Math.random() * (WORLD - 400),
    level: 1 + Math.floor(Math.random() * 3),
    hp: 60,
    maxHp: 60,
    name: BOT_NAMES[i % BOT_NAMES.length],
    color: BOT_COLORS[i % BOT_COLORS.length],
    bulk: 0,
  };
}

function ensureRoom(code) {
  if (rooms[code]) return rooms[code];
  const bots = [];
  for (let i = 0; i < BOT_COUNT; i++) bots.push(makeBot(i));
  const room = { bots };
  room.interval = setInterval(() => tickBots(code), 100);
  rooms[code] = room;
  return room;
}

function tickBots(code) {
  const room = rooms[code];
  if (!room) return;
  room.bots.forEach((b) => {
    if (b.respawnAt) {
      if (Date.now() < b.respawnAt) return;
      b.respawnAt = null;
      b.hp = b.maxHp;
      b.x = 200 + Math.random() * (WORLD - 400);
      b.y = 200 + Math.random() * (WORLD - 400);
    }
    const dx = b.tx - b.x, dy = b.ty - b.y, d = Math.hypot(dx, dy) || 1;
    if (d < 20) { b.tx = 100 + Math.random() * (WORLD - 200); b.ty = 100 + Math.random() * (WORLD - 200); }
    const speed = 1.1;
    b.x += (dx / d) * speed; b.y += (dy / d) * speed;
  });
  io.to(code).emit('bots', room.bots.map((b) => ({
    id: b.id, x: b.x, y: b.y, level: b.level, hp: b.hp, maxHp: b.maxHp,
    name: b.name, color: b.color, bulk: b.bulk, down: !!b.respawnAt,
  })));
}

function roomSize(code) {
  const r = io.sockets.adapter.rooms.get(code);
  return r ? r.size : 0;
}

io.on('connection', (socket) => {
  socket.on('join', (code) => {
    if (typeof code !== 'string' || !code.trim()) return;
    const room = code.trim().toUpperCase().slice(0, 6);
    socket.data.room = room;
    socket.join(room);
    const state = ensureRoom(room);
    socket.emit('bots', state.bots.map((b) => ({
      id: b.id, x: b.x, y: b.y, level: b.level, hp: b.hp, maxHp: b.maxHp,
      name: b.name, color: b.color, bulk: b.bulk, down: !!b.respawnAt,
    })));
  });

  ['state', 'food'].forEach((event) => {
    socket.on(event, (data) => {
      if (!socket.data.room) return;
      socket.to(socket.data.room).emit(event, { ...data, id: socket.id });
    });
  });
  socket.on('skin', (data) => {
    if (!socket.data.room) return;
    socket.to(socket.data.room).emit('skin', { ...data, id: socket.id });
  });

  socket.on('hit', (data) => {
    if (!data || !data.target) return;
    if (String(data.target).startsWith('bot-')) {
      const room = rooms[socket.data.room];
      if (!room) return;
      const bot = room.bots.find((b) => b.id === data.target);
      if (!bot || bot.respawnAt) return;
      bot.hp = Math.max(0, bot.hp - data.dmg);
      if (bot.hp <= 0) {
        bot.respawnAt = Date.now() + 8000;
        socket.emit('killed', { from: bot.id, bot: true });
      }
      return;
    }
    io.to(data.target).emit('hit', { ...data, from: socket.id });
  });
  socket.on('killed', (data) => {
    if (data && data.target) io.to(data.target).emit('killed', { from: socket.id });
  });

  socket.on('disconnect', () => {
    if (socket.data.room) {
      socket.to(socket.data.room).emit('peerLeave', { id: socket.id });
      setTimeout(() => {
        if (roomSize(socket.data.room) === 0 && rooms[socket.data.room]) {
          clearInterval(rooms[socket.data.room].interval);
          delete rooms[socket.data.room];
        }
      }, 1000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Blob Arena server listening on port ' + PORT));
