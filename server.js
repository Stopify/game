const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const WORLD = 3600, OUTER_FOOD = 300, CENTER_FOOD = 70, CENTER_RADIUS = 520, KNOCK = 44;
const BOT_COUNT = 8;
// Danger zone: ~7 hp/sec at 120ms tick interval
const CENTER_DOT_PER_TICK = 0.84;

// Bot personalities — each one plays differently
const PERSONALITIES = {
  AGGRESSIVE: 'aggressive', // charges everything, high risk, likes to dash
  FARMER:     'farmer',     // prioritizes food, only fights when winning
  SKIRMISHER: 'skirmisher', // hit-and-run, flees when hurt, kites
  BRAWLER:    'brawler',    // fights anyone regardless of size diff
  SNIPER:     'sniper',     // waits for targets to be weakened then finishes them
};

// Bot tiers now include personality + dash capability
const TIERS = [
  { name:'Raider',  color:'#8888aa', speed:1.10, dmg:10, aggro:260, cooldown:1600, startLevel:1, hp:60,  maxHp:60,  personality:PERSONALITIES.SKIRMISHER, dashCooldown:2200, dashRange:190, dashDmg:18 },
  { name:'Hunter',  color:'#88aa88', speed:1.20, dmg:11, aggro:280, cooldown:1500, startLevel:2, hp:70,  maxHp:70,  personality:PERSONALITIES.FARMER,     dashCooldown:2400, dashRange:160, dashDmg:16 },
  { name:'Bruiser', color:'#aa6688', speed:1.30, dmg:14, aggro:300, cooldown:1300, startLevel:2, hp:80,  maxHp:80,  personality:PERSONALITIES.BRAWLER,    dashCooldown:1800, dashRange:240, dashDmg:22 },
  { name:'Striker', color:'#aa8866', speed:1.40, dmg:15, aggro:320, cooldown:1200, startLevel:3, hp:85,  maxHp:85,  personality:PERSONALITIES.AGGRESSIVE, dashCooldown:1600, dashRange:270, dashDmg:24 },
  { name:'Phantom', color:'#cc88ff', speed:1.55, dmg:13, aggro:350, cooldown:1400, startLevel:3, hp:75,  maxHp:75,  personality:PERSONALITIES.SNIPER,     dashCooldown:1400, dashRange:300, dashDmg:28 },
  { name:'Slayer',  color:'#ff8844', speed:1.45, dmg:18, aggro:340, cooldown:1100, startLevel:4, hp:95,  maxHp:95,  personality:PERSONALITIES.AGGRESSIVE, dashCooldown:1500, dashRange:280, dashDmg:30 },
  { name:'Scout',   color:'#44ddff', speed:1.70, dmg:12, aggro:290, cooldown:1500, startLevel:2, hp:65,  maxHp:65,  personality:PERSONALITIES.SKIRMISHER, dashCooldown:1300, dashRange:260, dashDmg:20 },
  { name:'Alpha',   color:'#ffaa33', speed:1.60, dmg:22, aggro:380, cooldown:1000, startLevel:5, hp:120, maxHp:120, personality:PERSONALITIES.BRAWLER,    dashCooldown:1200, dashRange:320, dashDmg:36 },
];

