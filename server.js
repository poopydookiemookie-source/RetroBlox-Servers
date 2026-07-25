const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ================= GAME STORAGE SETUP =================
// Games are persisted to disk so they survive server restarts.
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const GAMES_INDEX_FILE = path.join(DATA_DIR, 'games.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let games = [];
try {
    games = JSON.parse(fs.readFileSync(GAMES_INDEX_FILE, 'utf8'));
} catch (e) {
    games = [];
}

function saveGamesIndex() {
    try {
        fs.writeFileSync(GAMES_INDEX_FILE, JSON.stringify(games, null, 2));
    } catch (e) {
        console.error('Failed to save games index:', e);
    }
}

// Public-safe view of a game (no need to strip much, but keep it explicit)
function publicGame(g) {
    return {
        id: g.id,
        name: g.name,
        creator: g.creator,
        description: g.description,
        icon: g.icon || null, // null means "use default image" on the client
        likes: g.likes,
        dislikes: g.dislikes,
        createdAt: g.createdAt
    };
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, fieldSize: 15 * 1024 * 1024 }
});

// Home / status route
app.get('/', (req, res) => res.send('Retroblox Server is Online'));

// ---- List all games (used by the home page) ----
app.get('/games', (req, res) => {
    res.json(games.map(publicGame));
});

// ---- Get a single game's metadata ----
app.get('/games/:id', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    res.json(publicGame(g));
});

// ---- Get a game's raw playable content (the .crbx data) ----
app.get('/games/:id/content', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).send('Game not found');
    const filePath = path.join(UPLOADS_DIR, g.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Game file missing');
    res.type('application/json').send(fs.readFileSync(filePath, 'utf8'));
});

// ---- Upload (publish) a new game from Retroblox Studio ----
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const id = crypto.randomUUID();
        const filename = `${id}.crbx`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);

        const icon = (typeof req.body.icon === 'string' && req.body.icon.startsWith('data:'))
            ? req.body.icon
            : null; // No icon uploaded -> client will fall back to the default image

        const game = {
            id,
            name: (req.body.name || 'Untitled Game').toString().slice(0, 100),
            creator: (req.body.creator || 'Guest').toString().slice(0, 60),
            description: (req.body.description || 'This game has no description yet.').toString().slice(0, 2000),
            icon,
            filename,
            likes: 0,
            dislikes: 0,
            likedBy: [],
            dislikedBy: [],
            createdAt: Date.now()
        };

        games.unshift(game);
        saveGamesIndex();

        res.json({ success: true, id: game.id, game: publicGame(game) });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed', details: err.message });
    }
});

// ---- Like a game (one vote per user) ----
app.post('/games/:id/like', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    const userId = (req.body.userId || '').toString();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    if (!Array.isArray(g.likedBy)) g.likedBy = [];
    if (!Array.isArray(g.dislikedBy)) g.dislikedBy = [];

    if (g.likedBy.includes(userId)) {
        return res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'like', status: 'already-voted' });
    }

    g.likedBy.push(userId);
    g.likes++;

    const dIdx = g.dislikedBy.indexOf(userId);
    if (dIdx !== -1) {
        g.dislikedBy.splice(dIdx, 1);
        g.dislikes = Math.max(0, g.dislikes - 1);
    }

    saveGamesIndex();
    res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'like', status: 'ok' });
});

// ---- Dislike a game (one vote per user) ----
app.post('/games/:id/dislike', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    const userId = (req.body.userId || '').toString();
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    if (!Array.isArray(g.likedBy)) g.likedBy = [];
    if (!Array.isArray(g.dislikedBy)) g.dislikedBy = [];

    if (g.dislikedBy.includes(userId)) {
        return res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'dislike', status: 'already-voted' });
    }

    g.dislikedBy.push(userId);
    g.dislikes++;

    const lIdx = g.likedBy.indexOf(userId);
    if (lIdx !== -1) {
        g.likedBy.splice(lIdx, 1);
        g.likes = Math.max(0, g.likes - 1);
    }

    saveGamesIndex();
    res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'dislike', status: 'ok' });
});

// ---- Check whether a given user already voted on a game ----
app.get('/games/:id/vote-status', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    const userId = (req.query.userId || '').toString();

    let vote = null;
    if (Array.isArray(g.likedBy) && g.likedBy.includes(userId)) vote = 'like';
    else if (Array.isArray(g.dislikedBy) && g.dislikedBy.includes(userId)) vote = 'dislike';

    res.json({ vote, likes: g.likes, dislikes: g.dislikes });
});

// ================= MULTIPLAYER (unchanged) =================
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
