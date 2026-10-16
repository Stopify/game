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
const WORLD = 3600;
const OUTER_FOOD = 300;
const CENTER_FOOD = 70;
const CENTER_RADIUS = 520;
const KNOCK = 44;
const BOT_COUNT = 8;
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
  { name: 'Apex',    color: '#ff3366', path: 'Damage',  aggroRange: 550, fleeThreshold: 0.20, dashAggro: 0.85, pref: 'hunt' },
  { name: 'Viper',   color: '#00e5ff', path: 'Speed',   aggroRange: 500, fleeThreshold: 0.45, dashAggro: 0.70, pref: 'kite' },
  { name: 'Titan',   color: '#ffd166', path: 'Tank',    aggroRange: 420, fleeThreshold: 0.15, dashAggro: 0.60, pref: 'tank' },
  { name: 'Nova',    color: '#00ff88', path: 'Growth',  aggroRange: 380, fleeThreshold: 0.40, dashAggro: 0.50, pref: 'farm' },
  { name: 'Ghost',   color: '#b388ff', path: 'Damage',  aggroRange: 600, fleeThreshold: 0.35, dashAggro: 0.90, pref: 'snipe' },
  { name: 'Havoc',   color: '#ff7733', path: 'Combo',   aggroRange: 520, fleeThreshold: 0.22, dashAggro: 0.80, pref: 'hunt' },
  { name: 'Blaze',   color: '#ff5522', path: 'Speed',   aggroRange: 480, fleeThreshold: 0.30, dashAggro: 0.85, pref: 'rush' },
  { name: 'Echo',    color: '#ff2a55', path: 'Vampire', aggroRange: 460, fleeThreshold: 0.28, dashAggro: 0.75, pref: 'vamp' }
];

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

function radiusFromLevel(lv, bulk = 0) {
  return (16 + lv * 2.4) * (1 + (bulk || 0));
}

function applyBotUpgrades(b) {
  const path = b.profile.path;
  const ups = b.upgrades;
  const lvl = b.level;

  if (path === 'Damage') {
    ups.power = Math.min(3, Math.floor(lvl / 2));
    if (lvl >= 3) ups.execute = Math.min(2, Math.floor((lvl - 1) / 3));
    if (lvl >= 6) ups.berserk = Math.min(2, Math.floor((lvl - 4) / 3));
    if (lvl >= 10) ups.reaper = 1;
  } else if (path === 'Speed') {
    ups.swift = Math.min(3, Math.floor(lvl / 2));
    if (lvl >= 3) ups.afterburn = Math.min(4, Math.floor((lvl - 1) / 2));
    if (lvl >= 6) ups.fury = Math.min(3, Math.floor((lvl - 4) / 3));
    if (lvl >= 10) ups.shockwave = 1;
  } else if (path === 'Tank') {
    ups.bulk = Math.min(3, Math.floor(lvl / 2));
    if (lvl >= 3) ups.vitality = Math.min(3, Math.floor((lvl - 1) / 3));
    if (lvl >= 3) ups.armor = Math.min(2, Math.floor(lvl / 4));
    if (lvl >= 6) ups.shield = Math.min(3, Math.floor((lvl - 3) / 3));
    if (lvl >= 10) ups.fortress = 1;
  } else if (path === 'Growth') {
    ups.magnet = Math.min(3, Math.floor(lvl / 2));
    if (lvl >= 3) ups.feast = Math.min(3, Math.floor((lvl - 1) / 3));
    if (lvl >= 6) ups.snack = Math.min(3, Math.floor((lvl - 4) / 3));
    if (lvl >= 10) ups.glutton = 1;
  } else if (path === 'Vampire') {
    ups.lifesteal = Math.min(3, Math.floor(lvl / 2));
    if (lvl >= 3) ups.regen = Math.min(2, Math.floor((lvl - 1) / 3));
    if (lvl >= 6) ups.bloodthirst = Math.min(2, Math.floor((lvl - 4) / 3));
    if (lvl >= 10) ups.vampire = 1;
  } else {
    ups.power = Math.min(2, Math.floor(lvl / 3));
    ups.swift = Math.min(2, Math.floor(lvl / 3));
    if (lvl >= 3) ups.vitality = 1;
    if (lvl >= 5) ups.juggernaut = 1;
  }

  b.bulk = (ups.bulk || 0) * 0.10;
  b.maxHp = Math.min(300, 100 + (ups.vitality || 0) * 40 + (ups.fortress ? 80 : 0));
  b.speedMult = Math.pow(1.15, ups.swift || 0);
  b.dashDmgMult = 1 + (ups.power || 0) * 0.35 + (ups.reaper ? 0.45 : 0);
  b.dashCdMult = Math.max(0.35, Math.pow(0.78, ups.fury || 0));
  b.dmgReduction = Math.min(0.40, (ups.armor || 0) * 0.10);
  b.lifesteal = (ups.lifesteal || 0) * 0.08 + (ups.vampire ? 0.15 : 0);
  b.regenMult = 1 + (ups.regen || 0) * 0.60 + (ups.fortress ? 0.50 : 0);
  b.shield = ups.shield || 0;
  b.frost = 0;
  b.berserk = (ups.berserk || 0) > 0 && (b.hp / b.maxHp < 0.40) ? 1 : 0;
}

