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

// ================= APPEARANCE (worn items, shown as "Currently Wearing" on profiles) =================
// Mirrors the equip categories the Avatar Editor already tracks client-side (see
// AVATAR_CATALOGS in display.html) so a profile page can show what someone has equipped
// without needing to load their full 3D avatar.
const APPEARANCE_SLOTS = ['equippedFace', 'equippedHair', 'equippedAccessory', 'equippedShirt', 'equippedPants', 'equippedTShirt'];
function blankAppearance() {
    const a = {};
    APPEARANCE_SLOTS.forEach(slot => { a[slot] = null; });
    return a;
}
function publicAppearance(account) {
    const a = (account && account.appearance) || {};
    const out = {};
    APPEARANCE_SLOTS.forEach(slot => { out[slot] = typeof a[slot] === 'string' && a[slot] ? a[slot] : null; });
    return out;
}

// Backfill fields for accounts created before friends/favorites/last-played/likes existed
accounts.forEach(a => {
    if (!Array.isArray(a.friends)) a.friends = [];
    if (!Array.isArray(a.favorites)) a.favorites = [];
    if (!Array.isArray(a.lastPlayed)) a.lastPlayed = [];
    if (!Array.isArray(a.likedGames)) a.likedGames = [];
    if (!Array.isArray(a.dislikedGames)) a.dislikedGames = [];
    if (!Array.isArray(a.friendRequests)) a.friendRequests = [];
    if (!Array.isArray(a.inventory)) a.inventory = [];
    if (!Array.isArray(a.followers)) a.followers = [];
    if (!Array.isArray(a.following)) a.following = [];
    if (!Array.isArray(a.blockedUsers)) a.blockedUsers = [];
    if (typeof a.bio !== 'string') a.bio = '';
    if (typeof a.avatarImage !== 'string') a.avatarImage = null;
    if (typeof a.robux !== 'number' || isNaN(a.robux)) a.robux = 0;
    if (typeof a.tix !== 'number' || isNaN(a.tix)) a.tix = 0;
    if (typeof a.banned !== 'boolean') a.banned = false;
    if (typeof a.banReason !== 'string') a.banReason = '';
    if (typeof a.banExpiresAt !== 'number') a.banExpiresAt = null;
    if (typeof a.lastDailyRewardAt !== 'number') a.lastDailyRewardAt = 0;
    if (!a.appearance || typeof a.appearance !== 'object') a.appearance = {};
    APPEARANCE_SLOTS.forEach(slot => {
        if (typeof a.appearance[slot] !== 'string' || !a.appearance[slot]) a.appearance[slot] = null;
    });
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

// ================= PLAYER IDs =================
// Every account gets a permanent, sequential player number - the first account ever
// created on this server is #1, the next is #2, and so on. IDs are never reused (even
// if an account is later terminated), so this counter is persisted separately from the
// accounts list itself.
const PLAYER_ID_COUNTER_FILE = path.join(DATA_DIR, 'player_id_counter.json');
let nextPlayerId = 1;
let counterFileExisted = false;
try {
    const counterData = JSON.parse(fs.readFileSync(PLAYER_ID_COUNTER_FILE, 'utf8'));
    if (typeof counterData.next === 'number' && counterData.next > 0) {
        nextPlayerId = counterData.next;
        counterFileExisted = true;
    }
} catch (e) {
    // No counter file yet - fine, we'll create one below.
}

function savePlayerIdCounter() {
    try {
        fs.writeFileSync(PLAYER_ID_COUNTER_FILE, JSON.stringify({ next: nextPlayerId }));
    } catch (e) {
        console.error('Failed to save player ID counter:', e);
    }
}

// Backfill playerId for accounts that existed before this feature - assigned in the
// same order they're stored in (i.e. signup order), so the very first account to ever
// sign up becomes player #1.
let backfilledAnyPlayerId = false;
accounts.forEach(a => {
    if (typeof a.playerId !== 'number') {
        a.playerId = nextPlayerId++;
        backfilledAnyPlayerId = true;
    }
});
if (backfilledAnyPlayerId || !counterFileExisted) savePlayerIdCounter();
if (backfilledAnyPlayerId) saveAccountsIndex();

// ================= BANS =================
// If a ban has an expiry and it's passed, lift it automatically. Called lazily
// whenever an account is touched, AND swept periodically (see setInterval near the
// bottom of this file) so bans lift on their own even with no incoming requests.
function liftBanIfExpired(account) {
    if (account.banned && account.banExpiresAt && Date.now() >= account.banExpiresAt) {
        account.banned = false;
        account.banReason = '';
        account.banExpiresAt = null;
        return true;
    }
    return false;
}

// ================= DAILY TIX BONUS =================
// Everyone starts with 10 Tix (see signup below) and gets another 10 Tix the first
// time they're active on a new calendar day (UTC).
const DAILY_TIX_AMOUNT = 10;
function isNewCalendarDay(prevTimestamp, nowTimestamp) {
    if (!prevTimestamp) return true;
    const prev = new Date(prevTimestamp);
    const now = new Date(nowTimestamp);
    return prev.getUTCFullYear() !== now.getUTCFullYear() ||
           prev.getUTCMonth() !== now.getUTCMonth() ||
           prev.getUTCDate() !== now.getUTCDate();
}
function grantDailyTixIfDue(account) {
    const now = Date.now();
    if (isNewCalendarDay(account.lastDailyRewardAt, now)) {
        account.tix = (account.tix || 0) + DAILY_TIX_AMOUNT;
        account.lastDailyRewardAt = now;
        return DAILY_TIX_AMOUNT;
    }
    return null;
}

// ================= ADMIN CONFIG =================
// Only these two accounts can see/use the admin page (take down games, ban players).
// NOTE: like the rest of this server, there are no session tokens - every route just
// trusts whatever username the client sends. That matches the rest of the app's
// (very informal) auth model, but means anyone who can read the client code could, in
// theory, spoof an admin username in a raw request. Fine for a hobby project; do not
// treat this as real production-grade access control.
const ADMIN_USERNAMES = ['shaqman21', 'retroblox'];
function isAdminUsername(username) {
    return ADMIN_USERNAMES.includes((username || '').toString().trim().toLowerCase());
}
function requireAdmin(req, res) {
    const adminUsername = (req.body.adminUsername || req.query.adminUsername || '').toString();
    if (!isAdminUsername(adminUsername)) {
        res.status(403).json({ error: 'not-admin', message: 'Admin access required.' });
        return null;
    }
    const adminAccount = findAccountByUsername(adminUsername);
    if (!adminAccount) {
        res.status(403).json({ error: 'not-admin', message: 'Admin access required.' });
        return null;
    }
    return adminAccount;
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

// Public-safe view of an account for another user to see (friends list, friend
// requests, admin player list) - never leaks salt/passwordHash.
function publicAccount(a) {
    return {
        username: a.username,
        playerId: a.playerId,
        avatarImage: a.avatarImage || null,
        createdAt: a.createdAt,
        robux: a.robux || 0,
        tix: a.tix || 0,
        banned: !!a.banned,
        banReason: a.banReason || '',
        banExpiresAt: a.banExpiresAt || null,
        friendsCount: Array.isArray(a.friends) ? a.friends.length : 0
    };
}

// Minimal public view used for player search results - no currency/ban details, just
// enough to find someone and see how "popular" (friended) they are.
function publicSearchAccount(a) {
    return {
        username: a.username,
        playerId: a.playerId,
        avatarImage: a.avatarImage || null,
        friendsCount: Array.isArray(a.friends) ? a.friends.length : 0
    };
}

// ================= CATALOG =================
// Server-side source of truth for buyable avatar items and their prices, so a client
// can never just send whatever price it wants to the /inventory/buy route. Every face
// in the Avatar Editor is uploaded by RETROBLOX and costs 10 Tix.
const CATALOG_FACE_FILES = ["crying.png", "dizzy.png", "funny.png", "goofy.png", "john.png", "manface.png", "scared.png", "superhappy.png", "tongue.png", "winningsmile.png", "woman.png"];
const FACE_PRICE_TIX = 10;
const CATALOG_ITEMS = CATALOG_FACE_FILES.map(file => ({
    itemPath: `./items/faces/${file}`,
    name: file.split('.')[0].replace(/_/g, ' '),
    category: 'faces',
    price: FACE_PRICE_TIX,
    currency: 'tix',
    creator: 'RETROBLOX'
}));
function findCatalogItem(itemPath) {
    return CATALOG_ITEMS.find(i => i.itemPath === itemPath);
}

// ================= STARTER PLACE =================
// Every new account gets its own default game named "<username>'s Place", the same
// way a brand-new Roblox account starts with a place already in its inventory.
//
// This mirrors exactly what Retroblox Studio itself starts a brand-new project with
// (see the "Baseplate Application" section + the StarterPlayerScripts/CharacterScripts/
// Camera/Terrain setup near the top of studio.html) and what its own "Export .crbx" /
// "Publish" flow serializes (getCrbxData() in studio.html): a single 512x20x512-stud
// grey Baseplate sitting at y:-10 (top face at y:0), plus the Camera/Terrain/StarterPlayer
// script-folder entries Studio always creates. There's no explicit SpawnLocation - Studio's
// own play/test code falls back to spawning at (0, 5, 0) when no spawnpoint block exists,
// which sits right above this baseplate, so that's left out here too, matching the same
// "brand new project, nothing touched yet" state a real Studio session starts in.
function buildStarterPlaceContent(username) {
    const cameraId = 'Camera_' + crypto.randomUUID();
    const terrainId = 'Terrain_' + crypto.randomUUID();
    const starterPlayerScriptsId = 'StarterPlayerScripts_' + crypto.randomUUID();
    const starterCharacterScriptsId = 'StarterCharacterScripts_' + crypto.randomUUID();

    return JSON.stringify({
        format: 'ClassicCRBX',
        settings: {
            name: `${username}'s Place`,
            creator: username,
            description: 'Welcome to my game!',
            icon: null,
            usePlayerJs: true
        },
        blocks: [
            {
                x: 0, y: -10, z: 0,
                scaleX: 256, scaleY: 10, scaleZ: 256,
                rotX: 0, rotY: 0, rotZ: 0,
                color: 0x7F7F7F,
                isSpawnpoint: false,
                isSeat: false,
                shape: 'Block',
                material: 'Studs',
                userData: {
                    id: crypto.randomUUID(),
                    parent: 'Workspace',
                    canCollide: true,
                    anchored: true,
                    transparency: 0,
                    reflectance: 0,
                    shape: 'Block',
                    material: 'Studs'
                }
            }
        ],
        non3DItems: [
            { isFolder: true, name: 'StarterPlayerScripts', uuid: starterPlayerScriptsId, parent: 'StarterPlayer' },
            { isFolder: true, name: 'StarterCharacterScripts', uuid: starterCharacterScriptsId, parent: 'StarterPlayer' },
            { isCamera: true, className: 'Camera', name: 'Camera', uuid: cameraId, parent: 'Workspace', CameraType: 'Custom', FieldOfView: 70, CameraSubject: '' },
            { isTerrain: true, className: 'Terrain', name: 'Terrain', uuid: terrainId, parent: 'Workspace', WaterColor: '#00aaff', WaterTransparency: 1 }
        ]
    });
}

function createStarterPlace(username, now) {
    try {
        const id = crypto.randomUUID();
        const filename = `${id}.crbx`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), buildStarterPlaceContent(username));

        const game = {
            id,
            name: `${username}'s Place`,
            creator: username,
            description: 'Welcome to my game!',
            icon: null,
            filename,
            likes: 0,
            dislikes: 0,
            likedBy: [],
            dislikedBy: [],
            createdAt: now,
            takenDown: false,
            takedownReason: ''
        };

        games.unshift(game);
        saveGamesIndex();
        return game;
    } catch (err) {
        console.error('Failed to create starter place:', err);
        return null;
    }
}

// ================= REPORTS =================
// Minimal record-keeping for the "Report" action on player profiles - just persisted
// to disk for now, there's no admin review UI for these yet.
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
let reports = [];
try {
    reports = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
} catch (e) {
    reports = [];
}
function saveReports() {
    try {
        fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
    } catch (e) {
        console.error('Failed to save reports:', e);
    }
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
    res.json(games.filter(g => !g.takenDown).map(publicGame));
});

