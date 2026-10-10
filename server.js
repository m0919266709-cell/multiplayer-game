const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const rooms = new Map();
const WORLD = 18;
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const obstacles = [
  { x: -7, z: -2, w: 4.5, d: .4, h: 2.4, type: "screen" },
  { x: 7, z: 2, w: 4.5, d: .4, h: 2.4, type: "screen" },
  { x: 0, z: -8, w: 5, d: .4, h: 2.4, type: "screen" },
  { x: 0, z: 8, w: 5, d: .4, h: 2.4, type: "screen" },
  ...[[-10,-10],[10,-10],[-10,10],[10,10],[-3,-4],[3,4]]
    .map(([x,z]) => ({x,z,w:1.2,d:1.2,h:4.3,type:"pillar"})),
  {x:-13,z:0,w:1.5,d:1.5,h:1.2,type:"crate"},
  {x:13,z:0,w:1.5,d:1.5,h:1.2,type:"crate"}
];

const itemDefs = [
  {id:"lime", type:"lime", x:-9, z:-5, label:"石灰粉"},
  {id:"dart", type:"dart", x:8, z:-8, label:"飛鏢"},
  {id:"smoke", type:"smoke", x:0, z:10, label:"迷煙"},
  {id:"robe", type:"robe", x:-11, z:7, label:"寶衣"},
  {id:"dagger", type:"dagger", x:11, z:5, label:"匕首"}
];

function makePlayer(id, role, ai = false) {
  return {
    id, role, ai,
    x: role === "wei" ? -4 : 4,
    z: 12,
    yaw: role === "wei" ? 0 : Math.PI,
    hp: role === "wei" ? 100 : 125,
    maxHp: role === "wei" ? 100 : 125,
    stamina: 100,
    alive: true,
    input: {x:0,z:0},
    sprint: false,
    attack: false,
    block: false,
    jump: false,
    inventory: {lime:1,dart:2,smoke:1,robe:0,dagger:0},
    effect: "",
    effectUntil: 0,
    invulnerableUntil: 0,
    wallRunUntil: 0,
    wallRunCooldown: 0,
    lastAttack: 0,
    lastItem: 0,
    aiNext: 0,
    aiStrafe: 1,
    aiStrafeUntil: 0
  };
}

function makeRoom(mode) {
  return {
    id: Math.random().toString(36).slice(2,9),
    mode,
    players: [],
    started: false,
    winner: null,
    items: itemDefs.map(i => ({...i, active:true})),
    log: ["紫禁城對決即將開始。"]
  };
}

function getRoom(id) {
  for (const r of rooms.values()) {
    if (r.players.some(p => p.id === id)) return r;
  }
  return null;
}

function say(r, message) {
  r.log.push(message);
  if (r.log.length > 8) r.log.shift();
}

function snapshot(r) {
  return {
    roomId: r.id,
    mode: r.mode,
    started: r.started,
    winner: r.winner,
    players: r.players.map(p => ({
      id:p.id, role:p.role, ai:p.ai,
      x:p.x,z:p.z,yaw:p.yaw,
      hp:p.hp,maxHp:p.maxHp,
      stamina:p.stamina,alive:p.alive,
      inventory:p.inventory,effect:p.effect,
      wallRunUntil:p.wallRunUntil
    })),
    items:r.items.filter(i => i.active),
    log:r.log.slice(-5)
  };
}

function blocked(x,z,rad=.42) {
  if (Math.abs(x) > WORLD-rad || Math.abs(z) > WORLD-rad) {
    return true;
  }

  for (const o of obstacles) {
    if (
      Math.abs(x-o.x) < o.w/2+rad &&
      Math.abs(z-o.z) < o.d/2+rad
    ) return true;
  }
  return false;
}

