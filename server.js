const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const players = new Map();

const MAP = { minX: -18, maxX: 18, minZ: -18, maxZ: 18 };
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const rand = (a, b) => a + Math.random() * (b - a);

const obstacles = [
  { id: "northWall", type: "wall", x: 0, z: -18, w: 36, d: 1 },
  { id: "southWall", type: "wall", x: 0, z: 18, w: 36, d: 1 },
  { id: "westWall", type: "wall", x: -18, z: 0, w: 1, d: 36 },
  { id: "eastWall", type: "wall", x: 18, z: 0, w: 1, d: 36 },
  { id: "screen1", type: "screen", x: -7, z: -1, w: 4.8, d: .35 },
  { id: "screen2", type: "screen", x: 6, z: 2, w: 4.8, d: .35 },
  { id: "screen3", type: "screen", x: 0, z: -8, w: 5.4, d: .35 },
  { id: "screen4", type: "screen", x: 0, z: 8, w: 5.4, d: .35 },
  { id: "screen5", type: "screen", x: -11, z: 9, w: 3.5, d: .35 },
  { id: "screen6", type: "screen", x: 11, z: -9, w: 3.5, d: .35 },
  { id: "pillar1", type: "pillar", x: -10, z: -10, w: 1.2, d: 1.2 },
  { id: "pillar2", type: "pillar", x: 10, z: -10, w: 1.2, d: 1.2 },
  { id: "pillar3", type: "pillar", x: -10, z: 10, w: 1.2, d: 1.2 },
  { id: "pillar4", type: "pillar", x: 10, z: 10, w: 1.2, d: 1.2 },
  { id: "pillar5", type: "pillar", x: -3, z: -4, w: 1.2, d: 1.2 },
  { id: "pillar6", type: "pillar", x: 3, z: 4, w: 1.2, d: 1.2 },
  { id: "crate1", type: "crate", x: -13, z: 0, w: 1.5, d: 1.5 },
  { id: "crate2", type: "crate", x: 13, z: 0, w: 1.5, d: 1.5 }
];

