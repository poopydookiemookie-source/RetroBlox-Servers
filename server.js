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
// 20mb (not 15mb) so a near-max-size Toolbox asset upload (see MAX_TOOLBOX_MODEL_CHARS
// below, ~15MB of model JSON alone) still fits once name/description/thumbnail are added.
app.use(express.json({ limit: '20mb' }));

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

// Where uploaded catalog item images (Shirts/Pants/T-Shirts/Accessories/Faces from the
// Item Creator plugin) get written. Same ephemeral-disk caveat as UPLOADS_DIR above.
const CATALOG_UPLOADS_DIR = path.join(UPLOADS_DIR, 'catalog');
if (!fs.existsSync(CATALOG_UPLOADS_DIR)) fs.mkdirSync(CATALOG_UPLOADS_DIR, { recursive: true });

// Where uploaded badge icons (from Studio's Badge Creator plugin) get written. Same
// ephemeral-disk caveat as UPLOADS_DIR above.
const BADGE_UPLOADS_DIR = path.join(UPLOADS_DIR, 'badges');
if (!fs.existsSync(BADGE_UPLOADS_DIR)) fs.mkdirSync(BADGE_UPLOADS_DIR, { recursive: true });

console.log(`[storage] Using DATA_DIR: ${DATA_DIR}`);

// Public base URL other machines use to reach THIS server. Catalog item images are
// served from our own disk (not bundled alongside display.html/studio.html the way
// ./items/faces/*.png are), so their itemPath has to be a real absolute URL no matter
// where the frontend happens to be hosted. Override via env var if this server's
// address ever changes.
const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || 'https://retroblox-servers.onrender.com';

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
const APPEARANCE_SLOTS = ['equippedFace', 'equippedHat', 'equippedHair', 'equippedFaceAccessory', 'equippedNeck', 'equippedShoulder', 'equippedFront', 'equippedBack', 'equippedWaist', 'equippedShirt', 'equippedPants', 'equippedTShirt'];
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

// Real Roblox's old paid-subscription tiers - Enum.MembershipType member names, in
// ascending order. Every account defaults to 'None' (see the accounts.forEach backfill
// below); an admin can grant a tier from the Admin Players tab. TIER_ICON_FILES maps
// each paid tier to the texture the client shows next to a player's name (None shows
// no icon, matching real Roblox) - filenames match what's in content/textures/.
const MEMBERSHIP_TYPES = ['None', 'BuildersClub', 'TurboBuildersClub', 'OutrageousBuildersClub'];
const TIER_ICON_FILES = {
    BuildersClub: 'buildersclub.png',
    TurboBuildersClub: 'turbobuildersclub.png',
    OutrageousBuildersClub: 'outrageousbuildersclub.png'
};

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
    // Every badge this account has ever been awarded, oldest first - {badgeId, awardedAt}.
    // A badge can only ever appear once per account (AwardBadge is idempotent, matching
    // real Roblox's BadgeService), so this array doubles as the "has earned" check.
    if (!Array.isArray(a.badges)) a.badges = [];
    // Player Points (PointsService:AwardPoints), scoped per game the same way badges are
    // scoped per game - {gameId, amount}. Unlike badges this ISN'T idempotent: real Roblox
    // Player Points are a running balance a game can award to (negative amount deducts, per
    // real Roblox), so each gameId entry just accumulates. account.pointsTotal is kept as a
    // denormalized sum across every gameId entry so profile/GetPointBalance reads don't have
    // to re-sum the array every time - see awardPointsToAccount() below, the only place either
    // is ever written.
    if (!Array.isArray(a.pointsByGame)) a.pointsByGame = [];
    if (typeof a.pointsTotal !== 'number' || isNaN(a.pointsTotal)) a.pointsTotal = 0;
    if (typeof a.bio !== 'string') a.bio = '';
    if (typeof a.avatarImage !== 'string') a.avatarImage = null;
    if (typeof a.robux !== 'number' || isNaN(a.robux)) a.robux = 0;
    if (typeof a.tix !== 'number' || isNaN(a.tix)) a.tix = 0;
    if (typeof a.banned !== 'boolean') a.banned = false;
    if (typeof a.banReason !== 'string') a.banReason = '';
    if (typeof a.banExpiresAt !== 'number') a.banExpiresAt = null;
    // MembershipType: real Roblox's old paid-subscription tiers (BC/TBC/OBC) - this
    // engine has no real payment backend, so every account defaults to None; an admin
    // can grant a tier per-account from the Admin Players tab (see
    // POST /admin/players/:username/membership below). Stored as the plain Enum member
    // name string so it serializes simply over JSON - the Lua bridge (editor.html) maps
    // this string onto the real Enum.MembershipType.* object PlayerlistModule/Topbar read.
    if (typeof a.membershipType !== 'string' || !MEMBERSHIP_TYPES.includes(a.membershipType)) a.membershipType = 'None';
    if (typeof a.lastDailyRewardAt !== 'number') a.lastDailyRewardAt = 0;
    if (!a.appearance || typeof a.appearance !== 'object') a.appearance = {};
    // Migrate the old single "equippedAccessory" slot (pre-dates the 7-category
    // Hat/Hair/Face/Neck/Shoulder/Front/Back/Waist accessory system) into the new
    // equippedHat slot, since that's what it always meant in practice.
    if (typeof a.appearance.equippedAccessory === 'string' && a.appearance.equippedAccessory && !a.appearance.equippedHat) {
        a.appearance.equippedHat = a.appearance.equippedAccessory;
    }
    delete a.appearance.equippedAccessory;
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
    // req.body can be undefined on a GET request with no JSON content-type (depends on
    // the exact body-parser version) - guard it so the admin GET panels (games,
    // players, catalog) don't 500 when only ?adminUsername=... is sent.
    const adminUsername = ((req.body && req.body.adminUsername) || req.query.adminUsername || '').toString();
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
        createdAt: g.createdAt,
        isPrivate: !!g.isPrivate,
        archived: !!g.archived,
        archivedAt: g.archivedAt || null,
        // Upload Options plugin fields (Retroblox Studio > Plugins tab > Retroblox
        // Plugins > Upload Options). maxPlayers caps each real server instance -
        // see the INSTANCING section below for how many instances actually exist
        // and GET /games/:id/instances for their live player counts.
        maturityRating: g.maturityRating || 'Everyone',
        genre: g.genre || 'All',
        theme: g.theme || 'None',
        gearsAllowed: !!g.gearsAllowed,
        allowCopying: !!g.allowCopying,
        allowThirdPartyTeleports: !!g.allowThirdPartyTeleports,
        maxPlayers: g.maxPlayers || 10,
        defaultRigType: g.defaultRigType || 'PlayerChoice',
        collaborators: Array.isArray(g.collaborators) ? g.collaborators : []
    };
}

// Whether `username` is allowed to open this game in Studio and build in it -
// true for the owner (case-insensitive) or anyone on its collaborators list.
// Used to gate the ?gameId= Studio load and the collab-session scene fetch;
// NOT used for the ownership-only actions (edit/content save/rename/visibility/
// archive/delete/invite) which stay creator-only via requireOwner/g.creator checks.
function canEditGame(g, username) {
    const u = (username || '').toString().trim().toLowerCase();
    if (!u) return false;
    if ((g.creator || '').toString().trim().toLowerCase() === u) return true;
    return Array.isArray(g.collaborators) && g.collaborators.some(c => (c || '').toLowerCase() === u);
}

// Whether `viewerUsername` is allowed to see/play a private game - true for the
// game's own creator (case-insensitive, same comparison /games/:id/edit uses) or
// an admin, false for anyone else (including guests, who pass no username at all).
function canViewPrivateGame(g, viewerUsername) {
    const viewer = (viewerUsername || '').toString().trim();
    if (!viewer) return false;
    if (viewer.toLowerCase() === (g.creator || '').toString().trim().toLowerCase()) return true;
    return isAdminUsername(viewer);
}