// ---- Get a single game's metadata ----
app.get('/games/:id', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (g.takenDown && !isAdminUsername(req.query.adminUsername)) {
        return res.status(403).json({ error: 'taken-down', message: g.takedownReason || 'This game has been taken down by an administrator.' });
    }
    res.json(publicGame(g));
});

// ---- Get a game's raw playable content (the .crbx data) ----
app.get('/games/:id/content', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).send('Game not found');
    if (g.takenDown && !isAdminUsername(req.query.adminUsername)) {
        return res.status(403).send(g.takedownReason || 'This game has been taken down by an administrator.');
    }
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
            createdAt: Date.now(),
            takenDown: false,
            takedownReason: ''
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

        const now = Date.now();
        const account = {
            username,
            playerId: nextPlayerId++,
            salt,
            passwordHash,
            birthday,
            gender,
            createdAt: now,
            friends: [],
            friendRequests: [],
            favorites: [],
            lastPlayed: [],
            likedGames: [],
            dislikedGames: [],
            inventory: [],
            avatarImage: null,
            appearance: blankAppearance(),
            robux: 0,
            tix: 10, // everyone starts with 10 Tix, plus 10 more every new calendar day they're active
            lastDailyRewardAt: now,
            banned: false,
            banReason: '',
            banExpiresAt: null
        };

        accounts.push(account);
        saveAccountsIndex();
        savePlayerIdCounter();

        // Every new account gets a starter game of their own, just like a fresh Roblox
        // account gets a default "[Username]'s Place". See createStarterPlace() for an
        // important caveat about the placeholder content it's saved with.
        const starterGame = createStarterPlace(account.username, now);

        res.json({
            success: true,
            username: account.username,
            playerId: account.playerId,
            birthday: account.birthday,
            gender: account.gender,
            avatarImage: account.avatarImage,
            appearance: publicAppearance(account),
            robux: account.robux,
            tix: account.tix,
            inventory: account.inventory,
            isAdmin: isAdminUsername(account.username),
            starterGame: starterGame ? publicGame(starterGame) : null
        });
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

        let dirty = liftBanIfExpired(account);

        if (account.banned) {
            if (dirty) saveAccountsIndex();
            return res.status(403).json({
                error: 'banned',
                message: account.banReason
                    ? `This account has been banned. Reason: ${account.banReason}`
                    : 'This account has been banned.'
            });
        }

        const dailyBonusGranted = grantDailyTixIfDue(account);
        if (dailyBonusGranted) dirty = true;
        if (dirty) saveAccountsIndex();

        res.json({
            success: true,
            username: account.username,
            playerId: account.playerId,
            birthday: account.birthday,
            gender: account.gender,
            avatarImage: account.avatarImage || null,
            appearance: publicAppearance(account),
            robux: account.robux || 0,
            tix: account.tix || 0,
            inventory: account.inventory || [],
            isAdmin: isAdminUsername(account.username),
            dailyBonusGranted
        });
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