function joinGame(socket, data = {}) {
  leaveGame(socket);

  const mode = data.mode === "online" ? "online" : "ai";
  let role = data.role === "hai" ? "hai" : "wei";
  let r;

  if (mode === "online") {
    r = [...rooms.values()].find(
      x => x.mode === "online" && !x.started && x.players.length < 2
    );

    if (!r) {
      r = makeRoom("online");
      rooms.set(r.id,r);
    }

    if (r.players.some(p => p.role === role)) {
      role = role === "wei" ? "hai" : "wei";
    }
  } else {
    r = makeRoom("ai");
    rooms.set(r.id,r);
  }

  r.players.push(makePlayer(socket.id,role));
  socket.join(r.id);
  socket.data.roomId = r.id;

  if (mode === "ai") {
    r.players.push(makePlayer(
      "AI-"+r.id, role === "wei" ? "hai" : "wei", true
    ));
    r.started = true;
    say(r, role === "wei"
      ? "你是韋小寶。利用身法與道具逃出生天！"
      : "你是海大富。運用輕功攔截韋小寶！");
  } else if (r.players.length === 2) {
    r.started = true;
    say(r,"兩名玩家已到齊，對決開始！");
  } else {
    say(r,"等待另一名玩家加入……");
  }

  socket.emit("joined", {
    id:socket.id, role, mode, roomId:r.id
  });
  io.to(r.id).emit("state",snapshot(r));
}

function leaveGame(socket) {
  const rid = socket.data.roomId;
  if (!rid) return;

  socket.leave(rid);
  socket.data.roomId = null;

  const r = rooms.get(rid);
  if (!r) return;

  r.players = r.players.filter(p => p.id !== socket.id);

  if (!r.players.length) {
    rooms.delete(rid);
  } else {
    r.started = false;
    say(r,"對手已離開。等待其他玩家加入。");
    io.to(rid).emit("state",snapshot(r));
  }
}

function movePlayer(p, dt) {
  if (!p.alive) return;

  const ix = p.input.x;
  const iz = p.input.z;
  const len = Math.hypot(ix,iz);
  const sprint = p.sprint && p.stamina > 1 && len > .1;

  let speed = p.role === "wei" ? 5.0 : 4.0;
  if (sprint) speed *= 1.45;
  if (p.wallRunUntil > now()) speed *= 1.55;

  if (sprint) p.stamina = Math.max(0,p.stamina-23*dt);
  else p.stamina = Math.min(100,p.stamina+14*dt);

  // 搖桿方向以第一人稱視角為基準。
  const forwardX = Math.sin(p.yaw);
  const forwardZ = Math.cos(p.yaw);
  const rightX = Math.cos(p.yaw);
  const rightZ = -Math.sin(p.yaw);

  const dx = (rightX*ix + forwardX*iz)*speed*dt;
  const dz = (rightZ*ix + forwardZ*iz)*speed*dt;

  if (!blocked(p.x+dx,p.z)) p.x += dx;
  if (!blocked(p.x,p.z+dz)) p.z += dz;

  if (p.jump && p.stamina >= 10) {
    p.stamina -= 10;
  }
  p.jump = false;

  if (
    p.role === "hai" &&
    sprint &&
    len > .1 &&
    p.wallRunCooldown < now()
  ) {
    for (const o of obstacles) {
      const nearX = Math.abs(p.x-o.x) < o.w/2+1.0;
      const nearZ = Math.abs(p.z-o.z) < o.d/2+1.0;

      if ((nearX || nearZ) && p.stamina >= 18) {
        p.wallRunUntil = now()+700;
        p.wallRunCooldown = now()+2400;
        p.stamina -= 18;
        const r = getRoom(p.id);
        if (r) say(r,"海大富施展貼牆輕功！");
        break;
      }
    }
  }
}

function aiThink(r,p,enemy) {
  if (!p.ai || !enemy || !enemy.alive) return;

  const d = distance(p,enemy);
  const dx = enemy.x-p.x;
  const dz = enemy.z-p.z;

  // AI 會朝對手轉向。
  p.yaw = Math.atan2(dx,dz);

  if (d > 2.0) {
    p.input.x = 0;
    p.input.z = -1;
    p.sprint = d > 5;
  } else {
    if (now() > p.aiStrafeUntil) {
      p.aiStrafe = Math.random() < .5 ? -1 : 1;
      p.aiStrafeUntil = now()+900;
    }
    p.input.x = p.aiStrafe;
    p.input.z = 0;
    p.sprint = false;
  }

  p.attack = d < 2.0 && now() > p.aiNext;
  p.block = d < 1.5 && Math.random() < .18;

  if (p.attack) p.aiNext = now()+850;
}

