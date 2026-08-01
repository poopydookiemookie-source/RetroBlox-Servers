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
    if (!Array.isArray(a.friendRequests)) a.friendRequests = [];
    if (!Array.isArray(a.inventory)) a.inventory = [];
    if (typeof a.avatarImage !== 'string') a.avatarImage = null;
    if (typeof a.robux !== 'number' || isNaN(a.robux)) a.robux = 0;
    if (typeof a.tix !== 'number' || isNaN(a.tix)) a.tix = 0;
    if (typeof a.banned !== 'boolean') a.banned = false;
    if (typeof a.banReason !== 'string') a.banReason = '';
    if (typeof a.banExpiresAt !== 'number') a.banExpiresAt = null;
    if (typeof a.lastDailyRewardAt !== 'number') a.lastDailyRewardAt = 0;
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

        res.json({
            success: true,
            username: account.username,
            playerId: account.playerId,
            birthday: account.birthday,
            gender: account.gender,
            avatarImage: account.avatarImage,
            robux: account.robux,
            tix: account.tix,
            inventory: account.inventory,
            isAdmin: isAdminUsername(account.username)
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
    saveAccountsIndex();
    res.json({ success: true });
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
        return res.json({ success: true, status: 'auto-accepted', friends: account.friends, friendRequests: account.friendRequests });
    }

    const alreadyRequested = friendAccount.friendRequests.some(u => u.toLowerCase() === account.username.toLowerCase());
    if (alreadyRequested) {
        return res.json({ success: true, status: 'already-requested' });
    }

    friendAccount.friendRequests.push(account.username);
    saveAccountsIndex();
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