// ---- Fetch a fresh copy of "my own" account info (currency, avatar, admin/ban status). ----
// Used on page load so a client that's been sitting on stale localStorage data always
// re-syncs with the server (e.g. picks up a ban, or Robux/Tix an admin granted).
app.get('/accounts/:username', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    let dirty = liftBanIfExpired(account);
    // Only hand out the daily bonus to an account that isn't (currently) banned.
    let dailyBonusGranted = null;
    if (!account.banned) {
        dailyBonusGranted = grantDailyTixIfDue(account);
        if (dailyBonusGranted) dirty = true;
    }
    if (dirty) saveAccountsIndex();

    res.json({
        username: account.username,
        playerId: account.playerId,
        birthday: account.birthday,
        gender: account.gender,
        avatarImage: account.avatarImage || null,
        appearance: publicAppearance(account),
        robux: account.robux || 0,
        tix: account.tix || 0,
        inventory: account.inventory || [],
        isAdmin: isAdminUsername(account.username),
        banned: !!account.banned,
        banReason: account.banReason || '',
        banExpiresAt: account.banExpiresAt || null,
        dailyBonusGranted
    });
});

// ---- Save a snapshot image (data URL) of the account's current avatar, so friends can ----
// ---- see it without needing to load a full 3D scene of their own. ----
app.post('/accounts/:username/avatar', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const avatarImage = (req.body.avatarImage || '').toString();
    if (!avatarImage.startsWith('data:image/')) {
        return res.status(400).json({ error: 'invalid-avatar', message: 'avatarImage must be a data:image/... URL.' });
    }
    if (avatarImage.length > 1_500_000) {
        return res.status(400).json({ error: 'avatar-too-large', message: 'Avatar snapshot is too large.' });
    }

    account.avatarImage = avatarImage;

    // Optional: the Avatar Editor sends its current equip state alongside every
    // snapshot save, so "Currently Wearing" on the profile page can stay in sync
    // without a separate round trip. Only known slots/string-or-null values are kept.
    if (req.body.appearance && typeof req.body.appearance === 'object') {
        if (!account.appearance || typeof account.appearance !== 'object') account.appearance = blankAppearance();
        APPEARANCE_SLOTS.forEach(slot => {
            const val = req.body.appearance[slot];
            if (val === null) account.appearance[slot] = null;
            else if (typeof val === 'string' && val.length > 0 && val.length <= 300) account.appearance[slot] = val;
        });
    }

    saveAccountsIndex();
    res.json({ success: true, appearance: publicAppearance(account) });
});

