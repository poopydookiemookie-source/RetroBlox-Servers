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
//
// IMPORTANT (Render users): Render's free/basic web services use an EPHEMERAL filesystem —
// anything written to disk is wiped every time the service restarts or redeploys (including
// just waking back up after the free tier puts it to sleep). If your uploaded games keep
// disappearing, that's almost always why.
//
// Fix: add a Render "Disk" to this service (Dashboard -> your service -> Disks -> Add Disk),
// mount it at something like /var/data, and set an environment variable DATA_DIR=/var/data
// on the service. That gives you a real persistent volume. Without a mounted disk, data will
// NOT survive restarts no matter what this code does.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const GAMES_INDEX_FILE = path.join(DATA_DIR, 'games.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

console.log(`[storage] Using DATA_DIR: ${DATA_DIR}`);

let games = [];
try {
    games = JSON.parse(fs.readFileSync(GAMES_INDEX_FILE, 'utf8'));
    console.log(`[storage] Loaded ${games.length} game(s) from ${GAMES_INDEX_FILE}`);
} catch (e) {
    games = [];
    console.log(`[storage] No existing games.json found at ${GAMES_INDEX_FILE} (starting empty). Reason: ${e.code || e.message}`);
}

function saveGamesIndex() {
    try {
        fs.writeFileSync(GAMES_INDEX_FILE, JSON.stringify(games, null, 2));
    } catch (e) {
        console.error('Failed to save games index:', e);
    }
}

// ================= ACCOUNT STORAGE SETUP =================
const ACCOUNTS_INDEX_FILE = path.join(DATA_DIR, 'accounts.json');

let accounts = [];
try {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_INDEX_FILE, 'utf8'));
    console.log(`[storage] Loaded ${accounts.length} account(s) from ${ACCOUNTS_INDEX_FILE}`);
} catch (e) {
    accounts = [];
    console.log(`[storage] No existing accounts.json found at ${ACCOUNTS_INDEX_FILE} (starting empty). Reason: ${e.code || e.message}`);
}

// Backfill fields for accounts created before friends/favorites/last-played/likes existed
accounts.forEach(a => {
    if (!Array.isArray(a.friends)) a.friends = [];
    if (!Array.isArray(a.favorites)) a.favorites = [];
    if (!Array.isArray(a.lastPlayed)) a.lastPlayed = [];
    if (!Array.isArray(a.likedGames)) a.likedGames = [];
    if (!Array.isArray(a.dislikedGames)) a.dislikedGames = [];
});

function saveAccountsIndex() {
    try {
        fs.writeFileSync(ACCOUNTS_INDEX_FILE, JSON.stringify(accounts, null, 2));
    } catch (e) {
        console.error('Failed to save accounts index:', e);
    }
}