function makeRoom(mode) {
  return {
    id: Math.random().toString(36).slice(2, 9),
    mode,
    players: [],
    humanIds: [],
    botIds: [],
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

function makePlayer(id, role, roomId, isAI = false) {
  const isWei = role === "wei";
  return {
    id, roomId, role, isAI,
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
    sprinting: false,
    inventory: isWei
      ? { lime: 1, dart: 2, smoke: 1, robe: 0, dagger: 0 }
      : { lime: 0, dart: 0, smoke: 0, robe: 0, dagger: 0 },
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
    kills: 0,
    aiThinkAt: 0,
    aiStrafe: Math.random() < .5 ? -1 : 1,
    aiStrafeUntil: 0
  };
}

function addMessage(room, message) {
  room.messages.push({ text: message, time: now() });
  room.messages = room.messages.slice(-6);
}

function roomOf(p) {
  return rooms.get(p.roomId);
}

function others(room, p) {
  return room.players
    .filter(id => id !== p.id)
    .map(id => players.get(id))
    .filter(Boolean);
}

function segmentRect(x1, z1, x2, z2, rect) {
  const steps = 32;
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

function canSee(room, a, b) {
  for (const o of obstacles) {
    if (o.type !== "screen" && o.type !== "wall") continue;
    if (room.destroyed.includes(o.id)) continue;
    if (segmentRect(a.x, a.z, b.x, b.z, o)) return false;
  }
  return true;
}

function circleRectCollision(x, z, radius, o) {
  const cx = clamp(x, o.x - o.w / 2, o.x + o.w / 2);
  const cz = clamp(z, o.z - o.d / 2, o.z + o.d / 2);
  return Math.hypot(x - cx, z - cz) < radius;
}

function blocked(room, x, z, radius = .42) {
  if (
    x < MAP.minX + radius || x > MAP.maxX - radius ||
    z < MAP.minZ + radius || z > MAP.maxZ - radius
  ) return true;

  return obstacles.some(o => {
    if (room.destroyed.includes(o.id)) return false;
    return circleRectCollision(x, z, radius, o);
  });
}

function movePlayer(room, p, dt) {
  if (!p.alive) return;

  const length = Math.hypot(p.inputX, p.inputZ);
  if (length < .01) {
    p.moving = false;
    p.stamina = Math.min(p.maxStamina, p.stamina + 11 * dt);
    return;
  }

  const nx = p.inputX / Math.max(1, length);
  const nz = p.inputZ / Math.max(1, length);
  p.moving = true;

  const sprinting = p.sprinting && p.stamina > 0;
  const speed = p.speed * (sprinting ? 1.38 : 1);

  if (sprinting) p.stamina = Math.max(0, p.stamina - 18 * dt);
  else p.stamina = Math.min(p.maxStamina, p.stamina + 11 * dt);

  const dx = nx * speed * dt;
  const dz = nz * speed * dt;
  const radius = p.role === "hai" ? .48 : .38;

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

  // yaw=0 面向 -Z，與 Three.js 第一人稱相機方向一致。
  const fx = -Math.sin(attacker.yaw);
  const fz = -Math.cos(attacker.yaw);
  const tx = target.x - attacker.x;
  const tz = target.z - attacker.z;
  const len = Math.hypot(tx, tz) || 1;
  const dot = (fx * tx + fz * tz) / len;

  if (dot < -.45) return false;
  if (!canSee(room, attacker, target)) return false;

  if (target.blocking && target.stamina > 5) {
    target.stamina = Math.max(0, target.stamina - damage * .65);
    damage *= .22;
    target.effect = "block";
    target.effectUntil = now() + 260;
  }

  if (target.role === "wei" && target.robeUntil > now()) damage *= .35;

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

  const enemy = getNearestEnemy(room, p, heavy ? 3 : 2.3);
  if (!enemy) {
    addMessage(room, heavy ? "重擊落空！" : "攻擊落空！");
    return;
  }

  hit(
    room, p, enemy,
    heavy ? (p.role === "hai" ? 26 : 17) : (p.role === "hai" ? 17 : 11),
    heavy ? 3 : 2.3,
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
    lime: "石灰粉", dart: "暗器", smoke: "煙霧彈",
    robe: "寶衣", dagger: "玄鐵匕首"
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
    addMessage(room, "石灰粉命中！對手短暫受到干擾。");
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

  if (!enemy) return;

  if (skill === "palm") {
    if (!cooldownReady(p, "palm", 1300) || p.stamina < 18) return;
    p.stamina -= 18;
    hit(room, p, enemy, 25, 3.5, "palm");
    addMessage(room, "海大富施展化骨綿掌！");
  } else if (skill === "poison") {
    if (!cooldownReady(p, "poison", 4500) || p.stamina < 24) return;
    p.stamina -= 24;
    if (hit(room, p, enemy, 18, 3.1, "poison")) {
      enemy.effect = "poison";
      enemy.effectUntil = now() + 2200;
      enemy.stamina = Math.max(0, enemy.stamina - 20);
    }
    addMessage(room, "海大富使出陰毒掌法！");
  } else if (skill === "grab") {
    if (!cooldownReady(p, "grab", 3800) || p.stamina < 20) return;
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
  if (!p || !p.alive || typeof action !== "string") return;

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
    if (!cooldownReady(p, "dodge", 1100) || p.stamina < 15) return;
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
    if (!cooldownReady(p, "jump", 800) || p.stamina < 12) return;
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

// 困難 AI：伺服器端決策、移動與出招。
function aiThink(room, bot) {
  if (!bot.isAI || !bot.alive || !room.started || room.winner) return;
  const t = now();
  if (t < bot.aiThinkAt) return;
  bot.aiThinkAt = t + 140;

  const enemy = others(room, bot).find(p => !p.isAI && p.alive);
  if (!enemy) return;

  const dx = enemy.x - bot.x;
  const dz = enemy.z - bot.z;
  const d = Math.hypot(dx, dz) || 1;
    // 低體力時不會一直衝刺；保持壓迫並繞行。
  const visible = canSee(room, bot, enemy);
  const lowHp = bot.hp / bot.maxHp < .32;
  const close = d < 2.7;

  if (t > bot.aiStrafeUntil) {
    bot.aiStrafe = Math.random() < .5 ? -1 : 1;
    bot.aiStrafeUntil = t + rand(650, 1300);
  }

  let mx = 0, mz = 0;
  if (visible) {
    if (close && (lowHp || Math.random() < .3)) {
      mx = (-dz / d) * bot.aiStrafe - (dx / d) * .18;
      mz = (dx / d) * bot.aiStrafe - (dz / d) * .18;
    } else if (d > 2.0) {
      mx = dx / d;
      mz = dz / d;
    } else {
      mx = (-dz / d) * bot.aiStrafe * .45;
      mz = (dx / d) * bot.aiStrafe * .45;
    }
  } else {
    mx = dx / d + (-dz / d) * bot.aiStrafe * .55;
    mz = dz / d + (dx / d) * bot.aiStrafe * .55;
  }

  const ml = Math.hypot(mx, mz) || 1;
  bot.inputX = clamp(mx / ml, -1, 1);
  bot.inputZ = clamp(mz / ml, -1, 1);
  bot.sprinting = d > 6 && bot.stamina > 30;
  bot.blocking = false;

  if (d < 3.2 && t > enemy.invulnerableUntil && bot.stamina > 18) {
    if (bot.role === "hai" && (lowHp || (enemy.attackUntil > t && Math.random() < .45))) {
      haiSkill(room, bot, "guard");
    } else if (enemy.attackUntil > t && Math.random() < .3) {
      doAction(room, bot, "dodge");
    } else if (Math.random() < .25) {
      bot.blocking = true;
    }
  }

  if (bot.role === "hai") {
    if (d <= 3.5 && bot.stamina >= 24 && Math.random() < .4) {
      haiSkill(room, bot, "palm");
    } else if (d <= 3.1 && bot.stamina >= 24 && Math.random() < .15) {
      haiSkill(room, bot, "poison");
    } else if (d <= 2.2 && bot.stamina >= 20 && Math.random() < .2) {
      haiSkill(room, bot, "grab");
    } else if (d <= 2.8) {
      attack(room, bot, Math.random() < .35 ? "heavy" : "attack");
    }
  } else {
    if (bot.inventory.robe > 0 && (lowHp || bot.hp < 60)) {
      useItem(room, bot, "robe");
    } else if (bot.inventory.lime > 0 && d < 8 && visible && Math.random() < .25) {
      useItem(room, bot, "lime");
    } else if (bot.inventory.dart > 0 && d > 3 && d < 12 && visible && Math.random() < .4) {
      useItem(room, bot, "dart");
    } else if (bot.inventory.dagger > 0 && d < 2.6) {
      useItem(room, bot, "dagger");
    } else if (d <= 2.5) {
      attack(room, bot, Math.random() < .22 ? "heavy" : "attack");
    }

    if (room.items.some(i => i.active && Math.hypot(i.x - bot.x, i.z - bot.z) < 1.5)) {
      pickup(room, bot);
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
      isAI: !!p.isAI,
      x: p.x, y: p.y, z: p.z, yaw: p.yaw,
      hp: p.hp, maxHp: p.maxHp,
      stamina: p.stamina, maxStamina: p.maxStamina,
      alive: p.alive, blocking: p.blocking, moving: p.moving,
      inventory: p.inventory,
      effect: p.effect, effectUntil: p.effectUntil,
      robeUntil: p.robeUntil, smokeUntil: p.smokeUntil,
      attackUntil: p.attackUntil, wallRunUntil: p.wallRunUntil
    }));

  return {
    id: room.id,
    mode: room.mode,
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
  for (const id of room.humanIds) io.to(id).emit("state", state);
}

function findOrCreateMultiplayerRoom() {
  for (const room of rooms.values()) {
    if (
      room.mode === "multi" &&
      !room.started &&
      !room.winner &&
      room.humanIds.length === 1
    ) return room;
  }
  const room = makeRoom("multi");
  rooms.set(room.id, room);
  return room;
}

function joinSinglePlayer(socket, requestedRole) {
  const room = makeRoom("ai");
  rooms.set(room.id, room);

  const role = requestedRole === "hai" ? "hai" : "wei";
  const botRole = role === "wei" ? "hai" : "wei";

  const human = makePlayer(socket.id, role, room.id, false);
  const botId = "bot_" + room.id;
  const bot = makePlayer(botId, botRole, room.id, true);

  players.set(socket.id, human);
  players.set(botId, bot);
  room.players.push(socket.id, botId);
  room.humanIds.push(socket.id);
  room.botIds.push(botId);
  room.started = true;

  socket.join(room.id);
  socket.emit("joined", {
    id: socket.id, role, roomId: room.id, mode: "ai",
    opponent: "AI 困難"
  });

  addMessage(room, `你選擇了${role === "wei" ? "韋小寶" : "海大富"}。`);
  addMessage(room, `困難 AI 將操作${botRole === "wei" ? "韋小寶" : "海大富"}。`);
  addMessage(room, "對決開始！善用地形、道具與技能。");
  broadcastRoom(room);
}

function joinMultiplayer(socket, requestedRole) {
  const room = findOrCreateMultiplayerRoom();
  let role = requestedRole === "hai" ? "hai" : "wei";

  if (room.humanIds.length > 0) {
    const first = players.get(room.humanIds[0]);
    if (first) role = first.role === "wei" ? "hai" : "wei";
  }

  const p = makePlayer(socket.id, role, room.id);
  players.set(socket.id, p);
  room.players.push(socket.id);
  room.humanIds.push(socket.id);
  socket.join(room.id);

  socket.emit("joined", {
    id: socket.id, role, roomId: room.id, mode: "multi"
  });

  addMessage(room, `${role === "wei" ? "韋小寶" : "海大富"}進入紫禁城。`);

  if (room.humanIds.length >= 2) {
    room.started = true;
    addMessage(room, "雙人對決開始！善用地形與技能取得勝利。");
  } else {
    addMessage(room, "等待另一位玩家加入……請分享遊戲網址。");
  }
  broadcastRoom(room);
}

io.on("connection", socket => {
  socket.on("joinGame", data => {
    if (players.has(socket.id)) return;
    data = data || {};
    const mode = data.mode === "multi" ? "multi" : "ai";
    const role = data.role === "hai" ? "hai" : "wei";

    if (mode === "ai") joinSinglePlayer(socket, role);
    else joinMultiplayer(socket, role);
  });

  socket.on("input", data => {
    const p = players.get(socket.id);
    if (!p || p.isAI || !data) return;

    p.yaw = Number.isFinite(data.yaw) ? data.yaw : p.yaw;
    p.inputX = clamp(Number(data.dx) || 0, -1, 1);
    p.inputZ = clamp(Number(data.dz) || 0, -1, 1);
    p.blocking = !!data.blocking;
    p.sprinting = !!data.sprinting;
  });

  socket.on("action", action => {
    const p = players.get(socket.id);
    if (!p || p.isAI) return;
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

    if (!room) return;

    room.players = room.players.filter(id => id !== socket.id);
    room.humanIds = room.humanIds.filter(id => id !== socket.id);

    if (room.mode === "ai") {
      for (const id of room.players) players.delete(id);
      rooms.delete(room.id);
      return;
    }

    room.started = false;
    room.winner = null;
    addMessage(room, "一名玩家離開了對戰。");

    if (room.humanIds.length === 0) {
      for (const id of room.players) players.delete(id);
      rooms.delete(room.id);
    } else {
      broadcastRoom(room);
    }
  });
});

setInterval(() => {
  const t = now();

  for (const room of rooms.values()) {
    const dt = Math.min(.1, Math.max(.001, (t - room.lastUpdate) / 1000));
    room.lastUpdate = t;

    if (!room.winner) {
      for (const id of room.players) {
        const p = players.get(id);
        if (!p) continue;
        movePlayer(room, p, dt);

        if (p.effectUntil < t) {
          if (p.effect === "robe" && p.robeUntil > t) {
          } else if (p.effect === "smoke" && p.smokeUntil > t) {
          } else {
            p.effect = "";
          }
        }
      }

      for (const id of room.botIds) {
        const bot = players.get(id);
        if (bot) aiThink(room, bot);
      }
    }

    broadcastRoom(room);
  }
}, 50);

app.get("/", (req, res) => res.send(PAGE));

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
#loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;background:radial-gradient(ellipse,#27354b,#080b13 70%);z-index:30;text-align:center;padding:22px;overflow:auto}
#loading h1{font-size:clamp(26px,6vw,48px);letter-spacing:4px;color:#f5d99a;text-shadow:0 0 28px #d89c47;margin:0 0 8px}
#loading p{color:#bdc5d5;line-height:1.7;font-size:14px}
.choice{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:7px 0}
.choice button{border:1px solid #827354;background:#131c2b;color:#d8dfeb;padding:10px 13px;border-radius:8px;font-weight:700}
.choice button.selected{background:linear-gradient(135deg,#8d2823,#351719);border-color:#e5c37d;color:#fff2cf;box-shadow:0 0 12px #d89c4733}
.choiceTitle{font-size:12px;color:#e5c37d;letter-spacing:2px;margin-top:9px}
#start{border:1px solid #e5c37d;background:linear-gradient(135deg,#8d2823,#351719);color:#fff2cf;padding:13px 32px;border-radius:8px;font-size:17px;font-weight:800;letter-spacing:3px;margin-top:12px}
#loadStatus{font-size:12px;color:#9faec1;margin-top:12px;max-width:90vw}
#hud{position:fixed;inset:0;pointer-events:none;display:none}
.panel{background:linear-gradient(135deg,#111927dd,#090d17bb);border:1px solid #c7a96a77;border-radius:12px;box-shadow:0 5px 24px #0006;backdrop-filter:blur(8px)}
#top{position:absolute;top:10px;left:10px;right:10px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
#identity{padding:9px 11px;min-width:120px}
#identity .name{font-size:16px;font-weight:900;color:#f6d998;letter-spacing:2px}
#identity .sub{font-size:10px;color:#aeb9cb;margin-top:3px}
#status{padding:8px 10px;width:min(43vw,250px)}
.barline{display:flex;justify-content:space-between;font-size:10px;color:#d7dce7;margin-bottom:4px}
.bar{height:7px;background:#333b48;border-radius:10px;overflow:hidden;margin-bottom:7px}
.fill{height:100%;width:100%;transition:width .12s linear;border-radius:10px}
#hpFill{background:linear-gradient(90deg,#a61f2b,#ff6b61)}
#stFill{background:linear-gradient(90deg,#158d80,#66e6bd)}
#round{position:absolute;top:91px;left:50%;transform:translateX(-50%);padding:6px 10px;font-size:11px;white-space:nowrap;color:#eeddb8;max-width:95vw;overflow:hidden}
#messages{position:absolute;left:10px;top:137px;max-width:min(65vw,330px);font-size:11px;line-height:1.65;color:#f2dfb4;text-shadow:0 2px 4px #000}
#crosshair{position:absolute;left:50%;top:50%;width:14px;height:14px;transform:translate(-50%,-50%);opacity:.8}
#crosshair:before,#crosshair:after{content:"";position:absolute;background:#fff0c5;box-shadow:0 0 6px #ffda8a}
#crosshair:before{width:2px;height:14px;left:6px;top:0}
#crosshair:after{height:2px;width:14px;top:6px;left:0}
#bottom{position:absolute;bottom:10px;left:10px;right:10px;display:flex;justify-content:space-between;align-items:flex-end;gap:6px}
#joystick{width:124px;height:124px;flex:0 0 124px;border-radius:50%;background:radial-gradient(circle,#26364f88,#0c1525aa);border:2px solid #d7c18c88;position:relative;pointer-events:auto;touch-action:none;user-select:none;box-shadow:inset 0 0 20px #0008}
#joyKnob{position:absolute;width:48px;height:48px;border-radius:50%;left:36px;top:36px;background:linear-gradient(135deg,#f2dfb5,#8e7449);border:2px solid #fff0c2;box-shadow:0 4px 12px #0009;pointer-events:none}
#joyLabel{position:absolute;left:0;right:0;bottom:10px;text-align:center;font-size:10px;color:#e5d4ad;opacity:.75;pointer-events:none}
#buttons{display:grid;grid-template-columns:repeat(3,minmax(43px,56px));gap:5px;pointer-events:auto}
.act{height:49px;border-radius:50%;border:1px solid #d9c18b99;background:linear-gradient(145deg,#273247ef,#101722f0);color:#fff0cb;font-size:10px;font-weight:800;box-shadow:0 3px 10px #0008;touch-action:manipulation;padding:0}
.act:active{transform:scale(.92);filter:brightness(1.5)}
.act.primary{background:linear-gradient(145deg,#a23b2b,#4a171c);border-color:#f2b58c}
.act.skill{background:linear-gradient(145deg,#5c3a83,#211832);border-color:#c2a6f0}
#items{position:absolute;right:9px;top:116px;display:flex;flex-direction:column;gap:4px;pointer-events:auto}
.itembtn{border:1px solid #c6ac6b99;background:#141a27df;color:#f5dba4;padding:6px 8px;border-radius:8px;font-size:10px}
#hint{position:absolute;bottom:142px;left:50%;transform:translateX(-50%);padding:5px 9px;background:#090e18b8;border-radius:6px;font-size:10px;color:#f5e4bd;white-space:nowrap}
#result{position:absolute;inset:0;background:#050912e8;display:none;align-items:center;justify-content:center;flex-direction:column;pointer-events:auto;text-align:center;padding:20px}
#result h2{font-size:32px;color:#f5dba4;letter-spacing:4px}
#result button{padding:12px 25px;background:#7d2925;color:white;border:1px solid #e8c77e;border-radius:8px}
@media(min-width:800px){
 #bottom{bottom:18px;left:20px;right:20px}
 #joystick{width:145px;height:145px;flex-basis:145px}
 #joyKnob{left:46px;top:46px}
 #buttons{grid-template-columns:repeat(3,64px);gap:8px}
 .act{height:58px;font-size:11px}
 #messages{top:145px}
}
</style>
</head>
<body>
<div id="game"></div>
<div id="loading">
  <h1>紫禁城</h1>
  <div style="color:#d9bd80;letter-spacing:4px;font-size:11px">THE FORBIDDEN CITY DUEL</div>
  <p>第一人稱武俠對戰<br>選擇角色與模式，踏入紫禁城。</p>
  <div class="choiceTitle">選擇你的角色</div>
  <div class="choice">
    <button class="selected" data-role="wei">韋小寶</button>
    <button data-role="hai">海大富</button>
  </div>
  <div class="choiceTitle">選擇對戰模式</div>
  <div class="choice">
    <button class="selected" data-mode="ai">單人 AI・困難</button>
    <button data-mode="multi">雙人連線</button>
  </div>
  <p id="modeHelp">你將與困難 AI 對戰，對手會追擊、閃避並使用技能。</p>
  <button id="start">踏入紫禁城</button>
  <div id="loadStatus">正在準備 3D 場景……</div>
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
  <div id="round" class="panel">正在加入對戰……</div>
  <div id="messages"></div>
  <div id="crosshair"></div>
  <div id="items"></div>
  <div id="hint">左側移動・右側拖曳轉動視角</div>
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
  <div id="result">
    <h2 id="resultTitle">對決結束</h2>
    <p id="resultText"></p>
    <button id="replayBtn" type="button">再戰一次</button>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
window.addEventListener("three-ready", () => {
"use strict";

const THREE = window.THREE;
const $ = id => document.getElementById(id);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const rand = (min, max) => min + Math.random() * (max - min);
const socket = io();

let myId = null, myRole = null, roomState = null, gameMode = "ai";
let scene, camera, renderer, clock;
let yaw = 0, pitch = 0, moveX = 0, moveY = 0;
let sprinting = false, bob = 0, jumpY = 0, jumpV = 0;
let lookTouch = null, joyPointer = null, started = false;
let playerMeshes = new Map(), itemMeshes = new Map(), objectMeshes = new Map();
let handGroup, weaponGroup, flashLight, ambientParticles = [];
let audioCtx = null;
let lastInputSent = 0;
const keys = {};

const selected = { role: "wei", mode: "ai" };

document.querySelectorAll("[data-role]").forEach(btn => {
  btn.addEventListener("click", () => {
    selected.role = btn.dataset.role;
    document.querySelectorAll("[data-role]").forEach(b =>
      b.classList.toggle("selected", b === btn)
    );
  });
});

document.querySelectorAll("[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    selected.mode = btn.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach(b =>
      b.classList.toggle("selected", b === btn)
    );
    $("modeHelp").textContent = selected.mode === "ai"
      ? "你將與困難 AI 對戰，對手會追擊、閃避並使用技能。"
      : "請兩位玩家各自開啟遊戲網址，選擇雙人連線即可加入對戰。";
  });
});

function material(color, roughness=.8, metalness=0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function box(w,h,d,mat,x,y,z,parent=scene) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
  mesh.position.set(x,y,z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(rt,rb,h,mat,x,y,z,parent=scene,seg=12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,seg),mat);
  mesh.position.set(x,y,z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeTextSprite(text,color="#f3dca4") {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(7,12,20,.75)";
  ctx.beginPath();
  ctx.roundRect(5,5,502,118,22);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.font = "bold 42px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text,256,64);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false
  }));
  sprite.scale.set(2.5,.62,1);
  return sprite;
}

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101827);
  scene.fog = new THREE.FogExp2(0x101827,.022);

  camera = new THREE.PerspectiveCamera(76,innerWidth/innerHeight,.08,150);
  camera.rotation.order = "YXZ";

  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance"
    });
  } catch (err) {
    $("loadStatus").textContent =
      "3D 畫面無法建立，可能是瀏覽器不支援 WebGL。請更新瀏覽器或換裝置試試。";
    throw err;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,1.6));
  renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  $("game").replaceChildren(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0x9eb9e3,0x4b3425,2.1));

  const moon = new THREE.DirectionalLight(0xffdfaa,3);
  moon.position.set(-12,22,8);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024,1024);
  moon.shadow.camera.left = -30;
  moon.shadow.camera.right = 30;
  moon.shadow.camera.top = 30;
  moon.shadow.camera.bottom = -30;
  scene.add(moon);

  const fill = new THREE.PointLight(0xff9e49,18,30);
  fill.position.set(0,5,0);
  scene.add(fill);

  makeGround();
  makePalace();
  makeLanterns();
  makeDecor();
  makeItemsInitial();
  makeParticles();

  handGroup = new THREE.Group();
  camera.add(handGroup);
  scene.add(camera);

  const sleeveMat = material(myRole === "hai" ? 0x202a3b : 0x8c2630);
  const skinMat = material(0xc98e65);
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(.22,.43,.24),sleeveMat);
  sleeve.position.set(.39,-.37,-.72);
  sleeve.rotation.z = -.25;
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
  window.addEventListener("resize",onResize);
  window.addEventListener("mousemove",mouseLook);
  renderer.domElement.addEventListener("click",() => {
    if (innerWidth > 800 && document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.();
    }
  });
  animate();
}

function makeGround() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(42,42),material(0x55525a,.92)
  );
  ground.rotation.x = -Math.PI/2;
  ground.position.y = -.08;
  ground.receiveShadow = true;
  scene.add(ground);

  const tileMat = material(0x77716b,.9);
  for(let x=-18;x<=18;x+=2) {
    for(let z=-18;z<=18;z+=2) {
      const tile = box(1.96,.025,1.96,tileMat,x,-.04,z);
      tile.castShadow = false;
    }
  }

  const gold = material(0xb99655,.55,.4);
  for(let i=-16;i<=16;i+=4) {
    box(.055,.012,36,gold,i,.005,0);
    box(36,.012,.055,gold,0,.006,i);
  }
}

function makePalace() {
  const red = material(0x72282a);
  const darkRed = material(0x401a20);
  const gold = material(0xc69d52,.35,.5);
  const stone = material(0x777b82);
  const roof = material(0x263b4a,.42,.25);

  box(37,4,1.1,red,0,1.9,-18);
  box(37,4,1.1,red,0,1.9,18);
  box(1.1,4,37,red,-18,1.9,0);
  box(1.1,4,37,red,18,1.9,0);

  for(let x=-16;x<=16;x+=4) {
    box(.12,4.25,.12,gold,x,2,-17.4);
    box(.12,4.25,.12,gold,x,2,17.4);
  }

  box(14,.6,8,stone,0,.22,-13);
  box(13,.18,7,material(0xb7a27e),0,.61,-13);
  box(11,.15,5.5,material(0x6e5a48),0,.76,-13);

  for(const x of [-5,-2.5,0,2.5,5]) {
    for(const z of [-15.6,-10.6]) {
      cylinder(.22,.25,4,red,x,2.8,z);
      cylinder(.28,.28,.16,gold,x,4.65,z);
      cylinder(.26,.26,.12,gold,x,1.05,z);
    }
  }

  box(12,2.7,.45,darkRed,0,2.55,-15.7);
  box(12,2.7,.45,darkRed,0,2.55,-10.5);
  box(.45,2.7,5.6,darkRed,-5.8,2.55,-13.1);
  box(.45,2.7,5.6,darkRed,5.8,2.55,-13.1);

  box(13,.35,7,roof,0,5.1,-13.1).rotation.x = .035;
  box(14,.2,7.4,roof,0,5.3,-13.1);

  for(const x of [-6.8,6.8]) {
    cylinder(.12,.12,1.3,gold,x,5.5,-13.1);
    cylinder(.08,.08,.55,gold,x,6.3,-13.1);
  }

  for(let i=0;i<5;i++) {
    box(4,.12,.65,material(0x9b8d79),0,.08+i*.1,-8.5+i*.65);
  }

  for(const side of [-1,1]) {
    const x = side*15;
    box(3,.22,16,roof,x,4.3,0);
    box(3.3,.15,16.3,roof,x,4.42,0);
    for(let z=-7;z<=7;z+=3.5) cylinder(.11,.11,3.2,red,x,2.7,z);
  }
}

function makeLanterns() {
  const red = material(0xb72f2c,.5);
  const gold = material(0xf2c46e,.35,.4);
  const glow = material(0xffc56b,.3,0);
  const positions = [
    [-8,3,-5],[8,3,-5],[-8,3,5],[8,3,5],
    [-14,3,-12],[14,3,-12],[-14,3,12],[14,3,12],
    [-3,3,0],[3,3,0]
  ];

  positions.forEach(([x,y,z]) => {
    cylinder(.045,.045,1.5,gold,x,y+.3,z);
    cylinder(.35,.28,.65,red,x,y-.4,z,scene,16);
    cylinder(.24,.24,.1,gold,x,y-.4,z,scene,16);
    cylinder(.24,.24,.1,gold,x,y-.75,z,scene,16);
    const light = new THREE.PointLight(0xff9c42,2.2,7);
    light.position.set(x,y-.4,z);
    scene.add(light);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(.17,10,8),glow);
    bulb.position.set(x,y-.4,z);
    scene.add(bulb);
  });
}

function makeDecor() {
  const wood = material(0x53352c);
  const gold = material(0xc49b58,.35,.4);
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x1c4c48, roughness: .65, side: THREE.DoubleSide
  });

  const screens = [
    [-7,-1,4.8,.35], [6,2,4.8,.35], [0,-8,5.4,.35],
    [0,8,5.4,.35], [-11,9,3.5,.35], [11,-9,3.5,.35]
  ];

  screens.forEach(([x,z,w,d]) => {
    const g = new THREE.Group();
    g.position.set(x,0,z);
    box(w,.12,d,wood,0,.08,0,g);
    box(w,.12,d,wood,0,2.2,0,g);
    box(.12,2.2,d,wood,-w/2,1.15,0,g);
    box(.12,2.2,d,wood,w/2,1.15,0,g);
    box(w-.3,1.85,.07,screenMat,0,1.15,0,g);
    for(let i=0;i<5;i++) {
      box(.04,.75,.025,gold,-w/2+.45+i*(w-.9)/4,1.15,-.055,g);
    }
    box(w-.55,.035,.025,gold,0,1.7,-.06,g);
    g.userData.x = x;
    g.userData.z = z;
    scene.add(g);
    objectMeshes.set("screen_"+x+"_"+z,g);
  });

  for(const [x,z] of [[-13,0],[13,0]]) {
    box(1.25,1.1,1.25,wood,x,.55,z);
    for(let i=-1;i<=1;i++) box(.04,1.05,1.28,gold,x+i*.4,.55,z-.01);
  }

  for(const [x,z] of [[-15,-4],[15,4],[-15,7],[15,-7]]) {
    box(.8,.25,.8,material(0x5d626b),x,.4,z);
    box(.55,.75,.55,material(0x777b82),x,.85,z);
    box(.9,.12,.9,gold,x,1.25,z);
    cylinder(.3,.25,.42,material(0x444c56),x,1.5,z);
    const light = new THREE.PointLight(0xffaa57,1.2,5);
    light.position.set(x,1.8,z);
    scene.add(light);
  }
}

function makeItemsInitial() {
  const positions = [
    ["item1","lime",-9,-5],["item2","dart",8,-8],
    ["item3","smoke",0,10],["item4","robe",-11,7],
    ["item5","dagger",11,5]
  ];
  const colors = {lime:0xc4d65e,dart:0xcbd6e6,smoke:0x8d9db7,robe:0xc8a05c,dagger:0xb7c7db};

  positions.forEach(([id,type,x,z]) => {
    const g = new THREE.Group();
    const color = colors[type];
    g.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(.25,1),
      new THREE.MeshStandardMaterial({
        color, emissive:color, emissiveIntensity:.45,
        metalness:.25, roughness:.3
      })
    ));
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(.42,.025,8,24),material(0xe3c779,.25,.5)
    );
    ring.rotation.x = Math.PI/2;
    g.add(ring);
    const light = new THREE.PointLight(color,1.2,3);
    g.add(light);
    g.position.set(x,.55,z);
    scene.add(g);
    itemMeshes.set(id,g);
  });
}

