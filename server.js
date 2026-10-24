const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ── World & Physics Constants (100% matched to client) ─────────────────────
const WORLD = 7200;
const OUTER_FOOD = 700;
const CENTER_FOOD = 120;
const CENTER_RADIUS = 680;
const KNOCK = 44;
const BOT_COUNT = 14;
const TICK_MS = 50; // 20 Hz tick rate for responsive, smooth gameplay
const FRAMES_PER_TICK = TICK_MS / 16.6667; // ~3.0 frames per tick

// Player base speed is 2.3 px/frame at 60fps = 138 px/sec = 6.9 px per 50ms tick
const PLAYER_BASE_PX_TICK = 2.3 * FRAMES_PER_TICK; 
// Player dash speed is 10.5 px/frame = 630 px/sec = 31.5 px per 50ms tick
const PLAYER_DASH_PX_TICK = 10.5 * FRAMES_PER_TICK;
const DASH_DURATION_MS = 220;
const DASH_COOLDOWN_MS = 1400;
const VEL_FRICTION = 0.91;
const CENTER_DOT_PER_SEC = 7;
const REGEN_DELAY = 7000;
const REGEN_RATE_PER_SEC = 1.25;

// ── Bot Personalities & Build Paths ────────────────────────────────────────
const BOT_PROFILES = [
  { color: '#ff3366', aggroRange: 550, fleeThreshold: 0.20, dashAggro: 0.85, pref: 'hunt' },
  { color: '#00e5ff', aggroRange: 500, fleeThreshold: 0.45, dashAggro: 0.70, pref: 'kite' },
  { color: '#ffd166', aggroRange: 420, fleeThreshold: 0.15, dashAggro: 0.60, pref: 'tank' },
  { color: '#00ff88', aggroRange: 380, fleeThreshold: 0.40, dashAggro: 0.50, pref: 'farm' },
  { color: '#b388ff', aggroRange: 600, fleeThreshold: 0.35, dashAggro: 0.90, pref: 'snipe' },
  { color: '#ff7733', aggroRange: 520, fleeThreshold: 0.22, dashAggro: 0.80, pref: 'hunt' },
  { color: '#ff5522', aggroRange: 480, fleeThreshold: 0.30, dashAggro: 0.85, pref: 'rush' },
  { color: '#ff2a55', aggroRange: 460, fleeThreshold: 0.28, dashAggro: 0.75, pref: 'vamp' }
];

// Names and builds are deliberately independent of personality. Every bot gets a
// unique, player-like name and makes its own random upgrade choices.
const BOT_NAME_STARTS = ['Neon', 'Solar', 'Turbo', 'Cosmic', 'Frost', 'Pixel', 'Iron', 'Lunar', 'Nova', 'Shadow', 'Thunder', 'Crystal', 'Rocket', 'Blazing', 'Phantom'];
const BOT_NAME_ACTIONS = ['Runner', 'Dasher', 'Hunter', 'Drifter', 'Striker', 'Chaser', 'Raider', 'Rider', 'Jumper', 'Spinner', 'Breaker', 'Seeker', 'Blaster', 'Sneaker', 'Wanderer'];
const BOT_UPGRADE_DEFS = [
  ['power', 3], ['execute', 2, 3, ['power']], ['berserk', 2, 6, ['execute']], ['reaper', 1, 10, ['berserk']],
  ['swift', 3], ['afterburn', 4, 3, ['swift']], ['adrenaline', 1, 3, ['swift']], ['fury', 3, 6, null, ['afterburn', 'adrenaline']], ['shockwave', 1, 10, ['fury']],
  ['bulk', 3], ['vitality', 3], ['armor', 2, 3, ['bulk']], ['shield', 3, 6, ['vitality']], ['fortress', 1, 10, ['shield']],
  ['magnet', 3], ['feast', 3, 3, ['magnet']], ['snack', 3, 6, ['feast']], ['glutton', 1, 10, ['snack']],
  ['lifesteal', 3], ['regen', 2], ['bloodthirst', 2, 3, ['regen']], ['vampire', 1, 10, ['bloodthirst']],
  ['juggernaut', 1, 5, ['bulk', 'power'], null, true], ['killRush', 1, 5, ['execute', 'swift'], null, true], ['shieldBlast', 1, 5, ['shield', 'power'], null, true]
].map(([id, maxStack, minLevel = 1, requires = [], requiresAny = [], combo = false]) => ({ id, maxStack, minLevel, requires: requires || [], requiresAny: requiresAny || [], combo }));
const BOT_UPGRADE_BY_ID = Object.fromEntries(BOT_UPGRADE_DEFS.map(u => [u.id, u]));

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeFood() {
  const rngA = mulberry32(42), arr = [];
  for (let i = 0; i < OUTER_FOOD; i++) {
    arr.push({ x: rngA() * WORLD, y: rngA() * WORLD, eaten: false, big: false });
  }
  const rngB = mulberry32(777), cx = WORLD / 2, cy = WORLD / 2;
  for (let i = 0; i < CENTER_FOOD; i++) {
    const ang = rngB() * Math.PI * 2, rad = Math.sqrt(rngB()) * CENTER_RADIUS;
    arr.push({ x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, eaten: false, big: true });
  }
  return arr;
}

function levelFromXp(xp) {
  let lvl = 1, needed = 0, step = 130;
  while (xp >= needed + step) { needed += step; lvl++; step += 45; }
  return lvl;
}

function xpForLevel(lvl) {
  let needed = 0, step = 130;
  for (let l = 1; l < lvl; l++) {
    needed += step;
    step += 45;
  }
  return needed;
}

function radiusFromLevel(lv, bulk = 0) {
  return (16 + lv * 2.4) * (1 + (bulk || 0));
}