// ---- List every buyable catalog item (currently: faces, 10 Tix each, all by RETROBLOX) ----
app.get('/catalog', (req, res) => {
    res.json(CATALOG_ITEMS);
});

// ================= INVENTORY =================

// ---- Get a player's owned catalog items ----
app.get('/accounts/:username/inventory', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.inventory)) account.inventory = [];
    res.json({ inventory: account.inventory });
});

// ---- Buy a catalog item with Tix (currently only faces are sold) ----
app.post('/accounts/:username/inventory/buy', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (liftBanIfExpired(account)) saveAccountsIndex();
    if (account.banned) return res.status(403).json({ error: 'banned', message: 'Banned accounts cannot make purchases.' });

    const itemPath = (req.body.itemPath || '').toString();
    const item = findCatalogItem(itemPath);
    if (!item) return res.status(400).json({ error: 'invalid-item', message: 'That item is not in the catalog.' });

    if (!Array.isArray(account.inventory)) account.inventory = [];
    if (account.inventory.includes(itemPath)) {
        return res.json({ success: true, status: 'already-owned', tix: account.tix, robux: account.robux, inventory: account.inventory });
    }

    if ((account.tix || 0) < item.price) {
        return res.status(400).json({ error: 'insufficient-tix', message: `You need ${item.price} Tix to buy this item.` });
    }

    account.tix -= item.price;
    account.inventory.push(itemPath);
    saveAccountsIndex();
    res.json({ success: true, status: 'purchased', tix: account.tix, robux: account.robux, inventory: account.inventory });
});

// ================= SEARCH =================
const SEARCH_RESULT_LIMIT = 24;

// ---- Search (or browse) players. Empty q -> most "popular" (most friends) first. ----
app.get('/search/players', (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    let results = accounts.slice();
    if (q) {
        results = results.filter(a => a.username.toLowerCase().includes(q));
    }
    results.sort((a, b) => {
        const byFriends = (Array.isArray(b.friends) ? b.friends.length : 0) - (Array.isArray(a.friends) ? a.friends.length : 0);
        if (byFriends !== 0) return byFriends;
        return (a.playerId || 0) - (b.playerId || 0);
    });
    res.json(results.slice(0, SEARCH_RESULT_LIMIT).map(publicSearchAccount));
});

// ---- Search (or browse) games. Empty q -> most "popular" (most likes) first. ----
app.get('/search/games', (req, res) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    let results = games.filter(g => !g.takenDown);
    if (q) {
        results = results.filter(g => g.name.toLowerCase().includes(q));
    }
    results.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    res.json(results.slice(0, SEARCH_RESULT_LIMIT).map(publicGame));
});

// ================= PUBLIC PROFILE =================

// ---- Get everything a player-profile page needs about an account, plus (if a ----
// ---- ?viewer=username is passed) how the viewer relates to them (friend/follow/block). ----
app.get('/accounts/:username/profile', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    if (!Array.isArray(account.friends)) account.friends = [];
    if (!Array.isArray(account.followers)) account.followers = [];
    if (!Array.isArray(account.following)) account.following = [];
    if (typeof account.bio !== 'string') account.bio = '';

    const viewerUsername = (req.query.viewer || '').toString().trim();
    const viewer = viewerUsername ? findAccountByUsername(viewerUsername) : null;

    let relationship = null;
    if (viewer && viewer.username.toLowerCase() !== account.username.toLowerCase()) {
        if (!Array.isArray(viewer.following)) viewer.following = [];
        if (!Array.isArray(viewer.blockedUsers)) viewer.blockedUsers = [];
        if (!Array.isArray(account.friendRequests)) account.friendRequests = [];
        relationship = {
            isFriend: account.friends.some(f => f.toLowerCase() === viewer.username.toLowerCase()),
            isFollowing: viewer.following.some(u => u.toLowerCase() === account.username.toLowerCase()),
            isFollowedBy: account.following.some(u => u.toLowerCase() === viewer.username.toLowerCase()),
            isBlocked: viewer.blockedUsers.some(u => u.toLowerCase() === account.username.toLowerCase()),
            // True once the viewer has sent this account a friend request that's still pending accept/decline.
            requestSentByViewer: account.friendRequests.some(u => u.toLowerCase() === viewer.username.toLowerCase())
        };
    }

    res.json({
        username: account.username,
        playerId: account.playerId,
        avatarImage: account.avatarImage || null,
        appearance: publicAppearance(account),
        createdAt: account.createdAt,
        bio: account.bio || '',
        friendsCount: account.friends.length,
        followersCount: account.followers.length,
        followingCount: account.following.length,
        relationship
    });
});

// ---- List every game a player has created/published (for the Creations section) ----
app.get('/accounts/:username/creations', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const showTakenDown = isAdminUsername(req.query.adminUsername);
    const creations = games
        .filter(g => g.creator.toLowerCase() === account.username.toLowerCase() && (showTakenDown || !g.takenDown))
        .map(g => showTakenDown ? { ...publicGame(g), takenDown: !!g.takenDown, takedownReason: g.takedownReason || '' } : publicGame(g));

    res.json(creations);
});

// ---- Update a player's bio (shown on their profile) ----
app.post('/accounts/:username/bio', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    account.bio = (req.body.bio || '').toString().slice(0, 500);
    saveAccountsIndex();
    res.json({ success: true, bio: account.bio });
});

// ================= FOLLOW (one-directional, separate from mutual Friends) =================