// Parses/validates the Upload Options plugin's fields out of a multipart body
// (req.body, all strings) for both /upload and /games/:id/content - shared so
// the two endpoints can't drift on allowed values or clamping.
const VALID_MATURITY_RATINGS = ['Everyone', 'Nine Plus', 'Teen', 'Mature'];
const VALID_RIG_TYPES = ['PlayerChoice', 'R6', 'R15'];
function parseUploadOptionsFields(body) {
    const maturityRating = VALID_MATURITY_RATINGS.includes(body.maturityRating) ? body.maturityRating : 'Everyone';
    const defaultRigType = VALID_RIG_TYPES.includes(body.defaultRigType) ? body.defaultRigType : 'PlayerChoice';
    // Genre/Theme aren't validated against a fixed list server-side - the client's
    // <select> already constrains them, and a free-form fallback here is harmless.
    const genre = (body.genre || 'All').toString().slice(0, 40);
    const theme = (body.theme || 'None').toString().slice(0, 40);
    const gearsAllowed = body.gearsAllowed === 'true';
    const allowCopying = body.allowCopying === 'true';
    const allowThirdPartyTeleports = body.allowThirdPartyTeleports === 'true';
    // Clamp 1-50, same as the plugin's slider. This is the cap PER SERVER
    // INSTANCE - how many instances actually exist is no longer a fixed number
    // the creator picks; see the INSTANCING section for how instances are
    // created/destroyed on demand as players come and go.
    let maxPlayers = parseInt(body.maxPlayers, 10);
    if (!Number.isFinite(maxPlayers)) maxPlayers = 10;
    maxPlayers = Math.min(50, Math.max(1, maxPlayers));

    return { maturityRating, defaultRigType, genre, theme, gearsAllowed, allowCopying, allowThirdPartyTeleports, maxPlayers };
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
        membershipType: a.membershipType || 'None',
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
// Catalog items are user-generated content, uploaded from the Item Creator plugin in
// Retroblox Studio. Shirts/Pants/T-Shirts are open to anyone; the 8 accessory kinds and
// Faces can only be uploaded by admins (mirrors ADMIN_USERNAMES below - same rule faces
// have always followed). Every item is persisted to disk (like games/accounts) and gets
// a permanent, sequential item number the same way accounts get a playerId - the first
// item ever uploaded (or seeded, see below) is #1.
const CATALOG_ITEMS_FILE = path.join(DATA_DIR, 'catalog_items.json');
const CATALOG_ID_COUNTER_FILE = path.join(DATA_DIR, 'catalog_id_counter.json');

const CLOTHING_CATEGORIES = ['shirts', 'pants', 'tshirts'];
const ACCESSORY_CATEGORIES = ['hats', 'hair', 'faceaccessories', 'neck', 'shoulder', 'front', 'back', 'waist']; // the 8 accessory kinds
const FACE_CATEGORY = 'faces';
const ALL_CATALOG_CATEGORIES = [...CLOTHING_CATEGORIES, ...ACCESSORY_CATEGORIES, FACE_CATEGORY];
const ADMIN_ONLY_CATEGORIES = [...ACCESSORY_CATEGORIES, FACE_CATEGORY];
// Which "Currently Wearing" equip slot (see APPEARANCE_SLOTS above) each category fills.
const CATEGORY_APPEARANCE_SLOT = {
    shirts: 'equippedShirt', pants: 'equippedPants', tshirts: 'equippedTShirt',
    hats: 'equippedHat', hair: 'equippedHair', faceaccessories: 'equippedFaceAccessory',
    neck: 'equippedNeck', shoulder: 'equippedShoulder', front: 'equippedFront',
    back: 'equippedBack', waist: 'equippedWaist', faces: 'equippedFace'
};
const UPLOAD_FEE_ROBUX = 5;    // charged to the uploader every time, regardless of the item's own price/currency
const MIN_ITEM_PRICE = 2;
const MAX_ITEM_PRICE = 9999999;

let catalogItems = [];
try {
    catalogItems = JSON.parse(fs.readFileSync(CATALOG_ITEMS_FILE, 'utf8'));
    console.log(`[storage] Loaded ${catalogItems.length} catalog item(s) from ${CATALOG_ITEMS_FILE}`);
} catch (e) {
    catalogItems = [];
    console.log(`[storage] No existing catalog_items.json found at ${CATALOG_ITEMS_FILE} (starting empty). Reason: ${e.code || e.message}`);
}
// Backfill fields for items saved before a field existed
catalogItems.forEach(i => {
    if (!Array.isArray(i.children)) i.children = [];
    if (typeof i.takenDown !== 'boolean') i.takenDown = false;
    if (typeof i.takedownReason !== 'string') i.takedownReason = '';
    if (typeof i.description !== 'string') i.description = '';
    if (i.modelFormat === undefined) i.modelFormat = null;
    if (i.modelData === undefined) i.modelData = null;
    if (i.originalPosition === undefined) i.originalPosition = null;
    if (i.originalSize === undefined) i.originalSize = null;
    if (typeof i.forSale !== 'boolean') i.forSale = true;
});

function saveCatalogItemsIndex() {
    try {
        fs.writeFileSync(CATALOG_ITEMS_FILE, JSON.stringify(catalogItems, null, 2));
    } catch (e) {
        console.error('Failed to save catalog items index:', e);
    }
}

let nextCatalogItemId = 1;
try {
    const counterData = JSON.parse(fs.readFileSync(CATALOG_ID_COUNTER_FILE, 'utf8'));
    if (typeof counterData.next === 'number' && counterData.next > 0) nextCatalogItemId = counterData.next;
} catch (e) {
    // No counter file yet - fine, we'll create one below.
}
function saveCatalogIdCounter() {
    try {
        fs.writeFileSync(CATALOG_ID_COUNTER_FILE, JSON.stringify({ next: nextCatalogItemId }));
    } catch (e) {
        console.error('Failed to save catalog ID counter:', e);
    }
}

// Faces used to auto-seed from a hardcoded list of built-in images the first time this
// server booted. That's disabled now - the catalog is strictly player uploads only, so
// this block intentionally does nothing. (Old servers that already ran the seed once
// still have those items sitting in catalog_items.json - remove them by hand there, or
// via the admin catalog panel, if you want them gone too.)

function findCatalogItem(itemPath) {
    return catalogItems.find(i => i.itemPath === itemPath);
}
function findCatalogItemById(id) {
    return catalogItems.find(i => String(i.id) === String(id));
}

// Real property schemas matching Studio's actual PointLight/SpotLight/ParticleEmitter/
// Sparkles/Fire/Smoke objects (see window.non3DItems in editor.html) - so a child stored
// on a catalog accessory can be spawned as a genuine child instance the moment it's
// equipped, instead of being just descriptive text. Unknown types/fields are dropped
// rather than stored as-is, since this data eventually gets pushed straight into a live
// 3D scene. Each field's default (used when a value is missing/invalid) matches that
// property's default in Studio's own Add Effect menu, so a Fire without an explicit
// SecondaryColor still comes out gold instead of white, etc.
const CHILD_SCHEMAS = {
    PointLight: { Color: { kind: 'color', default: '#ffffff' }, Brightness: { kind: 'number', default: 1 }, Range: { kind: 'number', default: 12 } },
    SpotLight: { Color: { kind: 'color', default: '#ffffff' }, Brightness: { kind: 'number', default: 1 }, Range: { kind: 'number', default: 16 }, Angle: { kind: 'number', default: 90 } },
    ParticleEmitter: { Color: { kind: 'color', default: '#ffffff' }, Size: { kind: 'number', default: 1 }, Rate: { kind: 'number', default: 20 } },
    Sparkles: { Color: { kind: 'color', default: '#ffffff' }, Size: { kind: 'number', default: 1 }, Rate: { kind: 'number', default: 20 } },
    Fire: { Color: { kind: 'color', default: '#FF8C00' }, SecondaryColor: { kind: 'color', default: '#FFD700' }, Size: { kind: 'number', default: 8 }, Heat: { kind: 'number', default: 9 } },
    Smoke: { Color: { kind: 'color', default: '#808080' }, Size: { kind: 'number', default: 1 }, Opacity: { kind: 'number', default: 0.5, max: 1 }, RiseVelocity: { kind: 'number', default: 1 } }
};
// A per-accessory position/size adjusted on the reference NPC in Studio's Accessory
// Editor tab (see window.buildAccessoryAttachmentHierarchy in editor.html) - a plain
// [x,y,z] array of finite numbers, or null if never provided/malformed. Stored on the
// catalog item as originalPosition/originalSize and handed back down so any client
// (Studio, the website's item page, or player.js on real equip) can rebuild the exact
// same Handle/[Type]Attachment/OriginalPosition/OriginalSize hierarchy the creator saw,
// instead of falling back to the generic per-type default.
function sanitizeVec3(raw) {
    let arr;
    try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
    if (!Array.isArray(arr) || arr.length !== 3) return null;
    const nums = arr.map(Number);
    if (!nums.every(Number.isFinite)) return null;
    // Clamp to a sane range - this only ever describes a small local offset/scale
    // multiplier, never a world-space coordinate, so anything huge is bogus input.
    return nums.map(n => Math.max(-1000, Math.min(1000, n)));
}

function sanitizeAccessoryChild(c) {
    if (!c || typeof c !== 'object') return null;
    const type = (c.type || '').toString();
    const schema = CHILD_SCHEMAS[type];
    if (!schema) return null;

    const out = { type, name: (c.name || type).toString().slice(0, 60) };
    for (const [field, def] of Object.entries(schema)) {
        const raw = c[field];
        if (def.kind === 'color') {
            out[field] = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : def.default;
        } else if (def.kind === 'number') {
            const n = Number(raw);
            const max = def.max !== undefined ? def.max : 1000;
            out[field] = Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : def.default;
        }
    }
    return out;
}

// Public-safe view of a catalog item, used by both the catalog grid and the item page.
// modelFormat tells the client which loader to use for an accessory's itemPath (see
// GET /catalog/model/:id below); the raw modelData itself is NOT included here, since
// it can be several MB and the catalog grid/list only needs it on demand.
function publicCatalogItem(i) {
    return {
        id: i.id,
        name: i.name,
        description: i.description,
        category: i.category,
        itemPath: i.itemPath,
        modelFormat: i.modelFormat || null,
        price: i.price,
        currency: i.currency,
        creator: i.creator,
        createdAt: i.createdAt,
        children: i.children || [],
        originalPosition: i.originalPosition || null,
        originalSize: i.originalSize || null,
        forSale: i.forSale !== false
    };
}

// ================= BADGES =================
// A badge is created under one specific game (like real Roblox: you make it on the
// site/Studio "under" an experience, then a server script awards it to players at
// runtime). Persisted the same way catalog items are - a flat JSON file plus a
// sequential ID counter - and icons are stored on disk the same way catalog item
// images are (see BADGE_UPLOADS_DIR above).
const BADGES_FILE = path.join(DATA_DIR, 'badges.json');
const BADGE_ID_COUNTER_FILE = path.join(DATA_DIR, 'badge_id_counter.json');

let badges = [];
try {
    badges = JSON.parse(fs.readFileSync(BADGES_FILE, 'utf8'));
    console.log(`[storage] Loaded ${badges.length} badge(s) from ${BADGES_FILE}`);
} catch (e) {
    badges = [];
    console.log(`[storage] No existing badges.json found at ${BADGES_FILE} (starting empty). Reason: ${e.code || e.message}`);
}
function saveBadgesIndex() {
    try {
        fs.writeFileSync(BADGES_FILE, JSON.stringify(badges, null, 2));
    } catch (e) {
        console.error('Failed to save badges index:', e);
    }
}

let nextBadgeId = 1;
try {
    const counterData = JSON.parse(fs.readFileSync(BADGE_ID_COUNTER_FILE, 'utf8'));
    if (typeof counterData.next === 'number' && counterData.next > 0) nextBadgeId = counterData.next;
} catch (e) {
    // No counter file yet - fine, we'll create one below.
}
function saveBadgeIdCounter() {
    try {
        fs.writeFileSync(BADGE_ID_COUNTER_FILE, JSON.stringify({ next: nextBadgeId }));
    } catch (e) {
        console.error('Failed to save badge ID counter:', e);
    }
}

function findBadgeById(id) {
    return badges.find(b => String(b.id) === String(id));
}

// Public-safe view of a badge, used by the game page's Badges card and anywhere else
// a badge definition (not an award) is shown.
function publicBadge(b) {
    return {
        id: b.id,
        gameId: b.gameId,
        name: b.name,
        description: b.description,
        iconPath: b.iconPath,
        creator: b.creator,
        createdAt: b.createdAt
    };
}

// ---- Create a new badge under a specific game (Studio's Badge Creator plugin) ----
// Only that game's creator can add badges to it - same ownership rule Retroblox
// already enforces for editing/renaming/archiving a game elsewhere in this file.
const badgeIconUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/games/:id/badges', badgeIconUpload.single('icon'), (req, res) => {
    try {
        const game = games.find(g => g.id === req.params.id);
        if (!game) return res.status(404).json({ error: 'no-game', message: 'Game not found.' });

        const account = findAccountByUsername((req.body.username || '').toString());
        if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found. Log in to create a badge.' });
        if (liftBanIfExpired(account)) saveAccountsIndex();
        if (account.banned) return res.status(403).json({ error: 'banned', message: 'Banned accounts cannot create badges.' });

        if (account.username.toLowerCase() !== game.creator.toLowerCase()) {
            return res.status(403).json({ error: 'not-owner', message: 'Only this game\'s creator can add badges to it.' });
        }

        const name = (req.body.name || '').toString().trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: 'missing-name', message: 'Give this badge a name.' });

        const description = (req.body.description || '').toString().trim().slice(0, 1000);
        if (!description) return res.status(400).json({ error: 'missing-description', message: 'A description is required to create a badge.' });

        if (!req.file) return res.status(400).json({ error: 'no-image', message: 'An icon image (PNG or JPG) is required.' });
        const mime = (req.file.mimetype || '').toLowerCase();
        const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
        if (!ALLOWED_MIMES.includes(mime)) {
            return res.status(400).json({ error: 'invalid-file-type', message: 'Badge icons must be a PNG or JPG file.' });
        }

        const id = nextBadgeId++;
        saveBadgeIdCounter();

        const imgExt = mime === 'image/png' ? '.png' : '.jpg';
        const filename = `${id}${imgExt}`;
        fs.writeFileSync(path.join(BADGE_UPLOADS_DIR, filename), req.file.buffer);
        const iconPath = `${PUBLIC_SERVER_URL}/badges/icon/${filename}`;

        const badge = {
            id,
            gameId: game.id,
            name,
            description,
            iconPath,
            creator: account.username,
            createdAt: Date.now()
        };
        badges.push(badge);
        saveBadgesIndex();

        res.json({ success: true, badge: publicBadge(badge) });
    } catch (err) {
        console.error('Badge creation error:', err);
        res.status(500).json({ error: 'creation-failed', message: 'Something went wrong creating that badge.' });
    }
});

