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

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const normalizeAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
const angleDiff = (a, b) => normalizeAngle(a - b);

function circleRectCollision(x, y, r, rect) {
  const cx = clamp(x, rect.x, rect.x + rect.w);
  const cy = clamp(y, rect.y, rect.y + rect.h);
  return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
}

function segmentIntersectsRect(x1, y1, x2, y2, rect) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 8));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (
      x >= rect.x && x <= rect.x + rect.w &&
      y >= rect.y && y <= rect.y + rect.h
    ) return true;
  }
  return false;
}

function createMap() {
  return {
    walls: [
      { x: 0, y: 0, w: WIDTH, h: 24 },
      { x: 0, y: HEIGHT - 24, w: WIDTH, h: 24 },
      { x: 0, y: 0, w: 24, h: HEIGHT },
      { x: WIDTH - 24, y: 0, w: 24, h: HEIGHT },

      { x: 100, y: 115, w: 300, h: 22 },
      { x: 800, y: 115, w: 300, h: 22 },
      { x: 100, y: 115, w: 22, h: 160 },
      { x: 1078, y: 115, w: 22, h: 160 },

      { x: 170, y: 245, w: 220, h: 22 },
      { x: 810, y: 245, w: 220, h: 22 },
      { x: 390, y: 210, w: 22, h: 150 },
      { x: 788, y: 210, w: 22, h: 150 },

      { x: 450, y: 105, w: 300, h: 22 },
      { x: 450, y: 105, w: 22, h: 90 },
      { x: 728, y: 105, w: 22, h: 90 },

      { x: 275, y: 430, w: 185, h: 20 },
      { x: 740, y: 430, w: 185, h: 20 },
      { x: 580, y: 475, w: 40, h: 100 }
    ],
    floors: [
      { x: 175, y: 315, w: 125, h: 75, damage: 0, state: 0 },
      { x: 900, y: 315, w: 125, h: 75, damage: 0, state: 0 },
      { x: 490, y: 285, w: 100, h: 75, damage: 0, state: 0 },
      { x: 610, y: 285, w: 100, h: 75, damage: 0, state: 0 },
      { x: 445, y: 505, w: 100, h: 65, damage: 0, state: 0 },
      { x: 655, y: 505, w: 100, h: 65, damage: 0, state: 0 }
    ],
    pillars: [
      { x: 300, y: 175, r: 22, hp: 45, maxHp: 45, fallen: false },
      { x: 900, y: 175, r: 22, hp: 45, maxHp: 45, fallen: false },
      { x: 440, y: 390, r: 22, hp: 45, maxHp: 45, fallen: false },
      { x: 760, y: 390, r: 22, hp: 45, maxHp: 45, fallen: false },
      { x: 510, y: 615, r: 22, hp: 45, maxHp: 45, fallen: false },
      { x: 690, y: 615, r: 22, hp: 45, maxHp: 45, fallen: false }
    ],
    screens: [
      { x: 130, y: 490, w: 100, h: 18 },
      { x: 970, y: 490, w: 100, h: 18 },
      { x: 525, y: 150, w: 150, h: 18 }
    ],
    crates: [
      { x: 320, y: 540, w: 42, h: 42, hp: 25, maxHp: 25 },
      { x: 838, y: 540, w: 42, h: 42, hp: 25, maxHp: 25 },
      { x: 465, y: 205, w: 38, h: 38, hp: 25, maxHp: 25 },
      { x: 700, y: 205, w: 38, h: 38, hp: 25, maxHp: 25 }
    ]
  };
}

function createPlayer(id, role) {
  const wei = role === "wei";
  return {
    id,
    role,
    x: wei ? 210 : 990,
    y: 650,
    r: wei ? 18 : 20,
    hp: wei ? 100 : 120,
    maxHp: wei ? 100 : 120,
    speed: wei ? 4.5 : 3.7,
    angle: wei ? -Math.PI / 2 : -Math.PI / 2,
    alive: true,
    input: {},
    specialCooldown: 0,
    attackCooldown: 0,
    invincible: 0,
    movementMode: "ground",
    shenXing: 120,
    shenfa: 100,
    escapes: 3,
    wallRunTimer: 0,
    airTimer: 0,
    vaultTimer: 0,
    specialFlash: 0,
    attackFlash: 0,
    hitFlash: 0,
    lastAction: "",
    actionLock: false
  };
}

function createRoom(name) {
  return {
    name,
    players: {},
    map: createMap(),
    started: false,
    winner: null,
    tick: 0,
    effects: [],
    createdAt: Date.now()
  };
}

function getSolidRects(room) {
  const map = room.map;
  return [
    ...map.walls,
    ...map.screens,
    ...map.crates.filter(c => c.hp > 0),
    ...map.floors.filter(f => f.state >= 2)
  ];
}

function collidesMap(room, x, y, r) {
  for (const rect of getSolidRects(room)) {
    if (circleRectCollision(x, y, r, rect)) return true;
  }

  for (const p of room.map.pillars) {
    if (p.fallen) continue;
    if (Math.hypot(x - p.x, y - p.y) < r + p.r) return true;
  }

  return false;
}

function moveGround(room, p, dx, dy) {
  const nx = clamp(p.x + dx, p.r + 24, WIDTH - p.r - 24);
  const ny = clamp(p.y + dy, p.r + 24, HEIGHT - p.r - 24);

  if (!collidesMap(room, nx, p.y, p.r)) p.x = nx;
  if (!collidesMap(room, p.x, ny, p.r)) p.y = ny;
}

function hasLineOfSight(room, a, b) {
  for (const rect of [
    ...room.map.walls,
    ...room.map.screens,
    ...room.map.crates.filter(c => c.hp > 0)
  ]) {
    if (segmentIntersectsRect(a.x, a.y, b.x, b.y, rect)) return false;
  }
  return true;
}

function addEffect(room, x, y, type, color, size = 25, life = 18) {
  room.effects.push({
    x, y, type, color, size, life, maxLife: life,
    angle: Math.random() * Math.PI * 2
  });
  if (room.effects.length > 100) room.effects.shift();
}

function damageFloor(room, floor, amount) {
  if (floor.state >= 2) return;
  floor.damage += amount;

  if (floor.damage >= 100) {
    floor.state = 2;
    addEffect(room, floor.x + floor.w / 2, floor.y + floor.h / 2,
      "collapse", "#d9b27a", 75, 35);
  } else if (floor.damage >= 55) {
    floor.state = 1;
  }
}