function applyLegacyBotUpgrades(b) {
  const path = b.profile.path;
  const ups = {};
  const lvl = b.level;

  if (path === 'Damage') {
    // Tier 1: Power (max 3)
    ups.power = Math.min(3, Math.max(1, Math.floor(lvl / 1.5)));
    // Tier 2: Execute (max 2, minLvl 3)
    if (lvl >= 3) ups.execute = Math.min(2, Math.max(1, lvl - 2));
    // Tier 3: Berserk (max 2, minLvl 6)
    if (lvl >= 6) ups.berserk = Math.min(2, Math.max(1, lvl - 5));
    // Complementary traits: Vitality & Swift for high levels
    if (lvl >= 5) ups.vitality = Math.min(2, Math.floor((lvl - 3) / 2));
    if (lvl >= 7) ups.swift = Math.min(2, Math.floor((lvl - 5) / 2));
    // Tier 4: Reaper (minLvl 10)
    if (lvl >= 10) ups.reaper = 1;
  } else if (path === 'Speed') {
    // Tier 1: Swift (max 3)
    ups.swift = Math.min(3, Math.max(1, Math.floor(lvl / 1.5)));
    // Tier 2: Afterburn (max 4, minLvl 3)
    if (lvl >= 3) ups.afterburn = Math.min(4, Math.max(1, lvl - 2));
    if (lvl >= 4) ups.adrenaline = 1;
    // Tier 3: Fury (max 3, minLvl 6)
    if (lvl >= 6) ups.fury = Math.min(3, Math.max(1, lvl - 5));
    // Complementary: Power for high levels
    if (lvl >= 5) ups.power = Math.min(2, Math.floor((lvl - 3) / 2));
    // Tier 4: Shockwave (minLvl 10)
    if (lvl >= 10) ups.shockwave = 1;
  } else if (path === 'Tank') {
    // Tier 1: Bulk (max 3)
    ups.bulk = Math.min(3, Math.max(1, Math.floor(lvl / 1.5)));
    // Tier 2: Vitality (max 3, minLvl 3), Armor (max 2, minLvl 3)
    if (lvl >= 3) ups.vitality = Math.min(3, Math.max(1, Math.floor((lvl - 1) / 1.5)));
    if (lvl >= 4) ups.armor = Math.min(2, Math.max(1, lvl - 3));
    // Tier 3: Shield (max 3, minLvl 6)
    if (lvl >= 6) ups.shield = Math.min(3, Math.max(1, lvl - 5));
    // Complementary: Regen
    if (lvl >= 7) ups.regen = Math.min(2, Math.floor((lvl - 5) / 2));
    // Tier 4: Fortress (minLvl 10)
    if (lvl >= 10) ups.fortress = 1;
  } else if (path === 'Growth') {
    // Tier 1: Magnet (max 3)
    ups.magnet = Math.min(3, Math.max(1, Math.floor(lvl / 1.5)));
    // Tier 2: Feast (max 3, minLvl 3)
    if (lvl >= 3) ups.feast = Math.min(3, Math.max(1, lvl - 2));
    // Tier 3: Snack (max 3, minLvl 6)
    if (lvl >= 6) ups.snack = Math.min(3, Math.max(1, lvl - 5));
    // Complementary: Bulk & Vitality
    if (lvl >= 4) ups.bulk = Math.min(2, Math.floor((lvl - 2) / 2));
    if (lvl >= 6) ups.vitality = Math.min(2, Math.floor((lvl - 4) / 2));
    // Tier 4: Glutton (minLvl 10)
    if (lvl >= 10) ups.glutton = 1;
  } else if (path === 'Vampire') {
    // Tier 1: Lifesteal (max 3)
    ups.lifesteal = Math.min(3, Math.max(1, Math.floor(lvl / 1.5)));
    // Tier 2: Regen (max 2, minLvl 3)
    if (lvl >= 3) ups.regen = Math.min(2, Math.max(1, lvl - 2));
    // Tier 3: Bloodthirst (max 2, minLvl 6)
    if (lvl >= 6) ups.bloodthirst = Math.min(2, Math.max(1, lvl - 5));
    // Complementary: Power & Swift
    if (lvl >= 5) ups.power = Math.min(2, Math.floor((lvl - 3) / 2));
    if (lvl >= 7) ups.swift = Math.min(2, Math.floor((lvl - 5) / 2));
    // Tier 4: Vampire (minLvl 10)
    if (lvl >= 10) ups.vampire = 1;
  } else {
    // Combo (Havoc / Hybrid)
    ups.power = Math.min(3, Math.max(1, Math.floor(lvl / 2)));
    ups.swift = Math.min(3, Math.max(1, Math.floor(lvl / 2)));
    if (lvl >= 3) ups.vitality = Math.min(2, Math.floor(lvl / 2));
    if (lvl >= 4) ups.bulk = Math.min(2, Math.floor(lvl / 3));
    if (lvl >= 5) ups.juggernaut = 1;
    if (lvl >= 6) ups.killRush = 1;
    if (lvl >= 7) ups.shieldBlast = 1;
    if (lvl >= 10) ups.reaper = 1;
  }

  b.upgrades = ups;

  // Compute stats matched to client upgrade trees
  b.bulk = (ups.bulk || 0) * 0.10;
  b.maxHp = Math.min(300, 100 + (ups.vitality || 0) * 40 + (ups.fortress ? 80 : 0));
  b.speedMult = Math.pow(1.15, ups.swift || 0);
  b.dashDmgMult = 1 + (ups.power || 0) * 0.35 + (ups.reaper ? 0.45 : 0);
  b.dashCdMult = Math.max(0.35, Math.pow(0.78, ups.fury || 0));
  b.dmgReduction = Math.min(0.45, (ups.armor || 0) * 0.10);
  b.lifesteal = (ups.lifesteal || 0) * 0.08 + (ups.vampire ? 0.15 : 0);
  b.regenMult = 1 + (ups.regen || 0) * 0.60 + (ups.fortress ? 0.50 : 0);
  b.killHeal = (ups.bloodthirst || 0) * 0.20 + (ups.vampire ? 0.20 : 0);
  b.executioner = (ups.execute || 0) * 0.45 + (ups.reaper ? 0.35 : 0);
  b.xpMult = 1 + (ups.feast || 0) * 0.30 + (ups.snack || 0) * 0.20 + (ups.glutton ? 0.50 : 0);
  b.dashDurMult = 1 + ((ups.afterburn || 0) * 0.22);
  b.maxShield = ups.shield || 0;
  if (b.shield == null) b.shield = b.maxShield;
  b.shield = Math.min(b.shield, b.maxShield);
}