// Serve uploaded badge icon images (written by /games/:id/badges above).
app.use('/badges/icon', express.static(BADGE_UPLOADS_DIR));

// ---- List every badge that belongs to a specific game (game page's Badges card) ----
// ?viewer=<username> additionally tags each badge with whether/when that viewer
// earned it, so the game page can show "You won this today" etc.
app.get('/games/:id/badges', (req, res) => {
    const gameBadges = badges.filter(b => b.gameId === req.params.id);

    const viewerUsername = (req.query.viewer || '').toString().trim();
    const viewer = viewerUsername ? findAccountByUsername(viewerUsername) : null;

    const out = gameBadges.map(b => {
        const base = publicBadge(b);
        if (viewer && Array.isArray(viewer.badges)) {
            const award = viewer.badges.find(a => String(a.badgeId) === String(b.id));
            base.awardedAt = award ? award.awardedAt : null;
        } else {
            base.awardedAt = null;
        }
        return base;
    });

    res.json({ badges: out });
});

// ---- Player Points (PointsService) ----
// Unlike badges, points have no registration step on real Roblox - a game just calls
// AwardPoints(userId, amount) with a raw number, there's no "create a point type" concept.
// So there's no findPointsById/publicPoints pair here, just this one mutator shared by the
// award endpoint below and used by the balance-reading endpoints further down.
//
// amount can be negative (real Roblox: "Negative amounts will deduct their player points"),
// but the running total is clamped at 0 - real Roblox doesn't document balances going negative,
// and nothing in this codebase should show a player owing points.
function awardPointsToAccount(account, gameId, amount) {
    if (!Array.isArray(account.pointsByGame)) account.pointsByGame = [];
    let entry = account.pointsByGame.find(p => p.gameId === gameId);
    if (!entry) {
        entry = { gameId, amount: 0 };
        account.pointsByGame.push(entry);
    }
    entry.amount = Math.max(0, entry.amount + amount);
    account.pointsTotal = Math.max(0, account.pointsByGame.reduce((sum, p) => sum + p.amount, 0));
    return entry.amount;
}

// ---- Award a badge to a player (called from a game's server script via BadgeService:AwardBadge) ----
// Idempotent like real Roblox - awarding a badge a player already has is a no-op success,
// never a duplicate or an error. This is the only "write" badge endpoint; there is no
// manual/admin award path, same as real Roblox (only a game's own server-side script can
// award its badges).
app.post('/badges/:id/award', (req, res) => {
    try {
        const badge = findBadgeById(req.params.id);
        if (!badge) return res.status(404).json({ error: 'no-badge', message: 'Badge not found.' });

        const username = (req.body.username || '').toString();
        const account = findAccountByUsername(username);
        if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

        if (!Array.isArray(account.badges)) account.badges = [];
        const alreadyHas = account.badges.some(a => String(a.badgeId) === String(badge.id));
        if (alreadyHas) {
            return res.json({ success: true, alreadyAwarded: true, badge: publicBadge(badge) });
        }

        const awardedAt = Date.now();
        account.badges.push({ badgeId: badge.id, awardedAt });
        saveAccountsIndex();

        res.json({ success: true, alreadyAwarded: false, awardedAt, badge: publicBadge(badge) });
    } catch (err) {
        console.error('Badge award error:', err);
        res.status(500).json({ error: 'award-failed', message: 'Something went wrong awarding that badge.' });
    }
});

// ---- Check whether a player already has a badge (BadgeService:UserHasBadgeAsync) ----
app.get('/badges/:id/has/:username', (req, res) => {
    const badge = findBadgeById(req.params.id);
    if (!badge) return res.status(404).json({ error: 'no-badge', message: 'Badge not found.' });

    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const hasBadge = Array.isArray(account.badges) && account.badges.some(a => String(a.badgeId) === String(badge.id));
    res.json({ hasBadge });
});

// ---- Award stats for one badge - total wins, plus how many were won today/yesterday ----
// ---- (Creations -> Badges tab -> click a badge -> detail view). "Today"/"yesterday" ----
// ---- are calendar days in server-local time, same as Date.now() everywhere else here. ----
app.get('/badges/:id/stats', (req, res) => {
    const badge = findBadgeById(req.params.id);
    if (!badge) return res.status(404).json({ error: 'no-badge', message: 'Badge not found.' });

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

    let total = 0, wonToday = 0, wonYesterday = 0;
    for (const account of accounts) {
        if (!Array.isArray(account.badges)) continue;
        for (const award of account.badges) {
            if (String(award.badgeId) !== String(badge.id)) continue;
            total++;
            if (award.awardedAt >= startOfToday) wonToday++;
            else if (award.awardedAt >= startOfYesterday) wonYesterday++;
        }
    }

    res.json({ total, wonToday, wonYesterday });
});

// ---- Award Player Points to a player (called from a game's server script via ----
// ---- PointsService:AwardPoints(userId, amount)). Not idempotent like badge awards - ----
// ---- every call adds amount onto that gameId's running balance (real Roblox: negative ----
// ---- amounts deduct). There's no badge-style "definition" to look up first, since real ----
// ---- Roblox points have no registration step - just a gameId and a number. ----
app.post('/points/:gameId/award', (req, res) => {
    try {
        const gameId = req.params.gameId;
        if (!isRealGameId(gameId)) return res.status(404).json({ error: 'no-game', message: 'Game not found.' });

        const username = (req.body.username || '').toString();
        const account = findAccountByUsername(username);
        if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

        const amount = Number(req.body.amount);
        if (!isFinite(amount) || amount === 0) {
            return res.status(400).json({ error: 'invalid-amount', message: 'amount must be a non-zero number.' });
        }

        const userBalanceInGame = awardPointsToAccount(account, gameId, amount);
        saveAccountsIndex();

        res.json({ success: true, userBalanceInGame, userTotalBalance: account.pointsTotal });
    } catch (err) {
        console.error('Points award error:', err);
        res.status(500).json({ error: 'award-failed', message: 'Something went wrong awarding those points.' });
    }
});

// ---- PointsService:GetGamePointBalance(userId) - total points this player has earned ----
// ---- in one specific game. ----
app.get('/points/:gameId/balance/:username', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const entry = Array.isArray(account.pointsByGame) ? account.pointsByGame.find(p => p.gameId === req.params.gameId) : null;
    res.json({ balance: entry ? entry.amount : 0 });
});

// ---- PointsService:GetPointBalance(userId) - total points this player has earned across ----
// ---- every game, also what's shown on their public profile. ----
app.get('/accounts/:username/points', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    res.json({ balance: account.pointsTotal || 0 });
});

// ---- Every badge a player has created, across all their games (Studio Creations -> ----
// ---- Development Items -> Badges tab). Distinct from GET /accounts/:username/badges ----
// ---- below, which lists badges that player has *earned*, not made. ----
app.get('/accounts/:username/created-badges', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const out = badges
        .filter(b => b.creator.toLowerCase() === account.username.toLowerCase())
        .map(b => publicBadge(b));

    res.json({ badges: out });
});

// Same "only the creator may touch this" gate as requireCatalogItemOwner above, scoped
// to a badge's `creator` field.
function requireBadgeOwner(req, res, badge) {
    const username = (req.body.username || req.query.username || '').toString().trim();
    if (!username || username.toLowerCase() !== (badge.creator || '').toString().trim().toLowerCase()) {
        res.status(403).json({ error: 'not-owner', message: 'Only this badge\'s creator can change it.' });
        return false;
    }
    return true;
}

// ---- Rename a badge (Creations -> badge's "..." settings -> Rename) ----
app.post('/badges/:id/rename', (req, res) => {
    const badge = findBadgeById(req.params.id);
    if (!badge) return res.status(404).json({ error: 'no-badge', message: 'Badge not found.' });
    if (!requireBadgeOwner(req, res, badge)) return;

    const name = (req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'invalid-name', message: 'Name cannot be empty.' });
    badge.name = name.slice(0, 60);

    saveBadgesIndex();
    res.json({ success: true, badge: publicBadge(badge) });
});

// ---- Edit a badge's description (Creations -> badge's "..." settings) ----
app.post('/badges/:id/description', (req, res) => {
    const badge = findBadgeById(req.params.id);
    if (!badge) return res.status(404).json({ error: 'no-badge', message: 'Badge not found.' });
    if (!requireBadgeOwner(req, res, badge)) return;

    const description = (req.body.description || '').toString().trim();
    if (!description) return res.status(400).json({ error: 'invalid-description', message: 'Description cannot be empty.' });
    badge.description = description.slice(0, 1000);

    saveBadgesIndex();
    res.json({ success: true, badge: publicBadge(badge) });
});

// ---- Replace a badge's icon image (Creations -> badge's "..." settings -> Change Image) ----
app.post('/badges/:id/image', badgeIconUpload.single('icon'), (req, res) => {
    const badge = findBadgeById(req.params.id);
    if (!badge) return res.status(404).json({ error: 'no-badge', message: 'Badge not found.' });
    if (!requireBadgeOwner(req, res, badge)) return;

    if (!req.file) return res.status(400).json({ error: 'no-image', message: 'An icon image (PNG or JPG) is required.' });
    const mime = (req.file.mimetype || '').toLowerCase();
    const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
    if (!ALLOWED_MIMES.includes(mime)) {
        return res.status(400).json({ error: 'invalid-file-type', message: 'Badge icons must be a PNG or JPG file.' });
    }

    const imgExt = mime === 'image/png' ? '.png' : '.jpg';
    const filename = `${badge.id}${imgExt}`;
    fs.writeFileSync(path.join(BADGE_UPLOADS_DIR, filename), req.file.buffer);
    badge.iconPath = `${PUBLIC_SERVER_URL}/badges/icon/${filename}`;

    saveBadgesIndex();
    res.json({ success: true, badge: publicBadge(badge) });
});