function mulberry32(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function makeFood(){
  // Must advance the RNG in the exact same sequence as the client's generator (2 draws per outer pellet, x then y)
  // so both sides agree on pellet positions by index.
  const rngA=mulberry32(42), arr=[];
  for(let i=0;i<OUTER_FOOD;i++) arr.push({x:rngA()*WORLD,y:rngA()*WORLD,eaten:false,big:false});
  const rngB=mulberry32(777), cx=WORLD/2, cy=WORLD/2;
  for(let i=0;i<CENTER_FOOD;i++){
    const ang=rngB()*Math.PI*2, rad=Math.sqrt(rngB())*CENTER_RADIUS;
    arr.push({x:cx+Math.cos(ang)*rad, y:cy+Math.sin(ang)*rad, eaten:false, big:true});
  }
  return arr;
}
function levelFromXp(xp){
  let lvl=1, needed=0, step=130;
  while(xp>=needed+step){ needed+=step; lvl++; step+=45; }
  return lvl;
}
function radiusFromLevel(lv){return 16+lv*2.4;}

const rooms = {}; // code -> { bots, food, interval }

// Bot stat scaling with level — bots get meaningfully stronger as they grow
function botMaxHp(b){ return b.tier.maxHp + (b.level-b.tier.startLevel)*12; }
function botDmg(b){ return b.tier.dmg + b.level * 1.2; }
function botDashDmg(b){ return b.tier.dashDmg + b.level * 1.8; }
function botAggro(b){ return b.tier.aggro + b.level * 8; }

function makeBot(i){
  const tier=TIERS[i%TIERS.length];
  const startXp=(tier.startLevel-1)*130;
  return {
    id:'bot-'+i, tier,
    x:200+Math.random()*(WORLD-400), y:200+Math.random()*(WORLD-400),
    tx:200+Math.random()*(WORLD-400), ty:200+Math.random()*(WORLD-400),
    level:tier.startLevel, xp:startXp,
    hp:tier.maxHp, maxHp:tier.maxHp,
    name:tier.name+(i+1),
    cooldownUntil:0,        // melee attack cooldown
    dashCooldownUntil:0,    // dash cooldown
    dashing:false,          // currently in dash?
    dashUntil:0,            // dash ends at this time
    dashDX:0, dashDY:0,     // dash direction
    dashHitSet:new Set(),   // targets already hit this dash
    respawnAt:null,
    lastDamageAt:0,         // for out-of-combat regen
    vkx:0, vky:0,           // knockback velocity — ice sliding physics
    // AI state
    fleeTarget:null,        // position to flee to
    fleeUntil:0,            // stop fleeing at this time
    wanderChangeAt:0,       // when to pick a new wander target
    stuckX:0, stuckY:0, stuckCheckAt:0, // anti-stuck
  };
}

function ensureRoom(code){
  if(rooms[code]) return rooms[code];
  const bots=[]; for(let i=0;i<BOT_COUNT;i++) bots.push(makeBot(i));
  const room={ bots, food:makeFood() };
  room.interval=setInterval(()=>tickBots(code),120);
  rooms[code]=room;
  return room;
}

function respawnFood(code,i,delay){
  setTimeout(()=>{
    const room=rooms[code]; if(!room||!room.food[i]) return;
    const f=room.food[i];
    if(f.big){
      const ang=Math.random()*Math.PI*2, rad=Math.sqrt(Math.random())*CENTER_RADIUS;
      f.x=WORLD/2+Math.cos(ang)*rad; f.y=WORLD/2+Math.sin(ang)*rad;
    } else {
      f.x=60+Math.random()*(WORLD-120); f.y=60+Math.random()*(WORLD-120);
    }
    f.eaten=false;
    io.to(code).emit('food',{i,respawn:true,x:f.x,y:f.y});
  },delay);
}

function getRoomPlayers(code){
  const set=io.sockets.adapter.rooms.get(code);
  if(!set) return [];
  const out=[];
  set.forEach(id=>{ const s=io.sockets.sockets.get(id); if(s&&s.data.state) out.push(s.data.state); });
  return out;
}

function tickBots(code){
  const room=rooms[code]; if(!room) return;
  const now=Date.now();
  const players=getRoomPlayers(code);
  const TICK_DT=120; // ms per tick
  const REGEN_DELAY=6000; // ms out of combat before regen starts
  const REGEN_PER_TICK=0.7; // hp per tick while regenerating

  room.bots.forEach(b=>{
    // ── Respawn ──────────────────────────────────────────────────────────
    if(b.respawnAt){
      if(now<b.respawnAt) return;
      b.respawnAt=null;
      b.level=b.tier.startLevel; b.xp=(b.tier.startLevel-1)*130;
      b.hp=b.tier.maxHp; b.maxHp=b.tier.maxHp;
      b.x=200+Math.random()*(WORLD-400); b.y=200+Math.random()*(WORLD-400);
      b.vkx=0; b.vky=0; b.dashing=false; b.dashHitSet=new Set();
      b.fleeUntil=0; b.cooldownUntil=0; b.dashCooldownUntil=0;
    }

    // ── Danger zone DoT — bots flee the center ────────────────────────────
    const distC=Math.hypot(b.x-WORLD/2,b.y-WORLD/2);
    if(distC<CENTER_RADIUS){
      b.hp=Math.max(0,b.hp-CENTER_DOT_PER_TICK);
      b.lastDamageAt=now;
      if(b.hp<=0&&!b.respawnAt){ b.respawnAt=now+6000; return; }
      // Force flee out of danger zone
      const ang=Math.atan2(b.y-WORLD/2,b.x-WORLD/2);
      b.fleeTarget={x:WORLD/2+Math.cos(ang)*(CENTER_RADIUS+200), y:WORLD/2+Math.sin(ang)*(CENTER_RADIUS+200)};
      b.fleeUntil=now+2000;
    }

    // ── Out-of-combat regeneration ─────────────────────────────────────
    const mhp=botMaxHp(b);
    if(b.hp<mhp && now-b.lastDamageAt>REGEN_DELAY){
      b.hp=Math.min(mhp, b.hp+REGEN_PER_TICK);
    }
    // Update maxHp based on current level
    b.maxHp=mhp;

    // ── Ice sliding: decay and apply knockback velocity ─────────────────
    b.vkx*=0.84; b.vky*=0.84;
    b.x=Math.min(WORLD,Math.max(0,b.x+b.vkx));
    b.y=Math.min(WORLD,Math.max(0,b.y+b.vky));

    // ── Dash continuation (mid-dash movement + hit detection) ───────────
    if(b.dashing){
      if(now>=b.dashUntil){
        b.dashing=false; b.dashHitSet=new Set();
      } else {
        // Move fast during dash
        const dashSpeed=8.5;
        b.x=Math.min(WORLD,Math.max(0,b.x+b.dashDX*dashSpeed));
        b.y=Math.min(WORLD,Math.max(0,b.y+b.dashDY*dashSpeed));
        const br=radiusFromLevel(b.level);
        const dashDmg=botDashDmg(b);
        // Hit players during dash
        players.forEach(p=>{
          if(b.dashHitSet.has(p.id)) return;
          const pr=radiusFromLevel(p.level||1);
          const pd=Math.hypot(p.x-b.x,p.y-b.y);
          if(pd<br+pr){
            b.dashHitSet.add(p.id);
            const dx=(p.x-b.x)/(pd||1), dy=(p.y-b.y)/(pd||1);
            io.to(p.id).emit('hit',{dmg:dashDmg,byName:b.name,from:b.id,kx:dx*KNOCK*1.1,ky:dy*KNOCK*1.1});
          }
        });
        // Hit bots during dash
        room.bots.forEach(ob=>{
          if(ob===b||ob.respawnAt||b.dashHitSet.has(ob.id)) return;
          const obr=radiusFromLevel(ob.level);
          const od=Math.hypot(ob.x-b.x,ob.y-b.y);
          if(od<br+obr){
            b.dashHitSet.add(ob.id);
            ob.hp=Math.max(0,ob.hp-dashDmg);
            ob.lastDamageAt=now;
            const dx=(ob.x-b.x)/(od||1), dy=(ob.y-b.y)/(od||1);
            ob.vkx+=dx*KNOCK*0.5; ob.vky+=dy*KNOCK*0.5;
            if(ob.hp<=0&&!ob.respawnAt){
              ob.respawnAt=now+6000;
              b.xp+=Math.max(50,Math.floor(ob.level*80+ob.xp*0.3));
              b.level=levelFromXp(b.xp);
            }
          }
        });
        return; // skip normal movement while dashing
      }
    }

    const r=radiusFromLevel(b.level);
    const personality=b.tier.personality;
    const hpPct=b.hp/mhp;

    // ── Flee logic: low HP bots run away ──────────────────────────────────
    const fleeThreshold= personality===PERSONALITIES.SKIRMISHER ? 0.55
                       : personality===PERSONALITIES.FARMER     ? 0.45
                       : personality===PERSONALITIES.SNIPER     ? 0.40
                       : 0.25; // AGGRESSIVE/BRAWLER tough it out

    if(hpPct<fleeThreshold && now>b.lastDamageAt-500 && now>=b.fleeUntil-3000){
      // Pick a flee position away from nearby threats
      let threatX=0, threatY=0, threatCount=0;
      players.forEach(p=>{ const d=Math.hypot(p.x-b.x,p.y-b.y); if(d<400){threatX+=p.x;threatY+=p.y;threatCount++;} });
      room.bots.forEach(ob=>{ if(ob===b||ob.respawnAt)return; const d=Math.hypot(ob.x-b.x,ob.y-b.y); if(d<300&&ob.hp>b.hp){threatX+=ob.x;threatY+=ob.y;threatCount++;} });
      if(threatCount>0){
        const tx=threatX/threatCount, ty=threatY/threatCount;
        const ang=Math.atan2(b.y-ty,b.x-tx);
        b.fleeTarget={x:Math.min(WORLD-100,Math.max(100,b.x+Math.cos(ang)*350)),y:Math.min(WORLD-100,Math.max(100,b.y+Math.sin(ang)*350))};
        b.fleeUntil=now+2500;
      }
    }

    // ── Target selection: find best attack target ──────────────────────────
    const aggro=botAggro(b);
    let bestD=Infinity, bestX=null, bestY=null, bestType=null, bestRef=null, bestR=0;

    // Build candidate list + score targets
    const candidates=[];
    players.forEach(p=>{
      const d=Math.hypot(p.x-b.x,p.y-b.y);
      if(d>aggro) return;
      const pr=radiusFromLevel(p.level||1,p.bulk||0);
      // Size check — brawlers fight anyone, others prefer smaller/weakened targets
      const sizeOk = personality===PERSONALITIES.BRAWLER ? true
                   : personality===PERSONALITIES.AGGRESSIVE ? pr<=r*1.5
                   : pr<=r*1.2;
      if(!sizeOk) return;
      const pHpPct=(p.hp!=null&&p.maxHp)?p.hp/p.maxHp:1;
      // Sniper prefers wounded targets
      if(personality===PERSONALITIES.SNIPER && pHpPct>0.65 && d>200) return;
      let score=d;
      score -= (1-pHpPct)*120; // prefer low-HP targets
      if(p.level<b.level) score-=80; // prefer lower-level targets
      candidates.push({d,x:p.x,y:p.y,type:'player',ref:p,r:pr,score});
    });
    room.bots.forEach(ob=>{
      if(ob===b||ob.respawnAt) return;
      const d=Math.hypot(ob.x-b.x,ob.y-b.y);
      if(d>aggro*0.8) return;
      const obr=radiusFromLevel(ob.level);
      const sizeOk = personality===PERSONALITIES.BRAWLER ? true : obr<=r*1.3;
      if(!sizeOk) return;
      const obHpPct=ob.hp/botMaxHp(ob);
      let score=d - (1-obHpPct)*80;
      if(ob.level<b.level) score-=60;
      candidates.push({d,x:ob.x,y:ob.y,type:'bot',ref:ob,r:obr,score});
    });

    // Pick lowest score (best) target
    if(candidates.length>0){
      candidates.sort((a,b)=>a.score-b.score);
      const best=candidates[0];
      bestD=best.d; bestX=best.x; bestY=best.y; bestType=best.type; bestRef=best.ref; bestR=best.r;
    }

    // ── Nearest food scan ─────────────────────────────────────────────────
    let pIdx=-1, pDist=Infinity, pTarget=null;
    const foodScanR=personality===PERSONALITIES.FARMER?600:380;
    room.food.forEach((f,i)=>{
      if(f.eaten) return;
      const d=Math.hypot(f.x-b.x,f.y-b.y);
      if(d<foodScanR&&d<pDist){pDist=d;pIdx=i;pTarget=f;}
    });

    // ── Decide movement direction ─────────────────────────────────────────
    let mx, my;
    const isFleeing=now<b.fleeUntil && b.fleeTarget;

    if(isFleeing){
      // Flee mode: run to safe spot
      mx=b.fleeTarget.x-b.x; my=b.fleeTarget.y-b.y;
      const fd=Math.hypot(mx,my);
      if(fd<30) b.fleeUntil=0;
    } else if(bestRef && !isFleeing){
      // Chase / attack target
      mx=bestX-b.x; my=bestY-b.y;

      // ── Dash: launch a dash at the target if in range ─────────────────
      const dashRange=b.tier.dashRange;
      const wantDash = (bestD<dashRange) && now>=b.dashCooldownUntil && !b.dashing;
      // Farmer only dashes if it's confident (hp > 60%)
      const dashAllowed = personality===PERSONALITIES.FARMER ? (hpPct>0.60 && wantDash) : wantDash;

      if(dashAllowed){
        b.dashing=true;
        b.dashUntil=now+200;
        b.dashCooldownUntil=now+b.tier.dashCooldown*(0.85+Math.random()*0.3); // ±15% jitter
        b.dashHitSet=new Set();
        const dd=Math.hypot(mx,my)||1;
        // Add small aim error for realism
        const aimError=(Math.random()-0.5)*0.18;
        b.dashDX=Math.cos(Math.atan2(my,mx)+aimError);
        b.dashDY=Math.sin(Math.atan2(my,mx)+aimError);
      }

      // ── Melee hit if close ─────────────────────────────────────────────
      if(bestD<r+bestR+8 && now>=b.cooldownUntil){
        b.cooldownUntil=now+b.tier.cooldown;
        const dx=(bestX-b.x)/(bestD||1), dy=(bestY-b.y)/(bestD||1);
        const dmg=botDmg(b);
        if(bestType==='player'){
          io.to(bestRef.id).emit('hit',{dmg,byName:b.name,from:b.id,kx:dx*KNOCK,ky:dy*KNOCK});
        } else {
          bestRef.hp=Math.max(0,bestRef.hp-dmg);
          bestRef.lastDamageAt=now;
          bestRef.vkx=(bestRef.vkx||0)+dx*KNOCK*0.4;
          bestRef.vky=(bestRef.vky||0)+dy*KNOCK*0.4;
          if(bestRef.hp<=0&&!bestRef.respawnAt){
            bestRef.respawnAt=now+6000;
            b.xp+=Math.max(40,Math.floor(bestRef.level*60+bestRef.xp*0.25));
            b.level=levelFromXp(b.xp); b.maxHp=botMaxHp(b);
          }
        }
      }

      // ── Kiting: skirmishers back off when target is close ─────────────
      if(personality===PERSONALITIES.SKIRMISHER && bestD<r+bestR+40){
        mx=-(bestX-b.x); my=-(bestY-b.y); // back away
      }

    } else if(pTarget && (personality===PERSONALITIES.FARMER || !bestRef)){
      // Farm food
      mx=pTarget.x-b.x; my=pTarget.y-b.y;
      if(pDist<r+12){
        pTarget.eaten=true;
        const xpGain=pTarget.big?20:8;
        b.xp+=xpGain; b.level=levelFromXp(b.xp); b.maxHp=botMaxHp(b);
        io.to(code).emit('food',{i:pIdx});
        respawnFood(code,pIdx,9000+Math.random()*6000);
      }
    } else {
      // Wander with purpose: update target every 2-4s or when arrived
      if(now>b.wanderChangeAt || Math.hypot(b.tx-b.x,b.ty-b.y)<30){
        // Wander toward the center of action or toward food clusters
        if(Math.random()<0.35){
          // Drift toward map center with offset
          b.tx=WORLD/2+(Math.random()-0.5)*1600;
          b.ty=WORLD/2+(Math.random()-0.5)*1600;
        } else {
          b.tx=120+Math.random()*(WORLD-240);
          b.ty=120+Math.random()*(WORLD-240);
        }
        b.wanderChangeAt=now+2000+Math.random()*2000;
      }
      mx=b.tx-b.x; my=b.ty-b.y;
    }

    // ── Apply movement ─────────────────────────────────────────────────────
    const d=Math.hypot(mx,my)||1;
    let speed=b.tier.speed;
    // Fleeing bots move faster
    if(isFleeing) speed*=1.25;
    // Frost aura from players slows bots
    let slow=1;
    players.forEach(p=>{ if(p.frost && Math.hypot(p.x-b.x,p.y-b.y)<radiusFromLevel(p.level||1)*(1+(p.bulk||0))+r+70) slow=0.65; });
    b.x=Math.min(WORLD,Math.max(0,b.x+(mx/d)*speed*slow));
    b.y=Math.min(WORLD,Math.max(0,b.y+(my/d)*speed*slow));

    // ── Anti-stuck: if barely moved in 3s, teleport wander target ─────────
    if(now>b.stuckCheckAt){
      const moved=Math.hypot(b.x-b.stuckX,b.y-b.stuckY);
      if(moved<15 && !isFleeing && !b.dashing){
        b.tx=120+Math.random()*(WORLD-240); b.ty=120+Math.random()*(WORLD-240);
      }
      b.stuckX=b.x; b.stuckY=b.y; b.stuckCheckAt=now+3000;
    }
  });

  io.to(code).emit('bots', room.bots.map(b=>({id:b.id,x:b.x,y:b.y,level:b.level,hp:b.hp,maxHp:b.maxHp,name:b.name,color:b.tier.color,bulk:0,down:!!b.respawnAt,dashing:b.dashing})));
}


function roomSize(code){ const r=io.sockets.adapter.rooms.get(code); return r?r.size:0; }

io.on('connection',(socket)=>{
  console.log('[connect]', socket.id);
  socket.on('join',(code)=>{
    if(typeof code!=='string'||!code.trim()) return;
    const room=code.trim().toUpperCase().slice(0,6);
    socket.data.room=room;
    socket.join(room);
    console.log('[join]', socket.id, '->', room, '| room size:', roomSize(room));
    const state=ensureRoom(room);
    socket.emit('bots', state.bots.map(b=>({id:b.id,x:b.x,y:b.y,level:b.level,hp:b.hp,maxHp:b.maxHp,name:b.name,color:b.tier.color,bulk:0,down:!!b.respawnAt})));
  });

  socket.on('state',(data)=>{
    if(!socket.data.room) return;
    socket.data.state={...data,id:socket.id};
    socket.to(socket.data.room).emit('state',{...data,id:socket.id});
  });
  socket.on('food',(data)=>{
    if(!socket.data.room) return;
    const room=rooms[socket.data.room];
    if(room && room.food[data.i]){
      if(data.respawn){ room.food[data.i].eaten=false; if(data.x!=null){room.food[data.i].x=data.x;room.food[data.i].y=data.y;} }
      else room.food[data.i].eaten=true;
    }
    socket.to(socket.data.room).emit('food',{...data,id:socket.id});
  });
  socket.on('skin',(data)=>{
    if(!socket.data.room) return;
    socket.to(socket.data.room).emit('skin',{...data,id:socket.id});
  });
  socket.on('fx',(data)=>{
    if(!socket.data.room) return;
    socket.to(socket.data.room).emit('fx',{...data,from:socket.id});
  });

  socket.on('hit',(data)=>{
    if(!data||!data.target) return;
    if(String(data.target).startsWith('bot-')){
      const room=rooms[socket.data.room]; if(!room) return;
      const bot=room.bots.find(b=>b.id===data.target);
      if(!bot||bot.respawnAt) return;
      bot.hp=Math.max(0,bot.hp-data.dmg);
      bot.lastDamageAt=Date.now(); // reset regen timer
      // Velocity-based knockback — bot slides instead of teleporting
      bot.vkx=(bot.vkx||0)+(data.kx||0)*0.5;
      bot.vky=(bot.vky||0)+(data.ky||0)*0.5;
      if(bot.hp<=0){
        bot.respawnAt=Date.now()+6000;
        const bounty = Math.max(50, Math.floor(bot.level * 80 + bot.xp * 0.4));
        socket.emit('killed',{from:bot.id, bot:true, xpBounty: bounty, victimXp: bot.xp, victimName: bot.name, victimLevel: bot.level});
      }
      return;
    }
    io.to(data.target).emit('hit',{...data,from:socket.id});
  });
  socket.on('killed',(data)=>{
    if(!data||!data.target) return;
    if(String(data.target).startsWith('bot-')){
      const room=rooms[socket.data.room]; if(!room) return;
      const bot=room.bots.find(b=>b.id===data.target);
      if(bot){
        const gain = data.xpBounty || 60;
        bot.xp+=gain;
        bot.level=levelFromXp(bot.xp);
      }
      return;
    }
    io.to(data.target).emit('killed',{
      from: socket.id,
      xpBounty: data.xpBounty,
      victimXp: data.victimXp,
      victimName: data.victimName,
      victimLevel: data.victimLevel
    });
  });

  socket.on('disconnect',(reason)=>{
    console.log('[disconnect]', socket.id, 'room:', socket.data.room, 'reason:', reason);
    if(socket.data.room){
      const rc=socket.data.room;
      socket.to(rc).emit('peerLeave',{id:socket.id});
      setTimeout(()=>{
        if(roomSize(rc)===0 && rooms[rc]){ clearInterval(rooms[rc].interval); delete rooms[rc]; }
      },1000);
    }
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('Blob Arena server listening on port '+PORT));