function findAccountByUsername(username) {
    const lower = (username || '').toString().toLowerCase();
    return accounts.find(a => a.username.toLowerCase() === lower);
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
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

// ---- Diagnostics: check where data is being stored and how much is loaded ----
// Visit this in a browser to sanity-check persistence, e.g. after a redeploy.
app.get('/debug/storage', (req, res) => {
    res.json({
        dataDir: DATA_DIR,
        usingEnvOverride: !!process.env.DATA_DIR,
        gamesLoaded: games.length,
        accountsLoaded: accounts.length,
        uploadsDirExists: fs.existsSync(UPLOADS_DIR),
        note: "If gamesLoaded/accountsLoaded reset to 0 after every restart, this service's filesystem is ephemeral — mount a persistent Disk and set DATA_DIR to its path."
    });
});

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

// A logged-in user's vote identity is their username (stable across devices/browsers).
// A logged-out user falls back to whatever anonymous userId the client generated.
function voteIdentity(req, source) {
    const username = (source.username || '').toString().trim();
    const userId = (source.userId || '').toString();
    return { identity: username || userId, username };
}

// ---- Like a game (one vote per user) ----
app.post('/games/:id/like', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    const { identity, username } = voteIdentity(req, req.body);
    if (!identity) return res.status(400).json({ error: 'Missing userId' });

    if (!Array.isArray(g.likedBy)) g.likedBy = [];
    if (!Array.isArray(g.dislikedBy)) g.dislikedBy = [];

    if (g.likedBy.includes(identity)) {
        return res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'like', status: 'already-voted' });
    }

    g.likedBy.push(identity);
    g.likes++;

    const dIdx = g.dislikedBy.indexOf(identity);
    if (dIdx !== -1) {
        g.dislikedBy.splice(dIdx, 1);
        g.dislikes = Math.max(0, g.dislikes - 1);
    }

    saveGamesIndex();

    // Store the like on the account too, so it's persisted server-side (not just localStorage)
    if (username) {
        const account = findAccountByUsername(username);
        if (account) {
            if (!Array.isArray(account.likedGames)) account.likedGames = [];
            if (!Array.isArray(account.dislikedGames)) account.dislikedGames = [];
            if (!account.likedGames.includes(g.id)) account.likedGames.push(g.id);
            account.dislikedGames = account.dislikedGames.filter(id => id !== g.id);
            saveAccountsIndex();
        }
    }

    res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'like', status: 'ok' });
});

// ---- Dislike a game (one vote per user) ----
app.post('/games/:id/dislike', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    const { identity, username } = voteIdentity(req, req.body);
    if (!identity) return res.status(400).json({ error: 'Missing userId' });

    if (!Array.isArray(g.likedBy)) g.likedBy = [];
    if (!Array.isArray(g.dislikedBy)) g.dislikedBy = [];

    if (g.dislikedBy.includes(identity)) {
        return res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'dislike', status: 'already-voted' });
    }

    g.dislikedBy.push(identity);
    g.dislikes++;

    const lIdx = g.likedBy.indexOf(identity);
    if (lIdx !== -1) {
        g.likedBy.splice(lIdx, 1);
        g.likes = Math.max(0, g.likes - 1);
    }

    saveGamesIndex();

    if (username) {
        const account = findAccountByUsername(username);
        if (account) {
            if (!Array.isArray(account.likedGames)) account.likedGames = [];
            if (!Array.isArray(account.dislikedGames)) account.dislikedGames = [];
            if (!account.dislikedGames.includes(g.id)) account.dislikedGames.push(g.id);
            account.likedGames = account.likedGames.filter(id => id !== g.id);
            saveAccountsIndex();
        }
    }

    res.json({ likes: g.likes, dislikes: g.dislikes, vote: 'dislike', status: 'ok' });
});

// ---- Check whether a given user already voted on a game ----
app.get('/games/:id/vote-status', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    const { identity } = voteIdentity(req, req.query);

    let vote = null;
    if (Array.isArray(g.likedBy) && g.likedBy.includes(identity)) vote = 'like';
    else if (Array.isArray(g.dislikedBy) && g.dislikedBy.includes(identity)) vote = 'dislike';

    res.json({ vote, likes: g.likes, dislikes: g.dislikes });
});

// ================= ACCOUNTS =================

// ---- Sign up a new account ----
app.post('/accounts/signup', (req, res) => {
    try {
        const username = (req.body.username || '').toString().trim();
        const password = (req.body.password || '').toString();
        const birthday = (req.body.birthday || '').toString();
        const gender = (req.body.gender || '').toString();

        if (!username || username.length <= 3) {
            return res.status(400).json({ error: 'invalid-username', message: 'Username must be more than 3 characters.' });
        }
        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'invalid-password', message: 'Password must be at least 8 characters.' });
        }
        if (!birthday) {
            return res.status(400).json({ error: 'invalid-birthday', message: 'Birthday is required.' });
        }
        if (findAccountByUsername(username)) {
            return res.status(409).json({ error: 'username-taken', message: 'That username is already taken.' });
        }

        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = hashPassword(password, salt);

        const account = {
            username,
            salt,
            passwordHash,
            birthday,
            gender,
            createdAt: Date.now(),
            friends: [],
            favorites: [],
            lastPlayed: [],
            likedGames: [],
            dislikedGames: []
        };

        accounts.push(account);
        saveAccountsIndex();

        res.json({ success: true, username: account.username, birthday: account.birthday, gender: account.gender });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'signup-failed', message: 'Something went wrong creating your account.' });
    }
});