function makeParticles() {
  const geom = new THREE.BufferGeometry();
  const count = 150;
  const arr = new Float32Array(count*3);
  for(let i=0;i<count;i++) {
    arr[i*3] = rand(-18,18);
    arr[i*3+1] = rand(.5,7);
    arr[i*3+2] = rand(-18,18);
  }
  geom.setAttribute("position",new THREE.BufferAttribute(arr,3));
  const points = new THREE.Points(geom,new THREE.PointsMaterial({
    color:0xe5c78a,size:.035,transparent:true,opacity:.55
  }));
  scene.add(points);
  ambientParticles.push(points);
}

function makeWeapon() {
  if(!weaponGroup) return;
  while(weaponGroup.children.length) weaponGroup.remove(weaponGroup.children[0]);

  const metal = material(0xc3ccd7,.25,.8);
  const gold = material(0xd8b05f,.25,.6);
  const dark = material(0x39251f);

  if(myRole === "hai") {
    cylinder(.035,.045,.68,metal,0,-.05,0,weaponGroup,8).rotation.z = -.2;
    cylinder(.075,.075,.16,dark,0,-.35,0,weaponGroup,8);
    cylinder(.045,.045,.18,gold,0,-.45,0,weaponGroup,8);
  } else {
    box(.07,.48,.07,metal,0,-.05,0,weaponGroup);
    box(.16,.08,.11,gold,0,-.32,0,weaponGroup);
    box(.1,.13,.1,dark,0,-.4,0,weaponGroup);
  }
}