function act(r,p,enemy) {
  const t = now();

  if (
    p.attack &&
    t-p.lastAttack > 650 &&
    enemy && enemy.alive &&
    distance(p,enemy) < 2.15
  ) {
    p.lastAttack = t;

    if (enemy.block) {
      say(r,"對手擋下了攻擊！");
    } else if (enemy.invulnerableUntil > t) {
      say(r,"對手以身法避開攻擊！");
    } else {
      const dmg = p.inventory.dagger > 0
        ? 24
        : (p.role === "hai" ? 16 : 11);

      enemy.hp = Math.max(0,enemy.hp-dmg);
      enemy.invulnerableUntil = t+200;
      say(r,(p.role === "wei" ? "韋小寶" : "海大富")+
        "命中，造成 "+dmg+" 點傷害。");

      if (enemy.hp <= 0) {
        enemy.alive = false;
        r.winner = p.role;
        say(r,(p.role === "wei" ? "韋小寶" : "海大富")+"獲勝！");
      }
    }
    p.attack = false;
  }

  if (!p.useItem || t-p.lastItem < 500) return;

  const item = p.useItem;
  p.useItem = null;
  p.lastItem = t;

  if (!(p.inventory[item] > 0)) return;
  p.inventory[item]--;

  if (item === "lime" && enemy && distance(p,enemy) < 6) {
    enemy.effect = "石灰粉";
    enemy.effectUntil = t+2200;
    say(r,"石灰粉命中！對手短暫受阻。");
  } else if (item === "dart" && enemy && distance(p,enemy) < 9) {
    enemy.hp = Math.max(0,enemy.hp-12);
    say(r,"飛鏢命中，造成 12 點傷害。");
    if (enemy.hp <= 0) {
      enemy.alive = false;
      r.winner = p.role;
    }
  } else if (item === "smoke") {
    p.invulnerableUntil = t+1300;
    say(r,"迷煙散開，趁機改變位置！");
  } else if (item === "robe") {
    p.invulnerableUntil = t+2200;
    say(r,"寶衣暫時擋下攻擊！");
  } else if (item === "dagger") {
    say(r,"玄鐵匕首已備妥，近身攻擊更強！");
  } else {
    say(r,"道具已使用。");
  }
}

setInterval(() => {
  const dt = .05;

  for (const r of rooms.values()) {
    if (!r.started || r.winner) continue;
    if (r.players.length < 2) continue;

    for (const p of r.players) {
      const enemy = r.players.find(q => q.id !== p.id);
      aiThink(r,p,enemy);
      movePlayer(p,dt);
      act(r,p,enemy);

      if (p.effect && p.effectUntil < now()) p.effect = "";
    }

    for (const p of r.players) {
      for (const it of r.items) {
        if (it.active && distance(p,it) < 1.0) {
          it.active = false;
          p.inventory[it.type] = (p.inventory[it.type]||0)+1;
          say(r,(p.role === "wei" ? "韋小寶" : "海大富")+
            "取得"+it.label+"！");
        }
      }
    }

    io.to(r.id).emit("state",snapshot(r));
  }
},50);

app.get("/health",(req,res) => res.json({ok:true}));
app.get("/",(req,res) => res.type("html").send(HTML));

io.on("connection",socket => {
  socket.on("joinGame",data => joinGame(socket,data||{}));

  socket.on("input",data => {
    const r = rooms.get(socket.data.roomId);
    if (!r) return;
    const p = r.players.find(q => q.id === socket.id);
    if (!p) return;

    p.input = {
      x:clamp(Number(data.x)||0,-1,1),
      z:clamp(Number(data.z)||0,-1,1)
    };
    p.yaw = Number.isFinite(data.yaw) ? data.yaw : p.yaw;
    p.sprint = !!data.sprint;
    p.attack = !!data.attack;
    p.block = !!data.block;
    p.jump = !!data.jump;
    if (data.useItem) p.useItem = data.useItem;
  });

  socket.on("disconnect",() => leaveGame(socket));
});

const HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>紫禁城對決</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#080c14;color:#fff;font-family:system-ui,"Noto Sans TC",sans-serif;touch-action:none}
#game{position:fixed;inset:0}
canvas{display:block;width:100%;height:100%}
#menu{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:22px;background:radial-gradient(ellipse at center,#34435a 0,#111927 60%,#080b12 100%)}
.panel{width:min(500px,100%);padding:28px 24px;border:1px solid #c4a86b;border-radius:22px;background:linear-gradient(145deg,#202b3bee,#101722f5);box-shadow:0 20px 90px #000a;text-align:center}
h1{margin:0;color:#f0d59a;font-size:clamp(27px,6vw,43px);letter-spacing:3px}
.sub{color:#c5cbd4;line-height:1.7}
.row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:14px 0}
button{color:#fff;background:#253248;border:1px solid #8f805e;border-radius:12px;padding:12px 15px;font-size:14px;font-weight:700;touch-action:manipulation}
button.selected{background:linear-gradient(135deg,#b18a49,#74552b);border-color:#f2d69a}
#start{width:100%;padding:15px;background:linear-gradient(135deg,#c69d54,#80602d);font-size:17px}
#status{min-height:22px;color:#f1dba9;font-size:13px}
#hud{display:none;position:fixed;inset:0;z-index:3;pointer-events:none;text-shadow:0 2px 4px #000}
#top{position:absolute;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;gap:10px}
.card{width:min(185px,42vw);padding:10px 12px;border:1px solid #ffffff25;border-radius:13px;background:#0a101bdc;backdrop-filter:blur(9px)}
.name{font-size:13px;color:#f0d59a}
.bar{height:7px;margin:6px 0;background:#542d35;border-radius:8px;overflow:hidden}
.fill{height:100%;width:100%;background:linear-gradient(90deg,#a52d42,#f76d74);transition:width .15s}
.energy{background:linear-gradient(90deg,#237a5a,#65d5a1)}
.small{font-size:11px;color:#d5dae3}
#message{position:absolute;top:100px;left:50%;transform:translateX(-50%);padding:8px 14px;border:1px solid #ffffff22;border-radius:12px;background:#111827c9;font-size:13px;white-space:nowrap}
#feed{position:absolute;left:12px;top:145px;max-width:70%;font-size:12px;line-height:1.8;color:#ffe6b0}
#crosshair{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:12px;height:12px;border:1px solid #ffffffb0;border-radius:50%;box-shadow:0 0 8px #000}
#crosshair:after,#crosshair:before{content:"";position:absolute;background:#ffffffa0}
#crosshair:after{width:2px;height:18px;left:4px;top:-4px}
#crosshair:before{height:2px;width:18px;top:4px;left:-4px}
#mobile{display:none;position:absolute;inset:0;pointer-events:none}
#joystick{position:absolute;left:22px;bottom:26px;width:132px;height:132px;border:1px solid #ffffff70;border-radius:50%;background:radial-gradient(circle,#ffffff15,#0a102477);box-shadow:inset 0 0 22px #0007;pointer-events:auto;touch-action:none}
#stick{position:absolute;left:40px;top:40px;width:50px;height:50px;border:1px solid #ffffff8c;border-radius:50%;background:linear-gradient(145deg,#c5b58d,#62543f);box-shadow:0 4px 16px #0008;pointer-events:none}
#lookzone{position:absolute;left:38%;right:0;top:15%;bottom:30%;pointer-events:auto;touch-action:none}
#actions{position:absolute;right:14px;bottom:22px;display:grid;grid-template-columns:repeat(2,58px);gap:8px;pointer-events:auto}
.act{width:58px;height:49px;display:flex;align-items:center;justify-content:center;padding:4px;border:1px solid #ffffff5c;border-radius:15px;background:#111a2bd9;font-size:12px;backdrop-filter:blur(8px);touch-action:none}
.act.main{border-color:#d3b777;background:#73552fcf}
#hint{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);font-size:11px;color:#ffffffa0;white-space:nowrap}
@media(pointer:coarse),(max-width:700px){
 #mobile{display:block}
 #hint{display:none}
}
@media(max-width:380px){
 #joystick{width:112px;height:112px;left:12px;bottom:16px}
 #stick{left:31px;top:31px;width:48px;height:48px}
 #actions{right:8px;bottom:14px;grid-template-columns:repeat(2,51px);gap:6px}
 .act{width:51px;height:44px}
}
</style>
</head>
<body>
<div id="game"></div>

<div id="menu">
 <div class="panel">
  <h1>紫禁城對決</h1>
  <p class="sub">第一人稱武俠追逐與心理博弈<br>在宮牆、屏風與宮柱之間，決定誰能掌握局勢。</p>
  <div class="row">
   <button class="selected" data-mode="ai">單人挑戰</button>
   <button data-mode="online">雙人連線</button>
  </div>
  <div class="row">
   <button class="selected" data-role="wei">韋小寶</button>
   <button data-role="hai">海大富</button>
  </div>
  <button id="start">進入紫禁城</button>
  <p id="status">正在連線……</p>
  <div class="small">手機：左側搖桿移動，右側區域滑動轉向。</div>
 </div>
</div>

<div id="hud">
 <div id="top">
  <div class="card">
   <div class="name" id="myName">韋小寶</div>
   <div class="bar"><div class="fill" id="myHp"></div></div>
   <div class="bar"><div class="fill energy" id="myStamina"></div></div>
   <div class="small" id="myStats">HP 100 · 體力 100</div>
  </div>
  <div class="card" style="text-align:right">
   <div class="name" id="enemyName">海大富</div>
   <div class="bar"><div class="fill" id="enemyHp"></div></div>
   <div class="small" id="enemyStats">等待對手</div>
  </div>
 </div>
 <div id="message">對決開始</div>
 <div id="feed"></div>
 <div id="crosshair"></div>
 <div id="mobile">
  <div id="lookzone"></div>
  <div id="joystick"><div id="stick"></div></div>
  <div id="actions">
   <button class="act main" data-key="attack">攻擊</button>
   <button class="act" data-key="sprint">奔跑</button>
   <button class="act" data-key="jump">跳躍</button>
   <button class="act" data-key="block">防禦</button>
   <button class="act" data-item="lime">石灰粉</button>
   <button class="act" data-item="dart">飛鏢</button>
   <button class="act" data-item="smoke">迷煙</button>
   <button class="act" data-item="robe">寶衣</button>
   <button class="act" data-item="dagger">匕首</button>
  </div>
 </div>
 <div id="hint">WASD 移動 · 滑鼠轉向 · Shift 奔跑 · Space 跳躍 · 左鍵攻擊</div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.min.js"></script>
<script>
(()=>{
"use strict";
const $=id=>document.getElementById(id);
const socket=io();
let mode="ai",role="wei",meId=null,joined=false,state=null;
let scene,camera,renderer,clock;
let yaw=0,pitch=0,mouseLook=false;
const keys={},touch={};
const characters=new Map(),items3D=new Map();
const mats={};

function mat(color,roughness=.78,metalness=0){
 return new THREE.MeshStandardMaterial({color,roughness,metalness});
}
function box(w,h,d,m,x,y,z){
 const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);
 o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;
 scene.add(o);return o;
}

function initScene(){
 scene=new THREE.Scene();
 scene.background=new THREE.Color(0x111927);
 scene.fog=new THREE.Fog(0x111927,27,68);

 camera=new THREE.PerspectiveCamera(76,innerWidth/innerHeight,.08,100);
 renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.6));
 renderer.setSize(innerWidth,innerHeight);
 renderer.shadowMap.enabled=true;
 renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 $("game").appendChild(renderer.domElement);
 clock=new THREE.Clock();

 scene.add(new THREE.HemisphereLight(0xb7d3ef,0x493528,2.0));

 const moon=new THREE.DirectionalLight(0xffd7a0,2.5);
 moon.position.set(-9,19,7);
 moon.castShadow=true;
 moon.shadow.mapSize.set(1024,1024);
 scene.add(moon);

 mats.floor=mat(0x66615a);
 mats.wall=mat(0x564337);
 mats.roof=mat(0x8c2725);
 mats.gold=mat(0xc8a75e,.38,.3);
 mats.wood=mat(0x63402d);
 mats.screen=mat(0x852c2d);
 mats.pillar=mat(0x9b3430);
 mats.wei=mat(0x2d819c);
 mats.hai=mat(0x282631);
 mats.skin=mat(0xd6a17e);
 mats.stone=mat(0x8b8780);

 const floor=new THREE.Mesh(new THREE.PlaneGeometry(38,38),mats.floor);
 floor.rotation.x=-Math.PI/2;
 floor.receiveShadow=true;
 scene.add(floor);

 // 石板格線與宮廷地面裝飾。
 const grid=new THREE.GridHelper(36,36,0x9a8667,0x7a7268);
 grid.position.y=.012;
 grid.material.transparent=true;
 grid.material.opacity=.16;
 scene.add(grid);

 box(38,4,.8,mats.wall,0,2,-18);
 box(38,4,.8,mats.wall,0,2,18);
 box(.8,4,38,mats.wall,-18,2,0);
 box(.8,4,38,mats.wall,18,2,0);

 for(const z of [-18,18]){
  box(39,.3,1.2,mats.roof,0,4,z);
  box(39,.13,1.28,mats.gold,0,4.2,z);
  for(let x=-16;x<=16;x+=4){
   box(.3,1,.3,mats.gold,x,4.65,z);
  }
 }

 // 宮殿主殿與重簷。
 for(const z of [-14.5,14.5]){
  box(12,3,3,mats.wood,0,1.5,z);
  box(13,.4,4,mats.roof,0,3.15,z);
  box(13,.12,4.1,mats.gold,0,3.4,z);
  for(let x=-5;x<=5;x+=2.5){
   box(.2,2.5,.2,mats.gold,x,1.25,z);
  }
 }

 const obs=${JSON.stringify(obstacles)};
 for(const o of obs){
  if(o.type==="pillar"){
   const c=new THREE.Mesh(
    new THREE.CylinderGeometry(.52,.62,o.h,12),mats.pillar);
   c.position.set(o.x,o.h/2,o.z);
   c.castShadow=true;scene.add(c);
   const top=new THREE.Mesh(
    new THREE.CylinderGeometry(.7,.7,.2,12),mats.gold);
   top.position.set(o.x,o.h-.05,o.z);scene.add(top);
   const base=new THREE.Mesh(
    new THREE.CylinderGeometry(.72,.72,.18,12),mats.gold);
   base.position.set(o.x,.09,o.z);scene.add(base);
  }else if(o.type==="screen"){
   box(o.w,o.h,o.d,mats.screen,o.x,o.h/2,o.z);
   box(o.w+.1,.12,o.d+.1,mats.gold,o.x,o.h,o.z);
   box(o.w+.1,.12,o.d+.1,mats.gold,o.x,.08,o.z);
  }else{
   box(o.w,o.h,o.d,mats.wood,o.x,o.h/2,o.z);
  }
 }

 // 宮燈：暖色光源與金屬燈座。
 for(const [x,z] of [
  [-14,-5],[14,-5],[-14,5],[14,5],[-5,0],[5,0]
 ]){
  box(.28,1.7,.28,mats.wood,x,.85,z);
  box(.62,.12,.62,mats.gold,x,1.75,z);
  const glow=new THREE.Mesh(
   new THREE.SphereGeometry(.18,12,10),
   new THREE.MeshBasicMaterial({color:0xffc16b}));
  glow.position.set(x,2,z);scene.add(glow);
  const light=new THREE.PointLight(0xffa34d,3.5,8);
  light.position.set(x,2,z);scene.add(light);
 }

 // 地面中軸裝飾。
 for(let z=-12;z<=12;z+=4){
  const tile=box(2.5,.035,1.7,mats.stone,0,.025,z);
  tile.material=mat(0x81786a);
 }

 window.addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
 });

 animate();
}

function createCharacter(p){
 const g=new THREE.Group();
 const cloth=p.role==="wei"?mats.wei:mats.hai;
 const body=new THREE.Mesh(
  new THREE.CapsuleGeometry(.32,.78,4,8),cloth);
 body.position.y=1.03;g.add(body);
 const head=new THREE.Mesh(
  new THREE.SphereGeometry(.23,12,10),mats.skin);
 head.position.y=1.7;g.add(head);
 const hat=new THREE.Mesh(
  new THREE.CylinderGeometry(.23,.27,.12,10),
  p.role==="hai"?mats.hai:mats.gold);
 hat.position.y=1.95;g.add(hat);
 for(const side of [-1,1]){
  const arm=new THREE.Mesh(
   new THREE.BoxGeometry(.14,.5,.16),cloth);
  arm.position.set(side*.39,1.08,0);g.add(arm);
  const leg=new THREE.Mesh(
   new THREE.BoxGeometry(.17,.48,.19),mats.wood);
  leg.position.set(side*.14,.32,0);g.add(leg);
 }
 scene.add(g);
 return g;
}

function createItem(it){
 const colors={lime:0x9fe64d,dart:0xd2d8e1,
  smoke:0x9898ff,robe:0xe8ce82,dagger:0xd5e1ed};
 const g=new THREE.Group();
 const orb=new THREE.Mesh(
  new THREE.OctahedronGeometry(.28),
  new THREE.MeshStandardMaterial({
   color:colors[it.type]||0xffffff,
   emissive:colors[it.type]||0xffffff,
   emissiveIntensity:.28}));
 orb.position.y=.65;g.add(orb);
 const ring=new THREE.Mesh(
  new THREE.TorusGeometry(.43,.025,6,22),mats.gold);
 ring.rotation.x=Math.PI/2;ring.position.y=.1;g.add(ring);
 g.position.set(it.x,0,it.z);
 scene.add(g);return g;
}

function updateScene(s){
 const visible=new Set();
 for(const p of s.players){
  if(p.id===meId)continue;
  visible.add(p.id);
  let g=characters.get(p.id);
  if(!g){g=createCharacter(p);characters.set(p.id,g);}
  g.visible=p.alive;
  g.position.set(p.x,0,p.z);
  g.rotation.y=p.yaw;
 }

 for(const [id,g] of characters){
  if(!visible.has(id)){
   scene.remove(g);characters.delete(id);
  }
 }

 const seenItems=new Set();
 for(const it of s.items){
  seenItems.add(it.id);
  let g=items3D.get(it.id);
  if(!g){g=createItem(it);items3D.set(it.id,g);}
  g.visible=it.active;
  g.rotation.y+=.018;
  g.position.y=.04+Math.sin(Date.now()*.002+it.x)*.06;
 }
 for(const [id,g] of items3D){
  if(!seenItems.has(id)){
   scene.remove(g);items3D.delete(id);
  }
 }
}

function updateHUD(s){
 const me=s.players.find(p=>p.id===meId);
 const enemy=s.players.find(p=>p.id!==meId);
 if(!me)return;

 $("myName").textContent=me.role==="wei"?"韋小寶":"海大富";
 $("enemyName").textContent=enemy
  ?(enemy.role==="wei"?"韋小寶":"海大富"):"等待對手";

 $("myHp").style.width=(me.hp/me.maxHp*100)+"%";
 $("myStamina").style.width=me.stamina+"%";
 $("myStats").textContent=
  "HP "+me.hp+"/"+me.maxHp+" · 體力 "+Math.round(me.stamina);
 $("enemyHp").style.width=enemy?(enemy.hp/enemy.maxHp*100)+"%":"0%";
 $("enemyStats").textContent=enemy
  ?"HP "+enemy.hp+"/"+enemy.maxHp:"等待對手";

 $("message").textContent=s.winner
  ?(s.winner===me.role?"對決勝利":"對決失敗")
  :(s.started?"觀察對手，尋找出手機會":"等待另一名玩家");

 $("feed").innerHTML=s.log.slice(-4).map(
  t=>"· "+escapeHtml(t)).join("<br>");
 if(me.effect)$("message").textContent=me.effect+"！";
}

function escapeHtml(s){
 return String(s).replace(/[&<>"']/g,c=>({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
 }[c]));
}

// 第一人稱攝影機：角色本人不會出現在畫面中央。
function render(){
 requestAnimationFrame(render);
 if(!renderer||!camera)return;

 const me=state&&state.players.find(p=>p.id===meId);
 if(me){
  camera.position.set(me.x,1.62,me.z);
  camera.rotation.order="YXZ";
  camera.rotation.y=yaw;
  camera.rotation.x=pitch;
  updateScene(state);
 }
 renderer.render(scene,camera);
}

function animate(){
 requestAnimationFrame(animate);
 if(!renderer||!camera)return;
 const me=state&&state.players.find(p=>p.id===meId);
 if(me){
  camera.position.set(me.x,1.62,me.z);
  camera.rotation.order="YXZ";
  camera.rotation.y=yaw;
  camera.rotation.x=pitch;
 }
 if(state)updateScene(state);
 renderer.render(scene,camera);
}

function sendInput(extra={}){
 if(!joined||!socket.connected)return;
 const x=touch.x||0,z=touch.z||0;
 socket.emit("input",{
  x,z,yaw,
  sprint:!!keys.ShiftLeft||!!touch.sprint,
  attack:!!touch.attack||!!keys.MouseAttack,
  block:!!touch.block||!!keys.KeyQ,
  jump:!!touch.jump||!!keys.Space,
  ...extra
 });
}

function bindJoystick(){
 const joy=$("joystick"),stick=$("stick");
 let activeId=null,cx=0,cy=0,max=43;

 function reset(){
  activeId=null;touch.x=0;touch.z=0;
  stick.style.transform="translate(0px,0px)";
 }

 joy.addEventListener("pointerdown",e=>{
  e.preventDefault();
  activeId=e.pointerId;
  joy.setPointerCapture(activeId);
  const r=joy.getBoundingClientRect();
  cx=r.left+r.width/2;cy=r.top+r.height/2;
  move(e);
 });

 function move(e){
  if(activeId!==e.pointerId)return;
  const dx=e.clientX-cx,dy=e.clientY-cy;
  const len=Math.hypot(dx,dy);
  const scale=len>max?max/len:1;
  const px=dx*scale,py=dy*scale;
  stick.style.transform="translate("+px+"px,"+py+"px)";
  touch.x=clamp(px/max,-1,1);
  // 搖桿往上推代表向前。
  touch.z=clamp(py/max,-1,1);
 }

 joy.addEventListener("pointermove",move);
 joy.addEventListener("pointerup",reset);
 joy.addEventListener("pointercancel",reset);
}

function bindLook(){
 const zone=$("lookzone");
 let lastX=0,lastY=0,activeId=null;

 zone.addEventListener("pointerdown",e=>{
  e.preventDefault();
  activeId=e.pointerId;
  lastX=e.clientX;lastY=e.clientY;
  zone.setPointerCapture(activeId);
 });

 zone.addEventListener("pointermove",e=>{
  if(activeId!==e.pointerId)return;
  const dx=e.clientX-lastX,dy=e.clientY-lastY;
  lastX=e.clientX;lastY=e.clientY;
  yaw-=dx*.006;
  pitch=clamp(pitch-dy*.005,-1.15,1.15);
 });

 const end=()=>activeId=null;
 zone.addEventListener("pointerup",end);
 zone.addEventListener("pointercancel",end);

 // 桌機滑鼠控制視角。
 renderer.domElement.addEventListener("click",()=>{
  if(!matchMedia("(pointer:coarse)").matches){
   renderer.domElement.requestPointerLock?.();
  }
 });

 document.addEventListener("mousemove",e=>{
  if(document.pointerLockElement===renderer.domElement){
   yaw-=e.movementX*.0025;
   pitch=clamp(pitch-e.movementY*.0025,-1.15,1.15);
  }
 });
}

function bindActions(){
 window.addEventListener("keydown",e=>{
  keys[e.code]=true;
  if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)){
   e.preventDefault();
  }
 });
 window.addEventListener("keyup",e=>keys[e.code]=false);

 renderer.domElement.addEventListener("pointerdown",e=>{
  if(e.pointerType==="mouse")keys.MouseAttack=true;
 });
 window.addEventListener("pointerup",()=>keys.MouseAttack=false);

 document.querySelectorAll("[data-key]").forEach(el=>{
  const key=el.dataset.key;
  const on=e=>{e.preventDefault();touch[key]=true;};
  const off=e=>{e.preventDefault();touch[key]=false;};
  el.addEventListener("pointerdown",on);
  el.addEventListener("pointerup",off);
  el.addEventListener("pointercancel",off);
  el.addEventListener("pointerleave",off);
 });

 document.querySelectorAll("[data-item]").forEach(el=>{
  el.addEventListener("pointerdown",e=>{
   e.preventDefault();
   sendInput({useItem:el.dataset.item});
  });
 });

 setInterval(()=>sendInput(),50);
}

document.querySelectorAll("[data-mode]").forEach(b=>{
 b.onclick=()=>{
  mode=b.dataset.mode;
  document.querySelectorAll("[data-mode]").forEach(x=>
   x.classList.toggle("selected",x===b));
 };
});

document.querySelectorAll("[data-role]").forEach(b=>{
 b.onclick=()=>{
  role=b.dataset.role;
  document.querySelectorAll("[data-role]").forEach(x=>
   x.classList.toggle("selected",x===b));
 };
});

socket.on("connect",()=>$("status").textContent="連線成功，可以開始。");
socket.on("connect_error",()=>$("status").textContent="連線失敗，請稍後重新整理。");

socket.on("joined",d=>{
 meId=d.id;role=d.role;joined=true;
 const meRole=d.role;
 yaw=meRole==="wei"?0:Math.PI;
});

socket.on("state",s=>{
 state=s;
 updateHUD(s);
});

$("start").onclick=()=>{
 try{
  if(!window.THREE){
   $("status").textContent="3D 引擎載入失敗，請重新整理或檢查網路。";
   return;
  }

  initScene();
  bindJoystick();
  bindLook();
  bindActions();

  $("menu").style.display="none";
  $("hud").style.display="block";
  socket.emit("joinGame",{mode,role});
 }catch(e){
  console.error(e);
  $("status").textContent="啟動失敗："+e.message;
 }
};
})();
</script>
</body>
</html>`;

server.listen(PORT,"0.0.0.0",()=>{
  console.log("紫禁城對決啟動於 port "+PORT);
});