// ---- Follow a player ----
app.post('/accounts/:username/follow', (req, res) => {
    const target = findAccountByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const followerUsername = (req.body.followerUsername || '').toString().trim();
    const follower = findAccountByUsername(followerUsername);
    if (!follower) return res.status(404).json({ error: 'no-follower-account', message: 'Your account was not found.' });
    if (follower.username.toLowerCase() === target.username.toLowerCase()) {
        return res.status(400).json({ error: 'cannot-follow-self', message: "You can't follow yourself." });
    }

    if (!Array.isArray(target.followers)) target.followers = [];
    if (!Array.isArray(follower.following)) follower.following = [];

    if (!target.followers.some(u => u.toLowerCase() === follower.username.toLowerCase())) {
        target.followers.push(follower.username);
    }
    if (!follower.following.some(u => u.toLowerCase() === target.username.toLowerCase())) {
        follower.following.push(target.username);
    }

    saveAccountsIndex();
    res.json({ success: true, followersCount: target.followers.length });
});

// ---- Unfollow a player ----
app.post('/accounts/:username/unfollow', (req, res) => {
    const target = findAccountByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const followerUsername = (req.body.followerUsername || '').toString().trim();
    const follower = findAccountByUsername(followerUsername);

    if (!Array.isArray(target.followers)) target.followers = [];
    target.followers = target.followers.filter(u => u.toLowerCase() !== followerUsername.toLowerCase());
    if (follower && Array.isArray(follower.following)) {
        follower.following = follower.following.filter(u => u.toLowerCase() !== target.username.toLowerCase());
    }

    saveAccountsIndex();
    res.json({ success: true, followersCount: target.followers.length });
});

// ================= BLOCK =================

// ---- Block a player - also strips any existing friendship/follow between the two ----
app.post('/accounts/:username/block', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const blockedUsername = (req.body.blockedUsername || '').toString().trim();
    if (!blockedUsername) return res.status(400).json({ error: 'missing-blocked', message: 'Missing blockedUsername.' });
    if (blockedUsername.toLowerCase() === account.username.toLowerCase()) {
        return res.status(400).json({ error: 'cannot-block-self', message: "You can't block yourself." });
    }

    if (!Array.isArray(account.blockedUsers)) account.blockedUsers = [];
    if (!account.blockedUsers.some(u => u.toLowerCase() === blockedUsername.toLowerCase())) {
        account.blockedUsers.push(blockedUsername);
    }

    account.friends = (account.friends || []).filter(f => f.toLowerCase() !== blockedUsername.toLowerCase());
    account.following = (account.following || []).filter(f => f.toLowerCase() !== blockedUsername.toLowerCase());
    account.followers = (account.followers || []).filter(f => f.toLowerCase() !== blockedUsername.toLowerCase());

    const blockedAccount = findAccountByUsername(blockedUsername);
    if (blockedAccount) {
        blockedAccount.friends = (blockedAccount.friends || []).filter(f => f.toLowerCase() !== account.username.toLowerCase());
        blockedAccount.following = (blockedAccount.following || []).filter(f => f.toLowerCase() !== account.username.toLowerCase());
        blockedAccount.followers = (blockedAccount.followers || []).filter(f => f.toLowerCase() !== account.username.toLowerCase());
    }

    saveAccountsIndex();
    res.json({ success: true, blockedUsers: account.blockedUsers });
});

// ---- Unblock a player ----
app.post('/accounts/:username/unblock', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const blockedUsername = (req.body.blockedUsername || '').toString().trim();
    if (!Array.isArray(account.blockedUsers)) account.blockedUsers = [];
    account.blockedUsers = account.blockedUsers.filter(u => u.toLowerCase() !== blockedUsername.toLowerCase());
    saveAccountsIndex();
    res.json({ success: true, blockedUsers: account.blockedUsers });
});

// ================= REPORT =================

// ---- Report a player. No moderation UI yet - just persisted for the record. ----
app.post('/accounts/:username/report', (req, res) => {
    const target = findAccountByUsername(req.params.username);
    if (!target) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const reporterUsername = (req.body.reporterUsername || 'Guest').toString().slice(0, 60);
    const reason = (req.body.reason || '').toString().slice(0, 500);

    reports.push({
        id: crypto.randomUUID(),
        targetUsername: target.username,
        reporterUsername,
        reason,
        createdAt: Date.now()
    });
    saveReports();
    res.json({ success: true });
});

// ================= FRIENDS =================

// ---- Send a friend request (no longer auto-accepts). If the target already sent ----
// ---- *you* a request, this instead accepts theirs, so two people requesting each ----
// ---- other doesn't leave two pending requests sitting around forever. ----
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
    if (!Array.isArray(account.friendRequests)) account.friendRequests = [];
    if (!Array.isArray(friendAccount.friendRequests)) friendAccount.friendRequests = [];

    const alreadyFriends = account.friends.some(f => f.toLowerCase() === friendAccount.username.toLowerCase());
    if (alreadyFriends) {
        return res.json({ success: true, status: 'already-friends', friends: account.friends });
    }

    // They already requested us -> accept theirs instead of creating a duplicate request.
    const incomingIdx = account.friendRequests.findIndex(u => u.toLowerCase() === friendAccount.username.toLowerCase());
    if (incomingIdx !== -1) {
        account.friendRequests.splice(incomingIdx, 1);
        friendAccount.friendRequests = friendAccount.friendRequests.filter(u => u.toLowerCase() !== account.username.toLowerCase());
        account.friends.push(friendAccount.username);
        friendAccount.friends.push(account.username);
        saveAccountsIndex();
        // friendAccount was the original sender of the pending request we just satisfied -
        // let them know live, the same way an explicit accept would.
        const senderPresence = sitePresence[friendAccount.username.toLowerCase()];
        if (senderPresence) {
            io.to(senderPresence.socketId).emit('friendRequestAccepted', { by: account.username, at: Date.now() });
        }
        return res.json({ success: true, status: 'auto-accepted', friends: account.friends, friendRequests: account.friendRequests });
    }

    const alreadyRequested = friendAccount.friendRequests.some(u => u.toLowerCase() === account.username.toLowerCase());
    if (alreadyRequested) {
        return res.json({ success: true, status: 'already-requested' });
    }

    friendAccount.friendRequests.push(account.username);
    saveAccountsIndex();

    // Push the request live to the recipient if they currently have the site/game open.
    const recipientPresence = sitePresence[friendAccount.username.toLowerCase()];
    if (recipientPresence) {
        io.to(recipientPresence.socketId).emit('friendRequestReceived', {
            from: account.username,
            avatarImage: account.avatarImage || null,
            at: Date.now()
        });
    }

    res.json({ success: true, status: 'requested' });
});

