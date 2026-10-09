
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const STEP = 50;
const SIZE = 18;
const rooms = new Map();
const sockets = new Map();

const ITEMS = ["石灰粉", "暗器", "煙霧彈", "寶衣", "匕首"];

const OBSTACLES = [
  { id: "screenA", x: 0, z: -6, w: 8, d: 0.55, h: 2.2, kind: "screen" },
  { id: "screenB", x: 0, z: 6, w: 8, d: 0.55, h: 2.2, kind: "screen" },
  { id: "pillarA", x: -8, z: 0, w: 0.9, d: 0.9, h: 3.1, kind: "pillar" },
  { id: "pillarB", x: 8, z: 0, w: 0.9, d: 0.9, h: 3.1, kind: "pillar" },
  { id: "wallA", x: -12, z: -10, w: 7, d: 1, h: 3, kind: "wall" },
  { id: "wallB", x: 12, z: -10, w: 7, d: 1, h: 3, kind: "wall" },
  { id: "wallC", x: -12, z: 10, w: 7, d: 1, h: 3, kind: "wall" },
  { id: "wallD", x: 12, z: 10, w: 7, d: 1, h: 3, kind: "wall" }
];

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const now = () => Date.now();

function newPlayer(id, role, index) {
  return {
    id, role,
    x: index === 0 ? -3 : 3,
    z: index === 0 ? 0 : 0,
    yaw: index === 0 ? Math.PI / 2 : -Math.PI / 2,
    hp: 100,
    stamina: 100,
    alive: true,
    score: 0,
    input: { dx: 0, dz: 0 },
    blocking: false,
    dodgeUntil: 0,
    jumpUntil: 0,
    attackUntil: 0,
    cooldownUntil: 0,
    hitUntil: 0,
    blindUntil: 0,
    vestUntil: 0,
    smokeUntil: 0,
    inventory: Object.fromEntries(ITEMS.map(k => [k, 0])),
    lastAction: ""
  };
}

function newRoom(id) {
  const room = {
    id,
    players: new Map(),
    started: false,
    winner: null,
    destroyed: new Set(),
    items: [],
    nextItemId: 1,
    messages: [],
    rematchAt: 0
  };

  const spots = [
    [-9, -3], [9, 3], [-9, 3], [9, -3],
    [-4, 0], [4, 0], [0, -9], [0, 9],
    [-12, 0], [12, 0]
  ];

  for (let i = 0; i < 10; i++) {
    const p = spots[i];
    room.items.push({
      id: room.nextItemId++,
      type: ITEMS[i % ITEMS.length],
      x: p[0] + (Math.random() - 0.5),
      z: p[1] + (Math.random() - 0.5)
    });
  }
  return room;
}

function message(room, text) {
  room.messages.push({ text, at: now() });
  room.messages = room.messages.slice(-5);
}

function roomOf(id) {
  const roomId = sockets.get(id);
  return roomId ? rooms.get(roomId) : null;
}

function obstacleActive(room, o) {
  return !(o.kind === "screen" && room.destroyed.has(o.id));
}

function circleRect(x, z, radius, o) {
  const cx = clamp(x, o.x - o.w / 2, o.x + o.w / 2);
  const cz = clamp(z, o.z - o.d / 2, o.z + o.d / 2);
  return Math.hypot(x - cx, z - cz) < radius;
}

function blocked(room, x, z, radius = 0.48) {
  if (Math.abs(x) > SIZE - radius || Math.abs(z) > SIZE - radius) {
    return true;
  }
  return OBSTACLES.some(o =>
    obstacleActive(room, o) && circleRect(x, z, radius, o)
  );
}

function lineHitsRect(ax, az, bx, bz, o) {
  const minX = o.x - o.w / 2;
  const maxX = o.x + o.w / 2;
  const minZ = o.z - o.d / 2;
  const maxZ = o.z + o.d / 2;
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0, t1 = 1;

  const tests = [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dz, az - minZ],
    [dz, maxZ - az]
  ];

  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-8) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        t0 = Math.max(t0, r);
      } else {
        if (r < t0) return false;
        t1 = Math.min(t1, r);
      }
    }
  }
  return t1 >= t0 && t1 > 0.03 && t0 < 0.97;
}

function hasSight(room, a, b) {
  return !OBSTACLES.some(o =>
    obstacleActive(room, o) &&
    lineHitsRect(a.x, a.z, b.x, b.z, o)
  );
}

