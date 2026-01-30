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
// rooms[roomId] = { currentSpeaker: socketId | null, users: { socketId: { username } } }
const rooms = {};
// users: socketId -> username
const users = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // SET USERNAME
  socket.on('set-username', (username) => {
    users[socket.id] = username;
    console.log(`User ${socket.id} set username: ${username}`);
  });

  // JOIN ROOM
  socket.on('join-room', (roomId, username) => {
    socket.join(roomId);
    
    // Store username if provided
    if (username) {
      users[socket.id] = username;
    }
    
    // Initialize room if not exists
    if (!rooms[roomId]) {
      rooms[roomId] = { currentSpeaker: null, users: {} };
    }
    
    // Add user to room
    rooms[roomId].users[socket.id] = {
      username: users[socket.id] || socket.id,
      socketId: socket.id
    };
    
    console.log(`User ${users[socket.id] || socket.id} joined room: ${roomId}`);

    // Send current state to the new user
    socket.emit('room-state', rooms[roomId]);
    
    // Notify everyone in the room that a user joined
    io.to(roomId).emit('user-joined', {
      socketId: socket.id,
      username: users[socket.id] || socket.id
    });
  });

  // LEAVE ROOM
  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    
    // Remove user from room
    if (rooms[roomId] && rooms[roomId].users) {
      delete rooms[roomId].users[socket.id];
    }
    
    console.log(`User ${users[socket.id] || socket.id} left room: ${roomId}`);
    
    // If this user was the active speaker, release the lock
    if (rooms[roomId] && rooms[roomId].currentSpeaker === socket.id) {
        rooms[roomId].currentSpeaker = null;
        io.to(roomId).emit('talk-stopped', { userId: socket.id, username: users[socket.id] });
    }
    
    // Notify everyone in the room that a user left
    io.to(roomId).emit('user-left', {
      socketId: socket.id,
      username: users[socket.id] || socket.id
    });
  });

  // START TALKING (Request Mutex)
  socket.on('start-talk', ({ roomId, sampleRate }) => {
    if (!rooms[roomId]) return;

    // If no one is speaking, grant permission
    if (rooms[roomId].currentSpeaker === null) {
      rooms[roomId].currentSpeaker = socket.id;
      rooms[roomId].sampleRate = sampleRate; // Store Sample Rate
      
      // Notify EVERYONE in the room (including sender) that X is speaking
      io.to(roomId).emit('talk-started', { 
        userId: socket.id, 
        username: users[socket.id] || socket.id,
        sampleRate 
      });
      console.log(`User ${users[socket.id] || socket.id} started talking in ${roomId} at ${sampleRate}Hz`);
    } else {
      // Reject request
      const speakerUsername = users[rooms[roomId].currentSpeaker] || rooms[roomId].currentSpeaker;
      socket.emit('talk-rejected', { 
        speaker: rooms[roomId].currentSpeaker,
        username: speakerUsername
      });
    }
  });

  // VOICE DATA (Relay)
  socket.on('voice-chunk', ({ roomId, chunk }) => {
    // Only allow broadcast if this user is the current speaker
    if (rooms[roomId] && rooms[roomId].currentSpeaker === socket.id) {
      // Broadcast to everyone ELSE in the room
      socket.to(roomId).emit('voice-chunk', { 
        chunk, 
        userId: socket.id,
        username: users[socket.id] || socket.id
      });
    }
  });

  // STOP TALKING (Release Mutex)
  socket.on('stop-talk', (roomId) => {
    if (rooms[roomId] && rooms[roomId].currentSpeaker === socket.id) {
      rooms[roomId].currentSpeaker = null;
      io.to(roomId).emit('talk-stopped', { 
        userId: socket.id, 
        username: users[socket.id] || socket.id
      });
      console.log(`User ${users[socket.id] || socket.id} stopped talking in ${roomId}`);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Cleanup: If this user was the active speaker, release the lock
    for (const roomId in rooms) {
      // Remove user from room
      if (rooms[roomId] && rooms[roomId].users) {
        delete rooms[roomId].users[socket.id];
      }
      
      // Release speaker lock
      if (rooms[roomId] && rooms[roomId].currentSpeaker === socket.id) {
        rooms[roomId].currentSpeaker = null;
        io.to(roomId).emit('talk-stopped', { 
          userId: socket.id, 
          username: users[socket.id] || socket.id
        });
      }
      
      // Notify room that user left
      io.to(roomId).emit('user-left', {
        socketId: socket.id,
        username: users[socket.id] || socket.id
      });
    }
    
    // Remove user from users map
    delete users[socket.id];
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
