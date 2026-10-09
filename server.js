


const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const W = 1200;
const H = 760;

const rooms = new Map();
const players = new Map();

const MAP = {
  minX: -18,
  maxX: 18,
  minZ: -18,
  maxZ: 18
};

const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const rand = (a, b) => a + Math.random() * (b - a);

function makeRoom() {
  return {
    id: Math.random().toString(36).slice(2, 9),
    players: [],
    started: false,
    winner: null,
    destroyed: [],
    items: [
      { id: "item1", type: "lime", x: -9, z: -5, active: true },
      { id: "item2", type: "dart", x: 8, z: -8, active: true },
      { id: "item3", type: "smoke", x: 0, z: 10, active: true },
      { id: "item4", type: "robe", x: -11, z: 7, active: true },
      { id: "item5", type: "dagger", x: 11, z: 5, active: true }
    ],
    messages: [],
    lastUpdate: now()
  };
}

function makePlayer(id, role, roomId) {
  const isWei = role === "wei";

  return {
    id,
    roomId,
    role,
    x: isWei ? -4 : 4,
    y: 0,
    z: 12,
    yaw: isWei ? -Math.PI / 2 : Math.PI / 2,
    hp: isWei ? 100 : 125,
    maxHp: isWei ? 100 : 125,
    stamina: 100,
    maxStamina: 100,
    speed: isWei ? 5.1 : 4.0,
    alive: true,
    blocking: false,
    moving: false,
    inputX: 0,
    inputZ: 0,
    inventory: isWei
      ? { lime: 1, dart: 2, smoke: 1, robe: 0, dagger: 0 }
      : {},
    cooldowns: {},
    effect: "",
    effectUntil: 0,
    invulnerableUntil: 0,
    robeUntil: 0,
    smokeUntil: 0,
    attackUntil: 0,
    lastAttack: 0,
    lastAction: 0,
    lastPickup: 0,
    wallRunUntil: 0,
    combo: 0,
    kills: 0
  };
}

function addMessage(room, message) {
  room.messages.push({ text: message, time: now() });
  room.messages = room.messages.slice(-5);
}

function roomOf(player) {
  return rooms.get(player.roomId);
}

function others(room, player) {
  return room.players
    .filter(id => id !== player.id)
    .map(id => players.get(id))
    .filter(Boolean);
}

function canSee(room, a, b) {
  const blockers = [
    ...obstacles.filter(o => o.type === "screen"),
    ...obstacles.filter(o => o.type === "wall")
  ];

  for (const o of blockers) {
    if (room.destroyed.includes(o.id)) continue;
    if (segmentRect(a.x, a.z, b.x, b.z, o)) return false;
  }
  return true;
}

function segmentRect(x1, z1, x2, z2, rect) {
  const steps = 28;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const z = z1 + (z2 - z1) * t;

    if (
      x >= rect.x - rect.w / 2 &&
      x <= rect.x + rect.w / 2 &&
      z >= rect.z - rect.d / 2 &&
      z <= rect.z + rect.d / 2
    ) return true;
  }
  return false;
}

const obstacles = [
  { id: "northWall", type: "wall", x: 0, z: -18, w: 36, d: 1 },
  { id: "southWall", type: "wall", x: 0, z: 18, w: 36, d: 1 },
  { id: "westWall", type: "wall", x: -18, z: 0, w: 1, d: 36 },
  { id: "eastWall", type: "wall", x: 18, z: 0, w: 1, d: 36 },

  { id: "screen1", type: "screen", x: -7, z: -1, w: 4.8, d: 0.35 },
  { id: "screen2", type: "screen", x: 6, z: 2, w: 4.8, d: 0.35 },
  { id: "screen3", type: "screen", x: 0, z: -8, w: 5.4, d: 0.35 },
  { id: "screen4", type: "screen", x: 0, z: 8, w: 5.4, d: 0.35 },
  { id: "screen5", type: "screen", x: -11, z: 9, w: 3.5, d: 0.35 },
  { id: "screen6", type: "screen", x: 11, z: -9, w: 3.5, d: 0.35 },

  { id: "pillar1", type: "pillar", x: -10, z: -10, w: 1.2, d: 1.2 },
  { id: "pillar2", type: "pillar", x: 10, z: -10, w: 1.2, d: 1.2 },
  { id: "pillar3", type: "pillar", x: -10, z: 10, w: 1.2, d: 1.2 },
  { id: "pillar4", type: "pillar", x: 10, z: 10, w: 1.2, d: 1.2 },
  { id: "pillar5", type: "pillar", x: -3, z: -4, w: 1.2, d: 1.2 },
  { id: "pillar6", type: "pillar", x: 3, z: 4, w: 1.2, d: 1.2 },

  { id: "crate1", type: "crate", x: -13, z: 0, w: 1.5, d: 1.5 },
  { id: "crate2", type: "crate", x: 13, z: 0, w: 1.5, d: 1.5 }
];

function circleRectCollision(x, z, radius, o) {
  const cx = clamp(x, o.x - o.w / 2, o.x + o.w / 2);
  const cz = clamp(z, o.z - o.d / 2, o.z + o.d / 2);
  return Math.hypot(x - cx, z - cz) < radius;
}

function blocked(room, x, z, radius = 0.42) {
  if (
    x < MAP.minX + radius ||
    x > MAP.maxX - radius ||
    z < MAP.minZ + radius ||
    z > MAP.maxZ - radius
  ) return true;

  return obstacles.some(o => {
    if (room.destroyed.includes(o.id)) return false;
    return circleRectCollision(x, z, radius, o);
  });
}

