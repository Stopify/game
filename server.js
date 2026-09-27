const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  socket.on('join', (code) => {
    if (typeof code !== 'string' || !code.trim()) return;
    socket.data.room = code.trim().toUpperCase().slice(0, 6);
    socket.join(socket.data.room);
  });

  // Broadcast-style events: relay to everyone else in the same lobby, tagging the sender's id.
  ['state', 'food', 'skin'].forEach((event) => {
    socket.on(event, (data) => {
      if (!socket.data.room) return;
      socket.to(socket.data.room).emit(event, { ...data, id: socket.id });
    });
  });

  // Targeted events: delivered to one specific player (e.g. a lunge attack landing on them).
  socket.on('hit', (data) => {
    if (data && data.target) io.to(data.target).emit('hit', { ...data, from: socket.id });
  });
  socket.on('killed', (data) => {
    if (data && data.target) io.to(data.target).emit('killed', { from: socket.id });
  });

  socket.on('disconnect', () => {
    if (socket.data.room) socket.to(socket.data.room).emit('peerLeave', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Blob Arena server listening on port ' + PORT));