// ---- Permanently delete a badge (Creations -> badge's "..." settings -> Delete Forever) ----
// Players who already earned this badge keep the awardedAt entry on their account, but
// GET /accounts/:username/badges silently skips it (findBadgeById returns nothing), the
// same way a removed catalog item would disappear from someone's inventory.
app.delete('/badges/:id', (req, res) => {
    const idx = badges.findIndex(b => String(b.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'no-badge', message: 'Badge not found.' });
    const badge = badges[idx];
    if (!requireBadgeOwner(req, res, badge)) return;

    try {
        if (badge.iconPath && badge.iconPath.includes('/badges/icon/')) {
            const filename = badge.iconPath.split('/badges/icon/')[1];
            const filePath = path.join(BADGE_UPLOADS_DIR, filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Failed to remove badge icon on delete:', err);
    }

    badges.splice(idx, 1);
    saveBadgesIndex();
    res.json({ success: true });
});

// ---- Every badge a player has ever earned, newest first (profile page's Badges section) ----
app.get('/accounts/:username/badges', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    if (!Array.isArray(account.badges)) account.badges = [];
    const out = account.badges
        .slice()
        .sort((a, b) => b.awardedAt - a.awardedAt)
        .map(a => {
            const badge = findBadgeById(a.badgeId);
            if (!badge) return null; // badge definition was somehow removed - skip it
            return { ...publicBadge(badge), awardedAt: a.awardedAt };
        })
        .filter(Boolean);

    res.json({ badges: out });
});

// ================= STARTER PLACE =================
// Every new account gets its own default game named "<username>'s Place", the same
// way a brand-new Roblox account starts with a place already in its inventory.
//
// This mirrors exactly what Retroblox Studio itself starts a brand-new project with
// (see the "Baseplate Application" section + the StarterPlayerScripts/CharacterScripts/
// Camera/Terrain setup near the top of editor.html) and what its own "Export .crbx" /
// "Publish" flow serializes (getCrbxData() in editor.html): a single 512x20x512-stud
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
// Private games only show up for their own creator (pass ?username=you), and
// archived games never show up here at all - archived games only ever appear
// under the owner's Studio "Archive" tab (see /accounts/:username/creations).
app.get('/games', (req, res) => {
    const viewer = (req.query.username || '').toString();
    res.json(games
        .filter(g => !g.takenDown && !g.archived)
        .filter(g => !g.isPrivate || canViewPrivateGame(g, viewer))
        .map(publicGame));
});

// ---- Get a single game's metadata ----
app.get('/games/:id', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (g.takenDown && !isAdminUsername(req.query.adminUsername)) {
        return res.status(403).json({ error: 'taken-down', message: g.takedownReason || 'This game has been taken down by an administrator.' });
    }
    if (g.isPrivate && !canViewPrivateGame(g, req.query.username)) {
        return res.status(403).json({ error: 'private', message: 'This game is private.' });
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
    if (g.isPrivate && !canViewPrivateGame(g, req.query.username)) {
        return res.status(403).send('This game is private.');
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

        const uploadOptions = parseUploadOptionsFields(req.body);

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
            takedownReason: '',
            isPrivate: false,
            archived: false,
            archivedAt: null,
            // Studio collaborators: usernames the owner has granted "Shared With Me"
            // access to (invite-only, friends-of-owner only - see POST /games/:id/invite).
            // These accounts can open this game in Studio via ?gameId= and build in it,
            // but every ownership-gated endpoint (edit/content/rename/visibility/archive/
            // delete) still checks g.creator specifically, never this list.
            collaborators: [],
            ...uploadOptions
        };

        games.unshift(game);
        saveGamesIndex();

        res.json({ success: true, id: game.id, game: publicGame(game) });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Upload failed', details: err.message });
    }
});

// ---- Edit a game's name/description/icon (used by the Studio "My Games" tab so a ----
// ---- creator can restyle their game's listing without re-uploading the whole file). ----
app.post('/games/:id/edit', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });

    const creator = (req.body.creator || '').toString().trim();
    if (!creator || creator.toLowerCase() !== (g.creator || '').toString().trim().toLowerCase()) {
        return res.status(403).json({ error: 'not-owner', message: 'Only the creator can edit this game.' });
    }

    if (typeof req.body.name === 'string' && req.body.name.trim()) g.name = req.body.name.toString().slice(0, 100);
    if (typeof req.body.description === 'string') g.description = req.body.description.toString().slice(0, 2000);
    if (typeof req.body.icon === 'string') {
        if (req.body.icon === '') g.icon = null;
        else if (req.body.icon.startsWith('data:image/') && req.body.icon.length <= 1_500_000) g.icon = req.body.icon;
    }

    saveGamesIndex();
    res.json({ success: true, game: publicGame(g) });
});

// ---- Overwrite an existing game's saved content (used by Studio's "My Games" ----
// ---- edit flow: open a previously-uploaded game, make changes, save back to the ----
// ---- same game id instead of always creating a new one via /upload). ----
app.post('/games/:id/content', upload.single('file'), (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });

    const creator = (req.body.creator || '').toString().trim();
    if (!creator || creator.toLowerCase() !== (g.creator || '').toString().trim().toLowerCase()) {
        return res.status(403).json({ error: 'not-owner', message: 'Only the creator can save changes to this game.' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        // Overwrite the same file on disk this game has always used (g.filename was
        // fixed at initial /upload time) rather than writing a new one, so the game's
        // id/filename/likes/createdAt all stay exactly as they were.
        fs.writeFileSync(path.join(UPLOADS_DIR, g.filename), req.file.buffer);

        if (typeof req.body.name === 'string' && req.body.name.trim()) g.name = req.body.name.toString().slice(0, 100);
        if (typeof req.body.description === 'string') g.description = req.body.description.toString().slice(0, 2000);
        if (typeof req.body.icon === 'string') {
            if (req.body.icon === '') g.icon = null;
            else if (req.body.icon.startsWith('data:image/')) g.icon = req.body.icon;
        }
        // Upload Options plugin fields - only present when Studio actually sent them
        // (older cached clients might not), so only overwrite when at least one of
        // them showed up on this request.
        if (req.body.maturityRating !== undefined || req.body.defaultRigType !== undefined ||
            req.body.genre !== undefined || req.body.theme !== undefined ||
            req.body.maxPlayers !== undefined) {
            Object.assign(g, parseUploadOptionsFields(req.body));
        }

        saveGamesIndex();
        res.json({ success: true, game: publicGame(g) });
    } catch (err) {
        console.error('Save content error:', err);
        res.status(500).json({ error: 'Save failed', details: err.message });
    }
});

// Shared owner check for the settings actions below (rename/visibility/archive/
// unarchive/permanent delete) - same case-insensitive creator match /games/:id/edit
// already uses, kept in one place since five endpoints now need it.
function requireOwner(req, res, g) {
    const creator = (req.body.creator || '').toString().trim();
    if (!creator || creator.toLowerCase() !== (g.creator || '').toString().trim().toLowerCase()) {
        res.status(403).json({ error: 'not-owner', message: 'Only the creator can change this game.' });
        return false;
    }
    return true;
}

// ---- Rename a game (Studio "My Games" -> "..." -> Rename) ----
app.post('/games/:id/rename', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (!requireOwner(req, res, g)) return;

    const name = (req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'invalid-name', message: 'Name cannot be empty.' });
    g.name = name.slice(0, 100);

    saveGamesIndex();
    res.json({ success: true, game: publicGame(g) });
});

// ---- Set a game's visibility (Studio "My Games" -> "..." -> Public/Private) ----
// Private means only the creator (or an admin) can see or play it - enforced in
// GET /games, /games/:id, and /games/:id/content above.
app.post('/games/:id/visibility', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (!requireOwner(req, res, g)) return;

    g.isPrivate = !!req.body.isPrivate;

    saveGamesIndex();
    res.json({ success: true, game: publicGame(g) });
});

// ---- Archive a game (Studio "My Games" -> "..." -> Archive) ----
// Archived games drop out of My Games / the public /games list and appear only
// under Archive. They're auto-deleted 7 days after archivedAt by the sweep below.
app.post('/games/:id/archive', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (!requireOwner(req, res, g)) return;

    g.archived = true;
    g.archivedAt = Date.now();

    saveGamesIndex();
    res.json({ success: true, game: publicGame(g) });
});

// ---- Unarchive a game (Archive -> "(Archived) X's Settings" -> Unarchive) ----
// Moves it back to My Games / the public listing (subject to its isPrivate flag).
app.post('/games/:id/unarchive', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (!requireOwner(req, res, g)) return;

    g.archived = false;
    g.archivedAt = null;

    saveGamesIndex();
    res.json({ success: true, game: publicGame(g) });
});

// ---- Permanently delete an archived game (Archive -> "(Archived) X's Settings" ----
// ---- -> Permanently Delete) - removes both the games.json entry and the .crbx ----
// ---- file on disk. Only allowed while the game is archived, same as the 7-day ----
// ---- auto-delete sweep below, so a game always has to pass through Archive first. ----
app.delete('/games/:id', (req, res) => {
    const idx = games.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Game not found' });
    const g = games[idx];
    if (!requireOwner(req, res, g)) return;
    if (!g.archived) {
        return res.status(400).json({ error: 'not-archived', message: 'Only archived games can be permanently deleted.' });
    }

    try {
        const filePath = path.join(UPLOADS_DIR, g.filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        console.error('Failed to remove game file on delete:', err);
    }

    games.splice(idx, 1);
    saveGamesIndex();
    res.json({ success: true });
});

// ================= STUDIO COLLABORATORS ("Shared With Me") =================
// Distinct from the ephemeral studioInvite socket ping (which just notifies someone
// live that a session exists) - these endpoints are what actually grants a user
// persistent access to open and build in someone else's game. Only the game's owner
// can grant/revoke it, and only to accounts already on the owner's friends list.

// ---- Owner invites a friend to collaborate on this game (grants Shared With Me access) ----
app.post('/games/:id/invite', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (!requireOwner(req, res, g)) return;

    const targetUsername = (req.body.username || '').toString().trim();
    if (!targetUsername) return res.status(400).json({ error: 'missing-username', message: 'Missing username.' });
    if (targetUsername.toLowerCase() === g.creator.toLowerCase()) {
        return res.status(400).json({ error: 'cannot-invite-self', message: "You can't invite yourself." });
    }

    const targetAccount = findAccountByUsername(targetUsername);
    if (!targetAccount) return res.status(404).json({ error: 'no-account', message: 'That user does not exist.' });

    // Friends-only: only accounts the owner has actually friended can be invited -
    // this is also what keeps "friends of friends" out, since it's always checked
    // against the OWNER's own friends list, never the invitee's.
    const ownerAccount = findAccountByUsername(g.creator);
    const ownerFriends = (ownerAccount && Array.isArray(ownerAccount.friends)) ? ownerAccount.friends : [];
    const isFriend = ownerFriends.some(f => f.toLowerCase() === targetAccount.username.toLowerCase());
    if (!isFriend) {
        return res.status(403).json({ error: 'not-friends', message: 'You can only invite friends to collaborate.' });
    }

    if (!Array.isArray(g.collaborators)) g.collaborators = [];
    const already = g.collaborators.some(c => c.toLowerCase() === targetAccount.username.toLowerCase());
    if (!already) {
        g.collaborators.push(targetAccount.username);
        saveGamesIndex();
    }

    res.json({ success: true, collaborators: g.collaborators, game: publicGame(g) });
});

// ---- Owner removes a collaborator's access ("take them away" from Shared With Me) ----
// If that person is actively in a live collab session for this game right now, the
// studio_* socket room for it gets a 'collabAccessRevoked' push so their client can
// boot them out immediately (see io.on('connection') studio section below).
app.post('/games/:id/collaborators/:username/remove', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });
    if (!requireOwner(req, res, g)) return;

    const targetUsername = (req.params.username || '').toString().trim();
    if (!Array.isArray(g.collaborators)) g.collaborators = [];
    const before = g.collaborators.length;
    g.collaborators = g.collaborators.filter(c => c.toLowerCase() !== targetUsername.toLowerCase());
    if (g.collaborators.length !== before) saveGamesIndex();

    // Kick any live session(s) tied to this game where the removed user is present.
    revokeCollabAccess(g.id, targetUsername);

    res.json({ success: true, collaborators: g.collaborators });
});