function facing(a, b) {
  const targetAngle = Math.atan2(b.x - a.x, b.z - a.z);
  let d = targetAngle - a.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function knockback(room, attacker, target, amount) {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = target.x + dx / len * amount;
  const nz = target.z + dz / len * amount;
  if (!blocked(room, nx, target.z)) target.x = nx;
  if (!blocked(room, target.x, nz)) target.z = nz;
}

function damage(room, attacker, target, base, label) {
  if (!target.alive || now() < target.dodgeUntil) return false;

  let amount = base;
  if (target.blocking && facing(target, attacker) < 1.8) amount *= 0.2;
  if (now() < target.vestUntil) amount *= 0.5;

  target.hp = Math.max(0, target.hp - amount);
  target.hitUntil = now() + 320;

  if (!target.blocking) knockback(room, attacker, target, 0.85);

  if (target.hp <= 0) {
    target.alive = false;
    attacker.score++;
    message(room, target.role + "被" + attacker.role + "擊敗！");
  } else {
    message(room, attacker.role + "使出" + label + "，命中" + target.role + "！");
  }
  return true;
}

function attack(room, p, heavy) {
  const t = now();
  if (!p.alive || t < p.cooldownUntil || t < p.hitUntil) return;

  const cost = heavy ? 26 : 12;
  if (p.stamina < cost) return;
  p.stamina -= cost;
  p.attackUntil = t + (heavy ? 480 : 260);
  p.cooldownUntil = t + (heavy ? 900 : 390);
  p.lastAction = heavy ? "重擊" : "攻擊";

  const range = heavy ? 2.55 : 1.8;
  const base = p.role === "海大富"
    ? (heavy ? 27 : 15)
    : (heavy ? 21 : 12);

  for (const target of room.players.values()) {
    if (target.id === p.id || !target.alive) continue;
    if (dist(p, target) > range || facing(p, target) > 1.1) continue;
    if (!hasSight(room, p, target)) continue;
    damage(room, p, target, base, heavy ? "重掌" : "近身攻擊");
  }
}

function pickup(room, p) {
  const item = room.items.find(i => dist(p, i) < 1.55);
  if (!item) {
    message(room, "附近沒有可拾取的道具。");
    return;
  }
  p.inventory[item.type] = Math.min(5, (p.inventory[item.type] || 0) + 1);
  room.items = room.items.filter(i => i.id !== item.id);
  message(room, p.role + "拾取了" + item.type + "！");
}

function useItem(room, p, type) {
  if (!ITEMS.includes(type) || !p.alive) return;
  if (!p.inventory[type]) {
    message(room, "你沒有" + type + "。");
    return;
  }

  p.inventory[type]--;
  const enemies = [...room.players.values()].filter(
    e => e.id !== p.id && e.alive
  );

  if (type === "石灰粉") {
    const targets = enemies.filter(e =>
      dist(p, e) < 4 && hasSight(room, p, e)
    );
    targets.forEach(e => e.blindUntil = now() + 2600);
    message(room, targets.length
      ? p.role + "撒出石灰粉，干擾了對手！"
      : p.role + "撒出石灰粉，但沒有命中。");
  }

  if (type === "暗器") {
    const target = enemies
      .filter(e => dist(p, e) < 10 && hasSight(room, p, e))
      .sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (target) damage(room, p, target, 13, "暗器");
    else message(room, "暗器被障礙物擋住，或對手距離太遠。");
  }

  if (type === "煙霧彈") {
    p.smokeUntil = now() + 3200;
    enemies.filter(e => dist(p, e) < 7)
      .forEach(e => e.blindUntil = now() + 1800);
    message(room, p.role + "施放煙霧彈！");
  }

  if (type === "寶衣") {
    p.vestUntil = now() + 6000;
    message(room, p.role + "穿上寶衣，短時間減傷！");
  }

  if (type === "匕首") {
    const target = enemies
      .filter(e => dist(p, e) < 2.25 && hasSight(room, p, e))
      .sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (target) damage(room, p, target, 25, "匕首突襲");
    else message(room, "匕首沒有命中目標。");
  }
}

function doAction(room, p, data) {
  if (!room.started || room.winner || !p.alive || !data) return;

  switch (data.type) {
    case "attack": attack(room, p, false); break;
    case "heavy": attack(room, p, true); break;
    case "pickup": pickup(room, p); break;
    case "useItem": useItem(room, p, data.item); break;

    case "block":
      p.blocking = !!data.value;
      break;

    case "dodge":
      if (p.stamina >= 20 && now() >= p.hitUntil) {
        p.stamina -= 20;
        p.dodgeUntil = now() + 330;
        p.cooldownUntil = Math.max(p.cooldownUntil, now() + 180);
      }
      break;

    case "jump":
      if (p.stamina >= 12 && now() >= p.hitUntil) {
        p.stamina -= 12;
        p.jumpUntil = now() + 420;
        p.dodgeUntil = now() + 160;
      }
      break;

    case "break": {
      const screen = OBSTACLES.find(o =>
        o.kind === "screen" &&
        !room.destroyed.has(o.id) &&
        dist(p, o) < 2.2
      );
      if (screen) {
        room.destroyed.add(screen.id);
        message(room, p.role + "擊破了屏風！");
      } else {
        message(room, "附近沒有可擊破的屏風。");
      }
      break;
    }
  }
}

function serializePlayer(p) {
  return {
    id: p.id, role: p.role, x: p.x, z: p.z, yaw: p.yaw,
    hp: p.hp, stamina: p.stamina, alive: p.alive, score: p.score,
    blocking: p.blocking,
    dodging: now() < p.dodgeUntil,
    jumping: now() < p.jumpUntil,
    attacking: now() < p.attackUntil,
    hit: now() < p.hitUntil,
    blind: now() < p.blindUntil,
    vest: now() < p.vestUntil,
    smoke: now() < p.smokeUntil,
    inventory: p.inventory
  };
}

function sendState(room) {
  for (const p of room.players.values()) {
    const visiblePlayers = [...room.players.values()]
      .filter(other => {
        if (other.id === p.id) return true;
        if (now() < p.blindUntil) return false;
        if (now() < other.smokeUntil && dist(p, other) > 2.0) return false;
        return hasSight(room, p, other);
      })
      .map(serializePlayer);

    io.to(p.id).emit("state", {
      roomId: room.id,
      role: p.role,
      started: room.started,
      winner: room.winner,
      players: visiblePlayers,
      items: room.items,
      obstacles: OBSTACLES,
      destroyed: [...room.destroyed],
      messages: room.messages.slice(-4),
      me: serializePlayer(p)
    });
  }
}

function endCheck(room) {
  if (!room.started || room.winner) return;
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1 && room.players.size === 2) {
    room.winner = alive[0] ? alive[0].role : "平手";
    message(room, "本局結束，勝者：" + room.winner);
  }
}