function onResize() {
  if(!camera || !renderer) return;
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,1.6));
}

function mouseLook(e) {
  if(innerWidth <= 800 || document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX*.0021;
  pitch = clamp(pitch-e.movementY*.0018,-1.15,1.15);
}

function sound(freq,duration) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(.08,audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime+duration);
  } catch(e) {}
}

function action(name) {
  if(!myId || !socket.connected) return;
  socket.emit("action",name);

  if(name === "jump") {
    if(jumpY <= 0.02 && jumpV <= 0) jumpV = 6.5;
    sound(260,.06);
  }

  if(name === "attack" || name === "heavy") {
    if(handGroup) handGroup.rotation.x = -.45;
    setTimeout(() => { if(handGroup) handGroup.rotation.x = 0; },180);
    if(flashLight) flashLight.intensity = 2.4;
    setTimeout(() => { if(flashLight) flashLight.intensity = 0; },100);
    sound(name === "heavy" ? 95 : 180,.08);
  }
}

function bindControls() {
  const replayBtn = $("replayBtn");
  if(replayBtn && !replayBtn.dataset.bound) {
    replayBtn.dataset.bound = "1";
    replayBtn.addEventListener("click", e => {
      e.preventDefault();
      window.location.reload();
    });
    replayBtn.addEventListener("pointerup", e => {
      if(e.pointerType === "touch") {
        e.preventDefault();
        window.location.reload();
      }
    });
  }

  const joy = $("joystick");
  const knob = $("joyKnob");
  let joyRect = null;

  function joyStart(e) {
    e.preventDefault();
    joyPointer = e.pointerId;
    joyRect = joy.getBoundingClientRect();
    try { joy.setPointerCapture(e.pointerId); } catch(err) {}
    joyMove(e);
  }

  function joyMove(e) {
    if(joyPointer === null || e.pointerId !== joyPointer) return;
    e.preventDefault();
    if(!joyRect) joyRect = joy.getBoundingClientRect();

    const cx = joyRect.left + joyRect.width/2;
    const cy = joyRect.top + joyRect.height/2;
    const max = joyRect.width*.32;
    let dx = e.clientX-cx;
    let dy = e.clientY-cy;
    const len = Math.hypot(dx,dy);
    if(len > max) { dx = dx/len*max; dy = dy/len*max; }

    knob.style.left = (joyRect.width/2-24+dx)+"px";
    knob.style.top = (joyRect.height/2-24+dy)+"px";
    moveX = clamp(dx/max,-1,1);
    moveY = clamp(dy/max,-1,1);
  }

  function joyEnd(e) {
    if(joyPointer === null) return;
    if(e && e.pointerId !== undefined && e.pointerId !== joyPointer) return;
    joyPointer = null;
    joyRect = null;
    moveX = 0;
    moveY = 0;
    knob.style.left = (joy.clientWidth/2-24)+"px";
    knob.style.top = (joy.clientHeight/2-24)+"px";
  }

  joy.addEventListener("pointerdown",joyStart);
  joy.addEventListener("pointermove",joyMove);
  joy.addEventListener("pointerup",joyEnd);
  joy.addEventListener("pointercancel",joyEnd);
  joy.addEventListener("lostpointercapture",joyEnd);
  window.addEventListener("pointerup",joyEnd);
  window.addEventListener("pointercancel",joyEnd);

  if(!window.PointerEvent) {
    let touchId = null;
    const findTouch = list => {
      for(let i=0;i<list.length;i++) if(list[i].identifier === touchId) return list[i];
      return null;
    };
    joy.addEventListener("touchstart",e => {
      if(touchId !== null) return;
      const t = e.changedTouches[0];
      if(!t) return;
      e.preventDefault();
      touchId = t.identifier;
      joyRect = joy.getBoundingClientRect();
      const cx = joyRect.left + joyRect.width/2;
      const cy = joyRect.top + joyRect.height/2;
      const max = joyRect.width*.32;
      let dx = t.clientX-cx, dy = t.clientY-cy;
      const len = Math.hypot(dx,dy);
      if(len > max) { dx = dx/len*max; dy = dy/len*max; }
      knob.style.left = (joyRect.width/2-24+dx)+"px";
      knob.style.top = (joyRect.height/2-24+dy)+"px";
      moveX = clamp(dx/max,-1,1);
      moveY = clamp(dy/max,-1,1);
    },{passive:false});
    joy.addEventListener("touchmove",e => {
      const t = findTouch(e.changedTouches) || findTouch(e.touches);
      if(!t) return;
      e.preventDefault();
      const cx = joyRect.left + joyRect.width/2;
      const cy = joyRect.top + joyRect.height/2;
      const max = joyRect.width*.32;
      let dx = t.clientX-cx, dy = t.clientY-cy;
      const len = Math.hypot(dx,dy);
      if(len > max) { dx = dx/len*max; dy = dy/len*max; }
      knob.style.left = (joyRect.width/2-24+dx)+"px";
      knob.style.top = (joyRect.height/2-24+dy)+"px";
      moveX = clamp(dx/max,-1,1);
      moveY = clamp(dy/max,-1,1);
    },{passive:false});
    const touchEnd = e => {
      if(touchId === null) return;
      const t = findTouch(e.changedTouches);
      if(!t) return;
      touchId = null;
      joyEnd();
    };
    joy.addEventListener("touchend",touchEnd,{passive:false});
    joy.addEventListener("touchcancel",touchEnd,{passive:false});
  }

  renderer.domElement.addEventListener("pointerdown",e => {
    if(e.pointerType === "mouse" || e.clientX < innerWidth*.38) return;
    lookTouch = { id:e.pointerId, x:e.clientX, y:e.clientY };
    try { renderer.domElement.setPointerCapture(e.pointerId); } catch(err) {}
  });

  renderer.domElement.addEventListener("pointermove",e => {
    if(!lookTouch || lookTouch.id !== e.pointerId) return;
    const dx = e.clientX-lookTouch.x;
    const dy = e.clientY-lookTouch.y;
    yaw -= dx*.005;
    pitch = clamp(pitch-dy*.004,-1.15,1.15);
    lookTouch.x = e.clientX;
    lookTouch.y = e.clientY;
  });

  const endLook = e => {
    if(lookTouch && (!e || lookTouch.id === e.pointerId)) lookTouch = null;
  };
  renderer.domElement.addEventListener("pointerup",endLook);
  renderer.domElement.addEventListener("pointercancel",endLook);

  document.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("pointerdown",e => e.preventDefault());
    btn.addEventListener("click",() => action(btn.dataset.action));
  });

  window.addEventListener("keydown",e => {
    keys[e.code] = true;
    if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.code)) e.preventDefault();
    if(e.repeat) return;
    if(e.code === "Space") action("jump");
    if(e.code === "KeyE") action("pickup");
    if(e.code === "KeyF") action("attack");
    if(e.code === "KeyG") action("heavy");
    if(e.code === "KeyQ") action("dodge");
    if(e.code === "KeyR") action("break");
    if(e.code === "Digit1") action("item:lime");
    if(e.code === "Digit2") action("item:dart");
    if(e.code === "Digit3") action("item:smoke");
    if(e.code === "Digit4") action("item:robe");
    if(e.code === "Digit5") action("item:dagger");
  });
  window.addEventListener("keyup",e => keys[e.code] = false);
  window.addEventListener("blur",() => {
    joyEnd();
    lookTouch = null;
    moveX = 0;
    moveY = 0;
    Object.keys(keys).forEach(k => keys[k] = false);
  });
}