// Mirrors the player's level-up cadence: levels 1-5, then 7, 9, 12, 16, etc.
function botUpgradeSlots(level) {
  let slots = 0, lastLevel = 0, step = 1;
  while (level - lastLevel >= step) {
    slots++;
    lastLevel += step;
    if (lastLevel >= 5) step++;
  }
  return slots;
}

function botUpgradeIsAvailable(upgrade, counts, level) {
  if (level < upgrade.minLevel || (counts[upgrade.id] || 0) >= upgrade.maxStack) return false;
  const requiredRank = id => {
    const parent = BOT_UPGRADE_BY_ID[id];
    return upgrade.combo ? Math.min(2, parent.maxStack) : parent.maxStack;
  };
  return upgrade.requires.every(id => (counts[id] || 0) >= requiredRank(id)) &&
    (!upgrade.requiresAny.length || upgrade.requiresAny.some(id => (counts[id] || 0) >= requiredRank(id)));
}

function applyBotUpgrades(bot) {
  const counts = bot.upgradeCounts || (bot.upgradeCounts = {});
  while (Object.values(counts).reduce((sum, rank) => sum + rank, 0) < botUpgradeSlots(bot.level)) {
    const choices = BOT_UPGRADE_DEFS.filter(upgrade => botUpgradeIsAvailable(upgrade, counts, bot.level));
    if (!choices.length) break;
    // A bot sees a small random hand, then makes a random choice from it like a player would.
    const hand = choices.sort(() => Math.random() - 0.5).slice(0, Math.min(3, choices.length));
    const pick = hand[Math.floor(Math.random() * hand.length)];
    counts[pick.id] = (counts[pick.id] || 0) + 1;
  }

  bot.upgrades = { ...counts };
  const ups = bot.upgrades;
  const b = bot;
  b.bulk = (ups.bulk || 0) * 0.10;
  b.maxHp = Math.min(300, 100 + (ups.vitality || 0) * 40 + (ups.fortress ? 80 : 0));
  b.speedMult = Math.pow(1.15, ups.swift || 0);
  b.dashDmgMult = 1 + (ups.power || 0) * 0.35 + (ups.reaper ? 0.45 : 0);
  b.dashCdMult = Math.max(0.35, Math.pow(0.78, ups.fury || 0));
  b.dmgReduction = Math.min(0.45, (ups.armor || 0) * 0.10);
  b.lifesteal = (ups.lifesteal || 0) * 0.08 + (ups.vampire ? 0.15 : 0);
  b.regenMult = 1 + (ups.regen || 0) * 0.60 + (ups.fortress ? 0.50 : 0);
  b.killHeal = (ups.bloodthirst || 0) * 0.20 + (ups.vampire ? 0.20 : 0);
  b.executioner = (ups.execute || 0) * 0.45 + (ups.reaper ? 0.35 : 0);
  b.xpMult = 1 + (ups.feast || 0) * 0.30 + (ups.snack || 0) * 0.20 + (ups.glutton ? 0.50 : 0);
  b.dashDurMult = 1 + ((ups.afterburn || 0) * 0.22);
  b.maxShield = ups.shield || 0;
  if (b.shield == null) b.shield = b.maxShield;
  b.shield = Math.min(b.shield, b.maxShield);
}

function makeBotName(usedNames) {
  let name;
  do {
    name = BOT_NAME_STARTS[Math.floor(Math.random() * BOT_NAME_STARTS.length)] +
      ' ' + BOT_NAME_ACTIONS[Math.floor(Math.random() * BOT_NAME_ACTIONS.length)];
  } while (usedNames.has(name));
  usedNames.add(name);
  return name;
}

function makeBot(i, usedNames) {
  const profile = BOT_PROFILES[i % BOT_PROFILES.length];
  // Seed initial bots across levels 1 to 5 so the arena starts dynamic and tiered!
  const initialLevels = [1, 2, 3, 2, 4, 3, 5, 2, 1, 3, 2, 4, 3, 5];
  const targetLvl = initialLevels[i % initialLevels.length];
  const baseXp = xpForLevel(targetLvl);
  const startXp = baseXp + Math.floor(Math.random() * 60);

  const bot = {
    id: 'bot-' + i,
    profile,
    name: makeBotName(usedNames),
    color: profile.color,
    x: 400 + Math.random() * (WORLD - 800),
    y: 400 + Math.random() * (WORLD - 800),
    tx: WORLD / 2 + (Math.random() - 0.5) * 2800,
    ty: WORLD / 2 + (Math.random() - 0.5) * 2800,
    level: targetLvl,
    xp: startXp,
    hp: 100,
    maxHp: 100,
    bulk: 0,
    upgrades: {},
    upgradeCounts: {},
    speedMult: 1,
    dashDmgMult: 1,
    dashCdMult: 1,
    dashDurMult: 1,
    dmgReduction: 0,
    lifesteal: 0,
    regenMult: 1,
    killHeal: 0,
    executioner: 0,
    xpMult: 1,
    shield: 0,
    maxShield: 0,
    shieldRechargeAt: 0,
    frost: 0,
    berserk: 0,
    vkx: 0,
    vky: 0,
    dashing: false,
    dashUntil: 0,
    dashCooldownUntil: 0,
    dashDX: 0,
    dashDY: 0,
    dashHitSet: new Set(),
    respawnAt: null,
    lastDamageAt: 0,
    lastAmbientXpAt: Date.now(),
    fleeUntil: 0,
    fleeTarget: null,
    wanderChangeAt: 0,
    stuckCheckAt: 0,
    stuckX: 0,
    stuckY: 0,
  };
  bot.level = levelFromXp(bot.xp);
  applyBotUpgrades(bot);
  bot.hp = bot.maxHp;
  bot.shield = bot.maxShield;
  return bot;
}