// ---- List the friend requests *sent to* this account (pending, awaiting accept/decline) ----
app.get('/accounts/:username/friends/requests', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.friendRequests)) account.friendRequests = [];

    const requests = account.friendRequests.map(u => {
        const a = findAccountByUsername(u);
        return { username: u, avatarImage: a ? (a.avatarImage || null) : null };
    });
    res.json(requests);
});

// ---- Accept a pending friend request (mutual - adds both ways) ----
app.post('/accounts/:username/friends/accept', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const friendUsername = (req.body.friendUsername || '').toString().trim();
    if (!Array.isArray(account.friendRequests)) account.friendRequests = [];
    if (!Array.isArray(account.friends)) account.friends = [];

    const idx = account.friendRequests.findIndex(u => u.toLowerCase() === friendUsername.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'no-request', message: 'No pending request from that user.' });
    account.friendRequests.splice(idx, 1);

    if (!account.friends.some(f => f.toLowerCase() === friendUsername.toLowerCase())) {
        account.friends.push(friendUsername);
    }

    const friendAccount = findAccountByUsername(friendUsername);
    if (friendAccount) {
        if (!Array.isArray(friendAccount.friends)) friendAccount.friends = [];
        if (!friendAccount.friends.some(f => f.toLowerCase() === account.username.toLowerCase())) {
            friendAccount.friends.push(account.username);
        }
    }

    saveAccountsIndex();

    // Let the original sender know live that their request was accepted.
    const senderPresence = sitePresence[friendUsername.toLowerCase()];
    if (senderPresence) {
        io.to(senderPresence.socketId).emit('friendRequestAccepted', { by: account.username, at: Date.now() });
    }

    res.json({ success: true, friends: account.friends, friendRequests: account.friendRequests });
});

// ---- Decline (dismiss) a pending friend request ----
app.post('/accounts/:username/friends/decline', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const friendUsername = (req.body.friendUsername || '').toString().trim();
    if (!Array.isArray(account.friendRequests)) account.friendRequests = [];
    account.friendRequests = account.friendRequests.filter(u => u.toLowerCase() !== friendUsername.toLowerCase());

    saveAccountsIndex();
    res.json({ success: true, friendRequests: account.friendRequests });
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

// ---- List a user's friends (with avatar image, for display) ----
app.get('/accounts/:username/friends', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.friends)) account.friends = [];

    const friends = account.friends.map(u => {
        const a = findAccountByUsername(u);
        return { username: u, avatarImage: a ? (a.avatarImage || null) : null };
    });
    res.json(friends);
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

// ================= ADMIN (shaqman21 / RETROBLOX only) =================
// Every route below requires an "adminUsername" (body for POST, query for GET) that
// matches ADMIN_USERNAMES. See the note above isAdminUsername() for the security caveat.

// ---- List every game (including taken-down ones) for the admin games panel ----
app.get('/admin/games', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(games.map(g => ({
        ...publicGame(g),
        takenDown: !!g.takenDown,
        takedownReason: g.takedownReason || ''
    })));
});

// ---- Take a game down (hides it from /games and blocks play, but keeps the record) ----
app.post('/admin/games/:id/takedown', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'not-found', message: 'Game not found.' });

    g.takenDown = true;
    g.takedownReason = (req.body.reason || '').toString().slice(0, 300);
    saveGamesIndex();
    res.json({ success: true, game: { ...publicGame(g), takenDown: true, takedownReason: g.takedownReason } });
});

// ---- Restore a previously taken-down game ----
app.post('/admin/games/:id/restore', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'not-found', message: 'Game not found.' });

    g.takenDown = false;
    g.takedownReason = '';
    saveGamesIndex();
    res.json({ success: true, game: { ...publicGame(g), takenDown: false, takedownReason: '' } });
});

// ---- List every player account for the admin players panel ----
app.get('/admin/players', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let changed = false;
    accounts.forEach(a => { if (liftBanIfExpired(a)) changed = true; });
    if (changed) saveAccountsIndex();
    res.json(accounts.map(publicAccount));
});

// ---- Ban a player (blocks login and multiplayer join). Optional durationMs auto-unbans ----
// ---- them once that much time has passed (see liftBanIfExpired + the sweep below). ----
app.post('/admin/players/:username/ban', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (isAdminUsername(account.username)) {
        return res.status(400).json({ error: 'cannot-ban-admin', message: 'Admins cannot be banned.' });
    }

    const durationMs = Number(req.body.durationMs);
    account.banned = true;
    account.banReason = (req.body.reason || '').toString().slice(0, 300);
    account.banExpiresAt = (durationMs && durationMs > 0) ? Date.now() + durationMs : null;
    saveAccountsIndex();
    res.json({ success: true, account: publicAccount(account) });
});

// ---- Unban a player ----
app.post('/admin/players/:username/unban', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    account.banned = false;
    account.banReason = '';
    account.banExpiresAt = null;
    saveAccountsIndex();
    res.json({ success: true, account: publicAccount(account) });
});