function damagePillar(room, pillar, amount) {
  if (pillar.fallen) return;

  pillar.hp = Math.max(0, pillar.hp - amount);

  if (pillar.hp <= 0) {
    pillar.fallen = true;
    addEffect(room, pillar.x, pillar.y, "collapse", "#d7b17b", 70, 35);

    let nearest = null;
    let nearestDistance = Infinity;

    for (const f of room.map.floors) {
      const d = Math.hypot(
        f.x + f.w / 2 - pillar.x,
        f.y + f.h / 2 - pillar.y
      );
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = f;
      }
    }

    if (nearest) damageFloor(room, nearest, 90);

    for (const p of Object.values(room.players)) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - pillar.x, p.y - pillar.y) < 85) {
        hurtPlayer(room, p, 10, pillar.x, pillar.y);
      }
    }
  }
}

function hurtPlayer(room, p, damage, fromX, fromY) {
  if (!p.alive || p.invincible > 0) return;

  p.hp = Math.max(0, p.hp - damage);
  p.hitFlash = 10;
  p.invincible = 10;

  const a = Math.atan2(p.y - fromY, p.x - fromX);
  const nx = p.x + Math.cos(a) * 15;
  const ny = p.y + Math.sin(a) * 15;

  if (!collidesMap(room, nx, ny, p.r)) {
    p.x = nx;
    p.y = ny;
  }

  addEffect(room, p.x, p.y, "hit", "#ffcf7a", 32, 20);

  if (p.hp <= 0) {
    p.alive = false;
    p.movementMode = "ground";
    addEffect(room, p.x, p.y, "ko", "#f3c879", 60, 45);
  }
}

function attackCrates(room, p) {
  for (const c of room.map.crates) {
    if (c.hp <= 0) continue;

    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const d = Math.hypot(cx - p.x, cy - p.y);
    const a = Math.atan2(cy - p.y, cx - p.x);

    if (d < 100 && Math.abs(angleDiff(a, p.angle)) < 0.85) {
      c.hp = Math.max(0, c.hp - 10);
      addEffect(room, cx, cy, "hit", "#d4a56a", 22, 14);
      break;
    }
  }
}

function attackPillars(room, p) {
  for (const pillar of room.map.pillars) {
    if (pillar.fallen) continue;

    const d = Math.hypot(pillar.x - p.x, pillar.y - p.y);
    const a = Math.atan2(pillar.y - p.y, pillar.x - p.x);

    if (d < 105 && Math.abs(angleDiff(a, p.angle)) < 0.9) {
      damagePillar(room, pillar, 15);
      break;
    }
  }
}

function getOpponent(room, p) {
  return Object.values(room.players).find(q => q.id !== p.id && q.alive);
}

function attack(room, p) {
  if (p.attackCooldown > 0 || !p.alive) return;

  p.attackCooldown = p.role === "wei" ? 22 : 28;
  p.attackFlash = 10;
  p.lastAction = "attack";

  const range = p.role === "wei" ? 82 : 105;
  const opponent = getOpponent(room, p);

  addEffect(
    room,
    p.x + Math.cos(p.angle) * 32,
    p.y + Math.sin(p.angle) * 32,
    p.role === "wei" ? "slash" : "strike",
    p.role === "wei" ? "#e8f5ff" : "#ffbc58",
    range * 0.65,
    14
  );

  if (opponent) {
    const d = distance(p, opponent);
    const targetAngle = Math.atan2(opponent.y - p.y, opponent.x - p.x);
    const diff = Math.abs(angleDiff(targetAngle, p.angle));

    if (d < range && diff < (p.role === "wei" ? 0.9 : 1.0) &&
        hasLineOfSight(room, p, opponent)) {
      let damage;

      if (p.role === "wei") {
        if (diff < 0.35) damage = 18;
        else if (diff < 0.65) damage = 24;
        else damage = 30;
      } else {
        damage = 17;
        if (["wallrun", "air", "vault"].includes(p.movementMode)) {
          damage += 4;
        }
      }

      hurtPlayer(room, opponent, damage, p.x, p.y);
    }
  }

  attackCrates(room, p);
  if (p.role === "hai") attackPillars(room, p);
}

function specialWei(room, p) {
  if (p.specialCooldown > 0 || p.shenXing < 35 || !p.alive) return;

  p.shenXing -= 35;
  p.specialCooldown = 300;
  p.invincible = Math.max(p.invincible, 45);
  p.specialFlash = 25;
  p.movementMode = "shenxing";
  p.lastAction = "神行百變";

  addEffect(room, p.x, p.y, "burst", "#9fe7ff", 55, 30);
}

function escapeWei(room, p) {
  if (p.escapes <= 0 || !p.alive) return;

  p.escapes--;
  p.invincible = Math.max(p.invincible, 35);
  p.movementMode = "escape";
  p.lastAction = "脫身";

  for (let i = 0; i < 8; i++) {
    const nx = p.x + Math.cos(p.angle) * 18;
    const ny = p.y + Math.sin(p.angle) * 18;
    if (collidesMap(room, nx, ny, p.r)) break;

    p.x = nx;
    p.y = ny;
    addEffect(room, p.x, p.y, "afterimage", "#80dfff", 24, 16);
  }

  p.movementMode = "ground";
}

function specialHai(room, p) {
  if (p.specialCooldown > 0 || !p.alive) return;

  p.specialCooldown = 180;
  p.specialFlash = 24;
  p.lastAction = "掌勢震擊";

  const opponent = getOpponent(room, p);

  if (opponent && distance(p, opponent) < 150 &&
      hasLineOfSight(room, p, opponent)) {
    const a = Math.atan2(opponent.y - p.y, opponent.x - p.x);
    if (Math.abs(angleDiff(a, p.angle)) < 1.15) {
      hurtPlayer(room, opponent, 22, p.x, p.y);
    }
  }

  for (const pillar of room.map.pillars) {
    const d = Math.hypot(pillar.x - p.x, pillar.y - p.y);
    const a = Math.atan2(pillar.y - p.y, pillar.x - p.x);
    if (d < 125 && Math.abs(angleDiff(a, p.angle)) < 1.1) {
      damagePillar(room, pillar, 25);
    }
  }

  addEffect(room, p.x, p.y, "shockwave", "#ffb14d", 125, 25);
}

