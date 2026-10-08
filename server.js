const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const WIDTH = 1200;
const HEIGHT = 760;

const rooms = new Map();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDiff(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function circleRectCollision(x, y, r, rect) {
  const cx = clamp(x, rect.x, rect.x + rect.w);
  const cy = clamp(y, rect.y, rect.y + rect.h);
  return Math.hypot(x - cx, y - cy) < r;
}

function segmentIntersectsRect(x1, y1, x2, y2, rect) {
  const left = rect.x, right = rect.x + rect.w;
  const top = rect.y, bottom = rect.y + rect.h;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - left, right - x1, y1 - top, bottom - y1];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

function createMap() {
  return {
    walls: [
      { x: 0, y: 0, w: WIDTH, h: 20 }, { x: 0, y: HEIGHT - 20, w: WIDTH, h: 20 },
      { x: 0, y: 0, w: 20, h: HEIGHT }, { x: WIDTH - 20, y: 0, w: 20, h: HEIGHT },
      { x: 420, y: 170, w: 360, h: 55 }, { x: 420, y: 170, w: 55, h: 180 },
      { x: 725, y: 170, w: 55, h: 180 }, { x: 100, y: 150, w: 180, h: 45 },
      { x: 100, y: 150, w: 45, h: 170 }, { x: 235, y: 150, w: 45, h: 170 },
      { x: 920, y: 150, w: 180, h: 45 }, { x: 920, y: 150, w: 45, h: 170 },
      { x: 1055, y: 150, w: 45, h: 170 }, { x: 100, y: 565, w: 180, h: 45 },
      { x: 100, y: 610, w: 45, h: 70 }, { x: 235, y: 610, w: 45, h: 70 },
      { x: 920, y: 565, w: 180, h: 45 }, { x: 920, y: 610, w: 45, h: 70 },
      { x: 1055, y: 610, w: 45, h: 70 }
    ],
    corridors: [
      { x: 300, y: 330, w: 120, h: 40 }, { x: 780, y: 330, w: 120, h: 40 },
      { x: 300, y: 430, w: 120, h: 40 }, { x: 780, y: 430, w: 120, h: 40 }
    ],
    step: { x: 460, y: 350, w: 280, h: 65 },
    floorDamage: [
      { id: "f1", x: 270, y: 225, w: 120, h: 120, damage: 0, maxDamage: 100, state: "normal" },
      { id: "f2", x: 810, y: 225, w: 120, h: 120, damage: 0, maxDamage: 100, state: "normal" },
      { id: "f3", x: 270, y: 550, w: 120, h: 120, damage: 0, maxDamage: 100, state: "normal" },
      { id: "f4", x: 810, y: 550, w: 120, h: 120, damage: 0, maxDamage: 100, state: "normal" },
      { id: "f5", x: 440, y: 500, w: 120, h: 110, damage: 0, maxDamage: 100, state: "normal" },
      { id: "f6", x: 640, y: 500, w: 120, h: 110, damage: 0, maxDamage: 100, state: "normal" }
    ],
    pillars: [
      { id: "p1", x: 390, y: 250, r: 17, hp: 45, maxHp: 45, fallen: false },
      { id: "p2", x: 810, y: 250, r: 17, hp: 45, maxHp: 45, fallen: false },
      { id: "p3", x: 390, y: 510, r: 17, hp: 45, maxHp: 45, fallen: false },
      { id: "p4", x: 810, y: 510, r: 17, hp: 45, maxHp: 45, fallen: false },
      { id: "p5", x: 500, y: 460, r: 17, hp: 45, maxHp: 45, fallen: false },
      { id: "p6", x: 700, y: 460, r: 17, hp: 45, maxHp: 45, fallen: false }
    ],
    screens: [
      { x: 330, y: 390, w: 100, h: 18 }, { x: 770, y: 390, w: 100, h: 18 },
      { x: 550, y: 275, w: 100, h: 18 }
    ],
    crates: [
      { id: "c1", x: 320, y: 120, w: 38, h: 38, hp: 25, maxHp: 25 },
      { id: "c2", x: 842, y: 120, w: 38, h: 38, hp: 25, maxHp: 25 },
      { id: "c3", x: 320, y: 475, w: 38, h: 38, hp: 25, maxHp: 25 },
      { id: "c4", x: 842, y: 475, w: 38, h: 38, hp: 25, maxHp: 25 }
    ]
  };
}

function newPlayer(id, type) {
  const base = {
    id, type,
    x: type === "wei" ? 210 : 990, y: 650,
    r: type === "wei" ? 18 : 20,
    hp: type === "wei" ? 100 : 120,
    maxHp: type === "wei" ? 100 : 120,
    speed: type === "wei" ? 4.5 : 3.7,
    angle: -Math.PI / 2,
    input: { up:false, down:false, left:false, right:false, attack:false, special:false, escape:false },
    specialCooldown: 0,
    movementMode: "ground",
    attackCooldown: 0
  };
  if (type === "wei") {
    Object.assign(base, { shenXing:120, shenXingMax:120, invincible:0, escapes:3 });
  } else {
    Object.assign(base, { shenfa:100, shenfaMax:100, wallRunTimer:0, airTimer:0 });
  }
  return base;
}

function createRoom(roomId) {
  return { id: roomId, map: createMap(), players: new Map(), started: false };
}

function getOpponent(room, player) {
  if (!room || !player) return null;
  for (const p of room.players.values()) if (p.id !== player.id && p.hp > 0) return p;
  return null;
}

function getSolidRects(room) {
  const rects = [...room.map.walls, ...room.map.screens];
  for (const crate of room.map.crates) if (crate.hp > 0) rects.push(crate);
  for (const floor of room.map.floorDamage) if (floor.state === "collapsed") rects.push(floor);
  return rects;
}

function collidesMap(room, x, y, r) {
  for (const rect of getSolidRects(room)) if (circleRectCollision(x,y,r,rect)) return true;
  for (const pillar of room.map.pillars) {
    if (!pillar.fallen && Math.hypot(x-pillar.x,y-pillar.y) < r + pillar.r) return true;
  }
  return false;
}

function moveGround(room, player, dx, dy) {
  const oldX = player.x, oldY = player.y;
  const nx = clamp(player.x + dx, player.r + 20, WIDTH - player.r - 20);
  const ny = clamp(player.y + dy, player.r + 20, HEIGHT - player.r - 20);
  if (!collidesMap(room,nx,ny,player.r)) { player.x=nx; player.y=ny; return true; }
  if (!collidesMap(room,nx,oldY,player.r)) player.x=nx;
  if (!collidesMap(room,player.x,ny,player.r)) player.y=ny;
  return player.x !== oldX || player.y !== oldY;
}

function hasLineOfSight(room,a,b) {
  if (!a || !b) return false;
  const objects = [...room.map.walls, ...room.map.screens];
  for (const crate of room.map.crates) if (crate.hp > 0) objects.push(crate);
  for (const obj of objects) if (segmentIntersectsRect(a.x,a.y,b.x,b.y,obj)) return false;
  return true;
}

function getFloorFromPillar(room,pillar) {
  let nearest=null, nearestDistance=Infinity;
  for (const floor of room.map.floorDamage) {
    const d=Math.hypot(pillar.x-(floor.x+floor.w/2),pillar.y-(floor.y+floor.h/2));
    if(d<nearestDistance){nearestDistance=d;nearest=floor;}
  }
  return nearest;
}

function damageFloor(room,floor,amount) {
  if(!floor || floor.state==="collapsed") return false;
  floor.damage += amount;
  if(floor.damage>=floor.maxDamage){floor.damage=floor.maxDamage;floor.state="collapsed";return true;}
  if(floor.damage>=55) floor.state="cracked";
  return false;
}

function damagePillar(room,pillar,amount) {
  if(!pillar || pillar.fallen) return false;
  pillar.hp -= amount;
  if(pillar.hp>0) return false;
  pillar.hp=0; pillar.fallen=true;
  const floor=getFloorFromPillar(room,pillar);
  if(floor) damageFloor(room,floor,90);
  return true;
}

function damageEnvironmentFromAttack(room,attacker) {
  if(!room || !attacker || attacker.type!=="hai") return;
  for(const pillar of room.map.pillars){
    if(pillar.fallen) continue;
    const dx=pillar.x-attacker.x, dy=pillar.y-attacker.y, d=Math.hypot(dx,dy);
    if(d>100+pillar.r) continue;
    if(angleDiff(Math.atan2(dy,dx),attacker.angle)>Math.PI*.65) continue;
    if(!hasLineOfSight(room,attacker,{x:pillar.x,y:pillar.y})) continue;
    damagePillar(room,pillar,15);
  }
}

function getNearbyWall(room,player,maxDistance=35) {
  let best=null,bestDistance=Infinity;
  for(const wall of room.map.walls){
    const cx=clamp(player.x,wall.x,wall.x+wall.w), cy=clamp(player.y,wall.y,wall.y+wall.h);
    const d=Math.hypot(player.x-cx,player.y-cy);
    if(d<=maxDistance && d<bestDistance){best=wall;bestDistance=d;}
  }
  return best;
}

function enterHaiWallRun(room,player){
  if(player.type!=="hai" || player.shenfa<10) return false;
  if(!getNearbyWall(room,player,32)) return false;
  player.movementMode="wallrun"; player.wallRunTimer=28; player.shenfa-=10; return true;
}

function updateHaiWallRun(room,player){
  if(player.wallRunTimer<=0){player.movementMode="ground";return false;}
  player.wallRunTimer--;
  let dx=0,dy=0;
  if(player.input.left)dx--; if(player.input.right)dx++; if(player.input.up)dy--; if(player.input.down)dy++;
  if(dx===0&&dy===0){player.wallRunTimer=0;player.movementMode="ground";return false;}
  const len=Math.hypot(dx,dy); dx/=len; dy/=len;
  moveGround(room,player,dx*player.speed*1.45,dy*player.speed*1.45);
  player.angle=Math.atan2(dy,dx); return true;
}

function updateHaiAir(room,player){
  if(player.airTimer<=0)return false;
  player.airTimer--;
  let dx=0,dy=0;
  if(player.input.left)dx--; if(player.input.right)dx++; if(player.input.up)dy--; if(player.input.down)dy++;
  if(dx!==0||dy!==0){const len=Math.hypot(dx,dy);dx/=len;dy/=len;moveGround(room,player,dx*player.speed*1.25,dy*player.speed*1.25);player.angle=Math.atan2(dy,dx);}
  if(player.airTimer<=0)player.movementMode="ground";
  return true;
}

function getNearbyPillar(room,player,maxDistance=60){
  let best=null,bestDistance=Infinity;
  for(const pillar of room.map.pillars){
    if(pillar.fallen)continue;
    const d=Math.hypot(player.x-pillar.x,player.y-pillar.y);
    if(d<=maxDistance&&d<bestDistance){best=pillar;bestDistance=d;}
  }
  return best;
}

function haiPillarTurn(room,player){
  if(player.type!=="hai"||player.shenfa<8)return false;
  const pillar=getNearbyPillar(room,player,55);
  if(!pillar)return false;
  player.angle=normalizeAngle(Math.atan2(pillar.y-player.y,pillar.x-player.x)+Math.PI/2);
  player.shenfa-=8; player.movementMode="pillar"; player.airTimer=8; return true;
}

function haiVault(room,player){
  if(player.type!=="hai"||player.shenfa<12)return false;
  const dx=Math.cos(player.angle),dy=Math.sin(player.angle);
  if(!collidesMap(room,player.x+dx*35,player.y+dy*35,player.r))return false;
  const nx=player.x+dx*70,ny=player.y+dy*70;
  if(collidesMap(room,nx,ny,player.r))return false;
  player.shenfa-=12;player.x=nx;player.y=ny;player.movementMode="vault";player.airTimer=10;return true;
}

function updateHai(room,player){
  if(player.shenfa<player.shenfaMax)player.shenfa+=0.35;
  if(updateHaiAir(room,player))return;
  if(player.movementMode==="wallrun"&&updateHaiWallRun(room,player))return;

  let dx=0,dy=0;
  if(player.input.left)dx--;if(player.input.right)dx++;if(player.input.up)dy--;if(player.input.down)dy++;
  if(dx!==0||dy!==0){const len=Math.hypot(dx,dy);dx/=len;dy/=len;player.angle=Math.atan2(dy,dx);moveGround(room,player,dx*player.speed,dy*player.speed);player.movementMode="ground";}

  if(player.input.special&&player.specialCooldown<=0)useHaiSpecial(room,player);
  if(player.input.attack&&player.attackCooldown<=0){attack(room,player,getOpponent(room,player));player.attackCooldown=8;}
  if(player.attackCooldown>0)player.attackCooldown--;

  if((player.input.up||player.input.down||player.input.left||player.input.right)&&player.shenfa>=10&&getNearbyWall(room,player,30))enterHaiWallRun(room,player);
  if((player.input.left||player.input.right)&&player.shenfa>=8)haiPillarTurn(room,player);
  if(player.input.up&&player.shenfa>=12)haiVault(room,player);
}

function updateWei(room,player){
  if(player.shenXing<player.shenXingMax)player.shenXing+=0.45;
  if(player.invincible>0)player.invincible--;
  let dx=0,dy=0;
  if(player.input.left)dx--;if(player.input.right)dx++;if(player.input.up)dy--;if(player.input.down)dy++;
  if(dx!==0||dy!==0){const len=Math.hypot(dx,dy);dx/=len;dy/=len;player.angle=Math.atan2(dy,dx);moveGround(room,player,dx*player.speed,dy*player.speed);player.movementMode="ground";}
  if(player.input.special&&player.specialCooldown<=0)useWeiSpecial(room,player);
  if(player.input.escape)useWeiEscape(room,player);
  if(player.input.attack&&player.attackCooldown<=0){attack(room,player,getOpponent(room,player));player.attackCooldown=8;}
  if(player.attackCooldown>0)player.attackCooldown--;
}

function getWeiDaggerDamage(attacker,target){
  const diff=angleDiff(Math.atan2(attacker.y-target.y,attacker.x-target.x),target.angle);
  if(diff<=Math.PI*.30)return 18;
  if(diff<=Math.PI*.65)return 24;
  return 30;
}

function attackPlayer(room,attacker,target){
  if(!room||!attacker||!target||attacker.hp<=0||target.hp<=0)return false;
  if(target.invincible>0)return false;
  const attackRange=attacker.type==="wei"?82:105;
  if(distance(attacker,target)>attackRange)return false;
  if(!hasLineOfSight(room,attacker,target))return false;
  let damage=attacker.type==="wei"?getWeiDaggerDamage(attacker,target):17;
  if(attacker.type==="hai"&&["wallrun","air","pillar","vault"].includes(attacker.movementMode))damage+=4;
  target.hp=Math.max(0,target.hp-damage); return true;
}

function attackCrates(room,attacker){
  for(const crate of room.map.crates){
    if(crate.hp<=0)continue;
    const cx=crate.x+crate.w/2,cy=crate.y+crate.h/2,d=Math.hypot(cx-attacker.x,cy-attacker.y);
    if(d>90||angleDiff(Math.atan2(cy-attacker.y,cx-attacker.x),attacker.angle)>Math.PI*.7)continue;
    crate.hp=Math.max(0,crate.hp-10);return true;
  }
  return false;
}

function attack(room,attacker,target){
  if(!room||!attacker||attacker.hp<=0)return false;
  if(target)attackPlayer(room,attacker,target);
  attackCrates(room,attacker);
  damageEnvironmentFromAttack(room,attacker);
  return true;
}

function useWeiSpecial(room,player){
  if(!room||!player||player.specialCooldown>0||player.shenXing<35)return false;
  player.shenXing-=35;player.specialCooldown=300;player.invincible=45;player.movementMode="shenxing";return true;
}

function useWeiEscape(room,player){
  if(!room||!player||player.escapes<=0||player.hp<=0)return false;
  player.input.escape=false;player.escapes--;player.invincible=35;
  const dx=Math.cos(player.angle),dy=Math.sin(player.angle);
  for(let i=0;i<8;i++){const nx=player.x+dx*18,ny=player.y+dy*18;if(collidesMap(room,nx,ny,player.r))break;player.x=nx;player.y=ny;}
  player.movementMode="escape";return true;
}

function useHaiSpecial(room,player){
  if(!room||!player||player.specialCooldown>0)return false;
  const target=getOpponent(room,player);if(!target)return false;
  player.specialCooldown=180;
  const d=distance(player,target);
  if(d<=150&&hasLineOfSight(room,player,target)){
    let damage=22;
    if(["wallrun","air","pillar","vault"].includes(player.movementMode))damage+=4;
    if(target.invincible<=0)target.hp=Math.max(0,target.hp-damage);
  }
  for(const pillar of room.map.pillars){
    if(pillar.fallen)continue;
    const dx=pillar.x-player.x,dy=pillar.y-player.y,d2=Math.hypot(dx,dy);
    if(d2>125||angleDiff(Math.atan2(dy,dx),player.angle)>Math.PI*.7)continue;
    damagePillar(room,pillar,25);
  }
  return true;
}

function updateCooldowns(player){
  if(player.specialCooldown>0)player.specialCooldown--;
  if(player.type==="wei"&&player.invincible>0)player.invincible--;
}

function serializePlayer(player){
  return {
    id:player.id,type:player.type,x:player.x,y:player.y,r:player.r,hp:player.hp,maxHp:player.maxHp,angle:player.angle,
    specialCooldown:player.specialCooldown,shenXing:player.shenXing,shenXingMax:player.shenXingMax,shenfa:player.shenfa,
    shenfaMax:player.shenfaMax,escapes:player.escapes,invincible:player.invincible,movementMode:player.movementMode,
    wallRunTimer:player.wallRunTimer,airTimer:player.airTimer
  };
}

function serializeRoom(room){
  return {
    id:room.id,width:WIDTH,height:HEIGHT,
    players:Array.from(room.players.values()).map(serializePlayer),
    map:{walls:room.map.walls,corridors:room.map.corridors,step:room.map.step,floorDamage:room.map.floorDamage,pillars:room.map.pillars,screens:room.map.screens,crates:room.map.crates}
  };
}

function resetRoom(room){
  room.map=createMap();
  let index=0;
  for(const player of room.players.values()){
    const fresh=newPlayer(player.id,player.type);
    if(index===0){fresh.x=210;fresh.y=650;}else{fresh.x=990;fresh.y=650;}
    room.players.set(player.id,fresh);index++;
  }
  room.started=room.players.size>=2;
}

function gameLoop(){
  for(const room of rooms.values()){
    if(room.players.size===0)continue;
    for(const player of room.players.values()){
      if(player.hp<=0)continue;
      if(player.type==="wei")updateWei(room,player);else updateHai(room,player);
      updateCooldowns(player);
    }
    const players=Array.from(room.players.values());
    const alive=players.filter(p=>p.hp>0);
    if(room.started&&players.length>=2&&alive.length<=1)room.started=false;
    io.to(room.id).emit("state",serializeRoom(room));
  }
}

io.on("connection",socket=>{
  console.log("玩家連線：",socket.id);
  socket.on("joinRoom",data=>{
    const roomId=data&&data.roomId?String(data.roomId):"紫禁城";
    const type=data&&data.type==="hai"?"hai":"wei";
    let room=rooms.get(roomId);
    if(!room){room=createRoom(roomId);rooms.set(roomId,room);}
    if(room.players.size>=2){socket.emit("roomFull");return;}
    for(const p of room.players.values())if(p.type===type){socket.emit("roleTaken",{type});return;}
    const player=newPlayer(socket.id,type);
    room.players.set(socket.id,player);socket.join(roomId);socket.data.roomId=roomId;
    room.started=room.players.size>=2;
    socket.emit("joined",{roomId,type,playerId:socket.id});
    io.to(room.id).emit("state",serializeRoom(room));
  });
  socket.on("input",input=>{
    const room=rooms.get(socket.data.roomId);
    if(!room||!input)return;
    const player=room.players.get(socket.id);
    if(!player)return;
    player.input.up=!!input.up;player.input.down=!!input.down;player.input.left=!!input.left;player.input.right=!!input.right;
    player.input.attack=!!input.attack;player.input.special=!!input.special;
    if(input.escape)player.input.escape=true;
  });
  socket.on("restart",()=>{
    const room=rooms.get(socket.data.roomId);if(!room)return;
    resetRoom(room);io.to(room.id).emit("state",serializeRoom(room));
  });
  socket.on("disconnect",()=>{
    const roomId=socket.data.roomId;if(!roomId)return;
    const room=rooms.get(roomId);if(!room)return;
    room.players.delete(socket.id);
    if(room.players.size===0)rooms.delete(roomId);
    else{room.started=false;io.to(room.id).emit("state",serializeRoom(room));}
  });
});

const html = `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><title>韋小寶 vs 海大富</title>
<style>*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111;color:white;font-family:Arial,"Noto Sans TC",sans-serif;touch-action:none}body{display:flex;flex-direction:column}#topbar{height:52px;flex-shrink:0;padding:6px 10px;display:flex;align-items:center;justify-content:space-between;background:#191919;border-bottom:1px solid #444;z-index:20}#title{font-size:17px;font-weight:bold;white-space:nowrap}#controls{display:flex;align-items:center;gap:5px}#controls input,#controls select,#controls button{height:34px;border-radius:6px;border:1px solid #555;background:#292929;color:white;padding:0 8px}#roomInput{width:90px}#gameWrap{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#151515}canvas{display:block;max-width:100%;max-height:100%;background:#27221b;touch-action:none}#hud{position:absolute;left:10px;top:10px;z-index:10;padding:8px 11px;border-radius:8px;background:rgba(0,0,0,.62);pointer-events:none;line-height:1.45;min-width:175px}#hudTitle{font-weight:bold}#cdText{font-weight:bold}#roomInfo{font-size:11px;color:#bbb}#message{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;padding:14px 22px;border-radius:10px;background:rgba(0,0,0,.78);font-size:22px;font-weight:bold;display:none;text-align:center;pointer-events:none}#mobileControls{position:absolute;inset:0;z-index:15;pointer-events:none;display:none}#joystick{position:absolute;left:24px;bottom:24px;width:150px;height:150px;border-radius:50%;background:rgba(255,255,255,.10);border:2px solid rgba(255,255,255,.25);pointer-events:auto;touch-action:none}#joystickKnob{position:absolute;left:50%;top:50%;width:64px;height:64px;margin-left:-32px;margin-top:-32px;border-radius:50%;background:rgba(255,255,255,.30);border:2px solid rgba(255,255,255,.55);pointer-events:none}.actionButton{position:absolute;border-radius:50%;display:flex;align-items:center;justify-content:center;user-select:none;-webkit-user-select:none;pointer-events:auto;touch-action:none;font-weight:bold;color:white;border:2px solid rgba(255,255,255,.45);background:rgba(30,30,30,.72);box-shadow:0 4px 10px rgba(0,0,0,.35)}.actionButton:active{background:rgba(120,120,120,.75);transform:scale(.94)}#attackButton{width:82px;height:82px;right:28px;bottom:34px;font-size:22px}#specialButton{width:68px;height:68px;right:122px;bottom:112px;font-size:17px}#escapeButton{width:60px;height:60px;right:150px;bottom:30px;font-size:15px}#specialCooldown{position:absolute;right:136px;bottom:178px;pointer-events:none;font-size:12px;background:rgba(0,0,0,.65);padding:3px 6px;border-radius:5px}@media (max-width:899px){#mobileControls{display:block}#controls input{width:65px}#controls select{width:82px}#controls button{padding:0 7px}#title{font-size:14px}}@media (orientation:portrait){#message::after{content:"建議將手機橫向使用"}}</style></head>
<body><div id="topbar"><div id="title">韋小寶 vs 海大富</div><div id="controls"><input id="roomInput" value="紫禁城" placeholder="房間"><select id="roleSelect"><option value="wei">韋小寶</option><option value="hai">海大富</option></select><button id="joinBtn">加入</button><button id="restartBtn">重開</button></div></div>
<div id="gameWrap"><canvas id="game"></canvas><div id="hud"><div id="hudTitle">尚未加入</div><div id="status">HP：-</div><div id="cdText">武學：Ready</div><div id="roomInfo">房間：-</div></div><div id="message"></div>
<div id="mobileControls"><div id="joystick"><div id="joystickKnob"></div></div><div class="actionButton" id="attackButton">攻</div><div class="actionButton" id="specialButton">技</div><div class="actionButton" id="escapeButton">逃</div><div id="specialCooldown">Ready</div></div></div>
<script src="/socket.io/socket.io.js"></script><script>
const socket=io(),canvas=document.getElementById("game"),ctx=canvas.getContext("2d"),roomInput=document.getElementById("roomInput"),roleSelect=document.getElementById("roleSelect"),joinBtn=document.getElementById("joinBtn"),restartBtn=document.getElementById("restartBtn"),hudTitle=document.getElementById("hudTitle"),status=document.getElementById("status"),cdText=document.getElementById("cdText"),roomInfo=document.getElementById("roomInfo"),message=document.getElementById("message"),joystick=document.getElementById("joystick"),joystickKnob=document.getElementById("joystickKnob"),attackButton=document.getElementById("attackButton"),specialButton=document.getElementById("specialButton"),escapeButton=document.getElementById("escapeButton"),specialCooldown=document.getElementById("specialCooldown");
let roomState=null,myId=null,myType=null;
const input={up:false,down:false,left:false,right:false,attack:false,special:false,escape:false};
function resizeCanvas(){const wrap=document.getElementById("gameWrap"),w=wrap.clientWidth,h=wrap.clientHeight,ratio=1200/760;let cw=w,ch=cw/ratio;if(ch>h){ch=h;cw=ch*ratio}canvas.width=Math.max(1,Math.floor(cw));canvas.height=Math.max(1,Math.floor(ch))}
window.addEventListener("resize",resizeCanvas);resizeCanvas();
function sx(x){return x*canvas.width/1200}function sy(y){return y*canvas.height/760}
function worldToScreen(x,y){return{x:sx(x),y:sy(y)}}
function sendInput(){socket.emit("input",input)}setInterval(sendInput,50);
joinBtn.addEventListener("click",()=>{const roomId=roomInput.value.trim()||"紫禁城";socket.emit("joinRoom",{roomId,type:roleSelect.value})});
restartBtn.addEventListener("click",()=>socket.emit("restart"));
socket.on("joined",data=>{myId=data.playerId;myType=data.type;attackButton.textContent=myType==="wei"?"匕":"攻";message.style.display="none"});
socket.on("roomFull",()=>{message.textContent="房間已滿";message.style.display="block"});
socket.on("roleTaken",data=>{message.textContent=data.type==="wei"?"韋小寶已有人使用":"海大富已有人使用";message.style.display="block"});
socket.on("state",state=>{roomState=state;const me=state.players.find(p=>p.id===myId);if(!me)return;hudTitle.textContent=me.type==="wei"?"你：韋小寶":"你：海大富";status.textContent="HP："+Math.ceil(me.hp)+" / "+me.maxHp;const seconds=(me.specialCooldown/20).toFixed(1);cdText.textContent=me.specialCooldown<=0?(me.type==="wei"?"玄鐵匕首｜武學：Ready":"武學：Ready"):(me.type==="wei"?"玄鐵匕首｜武學：CD "+seconds+"s":"武學：CD "+seconds+"s");specialCooldown.textContent=me.specialCooldown<=0?"Ready":seconds+"s";roomInfo.textContent="房間："+state.id+"｜"+me.movementMode+(me.type==="wei"?"｜神行 "+Math.floor(me.shenXing)+"｜逃跑 "+me.escapes:"｜身法 "+Math.floor(me.shenfa))});
function drawRect(r,fill,stroke){ctx.fillStyle=fill;ctx.fillRect(sx(r.x),sy(r.y),sx(r.w),sy(r.h));if(stroke){ctx.strokeStyle=stroke;ctx.strokeRect(sx(r.x),sy(r.y),sx(r.w),sy(r.h))}}
function drawMap(map){ctx.fillStyle="#30291f";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle="rgba(255,255,255,.035)";ctx.lineWidth=1;for(let x=20;x<1200;x+=40){ctx.beginPath();ctx.moveTo(sx(x),sy(20));ctx.lineTo(sx(x),sy(740));ctx.stroke()}for(let y=20;y<740;y+=40){ctx.beginPath();ctx.moveTo(sx(20),sy(y));ctx.lineTo(sx(1180),sy(y));ctx.stroke()}for(const floor of map.floorDamage){ctx.fillStyle=floor.state==="normal"?"rgba(120,90,60,.38)":floor.state==="cracked"?"rgba(120,80,50,.48)":"rgba(10,10,10,.92)";ctx.fillRect(sx(floor.x),sy(floor.y),sx(floor.w),sy(floor.h));if(floor.state==="cracked"){ctx.strokeStyle="rgba(220,180,120,.8)";ctx.lineWidth=2;for(let i=0;i<4;i++){ctx.beginPath();ctx.moveTo(sx(floor.x+floor.w*(.15+i*.2)),sy(floor.y));ctx.lineTo(sx(floor.x+floor.w*(.1+i*.2)),sy(floor.y+floor.h*.4));ctx.lineTo(sx(floor.x+floor.w*(.2+i*.17)),sy(floor.y+floor.h));ctx.stroke()}}if(floor.state==="collapsed"){ctx.strokeStyle="rgba(0,0,0,.9)";ctx.lineWidth=3;ctx.strokeRect(sx(floor.x),sy(floor.y),sx(floor.w),sy(floor.h))}}for(const c of map.corridors)drawRect(c,"#493d2d","#6b5a42");drawRect(map.step,"#5c4b36","#8a7352");for(const wall of map.walls)drawRect(wall,"#68543c","#a0845d");for(const screen of map.screens)drawRect(screen,"#4c2025","#b98a67");for(const crate of map.crates){if(crate.hp<=0)continue;drawRect(crate,"#78562e","#c0924e");const hp=crate.hp/crate.maxHp;ctx.fillStyle="#111";ctx.fillRect(sx(crate.x),sy(crate.y-7),sx(crate.w),4);ctx.fillStyle="#ddd";ctx.fillRect(sx(crate.x),sy(crate.y-7),sx(crate.w*hp),4)}for(const pillar of map.pillars){const p=worldToScreen(pillar.x,pillar.y);if(pillar.fallen){ctx.save();ctx.translate(p.x,p.y);ctx.rotate(Math.PI/2);ctx.fillStyle="#75634c";ctx.fillRect(-sx(25),-sy(8),sx(50),sy(16));ctx.restore();continue}ctx.beginPath();ctx.arc(p.x,p.y,sx(pillar.r),0,Math.PI*2);ctx.fillStyle="#8b7558";ctx.fill();ctx.strokeStyle="#c2a77b";ctx.lineWidth=2;ctx.stroke();const hp=pillar.hp/pillar.maxHp;ctx.fillStyle="rgba(0,0,0,.7)";ctx.fillRect(p.x-sx(22),p.y-sy(27),sx(44),5);ctx.fillStyle="#ddd";ctx.fillRect(p.x-sx(22),p.y-sy(27),sx(44*hp),5)}}
function drawPlayer(player){const p=worldToScreen(player.x,player.y),r=sx(player.r);ctx.save();if(player.invincible>0)ctx.globalAlpha=.55+.35*Math.sin(Date.now()/70);ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fillStyle=player.type==="wei"?"#d9a441":"#7e8aa8";ctx.fill();ctx.strokeStyle=player.type==="wei"?"#ffe49a":"#cbd5ff";ctx.lineWidth=2;ctx.stroke();ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+Math.cos(player.angle)*r*1.7,p.y+Math.sin(player.angle)*r*1.7);ctx.strokeStyle="#fff";ctx.lineWidth=3;ctx.stroke();if(player.type==="wei"){const daggerLength=r*1.25,daggerX=p.x+Math.cos(player.angle)*(r*.75),daggerY=p.y+Math.sin(player.angle)*(r*.75),tipX=daggerX+Math.cos(player.angle)*daggerLength,tipY=daggerY+Math.sin(player.angle)*daggerLength;ctx.beginPath();ctx.moveTo(daggerX,daggerY);ctx.lineTo(tipX,tipY);ctx.strokeStyle="#e6e6e6";ctx.lineWidth=3;ctx.stroke();ctx.beginPath();ctx.moveTo(daggerX-Math.sin(player.angle)*4,daggerY+Math.cos(player.angle)*4);ctx.lineTo(daggerX+Math.sin(player.angle)*4,daggerY-Math.cos(player.angle)*4);ctx.strokeStyle="#4b3020";ctx.lineWidth=4;ctx.stroke()}ctx.restore();const barW=sx(52),hp=Math.max(0,player.hp/player.maxHp);ctx.fillStyle="rgba(0,0,0,.75)";ctx.fillRect(p.x-barW/2,p.y-r-15,barW,6);ctx.fillStyle="#ddd";ctx.fillRect(p.x-barW/2,p.y-r-15,barW*hp,6);ctx.fillStyle="#fff";ctx.font="12px Arial";ctx.textAlign="center";ctx.fillText(player.type==="wei"?"韋小寶":"海大富",p.x,p.y+r+16)}
function draw(){requestAnimationFrame(draw);if(!roomState){ctx.fillStyle="#171717";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle="#ddd";ctx.font="24px Arial";ctx.textAlign="center";ctx.fillText("請先加入紫禁城",canvas.width/2,canvas.height/2);return}drawMap(roomState.map);for(const player of roomState.players)drawPlayer(player);const alive=roomState.players.filter(p=>p.hp>0);if(roomState.players.length>=2&&alive.length<=1){const winner=alive[0];message.textContent=winner?(winner.type==="wei"?"韋小寶勝利！":"海大富勝利！"):"雙方倒下";message.style.display="block"}else message.style.display="none"}draw();
const keyMap={w:"up",s:"down",a:"left",d:"right"};
window.addEventListener("keydown",e=>{const key=e.key.toLowerCase();if(keyMap[key])input[keyMap[key]]=true;if(key===" "||key==="j")input.attack=true;if(key==="k")input.special=true;if(key==="l"||key==="shift")input.escape=true});
window.addEventListener("keyup",e=>{const key=e.key.toLowerCase();if(keyMap[key])input[keyMap[key]]=false;if(key===" "||key==="j")input.attack=false;if(key==="k")input.special=false;if(key==="l"||key==="shift")input.escape=false});
let joystickPointerId=null;
function updateJoystick(clientX,clientY){const rect=joystick.getBoundingClientRect(),centerX=rect.left+rect.width/2,centerY=rect.top+rect.height/2;let dx=clientX-centerX,dy=clientY-centerY,maxDistance=rect.width/2-32,d=Math.hypot(dx,dy);if(d>maxDistance){dx=dx/d*maxDistance;dy=dy/d*maxDistance}joystickKnob.style.transform="translate("+dx+"px,"+dy+"px)";const threshold=maxDistance*.18;input.left=dx<-threshold;input.right=dx>threshold;input.up=dy<-threshold;input.down=dy>threshold}
function resetJoystick(){joystickPointerId=null;joystickKnob.style.transform="translate(0,0)";input.left=false;input.right=false;input.up=false;input.down=false}
joystick.addEventListener("pointerdown",e=>{e.preventDefault();joystickPointerId=e.pointerId;joystick.setPointerCapture(e.pointerId);updateJoystick(e.clientX,e.clientY)});
joystick.addEventListener("pointermove",e=>{if(e.pointerId!==joystickPointerId)return;e.preventDefault();updateJoystick(e.clientX,e.clientY)});
joystick.addEventListener("pointerup",e=>{if(e.pointerId!==joystickPointerId)return;e.preventDefault();resetJoystick()});
joystick.addEventListener("pointercancel",e=>{if(e.pointerId!==joystickPointerId)return;resetJoystick()});
function bindHoldButton(element,key){let pointerId=null;element.addEventListener("pointerdown",e=>{e.preventDefault();pointerId=e.pointerId;element.setPointerCapture(e.pointerId);input[key]=true});element.addEventListener("pointerup",e=>{if(e.pointerId!==pointerId)return;e.preventDefault();input[key]=false;pointerId=null});element.addEventListener("pointercancel",e=>{if(e.pointerId!==pointerId)return;input[key]=false;pointerId=null})}
bindHoldButton(attackButton,"attack");bindHoldButton(specialButton,"special");
escapeButton.addEventListener("pointerdown",e=>{e.preventDefault();input.escape=true});escapeButton.addEventListener("pointerup",e=>{e.preventDefault();input.escape=false});escapeButton.addEventListener("pointercancel",()=>{input.escape=false});
</script></body></html>`;

app.get("/", (req,res) => res.send(html));

// 啟動遊戲循環（原始程式碼缺少這一行）
setInterval(gameLoop, 50);

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