// ---- Terminate (permanently delete) a player's account. Cannot be undone. ----
app.post('/admin/players/:username/terminate', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const idx = accounts.findIndex(a => a.username.toLowerCase() === req.params.username.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (isAdminUsername(accounts[idx].username)) {
        return res.status(400).json({ error: 'cannot-terminate-admin', message: 'Admins cannot be terminated.' });
    }

    const removedUsername = accounts[idx].username;
    accounts.splice(idx, 1);

    // Clean up any references to the removed account left on other accounts.
    accounts.forEach(a => {
        if (Array.isArray(a.friends)) a.friends = a.friends.filter(f => f.toLowerCase() !== removedUsername.toLowerCase());
        if (Array.isArray(a.friendRequests)) a.friendRequests = a.friendRequests.filter(f => f.toLowerCase() !== removedUsername.toLowerCase());
    });

    saveAccountsIndex();
    res.json({ success: true });
});

// ---- Grant (or deduct, with a negative amount) Robux/Tix to a player ----
app.post('/admin/players/:username/grant', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const robuxDelta = Number(req.body.robux) || 0;
    const tixDelta = Number(req.body.tix) || 0;
    account.robux = Math.max(0, (account.robux || 0) + robuxDelta);
    account.tix = Math.max(0, (account.tix || 0) + tixDelta);
    saveAccountsIndex();
    res.json({ success: true, account: publicAccount(account) });
});

// ================= SITE PRESENCE (online / in-game status shown on friends UI) =================
// Tracks who currently has the site open in a browser tab (separate from being inside a
// specific game's multiplayer room, which lives in gameStates below). The status shown
// for a friend is: "in-game" if they're in any gameStates room, else "online" if they're
// in sitePresence, else "offline".
const sitePresence = {}; // lowercased username -> { socketId, username, lastSeen }

// Find which game (if any) a username is currently connected to, by scanning every
// live game room for a player whose name matches (case-insensitive).
function findActiveGameForUsername(username) {
    const lower = (username || '').toString().toLowerCase();
    if (!lower) return null;
    for (const gameId in gameStates) {
        const room = gameStates[gameId];
        for (const socketId in room) {
            if ((room[socketId].name || '').toLowerCase() === lower) {
                const g = games.find(x => x.id === gameId);
                return { gameId, gameName: g ? g.name : 'a game' };
            }
        }
    }
    return null;
}

function presenceStatusFor(username) {
    const activeGame = findActiveGameForUsername(username);
    if (activeGame) return { status: 'in-game', gameId: activeGame.gameId, gameName: activeGame.gameName };
    if (sitePresence[(username || '').toString().toLowerCase()]) return { status: 'online', gameId: null, gameName: null };
    return { status: 'offline', gameId: null, gameName: null };
}

// ---- Look up online/in-game status for one or more usernames at once ----
// GET /presence?usernames=alice,bob,carol
app.get('/presence', (req, res) => {
    const usernames = (req.query.usernames || '').toString().split(',').map(u => u.trim()).filter(Boolean);
    const out = {};
    usernames.forEach(u => { out[u] = presenceStatusFor(u); });
    res.json(out);
});

// ================= DIRECT MESSAGES (site chat - separate from in-game chat) =================
// Anyone with an account can message anyone else, friends or not. Conversations are
// persisted the same way accounts/games are.
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
let conversations = [];
try {
    conversations = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
} catch (e) {
    conversations = [];
}
function saveConversations() {
    try {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(conversations, null, 2));
    } catch (e) {
        console.error('Failed to save messages:', e);
    }
}
function conversationKey(a, b) {
    return [a.toString().toLowerCase(), b.toString().toLowerCase()].sort().join('|');
}
function findOrCreateConversation(userA, userB) {
    const key = conversationKey(userA, userB);
    let convo = conversations.find(c => c.key === key);
    if (!convo) {
        convo = { key, users: [userA, userB], messages: [], lastRead: {}, updatedAt: Date.now() };
        conversations.push(convo);
    }
    return convo;
}
function otherUserIn(convo, username) {
    const lower = username.toString().toLowerCase();
    return convo.users.find(u => u.toLowerCase() !== lower) || convo.users[0];
}

// ---- Send a direct message ----
app.post('/messages/send', (req, res) => {
    const from = (req.body.from || '').toString().trim();
    const to = (req.body.to || '').toString().trim();
    const text = (req.body.text || '').toString().trim().slice(0, 1000);
    if (!from || !to || !text) return res.status(400).json({ error: 'missing-fields', message: 'from, to, and text are all required.' });
    if (from.toLowerCase() === to.toLowerCase()) return res.status(400).json({ error: 'cannot-message-self', message: "You can't message yourself." });

    if (!findAccountByUsername(from) || !findAccountByUsername(to)) {
        return res.status(404).json({ error: 'no-account', message: 'One of these accounts does not exist.' });
    }

    const convo = findOrCreateConversation(from, to);
    const message = { from, text, at: Date.now() };
    convo.messages.push(message);
    convo.updatedAt = message.at;
    convo.lastRead[from.toLowerCase()] = message.at; // sending counts as having read your own message
    saveConversations();

    // Push it live if the recipient currently has the site open.
    const recipientPresence = sitePresence[to.toLowerCase()];
    if (recipientPresence) {
        io.to(recipientPresence.socketId).emit('newMessage', { from, to, text, at: message.at });
    }

    res.json({ success: true, message });
});