io.on("connection", socket => {
  socket.on("joinGame", () => {
    if (sockets.has(socket.id)) return;

    let room = [...rooms.values()].find(r =>
      !r.started && !r.winner && r.players.size < 2
    );

    if (!room) {
      room = newRoom("palace-" + Math.random().toString(36).slice(2, 7));
      rooms.set(room.id, room);
    }

    const index = room.players.size;
    const role = index === 0 ? "韋小寶" : "海大富";
    const p = newPlayer(socket.id, role, index);
    room.players.set(socket.id, p);
    sockets.set(socket.id, room.id);
    socket.join(room.id);

    socket.emit("joined", { id: socket.id, role, roomId: room.id });
    message(room, role + "進入紫禁城！");

    if (room.players.size === 2) {
      room.started = true;
      message(room, "對決開始！善用格擋、閃避和道具。");
    }
    sendState(room);
  });

  socket.on("input", data => {
    const room = roomOf(socket.id);
    if (!room || !room.started || room.winner) return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive || !data) return;

    const dx = Number(data.dx);
    const dz = Number(data.dz);
    const yaw = Number(data.yaw);

    p.input.dx = Number.isFinite(dx) ? clamp(dx, -1, 1) : 0;
    p.input.dz = Number.isFinite(dz) ? clamp(dz, -1, 1) : 0;
    if (Number.isFinite(yaw)) p.yaw = yaw;
    p.blocking = !!data.blocking;
  });

  socket.on("action", data => {
    const room = roomOf(socket.id);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    doAction(room, p, data);
    endCheck(room);
    sendState(room);
  });

  socket.on("disconnect", () => {
    const room = roomOf(socket.id);
    sockets.delete(socket.id);
    if (!room) return;

    room.players.delete(socket.id);
    if (room.players.size === 0) {
      rooms.delete(room.id);
    } else {
      room.started = false;
      room.winner = null;
      message(room, "對手已離開，等待新玩家加入。");
      sendState(room);
    }
  });
});