function tryHaiMovement(room, p, action) {
  if (!p.alive || p.shenfa <= 0 || p.specialCooldown > 0) return;

  if (action === "wallrun" && p.shenfa >= 10) {
    p.shenfa -= 10;
    p.wallRunTimer = 28;
    p.movementMode = "wallrun";
    p.lastAction = "壁上飛行";
    p.specialCooldown = 24;
    addEffect(room, p.x, p.y, "burst", "#ffc16b", 30, 16);
  }

  if (action === "pillar" && p.shenfa >= 8) {
    const nearby = room.map.pillars.some(q =>
      !q.fallen && Math.hypot(q.x - p.x, q.y - p.y) < 85
    );

    if (nearby) {
      p.shenfa -= 8;
      p.airTimer = 8;
      p.movementMode = "air";
      p.lastAction = "轉柱躍身";
      p.specialCooldown = 24;
    }
  }

  if (action === "vault" && p.shenfa >= 12) {
    p.shenfa -= 12;

    const blocked35 = collidesMap(
      room,
      p.x + Math.cos(p.angle) * 35,
      p.y + Math.sin(p.angle) * 35,
      p.r
    );

    const nx = p.x + Math.cos(p.angle) * 70;
    const ny = p.y + Math.sin(p.angle) * 70;

    if (blocked35 && !collidesMap(room, nx, ny, p.r)) {
      p.x = nx;
      p.y = ny;
      p.vaultTimer = 10;
      p.movementMode = "vault";
      p.lastAction = "飛身越障";
      p.specialCooldown = 35;
      addEffect(room, p.x, p.y, "burst", "#ffca83", 35, 18);
    }
  }
}

function updatePlayer(room, p) {
  if (!p.alive) return;

  const keys = p.input || {};
  const left = !!keys.left;
  const right = !!keys.right;
  const up = !!keys.up;
  const down = !!keys.down;

  let dx = (right ? 1 : 0) - (left ? 1 : 0);
  let dy = (down ? 1 : 0) - (up ? 1 : 0);

  if (dx || dy) {
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    p.angle = Math.atan2(dy, dx);
  }

  let speed = p.speed;

  if (p.role === "hai" &&
      ["wallrun", "air", "vault"].includes(p.movementMode)) {
    speed *= 1.55;
  }

  moveGround(room, p, dx * speed, dy * speed);

  if (p.role === "wei") {
    p.shenXing = Math.min(120, p.shenXing + 0.45);
  } else {
    p.shenfa = Math.min(100, p.shenfa + 0.35);
  }

  if (p.specialCooldown > 0) p.specialCooldown--;
  if (p.attackCooldown > 0) p.attackCooldown--;
  if (p.invincible > 0) p.invincible--;
  if (p.specialFlash > 0) p.specialFlash--;
  if (p.attackFlash > 0) p.attackFlash--;
  if (p.hitFlash > 0) p.hitFlash--;

  if (p.role === "hai") {
    if (p.wallRunTimer > 0) {
      p.wallRunTimer--;
      p.movementMode = "wallrun";
    } else if (p.airTimer > 0) {
      p.airTimer--;
      p.movementMode = "air";
    } else if (p.vaultTimer > 0) {
      p.vaultTimer--;
      p.movementMode = "vault";
    } else {
      p.movementMode = "ground";
    }
  }

  if (keys.attack) attack(room, p);

  if (keys.special) {
    if (p.role === "wei") specialWei(room, p);
    else specialHai(room, p);
  }

  if (p.role === "wei" && keys.escape) {
    escapeWei(room, p);
  }

  if (p.role === "hai") {
    if (keys.wallrun) tryHaiMovement(room, p, "wallrun");
    if (keys.pillar) tryHaiMovement(room, p, "pillar");
    if (keys.vault) tryHaiMovement(room, p, "vault");
  }
}

function serializePlayer(p) {
  return {
    id: p.id,
    role: p.role,
    x: p.x,
    y: p.y,
    r: p.r,
    hp: p.hp,
    maxHp: p.maxHp,
    angle: p.angle,
    alive: p.alive,
    specialCooldown: p.specialCooldown,
    invincible: p.invincible,
    movementMode: p.movementMode,
    shenXing: p.shenXing,
    shenfa: p.shenfa,
    escapes: p.escapes,
    specialFlash: p.specialFlash,
    attackFlash: p.attackFlash,
    hitFlash: p.hitFlash,
    lastAction: p.lastAction
  };
}

function serializeRoom(room) {
  return {
    name: room.name,
    players: Object.values(room.players).map(serializePlayer),
    map: room.map,
    started: room.started,
    winner: room.winner,
    effects: room.effects
  };
}

function resetRoom(room) {
  room.map = createMap();
  room.started = Object.keys(room.players).length >= 2;
  room.winner = null;
  room.effects = [];

  for (const p of Object.values(room.players)) {
    const fresh = createPlayer(p.id, p.role);
    Object.assign(p, fresh);
  }
}

function gameLoop() {
  for (const room of rooms.values()) {
    room.tick++;

    if (room.started && !room.winner) {
      for (const p of Object.values(room.players)) updatePlayer(room, p);

      const alive = Object.values(room.players).filter(p => p.alive);
      if (alive.length <= 1 && Object.keys(room.players).length >= 2) {
        room.winner = alive.length === 1 ? alive[0].role : "draw";
      }
    }

    room.effects = room.effects.filter(e => {
      e.life--;
      return e.life > 0;
    });

    io.to(room.name).emit("state", serializeRoom(room));
  }
}