// ---- List a user's conversations, most recently active first ----
app.get('/messages/conversations/:username', (req, res) => {
    const username = req.params.username;
    const mine = conversations.filter(c => c.users.some(u => u.toLowerCase() === username.toLowerCase()));
    mine.sort((a, b) => b.updatedAt - a.updatedAt);

    const out = mine.map(c => {
        const other = otherUserIn(c, username);
        const otherAccount = findAccountByUsername(other);
        const lastMessage = c.messages[c.messages.length - 1] || null;
        const lastReadAt = c.lastRead[username.toLowerCase()] || 0;
        const unread = c.messages.filter(m => m.from.toLowerCase() !== username.toLowerCase() && m.at > lastReadAt).length;
        return {
            username: other,
            avatarImage: otherAccount ? (otherAccount.avatarImage || null) : null,
            lastMessage: lastMessage ? lastMessage.text : '',
            lastFrom: lastMessage ? lastMessage.from : null,
            updatedAt: c.updatedAt,
            unread
        };
    });
    res.json(out);
});

// ---- Full message thread between two users - also marks it read for :username ----
app.get('/messages/thread/:username/:otherUsername', (req, res) => {
    const { username, otherUsername } = req.params;
    const convo = conversations.find(c => c.key === conversationKey(username, otherUsername));
    if (!convo) return res.json({ messages: [] });

    convo.lastRead[username.toLowerCase()] = Date.now();
    saveConversations();

    res.json({ messages: convo.messages });
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
    // ---- Site presence: client emits this once on connect (and again after a ----
    // ---- reconnect) so friends can be shown "online" even outside a game.    ----
    socket.on('sitePresence', (data) => {
        const username = data && data.username;
        if (!username) return;
        socket.data.presenceUsername = username;
        sitePresence[username.toLowerCase()] = { socketId: socket.id, username, lastSeen: Date.now() };
    });

    socket.on('joinGame', ({ gameId, userData }) => {
        const account = findAccountByUsername((userData && userData.username) || '');
        if (account && liftBanIfExpired(account)) saveAccountsIndex();
        if (account && account.banned) {
            socket.emit('banned', { reason: account.banReason || 'You have been banned.' });
            return;
        }

        socket.join(gameId);
        if (!gameStates[gameId]) gameStates[gameId] = {};

        gameStates[gameId][socket.id] = {
            id: socket.id,
            name: userData.username || "Guest",
            appearance: userData.appearance || {},
            avatarImage: userData.avatarImage || null,
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

    socket.on('disconnect', () => {
        const presenceUsername = socket.data && socket.data.presenceUsername;
        if (presenceUsername) {
            const entry = sitePresence[presenceUsername.toLowerCase()];
            // Only clear if this socket is still the one on file - guards against a user
            // with two tabs open where closing one shouldn't mark them offline.
            if (entry && entry.socketId === socket.id) delete sitePresence[presenceUsername.toLowerCase()];
        }
        updateGlobalCounts();
    });

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

// ================= STUDIO COLLABORATION (multiplayer editing + shared playtest) =================
// A "studio session" is an ad-hoc room formed the moment someone opens the Multiplayer
// plugin tab in Studio. Anyone invited who joins becomes part of studioRosters[sessionId].
// Pressing Play broadcasts to the room so everyone enters play mode together, reusing the
// exact same joinGame/updateState/etc events as the live game player (gameId = "studio_"+sessionId).
const studioRosters = {}; // sessionId -> { [socketId]: { username } }

io.on('connection', (socket) => {
    // ---- Invite a friend to collaborate. Delivered live if they have the site open; ----
    // ---- otherwise this is a no-op (studio invites are ephemeral, not persisted DMs). ----
    socket.on('studioInvite', ({ from, to, sessionId, placeName }) => {
        if (!from || !to || !sessionId) return;
        const recipientPresence = sitePresence[to.toLowerCase()];
        if (recipientPresence) {
            io.to(recipientPresence.socketId).emit('studioInviteReceived', {
                from, sessionId, placeName: placeName || 'Untitled Game', at: Date.now()
            });
        }
    });

    socket.on('studioJoinSession', ({ sessionId, username }) => {
        if (!sessionId || !username) return;
        const room = 'studio_' + sessionId;
        socket.join(room);
        socket.data.studioSessionId = sessionId;
        socket.data.studioUsername = username;

        if (!studioRosters[sessionId]) studioRosters[sessionId] = {};
        studioRosters[sessionId][socket.id] = { username };

        io.to(room).emit('studioRoster', studioRosters[sessionId]);
    });

    socket.on('studioLeaveSession', () => {
        leaveStudioSession(socket);
    });

    // ---- Someone in the session hit Play - tell everyone (including the presser) to ----
    // ---- enter play mode together, sharing gameId = "studio_"+sessionId. ----
    socket.on('studioStartPlay', ({ sessionId }) => {
        if (!sessionId) return;
        io.to('studio_' + sessionId).emit('studioPlayStarted', { sessionId });
    });

    socket.on('studioStopPlay', ({ sessionId }) => {
        if (!sessionId) return;
        io.to('studio_' + sessionId).emit('studioPlayStopped', { sessionId });
    });

    socket.on('disconnecting', () => {
        leaveStudioSession(socket);
    });

    function leaveStudioSession(socket) {
        const sessionId = socket.data && socket.data.studioSessionId;
        if (!sessionId) return;
        const room = 'studio_' + sessionId;
        if (studioRosters[sessionId]) {
            delete studioRosters[sessionId][socket.id];
            if (Object.keys(studioRosters[sessionId]).length === 0) {
                delete studioRosters[sessionId];
            } else {
                io.to(room).emit('studioRoster', studioRosters[sessionId]);
            }
        }
        socket.leave(room);
        socket.data.studioSessionId = null;
    }
});

// Ban-timer sweep: every minute, check every banned account with an expiry and lift
// the ban if it's passed - this is what makes bans "automatically" expire even if
// nobody happens to log in, load the admin panel, or try to join a game in the
// meantime.
setInterval(() => {
    let changed = false;
    accounts.forEach(a => { if (liftBanIfExpired(a)) changed = true; });
    if (changed) saveAccountsIndex();
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