setInterval(() => {
  const dt = STEP / 1000;
  for (const room of rooms.values()) {
    if (!room.started || room.winner) continue;

    for (const p of room.players.values()) {
      if (!p.alive) continue;

      if (now() < p.hitUntil) {
        p.stamina = Math.min(100, p.stamina + 4 * dt);
        continue;
      }

      const dx = p.input.dx;
      const dz = p.input.dz;
      const length = Math.hypot(dx, dz);
      const speed = p.role === "海大富" ? 4.6 : 5.1;

      if (length > 0.01) {
        const boost = now() < p.dodgeUntil ? 2.0 : 1;
        const slow = p.blocking ? 0.42 : 1;
        const step = speed * boost * slow * dt / Math.max(1, length);
        const nx = clamp(p.x + dx * step, -SIZE + 0.6, SIZE - 0.6);
        const nz = clamp(p.z + dz * step, -SIZE + 0.6, SIZE - 0.6);

        if (!blocked(room, nx, p.z)) p.x = nx;
        if (!blocked(room, p.x, nz)) p.z = nz;

        p.stamina = Math.max(0, p.stamina - (p.blocking ? 1 : 2.5) * dt);
      } else {
        p.stamina = Math.min(100, p.stamina + 14 * dt);
      }
    }

    endCheck(room);
    sendState(room);
  }
}, STEP);

app.get("/", (req, res) => res.type("html").send(PAGE));

const PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>紫禁城：韋小寶對決海大富</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111821;color:#fff;font-family:system-ui,"Noto Sans TC",sans-serif;touch-action:none}
#game{position:fixed;inset:0}
canvas{display:block}
#hud{position:fixed;z-index:5;top:calc(env(safe-area-inset-top) + 8px);left:8px;background:#10131bdc;border:1px solid #b99457;border-radius:12px;padding:10px;width:190px;font-size:12px;pointer-events:none}
#status{font-weight:800;color:#f1d18b;font-size:13px;margin-bottom:4px}
.bar{height:9px;border-radius:9px;background:#3d2828;overflow:hidden;margin:4px 0 7px}
.fill{height:100%;width:100%;transition:width .1s}
#hpFill{background:linear-gradient(90deg,#a72e28,#f07855)}
#stFill{background:linear-gradient(90deg,#8d6a22,#f4d478)}
#items{line-height:1.65;color:#e8e0ce}
#messages{position:fixed;right:8px;top:calc(env(safe-area-inset-top) + 8px);z-index:5;text-align:right;font-size:12px;text-shadow:0 2px 4px #000;max-width:45vw}
#center{position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);z-index:3;color:#fff7;font-size:24px;pointer-events:none}
#tip{position:fixed;left:8px;bottom:8px;z-index:4;background:#10131bc9;padding:7px 9px;border-radius:8px;font-size:10px;max-width:45vw;line-height:1.5;pointer-events:none}
#mobile{position:fixed;inset:0;z-index:6;pointer-events:none}
#stickBase{position:absolute;left:20px;bottom:26px;width:124px;height:124px;border-radius:50%;background:#12172288;border:2px solid #d4b36b88;pointer-events:auto;touch-action:none}
#stick{position:absolute;width:48px;height:48px;left:36px;top:36px;border-radius:50%;background:#d7bd7bcc;border:2px solid #fff8;pointer-events:none}
#buttons{position:absolute;right:10px;bottom:16px;display:grid;grid-template-columns:repeat(3,58px);gap:7px;pointer-events:auto}
.ctrl{border:1px solid #dfc080;border-radius:50%;width:58px;height:58px;color:#fff;background:#3c2925e8;font-weight:800;font-size:12px;touch-action:none;box-shadow:0 3px 8px #0007}
.ctrl:active,.ctrl.active{background:#a34a2d}
.ctrl.small{width:48px;height:48px;font-size:10px}
#overlay{position:fixed;inset:0;z-index:20;background:linear-gradient(#10151beF,#17120feF);display:flex;align-items:center;justify-content:center;text-align:center;padding:22px}
#panel{max-width:420px;width:100%;border:1px solid #b99457;border-radius:18px;padding:24px 18px;background:linear-gradient(145deg,#322b23,#141923);box-shadow:0 18px 55px #0008}
h1{font-size:25px;color:#f2d18a;margin:0 0 8px}
button.primary{border:1px solid #f0d79d;background:linear-gradient(#a84a2d,#702a22);border-radius:10px;padding:13px 24px;color:white;font-weight:800;font-size:16px;margin-top:12px}
#note{color:#c8c0b0;font-size:12px;line-height:1.7}
@media(min-width:850px){
 #stickBase{left:28px;bottom:28px}
 #buttons{right:24px;bottom:24px;grid-template-columns:repeat(3,66px)}
 .ctrl{width:66px;height:66px;font-size:13px}
 #tip{font-size:12px;max-width:350px}
 #hud{width:230px;font-size:13px}
}
</style>
</head>
<body>
<div id="game"></div>
<div id="hud">
 <div id="status">尚未加入戰場</div>
 <div id="role">角色：—</div>
 <div>氣血</div><div class="bar"><div id="hpFill" class="fill"></div></div>
 <div>體力</div><div class="bar"><div id="stFill" class="fill"></div></div>
 <div id="items">道具尚未同步</div>
</div>
<div id="messages"></div>
<div id="center">＋</div>
<div id="tip">左側搖桿移動；右側按鈕攻防。靠近道具按「拾取」。</div>
<div id="mobile">
 <div id="stickBase"><div id="stick"></div></div>
 <div id="buttons">
  <button class="ctrl" data-action="attack">攻擊</button>
  <button class="ctrl" data-action="heavy">重掌</button>
  <button class="ctrl" data-action="block" data-hold="true">格擋</button>
  <button class="ctrl" data-action="dodge">閃避</button>
  <button class="ctrl" data-action="jump">輕功</button>
  <button class="ctrl" data-action="pickup">拾取</button>
  <button class="ctrl small" data-item="石灰粉">石灰</button>
  <button class="ctrl small" data-item="暗器">暗器</button>
  <button class="ctrl small" data-item="煙霧彈">煙霧</button>
  <button class="ctrl small" data-item="寶衣">寶衣</button>
  <button class="ctrl small" data-item="匕首">匕首</button>
  <button class="ctrl small" data-action="break">破屏</button>
 </div>
</div>
<div id="overlay">
 <div id="panel">
  <h1>紫禁城・武俠對決</h1>
  <p>韋小寶　VS　海大富</p>
  <p id="note">風格化 3D 場景、近身攻防、道具與屏風戰術。請開啟第二個瀏覽器或另一台裝置進行雙人測試。</p>
  <button id="start" class="primary">進入戰場</button>
  <p id="wait" style="font-size:12px;color:#f0d18b"></p>
 </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
<script>
(function(){
"use strict";
const socket=io();
const $=id=>document.getElementById(id);
let scene,camera,renderer,clock;
let myId=null,myRole=null,joined=false,state=null;
let yaw=0,pitch=0.28;
let meshes=new Map(),itemMeshes=new Map(),obstacleMeshes=new Map();
let joystick={x:0,y:0,active:false,pointer:null};
let blockHeld=false,jumpVisual=0,jumpSpeed=0,lastSend=0;
const mat=(color,roughness=.8,metalness=0)=>new THREE.MeshStandardMaterial({color,roughness,metalness});
const box=(parent,x,y,z,w,h,d,material)=>{
 const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
 m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
};

function buildScene(){
 scene=new THREE.Scene();
 scene.background=new THREE.Color(0x121923);
 scene.fog=new THREE.Fog(0x121923,32,65);
 camera=new THREE.PerspectiveCamera(64,innerWidth/innerHeight,.1,120);
 renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 renderer.setSize(innerWidth,innerHeight);
 renderer.shadowMap.enabled=true;
 renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 $("game").appendChild(renderer.domElement);
 scene.add(new THREE.HemisphereLight(0xdce7ff,0x453024,2.1));
 const sun=new THREE.DirectionalLight(0xffd7a0,2.7);
 sun.position.set(-10,22,12);sun.castShadow=true;
 sun.shadow.mapSize.set(1024,1024);scene.add(sun);

 const stone=mat(0x82735d),tile=mat(0x9a886a),red=mat(0x792e24),dark=mat(0x4c211b);
 const gold=mat(0xd3ae63,.38,.2),roof=mat(0x29423c),wall=mat(0xb9a47e);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(36,36),stone);
 ground.rotation.x=-Math.PI/2;ground.position.y=-.08;ground.receiveShadow=true;scene.add(ground);
 for(let x=-17;x<=17;x+=2)for(let z=-17;z<=17;z+=2)
  box(scene,x,-.015,z,1.94,.035,1.94,tile);

 // 圍牆與宮殿
 box(scene,0,1.6,-18,38,3.2,.7,wall);
 box(scene,0,1.6,18,38,3.2,.7,wall);
 box(scene,-18,1.6,0,.7,3.2,36,wall);
 box(scene,18,1.6,0,.7,3.2,36,wall);

 [-13,13].forEach(z=>{
  box(scene,0,1.45,z,14,2.9,4,red);
  box(scene,0,3.05,z,15,.25,4.7,gold);
  const r=new THREE.Mesh(new THREE.ConeGeometry(8.4,2.3,4),roof);
  r.rotation.y=Math.PI/4;r.scale.set(1,.5,.48);r.position.set(0,4,z);r.castShadow=true;scene.add(r);
  [-5,-2.5,0,2.5,5].forEach(x=>{
   box(scene,x,1.4,z-2.05,.26,2.8,.26,dark);
   box(scene,x,1.4,z+2.05,.26,2.8,.26,dark);
  });
 });
 [-14,14].forEach(x=>[-10,-5,0,5,10].forEach(z=>{
  const p=new THREE.Mesh(new THREE.CylinderGeometry(.28,.34,3.3,12),red);
  p.position.set(x,1.65,z);p.castShadow=true;scene.add(p);
  box(scene,x,3.35,z,.65,.72,.65,gold);
 }));

 const obstacles=[
  {id:"screenA",x:0,z:-6,w:8,d:.55,h:2.2,kind:"screen"},
  {id:"screenB",x:0,z:6,w:8,d:.55,h:2.2,kind:"screen"},
  {id:"pillarA",x:-8,z:0,w:.9,d:.9,h:3.1,kind:"pillar"},
  {id:"pillarB",x:8,z:0,w:.9,d:.9,h:3.1,kind:"pillar"},
  {id:"wallA",x:-12,z:-10,w:7,d:1,h:3,kind:"wall"},
  {id:"wallB",x:12,z:-10,w:7,d:1,h:3,kind:"wall"},
  {id:"wallC",x:-12,z:10,w:7,d:1,h:3,kind:"wall"},
  {id:"wallD",x:12,z:10,w:7,d:1,h:3,kind:"wall"}
 ];
 obstacles.forEach(o=>{
  const m=box(scene,o.x,o.h/2,o.z,o.w,o.h,o.d,
   o.kind==="screen"?mat(0x9a5132):o.kind==="pillar"?dark:red);
  obstacleMeshes.set(o.id,m);
  if(o.kind==="screen"){
   box(scene,o.x,o.h+.07,o.z,o.w+.18,.14,o.d+.12,gold);
   for(let x=-o.w/2+.5;x<o.w/2;x+=1.1)box(scene,o.x+x,1.05,o.z,.045,1.7,.06,gold);
  }
 });

 // 宮燈
 [-5,5].forEach(x=>{
  const lamp=new THREE.Mesh(new THREE.SphereGeometry(.28,12,10),
   new THREE.MeshBasicMaterial({color:0xffbd51}));
  lamp.position.set(x,5.4,0);scene.add(lamp);
 });
}

function makeCharacter(role){
 const group=new THREE.Group();
 const wei=role==="韋小寶";
 const robe=mat(wei?0x315e91:0x692a24);
 const trim=mat(wei?0xd9bd77:0xb4a080);
 const skin=mat(0xe0b28a),pants=mat(0x252832),black=mat(0x17191d);
 const body= new THREE.Mesh(new THREE.CapsuleGeometry(.39,.64,4,8),robe);
 body.position.y=1.24;body.castShadow=true;group.add(body);
 const head=new THREE.Mesh(new THREE.SphereGeometry(.3,14,12),skin);
 head.position.y=2.02;head.castShadow=true;group.add(head);
 const hat=new THREE.Mesh(new THREE.CylinderGeometry(.29,.32,.15,12),black);
 hat.position.y=2.29;group.add(hat);
 const belt=new THREE.Mesh(new THREE.TorusGeometry(.4,.045,6,16),trim);
 belt.rotation.x=Math.PI/2;belt.position.y=1.05;group.add(belt);
 [-1,1].forEach(side=>{
  const leg=new THREE.Mesh(new THREE.CapsuleGeometry(.14,.38,3,7),pants);
  leg.position.set(side*.2,.48,0);group.add(leg);
  const arm=new THREE.Mesh(new THREE.CapsuleGeometry(.12,.43,3,7),robe);
  arm.position.set(side*.45,1.42,0);arm.rotation.z=side*.35;group.add(arm);
 });
 const sword=new THREE.Mesh(new THREE.BoxGeometry(.055,.72,.1),mat(0xc7d4dc,.25,.7));
 sword.position.set(.48,1.16,.2);sword.rotation.z=-.6;group.add(sword);

 const c=document.createElement("canvas");c.width=256;c.height=64;
 const ctx=c.getContext("2d");ctx.fillStyle="#17130ee8";ctx.fillRect(0,0,256,64);
 ctx.fillStyle=wei?"#d5e8ff":"#ffe0c1";ctx.font="bold 30px sans-serif";
 ctx.textAlign="center";ctx.fillText(role,128,42);
 const label=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),transparent:true}));
 label.position.y=2.75;label.scale.set(1.8,.45,1);group.add(label);
 group.userData.body=body;group.userData.sword=sword;group.userData.robes=[robe];
 return group;
}

function makeItem(item){
 const colors={"石灰粉":0xe8dfb5,"暗器":0xa9bacb,"煙霧彈":0x7f8597,"寶衣":0x45a16c,"匕首":0xd1dce8};
 const g=new THREE.Group();
 const core=new THREE.Mesh(new THREE.OctahedronGeometry(.27),mat(colors[item.type]||0xffffff,.4,.15));
 core.position.y=.55;g.add(core);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(.38,.035,6,20),
  new THREE.MeshBasicMaterial({color:colors[item.type]||0xffffff}));
 ring.rotation.x=Math.PI/2;ring.position.y=.18;g.add(ring);
 g.position.set(item.x,0,item.z);scene.add(g);return g;
}

function updateState(s){
 state=s;
 const present=new Set(s.players.map(p=>p.id));
 for(const [id,m] of meshes)if(!present.has(id)){scene.remove(m);meshes.delete(id);}
 s.players.forEach(p=>{
  let m=meshes.get(p.id);
  if(!m){m=makeCharacter(p.role);scene.add(m);meshes.set(p.id,m);}
  const y=p.jumping?Math.sin((performance.now()%420)/420*Math.PI)*.8:0;
  m.position.set(p.x,y,p.z);m.rotation.y=p.yaw;
  m.userData.body.material.emissive.setHex(p.hit?0x551111:0x000000);
  m.userData.sword.visible=p.attacking;
  m.userData.sword.rotation.z=p.attacking?-1.25:-.6;
  m.visible=true;
  if(p.id===myId)updateHud(p);
 });

 const itemIds=new Set(s.items.map(i=>i.id));
 for(const [id,m] of itemMeshes)if(!itemIds.has(id)){scene.remove(m);itemMeshes.delete(id);}
 s.items.forEach(i=>{
  if(!itemMeshes.has(i.id))itemMeshes.set(i.id,makeItem(i));
 });
 itemMeshes.forEach((m,id)=>{
  m.rotation.y+=.025;
  m.position.y=.05+Math.sin(performance.now()*.003+id)*.08;
 });

 s.destroyed.forEach(id=>{
  const m=obstacleMeshes.get(id);if(m)m.visible=false;
 });
 $("messages").innerHTML=s.messages.map(m=>"<div>"+esc(m.text)+"</div>").join("");
 if(s.winner){
  $("overlay").style.display="flex";
  $("start").textContent="重新開始";
  $("wait").textContent="勝者："+s.winner+"。重新整理頁面可再次配對。";
 }
}

function updateHud(p){
 $("role").textContent="角色："+p.role+"　戰績："+p.score;
 $("hpFill").style.width=p.hp+"%";
 $("stFill").style.width=p.stamina+"%";
 $("status").textContent=!state.started?"等待對手加入":!p.alive?"本局落敗":state.winner?"勝者："+state.winner:"紫禁城對決中";
 const names=["石灰粉","暗器","煙霧彈","寶衣","匕首"];
 $("items").innerHTML=names.map((n,i)=>(i+1)+". "+n+" × "+(p.inventory[n]||0)).join("<br>");
}

function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function action(type,item){if(joined)socket.emit("action",{type,item});}

function sendInput(){
 if(!joined||!state||!state.started)return;
 const len=Math.hypot(joystick.x,joystick.y);
 let sx=joystick.x,sy=joystick.y;
 if(len>1){sx/=len;sy/=len;}
 // 搖桿上推代表沿著角色鏡頭前方移動
 const forward=-sy,right=sx;
 const dx=Math.sin(yaw)*forward+Math.cos(yaw)*right;
 const dz=Math.cos(yaw)*forward-Math.sin(yaw)*right;
 socket.emit("input",{dx:dx,dz:dz,yaw:yaw,blocking:blockHeld});
}

function updateCamera(dt){
 if(!state||!state.me)return;
 const p=state.me;
 const target=new THREE.Vector3(p.x,1.35+jumpVisual,p.z);
 const d=6.3;
 const desired=new THREE.Vector3(
  p.x+Math.sin(yaw)*Math.cos(pitch)*d,
  target.y+1.7+Math.sin(pitch)*d,
  p.z+Math.cos(yaw)*Math.cos(pitch)*d
 );
 camera.position.lerp(desired,Math.min(1,dt*7));
 camera.lookAt(target);
}

function animate(){
 requestAnimationFrame(animate);
 if(!renderer)return;
 const dt=Math.min(clock.getDelta(),.05);
 const t=performance.now();
 if(jumpSpeed!==0||jumpVisual>0){
  jumpVisual+=jumpSpeed*dt;jumpSpeed-=11*dt;
  if(jumpVisual<=0){jumpVisual=0;jumpSpeed=0;}
 }
 if(t-lastSend>45){sendInput();lastSend=t;}
 updateCamera(dt);
 renderer.render(scene,camera);
}

function setupControls(){
 const base=$("stickBase"),stick=$("stick");
 function setStick(e){
  const r=base.getBoundingClientRect();
  const cx=r.left+r.width/2,cy=r.top+r.height/2;
  let dx=(e.clientX-cx)/43,dy=(e.clientY-cy)/43;
  const l=Math.hypot(dx,dy);if(l>1){dx/=l;dy/=l;}
  joystick.x=dx;joystick.y=dy;
  stick.style.left=(36+dx*34)+"px";stick.style.top=(36+dy*34)+"px";
 }
 base.addEventListener("pointerdown",e=>{
  e.preventDefault();joystick.active=true;joystick.pointer=e.pointerId;
  base.setPointerCapture(e.pointerId);setStick(e);
 });
 base.addEventListener("pointermove",e=>{
  if(joystick.active&&e.pointerId===joystick.pointer)setStick(e);
 });
 function resetStick(){
  joystick.active=false;joystick.x=0;joystick.y=0;
  stick.style.left="36px";stick.style.top="36px";
 }
 base.addEventListener("pointerup",resetStick);
 base.addEventListener("pointercancel",resetStick);

 document.querySelectorAll("[data-action]").forEach(btn=>{
  const type=btn.dataset.action;
  if(type==="block"){
   btn.addEventListener("pointerdown",e=>{e.preventDefault();blockHeld=true;btn.classList.add("active");});
   const release=()=>{blockHeld=false;btn.classList.remove("active");};
   btn.addEventListener("pointerup",release);
   btn.addEventListener("pointercancel",release);
   btn.addEventListener("pointerleave",release);
  }else{
   btn.addEventListener("pointerdown",e=>{
    e.preventDefault();
    if(type==="jump"){jumpSpeed=5.5;action(type);}
    else action(type);
   });
  }
 });
 document.querySelectorAll("[data-item]").forEach(btn=>{
  btn.addEventListener("pointerdown",e=>{e.preventDefault();action("useItem",btn.dataset.item);});
 });

 // 手指在畫面右半部滑動可轉動視角
 let lookPointer=null,lastX=0,lastY=0;
 renderer.domElement.addEventListener("pointerdown",e=>{
  if(e.pointerType==="mouse"&&e.button===0){action("attack");return;}
  if(e.clientX>innerWidth*.38){lookPointer=e.pointerId;lastX=e.clientX;lastY=e.clientY;}
 });
 renderer.domElement.addEventListener("pointermove",e=>{
  if(lookPointer!==e.pointerId)return;
  const dx=e.clientX-lastX,dy=e.clientY-lastY;
  yaw-=dx*.006;pitch=Math.max(-.12,Math.min(.7,pitch+dy*.003));
  lastX=e.clientX;lastY=e.clientY;
 });
 const endLook=e=>{if(lookPointer===e.pointerId)lookPointer=null;};
 renderer.domElement.addEventListener("pointerup",endLook);
 renderer.domElement.addEventListener("pointercancel",endLook);

 document.addEventListener("keydown",e=>{
  if(e.repeat||!joined)return;
  const map={KeyJ:"attack",KeyK:"heavy",ShiftLeft:"dodge",Space:"jump",KeyE:"pickup",KeyR:"break"};
  if(map[e.code])action(map[e.code]);
  const names=["石灰粉","暗器","煙霧彈","寶衣","匕首"];
  if(/^Digit[1-5]$/.test(e.code))action("useItem",names[Number(e.code.slice(-1))-1]);
  if(e.code==="KeyL")blockHeld=true;
 });
 document.addEventListener("keyup",e=>{if(e.code==="KeyL")blockHeld=false;});
 addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
 });
}

$("start").addEventListener("click",()=>{
 if(joined){
  location.reload();return;
 }
 $("start").disabled=true;$("start").textContent="正在配對";
 $("wait").textContent="等待另一名玩家進入……";
 socket.emit("joinGame");
});

socket.on("joined",data=>{
 myId=data.id;myRole=data.role;joined=true;
 $("overlay").style.display="none";
});
socket.on("state",updateState);
socket.on("connect_error",()=>{$("wait").textContent="連線失敗，請重新整理頁面。";});

buildScene();
clock=new THREE.Clock();
setupControls();
animate();
})();
</script>
</body>
</html>`;

server.listen(PORT, "0.0.0.0", () => {
  console.log("3D 武俠格鬥遊戲已啟動，port " + PORT);
});