// ---- List every game shared with this account (their "Shared With Me" tab) ----
app.get('/accounts/:username/shared-with-me', (req, res) => {
    const username = (req.params.username || '').toString().trim().toLowerCase();
    if (!username) return res.json([]);
    const shared = games.filter(g =>
        !g.archived &&
        Array.isArray(g.collaborators) &&
        g.collaborators.some(c => (c || '').toLowerCase() === username)
    );
    res.json(shared.map(publicGame));
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
        membershipType: account.membershipType || 'None',
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

// Serve uploaded catalog item images (clothing/faces - written by /catalog/upload
// below) as plain static files, e.g. GET /catalog/image/14.png.
app.use('/catalog/image', express.static(CATALOG_UPLOADS_DIR));

// ---- List every buyable catalog item (Shirts/Pants/T-Shirts/Accessories/Faces) ----
app.get('/catalog', (req, res) => {
    res.json(catalogItems.map(i => publicCatalogItem(i)));
});

// ---- Get one catalog item's full detail (used by the item page) ----
app.get('/catalog/:id', (req, res) => {
    const item = findCatalogItemById(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found', message: 'That catalog item does not exist.' });
    res.json({
        ...publicCatalogItem(item),
        takenDown: !!item.takenDown,
        takedownReason: item.takedownReason || ''
    });
});

// ---- Serve an accessory's raw 3D model data (written by /catalog/upload below). ----
// The trailing "extension" in the URL (e.g. /catalog/model/14.glb) is purely a hint for
// whatever client fetches it (GLTFLoader/OBJLoader/JSON.parse - see itemPath below) -
// this route ignores everything after the leading digits, so /catalog/model/14 and
// /catalog/model/14.glb both resolve to item #14.
app.get('/catalog/model/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = findCatalogItemById(id);
    if (!item || !item.modelData) return res.status(404).send('Model not found.');

    const CONTENT_TYPES = {
        glb: 'model/gltf-binary',
        gltf: 'model/gltf+json',
        obj: 'text/plain; charset=utf-8',
        parts: 'application/json'
    };
    res.set('Content-Type', CONTENT_TYPES[item.modelFormat] || 'application/octet-stream');

    if (item.modelFormat === 'glb') {
        // Stored as base64 text (it's binary data) - decode back to real bytes.
        res.send(Buffer.from(item.modelData, 'base64'));
    } else {
        // gltf/obj/parts are all stored as plain text (JSON or OBJ source).
        res.send(item.modelData);
    }
});

// ---- Upload a new catalog item from the Item Creator plugin (Retroblox Studio) ----
// Shirts/Pants/T-Shirts are open to everyone and are still plain PNG/JPG images. The 8
// accessory kinds + Faces require an admin account; Faces stay images too, but
// accessories are now real 3D models (.glb/.gltf/.obj, or .rbxm/.rbxmx pre-converted to
// a portable "parts" JSON by Studio's own importer before it ever reaches this route -
// see the Item Creator plugin) instead of a flat picture. Costs a flat
// UPLOAD_FEE_ROBUX either way, regardless of the item's own price.
const catalogImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, fieldSize: 20 * 1024 * 1024 } // images stay small; fieldSize covers a base64 model in modelData
});
const MODEL_FORMATS = ['glb', 'gltf', 'obj', 'parts'];
const MAX_MODEL_DATA_CHARS = 15 * 1024 * 1024; // ~15MB of text (base64 GLB, gltf JSON, obj source, or parts JSON)

app.post('/catalog/upload', catalogImageUpload.single('image'), (req, res) => {
    try {
        const account = findAccountByUsername((req.body.username || '').toString());
        if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found. Log in to upload catalog items.' });
        if (liftBanIfExpired(account)) saveAccountsIndex();
        if (account.banned) return res.status(403).json({ error: 'banned', message: 'Banned accounts cannot upload catalog items.' });

        const category = (req.body.category || '').toString().toLowerCase().trim();
        if (!ALL_CATALOG_CATEGORIES.includes(category)) {
            return res.status(400).json({ error: 'invalid-category', message: 'Not a valid catalog category.' });
        }
        const isAdmin = isAdminUsername(account.username);
        if (ADMIN_ONLY_CATEGORIES.includes(category) && !isAdmin) {
            return res.status(403).json({ error: 'admin-only-category', message: 'Only admins can upload accessories or faces.' });
        }
        const isAccessoryUpload = ACCESSORY_CATEGORIES.includes(category);

        const name = (req.body.name || '').toString().trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: 'missing-name', message: 'Give this item a name.' });

        const description = (req.body.description || '').toString().trim().slice(0, 1000);
        if (!description) return res.status(400).json({ error: 'missing-description', message: 'A description is required to upload a catalog item.' });

        const price = Math.round(Number(req.body.price));
        if (!Number.isFinite(price) || price < MIN_ITEM_PRICE || price > MAX_ITEM_PRICE) {
            return res.status(400).json({ error: 'invalid-price', message: `Price must be between ${MIN_ITEM_PRICE} and ${MAX_ITEM_PRICE}.` });
        }

        const currency = (req.body.currency || '').toString().toLowerCase().trim();
        if (currency !== 'robux' && currency !== 'tix') {
            return res.status(400).json({ error: 'invalid-currency', message: 'Currency must be Robux or Tix.' });
        }

        if ((account.robux || 0) < UPLOAD_FEE_ROBUX) {
            return res.status(400).json({ error: 'insufficient-robux', message: `Uploading costs ${UPLOAD_FEE_ROBUX} Robux - you don't have enough.` });
        }

        // Optional: accessory "children" (particle emitters, lights, etc. attached to
        // the item) - admin-only. These get real property schemas matching Studio's
        // actual PointLight/SpotLight/ParticleEmitter objects, since the whole point is
        // that they become real child instances the moment the accessory is equipped,
        // not just descriptive text.
        let children = [];
        if (isAdmin && isAccessoryUpload && typeof req.body.childrenJson === 'string' && req.body.childrenJson) {
            try {
                const parsed = JSON.parse(req.body.childrenJson);
                if (Array.isArray(parsed)) children = parsed.slice(0, 20).map(sanitizeAccessoryChild).filter(Boolean);
            } catch (e) { /* ignore malformed children payload */ }
        }

        // Optional: this accessory's position/size, adjusted on the reference NPC in
        // Studio's Accessory Editor tab. Stored so any client can rebuild the exact same
        // Handle/[Type]Attachment/OriginalPosition/OriginalSize hierarchy on real equip
        // instead of falling back to the generic per-type default offset.
        let originalPosition = null, originalSize = null;
        if (isAccessoryUpload) {
            originalPosition = sanitizeVec3(req.body.originalPosition);
            originalSize = sanitizeVec3(req.body.originalSize);
        }

        const id = nextCatalogItemId++;
        saveCatalogIdCounter();

        let itemPath, modelFormat = null, modelData = null;

        if (isAccessoryUpload) {
            // Accessories: a real 3D model, sent as text (see the Item Creator plugin -
            // .glb becomes a base64 string, .gltf/.obj/.parts are sent as plain text/JSON).
            modelFormat = (req.body.modelFormat || '').toString().toLowerCase().trim();
            if (!MODEL_FORMATS.includes(modelFormat)) {
                return res.status(400).json({ error: 'invalid-model-format', message: 'Accessories need a .glb, .gltf, .obj, .rbxm or .rbxmx model.' });
            }
            modelData = (req.body.modelData || '').toString();
            if (!modelData) {
                return res.status(400).json({ error: 'no-model', message: 'No 3D model was attached to this upload.' });
            }
            if (modelData.length > MAX_MODEL_DATA_CHARS) {
                return res.status(400).json({ error: 'model-too-large', message: 'That model is too large (try keeping it under ~10MB).' });
            }
            if (modelFormat === 'parts') {
                // Sanity-check it's actually valid JSON with a parts array before storing.
                try {
                    const parsed = JSON.parse(modelData);
                    if (!parsed || !Array.isArray(parsed.parts)) throw new Error('missing parts array');
                } catch (e) {
                    return res.status(400).json({ error: 'invalid-model-data', message: 'That .rbxm/.rbxmx file could not be converted to a model.' });
                }
            }
            const ext = modelFormat === 'parts' ? 'json' : modelFormat;
            itemPath = `${PUBLIC_SERVER_URL}/catalog/model/${id}.${ext}`;
        } else {
            // Clothing/Faces: still a plain PNG/JPG image, uploaded as a real file.
            if (!req.file) return res.status(400).json({ error: 'no-image', message: 'An image (PNG or JPG) is required.' });
            const mime = (req.file.mimetype || '').toLowerCase();
            const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
            if (!ALLOWED_MIMES.includes(mime)) {
                return res.status(400).json({ error: 'invalid-file-type', message: 'Catalog images must be a PNG or JPG file.' });
            }
            const imgExt = mime === 'image/png' ? '.png' : '.jpg';
            const filename = `${id}${imgExt}`;
            fs.writeFileSync(path.join(CATALOG_UPLOADS_DIR, filename), req.file.buffer);
            itemPath = `${PUBLIC_SERVER_URL}/catalog/image/${filename}`;
        }

        account.robux = (account.robux || 0) - UPLOAD_FEE_ROBUX;
        saveAccountsIndex();

        const item = {
            id,
            name,
            description,
            category,
            itemPath,
            modelFormat,
            modelData,
            price,
            currency,
            creator: account.username,
            createdAt: Date.now(),
            takenDown: false,
            takedownReason: '',
            forSale: true,
            children,
            originalPosition,
            originalSize
        };
        catalogItems.push(item);
        saveCatalogItemsIndex();

        res.json({ success: true, item: publicCatalogItem(item), robux: account.robux });
    } catch (err) {
        console.error('Catalog upload error:', err);
        res.status(500).json({ error: 'upload-failed', message: 'Something went wrong uploading that item.' });
    }
});

// Same "only the creator may touch this" gate as requireOwner() for games above, just
// scoped to a catalog item's `creator` field instead of a game's.
function requireCatalogItemOwner(req, res, item) {
    const username = (req.body.username || req.query.username || '').toString().trim();
    if (!username || username.toLowerCase() !== (item.creator || '').toString().trim().toLowerCase()) {
        res.status(403).json({ error: 'not-owner', message: 'Only this item\'s creator can change it.' });
        return false;
    }
    return true;
}

// ---- List every catalog item a player has uploaded (Studio Creations -> Development Items) ----
app.get('/accounts/:username/catalog-items', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const items = catalogItems
        .filter(i => i.creator.toLowerCase() === account.username.toLowerCase())
        .map(publicCatalogItem);

    res.json(items);
});

// ---- Rename a catalog item (Creations -> item's "..." settings -> Rename) ----
app.post('/catalog/:id/rename', (req, res) => {
    const item = findCatalogItemById(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found', message: 'That catalog item does not exist.' });
    if (!requireCatalogItemOwner(req, res, item)) return;

    const name = (req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'invalid-name', message: 'Name cannot be empty.' });
    item.name = name.slice(0, 60);

    saveCatalogItemsIndex();
    res.json({ success: true, item: publicCatalogItem(item) });
});