// ---- Log in to an existing account ----
app.post('/accounts/login', (req, res) => {
    try {
        const username = (req.body.username || '').toString().trim();
        const password = (req.body.password || '').toString();

        const account = findAccountByUsername(username);
        if (!account) {
            return res.status(404).json({ error: 'no-account', message: "That username doesn't exist." });
        }

        const attemptHash = hashPassword(password, account.salt);
        if (attemptHash !== account.passwordHash) {
            return res.status(401).json({ error: 'wrong-password', message: 'Incorrect password.' });
        }

        res.json({ success: true, username: account.username, birthday: account.birthday, gender: account.gender });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'login-failed', message: 'Something went wrong logging in.' });
    }
});

// ---- Check if a username is already taken (used for live validation) ----
app.get('/accounts/exists', (req, res) => {
    const username = (req.query.username || '').toString();
    res.json({ exists: !!findAccountByUsername(username) });
});

// ================= FRIENDS =================

// ---- Add a friend (mutual - adds both ways) ----
app.post('/accounts/:username/friends', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const friendUsername = (req.body.friendUsername || '').toString().trim();
    if (!friendUsername) return res.status(400).json({ error: 'missing-friend', message: 'Missing friendUsername.' });
    if (friendUsername.toLowerCase() === account.username.toLowerCase()) {
        return res.status(400).json({ error: 'cannot-friend-self', message: "You can't add yourself as a friend." });
    }

    const friendAccount = findAccountByUsername(friendUsername);
    if (!friendAccount) return res.status(404).json({ error: 'friend-not-found', message: 'That user does not exist.' });

    if (!Array.isArray(account.friends)) account.friends = [];
    if (!Array.isArray(friendAccount.friends)) friendAccount.friends = [];

    if (!account.friends.some(f => f.toLowerCase() === friendAccount.username.toLowerCase())) {
        account.friends.push(friendAccount.username);
    }
    if (!friendAccount.friends.some(f => f.toLowerCase() === account.username.toLowerCase())) {
        friendAccount.friends.push(account.username);
    }

    saveAccountsIndex();
    res.json({ success: true, friends: account.friends });
});

// ---- Remove a friend (mutual - removes both ways) ----
app.post('/accounts/:username/friends/remove', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const friendUsername = (req.body.friendUsername || '').toString().trim();
    if (!Array.isArray(account.friends)) account.friends = [];
    account.friends = account.friends.filter(f => f.toLowerCase() !== friendUsername.toLowerCase());

    const friendAccount = findAccountByUsername(friendUsername);
    if (friendAccount && Array.isArray(friendAccount.friends)) {
        friendAccount.friends = friendAccount.friends.filter(f => f.toLowerCase() !== account.username.toLowerCase());
    }

    saveAccountsIndex();
    res.json({ success: true, friends: account.friends });
});

// ---- List a user's friends ----
app.get('/accounts/:username/friends', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.friends)) account.friends = [];
    res.json(account.friends);
});

// ================= FAVORITES =================

// ---- Toggle a game as favorited (adds if not present, removes if present) ----
app.post('/accounts/:username/favorites', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const gameId = (req.body.gameId || '').toString();
    if (!gameId) return res.status(400).json({ error: 'missing-gameId', message: 'Missing gameId.' });

    if (!Array.isArray(account.favorites)) account.favorites = [];
    const idx = account.favorites.indexOf(gameId);
    if (idx !== -1) account.favorites.splice(idx, 1);
    else account.favorites.unshift(gameId);

    saveAccountsIndex();

    const favGames = account.favorites.map(id => games.find(g => g.id === id)).filter(Boolean).map(publicGame);
    res.json({ success: true, favorited: idx === -1, favorites: favGames });
});

