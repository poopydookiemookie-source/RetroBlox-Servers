const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Add a home route so the server stays "awake" and shows a status
app.get('/', (req, res) => res.send('Retroblox Server is Online'));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // This allows your local computer to connect
        methods: ["GET", "POST"]
    }
});

const gameStates = {};

io.on('connection', (socket) => {
    socket.on('joinGame', ({ gameId, userData }) => {
        socket.join(gameId);
        if (!gameStates[gameId]) gameStates[gameId] = {};
        
        gameStates[gameId][socket.id] = {
            id: socket.id,
            name: userData.username || "Guest",
            appearance: userData.appearance || {},
            position: { x: 0, y: 5, z: 0 },
            rotation: { y: 0 },
            health: 100
        };

        socket.to(gameId).emit('playerJoined', gameStates[gameId][socket.id]);
        socket.emit('currentPlayers', gameStates[gameId]);
        updateGlobalCounts();
    });

    socket.on('updateState', (data) => {
        const rooms = Array.from(socket.rooms);
        const room = rooms[1]; 
        if (room && gameStates[room] && gameStates[room][socket.id]) {
            Object.assign(gameStates[room][socket.id], data);
            socket.to(room).emit('peerUpdate', { id: socket.id, ...data });
        }
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