// ---- Change a catalog item's price (Shirts/Pants/T-Shirts/Accessories only) ----
app.post('/catalog/:id/price', (req, res) => {
    const item = findCatalogItemById(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found', message: 'That catalog item does not exist.' });
    if (!requireCatalogItemOwner(req, res, item)) return;

    const price = Math.round(Number(req.body.price));
    if (!Number.isFinite(price) || price < MIN_ITEM_PRICE || price > MAX_ITEM_PRICE) {
        return res.status(400).json({ error: 'invalid-price', message: `Price must be between ${MIN_ITEM_PRICE} and ${MAX_ITEM_PRICE}.` });
    }
    item.price = price;

    saveCatalogItemsIndex();
    res.json({ success: true, item: publicCatalogItem(item) });
});

// ---- Take a catalog item off sale / put it back on sale (Creations -> "..." settings) ----
// Distinct from the admin-only `takenDown` moderation flag above - this is the
// creator's own on/off switch (like real Roblox's "Off Sale"), and unlike takenDown it
// doesn't hide the item from someone who already owns/equipped it, only from the
// catalog listing/purchase flow.
app.post('/catalog/:id/for-sale', (req, res) => {
    const item = findCatalogItemById(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found', message: 'That catalog item does not exist.' });
    if (!requireCatalogItemOwner(req, res, item)) return;

    item.forSale = !!req.body.forSale;

    saveCatalogItemsIndex();
    res.json({ success: true, item: { ...publicCatalogItem(item), forSale: item.forSale } });
});

// ---- Replace a catalog item's image (Shirts/Pants/T-Shirts/Faces only - accessories ----
// ---- are 3D models, not images, so this route rejects those categories). ----
app.post('/catalog/:id/image', catalogImageUpload.single('image'), (req, res) => {
    const item = findCatalogItemById(req.params.id);
    if (!item) return res.status(404).json({ error: 'not-found', message: 'That catalog item does not exist.' });
    if (!requireCatalogItemOwner(req, res, item)) return;
    if (ACCESSORY_CATEGORIES.includes(item.category)) {
        return res.status(400).json({ error: 'not-an-image-item', message: 'Accessories are 3D models and can\'t have their image swapped here.' });
    }

    if (!req.file) return res.status(400).json({ error: 'no-image', message: 'An image (PNG or JPG) is required.' });
    const mime = (req.file.mimetype || '').toLowerCase();
    const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
    if (!ALLOWED_MIMES.includes(mime)) {
        return res.status(400).json({ error: 'invalid-file-type', message: 'Catalog images must be a PNG or JPG file.' });
    }

    const imgExt = mime === 'image/png' ? '.png' : '.jpg';
    const filename = `${item.id}${imgExt}`;
    fs.writeFileSync(path.join(CATALOG_UPLOADS_DIR, filename), req.file.buffer);
    item.itemPath = `${PUBLIC_SERVER_URL}/catalog/image/${filename}`;

    saveCatalogItemsIndex();
    res.json({ success: true, item: publicCatalogItem(item) });
});

// ---- Permanently delete a catalog item (Creations -> "..." settings -> Delete Forever) ----
app.delete('/catalog/:id', (req, res) => {
    const idx = catalogItems.findIndex(i => String(i.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'not-found', message: 'That catalog item does not exist.' });
    const item = catalogItems[idx];
    if (!requireCatalogItemOwner(req, res, item)) return;

    try {
        if (item.itemPath && item.itemPath.includes('/catalog/image/')) {
            const filename = item.itemPath.split('/catalog/image/')[1];
            const filePath = path.join(CATALOG_UPLOADS_DIR, filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Failed to remove catalog item image on delete:', err);
    }

    catalogItems.splice(idx, 1);
    saveCatalogItemsIndex();
    res.json({ success: true });
});

// ================= TOOLBOX ASSETS =================
// Assets uploaded from Retroblox Studio's Explorer right-click menu ("Upload to
// Retroblox..." on a selected Part/Model/etc). Unlike the Catalog above (wearable
// clothing/accessories, admin-gated for most categories, costs Robux), Toolbox assets
// are just plain building-block content - anyone can upload one for free, and every
// uploaded asset immediately shows up for every Studio user in their Toolbox panel,
// ready to insert into any place. This mirrors how Roblox's real Toolbox ("My
// Models"/community models) works, simplified down to "free and open to everyone" per
// how this project's Studio is set up (no per-account moderation queue).
//
// The model itself is stored as our own serializeHierarchy() JSON - the exact same
// shape Studio's Cut/Copy/Paste already round-trips through (see deserializeHierarchy)
// - rather than a real binary .rbxm. That keeps a Toolbox asset 100% lossless when it
// comes back down into another Studio session, at the cost of only being readable by
// this Studio (not real Roblox). Studio's own "Save to File..." offers the same JSON
// wrapped in a ".rbxm" file extension for a local download, for consistency.
const TOOLBOX_ASSETS_FILE = path.join(DATA_DIR, 'toolbox_assets.json');
const TOOLBOX_ID_COUNTER_FILE = path.join(DATA_DIR, 'toolbox_id_counter.json');

let toolboxAssets = [];
try {
    toolboxAssets = JSON.parse(fs.readFileSync(TOOLBOX_ASSETS_FILE, 'utf8'));
    console.log(`[storage] Loaded ${toolboxAssets.length} toolbox asset(s) from ${TOOLBOX_ASSETS_FILE}`);
} catch (e) {
    toolboxAssets = [];
    console.log(`[storage] No existing toolbox_assets.json found at ${TOOLBOX_ASSETS_FILE} (starting empty). Reason: ${e.code || e.message}`);
}
// Backfill fields for assets saved before a field existed
toolboxAssets.forEach(a => {
    if (typeof a.takenDown !== 'boolean') a.takenDown = false;
    if (typeof a.takedownReason !== 'string') a.takedownReason = '';
    if (typeof a.description !== 'string') a.description = '';
});

function saveToolboxAssetsIndex() {
    try {
        fs.writeFileSync(TOOLBOX_ASSETS_FILE, JSON.stringify(toolboxAssets, null, 2));
    } catch (e) {
        console.error('Failed to save toolbox assets index:', e);
    }
}

let nextToolboxAssetId = 1;
try {
    const counterData = JSON.parse(fs.readFileSync(TOOLBOX_ID_COUNTER_FILE, 'utf8'));
    if (typeof counterData.next === 'number' && counterData.next > 0) nextToolboxAssetId = counterData.next;
} catch (e) {
    // No counter file yet - fine, we'll create one below.
}
function saveToolboxIdCounter() {
    try {
        fs.writeFileSync(TOOLBOX_ID_COUNTER_FILE, JSON.stringify({ next: nextToolboxAssetId }));
    } catch (e) {
        console.error('Failed to save toolbox ID counter:', e);
    }
}

function findToolboxAssetById(id) {
    const numId = parseInt(id, 10);
    return toolboxAssets.find(a => a.id === numId);
}

// List view (used by the Toolbox panel's grid) - excludes the (potentially large)
// model JSON itself, same reasoning as publicCatalogItem excluding modelData.
function publicToolboxAsset(a) {
    return {
        id: a.id,
        name: a.name,
        description: a.description,
        creator: a.creator,
        createdAt: a.createdAt,
        thumbnail: a.thumbnail || null
    };
}

const MAX_TOOLBOX_MODEL_CHARS = 15 * 1024 * 1024; // ~15MB of JSON - generous for a hand-built model

// ---- List every Toolbox asset (open to anyone, no login/ownership filter) ----
app.get('/toolbox/assets', (req, res) => {
    res.json(toolboxAssets.filter(a => !a.takenDown).map(publicToolboxAsset));
});

// ---- Get one Toolbox asset's full model data (used when the user clicks it in the ----
// ---- Toolbox panel to actually insert it into their place). ----
app.get('/toolbox/assets/:id', (req, res) => {
    const asset = findToolboxAssetById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'not-found', message: 'That asset does not exist.' });
    if (asset.takenDown) return res.status(403).json({ error: 'taken-down', message: asset.takedownReason || 'This asset has been taken down.' });
    res.json({
        id: asset.id,
        name: asset.name,
        description: asset.description,
        creator: asset.creator,
        createdAt: asset.createdAt,
        model: asset.model
    });
});

// ---- Upload a new asset from Retroblox Studio's Explorer right-click menu ----
// ("Upload to Retroblox..."). Open to anyone - no account, fee, or admin check, unlike
// the Catalog above. `model` is the JSON produced by Studio's own serializeHierarchy().
app.post('/toolbox/upload', (req, res) => {
    try {
        const name = (req.body.name || '').toString().trim().slice(0, 60) || 'Untitled Asset';
        const description = (req.body.description || '').toString().trim().slice(0, 1000);
        const creator = (req.body.creator || '').toString().trim().slice(0, 60) || 'Guest';

        const model = req.body.model;
        if (!model || typeof model !== 'object') {
            return res.status(400).json({ error: 'no-model', message: 'No model data was included in this upload.' });
        }
        const modelStr = JSON.stringify(model);
        if (modelStr.length > MAX_TOOLBOX_MODEL_CHARS) {
            return res.status(400).json({ error: 'model-too-large', message: 'That selection is too large to upload (try uploading a smaller piece of it).' });
        }

        const thumbnail = (typeof req.body.thumbnail === 'string' && req.body.thumbnail.startsWith('data:'))
            ? req.body.thumbnail
            : null;

        const id = nextToolboxAssetId++;
        saveToolboxIdCounter();

        const asset = {
            id,
            name,
            description,
            creator,
            model,
            thumbnail,
            createdAt: Date.now(),
            takenDown: false,
            takedownReason: ''
        };
        toolboxAssets.push(asset);
        saveToolboxAssetsIndex();

        res.json({ success: true, id: asset.id, asset: publicToolboxAsset(asset) });
    } catch (err) {
        console.error('Toolbox upload error:', err);
        res.status(500).json({ error: 'upload-failed', message: 'Something went wrong uploading that asset.' });
    }
});

// ---- List a specific account's own Toolbox uploads (Studio Creations -> Development ----
// ---- Items -> Models/Packages) - distinct from GET /toolbox/assets above, which is ----
// ---- the global, everyone's-assets Toolbox panel list. ----
app.get('/accounts/:username/toolbox-assets', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const assets = toolboxAssets
        .filter(a => a.creator.toLowerCase() === account.username.toLowerCase() && !a.takenDown)
        .map(publicToolboxAsset);

    res.json(assets);
});

// ================= INVENTORY =================

// ---- Get a player's owned catalog items ----
app.get('/accounts/:username/inventory', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (!Array.isArray(account.inventory)) account.inventory = [];
    res.json({ inventory: account.inventory });
});