const rooms = {};

function ensureRoom(code) {
  if (rooms[code]) return rooms[code];
  const bots = [];
  const usedNames = new Set();
  for (let i = 0; i < BOT_COUNT; i++) bots.push(makeBot(i, usedNames));
  const room = { bots, food: makeFood() };
  room.interval = setInterval(() => tickBots(code), TICK_MS);
  rooms[code] = room;
  return room;
}

function respawnFood(code, i, delay) {
  setTimeout(() => {
    const room = rooms[code];
    if (!room || !room.food[i]) return;
    const f = room.food[i];
    if (f.big) {
      const ang = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * CENTER_RADIUS;
      f.x = WORLD / 2 + Math.cos(ang) * rad;
      f.y = WORLD / 2 + Math.sin(ang) * rad;
    } else {
      f.x = 60 + Math.random() * (WORLD - 120);
      f.y = 60 + Math.random() * (WORLD - 120);
    }
    f.eaten = false;
    io.to(code).emit('food', { i, respawn: true, x: f.x, y: f.y });
  }, delay);
}

function getRoomPlayers(code) {
  const set = io.sockets.adapter.rooms.get(code);
  if (!set) return [];
  const out = [];
  set.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.state) out.push(s.data.state);
  });
  return out;
}

function tickBots(code) {
  const room = rooms[code];
  if (!room) return;
  const now = Date.now();
  const players = getRoomPlayers(code);

  room.bots.forEach(b => {
    if (b.respawnAt) {
      if (now < b.respawnAt) return;
      b.respawnAt = null;
      // Retain 65% XP with a floor based on (level - 1) so bots keep climbing!
      const minFloor = xpForLevel(Math.max(1, b.level - 1));
      b.xp = Math.max(minFloor, Math.floor(b.xp * 0.65));
      b.level = levelFromXp(b.xp);
      applyBotUpgrades(b);
      b.hp = b.maxHp;
      b.shield = b.maxShield;
      b.x = 250 + Math.random() * (WORLD - 500);
      b.y = 250 + Math.random() * (WORLD - 500);
      b.vkx = 0; b.vky = 0;
      b.dashing = false; b.dashHitSet = new Set();
      b.fleeUntil = 0; b.lastDamageAt = 0;
      b.stuckCheckAt = now + 2000;
      b.stuckX = b.x; b.stuckY = b.y;
    }

    const oldLevel = b.level;
    b.level = levelFromXp(b.xp);
    if (b.level !== oldLevel) {
      applyBotUpgrades(b);
    }

    // Ambient survival XP trickle (20 XP per 2.5s boosted by xpMult)
    if (!b.lastAmbientXpAt || now - b.lastAmbientXpAt >= 2500) {
      b.lastAmbientXpAt = now;
      b.xp += Math.round(20 * (b.xpMult || 1));
      const newLvl = levelFromXp(b.xp);
      if (newLvl !== b.level) {
        b.level = newLvl;
        applyBotUpgrades(b);
      }
    }

    // Danger zone DoT & Smart Escape
    const distC = Math.hypot(b.x - WORLD / 2, b.y - WORLD / 2);
    if (distC < CENTER_RADIUS) {
      const dotDmg = (CENTER_DOT_PER_SEC * TICK_MS) / 1000;
      b.hp = Math.max(0, b.hp - dotDmg);
      b.lastDamageAt = now;
      if (b.hp <= 0 && !b.respawnAt) {
        b.respawnAt = now + 5000;
        return;
      }
      // If taking danger zone damage, head firmly outwards until clear of danger
      if (b.hp / b.maxHp < 0.85) {
        const ang = Math.atan2(b.y - WORLD / 2, b.x - WORLD / 2);
        b.fleeTarget = {
          x: WORLD / 2 + Math.cos(ang) * (CENTER_RADIUS + 200),
          y: WORLD / 2 + Math.sin(ang) * (CENTER_RADIUS + 200)
        };
        b.fleeUntil = now + 3200; // Long enough to definitely reach safety

        // Dash out if dash ready
        if (now >= b.dashCooldownUntil && !b.dashing) {
          b.dashing = true;
          b.dashUntil = now + DASH_DURATION_MS * (b.dashDurMult || 1);
          b.dashCooldownUntil = now + DASH_COOLDOWN_MS * b.dashCdMult;
          b.dashDX = Math.cos(ang);
          b.dashDY = Math.sin(ang);
        }
      }
    }

    // HP regeneration out of combat
    if (distC >= CENTER_RADIUS && now - b.lastDamageAt > REGEN_DELAY && b.hp < b.maxHp) {
      const regenAmount = (REGEN_RATE_PER_SEC * b.regenMult * TICK_MS) / 1000;
      b.hp = Math.min(b.maxHp, b.hp + regenAmount);
    }

    // Shield recharge out of combat
    if (b.maxShield > 0 && b.shield < b.maxShield && now - b.lastDamageAt > REGEN_DELAY && now >= (b.shieldRechargeAt || 0)) {
      b.shield++;
      b.shieldRechargeAt = now + 12000;
    }

    b.vkx *= VEL_FRICTION;
    b.vky *= VEL_FRICTION;
    b.x = Math.min(WORLD, Math.max(0, b.x + b.vkx));
    b.y = Math.min(WORLD, Math.max(0, b.y + b.vky));

    const r = radiusFromLevel(b.level, b.bulk);
    const hpFrac = b.hp / b.maxHp;
    b.berserk = (b.upgrades.berserk || 0) > 0 && hpFrac < 0.40 ? 1 : 0;

    // Dash execution & combat hits
    if (b.dashing) {
      if (now >= b.dashUntil) {
        b.dashing = false;
        b.dashHitSet = new Set();
      } else {
        const subSteps = 3;
        const stepDist = (PLAYER_DASH_PX_TICK / subSteps) * (b.dashDurMult || 1);
        const baseDashDmg = Math.round((16 + b.level * 1.3) * b.dashDmgMult * (b.berserk ? 1.3 : 1));

        for (let s = 0; s < subSteps; s++) {
          b.x = Math.min(WORLD, Math.max(0, b.x + b.dashDX * stepDist));
          b.y = Math.min(WORLD, Math.max(0, b.y + b.dashDY * stepDist));

          // Hit players
          players.forEach(p => {
            if (b.dashHitSet.has(p.id)) return;
            const pr = radiusFromLevel(p.level || 1, p.bulk || 0);
            const pd = Math.hypot(p.x - b.x, p.y - b.y);
            if (pd < r + pr) {
              b.dashHitSet.add(p.id);
              let strikeDmg = baseDashDmg;
              const phpFrac = (p.hp != null && p.maxHp) ? p.hp / p.maxHp : 1;
              if (b.executioner > 0 && phpFrac < 0.50) {
                strikeDmg = Math.round(strikeDmg * (1 + b.executioner));
              }
              const dx = (p.x - b.x) / (pd || 1);
              const dy = (p.y - b.y) / (pd || 1);
              io.to(p.id).emit('hit', {
                dmg: strikeDmg,
                byName: b.name,
                from: b.id,
                kx: dx * KNOCK * 1.1,
                ky: dy * KNOCK * 1.1
              });
              if (b.lifesteal > 0) b.hp = Math.min(b.maxHp, b.hp + strikeDmg * b.lifesteal);
            }
          });

          // Hit other bots
          room.bots.forEach(ob => {
            if (ob === b || ob.respawnAt || b.dashHitSet.has(ob.id)) return;
            const obr = radiusFromLevel(ob.level, ob.bulk);
            const od = Math.hypot(ob.x - b.x, ob.y - b.y);
            if (od < r + obr) {
              b.dashHitSet.add(ob.id);
              let strikeDmg = baseDashDmg;
              const ohpFrac = ob.hp / ob.maxHp;
              if (b.executioner > 0 && ohpFrac < 0.50) {
                strikeDmg = Math.round(strikeDmg * (1 + b.executioner));
              }

              // Target bot shield absorption
              if (ob.shield > 0) {
                ob.shield--;
                ob.shieldRechargeAt = now + 16000;
                const absorbed = Math.min(40, strikeDmg);
                strikeDmg = Math.max(0, strikeDmg - absorbed);
                io.to(code).emit('fx', { type: 'shieldBreak', x: ob.x, y: ob.y, r: obr + 10, alpha: 1 });
              }

              const actualDmg = strikeDmg * (1 - (ob.dmgReduction || 0));
              ob.hp = Math.max(0, ob.hp - actualDmg);
              ob.lastDamageAt = now;
              const dx = (ob.x - b.x) / (od || 1);
              const dy = (ob.y - b.y) / (od || 1);
              ob.vkx += dx * KNOCK * 0.75;
              ob.vky += dy * KNOCK * 0.75;
              if (b.lifesteal > 0) b.hp = Math.min(b.maxHp, b.hp + actualDmg * b.lifesteal);

              if (ob.hp <= 0 && !ob.respawnAt) {
                ob.respawnAt = now + 5000;
                const bounty = Math.max(120, Math.round(ob.xp * 0.45 + ob.level * 60));
                const gained = Math.round(bounty * (b.xpMult || 1));
                b.xp += gained;
                b.level = levelFromXp(b.xp);
                applyBotUpgrades(b);
                if (b.killHeal) b.hp = Math.min(b.maxHp, b.hp + b.maxHp * b.killHeal);
              }
            }
          });
        }
        return;
      }
    }

    // Food collection & vacuum
    const magnetRange = (b.upgrades.magnet || 0) * 60 + (b.upgrades.glutton ? 100 : 0);
    for (let fi = 0; fi < room.food.length; fi++) {
      const f = room.food[fi];
      if (f.eaten) continue;
      const fd = Math.hypot(f.x - b.x, f.y - b.y);
      if (magnetRange > 0 && fd < r + magnetRange) {
        f.x += (b.x - f.x) * 0.16;
        f.y += (b.y - f.y) * 0.16;
      }
      if (fd < r + 12) {
        f.eaten = true;
        const baseVal = f.big ? 32 : 14; // boosted food XP
        const xpGain = Math.round(baseVal * (b.xpMult || 1));
        b.xp += xpGain;
        const newFoodLevel = levelFromXp(b.xp);
        if (newFoodLevel !== b.level) {
          b.level = newFoodLevel;
          applyBotUpgrades(b); // apply upgrades immediately on level-up from food
        }
        io.to(code).emit('food', { i: fi });
        respawnFood(code, fi, 3500 + Math.random() * 3000);
      }
    }

    // Low HP flee logic
    const isLosingHealth = hpFrac < b.profile.fleeThreshold;
    if (isLosingHealth && now >= b.fleeUntil - 1000) {
      let tx = 0, ty = 0, count = 0;
      players.forEach(p => {
        const d = Math.hypot(p.x - b.x, p.y - b.y);
        if (d < 500) { tx += p.x; ty += p.y; count++; }
      });
      room.bots.forEach(ob => {
        if (ob === b || ob.respawnAt) return;
        const d = Math.hypot(ob.x - b.x, ob.y - b.y);
        if (d < 450 && ob.hp > b.hp) { tx += ob.x; ty += ob.y; count++; }
      });

      if (count > 0) {
        const escapeAngle = Math.atan2(b.y - ty / count, b.x - tx / count);
        b.fleeTarget = {
          x: Math.min(WORLD - 100, Math.max(100, b.x + Math.cos(escapeAngle) * 550)),
          y: Math.min(WORLD - 100, Math.max(100, b.y + Math.sin(escapeAngle) * 550))
        };
        b.fleeUntil = now + 2000;

        if (now >= b.dashCooldownUntil && Math.random() < 0.70) {
          b.dashing = true;
          b.dashUntil = now + DASH_DURATION_MS * (b.dashDurMult || 1);
          b.dashCooldownUntil = now + DASH_COOLDOWN_MS * b.dashCdMult;
          b.dashDX = Math.cos(escapeAngle);
          b.dashDY = Math.sin(escapeAngle);
        }
      }
    }

    // Target selection & combat evaluation
    const aggro = b.profile.aggroRange + b.level * 10;
    let candidates = [];

    players.forEach(p => {
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d > aggro) return;
      const pr = radiusFromLevel(p.level || 1, p.bulk || 0);
      const phpFrac = (p.hp != null && p.maxHp) ? p.hp / p.maxHp : 1;
      const lvlDiff = (p.level || 1) - b.level;
      // Avoid suicidal fights vs players 3+ levels higher unless they are very low HP
      const fearPenalty = (lvlDiff > 2 && phpFrac > 0.35) ? 400 : 0;
      const score = d - (1 - phpFrac) * 260 - (b.level - (p.level || 1)) * 50 + fearPenalty;
      candidates.push({ type: 'player', ref: p, d, x: p.x, y: p.y, r: pr, hpFrac: phpFrac, score });
    });

    room.bots.forEach(ob => {
      if (ob === b || ob.respawnAt) return;
      const d = Math.hypot(ob.x - b.x, ob.y - b.y);
      if (d > aggro * 0.9) return;
      const obr = radiusFromLevel(ob.level, ob.bulk);
      const ohpFrac = ob.hp / ob.maxHp;
      const lvlDiff = ob.level - b.level;
      const fearPenalty = (lvlDiff > 2 && ohpFrac > 0.35) ? 350 : 0;
      const score = d - (1 - ohpFrac) * 220 - (b.level - ob.level) * 40 + fearPenalty;
      candidates.push({ type: 'bot', ref: ob, d, x: ob.x, y: ob.y, r: obr, hpFrac: ohpFrac, score });
    });

    candidates.sort((c1, c2) => c1.score - c2.score);
    const bestTarget = candidates[0];

    let moveDX = 0, moveDY = 0;
    const isFleeing = now < b.fleeUntil && b.fleeTarget;

    if (isFleeing) {
      moveDX = b.fleeTarget.x - b.x;
      moveDY = b.fleeTarget.y - b.y;
      if (Math.hypot(moveDX, moveDY) < 40) b.fleeUntil = 0;
    } else if (bestTarget && (b.profile.pref !== 'farm' || b.level >= 7 || bestTarget.hpFrac < 0.35)) {
      moveDX = bestTarget.x - b.x;
      moveDY = bestTarget.y - b.y;

      const targetDist = bestTarget.d;
      // Dash can be initiated at any close/mid range without arbitrary > 55 deadlocks!
      const wantDash = targetDist < 340 && now >= b.dashCooldownUntil;
      const aggroCheck = Math.random() < b.profile.dashAggro;

      if (wantDash && aggroCheck && !b.dashing) {
        b.dashing = true;
        b.dashUntil = now + DASH_DURATION_MS * (b.dashDurMult || 1);
        b.dashCooldownUntil = now + DASH_COOLDOWN_MS * b.dashCdMult;
        b.dashHitSet = new Set();
        const baseAngle = Math.atan2(moveDY, moveDX);
        const aimJitter = (Math.random() - 0.5) * 0.08;
        b.dashDX = Math.cos(baseAngle + aimJitter);
        b.dashDY = Math.sin(baseAngle + aimJitter);

        // Shockwave trigger on dash if unlocked
        if (b.upgrades.shockwave && now >= (b.shockwaveCooldownUntil || 0)) {
          b.shockwaveCooldownUntil = now + 4000;
          const blastR = r + 110;
          const waveDmg = (8 + b.level * 0.8) * b.dashDmgMult;
          io.to(code).emit('fx', { type: 'shockwave', x: b.x, y: b.y, r, maxR: blastR, alpha: 1, color: b.color });
          players.forEach(p => {
            const pd = Math.hypot(p.x - b.x, p.y - b.y);
            if (pd < blastR) {
              const ex = (p.x - b.x) / (pd || 1), ey = (p.y - b.y) / (pd || 1);
              io.to(p.id).emit('hit', { dmg: waveDmg, byName: b.name + ' (shockwave)', kx: ex * 70, ky: ey * 70 });
            }
          });
        }
      }

      // Close combat orbiting: instead of ramming head-first when not dashing, circle and strafe!
      if (targetDist < r + bestTarget.r + 55 && !b.dashing) {
        const perpX = -moveDY / (targetDist || 1);
        const perpY = moveDX / (targetDist || 1);
        const orbitDir = (b.id.charCodeAt(b.id.length - 1) % 2 === 0) ? 1 : -1;
        moveDX = (moveDX / (targetDist || 1)) * 0.25 + perpX * orbitDir * 1.1;
        moveDY = (moveDY / (targetDist || 1)) * 0.25 + perpY * orbitDir * 1.1;
      }

      if (b.profile.pref === 'kite' && targetDist < r + bestTarget.r + 45) {
        moveDX = -(bestTarget.x - b.x);
        moveDY = -(bestTarget.y - b.y);
      }
    } else {
      // Seek pellets actively to grow and level up — no distance cap so bots always have a pellet goal
      let nearestPellet = null, minPelletDist = Infinity;
      room.food.forEach(f => {
        if (f.eaten) return;
        const d = Math.hypot(f.x - b.x, f.y - b.y);
        // Big pellets are strongly preferred when healthy; all bots under lvl 8 want food badly
        const bigBonus = (f.big && hpFrac > 0.55) ? 0.45 : 1.0;
        const lvlHunger = b.level < 8 ? 0.80 : 1.0; // hungrier at low levels
        const weight = d * bigBonus * lvlHunger;
        if (weight < minPelletDist) {
          minPelletDist = weight;
          nearestPellet = f;
        }
      });

      if (nearestPellet) {
        moveDX = nearestPellet.x - b.x;
        moveDY = nearestPellet.y - b.y;
      } else {
        if (now > b.wanderChangeAt || Math.hypot(b.tx - b.x, b.ty - b.y) < 50) {
          b.tx = WORLD / 2 + (Math.random() - 0.5) * 1800;
          b.ty = WORLD / 2 + (Math.random() - 0.5) * 1800;
          b.wanderChangeAt = now + 2000 + Math.random() * 2000;
        }
        moveDX = b.tx - b.x;
        moveDY = b.ty - b.y;
      }
    }

    // Steering repulsion from neighboring bots to prevent clumping
    let repX = 0, repY = 0;
    room.bots.forEach(ob => {
      if (ob === b || ob.respawnAt) return;
      const obr = radiusFromLevel(ob.level, ob.bulk);
      const odx = b.x - ob.x;
      const ody = b.y - ob.y;
      const od = Math.hypot(odx, ody);
      const avoidDist = r + obr + 80; // wider avoidance bubble
      if (od < avoidDist && od > 0) {
        const force = (avoidDist - od) / avoidDist;
        repX += (odx / od) * force * 5.5; // much stronger repulsion
        repY += (ody / od) * force * 5.5;
      }
    });
    moveDX += repX;
    moveDY += repY;

    const mLen = Math.hypot(moveDX, moveDY) || 1;
    let actualSpeed = (PLAYER_BASE_PX_TICK / (1 + b.level * 0.05)) * b.speedMult;
    if (isFleeing) actualSpeed *= 1.25;
    if (b.berserk) actualSpeed *= 1.30;

    b.x = Math.min(WORLD, Math.max(0, b.x + (moveDX / mLen) * actualSpeed));
    b.y = Math.min(WORLD, Math.max(0, b.y + (moveDY / mLen) * actualSpeed));

    // Watchdog anti-stuck detector: gives a burst impulse if stuck in place
    if (now > b.stuckCheckAt) {
      const movedDist = Math.hypot(b.x - b.stuckX, b.y - b.stuckY);
      if (movedDist < 35 && !b.dashing) {
        const burstAngle = Math.random() * Math.PI * 2;
        b.vkx = Math.cos(burstAngle) * 20;
        b.vky = Math.sin(burstAngle) * 20;
        b.tx = 200 + Math.random() * (WORLD - 400);
        b.ty = 200 + Math.random() * (WORLD - 400);
        b.wanderChangeAt = now + 3000;
        b.fleeUntil = now + 1200;
        b.fleeTarget = { x: b.tx, y: b.ty };
      }
      b.stuckX = b.x; b.stuckY = b.y;
      b.stuckCheckAt = now + 1800;
    }
  });

  // ── Bot-to-Bot Circle Separation (Hard Physics Push) ─────────────
  for (let i = 0; i < room.bots.length; i++) {
    const b1 = room.bots[i];
    if (b1.respawnAt) continue;
    const r1 = radiusFromLevel(b1.level, b1.bulk);
    for (let j = i + 1; j < room.bots.length; j++) {
      const b2 = room.bots[j];
      if (b2.respawnAt) continue;
      const r2 = radiusFromLevel(b2.level, b2.bulk);
      const dx = b2.x - b1.x;
      const dy = b2.y - b1.y;
      let dist = Math.hypot(dx, dy);
      const minDist = r1 + r2;
      if (dist < minDist) {
        if (dist === 0) dist = 0.01;
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        // Push each bot out by full overlap so total separation = overlap (was 52% each = 104% which left gap issues)
        b1.x -= nx * overlap * 0.55;
        b1.y -= ny * overlap * 0.55;
        b2.x += nx * overlap * 0.55;
        b2.y += ny * overlap * 0.55;
        b1.vkx -= nx * 2.5;
        b1.vky -= ny * 2.5;
        b2.vkx += nx * 2.5;
        b2.vky += ny * 2.5;
      }
    }
  }

  // ── Bot-to-Player Separation ─────────────────────────────────────
  players.forEach(p => {
    const pr = radiusFromLevel(p.level || 1, p.bulk || 0);
    room.bots.forEach(b => {
      if (b.respawnAt) return;
      const br = radiusFromLevel(b.level, b.bulk);
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      let dist = Math.hypot(dx, dy);
      const minDist = br + pr;
      if (dist < minDist) {
        if (dist === 0) dist = 0.01;
        const overlap = minDist - dist;
        b.x += (dx / dist) * overlap * 0.55;
        b.y += (dy / dist) * overlap * 0.55;
        b.vkx += (dx / dist) * 1.5;
        b.vky += (dy / dist) * 1.5;
      }
    });
  });

  io.to(code).emit('bots', room.bots.map(b => ({
    id: b.id,
    x: b.x,
    y: b.y,
    level: b.level,
    hp: b.hp,
    maxHp: b.maxHp,
    name: b.name,
    color: b.color,
    bulk: b.bulk,
    down: !!b.respawnAt,
    dashing: b.dashing,
    upgrades: b.upgrades,
    shield: b.shield,
    frost: b.frost,
    berserk: b.berserk
  })));
}