function sendInput() {
  if(!myId || !socket.connected) return;

  let x = moveX, y = moveY;
  if(keys.KeyW || keys.ArrowUp) y -= 1;
  if(keys.KeyS || keys.ArrowDown) y += 1;
  if(keys.KeyA || keys.ArrowLeft) x -= 1;
  if(keys.KeyD || keys.ArrowRight) x += 1;

  const len = Math.hypot(x,y);
  if(len > 1) { x /= len; y /= len; }

  const forward = -y;
  const right = x;
  const dx = -Math.sin(yaw)*forward + Math.cos(yaw)*right;
  const dz = -Math.cos(yaw)*forward - Math.sin(yaw)*right;

  sprinting = !!keys.ShiftLeft;
  socket.emit("input",{
    dx,dz,yaw,
    blocking:!!keys.KeyB,
    sprinting
  });
}

function makeOpponent(p) {
  const group = new THREE.Group();
  const isHai = p.role === "hai";
  const robe = material(isHai ? 0x222d43 : 0x8e2930);
  const trim = material(0xd0ad69,.35,.4);
  const skin = material(0xb9805d);
  const dark = material(0x151820);

  const body = cylinder(.35,.42,1.05,robe,0,1.05,0,group,12);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.24,16,12),skin);
  head.position.y = 1.8;
  group.add(head);

  box(.82,.14,.42,trim,0,1.45,0,group);
  box(.62,.13,.44,dark,0,.68,0,group);

  const armL = cylinder(.105,.13,.72,robe,-.47,1.13,0,group);
  armL.rotation.z = -.18;
  const armR = cylinder(.105,.13,.72,robe,.47,1.13,0,group);
  armR.rotation.z = .18;
  cylinder(.13,.16,.15,trim,0,.48,0,group);
  cylinder(.15,.12,.3,dark,-.18,.15,0,group);
  cylinder(.15,.12,.3,dark,.18,.15,0,group);

  if(isHai) {
    cylinder(.25,.28,.13,dark,0,2.03,0,group,12);
    box(.46,.07,.3,trim,0,1.96,0,group);
    const beard = new THREE.Mesh(new THREE.ConeGeometry(.13,.33,8),dark);
    beard.position.set(0,1.55,.17);
    group.add(beard);
  } else {
    box(.55,.1,.45,trim,0,.92,0,group);
    cylinder(.23,.23,.12,dark,0,2.02,0,group,12);
    box(.36,.08,.3,trim,0,2.09,0,group);
  }

  const label = makeTextSprite(
    isHai ? "海大富" : "韋小寶",
    isHai ? "#d5dfff" : "#ffdc9c"
  );
  label.position.y = 2.55;
  group.add(label);
  group.userData.body = body;
  group.userData.armL = armL;
  group.userData.armR = armR;
  group.userData.label = label;
  return group;
}