function movePlayer(room, p, dt) {
  if (!p.alive) return;

  const length = Math.hypot(p.inputX, p.inputZ);
  if (length < 0.01) {
    p.moving = false;
    return;
  }

  const nx = p.inputX / Math.max(1, length);
  const nz = p.inputZ / Math.max(1, length);

  p.moving = true;

  const sprinting = p.sprinting && p.stamina > 0;
  const speed = p.speed * (sprinting ? 1.38 : 1);

  if (sprinting) {
    p.stamina = Math.max(0, p.stamina - 18 * dt);
  } else {
    p.stamina = Math.min(p.maxStamina, p.stamina + 11 * dt);
  }

  const dx = nx * speed * dt;
  const dz = nz * speed * dt;
  const radius = p.role === "hai" ? 0.48 : 0.38;

  if (!blocked(room, p.x + dx, p.z, radius)) p.x += dx;
  if (!blocked(room, p.x, p.z + dz, radius)) p.z += dz;
}

function cooldownReady(p, name, ms) {
  const t = now();
  if ((p.cooldowns[name] || 0) > t) return false;
  p.cooldowns[name] = t + ms;
  return true;
}

function hit(room, attacker, target, damage, range, name) {
  if (!attacker.alive || !target.alive) return false;
  if (now() < target.invulnerableUntil) return false;
  if (dist(attacker, target) > range) return false;

  const fx = Math.sin(attacker.yaw);
  const fz = Math.cos(attacker.yaw);
  const tx = target.x - attacker.x;
  const tz = target.z - attacker.z;
  const len = Math.hypot(tx, tz) || 1;
  const dot = (fx * tx + fz * tz) / len;

  if (dot < -0.45) return false;
  if (!canSee(room, attacker, target)) return false;

  if (target.blocking && target.stamina > 5) {
    target.stamina = Math.max(0, target.stamina - damage * 0.65);
    damage *= 0.22;
    target.effect = "block";
    target.effectUntil = now() + 260;
  }

  if (target.role === "wei" && target.robeUntil > now()) {
    damage *= 0.35;
  }

  target.hp = Math.max(0, target.hp - damage);
  target.effect = name || "hit";
  target.effectUntil = now() + 350;
  target.invulnerableUntil = now() + 220;

  addMessage(
    room,
    `${attacker.role === "wei" ? "韋小寶" : "海大富"}使出招式，造成 ${Math.round(damage)} 點傷害！`
  );

  if (target.hp <= 0) {
    target.alive = false;
    room.winner = attacker.role;
    addMessage(room, `${attacker.role === "wei" ? "韋小寶" : "海大富"}勝出！`);
  }

  return true;
}

function getNearestEnemy(room, p, maxRange = 4) {
  return others(room, p)
    .filter(e => e.alive && dist(p, e) <= maxRange && canSee(room, p, e))
    .sort((a, b) => dist(p, a) - dist(p, b))[0];
}

function attack(room, p, type) {
  if (!p.alive || !room.started || room.winner) return;

  const heavy = type === "heavy";
  if (!cooldownReady(p, "attack", heavy ? 900 : 420)) return;

  if (p.stamina < (heavy ? 22 : 8)) return;
  p.stamina -= heavy ? 22 : 8;
  p.attackUntil = now() + (heavy ? 420 : 240);
  p.lastAttack = now();

  const enemy = getNearestEnemy(room, p, heavy ? 3.0 : 2.3);
  if (!enemy) {
    addMessage(room, heavy ? "重擊落空！" : "攻擊落空！");
    return;
  }

  hit(
    room,
    p,
    enemy,
    heavy ? (p.role === "hai" ? 26 : 17) : (p.role === "hai" ? 17 : 11),
    heavy ? 3.0 : 2.3,
    heavy ? "heavy" : "hit"
  );
}

function pickup(room, p) {
  if (p.role !== "wei" || now() - p.lastPickup < 300) return;
  p.lastPickup = now();

  const item = room.items.find(i =>
    i.active && Math.hypot(i.x - p.x, i.z - p.z) < 1.5
  );

  if (!item) return;

  item.active = false;
  p.inventory[item.type] = (p.inventory[item.type] || 0) + 1;

  const names = {
    lime: "石灰粉",
    dart: "暗器",
    smoke: "煙霧彈",
    robe: "寶衣",
    dagger: "玄鐵匕首"
  };

  addMessage(room, `韋小寶取得了：${names[item.type]}`);
}

function useItem(room, p, item) {
  if (p.role !== "wei" || !room.started || room.winner) return;
  if (!p.inventory[item] || p.inventory[item] <= 0) return;
  if (!cooldownReady(p, "item_" + item, 700)) return;

  const enemy = getNearestEnemy(room, p, 12);

  if (item === "robe") {
    p.inventory.robe--;
    p.robeUntil = now() + 6500;
    p.effect = "robe";
    p.effectUntil = p.robeUntil;
    addMessage(room, "韋小寶穿上寶衣，暫時減少受到的傷害！");
    return;
  }

  if (item === "smoke") {
    p.inventory.smoke--;
    p.smokeUntil = now() + 4500;
    p.effect = "smoke";
    p.effectUntil = p.smokeUntil;
    addMessage(room, "煙霧瀰漫，視線受到干擾！");
    return;
  }

  if (!enemy) {
    addMessage(room, "附近沒有能命中的目標！");
    return;
  }

  if (item === "lime") {
    p.inventory.lime--;
    enemy.effect = "blind";
    enemy.effectUntil = now() + 2600;
    enemy.stamina = Math.max(0, enemy.stamina - 12);
    addMessage(room, "石灰粉命中！海大富短暫受到干擾。");
  } else if (item === "dart") {
    p.inventory.dart--;
    hit(room, p, enemy, 13, 12, "dart");
  } else if (item === "dagger") {
    p.inventory.dagger--;
    hit(room, p, enemy, 30, 2.6, "dagger");
  }
}