function roomSize(code) {
  const r = io.sockets.adapter.rooms.get(code);
  return r ? r.size : 0;
}

io.on('connection', socket => {
  console.log('[connect]', socket.id);

  socket.on('join', code => {
    if (typeof code !== 'string' || !code.trim()) return;
    const room = code.trim().toUpperCase().slice(0, 6);
    socket.data.room = room;
    socket.join(room);
    console.log('[join]', socket.id, '->', room, '| size:', roomSize(room));

    const state = ensureRoom(room);
    socket.emit('bots', state.bots.map(b => ({
      id: b.id, x: b.x, y: b.y, level: b.level, hp: b.hp, maxHp: b.maxHp,
      name: b.name, color: b.color, bulk: b.bulk, down: !!b.respawnAt,
      dashing: b.dashing, upgrades: b.upgrades, shield: b.shield
    })));
  });

  socket.on('state', data => {
    if (!socket.data.room) return;
    socket.data.state = { ...data, id: socket.id };
    socket.to(socket.data.room).emit('state', { ...data, id: socket.id });
  });

  socket.on('food', data => {
    if (!socket.data.room) return;
    const room = rooms[socket.data.room];
    if (room && room.food[data.i]) {
      if (data.respawn) {
        room.food[data.i].eaten = false;
        if (data.x != null) { room.food[data.i].x = data.x; room.food[data.i].y = data.y; }
      } else {
        room.food[data.i].eaten = true;
      }
    }
    socket.to(socket.data.room).emit('food', { ...data, id: socket.id });
  });

  socket.on('skin', data => {
    if (!socket.data.room) return;
    socket.to(socket.data.room).emit('skin', { ...data, id: socket.id });
  });

  socket.on('fx', data => {
    if (!socket.data.room) return;
    socket.to(socket.data.room).emit('fx', { ...data, from: socket.id });
  });

  socket.on('hit', data => {
    if (!data || !data.target) return;
    if (String(data.target).startsWith('bot-')) {
      const room = rooms[socket.data.room];
      if (!room) return;
      const bot = room.bots.find(b => b.id === data.target);
      if (!bot || bot.respawnAt) return;

      let strikeDmg = data.dmg;
      if (bot.shield > 0) {
        bot.shield--;
        bot.shieldRechargeAt = Date.now() + 16000;
        const absorbed = Math.min(40, strikeDmg);
        strikeDmg = Math.max(0, strikeDmg - absorbed);
        io.to(socket.data.room).emit('fx', {
          type: 'shieldBreak',
          x: bot.x,
          y: bot.y,
          r: radiusFromLevel(bot.level, bot.bulk) + 10,
          alpha: 1
        });
        if (bot.upgrades && bot.upgrades.shieldBlast) {
          socket.emit('hit', {
            dmg: 20,
            byName: bot.name + ' (shield blast)',
            from: bot.id,
            kx: -(data.kx || 0) * 1.2,
            ky: -(data.ky || 0) * 1.2
          });
        }
      }

      const reducedDmg = strikeDmg * (1 - (bot.dmgReduction || 0));
      bot.hp = Math.max(0, bot.hp - reducedDmg);
      bot.lastDamageAt = Date.now();
      bot.vkx = (bot.vkx || 0) + (data.kx || 0) * 0.7;
      bot.vky = (bot.vky || 0) + (data.ky || 0) * 0.7;

      if (bot.hp <= 0) {
        bot.respawnAt = Date.now() + 5000;
        const bounty = Math.max(120, Math.floor(bot.xp * 0.45 + bot.level * 60));
        socket.emit('killed', {
          from: bot.id,
          bot: true,
          xpBounty: bounty,
          victimXp: bot.xp,
          victimName: bot.name,
          victimLevel: bot.level
        });
      }
      return;
    }
    io.to(data.target).emit('hit', { ...data, from: socket.id });
  });

  socket.on('killed', data => {
    if (!data || !data.target) return;
    if (String(data.target).startsWith('bot-')) {
      const room = rooms[socket.data.room];
      if (!room) return;
      const bot = room.bots.find(b => b.id === data.target);
      if (bot) {
        const victimXp = data.victimXp || 120;
        const victimLvl = data.victimLevel || 1;
        const bountyCalc = Math.max(140, Math.round(victimXp * 0.45 + victimLvl * 75));
        const finalBounty = data.xpBounty || bountyCalc;
        bot.xp += Math.round(finalBounty * (bot.xpMult || 1));
        bot.level = levelFromXp(bot.xp);
        applyBotUpgrades(bot);
        if (bot.killHeal) bot.hp = Math.min(bot.maxHp, bot.hp + bot.maxHp * bot.killHeal);
      }
      return;
    }
    io.to(data.target).emit('killed', {
      from: socket.id,
      xpBounty: data.xpBounty,
      victimXp: data.victimXp,
      victimName: data.victimName,
      victimLevel: data.victimLevel
    });
  });

  socket.on('disconnect', reason => {
    console.log('[disconnect]', socket.id, 'room:', socket.data.room, 'reason:', reason);
    if (socket.data.room) {
      const rc = socket.data.room;
      socket.to(rc).emit('peerLeave', { id: socket.id });
      setTimeout(() => {
        if (roomSize(rc) === 0 && rooms[rc]) {
          clearInterval(rooms[rc].interval);
          delete rooms[rc];
        }
      }, 1000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Blob Arena server listening on port ' + PORT));