function makeBot(i) {
  const profile = BOT_PROFILES[i % BOT_PROFILES.length];
  const startXp = 40 + Math.floor(Math.random() * 120);
  const bot = {
    id: 'bot-' + i,
    profile,
    name: profile.name,
    color: profile.color,
    x: 250 + Math.random() * (WORLD - 500),
    y: 250 + Math.random() * (WORLD - 500),
    tx: WORLD / 2 + (Math.random() - 0.5) * 1200,
    ty: WORLD / 2 + (Math.random() - 0.5) * 1200,
    level: 1,
    xp: startXp,
    hp: 100,
    maxHp: 100,
    bulk: 0,
    upgrades: {},
    speedMult: 1,
    dashDmgMult: 1,
    dashCdMult: 1,
    dmgReduction: 0,
    lifesteal: 0,
    regenMult: 1,
    shield: 0,
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
    fleeUntil: 0,
    fleeTarget: null,
    targetChangeAt: 0,
    wanderChangeAt: 0,
    stuckCheckAt: 0,
    stuckX: 0,
    stuckY: 0,
  };
  bot.level = levelFromXp(bot.xp);
  applyBotUpgrades(bot);
  bot.hp = bot.maxHp;
  return bot;
}

const rooms = {};

function ensureRoom(code) {
  if (rooms[code]) return rooms[code];
  const bots = [];
  for (let i = 0; i < BOT_COUNT; i++) bots.push(makeBot(i));
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
      b.xp = Math.floor(b.xp * 0.45);
      b.level = levelFromXp(b.xp);
      b.upgrades = {};
      applyBotUpgrades(b);
      b.hp = b.maxHp;
      b.x = 250 + Math.random() * (WORLD - 500);
      b.y = 250 + Math.random() * (WORLD - 500);
      b.vkx = 0; b.vky = 0;
      b.dashing = false; b.dashHitSet = new Set();
      b.fleeUntil = 0; b.lastDamageAt = 0;
    }

    const oldLevel = b.level;
    b.level = levelFromXp(b.xp);
    if (b.level !== oldLevel) {
      applyBotUpgrades(b);
    }

    const distC = Math.hypot(b.x - WORLD / 2, b.y - WORLD / 2);
    if (distC < CENTER_RADIUS) {
      const dotDmg = (CENTER_DOT_PER_SEC * TICK_MS) / 1000;
      b.hp = Math.max(0, b.hp - dotDmg);
      b.lastDamageAt = now;
      if (b.hp <= 0 && !b.respawnAt) {
        b.respawnAt = now + 5000;
        return;
      }
      if (b.hp / b.maxHp < 0.65) {
        const ang = Math.atan2(b.y - WORLD / 2, b.x - WORLD / 2);
        b.fleeTarget = {
          x: WORLD / 2 + Math.cos(ang) * (CENTER_RADIUS + 220),
          y: WORLD / 2 + Math.sin(ang) * (CENTER_RADIUS + 220)
        };
        b.fleeUntil = now + 1200;
      }
    }

    if (distC >= CENTER_RADIUS && now - b.lastDamageAt > REGEN_DELAY && b.hp < b.maxHp) {
      const regenAmount = (REGEN_RATE_PER_SEC * b.regenMult * TICK_MS) / 1000;
      b.hp = Math.min(b.maxHp, b.hp + regenAmount);
    }

    b.vkx *= VEL_FRICTION;
    b.vky *= VEL_FRICTION;
    b.x = Math.min(WORLD, Math.max(0, b.x + b.vkx));
    b.y = Math.min(WORLD, Math.max(0, b.y + b.vky));

    const r = radiusFromLevel(b.level, b.bulk);
    const hpFrac = b.hp / b.maxHp;
    b.berserk = (b.upgrades.berserk || 0) > 0 && hpFrac < 0.40 ? 1 : 0;

    if (b.dashing) {
      if (now >= b.dashUntil) {
        b.dashing = false;
        b.dashHitSet = new Set();
      } else {
        const subSteps = 3;
        const stepDist = PLAYER_DASH_PX_TICK / subSteps;
        const dashDmg = Math.round((16 + b.level * 1.3) * b.dashDmgMult * (b.berserk ? 1.3 : 1));

        for (let s = 0; s < subSteps; s++) {
          b.x = Math.min(WORLD, Math.max(0, b.x + b.dashDX * stepDist));
          b.y = Math.min(WORLD, Math.max(0, b.y + b.dashDY * stepDist));

          players.forEach(p => {
            if (b.dashHitSet.has(p.id)) return;
            const pr = radiusFromLevel(p.level || 1, p.bulk || 0);
            const pd = Math.hypot(p.x - b.x, p.y - b.y);
            if (pd < r + pr) {
              b.dashHitSet.add(p.id);
              const dx = (p.x - b.x) / (pd || 1);
              const dy = (p.y - b.y) / (pd || 1);
              io.to(p.id).emit('hit', {
                dmg: dashDmg,
                byName: b.name,
                from: b.id,
                kx: dx * KNOCK * 1.1,
                ky: dy * KNOCK * 1.1
              });
              if (b.lifesteal > 0) b.hp = Math.min(b.maxHp, b.hp + dashDmg * b.lifesteal);
            }
          });

          room.bots.forEach(ob => {
            if (ob === b || ob.respawnAt || b.dashHitSet.has(ob.id)) return;
            const obr = radiusFromLevel(ob.level, ob.bulk);
            const od = Math.hypot(ob.x - b.x, ob.y - b.y);
            if (od < r + obr) {
              b.dashHitSet.add(ob.id);
              const actualDmg = dashDmg * (1 - (ob.dmgReduction || 0));
              ob.hp = Math.max(0, ob.hp - actualDmg);
              ob.lastDamageAt = now;
              const dx = (ob.x - b.x) / (od || 1);
              const dy = (ob.y - b.y) / (od || 1);
              ob.vkx += dx * KNOCK * 0.7;
              ob.vky += dy * KNOCK * 0.7;
              if (b.lifesteal > 0) b.hp = Math.min(b.maxHp, b.hp + actualDmg * b.lifesteal);

              if (ob.hp <= 0 && !ob.respawnAt) {
                ob.respawnAt = now + 5000;
                const bounty = Math.max(70, Math.floor(ob.xp * 0.35 + 80));
                b.xp += bounty;
                b.level = levelFromXp(b.xp);
                applyBotUpgrades(b);
              }
            }
          });
        }
        return;
      }
    }

    const magnetRange = (b.upgrades.magnet || 0) * 60 + (b.upgrades.glutton ? 100 : 0);
    for (let fi = 0; fi < room.food.length; fi++) {
      const f = room.food[fi];
      if (f.eaten) continue;
      const fd = Math.hypot(f.x - b.x, f.y - b.y);
      if (magnetRange > 0 && fd < r + magnetRange) {
        f.x += (b.x - f.x) * 0.15;
        f.y += (b.y - f.y) * 0.15;
      }
      if (fd < r + 10) {
        f.eaten = true;
        const xpGain = f.big ? 18 : 7;
        b.xp += xpGain;
        b.level = levelFromXp(b.xp);
        io.to(code).emit('food', { i: fi });
        respawnFood(code, fi, 9000 + Math.random() * 6000);
      }
    }

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
        b.fleeUntil = now + 1800;

        if (now >= b.dashCooldownUntil && Math.random() < 0.65) {
          b.dashing = true;
          b.dashUntil = now + DASH_DURATION_MS;
          b.dashCooldownUntil = now + DASH_COOLDOWN_MS * b.dashCdMult;
          b.dashDX = Math.cos(escapeAngle);
          b.dashDY = Math.sin(escapeAngle);
        }
      }
    }

    const aggro = b.profile.aggroRange + b.level * 10;
    let candidates = [];

    players.forEach(p => {
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d > aggro) return;
      const pr = radiusFromLevel(p.level || 1, p.bulk || 0);
      const phpFrac = (p.hp != null && p.maxHp) ? p.hp / p.maxHp : 1;
      const score = d - (1 - phpFrac) * 220 - (b.level - (p.level || 1)) * 60;
      candidates.push({ type: 'player', ref: p, d, x: p.x, y: p.y, r: pr, hpFrac: phpFrac, score });
    });

    room.bots.forEach(ob => {
      if (ob === b || ob.respawnAt) return;
      const d = Math.hypot(ob.x - b.x, ob.y - b.y);
      if (d > aggro * 0.9) return;
      const obr = radiusFromLevel(ob.level, ob.bulk);
      const ohpFrac = ob.hp / ob.maxHp;
      const score = d - (1 - ohpFrac) * 180 - (b.level - ob.level) * 45;
      candidates.push({ type: 'bot', ref: ob, d, x: ob.x, y: ob.y, r: obr, hpFrac: ohpFrac, score });
    });

    candidates.sort((c1, c2) => c1.score - c2.score);
    const bestTarget = candidates[0];

    let moveDX = 0, moveDY = 0;
    const isFleeing = now < b.fleeUntil && b.fleeTarget;

    if (isFleeing) {
      moveDX = b.fleeTarget.x - b.x;
      moveDY = b.fleeTarget.y - b.y;
      if (Math.hypot(moveDX, moveDY) < 30) b.fleeUntil = 0;
    } else if (bestTarget && (b.profile.pref !== 'farm' || b.level >= 3 || bestTarget.hpFrac < 0.5)) {
      moveDX = bestTarget.x - b.x;
      moveDY = bestTarget.y - b.y;

      const targetDist = bestTarget.d;
      const wantDash = targetDist < 300 && targetDist > 55 && now >= b.dashCooldownUntil;
      const aggroCheck = Math.random() < b.profile.dashAggro;

      if (wantDash && aggroCheck && !b.dashing) {
        b.dashing = true;
        b.dashUntil = now + DASH_DURATION_MS;
        b.dashCooldownUntil = now + DASH_COOLDOWN_MS * b.dashCdMult;
        b.dashHitSet = new Set();
        const baseAngle = Math.atan2(moveDY, moveDX);
        const aimJitter = (Math.random() - 0.5) * 0.12;
        b.dashDX = Math.cos(baseAngle + aimJitter);
        b.dashDY = Math.sin(baseAngle + aimJitter);
      }

      if (b.profile.pref === 'kite' && targetDist < r + bestTarget.r + 35) {
        moveDX = -(bestTarget.x - b.x);
        moveDY = -(bestTarget.y - b.y);
      }
    } else {
      let nearestPellet = null, minPelletDist = 600;
      room.food.forEach(f => {
        if (f.eaten) return;
        const d = Math.hypot(f.x - b.x, f.y - b.y);
        const weight = f.big && hpFrac > 0.65 ? d * 0.6 : d;
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
          b.tx = WORLD / 2 + (Math.random() - 0.5) * 1600;
          b.ty = WORLD / 2 + (Math.random() - 0.5) * 1600;
          b.wanderChangeAt = now + 2000 + Math.random() * 2000;
        }
        moveDX = b.tx - b.x;
        moveDY = b.ty - b.y;
      }
    }

    const mLen = Math.hypot(moveDX, moveDY) || 1;
    let actualSpeed = (PLAYER_BASE_PX_TICK / (1 + b.level * 0.05)) * b.speedMult;
    if (isFleeing) actualSpeed *= 1.25;
    if (b.berserk) actualSpeed *= 1.30;

    b.x = Math.min(WORLD, Math.max(0, b.x + (moveDX / mLen) * actualSpeed));
    b.y = Math.min(WORLD, Math.max(0, b.y + (moveDY / mLen) * actualSpeed));

    if (now > b.stuckCheckAt) {
      if (Math.hypot(b.x - b.stuckX, b.y - b.stuckY) < 25 && !b.dashing) {
        b.tx = 150 + Math.random() * (WORLD - 300);
        b.ty = 150 + Math.random() * (WORLD - 300);
        b.wanderChangeAt = 0;
      }
      b.stuckX = b.x; b.stuckY = b.y;
      b.stuckCheckAt = now + 2500;
    }
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

      const reducedDmg = data.dmg * (1 - (bot.dmgReduction || 0));
      bot.hp = Math.max(0, bot.hp - reducedDmg);
      bot.lastDamageAt = Date.now();
      bot.vkx = (bot.vkx || 0) + (data.kx || 0) * 0.7;
      bot.vky = (bot.vky || 0) + (data.ky || 0) * 0.7;

      if (bot.hp <= 0) {
        bot.respawnAt = Date.now() + 5000;
        const bounty = Math.max(70, Math.floor(bot.xp * 0.40 + bot.level * 40));
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
        bot.xp += data.xpBounty || 80;
        bot.level = levelFromXp(bot.xp);
        applyBotUpgrades(bot);
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