function haiSkill(room, p, skill) {
  if (p.role !== "hai" || !room.started || room.winner) return;

  const enemy = getNearestEnemy(room, p, 3.5);

  if (skill === "guard") {
    if (!cooldownReady(p, "guard", 7000)) return;
    p.effect = "inner";
    p.effectUntil = now() + 3500;
    p.invulnerableUntil = now() + 450;
    addMessage(room, "海大富運起內力護體！");
    return;
  }

  if (!enemy) {
    addMessage(room, "海大富的招式沒有命中！");
    return;
  }

  if (skill === "palm") {
    if (!cooldownReady(p, "palm", 1300)) return;
    if (p.stamina < 18) return;
    p.stamina -= 18;
    hit(room, p, enemy, 25, 3.5, "palm");
    addMessage(room, "海大富施展化骨綿掌！");
  }

  if (skill === "poison") {
    if (!cooldownReady(p, "poison", 4500)) return;
    if (p.stamina < 24) return;
    p.stamina -= 24;
    if (hit(room, p, enemy, 18, 3.1, "poison")) {
      enemy.effect = "poison";
      enemy.effectUntil = now() + 2200;
      enemy.stamina = Math.max(0, enemy.stamina - 20);
    }
    addMessage(room, "海大富使出陰毒掌法！");
  }

  if (skill === "grab") {
    if (!cooldownReady(p, "grab", 3800)) return;
    if (p.stamina < 20) return;
    p.stamina -= 20;
    if (hit(room, p, enemy, 12, 2.2, "grab")) {
      enemy.stamina = Math.max(0, enemy.stamina - 28);
      enemy.inputX = 0;
      enemy.inputZ = 0;
      enemy.invulnerableUntil = now() + 350;
    }
    addMessage(room, "海大富使出擒拿！");
  }
}

function doAction(room, p, action) {
  if (!p || !p.alive) return;

  if (action === "attack" || action === "heavy") {
    attack(room, p, action);
    return;
  }

  if (action === "pickup") {
    pickup(room, p);
    return;
  }

  if (action.startsWith("item:")) {
    useItem(room, p, action.slice(5));
    return;
  }

  if (action.startsWith("skill:")) {
    haiSkill(room, p, action.slice(6));
    return;
  }

  if (action === "dodge") {
    if (!cooldownReady(p, "dodge", 1100)) return;
    if (p.stamina < 15) return;
    p.stamina -= 15;
    p.invulnerableUntil = now() + 300;

    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);

    const bx = p.x + fx * 1.8;
    const bz = p.z + fz * 1.8;

    if (!blocked(room, bx, bz)) {
      p.x = bx;
      p.z = bz;
    }

    p.effect = "dodge";
    p.effectUntil = now() + 250;
    return;
  }

  if (action === "jump") {
    if (!cooldownReady(p, "jump", 800)) return;
    if (p.stamina < 12) return;
    p.stamina -= 12;
    p.invulnerableUntil = now() + 220;
    p.effect = "jump";
    p.effectUntil = now() + 500;
    return;
  }

  if (action === "break") {
    const obj = obstacles.find(o =>
      o.type === "screen" &&
      !room.destroyed.includes(o.id) &&
      Math.hypot(o.x - p.x, o.z - p.z) < 2.2
    );

    if (obj && cooldownReady(p, "break", 900)) {
      room.destroyed.push(obj.id);
      addMessage(room, "屏風被擊破！");
    }
  }
}

function serialize(room) {
  const visiblePlayers = room.players
    .map(id => players.get(id))
    .filter(Boolean)
    .map(p => ({
      id: p.id,
      role: p.role,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      hp: p.hp,
      maxHp: p.maxHp,
      stamina: p.stamina,
      maxStamina: p.maxStamina,
      alive: p.alive,
      blocking: p.blocking,
      moving: p.moving,
      inventory: p.inventory,
      effect: p.effect,
      effectUntil: p.effectUntil,
      robeUntil: p.robeUntil,
      smokeUntil: p.smokeUntil,
      attackUntil: p.attackUntil,
      wallRunUntil: p.wallRunUntil
    }));

  return {
    id: room.id,
    started: room.started,
    winner: room.winner,
    players: visiblePlayers,
    items: room.items,
    destroyed: room.destroyed,
    messages: room.messages,
    obstacles
  };
}

function broadcastRoom(room) {
  const state = serialize(room);
  for (const id of room.players) {
    io.to(id).emit("state", state);
  }
}

function findOrCreateRoom() {
  for (const room of rooms.values()) {
    if (!room.started && room.players.length < 2) return room;
  }

  const room = makeRoom();
  rooms.set(room.id, room);
  return room;
}

