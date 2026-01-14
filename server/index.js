const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow connections from the client
    methods: ["GET", "POST"]
  }
});

// State management
// rooms[roomId] = { currentSpeaker: socketId | null, lastActivity: timestamp }
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // JOIN ROOM
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room: ${roomId}`);

    // Initialize room if not exists
    if (!rooms[roomId]) {
      rooms[roomId] = { currentSpeaker: null };
    }

    // Send current state to the new user
    socket.emit('room-state', rooms[roomId]);
  });

  // START TALKING (Request Mutex)
  socket.on('start-talk', ({ roomId, sampleRate }) => {
    if (!rooms[roomId]) return;

    // If no one is speaking, grant permission
    if (rooms[roomId].currentSpeaker === null) {
      rooms[roomId].currentSpeaker = socket.id;
      rooms[roomId].sampleRate = sampleRate; // Store Sample Rate
      
      // Notify EVERYONE in the room (including sender) that X is speaking
      io.to(roomId).emit('talk-started', { userId: socket.id, sampleRate });
      console.log(`User ${socket.id} started talking in ${roomId} at ${sampleRate}Hz`);
    } else {
      // Reject request
      socket.emit('talk-rejected', { speaker: rooms[roomId].currentSpeaker });
    }
  });

  // VOICE DATA (Relay)
  socket.on('voice-chunk', ({ roomId, chunk }) => {
    // Only allow broadcast if this user is the current speaker
    if (rooms[roomId] && rooms[roomId].currentSpeaker === socket.id) {
      // Broadcast to everyone ELSE in the room
      socket.to(roomId).emit('voice-chunk', { chunk, userId: socket.id });
    }
  });

  // STOP TALKING (Release Mutex)
  socket.on('stop-talk', (roomId) => {
    if (rooms[roomId] && rooms[roomId].currentSpeaker === socket.id) {
      rooms[roomId].currentSpeaker = null;
      io.to(roomId).emit('talk-stopped', { userId: socket.id });
      console.log(`User ${socket.id} stopped talking in ${roomId}`);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Cleanup: If this user was the active speaker, release the lock
    for (const roomId in rooms) {
      if (rooms[roomId].currentSpeaker === socket.id) {
        rooms[roomId].currentSpeaker = null;
        io.to(roomId).emit('talk-stopped', { userId: socket.id });
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
