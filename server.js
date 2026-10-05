const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const WORLD = 3600, OUTER_FOOD = 300, CENTER_FOOD = 70, CENTER_RADIUS = 520, KNOCK = 44;
const BOT_COUNT = 5;
// Danger zone: ~7 hp/sec at 120ms tick interval
const CENTER_DOT_PER_TICK = 0.84;

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

const TIERS = [
  { name:'Basic',  color:'#8888aa', speed:1.0, dmg:8,  aggro:190, cooldown:1900, startLevel:1, hp:50 },
  { name:'Basic',  color:'#88aa88', speed:1.0, dmg:8,  aggro:190, cooldown:1900, startLevel:1, hp:50 },
  { name:'Hunter', color:'#aa6688', speed:1.45,dmg:13, aggro:260, cooldown:1400, startLevel:2, hp:75 },
  { name:'Hunter', color:'#aa8866', speed:1.45,dmg:13, aggro:260, cooldown:1400, startLevel:2, hp:75 },
  { name:'Alpha',  color:'#ffaa33', speed:1.85,dmg:20, aggro:340, cooldown:1000, startLevel:4, hp:120 },
];

const rooms = {}; // code -> { bots, food, interval }

function makeBot(i){
  const tier=TIERS[i%TIERS.length];
  return {
    id:'bot-'+i, tier,
    x:200+Math.random()*(WORLD-400), y:200+Math.random()*(WORLD-400),
    tx:200+Math.random()*(WORLD-400), ty:200+Math.random()*(WORLD-400),
    level:tier.startLevel, xp:(tier.startLevel-1)*50, hp:tier.hp, maxHp:tier.hp,
    name:tier.name+(i+1), cooldownUntil:0, respawnAt:null,
    vkx:0, vky:0, // knockback velocity — ice sliding physics
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
  room.bots.forEach(b=>{
    if(b.respawnAt){
      if(now<b.respawnAt) return;
      b.respawnAt=null; b.level=b.tier.startLevel; b.xp=(b.tier.startLevel-1)*50; b.hp=b.tier.hp;
      b.x=200+Math.random()*(WORLD-400); b.y=200+Math.random()*(WORLD-400);
      b.vkx=0; b.vky=0;
    }

    // --- Danger zone: deal damage inside CENTER_RADIUS ---
    const distC=Math.hypot(b.x-WORLD/2,b.y-WORLD/2);
    if(distC<CENTER_RADIUS){
      b.hp=Math.max(0,b.hp-CENTER_DOT_PER_TICK);
      if(b.hp<=0 && !b.respawnAt){ b.respawnAt=now+8000; return; }
    }

    // --- Ice sliding: decay and apply knockback velocity ---
    b.vkx*=0.84; b.vky*=0.84;
    b.x=Math.min(WORLD,Math.max(0,b.x+b.vkx));
    b.y=Math.min(WORLD,Math.max(0,b.y+b.vky));

    const r=radiusFromLevel(b.level);
    let bestD=Infinity, bestX=null, bestY=null, bestType=null, bestRef=null, bestR=0;
    players.forEach(p=>{
      const d=Math.hypot(p.x-b.x,p.y-b.y), pr=radiusFromLevel(p.level||1);
      if(d<b.tier.aggro && pr<=r*1.25 && d<bestD){ bestD=d; bestX=p.x; bestY=p.y; bestType='player'; bestRef=p; bestR=pr; }
    });
    room.bots.forEach(ob=>{
      if(ob===b||ob.respawnAt) return;
      const d=Math.hypot(ob.x-b.x,ob.y-b.y), obr=radiusFromLevel(ob.level);
      if(d<b.tier.aggro && obr<=r*1.25 && d<bestD){ bestD=d; bestX=ob.x; bestY=ob.y; bestType='bot'; bestRef=ob; bestR=obr; }
    });
    let pIdx=-1,pDist=Infinity,pTarget=null;
    room.food.forEach((f,i)=>{ if(f.eaten) return; const d=Math.hypot(f.x-b.x,f.y-b.y); if(d<420&&d<pDist){pDist=d;pIdx=i;pTarget=f;} });

    let mx=b.tx-b.x, my=b.ty-b.y;
    if(bestRef && bestD<b.tier.aggro){
      mx=bestX-b.x; my=bestY-b.y;
      if(bestD<r+bestR+6 && now>=b.cooldownUntil){
        b.cooldownUntil=now+b.tier.cooldown;
        const dx=(bestX-b.x)/(bestD||1), dy=(bestY-b.y)/(bestD||1);
        if(bestType==='player'){
          io.to(bestRef.id).emit('hit',{dmg:b.tier.dmg,byName:b.name,from:b.id,kx:dx*KNOCK,ky:dy*KNOCK});
        } else {
          bestRef.hp=Math.max(0,bestRef.hp-b.tier.dmg);
          // Velocity-based bot-on-bot knockback (smooth slide instead of instant teleport)
          bestRef.vkx=(bestRef.vkx||0)+dx*KNOCK*0.4;
          bestRef.vky=(bestRef.vky||0)+dy*KNOCK*0.4;
          if(bestRef.hp<=0 && !bestRef.respawnAt){ bestRef.respawnAt=now+8000; b.xp+=40; b.level=levelFromXp(b.xp); }
        }
      }
    } else if(pTarget){
      mx=pTarget.x-b.x; my=pTarget.y-b.y;
      if(pDist<r+10){
        pTarget.eaten=true; b.xp+=(pTarget.big?20:8); b.level=levelFromXp(b.xp);
        io.to(code).emit('food',{i:pIdx});
        respawnFood(code,pIdx,9000+Math.random()*6000);
      }
    } else {
      const wd=Math.hypot(b.tx-b.x,b.ty-b.y);
      if(wd<20){ b.tx=100+Math.random()*(WORLD-200); b.ty=100+Math.random()*(WORLD-200); }
    }
    const d=Math.hypot(mx,my)||1;
    // Frost Aura: players with it slow nearby bots
    let slow=1;
    players.forEach(p=>{ if(p.frost && Math.hypot(p.x-b.x,p.y-b.y)<radiusFromLevel(p.level||1)*(1+(p.bulk||0))+r+70) slow=0.65; });
    b.x=Math.min(WORLD,Math.max(0,b.x+(mx/d)*b.tier.speed*slow));
    b.y=Math.min(WORLD,Math.max(0,b.y+(my/d)*b.tier.speed*slow));
  });
  io.to(code).emit('bots', room.bots.map(b=>({id:b.id,x:b.x,y:b.y,level:b.level,hp:b.hp,maxHp:b.maxHp,name:b.name,color:b.tier.color,bulk:0,down:!!b.respawnAt})));
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
      // Velocity-based knockback — bot slides instead of teleporting
      bot.vkx=(bot.vkx||0)+(data.kx||0)*0.5;
      bot.vky=(bot.vky||0)+(data.ky||0)*0.5;
      if(bot.hp<=0){
        bot.respawnAt=Date.now()+8000;
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