io.on("connection", socket => {
  socket.on("joinGame", () => {
    if (players.has(socket.id)) return;

    const room = findOrCreateRoom();
    const role = room.players.length === 0 ? "wei" : "hai";
    const p = makePlayer(socket.id, role, room.id);

    players.set(socket.id, p);
    room.players.push(socket.id);
    socket.join(room.id);

    socket.emit("joined", {
      id: socket.id,
      role,
      roomId: room.id
    });

    addMessage(room, role === "wei"
      ? "韋小寶進入紫禁城。"
      : "海大富現身！對決開始。"
    );

    if (room.players.length >= 2) {
      room.started = true;
      addMessage(room, "對決開始！善用地形與技能取得勝利。");
    }

    broadcastRoom(room);
  });

  socket.on("input", data => {
    const p = players.get(socket.id);
    if (!p || !data) return;

    p.yaw = Number.isFinite(data.yaw) ? data.yaw : p.yaw;

    // dx、dz 是依攝影機朝向計算的世界座標方向。
    // 前端往上推搖桿時，forward 必須是正值。
    p.inputX = clamp(Number(data.dx) || 0, -1, 1);
    p.inputZ = clamp(Number(data.dz) || 0, -1, 1);
    p.blocking = !!data.blocking;
    p.sprinting = !!data.sprinting;
  });

  socket.on("action", action => {
    const p = players.get(socket.id);
    if (!p) return;

    const room = roomOf(p);
    if (!room) return;

    doAction(room, p, String(action || ""));
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    const p = players.get(socket.id);
    if (!p) return;

    const room = roomOf(p);
    players.delete(socket.id);

    if (room) {
      room.players = room.players.filter(id => id !== socket.id);
      room.started = false;
      room.winner = null;

      addMessage(room, "一名玩家離開了對戰。");

      if (room.players.length === 0) {
        rooms.delete(room.id);
      } else {
        broadcastRoom(room);
      }
    }
  });
});

setInterval(() => {
  const t = now();

  for (const room of rooms.values()) {
    const dt = Math.min(0.1, (t - room.lastUpdate) / 1000);
    room.lastUpdate = t;

    for (const id of room.players) {
      const p = players.get(id);
      if (!p) continue;

      if (room.started && !room.winner) {
        movePlayer(room, p, dt);

        if (p.effectUntil < t) {
          if (!p.robeUntil || p.robeUntil < t) {
            if (p.effect === "robe") p.effect = "";
          }
          if (p.effect !== "smoke" || p.smokeUntil < t) {
            p.effect = "";
          }
        }
      }
    }

    broadcastRoom(room);
  }
}, 50);

app.get("/", (req, res) => {
  res.send(PAGE);
});