io.on("connection", socket => {
  socket.on("joinRoom", data => {
    const name = String((data && data.room) || "紫禁城").slice(0, 30);
    const role = data && data.role === "hai" ? "hai" : "wei";

    let room = rooms.get(name);
    if (!room) {
      room = createRoom(name);
      rooms.set(name, room);
    }

    if (Object.keys(room.players).length >= 2) {
      socket.emit("joinError", "房間已滿，請選擇其他房間。");
      return;
    }

    if (Object.values(room.players).some(p => p.role === role)) {
      socket.emit("joinError", "這個角色已有人使用，請選另一個角色。");
      return;
    }

    socket.join(name);
    socket.data.room = name;
    socket.data.role = role;

    room.players[socket.id] = createPlayer(socket.id, role);
    room.started = Object.keys(room.players).length >= 2;

    socket.emit("joined", {
      room: name,
      role,
      started: room.started
    });

    io.to(name).emit("state", serializeRoom(room));
  });

  socket.on("input", input => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.players[socket.id]) return;

    const allowed = [
      "up", "down", "left", "right", "attack", "special",
      "escape", "wallrun", "pillar", "vault"
    ];

    const safe = {};
    for (const key of allowed) safe[key] = !!(input && input[key]);

    room.players[socket.id].input = safe;
  });

  socket.on("restart", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    resetRoom(room);
    io.to(room.name).emit("state", serializeRoom(room));
  });

  socket.on("disconnect", () => {
    const name = socket.data.room;
    if (!name) return;

    const room = rooms.get(name);
    if (!room) return;

    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      rooms.delete(name);
    } else {
      room.started = false;
      room.winner = null;
      io.to(name).emit("opponentLeft");
    }
  });
});

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>紫禁城風雲｜韋小寶 vs 海大富</title>
<style>
:root {
  --gold: #f4d18b;
  --gold2: #b98942;
  --red: #791e24;
  --dark: #100d0c;
  --panel: rgba(19, 15, 13, .92);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(ellipse at top, #43241e 0%, #170f0d 50%, #080808 100%);
  color: #f8e7c4;
  font-family: "Noto Serif TC", "Microsoft JhengHei", serif;
  overflow: hidden;
}
button, input { font: inherit; }
button {
  color: #ffe8b1;
  border: 1px solid #b9904e;
  background: linear-gradient(180deg, #682a28, #321515);
  border-radius: 8px;
  padding: 9px 14px;
  cursor: pointer;
  box-shadow: inset 0 1px rgba(255,255,255,.12), 0 3px 8px #0008;
}
button:active { transform: translateY(1px); }
button:disabled { opacity: .35; cursor: not-allowed; }
#topbar {
  position: absolute; z-index: 5; top: 0; left: 0; right: 0;
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px;
  background: linear-gradient(180deg, #160b0beF, #160b0b88, transparent);
  pointer-events: none;
}
#brand { font-size: clamp(16px, 2.2vw, 25px); letter-spacing: 3px; color: var(--gold); text-shadow: 0 2px 12px #d38b34; }
#topbar button { pointer-events: auto; padding: 6px 10px; font-size: 13px; }
#gameWrap {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
}
#game {
  display: block; width: min(100vw, 157.9vh); height: min(63.33vw, 100vh);
  max-width: 100vw; max-height: 100vh; object-fit: contain;
  box-shadow: 0 0 55px #000, 0 0 0 1px #9d6d33;
}
#hud {
  position: absolute; top: 54px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; justify-content: center; gap: 14px;
  width: min(900px, 96vw); pointer-events: none;
}
.fighter {
  flex: 1; min-width: 0; padding: 7px 10px; background: #160e0dd9;
  border: 1px solid #9b713d; border-radius: 8px;
  box-shadow: 0 3px 15px #0009;
}
.fighter .name { display:flex; justify-content:space-between; gap:8px; font-size:13px; margin-bottom:5px; }
.bar { height: 9px; border: 1px solid #6c4c2c; background:#271c18; border-radius: 10px; overflow:hidden; }
.bar > div { height:100%; width:100%; transition: width .15s; }
#weiHp { background: linear-gradient(90deg,#8a242b,#ef6754,#ffcb8b); }
#haiHp { background: linear-gradient(90deg,#9e6828,#e4ba60,#fff0a7); }
.resource { margin-top:5px; height:4px; border-radius:4px; background:#30251e; overflow:hidden; }
.resource div { height:100%; width:100%; background:#79d9e9; }
#haiResource { background:#e2a95d; }
#versus { color:#e9c37b; font-weight:bold; text-shadow:0 2px 8px #000; }
#status {
  position:absolute; left:50%; bottom:14px; transform:translateX(-50%);
  padding:6px 12px; border-radius:6px; background:#110c0bd9;
  border:1px solid #71502e; font-size:13px; text-align:center; max-width:90vw;
}
#joinScreen, #tutorial, #result {
  position:absolute; z-index:10; inset:0; display:flex; align-items:center; justify-content:center;
  background:radial-gradient(ellipse at center,#321b17eF,#090706f5);
  padding:18px;
}
.panel {
  width:min(640px, 96vw); max-height:92vh; overflow:auto;
  padding:clamp(18px, 4vw, 32px);
  border:1px solid #c29a57; border-radius:14px;
  background:linear-gradient(145deg,#2c1a16f7,#100c0bf9);
  box-shadow:0 0 0 5px #3d241b99, 0 18px 65px #000;
}
h1 { margin:0 0 8px; color:#f5d28a; letter-spacing:2px; font-size:clamp(24px,5vw,37px); }
h2 { margin:18px 0 8px; color:#e9c27c; font-size:18px; }
p { line-height:1.7; color:#e4d4b9; }
.small { font-size:12px; color:#bca88b; }
#joinScreen input {
  width:100%; padding:11px; margin:8px 0 12px;
  background:#0d0a09; color:#f8e7c4; border:1px solid #80613b; border-radius:7px;
}
.roleRow { display:flex; gap:10px; margin:12px 0; }
.roleRow button { flex:1; padding:14px 8px; }
.roleRow button.selected { outline:2px solid #f5d28a; background:linear-gradient(#8a3930,#4b1c18); }
.mainBtn { width:100%; margin-top:12px; padding:13px; font-size:16px; }
.tutorialGrid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.tip { padding:11px; border:1px solid #63472e; background:#17100e; border-radius:8px; }
.tip b { color:#f4d18b; }
#tutorial { display:none; z-index:12; }
#result { display:none; z-index:15; background:#090706bb; }
#result .panel { text-align:center; }
#mobileControls { display:none; position:absolute; inset:auto 0 46px 0; z-index:7; pointer-events:none; }
.pad { position:absolute; bottom:0; left:12px; width:150px; height:150px; pointer-events:auto; }
.pad button {
  position:absolute; width:48px; height:48px; padding:0; border-radius:50%;
  font-size:20px; background:#281814bb; border-color:#c49b5b;
  touch-action:none; user-select:none;
}
#up { left:51px; top:0; } #down { left:51px; bottom:0; }
#left { left:0; top:51px; } #right { right:0; top:51px; }
.actions {
  position:absolute; right:12px; bottom:0; display:grid; grid-template-columns:repeat(2,66px);
  gap:9px; pointer-events:auto;
}
.actions button { width:66px; height:58px; padding:3px; font-size:12px; touch-action:none; user-select:none; }
#toast {
  position:absolute; z-index:30; top:27%; left:50%; transform:translate(-50%,-50%);
  background:#140d0df0; border:1px solid #e3bd72; border-radius:8px;
  padding:12px 18px; display:none; text-align:center; box-shadow:0 4px 20px #000;
}
@media (pointer:coarse), (max-width:800px) {
  #mobileControls { display:block; }
  #status { bottom:206px; font-size:11px; }
  #hud { top:48px; gap:5px; }
  .fighter { padding:5px; }
  .fighter .name { font-size:10px; }
  #brand { letter-spacing:1px; }
  .tutorialGrid { grid-template-columns:1fr; }
}
</style>
</head>
<body>
<div id="topbar">
  <div id="brand">紫禁城風雲</div>
  <div>
    <button id="helpBtn">📜 對戰教學</button>
    <button id="backBtn">離開房間</button>
  </div>
</div>

<div id="gameWrap"><canvas id="game" width="1200" height="760"></canvas></div>

<div id="hud">
  <div class="fighter">
    <div class="name"><b>韋小寶</b><span id="weiNumbers">100 / 100</span></div>
    <div class="bar"><div id="weiHp"></div></div>
    <div class="resource"><div id="weiResource"></div></div>
  </div>
  <div id="versus">VS</div>
  <div class="fighter">
    <div class="name"><b>海大富</b><span id="haiNumbers">120 / 120</span></div>
    <div class="bar"><div id="haiHp"></div></div>
    <div class="resource"><div id="haiResource"></div></div>
  </div>
</div>

<div id="status">正在準備紫禁城……</div>
<div id="toast"></div>

<div id="mobileControls">
  <div class="pad">
    <button id="up" data-key="up">▲</button>
    <button id="down" data-key="down">▼</button>
    <button id="left" data-key="left">◀</button>
    <button id="right" data-key="right">▶</button>
  </div>
  <div class="actions">
    <button data-key="attack">⚔<br>攻擊</button>
    <button data-key="special">✦<br>特殊技</button>
    <button data-key="escape">💨<br>脫身</button>
    <button data-key="wallrun">壁上飛行</button>
    <button data-key="pillar">轉柱躍身</button>
    <button data-key="vault">飛身越障</button>
  </div>
</div>

<div id="joinScreen">
  <div class="panel">
    <h1>紫禁城風雲</h1>
    <p>韋小寶 vs 海大富。宮牆、屏風、木箱、石柱與地磚都可能在戰鬥中改變戰局。</p>
    <label for="roomName">對戰房間名稱</label>
    <input id="roomName" maxlength="30" value="紫禁城">
    <h2>選擇角色</h2>
    <div class="roleRow">
      <button id="chooseWei" class="selected">韋小寶<br><span class="small">靈巧、匕首、神行百變</span></button>
      <button id="chooseHai">海大富<br><span class="small">掌勢、破壞、身法</span></button>
    </div>
    <button id="joinBtn" class="mainBtn">進入紫禁城</button>
    <p class="small">兩位玩家需使用相同房間名稱，並分別選擇不同角色。若要測試多人對戰，請讓另一位玩家使用同一個伺服器網址進入。</p>
  </div>
</div>

<div id="tutorial">
  <div class="panel">
    <h1>紫禁城對戰手冊</h1>
    <p>勝負不只取決於攻擊。善用角度、距離、視線與可破壞地形，才有機會反敗為勝。</p>
    <div class="tutorialGrid">
      <div class="tip">
        <b>🗡 韋小寶</b>
        <p>普通攻擊使用匕首。正面命中造成 18 點傷害，側面 24 點，背後 30 點。</p>
        <p>特殊技「神行百變」消耗 35 點身法能量，並提供短暫無敵。脫身可快速移動，但只有 3 次。</p>
      </div>
      <div class="tip">
        <b>🥋 海大富</b>
        <p>普通掌擊傷害 17 點，進行特殊移動時命中可額外造成傷害。</p>
        <p>特殊技「掌勢震擊」可攻擊近距離對手及破壞前方石柱。</p>
        <p>壁上飛行、轉柱躍身、飛身越障各有身法消耗與使用條件。</p>
      </div>
      <div class="tip">
        <b>⌨️ 電腦操作</b>
        <p>W A S D：移動</p>
        <p>空白鍵或 J：普通攻擊</p>
        <p>K：特殊技</p>
        <p>L 或 Shift：韋小寶脫身</p>
        <p>海大富：U 壁上飛行、I 轉柱躍身、O 飛身越障</p>
      </div>
      <div class="tip">
        <b>📱 手機操作</b>
        <p>使用左側方向鍵移動，右側按鈕施展攻擊、特殊技及角色專屬身法。</p>
        <p>點擊教學按鈕可隨時重新查看操作方式。</p>
      </div>
      <div class="tip">
        <b>🏯 場景機制</b>
        <p>木箱會被攻擊破壞，石柱可承受傷害並倒塌，受損地磚也可能崩塌。倒塌物可能改變路線，並影響附近角色。</p>
      </div>
      <div class="tip">
        <b>🎯 對戰策略</b>
        <p>注意角色朝向與攻擊距離。牆壁、屏風及木箱會阻擋視線；不要只顧著連續攻擊，也要觀察對手的移動。</p>
      </div>
    </div>
    <button id="closeTutorial" class="mainBtn">明白，開始對戰</button>
  </div>
</div>

<div id="result">
  <div class="panel">
    <h1 id="resultTitle">對戰結束</h1>
    <p id="resultText"></p>
    <button id="restartBtn" class="mainBtn">重新開始</button>
    <button id="resultTutorialBtn" class="mainBtn">查看教學</button>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
(function() {
  const socket = io();
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  let myRole = "wei";
  let myId = null;
  let roomName = "紫禁城";
  let state = null;
  let joined = false;
  let tutorialWasShown = false;
  let lastSent = "";
  const keys = {
    up:false, down:false, left:false, right:false,
    attack:false, special:false, escape:false,
    wallrun:false, pillar:false, vault:false
  };
  const pressed = {};

  const $ = id => document.getElementById(id);

  function toast(message) {
    $("toast").textContent = message;
    $("toast").style.display = "block";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => $("toast").style.display = "none", 2600);
  }

  function setRole(role) {
    myRole = role;
    $("chooseWei").classList.toggle("selected", role === "wei");
    $("chooseHai").classList.toggle("selected", role === "hai");
  }

  $("chooseWei").onclick = () => setRole("wei");
  $("chooseHai").onclick = () => setRole("hai");

  $("joinBtn").onclick = function() {
    roomName = $("roomName").value.trim() || "紫禁城";
    socket.emit("joinRoom", { room: roomName, role: myRole });
    $("joinBtn").disabled = true;
    $("joinBtn").textContent = "正在進入……";
  };

  socket.on("joined", function(data) {
    joined = true;
    myId = socket.id;
    myRole = data.role;
    roomName = data.room;
    $("joinScreen").style.display = "none";
    $("joinBtn").disabled = false;
    $("joinBtn").textContent = "進入紫禁城";

    if (!tutorialWasShown) {
      $("tutorial").style.display = "flex";
      tutorialWasShown = true;
    }

    toast("已進入「" + roomName + "」，角色：" +
      (myRole === "wei" ? "韋小寶" : "海大富"));
  });

  socket.on("joinError", function(message) {
    $("joinBtn").disabled = false;
    $("joinBtn").textContent = "進入紫禁城";
    toast(message);
  });

  socket.on("opponentLeft", function() {
    toast("對手已離開房間。等待另一位玩家加入。");
  });

  socket.on("state", function(s) {
    state = s;
    if (state.winner) {
      $("result").style.display = "flex";
      if (state.winner === "draw") {
        $("resultTitle").textContent = "平局";
        $("resultText").textContent = "雙方同時倒下。重新整理戰局，再決勝負！";
      } else {
        const winnerName = state.winner === "wei" ? "韋小寶" : "海大富";
        $("resultTitle").textContent = winnerName + " 獲勝！";
        $("resultText").textContent = "紫禁城的勝負已分。重新開始可以重置角色與場景。";
      }
    } else {
      $("result").style.display = "none";
    }
    updateHud();
  });

  $("helpBtn").onclick = () => $("tutorial").style.display = "flex";
  $("closeTutorial").onclick = () => $("tutorial").style.display = "none";
  $("resultTutorialBtn").onclick = () => {
    $("result").style.display = "none";
    $("tutorial").style.display = "flex";
  };
  $("restartBtn").onclick = () => {
    socket.emit("restart");
    $("result").style.display = "none";
  };
  $("backBtn").onclick = () => {
    location.reload();
  };

  function updateHud() {
    if (!state) return;
    const wei = state.players.find(p => p.role === "wei");
    const hai = state.players.find(p => p.role === "hai");

    if (wei) {
      $("weiHp").style.width = (wei.hp / wei.maxHp * 100) + "%";
      $("weiNumbers").textContent = wei.hp + " / " + wei.maxHp;
      $("weiResource").style.width = (wei.shenXing / 120 * 100) + "%";
    }

    if (hai) {
      $("haiHp").style.width = (hai.hp / hai.maxHp * 100) + "%";
      $("haiNumbers").textContent = hai.hp + " / " + hai.maxHp;
      $("haiResource").style.width = (hai.shenfa / 100 * 100) + "%";
    }

    const me = state.players.find(p => p.id === myId);
    if (!state.started) {
      $("status").textContent = "房間「" + roomName + "」｜等待另一位玩家加入……";
    } else if (me) {
      const skill = me.specialCooldown > 0
        ? "特殊技冷卻 " + Math.ceil(me.specialCooldown / 60) + " 秒"
        : "特殊技就緒";
      const resource = me.role === "wei"
        ? "神行能量 " + Math.floor(me.shenXing) + "｜脫身 " + me.escapes + " 次"
        : "身法能量 " + Math.floor(me.shenfa);
      $("status").textContent = resource + "｜" + skill +
        (me.lastAction ? "｜最近動作：" + me.lastAction : "");
    }
  }

  function sendInput() {
    if (!joined) return;
    const packed = JSON.stringify(keys);
    if (packed !== lastSent) {
      socket.emit("input", keys);
      lastSent = packed;
    }
  }

  function keyDown(e) {
    const k = e.key.toLowerCase();
    const mapping = {
      w:"up", arrowup:"up",
      s:"down", arrowdown:"down",
      a:"left", arrowleft:"left",
      d:"right", arrowright:"right",
      " ":"attack", j:"attack",
      k:"special",
      l:"escape", shift:"escape",
      u:"wallrun", i:"pillar", o:"vault"
    };
    const action = mapping[k];
    if (!action) return;
    e.preventDefault();

    if (action === "escape" && myRole !== "wei") return;
    if (["wallrun","pillar","vault"].includes(action) && myRole !== "hai") return;

    if (!pressed[action]) {
      pressed[action] = true;
      keys[action] = true;
      sendInput();
    }
  }

  function keyUp(e) {
    const k = e.key.toLowerCase();
    const mapping = {
      w:"up", arrowup:"up",
      s:"down", arrowdown:"down",
      a:"left", arrowleft:"left",
      d:"right", arrowright:"right",
      " ":"attack", j:"attack",
      k:"special",
      l:"escape", shift:"escape",
      u:"wallrun", i:"pillar", o:"vault"
    };
    const action = mapping[k];
    if (!action) return;
    e.preventDefault();
    pressed[action] = false;
    keys[action] = false;
    sendInput();
  }

  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", function() {
    Object.keys(keys).forEach(k => keys[k] = false);
    Object.keys(pressed).forEach(k => pressed[k] = false);
    sendInput();
  });

  document.querySelectorAll("[data-key]").forEach(function(btn) {
    const action = btn.dataset.key;

    function start(e) {
      e.preventDefault();
      if (action === "escape" && myRole !== "wei") return;
      if (["wallrun","pillar","vault"].includes(action) && myRole !== "hai") return;
      keys[action] = true;
      sendInput();
    }

    function end(e) {
      e.preventDefault();
      keys[action] = false;
      sendInput();
    }

    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);
    btn.addEventListener("pointerleave", end);
    btn.addEventListener("contextmenu", e => e.preventDefault());
  });

  function roundedRect(x,y,w,h,r) {
    ctx.beginPath();
    ctx.roundRect(x,y,w,h,r);
  }

  function drawFloor() {
    const g = ctx.createLinearGradient(0,0,1200,760);
    g.addColorStop(0,"#4c2b22");
    g.addColorStop(.45,"#34231d");
    g.addColorStop(1,"#201814");
    ctx.fillStyle = g;
    ctx.fillRect(0,0,1200,760);

    for (let y=24; y<736; y+=48) {
      for (let x=24; x<1176; x+=48) {
        const alt = ((x/48 + y/48) % 2) === 0;
        ctx.fillStyle = alt ? "#4c3026" : "#412920";
        ctx.fillRect(x,y,48,48);
        ctx.strokeStyle = "#9b6b3c35";
        ctx.lineWidth = 1;
        ctx.strokeRect(x+.5,y+.5,47,47);

        ctx.strokeStyle = "#c3985b20";
        ctx.beginPath();
        ctx.moveTo(x+8,y+8); ctx.lineTo(x+16,y+8);
        ctx.moveTo(x+8,y+8); ctx.lineTo(x+8,y+16);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "#d2a45d";
    ctx.lineWidth = 3;
    ctx.strokeRect(38,38,1124,684);
    ctx.strokeStyle = "#8e5d31";
    ctx.lineWidth = 1;
    ctx.strokeRect(45,45,1110,670);

    for (let i=0; i<12; i++) {
      const x = 65 + i*97;
      ctx.fillStyle = "#b98a4c";
      ctx.fillRect(x,35,22,5);
      ctx.fillRect(x,720,22,5);
    }

    ctx.save();
    ctx.globalAlpha = .10;
    ctx.strokeStyle = "#f5d18b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(600,380,145,0,Math.PI*2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(600,380,125,0,Math.PI*2);
    ctx.stroke();
    ctx.translate(600,380);
    for (let i=0; i<8; i++) {
      ctx.rotate(Math.PI/4);
      ctx.strokeRect(-4,-150,8,300);
    }
    ctx.restore();

    drawLantern(62,80);
    drawLantern(1138,80);
    drawLantern(62,680);
    drawLantern(1138,680);
  }

  function drawLantern(x,y) {
    ctx.save();
    ctx.shadowColor = "#ff8a36";
    ctx.shadowBlur = 18;
    ctx.fillStyle = "#f4a34f";
    ctx.beginPath();
    ctx.ellipse(x,y,8,12,0,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#6c2b18";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#f9d28a";
    ctx.fillRect(x-3,y-17,6,5);
    ctx.fillRect(x-3,y+12,6,7);
    ctx.restore();
  }

  function drawWall(r) {
    ctx.save();
    ctx.shadowColor = "#0009";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    const g = ctx.createLinearGradient(r.x,r.y,r.x,r.y+r.h);
    g.addColorStop(0,"#b18a56");
    g.addColorStop(.25,"#795031");
    g.addColorStop(1,"#3b241b");
    ctx.fillStyle = g;
    ctx.fillRect(r.x,r.y,r.w,r.h);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = "#e3bf7b";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x+1,r.y+1,r.w-2,r.h-2);
    ctx.strokeStyle = "#3b2119";
    ctx.lineWidth = 2;
    if (r.w > r.h) {
      for (let x=r.x+12; x<r.x+r.w; x+=24) {
        ctx.beginPath(); ctx.moveTo(x,r.y+3); ctx.lineTo(x,r.y+r.h-3); ctx.stroke();
      }
    } else {
      for (let y=r.y+12; y<r.y+r.h; y+=24) {
        ctx.beginPath(); ctx.moveTo(r.x+3,y); ctx.lineTo(r.x+r.w-3,y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawMap(map) {
    if (!map) return;

    for (const f of map.floors) {
      ctx.save();
      if (f.state === 0) {
        ctx.fillStyle = "#6d4931";
        ctx.fillRect(f.x,f.y,f.w,f.h);
        ctx.strokeStyle = "#d2a66b";
        ctx.lineWidth = 2;
        ctx.strokeRect(f.x+2,f.y+2,f.w-4,f.h-4);
        ctx.strokeStyle = "#3b281f";
        for (let x=f.x+12; x<f.x+f.w; x+=24) {
          ctx.beginPath(); ctx.moveTo(x,f.y+3); ctx.lineTo(x,f.y+f.h-3); ctx.stroke();
        }
      } else if (f.state === 1) {
        ctx.fillStyle = "#42332b";
        ctx.fillRect(f.x,f.y,f.w,f.h);
        ctx.strokeStyle = "#f0b76a";
        ctx.lineWidth = 2;
        ctx.strokeRect(f.x+2,f.y+2,f.w-4,f.h-4);
        ctx.strokeStyle = "#e2bd89";
        ctx.beginPath();
        ctx.moveTo(f.x+10,f.y+10);
        ctx.lineTo(f.x+f.w*.35,f.y+f.h*.45);
        ctx.lineTo(f.x+f.w*.25,f.y+f.h*.8);
        ctx.moveTo(f.x+f.w*.7,f.y+8);
        ctx.lineTo(f.x+f.w*.6,f.y+f.h*.55);
        ctx.lineTo(f.x+f.w-8,f.y+f.h*.7);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#120d0b";
        ctx.fillRect(f.x,f.y,f.w,f.h);
        ctx.strokeStyle = "#d89d58";
        ctx.setLineDash([5,5]);
        ctx.strokeRect(f.x+2,f.y+2,f.w-4,f.h-4);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    for (const r of map.walls) drawWall(r);

    for (const s of map.screens) {
      ctx.save();
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#6f2926";
      ctx.fillRect(s.x,s.y,s.w,s.h);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#d8b36d";
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x,s.y,s.w,s.h);
      for (let x=s.x+8; x<s.x+s.w; x+=18) {
        ctx.strokeStyle = "#edc77e";
        ctx.beginPath(); ctx.moveTo(x,s.y+3); ctx.lineTo(x,s.y+s.h-3); ctx.stroke();
      }
      ctx.restore();
    }

    for (const c of map.crates) {
      if (c.hp <= 0) {
        ctx.strokeStyle = "#c99a5b66";
        ctx.strokeRect(c.x+5,c.y+5,c.w-10,c.h-10);
        continue;
      }

      ctx.save();
      ctx.shadowColor = "#000";
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#86522b";
      ctx.fillRect(c.x,c.y,c.w,c.h);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#e0b46d";
      ctx.lineWidth = 3;
      ctx.strokeRect(c.x+2,c.y+2,c.w-4,c.h-4);
      ctx.strokeStyle = "#422619";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(c.x+5,c.y+5); ctx.lineTo(c.x+c.w-5,c.y+c.h-5);
      ctx.moveTo(c.x+c.w-5,c.y+5); ctx.lineTo(c.x+5,c.y+c.h-5);
      ctx.stroke();
      if (c.hp < c.maxHp) {
        ctx.fillStyle = "#160d0a";
        ctx.fillRect(c.x,c.y-7,c.w,4);
        ctx.fillStyle = "#e6ae59";
        ctx.fillRect(c.x,c.y-7,c.w*c.hp/c.maxHp,4);
      }
      ctx.restore();
    }

    for (const p of map.pillars) {
      ctx.save();

      if (p.fallen) {
        ctx.translate(p.x,p.y);
        ctx.rotate(.3);
        ctx.fillStyle = "#6d4832";
        ctx.fillRect(-28,-10,56,20);
        ctx.strokeStyle = "#d4a86b";
        ctx.lineWidth = 3;
        ctx.strokeRect(-28,-10,56,20);
        ctx.restore();
        continue;
      }

      ctx.shadowColor = "#000a";
      ctx.shadowBlur = 10;
      const grad = ctx.createRadialGradient(p.x-8,p.y-9,2,p.x,p.y,p.r+8);
      grad.addColorStop(0,"#e0bd83");
      grad.addColorStop(.55,"#9a6b3e");
      grad.addColorStop(1,"#4a2c1f");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#f2d095";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = "#4d2c1d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x,p.y,p.r-7,0,Math.PI*2);
      ctx.stroke();

      if (p.hp < p.maxHp) {
        ctx.fillStyle = "#1a100d";
        ctx.fillRect(p.x-22,p.y-p.r-11,44,5);
        ctx.fillStyle = "#dba45a";
        ctx.fillRect(p.x-22,p.y-p.r-11,44*p.hp/p.maxHp,5);
      }
      ctx.restore();
    }
  }

  function drawPlayer(p) {
    ctx.save();
    ctx.translate(p.x,p.y);

    if (p.invincible > 0 && Math.floor(p.invincible/3)%2===0) {
      ctx.globalAlpha = .48;
    }

    const hai = p.role === "hai";
    const main = hai ? "#d7a24e" : "#398da4";
    const dark = hai ? "#57361d" : "#183e59";
    const light = hai ? "#f4d49a" : "#a9e5ed";

    if (p.movementMode !== "ground" || p.specialFlash > 0) {
      ctx.save();
      ctx.rotate(-p.angle);
      ctx.strokeStyle = hai ? "#ffbc60" : "#8cecff";
      ctx.lineWidth = 3;
      ctx.globalAlpha = .65;
      ctx.beginPath();
      ctx.ellipse(0,0,p.r+10,p.r+16,0,0,Math.PI*2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.shadowColor = "#000";
    ctx.shadowBlur = 10;
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.ellipse(0,5,p.r+4,p.r+2,0,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.moveTo(-p.r*.85,-p.r*.55);
    ctx.lineTo(p.r*.8,-p.r*.6);
    ctx.lineTo(p.r*1.05,p.r*.8);
    ctx.lineTo(-p.r*.9,p.r*.8);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = light;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.ellipse(0,-p.r*.7,p.r*.62,p.r*.67,0,0,Math.PI*2);
    ctx.fill();

    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.ellipse(0,-p.r*1.12,p.r*.72,p.r*.22,0,0,Math.PI*2);
    ctx.fill();
    ctx.fillRect(-p.r*.58,-p.r*1.45,p.r*1.16,4);

    ctx.rotate(p.angle);
    ctx.strokeStyle = hai ? "#f5dfad" : "#e9fbff";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p.r*.5,2);
    ctx.lineTo(p.r+11,2);
    ctx.stroke();

    if (!hai) {
      ctx.strokeStyle = "#b7efff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.r+10,-2);
      ctx.lineTo(p.r+18,2);
      ctx.lineTo(p.r+10,6);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#f6d28c";
      ctx.beginPath();
      ctx.arc(p.r+10,2,4,0,Math.PI*2);
      ctx.fill();
    }

    if (p.attackFlash > 0) {
      ctx.globalAlpha = p.attackFlash/10;
      ctx.strokeStyle = hai ? "#ffcf79" : "#b5f3ff";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(0,0,p.r+25,-.75,.75);
      ctx.stroke();
    }

    ctx.restore();

    ctx.save();
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#140b09";
    ctx.fillText(hai ? "海大富" : "韋小寶",p.x+1,p.y-p.r-25+1);
    ctx.fillStyle = hai ? "#f5d28a" : "#a9ecf7";
    ctx.fillText(hai ? "海大富" : "韋小寶",p.x,p.y-p.r-25);

    ctx.fillStyle = "#180e0c";
    ctx.fillRect(p.x-23,p.y-p.r-18,46,5);
    ctx.fillStyle = hai ? "#e3ad58" : "#60c8df";
    ctx.fillRect(p.x-23,p.y-p.r-18,46*p.hp/p.maxHp,5);
    ctx.restore();
  }

  function drawEffects(effects) {
    for (const e of effects || []) {
      const alpha = Math.max(0,e.life/e.maxLife);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(e.x,e.y);

      if (e.type === "afterimage") {
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.ellipse(0,0,10,18,e.angle,0,Math.PI*2);
        ctx.fill();
      } else if (e.type === "hit") {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 3;
        for (let i=0; i<6; i++) {
          const a = i*Math.PI/3;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a)*4,Math.sin(a)*4);
          ctx.lineTo(Math.cos(a)*e.size*alpha,Math.sin(a)*e.size*alpha);
          ctx.stroke();
        }
      } else if (e.type === "slash") {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 6*alpha;
        ctx.beginPath();
        ctx.arc(0,0,e.size,-1.1,.9);
        ctx.stroke();
      } else if (e.type === "strike") {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 4*alpha;
        ctx.beginPath();
        ctx.arc(0,0,e.size,-.8,.8);
        ctx.stroke();
      } else if (e.type === "shockwave" || e.type === "burst") {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 4*alpha;
        ctx.beginPath();
        ctx.arc(0,0,e.size*(1-alpha*.4),0,Math.PI*2);
        ctx.stroke();
        if (e.type === "burst") {
          ctx.fillStyle = e.color;
          ctx.globalAlpha = alpha*.15;
          ctx.beginPath();
          ctx.arc(0,0,e.size*alpha,0,Math.PI*2);
          ctx.fill();
        }
      } else if (e.type === "collapse" || e.type === "ko") {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 3*alpha;
        ctx.beginPath();
        ctx.arc(0,0,e.size*(1-alpha*.4),0,Math.PI*2);
        ctx.stroke();
        for (let i=0; i<7; i++) {
          const a = i*Math.PI*2/7 + e.angle;
          ctx.fillStyle = e.color;
          ctx.fillRect(Math.cos(a)*e.size*.5,Math.sin(a)*e.size*.5,5*alpha,5*alpha);
        }
      }
      ctx.restore();
    }
  }

  function drawWaitingOverlay() {
    if (state && state.started) return;

    ctx.save();
    ctx.fillStyle = "#100b0bc9";
    ctx.fillRect(300,325,600,110);
    ctx.strokeStyle = "#d7ad68";
    ctx.lineWidth = 2;
    ctx.strokeRect(300,325,600,110);
    ctx.textAlign = "center";
    ctx.fillStyle = "#f5d28a";
    ctx.font = "bold 27px serif";
    ctx.fillText("紫禁城對決",600,368);
    ctx.fillStyle = "#ead8b8";
    ctx.font = "17px sans-serif";
    ctx.fillText("等待另一位玩家加入同一房間……",600,401);
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0,0,1200,760);
    drawFloor();

    if (state && state.map) {
      drawMap(state.map);
      drawEffects(state.effects);

      for (const p of state.players) drawPlayer(p);
      drawWaitingOverlay();
    } else {
      drawWaitingOverlay();
    }

    requestAnimationFrame(render);
  }

  render();
})();
</script>
</body>
</html>`;

app.get("/", (req, res) => res.send(html));

server.listen(PORT, () => {
  console.log("紫禁城風雲伺服器已啟動：" + PORT);
});

setInterval(gameLoop, 1000 / 60) ; 