// ---- List a user's favorited games (full game objects) ----
app.get('/accounts/:username/favorites', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.favorites)) account.favorites = [];

    const favGames = account.favorites.map(id => games.find(g => g.id === id)).filter(Boolean).map(publicGame);
    res.json(favGames);
});

// ================= LAST PLAYED =================

const MAX_LAST_PLAYED = 10;

// ---- Record that a user just played a game (call this when they open a game) ----
app.post('/accounts/:username/last-played', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const gameId = (req.body.gameId || '').toString();
    if (!gameId) return res.status(400).json({ error: 'missing-gameId', message: 'Missing gameId.' });

    if (!Array.isArray(account.lastPlayed)) account.lastPlayed = [];
    account.lastPlayed = account.lastPlayed.filter(e => e.gameId !== gameId);
    account.lastPlayed.unshift({ gameId, playedAt: Date.now() });
    account.lastPlayed = account.lastPlayed.slice(0, MAX_LAST_PLAYED);

    saveAccountsIndex();
    res.json({ success: true });
});

// ---- List a user's recently played games, most recent first (full game objects) ----
app.get('/accounts/:username/last-played', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.lastPlayed)) account.lastPlayed = [];

    const entries = account.lastPlayed
        .map(e => {
            const g = games.find(x => x.id === e.gameId);
            return g ? { game: publicGame(g), playedAt: e.playedAt } : null;
        })
        .filter(Boolean);

    res.json(entries);
});

// ================= LIKED GAMES (mirrors the vote stored on the game itself) =================

// ---- List the games a user has liked ----
app.get('/accounts/:username/liked-games', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.likedGames)) account.likedGames = [];

    const likedGames = account.likedGames.map(id => games.find(g => g.id === id)).filter(Boolean).map(publicGame);
    res.json(likedGames);
});

// ================= MULTIPLAYER (unchanged) =================
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // This allows your local computer to connect
        methods: ["GET", "POST"]
    },
    pingInterval: 10000,
    pingTimeout: 8000 // detect a lost/crashed tab within ~18s instead of the ~60s default
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

    // ---- Appearance changed mid-session (e.g. player swaps a hat/shirt while playing) ----
    socket.on('updateAppearance', (appearance) => {
        const rooms = Array.from(socket.rooms);
        const room = rooms[1];
        if (room && gameStates[room] && gameStates[room][socket.id]) {
            gameStates[room][socket.id].appearance = appearance;
            socket.to(room).emit('peerAppearance', { id: socket.id, appearance });
        }
    });

    // ---- Chat: relay a message to everyone else in the same game room ----
    socket.on('chatMessage', (message) => {
        const rooms = Array.from(socket.rooms);
        const room = rooms[1];
        if (!room) return;
        const text = (message || '').toString().slice(0, 200);
        if (!text) return;
        // Broadcast to everyone else in the room (sender already renders its own message locally)
        socket.to(room).emit('chatMessage', { id: socket.id, message: text });
    });

    // ---- Explicit "I'm leaving" signal so the leaderboard updates immediately instead of ----
    // ---- waiting for the socket's ping-timeout to notice the tab navigated away.       ----
    socket.on('leaveGame', () => {
        leaveAllGameRooms(socket);
    });

    socket.on('disconnecting', () => {
        leaveAllGameRooms(socket);
    });

    socket.on('disconnect', updateGlobalCounts);

    function leaveAllGameRooms(socket) {
        socket.rooms.forEach(room => {
            if (gameStates[room] && gameStates[room][socket.id]) {
                delete gameStates[room][socket.id];
                socket.to(room).emit('playerLeft', socket.id);
            }
        });
        updateGlobalCounts();
    }
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