const PAGE = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>紫禁城：韋小寶 vs 海大富</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#090d16;color:#fff;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;touch-action:none}
canvas{display:block}
#game{position:fixed;inset:0}
#loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;background:radial-gradient(ellipse,#27354b,#080b13 70%);z-index:30;text-align:center;padding:24px}
#loading h1{font-size:clamp(26px,6vw,48px);letter-spacing:4px;color:#f5d99a;text-shadow:0 0 28px #d89c47;margin:0 0 12px}
#loading p{color:#bdc5d5;line-height:1.8}
#start{border:1px solid #e5c37d;background:linear-gradient(135deg,#8d2823,#351719);color:#fff2cf;padding:14px 32px;border-radius:8px;font-size:18px;font-weight:800;letter-spacing:3px;margin-top:18px}
#hud{position:fixed;inset:0;pointer-events:none;display:none}
.panel{background:linear-gradient(135deg,#111927dd,#090d17bb);border:1px solid #c7a96a77;border-radius:12px;box-shadow:0 5px 24px #0006;backdrop-filter:blur(8px)}
#top{position:absolute;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
#identity{padding:10px 13px;min-width:140px}
#identity .name{font-size:17px;font-weight:900;color:#f6d998;letter-spacing:2px}
#identity .sub{font-size:11px;color:#aeb9cb;margin-top:3px}
#status{padding:9px 12px;width:min(45vw,260px)}
.barline{display:flex;justify-content:space-between;font-size:11px;color:#d7dce7;margin-bottom:4px}
.bar{height:7px;background:#333b48;border-radius:10px;overflow:hidden;margin-bottom:8px}
.fill{height:100%;width:100%;transition:width .12s linear;border-radius:10px}
#hpFill{background:linear-gradient(90deg,#a61f2b,#ff6b61)}
#stFill{background:linear-gradient(90deg,#158d80,#66e6bd)}
#round{position:absolute;top:95px;left:50%;transform:translateX(-50%);padding:6px 12px;font-size:12px;white-space:nowrap;color:#eeddb8}
#messages{position:absolute;left:12px;top:150px;max-width:min(65vw,330px);font-size:12px;line-height:1.7;color:#f2dfb4;text-shadow:0 2px 4px #000}
#crosshair{position:absolute;left:50%;top:50%;width:14px;height:14px;transform:translate(-50%,-50%);opacity:.8}
#crosshair:before,#crosshair:after{content:"";position:absolute;background:#fff0c5;box-shadow:0 0 6px #ffda8a}
#crosshair:before{width:2px;height:14px;left:6px;top:0}
#crosshair:after{height:2px;width:14px;top:6px;left:0}
#bottom{position:absolute;bottom:12px;left:12px;right:12px;display:flex;justify-content:space-between;align-items:flex-end;gap:8px}
#joystick{width:132px;height:132px;border-radius:50%;background:radial-gradient(circle,#26364f88,#0c1525aa);border:2px solid #d7c18c88;position:relative;pointer-events:auto;touch-action:none;box-shadow:inset 0 0 20px #0008}
#joyKnob{position:absolute;width:48px;height:48px;border-radius:50%;left:40px;top:40px;background:linear-gradient(135deg,#f2dfb5,#8e7449);border:2px solid #fff0c2;box-shadow:0 4px 12px #0009}
#joyLabel{position:absolute;left:0;right:0;bottom:13px;text-align:center;font-size:10px;color:#e5d4ad;opacity:.75;pointer-events:none}
#buttons{display:grid;grid-template-columns:repeat(3,58px);gap:7px;pointer-events:auto}
.act{height:54px;border-radius:50%;border:1px solid #d9c18b99;background:linear-gradient(145deg,#273247eF,#101722f0);color:#fff0cb;font-size:11px;font-weight:800;box-shadow:0 3px 10px #0008;touch-action:manipulation}
.act:active{transform:scale(.92);filter:brightness(1.5)}
.act.primary{background:linear-gradient(145deg,#a23b2b,#4a171c);border-color:#f2b58c}
.act.skill{background:linear-gradient(145deg,#5c3a83,#211832);border-color:#c2a6f0}
#items{position:absolute;right:12px;top:120px;display:flex;flex-direction:column;gap:5px;pointer-events:auto}
.itembtn{border:1px solid #c6ac6b99;background:#141a27df;color:#f5dba4;padding:7px 10px;border-radius:8px;font-size:11px}
#hint{position:absolute;bottom:155px;left:50%;transform:translateX(-50%);padding:6px 12px;background:#090e18b8;border-radius:6px;font-size:11px;color:#f5e4bd;white-space:nowrap}
#result{position:absolute;inset:0;background:#050912d9;display:none;align-items:center;justify-content:center;flex-direction:column;pointer-events:auto;text-align:center}
#result h2{font-size:36px;color:#f5dba4;letter-spacing:5px}
#result button{padding:12px 25px;background:#7d2925;color:white;border:1px solid #e8c77e;border-radius:8px}
@media(min-width:800px){
 #bottom{bottom:20px;left:22px;right:22px}
 #joystick{width:145px;height:145px}
 #buttons{grid-template-columns:repeat(3,66px);gap:9px}
 .act{height:60px}
 #messages{top:155px}
}
</style>
</head>
<body>
<div id="game"></div>
<div id="loading">
  <h1>紫禁城</h1>
  <div style="color:#d9bd80;letter-spacing:5px;font-size:12px">THE FORBIDDEN CITY DUEL</div>
  <p>韋小寶　對決　海大富<br>第一人稱多人武俠對戰<br>請兩位玩家分別開啟遊戲網址加入同一場對決。</p>
  <button id="start">踏入紫禁城</button>
  <div id="loadStatus" style="font-size:12px;color:#9faec1;margin-top:14px">正在準備場景……</div>
</div>
<div id="hud">
  <div id="top">
    <div id="identity" class="panel">
      <div class="name" id="roleName">韋小寶</div>
      <div class="sub" id="roleSub">機敏・計謀・道具</div>
    </div>
    <div id="status" class="panel">
      <div class="barline"><span>氣血</span><span id="hpText">100 / 100</span></div>
      <div class="bar"><div class="fill" id="hpFill"></div></div>
      <div class="barline"><span>體力</span><span id="stText">100 / 100</span></div>
      <div class="bar"><div class="fill" id="stFill"></div></div>
    </div>
  </div>
  <div id="round" class="panel">等待另一位玩家加入……</div>
  <div id="messages"></div>
  <div id="crosshair"></div>
  <div id="items"></div>
  <div id="hint">左側移動・右側轉動視角</div>
  <div id="bottom">
    <div id="joystick"><div id="joyKnob"></div><div id="joyLabel">移動</div></div>
    <div id="buttons">
      <button class="act" data-action="pickup">拾取</button>
      <button class="act primary" data-action="attack">出掌</button>
      <button class="act primary" data-action="heavy">重擊</button>
      <button class="act" data-action="dodge">閃避</button>
      <button class="act" data-action="jump">輕功</button>
      <button class="act" data-action="break">破屏</button>
      <button class="act skill" data-action="skill:palm" id="skill1">綿掌</button>
      <button class="act skill" data-action="skill:poison" id="skill2">陰毒掌</button>
      <button class="act skill" data-action="skill:grab" id="skill3">擒拿</button>
      <button class="act skill" data-action="skill:guard" id="skill4">護體</button>
    </div>
  </div>
  <div id="result"><h2 id="resultTitle">對決結束</h2><p id="resultText"></p><button onclick="location.reload()">再戰一次</button></div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
<script>
(() => {
"use strict";

const $ = id => document.getElementById(id);
const socket = io();
let myId = null, myRole = null, roomState = null, started = false;
let scene, camera, renderer, clock;
let yaw = 0, pitch = 0, moveX = 0, moveY = 0;
let blockHeld = false, sprinting = false;
let lastFrame = 0, bob = 0, jumpY = 0, jumpV = 0;
let lookTouch = null, joyPointer = null;
let playerMeshes = new Map(), itemMeshes = new Map(), objectMeshes = new Map();
let handGroup, weaponGroup, flashLight, ambientParticles = [];
let audioCtx = null;
const keys = {};
const raycaster = new THREE.Raycaster();
const vForward = new THREE.Vector3();
const vRight = new THREE.Vector3();
const tempVec = new THREE.Vector3();

function material(color, roughness=.8, metalness=0) {
  return new THREE.MeshStandardMaterial({color,roughness,metalness});
}
function box(w,h,d,mat,x,y,z, parent=scene) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
  mesh.position.set(x,y,z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function cylinder(rt,rb,h,mat,x,y,z, parent=scene, seg=12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,seg),mat);
  mesh.position.set(x,y,z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function makeTextSprite(text, color="#f3dca4") {
  const c=document.createElement("canvas");
  c.width=512;c.height=128;
  const ctx=c.getContext("2d");
  ctx.fillStyle="rgba(7,12,20,.75)";
  ctx.roundRect(5,5,502,118,22);ctx.fill();
  ctx.strokeStyle=color;ctx.lineWidth=4;ctx.stroke();
  ctx.font="bold 42px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";
  ctx.fillStyle=color;ctx.fillText(text,256,64);
  const tex=new THREE.CanvasTexture(c);
  const s=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false}));
  s.scale.set(2.5,.62,1);
  return s;
}

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101827);
  scene.fog = new THREE.FogExp2(0x101827, .022);

  camera = new THREE.PerspectiveCamera(76, innerWidth/innerHeight, .08, 150);
  camera.rotation.order = "YXZ";

  renderer = new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.8));
  renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  $("game").appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0x9eb9e3,0x4b3425,2.1);
  scene.add(hemi);

  const moon = new THREE.DirectionalLight(0xffdfaa,3.0);
  moon.position.set(-12,22,8);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024,1024);
  moon.shadow.camera.left=-30;moon.shadow.camera.right=30;
  moon.shadow.camera.top=30;moon.shadow.camera.bottom=-30;
  scene.add(moon);

  const fill = new THREE.PointLight(0xff9e49,18,30);
  fill.position.set(0,5,0);
  scene.add(fill);

  makeGround();
  makePalace();
  makeLanterns();
  makeDecor();
  makeParticles();

  handGroup = new THREE.Group();
  camera.add(handGroup);
  scene.add(camera);

  const sleeveMat = material(myRole==="hai"?0x202a3b:0x8c2630);
  const skinMat = material(0xc98e65);
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(.22,.43,.24),sleeveMat);
  sleeve.position.set(.39,-.37,-.72);
  sleeve.rotation.z=-.25;
  handGroup.add(sleeve);

  const hand = new THREE.Mesh(new THREE.SphereGeometry(.105,12,10),skinMat);
  hand.position.set(.39,-.16,-.79);
  handGroup.add(hand);

  weaponGroup = new THREE.Group();
  weaponGroup.position.set(.39,-.23,-.82);
  handGroup.add(weaponGroup);
  makeWeapon();

  flashLight = new THREE.PointLight(0xffd28a,0,4);
  camera.add(flashLight);
  flashLight.position.set(0,-.2,-1);

  clock = new THREE.Clock();
  addEventListener("resize", onResize);
  addEventListener("mousemove", mouseLook);
  renderer.domElement.addEventListener("click", () => {
    if (innerWidth>800 && document.pointerLockElement!==renderer.domElement) {
      renderer.domElement.requestPointerLock?.();
    }
  });
  animate();
}

function makeGround() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(42,42),
    material(0x55525a,.92)
  );
  ground.rotation.x=-Math.PI/2;
  ground.position.y=-.08;
  ground.receiveShadow=true;
  scene.add(ground);

  const tileMat=material(0x77716b,.9);
  for(let x=-18;x<=18;x+=2){
    for(let z=-18;z<=18;z+=2){
      const tile=box(1.96,.025,1.96,tileMat,x,-.04,z);
      tile.castShadow=false;
    }
  }

  const gold=material(0xb99655,.55,.4);
  for(let i=-16;i<=16;i+=4){
    box(.055,.012,36,gold,i,.005,0);
    box(36,.012,.055,gold,0,.006,i);
  }
}

function makePalace() {
  const red=material(0x72282a);
  const darkRed=material(0x401a20);
  const gold=material(0xc69d52,.35,.5);
  const stone=material(0x777b82);
  const roof=material(0x263b4a,.42,.25);

  // 四周宮牆與基座
  box(37,4,1.1,red,0,1.9,-18);
  box(37,4,1.1,red,0,1.9,18);
  box(1.1,4,37,red,-18,1.9,0);
  box(1.1,4,37,red,18,1.9,0);

  for(let x=-16;x<=16;x+=4){
    box(.12,4.25,.12,gold,x,2,-17.4);
    box(.12,4.25,.12,gold,x,2,17.4);
  }

  // 宮殿中央台基
  box(14,.6,8,stone,0,.22,-13);
  box(13,.18,7,material(0xb7a27e),0,.61,-13);
  box(11,.15,5.5,material(0x6e5a48),0,.76,-13);

  // 殿柱、殿身、屋頂
  for(const x of [-5,-2.5,0,2.5,5]){
    for(const z of [-15.6,-10.6]){
      cylinder(.22,.25,4,red,x,2.8,z);
      cylinder(.28,.28,.16,gold,x,4.65,z);
      cylinder(.26,.26,.12,gold,x,1.05,z);
    }
  }
  box(12,2.7,.45,darkRed,0,2.55,-15.7);
  box(12,2.7,.45,darkRed,0,2.55,-10.5);
  box(.45,2.7,5.6,darkRed,-5.8,2.55,-13.1);
  box(.45,2.7,5.6,darkRed,5.8,2.55,-13.1);

  const roof1=box(13,.35,7,roof,0,5.1,-13.1);
  roof1.rotation.x=.035;
  const roof2=box(14,.2,7.4,gold,0,5.3,-13.1);
  roof2.material=roof;

  for(const x of [-6.8,6.8]){
    cylinder(.12,.12,1.3,gold,x,5.5,-13.1);
    cylinder(.08,.08,.55,gold,x,6.3,-13.1);
  }

  // 中央通道與階梯
  for(let i=0;i<5;i++){
    box(4,.12,.65,material(0x9b8d79),0,.08+i*.1,-8.5+i*.65);
  }

  // 遠景屋簷
  for(const side of [-1,1]){
    const x=side*15;
    box(3,.22,16,roof,x,4.3,0);
    box(3.3,.15,16.3,gold,x,4.42,0).material=roof;
    for(let z=-7;z<=7;z+=3.5){
      cylinder(.11,.11,3.2,red,x,2.7,z);
    }
  }
}

function makeLanterns() {
  const red=material(0xb72f2c,.5);
  const gold=material(0xf2c46e,.35,.4);
  const glow=material(0xffc56b,.3,0);
  const positions=[
    [-8,3,-5],[8,3,-5],[-8,3,5],[8,3,5],
    [-14,3,-12],[14,3,-12],[-14,3,12],[14,3,12],
    [-3,3,0],[3,3,0]
  ];

  positions.forEach(([x,y,z])=>{
    cylinder(.045,.045,1.5,gold,x,y+.3,z);
    cylinder(.35,.28,.65,red,x,y-.4,z,scene,16);
    cylinder(.24,.24,.1,gold,x,y-.4,z,scene,16);
    cylinder(.24,.24,.1,gold,x,y-.75,z,scene,16);
    const light=new THREE.PointLight(0xff9c42,2.2,7);
    light.position.set(x,y-.4,z);
    scene.add(light);
    const bulb=new THREE.Mesh(new THREE.SphereGeometry(.17,10,8),glow);
    bulb.position.set(x,y-.4,z);
    scene.add(bulb);
  });
}

function makeDecor() {
  const wood=material(0x53352c);
  const gold=material(0xc49b58,.35,.4);
  const screenMat=new THREE.MeshStandardMaterial({
    color:0x1c4c48,roughness:.65,side:THREE.DoubleSide
  });
  const silk=material(0x9b7d55);

  const screens=[
    [-7,-1,4.8,.35,0],
    [6,2,4.8,.35,0],
    [0,-8,5.4,.35,0],
    [0,8,5.4,.35,0],
    [-11,9,3.5,.35,0],
    [11,-9,3.5,.35,0]
  ];

  screens.forEach(([x,z,w,d])=>{
    const g=new THREE.Group();
    g.position.set(x,0,z);
    box(w,.12,d,wood,0,.08,0,g);
    box(w,.12,d,wood,0,2.2,0,g);
    box(.12,2.2,d,wood,-w/2,1.15,0,g);
    box(.12,2.2,d,wood,w/2,1.15,0,g);
    const panel=box(w-.3,1.85,.07,screenMat,0,1.15,0,g);
    panel.userData.screen=true;
    // 山水紋飾
    for(let i=0;i<5;i++){
      const line=box(.04,.75,.025,gold,-w/2+.45+i*(w-.9)/4,1.15,-.055,g);
      line.material=gold;
    }
    const ornament=box(w-.55,.035,.025,gold,0,1.7,-.06,g);
    g.userData.objectId="screen";
    scene.add(g);
    objectMeshes.set("decor_"+x+"_"+z,g);
  });

  // 木箱與石燈
  for(const [x,z] of [[-13,0],[13,0]]){
    const crate=box(1.25,1.1,1.25,wood,x,.55,z);
    crate.userData.crate=true;
    for(let i=-1;i<=1;i++){
      box(.04,1.05,1.28,gold,x+i*.4,.55,z-.01);
    }
  }

  // 遠景屏風外的石燈
  for(const [x,z] of [[-15,-4],[15,4],[-15,7],[15,-7]]){
    box(.8,.25,.8,material(0x5d626b),x,.4,z);
    box(.55,.75,.55,material(0x777b82),x,.85,z);
    box(.9,.12,.9,gold,x,1.25,z);
    cylinder(.3,.25,.42,material(0x444c56),x,1.5,z);
    const l=new THREE.PointLight(0xffaa57,1.2,5);
    l.position.set(x,1.8,z);scene.add(l);
  }
}

function makeParticles() {
  const geom=new THREE.BufferGeometry();
  const count=150;
  const arr=new Float32Array(count*3);
  for(let i=0;i<count;i++){
    arr[i*3]=rand(-18,18);
    arr[i*3+1]=rand(.5,7);
    arr[i*3+2]=rand(-18,18);
  }
  geom.setAttribute("position",new THREE.BufferAttribute(arr,3));
  const points=new THREE.Points(geom,new THREE.PointsMaterial({
    color:0xe5c78a,size:.035,transparent:true,opacity:.55
  }));
  scene.add(points);
  ambientParticles.push(points);
}

function makeWeapon() {
  while(weaponGroup.children.length) weaponGroup.remove(weaponGroup.children[0]);
  const metal=material(0xc3ccd7,.25,.8);
  const gold=material(0xd8b05f,.25,.6);
  const dark=material(0x39251f);
  if(myRole==="hai"){
    cylinder(.035,.045,.68,metal,0,-.05,0,weaponGroup,8).rotation.z=-.2;
    cylinder(.075,.075,.16,dark,0,-.35,0,weaponGroup,8);
    cylinder(.045,.045,.18,gold,0,-.45,0,weaponGroup,8);
  }else{
    box(.07,.48,.07,metal,0,-.05,0,weaponGroup);
    box(.16,.08,.11,gold,0,-.32,0,weaponGroup);
    box(.1,.13,.1,dark,0,-.4,0,weaponGroup);
  }
}

function onResize() {
  if(!camera||!renderer)return;
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.8));
}