function updateObjects(state) {
  const seen = new Set();

  for(const p of state.players) {
    if(p.id === myId) continue;
    seen.add(p.id);

    let mesh = playerMeshes.get(p.id);
    if(!mesh) {
      mesh = makeOpponent(p);
      scene.add(mesh);
      playerMeshes.set(p.id,mesh);
    }

    const me = state.players.find(q => q.id === myId);
    const inSmoke = me && me.smokeUntil > Date.now() &&
      Math.hypot(me.x-p.x,me.z-p.z) > 2;

    mesh.visible = p.alive && !inSmoke;
    mesh.position.set(p.x,0,p.z);
    mesh.rotation.y = p.yaw;
    mesh.userData.armL.rotation.x = p.moving ? Math.sin(Date.now()*.012)*.4 : 0;
    mesh.userData.armR.rotation.x = p.moving ? Math.sin(Date.now()*.012+Math.PI)*.4 : 0;
    mesh.userData.body.scale.y = p.effect === "hit" ? .92 : 1;
  }

  for(const [id,mesh] of playerMeshes) {
    if(!seen.has(id)) {
      scene.remove(mesh);
      playerMeshes.delete(id);
    }
  }

  for(const item of state.items || []) {
    const mesh = itemMeshes.get(item.id);
    if(!mesh) continue;
    mesh.visible = !!item.active;
    if(item.active) {
      mesh.position.set(item.x,.55+Math.sin(Date.now()*.002+item.x)*.1,item.z);
      mesh.rotation.y = Date.now()*.001;
    }
  }

  for(const id of state.destroyed || []) {
    const obj = state.obstacles.find(o => o.id === id);
    if(!obj || obj.type !== "screen") continue;
    for(const g of objectMeshes.values()) {
      if(Math.abs(g.userData.x-obj.x)<.1 && Math.abs(g.userData.z-obj.z)<.1) {
        g.visible = false;
      }
    }
  }
}