// ---- Buy a catalog item with Robux or Tix (whichever currency it's priced in). ----
// ---- If it was uploaded by a real player, that player is paid the full sale price. ----
app.post('/accounts/:username/inventory/buy', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });
    if (liftBanIfExpired(account)) saveAccountsIndex();
    if (account.banned) return res.status(403).json({ error: 'banned', message: 'Banned accounts cannot make purchases.' });

    const itemPath = (req.body.itemPath || '').toString();
    const item = findCatalogItem(itemPath);
    if (!item) return res.status(400).json({ error: 'invalid-item', message: 'That item is not in the catalog.' });
    if (item.takenDown) {
        return res.status(403).json({ error: 'taken-down', message: item.takedownReason || 'This item has been taken down by an administrator.' });
    }

    if (!Array.isArray(account.inventory)) account.inventory = [];
    if (account.inventory.includes(itemPath)) {
        return res.json({ success: true, status: 'already-owned', tix: account.tix, robux: account.robux, inventory: account.inventory });
    }

    const currencyField = item.currency === 'robux' ? 'robux' : 'tix';
    const label = currencyField === 'robux' ? 'Robux' : 'Tix';
    if ((account[currencyField] || 0) < item.price) {
        return res.status(400).json({ error: `insufficient-${currencyField}`, message: `You need ${item.price} ${label} to buy this item.` });
    }

    account[currencyField] -= item.price;
    account.inventory.push(itemPath);

    // Pay the creator, unless it's a system item (the original RETROBLOX-uploaded faces).
    const creatorAccount = findAccountByUsername(item.creator);
    if (creatorAccount) {
        creatorAccount[currencyField] = (creatorAccount[currencyField] || 0) + item.price;
    }

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
        pointsTotal: account.pointsTotal || 0,
        membershipType: account.membershipType || 'None',
        relationship
    });
});