function mouseLook(e) {
  if(innerWidth<=800 || document.pointerLockElement!==renderer.domElement)return;
  yaw -= e.movementX*.0021;
  pitch -= e.movementY*.0018;
  pitch=clamp(pitch,-1.15,1.15);
}

function action(name) {
  if(socket.connected) socket.emit("action",name);
  if(name==="attack"||name==="heavy"){
    handGroup.rotation.x=-.45;
    setTimeout(()=>{if(handGroup)handGroup.rotation.x=0},180);
    flashLight.intensity=2.4;
    setTimeout(()=>{if(flashLight)flashLight.intensity=0},100);
    sound(name==="heavy"?95:180,.08);
  }
}

function sound(freq,duration) {
  try{
    audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    const osc=audioCtx.createOscillator();
    const gain=audioCtx.createGain();
    osc.type="triangle";osc.frequency.value=freq;
    gain.gain.setValueAtTime(.08,audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+duration);
    osc.connect(gain);gain.connect(audioCtx.destination);
    osc.start();osc.stop(audioCtx.currentTime+duration);
  }catch(e){}
}

function bindControls() {
  const joy=$("joystick"), knob=$("joyKnob");
  let joyRect=null;

  function joyStart(e){
    e.preventDefault();
    joyPointer=e.pointerId;
    joy.setPointerCapture?.(e.pointerId);
    joyRect=joy.getBoundingClientRect();
    joyMove(e);
  }

  function joyMove(e){
    if(joyPointer===null || e.pointerId!==joyPointer)return;
    e.preventDefault();
    if(!joyRect)joyRect=joy.getBoundingClientRect();
    const cx=joyRect.left+joyRect.width/2;
    const cy=joyRect.top+joyRect.height/2;
    const max=joyRect.width*.32;
    let dx=e.clientX-cx,dy=e.clientY-cy;
    const len=Math.hypot(dx,dy);
    if(len>max){dx=dx/len*max;dy=dy/len*max}
    knob.style.left=(joyRect.width/2-24+dx)+"px";
    knob.style.top=(joyRect.height/2-24+dy)+"px";

    // 修正重點：畫面往上推，moveY 是負數。
    // 後續 forward = -moveY，因此往上推會向前走。
    moveX=clamp(dx/max,-1,1);
    moveY=clamp(dy/max,-1,1);
  }

  function joyEnd(e){
    if(joyPointer===null || (e && e.pointerId!==joyPointer))return;
    joyPointer=null;
    moveX=0;moveY=0;
    knob.style.left="40px";knob.style.top="40px";
  }

  joy.addEventListener("pointerdown",joyStart);
  joy.addEventListener("pointermove",joyMove);
  joy.addEventListener("pointerup",joyEnd);
  joy.addEventListener("pointercancel",joyEnd);
  joy.addEventListener("lostpointercapture",joyEnd);

  // 右側拖曳只轉動鏡頭，不會搶走左側操縱桿的控制權。
  renderer.domElement.addEventListener("pointerdown",e=>{
    if(e.pointerType==="mouse")return;
    if(e.clientX<innerWidth*.38)return;
    lookTouch={id:e.pointerId,x:e.clientX,y:e.clientY};
    renderer.domElement.setPointerCapture?.(e.pointerId);
  });

  renderer.domElement.addEventListener("pointermove",e=>{
    if(!lookTouch||lookTouch.id!==e.pointerId)return;
    const dx=e.clientX-lookTouch.x;
    const dy=e.clientY-lookTouch.y;
    yaw-=dx*.005;
    pitch=clamp(pitch-dy*.004,-1.15,1.15);
    lookTouch.x=e.clientX;lookTouch.y=e.clientY;
  });

  function endLook(e){
    if(lookTouch&&(!e||lookTouch.id===e.pointerId))lookTouch=null;
  }
  renderer.domElement.addEventListener("pointerup",endLook);
  renderer.domElement.addEventListener("pointercancel",endLook);

  document.querySelectorAll("[data-action]").forEach(btn=>{
    btn.addEventListener("pointerdown",e=>e.preventDefault());
    btn.addEventListener("click",()=>action(btn.dataset.action));
  });

  addEventListener("keydown",e=>{
    keys[e.code]=true;
    if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code))e.preventDefault();
    if(e.repeat)return;
    if(e.code==="Space")action("jump");
    if(e.code==="KeyE")action("pickup");
    if(e