function updateHud(state) {
  const me = state.players.find(p => p.id === myId);
  if(!me) return;

  $("roleName").textContent = myRole === "wei" ? "韋小寶" : "海大富";
  $("roleSub").textContent = myRole === "wei" ? "機敏・計謀・道具" : "內力・掌法・擒拿";
  $("hpText").textContent = Math.ceil(me.hp)+" / "+me.maxHp;
  $("stText").textContent = Math.ceil(me.stamina)+" / "+me.maxStamina;
  $("hpFill").style.width = (me.hp/me.maxHp*100)+"%";
  $("stFill").style.width = (me.stamina/me.maxStamina*100)+"%";

  $("round").textContent = !state.started
    ? "等待另一位玩家加入……"
    : state.winner
      ? (state.winner === myRole ? "你贏了！" : "你輸了！")
      : state.mode === "ai" ? "紫禁城對決・困難 AI" : "紫禁城對決・雙人連線";

  $("messages").innerHTML = (state.messages || []).slice(-4)
    .map(m => "<div>"+escapeHtml(m.text)+"</div>").join("");

  const items = $("items");
  items.replaceChildren();

  if(myRole === "wei") {
    const names = {lime:"石灰粉",dart:"暗器",smoke:"煙霧彈",robe:"寶衣",dagger:"匕首"};
    for(const key of Object.keys(names)) {
      const n = me.inventory[key] || 0;
      const b = document.createElement("button");
      b.className = "itembtn";
      b.textContent = names[key]+" × "+n;
      b.disabled = n <= 0;
      b.onclick = () => action("item:"+key);
      items.appendChild(b);
    }
  } else {
    ["palm","poison","grab","guard"].forEach((key,i) => {
      const b = document.createElement("button");
      b.className = "itembtn";
      b.textContent = ["化骨綿掌","陰毒掌法","擒拿","內力護體"][i];
      b.onclick = () => action("skill:"+key);
      items.appendChild(b);
    });
  }

  ["skill1","skill2","skill3","skill4"].forEach(id => {
    $(id).style.display = myRole === "hai" ? "block" : "none";
  });

  if(state.winner) {
    $("result").style.display = "flex";
    $("resultTitle").textContent = state.winner === myRole ? "大獲全勝" : "對決落敗";
    $("resultText").textContent = state.winner === myRole
      ? "你掌握了紫禁城的戰局。"
      : "再調整走位、時機與技能搭配，重新挑戰。";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function animate() {
  requestAnimationFrame(animate);
  if(!renderer || !camera) return;

  const dt = Math.min(clock.getDelta(),.05);
  const me = roomState && roomState.players.find(p => p.id === myId);

  if(me) {
    const moving = Math.hypot(moveX,moveY) > .12;
    if(moving) bob += dt*10;
    const bobY = moving ? Math.sin(bob)*.035 : 0;

    if(jumpV !== 0 || jumpY > 0) {
      jumpV -= 14*dt;
      jumpY += jumpV*dt;
      if(jumpY < 0) { jumpY = 0; jumpV = 0; }
    }

    camera.rotation.order = "YXZ";
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    camera.position.set(me.x,1.62+jumpY+bobY,me.z);

    if(handGroup) {
      const attacking = me.attackUntil > Date.now();
      const swing = attacking ? Math.sin((me.attackUntil-Date.now())*.025) : 0;
      handGroup.position.set(.02,moving ? Math.sin(bob)*.012 : 0,0);
      handGroup.rotation.x = attacking ? -.6 : 0;
      handGroup.rotation.z = moving ? Math.sin(bob)*.025 : 0;
      if(weaponGroup) weaponGroup.rotation.x = attacking ? swing*.4 : 0;
    }
  } else {
    camera.position.set(0,1.62,15);
  }

  ambientParticles.forEach(p => {
    const a = p.geometry.attributes.position;
    for(let i=0;i<a.count;i++) {
      a.array[i*3+1] += .0015;
      if(a.array[i*3+1] > 8) a.array[i*3+1] = .5;
    }
    a.needsUpdate = true;
  });

  renderer.render(scene,camera);
}

socket.on("connect",() => {
  $("loadStatus").textContent = "連線成功，準備加入對決。";
});

socket.on("connect_error",() => {
  $("loadStatus").textContent = "連線失敗，請確認伺服器已啟動後重新整理。";
});

socket.on("joined",data => {
  myId = data.id;
  myRole = data.role;
  gameMode = data.mode || selected.mode;
  yaw = myRole === "wei" ? -Math.PI/2 : Math.PI/2;

  $("loadStatus").textContent = gameMode === "ai"
    ? "已加入困難 AI 對戰。"
    : "已加入雙人連線，等待對手。";

  makeWeapon();
});

socket.on("state",state => {
  roomState = state;
  started = state.started;
  updateObjects(state);
  updateHud(state);
});

$("start").addEventListener("click",() => {
  if(!socket.connected) {
    $("loadStatus").textContent = "尚未連線，請稍候或重新整理。";
    return;
  }

  try {
    if(!scene) {
      initThree();
      bindControls();
    }
  } catch(err) {
    console.error("3D 初始化失敗：",err);
    $("loadStatus").textContent = "3D 場景初始化失敗：" + (err && err.message ? err.message : "未知錯誤") + "。請截圖這段訊息給我。";
    return;
  }

  $("loading").style.display = "none";
  $("hud").style.display = "block";
  socket.emit("joinGame",{
    mode: selected.mode,
    role: selected.role
  });

  if(audioCtx && audioCtx.state === "suspended") audioCtx.resume();
});

setInterval(sendInput,50);
});

(async function loadThreeModule() {
  const status = document.getElementById("loadStatus");
  const urls = [
    "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "https://unpkg.com/three@0.160.0/build/three.module.js"
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const module = await import(url);
      window.THREE = module;
      window.dispatchEvent(new Event("three-ready"));
      return;
    } catch (err) {
      lastError = err;
      console.error("Three.js 載入失敗：", url, err);
    }
  }
  status.textContent = "3D 引擎載入失敗。請確認網路可連線後重新整理；若仍失敗，請將此訊息告訴我。";
  console.error("無法載入 Three.js：", lastError);
})();
</script>
</body>
</html>`;

server.listen(PORT, "0.0.0.0", () => {
  console.log("紫禁城 3D 對決伺服器已啟動：" + PORT);
});
  