// ---- List every game a player has created/published (for the Creations section) ----
// By default this returns only non-archived games (what Studio's "My Games" tab
// shows) - pass ?archived=true to get the Archive tab's list instead. A game is
// never in both lists at once (see the .archived filter below), matching "archived
// games appear in the archive tab" / "unarchive... makes it go back into My Games".
app.get('/accounts/:username/creations', (req, res) => {
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const showTakenDown = isAdminUsername(req.query.adminUsername);
    const wantArchived = req.query.archived === 'true';
    const creations = games
        .filter(g => g.creator.toLowerCase() === account.username.toLowerCase() && (showTakenDown || !g.takenDown))
        .filter(g => !!g.archived === wantArchived)
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

    // Only a genuinely NEW follow (not a repeat call on someone already followed)
    // counts as "new" for the purposes of notifying the target live - matches
    // BadgeService.AwardBadge/friendRequestReceived's own already-have guards just
    // below/above this endpoint.
    const isNewFollow = !target.followers.some(u => u.toLowerCase() === follower.username.toLowerCase());

    if (isNewFollow) {
        target.followers.push(follower.username);
    }
    if (!follower.following.some(u => u.toLowerCase() === target.username.toLowerCase())) {
        follower.following.push(target.username);
    }

    saveAccountsIndex();

    // Push the new-follower toast live if the target currently has the site/game
    // open - same sitePresence lookup + io.to(socketId).emit(...) shape as
    // friendRequestReceived/friendRequestAccepted above. NotificationScript2.lua's
    // RobloxReplicatedStorage:WaitForChild('NewFollower').OnClientEvent listens for
    // exactly this event (relayed into Lua by editor.html's socket handling), and
    // expects a Player-shaped table with Name/userId - not just a bare username.
    if (isNewFollow) {
        const targetPresence = sitePresence[target.username.toLowerCase()];
        if (targetPresence) {
            io.to(targetPresence.socketId).emit('newFollower', {
                username: follower.username,
                userId: follower.playerId,
                avatarImage: follower.avatarImage || null,
                at: Date.now()
            });
        }
    }

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

// ---- List every catalog item for the admin catalog panel ----
app.get('/admin/catalog', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(catalogItems.map(i => publicCatalogItem(i)));
});

// ---- Permanently delete a catalog item: removes the catalog record, its on-disk ----
// ---- image file (accessories store their model data inline in the JSON, so there's ----
// ---- no file for those), and unequips it from every account that currently has it ----
// ---- on - otherwise anyone wearing a deleted item is left with a dangling reference ----
// ---- that fails to load (the classic "stuck all-white" bug), fixable only by manually ----
// ---- re-equipping something else. Ownership entries in inventories are left alone so ----
// ---- purchase history isn't erased, but the item can never be equipped again since it's gone.
app.post('/admin/catalog/:id/delete', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const itemIndex = catalogItems.findIndex(i => String(i.id) === String(req.params.id));
    if (itemIndex === -1) return res.status(404).json({ error: 'not-found', message: 'Catalog item not found.' });
    const item = catalogItems[itemIndex];
    const itemPath = item.itemPath;

    // Remove the on-disk image file for clothing/face items. Accessory (3D model)
    // items keep their data inline in catalog_items.json, not as a separate file.
    if (itemPath && itemPath.includes('/catalog/image/')) {
        const filename = itemPath.split('/catalog/image/')[1];
        if (filename && !filename.includes('..') && !filename.includes('/')) {
            const filePath = path.join(CATALOG_UPLOADS_DIR, filename);
            fs.unlink(filePath, err => {
                if (err && err.code !== 'ENOENT') console.error('Failed to delete catalog image file:', err);
            });
        }
    }

    catalogItems.splice(itemIndex, 1);
    saveCatalogItemsIndex();

    // Unequip this item from anyone currently wearing it.
    let accountsChanged = false;
    accounts.forEach(a => {
        if (!a.appearance || typeof a.appearance !== 'object') return;
        APPEARANCE_SLOTS.forEach(slot => {
            if (a.appearance[slot] === itemPath) {
                a.appearance[slot] = null;
                accountsChanged = true;
            }
        });
    });
    if (accountsChanged) saveAccountsIndex();

    res.json({ success: true, deletedId: item.id });
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

// ---- Set a player's MembershipType (None/BuildersClub/TurboBuildersClub/ ----
// ---- OutrageousBuildersClub) - shows their tier icon next to their name in-game ----
// ---- (Topbar/profile) and drives PlayerlistModule's real membershipType branch. ----
// ---- Admins can set this on any account, including their own. ----
app.post('/admin/players/:username/membership', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const account = findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: 'no-account', message: 'Account not found.' });

    const membershipType = (req.body.membershipType || '').toString();
    if (!MEMBERSHIP_TYPES.includes(membershipType)) {
        return res.status(400).json({ error: 'invalid-membership-type', message: `membershipType must be one of: ${MEMBERSHIP_TYPES.join(', ')}` });
    }

    account.membershipType = membershipType;
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
    for (const room in gameStates) {
        const players = gameStates[room];
        for (const socketId in players) {
            if ((players[socketId].name || '').toLowerCase() === lower) {
                // Strip the "#N" instance suffix (if any) to get back the base
                // gameId a friend's "Join Game" button should actually use -
                // joinGame() will route them into a real (possibly different,
                // if theirs has since filled up) instance of the same game.
                const hashIdx = room.indexOf(INSTANCE_SEP);
                const gameId = hashIdx === -1 ? room : room.slice(0, hashIdx);
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

// ================= REAL SERVER INSTANCING =================
// A published game can be played by more people than its Max Players setting
// allows in one room, so instead of one room per gameId, each gameId now maps
// to however many actual server instances are currently needed. Instances are
// created on demand (the moment someone needs one and every existing instance
// is full) and destroyed the moment they empty out - there's no fixed count to
// configure anymore, matching real Roblox's "servers spin up/down with demand"
// behavior instead of a creator-picked number of always-on placeholder rooms.
//
// Room naming: a real published game's socket.io room for instance N of gameId
// "abc123" is "abc123#N" (gameStates key matches). Non-game rooms - Studio
// collab sessions ("studio_<id>") and anything else that isn't a real games[]
// entry - are exempt from instancing entirely and keep using the gameId as-is
// for a single shared room, since those aren't public game listings with a
// Max Players setting to enforce.
const INSTANCE_SEP = '#';

function isRealGameId(gameId) {
    return games.some(g => g.id === gameId);
}

function maxPlayersForGame(gameId) {
    const g = games.find(x => x.id === gameId);
    return (g && g.maxPlayers) || 10;
}

// Every live instance room name for a base gameId, e.g. "abc123#1", "abc123#2".
function instanceRoomsFor(gameId) {
    const prefix = gameId + INSTANCE_SEP;
    return Object.keys(gameStates).filter(room => room.startsWith(prefix));
}

// Finds an existing instance with room to spare, or creates the next-numbered
// one if every existing instance is full (or none exist yet) - this is the
// "just make a new server if one gets full" behavior, with no upper limit on
// how many instances can exist.
function findOrCreateInstance(gameId) {
    const cap = maxPlayersForGame(gameId);
    const rooms = instanceRoomsFor(gameId);
    for (const room of rooms) {
        if (Object.keys(gameStates[room]).length < cap) return room;
    }
    // Every instance is full (or there are none yet) - number the new one
    // one higher than the current max instance number in use.
    let maxN = 0;
    rooms.forEach(room => {
        const n = parseInt(room.slice(gameId.length + 1), 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
    });
    const newRoom = gameId + INSTANCE_SEP + (maxN + 1);
    gameStates[newRoom] = {};
    return newRoom;
}

// A room is torn down the instant it empties, so instance numbers don't pile
// up forever and a later /games/:id/instances call only ever lists rooms that
// really have someone in them.
function destroyRoomIfEmpty(room) {
    if (gameStates[room] && Object.keys(gameStates[room]).length === 0) {
        delete gameStates[room];
    }
}

// GET /games/:id/instances - live instance list for the real "Join Server" UI
// on the game page: one entry per currently-running instance, each with its
// real current player count out of the game's real Max Players cap. An empty
// array just means nobody's playing yet (the first joiner spins up instance 1).
app.get('/games/:id/instances', (req, res) => {
    const g = games.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found' });

    const cap = g.maxPlayers || 10;
    const instances = instanceRoomsFor(g.id).map(room => {
        const n = parseInt(room.slice(g.id.length + 1), 10);
        const count = Object.keys(gameStates[room]).length;
        return { instance: n, players: count, maxPlayers: cap, full: count >= cap };
    }).sort((a, b) => a.instance - b.instance);

    res.json({ gameId: g.id, maxPlayers: cap, instances });
});

io.on('connection', (socket) => {
    // ---- Site presence: client emits this once on connect (and again after a ----
    // ---- reconnect) so friends can be shown "online" even outside a game.    ----
    socket.on('sitePresence', (data) => {
        const username = data && data.username;
        if (!username) return;
        socket.data.presenceUsername = username;
        sitePresence[username.toLowerCase()] = { socketId: socket.id, username, lastSeen: Date.now() };
    });

    // `gameId` is the base game id (e.g. from game.serverId), same as before -
    // callers don't need to know or pick an instance number. If the client
    // wants a SPECIFIC instance (e.g. clicking "Join" on a particular server
    // row, or following a friend into their exact instance), it can instead
    // pass `instance` alongside `gameId` and we'll join that one directly
    // (still subject to its cap - if it's full/gone this falls back to
    // findOrCreateInstance same as a plain join).
    socket.on('joinGame', ({ gameId, instance, userData }) => {
        const account = findAccountByUsername((userData && userData.username) || '');
        if (account && liftBanIfExpired(account)) saveAccountsIndex();
        if (account && account.banned) {
            socket.emit('banned', { reason: account.banReason || 'You have been banned.' });
            return;
        }

        // Defensive cleanup: a client is expected to emit 'leaveGame' before joining a
        // different game, but if that ever gets skipped - a missed navigation event, a
        // race on reconnect, a page that jumps straight from one game to the next - this
        // socket would otherwise stay registered as a "ghost" player in its OLD game
        // room forever, inflating that game's player count and leaving a stuck character
        // other players can still see. A socket can only ever really be playing one game
        // at a time, so force-leave every other game room before joining this one.
        Array.from(socket.rooms).forEach(room => {
            if (room !== gameId && gameStates[room] && gameStates[room][socket.id]) {
                delete gameStates[room][socket.id];
                socket.leave(room);
                socket.to(room).emit('playerLeft', socket.id);
                destroyRoomIfEmpty(room);
            }
        });

        // Real published games get routed to a real instance room; anything
        // else (Studio collab sessions, etc.) keeps the old single-room behavior.
        let room = gameId;
        if (isRealGameId(gameId)) {
            const cap = maxPlayersForGame(gameId);
            if (typeof instance === 'number' && gameStates[gameId + INSTANCE_SEP + instance] &&
                Object.keys(gameStates[gameId + INSTANCE_SEP + instance]).length < cap) {
                room = gameId + INSTANCE_SEP + instance;
            } else {
                room = findOrCreateInstance(gameId);
            }
        }

        socket.join(room);
        socket.data.gameRoom = room;
        if (!gameStates[room]) gameStates[room] = {};

        gameStates[room][socket.id] = {
            id: socket.id,
            name: userData.username || "Guest",
            appearance: userData.appearance || {},
            avatarImage: userData.avatarImage || null,
            position: { x: 0, y: 5, z: 0 },
            rotation: { y: 0 },
            health: 100
        };

        socket.to(room).emit('playerJoined', gameStates[room][socket.id]);
        // Tell the joiner which real room/instance it actually landed in, so a
        // client that cares (e.g. to show "Server 2" in its own UI) can - this
        // is new info the old flat-gameId flow never needed to send back.
        socket.emit('currentPlayers', gameStates[room]);
        socket.emit('joinedInstance', { gameId, room, instance: room.includes(INSTANCE_SEP) ? parseInt(room.slice(gameId.length + 1), 10) : null });
        updateGlobalCounts();
    });

socket.on('updateState', (data) => {
        const room = Array.from(socket.rooms).find(r => gameStates[r]);
        if (room && gameStates[room] && gameStates[room][socket.id]) {
            Object.assign(gameStates[room][socket.id], data);
            socket.to(room).emit('peerUpdate', { id: socket.id, ...data });
        }
    });

    // ---- Appearance changed mid-session (e.g. player swaps a hat/shirt while playing) ----
    socket.on('updateAppearance', (appearance) => {
        const room = Array.from(socket.rooms).find(r => gameStates[r]);
        if (room && gameStates[room] && gameStates[room][socket.id]) {
            gameStates[room][socket.id].appearance = appearance;
            socket.to(room).emit('peerAppearance', { id: socket.id, appearance });
        }
    });

// ---- Chat: relay a message to everyone else in the same game room ----
    socket.on('chatMessage', (message) => {
        const room = Array.from(socket.rooms).find(r => gameStates[r]);
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
                destroyRoomIfEmpty(room);
            }
        });
        updateGlobalCounts();
    }
});

// Aggregates every live instance room back up to its base gameId (e.g.
// "abc123#1" + "abc123#2" both count toward "abc123") so existing consumers
// of 'playerCounts' - the game-card player counts on the Home/Discover pages -
// keep working unchanged and show the TRUE total across every real instance,
// not just one room's worth. studio_* and other non-instanced rooms report
// under their own room name exactly as before.
function updateGlobalCounts() {
    const counts = {};
    for (const room in gameStates) {
        const hashIdx = room.indexOf(INSTANCE_SEP);
        const baseId = hashIdx === -1 ? room : room.slice(0, hashIdx);
        const key = hashIdx === -1 ? room : 'game_' + baseId;
        counts[key] = (counts[key] || 0) + Object.keys(gameStates[room]).length;
    }
    io.emit('playerCounts', counts);
}

// ================= STUDIO COLLABORATION (multiplayer editing + shared playtest) =================
// A "studio session" is an ad-hoc room formed the moment someone opens the Multiplayer
// plugin tab in Studio. Anyone invited who joins becomes part of studioRosters[sessionId].
// Pressing Play broadcasts to the room so everyone enters play mode together, reusing the
// exact same joinGame/updateState/etc events as the live game player (gameId = "studio_"+sessionId).
//
// Scene sync: the FIRST person to join a session is treated as the host (whoever's
// editor already has the real place data loaded, i.e. the game's owner - the person
// who owns the "Invite Friends" panel in the first place). When anyone else joins, we
// ask the host for its current scene (studioSceneRequest -> host replies studioSceneData)
// and relay that straight to the joiner, rather than the joiner starting from a blank
// default scene. From then on, every edit either side makes is broadcast to the room
// live via studioSceneEdit so both editors' 3D views stay in sync.
const studioRosters = {}; // sessionId -> { [socketId]: { username } }
const studioSessionGame = {}; // sessionId -> real gameId this session is editing (if any)
const studioSessionHost = {}; // sessionId -> socketId of the current host (first joiner / owner)

// Called by POST /games/:id/collaborators/:username/remove above - finds any live
// studio session(s) editing this game where the removed user is present and boots
// them out immediately, per the owner's expectation that removal is instant.
function revokeCollabAccess(gameId, username) {
    const u = (username || '').toLowerCase();
    Object.keys(studioSessionGame).forEach(sessionId => {
        if (studioSessionGame[sessionId] !== gameId) return;
        const roster = studioRosters[sessionId];
        if (!roster) return;
        Object.keys(roster).forEach(socketId => {
            if ((roster[socketId].username || '').toLowerCase() === u) {
                io.to(socketId).emit('collabAccessRevoked', { gameId });
            }
        });
    });
}

io.on('connection', (socket) => {
    // ---- Invite a friend to collaborate. Delivered live if they have the site open; ----
    // ---- otherwise this is a no-op (studio invites are ephemeral, not persisted DMs). ----
    // NOTE: this only pushes the live chat-bubble notification - it does NOT grant access.
    // Actually granting "Shared With Me" access happens via POST /games/:id/invite, which
    // the client calls alongside this (see editor.html's invite() function) and which
    // enforces owner-only + friends-only server-side regardless of what this event is sent.
    socket.on('studioInvite', ({ from, to, sessionId, placeName }) => {
        if (!from || !to || !sessionId) return;
        const recipientPresence = sitePresence[to.toLowerCase()];
        if (recipientPresence) {
            io.to(recipientPresence.socketId).emit('studioInviteReceived', {
                from, sessionId, placeName: placeName || 'Untitled Game', at: Date.now()
            });
        }
    });

    socket.on('studioJoinSession', ({ sessionId, username, gameId }) => {
        if (!sessionId || !username) return;
        const room = 'studio_' + sessionId;
        const isFirstInRoom = !studioRosters[sessionId] || Object.keys(studioRosters[sessionId]).length === 0;
        socket.join(room);
        socket.data.studioSessionId = sessionId;
        socket.data.studioUsername = username;

        if (!studioRosters[sessionId]) studioRosters[sessionId] = {};
        studioRosters[sessionId][socket.id] = { username };

        // Remember which real game this session belongs to (sent by whichever side
        // actually has one open via ?gameId= - a from-scratch/unpublished place has
        // none, which is fine, scene sync still works, there's just no revoke target).
        if (gameId) studioSessionGame[sessionId] = gameId;

        if (isFirstInRoom) {
            studioSessionHost[sessionId] = socket.id;
        } else {
            // Ask whoever's currently hosting to hand this joiner its live scene. The
            // host may have changed since studioSessionHost was first set (original
            // host left) - fall back to just re-electing whoever's left if it's stale.
            let hostId = studioSessionHost[sessionId];
            if (!hostId || !studioRosters[sessionId][hostId]) {
                hostId = Object.keys(studioRosters[sessionId]).find(id => id !== socket.id);
                studioSessionHost[sessionId] = hostId;
            }
            if (hostId) io.to(hostId).emit('studioSceneRequest', { forSocketId: socket.id });
        }

        io.to(room).emit('studioRoster', studioRosters[sessionId]);
    });

    // ---- Host relays its current place data to a specific newly-joined socket. ----
    // Sent in response to studioSceneRequest above; routed point-to-point (not
    // broadcast to the room) since only the requesting joiner needs it.
    socket.on('studioSceneData', ({ forSocketId, data }) => {
        if (!forSocketId || !data) return;
        io.to(forSocketId).emit('studioSceneData', { data });
    });

    // ---- Live edit broadcast: any block add/move/delete/property change, or non-3D ----
    // ---- item change, made while NOT in Play mode. Relayed to everyone else in the ----
    // ---- session so both/all editors' scenes stay in sync in real time. ----
    socket.on('studioSceneEdit', (edit) => {
        const sessionId = socket.data && socket.data.studioSessionId;
        if (!sessionId || !edit) return;
        socket.to('studio_' + sessionId).emit('studioSceneEdit', edit);
    });

    // ---- Edit-mode presence ("flying heads"): where each collaborator's camera is ----
    // ---- while building, separate from the Play-mode character position updates ----
    // ---- (joinGame/updateState) which only apply once everyone's actually playing. ----
    socket.on('studioEditPresence', (data) => {
        const sessionId = socket.data && socket.data.studioSessionId;
        if (!sessionId) return;
        socket.to('studio_' + sessionId).emit('studioEditPresence', { id: socket.id, ...data });
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
            // Tell everyone left in the room this socket's "flying head" should
            // disappear, mirroring how playerLeft works for Play-mode characters.
            socket.to(room).emit('studioEditPresenceLeft', { id: socket.id });
            if (Object.keys(studioRosters[sessionId]).length === 0) {
                delete studioRosters[sessionId];
                delete studioSessionGame[sessionId];
                delete studioSessionHost[sessionId];
            } else {
                if (studioSessionHost[sessionId] === socket.id) {
                    // Host left - hand hosting to whoever's left so late joiners
                    // still get a scene to sync from.
                    studioSessionHost[sessionId] = Object.keys(studioRosters[sessionId])[0];
                }
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

// Archive-expiry sweep: every minute, permanently delete any game that's been
// archived for 7+ days - same "automatically" pattern as the ban-expiry sweep
// above, so this doesn't depend on the owner ever reopening the Archive tab.
const ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
setInterval(() => {
    const cutoff = Date.now() - ARCHIVE_RETENTION_MS;
    const expired = games.filter(g => g.archived && g.archivedAt && g.archivedAt <= cutoff);
    if (expired.length === 0) return;

    expired.forEach(g => {
        try {
            const filePath = path.join(UPLOADS_DIR, g.filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
            console.error('Failed to remove expired archived game file:', err);
        }
    });
    games = games.filter(g => !(g.archived && g.archivedAt && g.archivedAt <= cutoff));
    saveGamesIndex();
    console.log(`[archive-sweep] Permanently deleted ${expired.length} game(s) archived 7+ days ago.`);
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
