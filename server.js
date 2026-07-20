const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// State: { [gameId]: { [playerId]: { position, appearance, etc } } }
const gameStates = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinGame', ({ gameId, userData }) => {
        socket.join(gameId);
        
        if (!gameStates[gameId]) gameStates[gameId] = {};
        
        // Initialize player state
        gameStates[gameId][socket.id] = {
            id: socket.id,
            name: userData.username || "Guest",
            appearance: userData.appearance || {}, // colors, clothes, accessories
            position: { x: 0, y: 5, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            animation: "Idle"
        };

        // Tell everyone in the room about the new player
        socket.to(gameId).emit('playerJoined', gameStates[gameId][socket.id]);
        
        // Send current player list to the newcomer
        socket.emit('currentPlayers', gameStates[gameId]);
        
        // Update global player counts for display.html
        updateGlobalCounts();
    });

    // Handle high-frequency movement updates
    socket.on('updateState', (data) => {
        const room = Array.from(socket.rooms)[1];
        if (room && gameStates[room] && gameStates[room][socket.id]) {
            Object.assign(gameStates[room][socket.id], data);
            // Broadcast to everyone else in the room
            socket.to(room).emit('peerUpdate', { id: socket.id, ...data });
        }
    });

    socket.on('chat', (msg) => {
        const room = Array.from(socket.rooms)[1];
        io.to(room).emit('chatMessage', { id: socket.id, message: msg });
    });

    socket.on('disconnecting', () => {
        socket.rooms.forEach(room => {
            if (gameStates[room] && gameStates[room][socket.id]) {
                delete gameStates[room][socket.id];
                socket.to(room).emit('playerLeft', socket.id);
            }
        });
    });

    socket.on('disconnect', updateGlobalCounts);
});

function updateGlobalCounts() {
    const counts = {};
    for (const gameId in gameStates) {
        counts[gameId] = Object.keys(gameStates[gameId]).length;
    }
    io.emit('playerCounts', counts);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));