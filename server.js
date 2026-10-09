
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const TICK_MS = 50;
const ARENA = 17;
const rooms = new Map();
const socketRooms = new Map();

const WEI_ITEMS = ["石灰粉", "暗器", "煙霧彈", "寶衣", "匕首"];

const OBSTACLES = [
  { id: "screenA", x: 0, z: -5.5, w: 7, d: 0.5, h: 2.2, kind: "screen" },
  { id: "screenB", x: 0, z: 5.5, w: 7, d: 0.5, h: 2.2, kind: "screen" },
  { id: "pillarA", x: -8, z: 0, w: 0.9, d: 0.9, h: 3, kind: "pillar" },
  { id: "pillarB", x: 8, z: 0, w: 0.9, d: 0.9, h: 3, kind: "pillar" },
  { id: "wallA", x: -12, z: -10, w: 7, d: 1, h: 3, kind: "wall" },
  { id: "wallB", x: 12, z: -10, w: 7, d: 1, h: 3, kind: "wall" },
  { id: "wallC", x: -12, z: 10, w: 7, d: 1, h: 3, kind: "wall" },
  { id: "wallD", x: 12, z: 10, w: 7, d: 1, h: 3, kind: "wall" }
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const now = () => Date.now();
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function createPlayer(id, role, index) {
  return {
    id,
    role,
    x: index === 0 ? -3 : 3,
    z: 0,
    yaw: index === 0 ? Math.PI / 2 : -Math.PI / 2,

    hp: 100,
    stamina: 100,
    alive: true,
    score: 0,

    dx: 0,
    dz: 0,
    blocking: false,

    dodgeUntil: 0,
    jumpUntil: 0,
    attackUntil: 0,
    cooldownUntil: 0,
    hitUntil: 0,
    blindUntil: 0,
    vestUntil: 0,
    smokeUntil: 0,

    inventory: Object.fromEntries(WEI_ITEMS.map(x => [x, 0])),
    skillCooldowns: {},
    lastAction: ""
  };
}

function createRoom(id) {
  const room = {
    id,
    players: new Map(),
    started: false,
    winner: null,
    destroyed: new Set(),
    items: [],
    nextItemId: 1,
    messages: [],
    createdAt: now()
  };

  const spots = [
    [-9, -3], [9, 3], [-9, 3], [9, -3],
    [-4, 0], [4, 0], [0, -9], [0, 9],
    [-12, 0], [12, 0], [-5, -9], [5, 9]
  ];

  for (let i = 0; i < spots.length; i++) {
    const [x, z] = spots[i];
    room.items.push({
      id: room.nextItemId++,
      type: WEI_ITEMS[i % WEI_ITEMS.length],
      x: x + (Math.random() - 0.5) * 0.5,
      z: z + (Math.random() - 0.5) * 0.5
    });
  }

  return room;
}

function say(room, text) {
  room.messages.push({ text, at: now() });
  room.messages = room.messages.slice(-5);
}

function getRoom(socketId) {
  const id = socketRooms.get(socketId);
  return id ? rooms.get(id) : null;
}

function isObstacleActive(room, o) {
  return !(o.kind === "screen" && room.destroyed.has(o.id));
}

function circleRect(x, z, r, o) {
  const cx = clamp(x, o.x - o.w / 2, o.x + o.w / 2);
  const cz = clamp(z, o.z - o.d / 2, o.z + o.d / 2);
  return Math.hypot(x - cx, z - cz) < r;
}

function isBlocked(room, x, z, radius = 0.45) {
  if (Math.abs(x) > ARENA - radius) return true;
  if (Math.abs(z) > ARENA - radius) return true;

  return OBSTACLES.some(o =>
    isObstacleActive(room, o) && circleRect(x, z, radius, o)
  );
}

function lineHitsRect(ax, az, bx, bz, o) {
  const minX = o.x - o.w / 2;
  const maxX = o.x + o.w / 2;
  const minZ = o.z - o.d / 2;
  const maxZ = o.z + o.d / 2;

  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;

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
    isObstacleActive(room, o) &&
    lineHitsRect(a.x, a.z, b.x, b.z, o)
  );
}

function angleTo(a, b) {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

function facingDifference(a, b) {
  let d = angleTo(a, b) - a.yaw;
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

  if (!isBlocked(room, nx, target.z)) target.x = nx;
  if (!isBlocked(room, target.x, nz)) target.z = nz;
}

function applyDamage(room, attacker, target, base, label) {
  if (!target.alive || now() < target.dodgeUntil) return false;

  let amount = base;

  if (target.blocking && facingDifference(target, attacker) < 1.8) {
    amount *= 0.22;
  }

  if (now() < target.vestUntil) amount *= 0.5;

  target.hp = Math.max(0, target.hp - amount);

  if (!target.blocking) {
    target.hitUntil = now() + 330;
    knockback(room, attacker, target, 0.7);
  }

  if (target.hp <= 0) {
    target.alive = false;
    attacker.score++;
    target.dx = 0;
    target.dz = 0;
    say(room, target.role + "被" + attacker.role + "擊敗！");
  } else {
    say(room, attacker.role + "使出" + label + "！");
  }

  return true;
}

function nearestEnemy(room, p, range, requireSight = true) {
  return [...room.players.values()]
    .filter(e =>
      e.id !== p.id &&
      e.alive &&
      distance(p, e) <= range &&
      (!requireSight || hasSight(room, p, e))
    )
    .sort((a, b) => distance(p, a) - distance(p, b))[0] || null;
}

function canUseSkill(p, key, staminaCost, cooldown) {
  const t = now();
  if (!p.alive || t < p.hitUntil) return false;
  if ((p.skillCooldowns[key] || 0) > t) return false;
  if (p.stamina < staminaCost) return false;

  p.stamina -= staminaCost;
  p.skillCooldowns[key] = t + cooldown;
  return true;
}

function basicAttack(room, p, heavy) {
  if (!p.alive || now() < p.cooldownUntil || now() < p.hitUntil) return;

  const cost = heavy ? 25 : 12;
  if (p.stamina < cost) return;

  p.stamina -= cost;
  p.attackUntil = now() + (heavy ? 480 : 260);
  p.cooldownUntil = now() + (heavy ? 850 : 360);

  const range = heavy ? 2.45 : 1.75;
  const damage = p.role === "海大富"
    ? (heavy ? 25 : 15)
    : (heavy ? 19 : 11);

  const target = nearestEnemy(room, p, range);

  if (
    target &&
    facingDifference(p, target) < 1.15
  ) {
    applyDamage(room, p, target, damage, heavy ? "重擊" : "普通攻擊");
  }
}

/* ------------------------------
   韋小寶專屬：道具與詭計
-------------------------------- */

function pickupItem(room, p) {
  if (p.role !== "韋小寶") {
    say(room, "海大富無法使用韋小寶的道具拾取技能。");
    return;
  }

  const item = room.items.find(i => distance(p, i) < 1.5);

  if (!item) {
    say(room, "附近沒有可拾取的道具。");
    return;
  }

  if ((p.inventory[item.type] || 0) >= 5) {
    say(room, item.type + "已達攜帶上限。");
    return;
  }

  p.inventory[item.type]++;
  room.items = room.items.filter(i => i.id !== item.id);
  say(room, "韋小寶拾取了" + item.type + "！");
}

function useWeiItem(room, p, type) {
  if (p.role !== "韋小寶") {
    say(room, "這是韋小寶的專屬道具。");
    return;
  }

  if (!WEI_ITEMS.includes(type)) return;

  if ((p.inventory[type] || 0) <= 0) {
    say(room, "你沒有" + type + "。");
    return;
  }

  const cooldownKey = "item:" + type;
  if ((p.skillCooldowns[cooldownKey] || 0) > now()) {
    say(room, type + "尚未冷卻完成。");
    return;
  }

  p.inventory[type]--;
  p.skillCooldowns[cooldownKey] = now() + 450;

  const enemies = [...room.players.values()].filter(
    e => e.id !== p.id && e.alive
  );

  if (type === "石灰粉") {
    const targets = enemies.filter(e =>
      distance(p, e) < 4 && hasSight(room, p, e)
    );

    targets.forEach(e => {
      e.blindUntil = now() + 2600;
    });

    say(room, targets.length
      ? "韋小寶撒出石灰粉，干擾了海大富！"
      : "石灰粉沒有命中對手。");
  }

  if (type === "暗器") {
    const target = nearestEnemy(room, p, 10);

    if (target) {
      applyDamage(room, p, target, 13, "暗器");
    } else {
      say(room, "暗器沒有命中：距離太遠或視線被阻擋。");
    }
  }

  if (type === "煙霧彈") {
    p.smokeUntil = now() + 3200;

    enemies
      .filter(e => distance(p, e) < 7)
      .forEach(e => {
        e.blindUntil = Math.max(e.blindUntil, now() + 1600);
      });

    say(room, "韋小寶施放煙霧彈，趁亂轉移！");
  }

  if (type === "寶衣") {
    p.vestUntil = now() + 6000;
    say(room, "韋小寶啟動寶衣，短時間降低受到的傷害！");
  }

  if (type === "匕首") {
    const target = nearestEnemy(room, p, 2.2);

    if (target && facingDifference(p, target) < 1.25) {
      applyDamage(room, p, target, 25, "匕首突襲");
    } else {
      say(room, "匕首突襲沒有命中。");
    }
  }
}

/* ------------------------------
   海大富專屬：武功與內力
-------------------------------- */

function haiSkill(room, p, skill) {
  if (p.role !== "海大富") {
    say(room, "這是海大富的專屬武功。");
    return;
  }

  if (skill === "bonePalm") {
    if (!canUseSkill(p, skill, 22, 1200)) return;

    p.attackUntil = now() + 480;
    const target = nearestEnemy(room, p, 3.0);

    if (target && facingDifference(p, target) < 0.95) {
      if (applyDamage(room, p, target, 25, "化骨綿掌")) {
        if (target.alive) target.hitUntil = now() + 600;
      }
    } else {
      say(room, "化骨綿掌擊空！");
    }
  }

  if (skill === "yinPalm") {
    if (!canUseSkill(p, skill, 30, 1500)) return;

    p.attackUntil = now() + 620;
    const target = nearestEnemy(room, p, 2.2);

    if (target && facingDifference(p, target) < 0.85) {
      applyDamage(room, p, target, 34, "陰毒掌法");
    } else {
      say(room, "陰毒掌法沒有命中！");
    }
  }

  if (skill === "grab") {
    if (!canUseSkill(p, skill, 18, 1300)) return;

    const target = nearestEnemy(room, p, 1.45);

    if (target && facingDifference(p, target) < 1.0) {
      applyDamage(room, p, target, 18, "擒拿");
      if (target.alive) target.hitUntil = now() + 650;
    } else {
      say(room, "擒拿距離不足！");
    }
  }

  if (skill === "innerGuard") {
    if (!canUseSkill(p, skill, 25, 7000)) return;

    p.vestUntil = now() + 3500;
    say(room, "海大富運轉內力護體！");
  }
}

function breakScreen(room, p) {
  const screen = OBSTACLES.find(o =>
    o.kind === "screen" &&
    !room.destroyed.has(o.id) &&
    distance(p, o) < 2.25
  );

  if (!screen) {
    say(room, "靠近屏風才能將它擊破。");
    return;
  }

  room.destroyed.add(screen.id);
  say(room, p.role + "擊破了屏風！");
}

function handleAction(room, p, data) {
  if (!data || !p.alive || room.winner) return;

  switch (data.type) {
    case "attack":
      basicAttack(room, p, false);
      break;

    case "heavy":
      basicAttack(room, p, true);
      break;

    case "block":
      p.blocking = !!data.value;
      break;

    case "dodge":
      if (p.stamina >= 20 && now() >= p.hitUntil) {
        p.stamina -= 20;
        p.dodgeUntil = now() + 330;
      }
      break;

    case "jump":
      if (p.stamina >= 12 && now() >= p.hitUntil) {
        p.stamina -= 12;
        p.jumpUntil = now() + 420;
        p.dodgeUntil = now() + 150;
      }
      break;

    case "pickup":
      pickupItem(room, p);
      break;

    case "useItem":
      useWeiItem(room, p, data.item);
      break;

    case "bonePalm":
    case "yinPalm":
    case "grab":
    case "innerGuard":
      haiSkill(room, p, data.type);
      break;

    case "break":
      breakScreen(room, p);
      break;
  }
}

function serializePlayer(p) {
  return {
    id: p.id,
    role: p.role,
    x: p.x,
    z: p.z,
    yaw: p.yaw,
    hp: p.hp,
    stamina: p.stamina,
    alive: p.alive,
    score: p.score,
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

function checkWinner(room) {
  if (!room.started || room.winner || room.players.size !== 2) return;

  const alive = [...room.players.values()].filter(p => p.alive);

  if (alive.length <= 1) {
    room.winner = alive[0] ? alive[0].role : "平手";
    say(room, "本局結束，勝者：" + room.winner);
  }
}

function sendState(room) {
  for (const p of room.players.values()) {
    const visiblePlayers = [...room.players.values()]
      .filter(other => {
        if (other.id === p.id) return true;
        if (now() < p.blindUntil) return false;

        if (
          now() < other.smokeUntil &&
          distance(p, other) > 2
        ) return false;

        return hasSight(room, p, other);
      })
      .map(serializePlayer);

    io.to(p.id).emit("state", {
      roomId: room.id,
      role: p.role,
      started: room.started,
      winner: room.winner,
      players: visiblePlayers,
      me: serializePlayer(p),
      items: room.items,
      obstacles: OBSTACLES,
      destroyed: [...room.destroyed],
      messages: room.messages.slice(-4)
    });
  }
}

/* ------------------------------
   Socket.IO 多人連線
-------------------------------- */

io.on("connection", socket => {
  socket.on("joinGame", () => {
    if (socketRooms.has(socket.id)) return;

    let room = [...rooms.values()].find(r =>
      !r.started && !r.winner && r.players.size < 2
    );

    if (!room) {
      room = createRoom(
        "palace-" + Math.random().toString(36).slice(2, 8)
      );
      rooms.set(room.id, room);
    }

    const index = room.players.size;
    const role = index === 0 ? "韋小寶" : "海大富";
    const p = createPlayer(socket.id, role, index);

    room.players.set(socket.id, p);
    socketRooms.set(socket.id, room.id);
    socket.join(room.id);

    socket.emit("joined", {
      id: socket.id,
      role,
      roomId: room.id
    });

    say(room, role + "進入紫禁城！");

    if (room.players.size === 2) {
      room.started = true;
      say(room, "對決開始！善用各自的武功與道具。");
    }

    sendState(room);
  });

  socket.on("input", data => {
    const room = getRoom(socket.id);
    if (!room || room.winner || !data) return;

    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;

    const dx = Number(data.dx);
    const dz = Number(data.dz);
    const yaw = Number(data.yaw);

    p.dx = Number.isFinite(dx) ? clamp(dx, -1, 1) : 0;
    p.dz = Number.isFinite(dz) ? clamp(dz, -1, 1) : 0;

    if (Number.isFinite(yaw)) p.yaw = yaw;
    p.blocking = !!data.blocking;
  });

  socket.on("action", data => {
    const room = getRoom(socket.id);
    if (!room) return;

    const p = room.players.get(socket.id);
    if (!p) return;

    handleAction(room, p, data);
    checkWinner(room);
    sendState(room);
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket.id);
    socketRooms.delete(socket.id);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(room.id);
      return;
    }

    room.started = false;
    room.winner = null;
    say(room, "對手已離開，等待新玩家加入。");
    sendState(room);
  });
});

/* ------------------------------
   伺服器移動與體力更新
-------------------------------- */

setInterval(() => {
  const dt = TICK_MS / 1000;

  for (const room of rooms.values()) {
    if (room.winner) continue;

    for (const p of room.players.values()) {
      if (!p.alive) continue;

      if (now() < p.hitUntil) {
        p.stamina = Math.min(100, p.stamina + 5 * dt);
        continue;
      }

      const dx = p.dx;
      const dz = p.dz;
      const length = Math.hypot(dx, dz);

      if (length > 0.03) {
        const speed = p.role === "海大富" ? 4.6 : 5.1;
        const boost = now() < p.dodgeUntil ? 1.8 : 1;
        const slow = p.blocking ? 0.42 : 1;
        const amount = speed * boost * slow * dt / Math.max(1, length);

        const nx = clamp(
          p.x + dx * amount,
          -ARENA + 0.5,
          ARENA - 0.5
        );

        const nz = clamp(
          p.z + dz * amount,
          -ARENA + 0.5,
          ARENA - 0.5
        );

        if (!isBlocked(room, nx, p.z)) p.x = nx;
        if (!isBlocked(room, p.x, nz)) p.z = nz;

        p.stamina = Math.max(
          0,
          p.stamina - (p.blocking ? 1 : 2) * dt
        );
      } else {
        p.stamina = Math.min(100, p.stamina + 14 * dt);
      }
    }

    checkWinner(room);
    sendState(room);
  }
}, TICK_MS);

/* ------------------------------
   3D 網頁前端
-------------------------------- */

const PAGE = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>紫禁城：金庸武俠對決</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111821;color:white;font-family:system-ui,"Noto Sans TC",sans-serif;touch-action:none}
#game{position:fixed;inset:0}
canvas{display:block}
#hud{position:fixed;z-index:5;top:calc(env(safe-area-inset-top) + 8px);left:8px;background:#10131be8;border:1px solid #b99457;border-radius:12px;padding:10px;width:190px;font-size:12px;pointer-events:none}
#status{font-weight:800;color:#f1d18b;font-size:13px;margin-bottom:4px}
.bar{height:9px;border-radius:9px;background:#3d2828;overflow:hidden;margin:4px 0 7px}
.fill{height:100%;width:100%}
#hpFill{background:linear-gradient(90deg,#a72e28,#f07855)}
#stFill{background:linear-gradient(90deg,#8d6a22,#f4d478)}
#items{line-height:1.6;color:#e8e0ce}
#messages{position:fixed;right:8px;top:calc(env(safe-area-inset-top) + 8px);z-index:5;text-align:right;font-size:12px;text-shadow:0 2px 4px #000;max-width:46vw;pointer-events:none}
#tip{position:fixed;left:8px;bottom:8px;z-index:4;background:#10131bd9;padding:7px 9px;border-radius:8px;font-size:10px;max-width:43vw;line-height:1.5;pointer-events:none}
#stickBase{position:fixed;left:18px;bottom:26px;width:124px;height:124px;border-radius:50%;background:#121722a8;border:2px solid #d4b36b;z-index:8;touch-action:none}
#stick{position:absolute;width:48px;height:48px;left:36px;top:36px;border-radius:50%;background:#d7bd7bcc;border:2px solid #fff8;pointer-events:none}
#buttons{position:fixed;right:8px;bottom:14px;z-index:8;display:grid;grid-template-columns:repeat(3,54px);gap:6px;touch-action:none}
.ctrl{border:1px solid #dfc080;border-radius:50%;width:54px;height:54px;color:white;background:#3c2925ee;font-weight:800;font-size:11px;touch-action:none;user-select:none}
.ctrl:active,.ctrl.active{background:#a34a2d}
.ctrl.small{width:46px;height:46px;font-size:10px}
.wei-skill,.hai-skill{display:none}
#overlay{position:fixed;inset:0;z-index:20;background:linear-gradient(#10151bef,#17120ff0);display:flex;align-items:center;justify-content:center;text-align:center;padding:22px}
#panel{max-width:420px;width:100%;border:1px solid #b99457;border-radius:18px;padding:24px 18px;background:linear-gradient(145deg,#322b23,#141923);box-shadow:0 18px 55px #0008}
h1{font-size:25px;color:#f2d18a;margin:0 0 8px}
.primary{border:1px solid #f0d79d;background:linear-gradient(#a84a2d,#702a22);border-radius:10px;padding:13px 24px;color:white;font-weight:800;font-size:16px;margin-top:12px}
#note{color:#c8c0b0;font-size:12px;line-height:1.7}
@media(min-width:800px){
 #stickBase{left:28px;bottom:28px}
 #buttons{right:22px;bottom:22px;grid-template-columns:repeat(3,64px);gap:8px}
 .ctrl{width:64px;height:64px;font-size:13px}
 .ctrl.small{width:54px;height:54px}
 #hud{width:230px;font-size:13px}
 #tip{font-size:12px;max-width:340px}
}
</style>
</head>
<body>
<div id="game"></div>
<div id="hud">
 <div id="status">尚未加入戰場</div>
 <div id="role">角色：—</div>
 <div>氣血</div><div class="bar"><div id="hpFill" class="fill"></div></div>
 <div>體力／內力</div><div class="bar"><div id="stFill" class="fill"></div></div>
 <div id="items"></div>
</div>
<div id="messages"></div>
<div id="tip">左側搖桿移動；右側拖動畫面轉向。韋小寶用道具，海大富用專屬武功。</div>
<div id="stickBase"><div id="stick"></div></div>
<div id="buttons">
 <button class="ctrl" data-action="attack">攻擊</button>
 <button class="ctrl" data-action="heavy">重擊</button>
 <button class="ctrl" data-action="block" data-hold="1">格擋</button>
 <button class="ctrl" data-action="dodge">閃避</button>
 <button class="ctrl" data-action="jump">輕功</button>
 <button class="ctrl" data-action="pickup">拾取</button>

 <button class="ctrl small wei-skill" data-item="石灰粉">石灰</button>
 <button class="ctrl small wei-skill" data-item="暗器">暗器</button>
 <button class="ctrl small wei-skill" data-item="煙霧彈">煙霧</button>
 <button class="ctrl small wei-skill" data-item="寶衣">寶衣</button>
 <button class="ctrl small wei-skill" data-item="匕首">匕首</button>

 <button class="ctrl small hai-skill" data-action="bonePalm">化骨掌</button>
 <button class="ctrl small hai-skill" data-action="yinPalm">陰毒掌</button>
 <button class="ctrl small hai-skill" data-action="grab">擒拿</button>
 <button class="ctrl small hai-skill" data-action="innerGuard">護體</button>

 <button class="ctrl small" data-action="break">破屏</button>
</div>
<div id="overlay">
 <div id="panel">
  <h1>紫禁城・武俠對決</h1>
  <p>韋小寶　VS　海大富</p>
  <p id="note">風格化 3D 宮廷場景、第三人稱視角、不同角色技能、道具和屏風戰術。請使用第二個瀏覽器或另一台裝置進行雙人測試。</p>
  <button id="start" class="primary">進入戰場</button>
  <p id="wait" style="font-size:12px;color:#f0d18b"></p>
 </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
<script>
(function(){
"use strict";
const $=id=>document.getElementById(id);
const socket=io();

let scene,camera,renderer,clock;
let myId=null,myRole=null,joined=false,state=null;
let yaw=0,pitch=.22;
let meshes=new Map(),itemMeshes=new Map(),obstacleMeshes=new Map();
let joy={x:0,y:0,active:false,pointer:null};
let blockHeld=false,lastSend=0,jumpVisual=0,jumpSpeed=0;
let lookPointer=null,lastX=0,lastY=0;

const material=(color,roughness=.8,metalness=0)=>
 new THREE.MeshStandardMaterial({color,roughness,metalness});

function addBox(parent,x,y,z,w,h,d,mat){
 const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
 m.position.set(x,y,z);
 m.castShadow=true;m.receiveShadow=true;
 parent.add(m);return m;
}

function buildScene(){
 scene=new THREE.Scene();
 scene.background=new THREE.Color(0x121923);
 scene.fog=new THREE.Fog(0x121923,34,68);

 camera=new THREE.PerspectiveCamera(64,innerWidth/innerHeight,.1,120);

 renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 renderer.setSize(innerWidth,innerHeight);
 renderer.shadowMap.enabled=true;
 renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 $("game").appendChild(renderer.domElement);

 scene.add(new THREE.HemisphereLight(0xdce7ff,0x453024,2.0));

 const sun=new THREE.DirectionalLight(0xffd7a0,2.5);
 sun.position.set(-10,22,12);
 sun.castShadow=true;
 sun.shadow.mapSize.set(1024,1024);
 scene.add(sun);

 const stone=material(0x776d5d);
 const tile=material(0x9a886a);
 const red=material(0x792e24);
 const dark=material(0x4c211b);
 const gold=material(0xd3ae63,.38,.15);
 const roof=material(0x29423c);
 const wall=material(0xb9a47e);

 const ground=new THREE.Mesh(new THREE.PlaneGeometry(36,36),stone);
 ground.rotation.x=-Math.PI/2;
 ground.position.y=-.08;
 ground.receiveShadow=true;
 scene.add(ground);

 for(let x=-17;x<=17;x+=2){
  for(let z=-17;z<=17;z+=2){
   addBox(scene,x,-.015,z,1.94,.035,1.94,tile);
  }
 }

 addBox(scene,0,1.6,-18,38,3.2,.7,wall);
 addBox(scene,0,1.6,18,38,3.2,.7,wall);
 addBox(scene,-18,1.6,0,.7,3.2,36,wall);
 addBox(scene,18,1.6,0,.7,3.2,36,wall);

 [-13,13].forEach(z=>{
  addBox(scene,0,1.45,z,14,2.9,4,red);
  addBox(scene,0,3.05,z,15,.25,4.7,gold);
  const r=new THREE.Mesh(new THREE.ConeGeometry(8.4,2.3,4),roof);
  r.rotation.y=Math.PI/4;
  r.scale.set(1,.5,.48);
  r.position.set(0,4,z);
  r.castShadow=true;
  scene.add(r);

  [-5,-2.5,0,2.5,5].forEach(x=>{
   addBox(scene,x,1.4,z-2.05,.26,2.8,.26,dark);
   addBox(scene,x,1.4,z+2.05,.26,2.8,.26,dark);
  });
 });

 [-14,14].forEach(x=>{
  [-10,-5,0,5,10].forEach(z=>{
   const pillar=new THREE.Mesh(
    new THREE.CylinderGeometry(.28,.34,3.3,12),red
   );
   pillar.position.set(x,1.65,z);
   pillar.castShadow=true;
   scene.add(pillar);
   addBox(scene,x,3.35,z,.65,.72,.65,gold);
  });
 });

 const localObstacles=[
  {id:"screenA",x:0,z:-5.5,w:7,d:.5,h:2.2,kind:"screen"},
  {id:"screenB",x:0,z:5.5,w:7,d:.5,h:2.2,kind:"screen"},
  {id:"pillarA",x:-8,z:0,w:.9,d:.9,h:3,kind:"pillar"},
  {id:"pillarB",x:8,z:0,w:.9,d:.9,h:3,kind:"pillar"},
  {id:"wallA",x:-12,z:-10,w:7,d:1,h:3,kind:"wall"},
  {id:"wallB",x:12,z:-10,w:7,d:1,h:3,kind:"wall"},
  {id:"wallC",x:-12,z:10,w:7,d:1,h:3,kind:"wall"},
  {id:"wallD",x:12,z:10,w:7,d:1,h:3,kind:"wall"}
 ];

 localObstacles.forEach(o=>{
  const m=addBox(
   scene,o.x,o.h/2,o.z,o.w,o.h,o.d,
   o.kind==="screen"?material(0x9a5132):
   o.kind==="pillar"?dark:red
  );

  obstacleMeshes.set(o.id,m);

  if(o.kind==="screen"){
   addBox(scene,o.x,o.h+.07,o.z,o.w+.18,.14,o.d+.12,gold);
   for(let x=-o.w/2+.5;x<o.w/2;x+=1.1){
    addBox(scene,o.x+x,1.05,o.z,.045,1.7,.06,gold);
   }
  }
 });

 [-5,5].forEach(x=>{
  const lamp=new THREE.Mesh(
   new THREE.SphereGeometry(.28,12,10),
   new THREE.MeshBasicMaterial({color:0xffbd51})
  );
  lamp.position.set(x,5.4,0);
  scene.add(lamp);
 });
}

function makeCharacter(role){
 const group=new THREE.Group();
 const wei=role==="韋小寶";

 const robe=material(wei?0x315e91:0x692a24);
 const trim=material(wei?0xd9bd77:0xb4a080);
 const skin=material(0xe0b28a);
 const pants=material(0x252832);
 const black=material(0x17191d);

 const body=new THREE.Mesh(
  new THREE.CapsuleGeometry(.39,.64,4,8),robe
 );
 body.position.y=1.24;
 body.castShadow=true;
 group.add(body);

 const head=new THREE.Mesh(
  new THREE.SphereGeometry(.3,14,12),skin
 );
 head.position.y=2.02;
 head.castShadow=true;
 group.add(head);

 const hat=new THREE.Mesh(
  new THREE.CylinderGeometry(.29,.32,.15,12),black
 );
 hat.position.y=2.29;
 group.add(hat);

 const belt=new THREE.Mesh(
  new THREE.TorusGeometry(.4,.045,6,16),trim
 );
 belt.rotation.x=Math.PI/2;
 belt.position.y=1.05;
 group.add(belt);

 [-1,1].forEach(side=>{
  const leg=new THREE.Mesh(
   new THREE.CapsuleGeometry(.14,.38,3,7),pants
  );
  leg.position.set(side*.2,.48,0);
  group.add(leg);

  const arm=new THREE.Mesh(
   new THREE.CapsuleGeometry(.12,.43,3,7),robe
  );
  arm.position.set(side*.45,1.42,0);
  arm.rotation.z=side*.35;
  group.add(arm);
 });

 const weapon=new THREE.Mesh(
  new THREE.BoxGeometry(.055,.72,.1),
  material(0xc7d4dc,.25,.7)
 );
 weapon.position.set(.48,1.16,.2);
 weapon.rotation.z=-.6;
 group.add(weapon);

 const labelCanvas=document.createElement("canvas");
 labelCanvas.width=256;
 labelCanvas.height=64;
 const ctx=labelCanvas.getContext("2d");
 ctx.fillStyle="#17130ee8";
 ctx.fillRect(0,0,256,64);
 ctx.fillStyle=wei?"#d5e8ff":"#ffe0c1";
 ctx.font="bold 30px sans-serif";
 ctx.textAlign="center";
 ctx.fillText(role,128,42);

 const label=new THREE.Sprite(
  new THREE.SpriteMaterial({
   map:new THREE.CanvasTexture(labelCanvas),
   transparent:true
  })
 );
 label.position.y=2.75;
 label.scale.set(1.8,.45,1);
 group.add(label);

 group.userData.body=body;
 group.userData.weapon=weapon;
 return group;
}

function makeItem(item){
 const colors={
  "石灰粉":0xe8dfb5,
  "暗器":0xa9bacb,
  "煙霧彈":0x7f8597,
  "寶衣":0x45a16c,
  "匕首":0xd1dce8
 };

 const group=new THREE.Group();

 const core=new THREE.Mesh(
  new THREE.OctahedronGeometry(.27),
  material(colors[item.type]||0xffffff,.4,.15)
 );
 core.position.y=.55;
 group.add(core);

 const ring=new THREE.Mesh(
  new THREE.TorusGeometry(.38,.035,6,20),
  new THREE.MeshBasicMaterial({
   color:colors[item.type]||0xffffff
  })
 );
 ring.rotation.x=Math.PI/2;
 ring.position.y=.18;
 group.add(ring);

 group.position.set(item.x,0,item.z);
 scene.add(group);
 return group;
}

function updateHud(p){
 $("role").textContent="角色："+p.role+"　戰績："+p.score;
 $("hpFill").style.width=p.hp+"%";
 $("stFill").style.width=p.stamina+"%";

 if(!state.started){
  $("status").textContent="等待對手加入";
 }else if(!p.alive){
  $("status").textContent="本局落敗";
 }else if(state.winner){
  $("status").textContent="勝者："+state.winner;
 }else{
  $("status").textContent="紫禁城對決中";
 }

 if(p.role==="韋小寶"){
  const names=["石灰粉","暗器","煙霧彈","寶衣","匕首"];
  $("items").innerHTML=names.map(
   (n,i)=>(i+1)+". "+n+" × "+(p.inventory[n]||0)
  ).join("<br>");
 }else{
  $("items").innerHTML=
   "化骨綿掌：中距離控制<br>"+
   "陰毒掌法：近距離重擊<br>"+
   "擒拿：近身打斷<br>"+
   "內力護體：短時間減傷";
 }
}

function escapeHTML(s){
 return String(s).replace(/[&<>"']/g,c=>({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
 }[c]));
}

function updateState(s){
 state=s;

 const present=new Set(s.players.map(p=>p.id));

 for(const [id,m] of meshes){
  if(!present.has(id)){
   scene.remove(m);
   meshes.delete(id);
  }
 }

 s.players.forEach(p=>{
  let m=meshes.get(p.id);

  if(!m){
   m=makeCharacter(p.role);
   scene.add(m);
   meshes.set(p.id,m);
  }

  const jumpY=p.jumping?
   Math.sin((performance.now()%420)/420*Math.PI)*.8:0;

  m.position.set(p.x,jumpY,p.z);
  m.rotation.y=p.yaw;
  m.userData.body.material.emissive.setHex(
   p.hit?0x551111:0x000000
  );
  m.userData.weapon.visible=p.attacking;
  m.userData.weapon.rotation.z=p.attacking?-1.25:-.6;
  m.visible=true;

  if(p.id===myId)updateHud(p);
 });

 const itemIds=new Set(s.items.map(i=>i.id));

 for(const [id,m] of itemMeshes){
  if(!itemIds.has(id)){
   scene.remove(m);
   itemMeshes.delete(id);
  }
 }

 s.items.forEach(i=>{
  if(!itemMeshes.has(i.id)){
   itemMeshes.set(i.id,makeItem(i));
  }
 });

 itemMeshes.forEach((m,id)=>{
  m.rotation.y+=.025;
  m.position.y=.05+Math.sin(performance.now()*.003+id)*.08;
 });

 s.destroyed.forEach(id=>{
  const m=obstacleMeshes.get(id);
  if(m)m.visible=false;
 });

 $("messages").innerHTML=s.messages
  .map(m=>"<div>"+escapeHTML(m.text)+"</div>")
  .join("");

 if(s.winner){
  $("overlay").style.display="flex";
  $("start").textContent="重新開始";
  $("wait").textContent="勝者："+s.winner+"。按重新開始重新配對。";
 }
}

function sendAction(type,item){
 if(joined)socket.emit("action",{type,item});
}

function sendInput(){
 if(!joined||!state)return;

 let sx=joy.x;
 let sy=joy.y;
 const len=Math.hypot(sx,sy);

 if(len>1){sx/=len;sy/=len;}

 const forward=-sy;
 const right=sx;

 const dx=Math.sin(yaw)*forward+Math.cos(yaw)*right;
 const dz=Math.cos(yaw)*forward-Math.sin(yaw)*right;

 socket.emit("input",{
  dx,dz,yaw,blocking:blockHeld
 });
}

function updateCamera(dt){
 if(!state||!state.me)return;

 const p=state.me;
 const target=new THREE.Vector3(
  p.x,1.35+jumpVisual,p.z
 );

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

 if(jumpSpeed!==0||jumpVisual>0){
  jumpVisual+=jumpSpeed*dt;
  jumpSpeed-=11*dt;
  if(jumpVisual<=0){
   jumpVisual=0;
   jumpSpeed=0;
  }
 }

 if(performance.now()-lastSend>40){
  sendInput();
  lastSend=performance.now();
 }

 updateCamera(dt);
 renderer.render(scene,camera);
}

function setupControls(){
 const base=$("stickBase");
 const stick=$("stick");

 function moveStick(e){
  const r=base.getBoundingClientRect();
  const cx=r.left+r.width/2;
  const cy=r.top+r.height/2;

  let dx=(e.clientX-cx)/43;
  let dy=(e.clientY-cy)/43;
  const len=Math.hypot(dx,dy);

  if(len>1){dx/=len;dy/=len;}

  joy.x=dx;
  joy.y=dy;
  stick.style.left=(36+dx*34)+"px";
  stick.style.top=(36+dy*34)+"px";
 }

 base.addEventListener("pointerdown",e=>{
  e.preventDefault();
  joy.active=true;
  joy.pointer=e.pointerId;
  base.setPointerCapture(e.pointerId);
  moveStick(e);
 });

 base.addEventListener("pointermove",e=>{
  if(joy.active&&e.pointerId===joy.pointer)moveStick(e);
 });

 function resetStick(){
  joy.active=false;
  joy.x=0;
  joy.y=0;
  stick.style.left="36px";
  stick.style.top="36px";
 }

 base.addEventListener("pointerup",resetStick);
 base.addEventListener("pointercancel",resetStick);

 document.querySelectorAll("[data-action]").forEach(btn=>{
  const type=btn.dataset.action;

  if(type==="block"){
   btn.addEventListener("pointerdown",e=>{
    e.preventDefault();
    blockHeld=true;
    btn.classList.add("active");
   });

   const release=()=>{
    blockHeld=false;
    btn.classList.remove("active");
   };

   btn.addEventListener("pointerup",release);
   btn.addEventListener("pointercancel",release);
   btn.addEventListener("pointerleave",release);
  }else{
   btn.addEventListener("pointerdown",e=>{
    e.preventDefault();

    if(type==="jump"){
     jumpSpeed=5.5;
     sendAction("jump");
    }else{
     sendAction(type);
    }
   });
  }
 });

 document.querySelectorAll("[data-item]").forEach(btn=>{
  btn.addEventListener("pointerdown",e=>{
   e.preventDefault();
   sendAction("useItem",btn.dataset.item);
  });
 });

 renderer.domElement.addEventListener("pointerdown",e=>{
  if(e.pointerType==="mouse"&&e.button===0){
   sendAction("attack");
   return;
  }

  if(e.clientX>innerWidth*.38){
   lookPointer=e.pointerId;
   lastX=e.clientX;
   lastY=e.clientY;
  }
 });

 renderer.domElement.addEventListener("pointermove",e=>{
  if(lookPointer!==e.pointerId)return;

  const dx=e.clientX-lastX;
  const dy=e.clientY-lastY;

  yaw-=dx*.006;
  pitch=Math.max(-.12,Math.min(.7,pitch+dy*.003));

  lastX=e.clientX;
  lastY=e.clientY;
 });

 const endLook=e=>{
  if(lookPointer===e.pointerId)lookPointer=null;
 };

 renderer.domElement.addEventListener("pointerup",endLook);
 renderer.domElement.addEventListener("pointercancel",endLook);

 document.addEventListener("keydown",e=>{
  if(e.repeat||!joined)return;

  const keys={
   KeyJ:"attack",
   KeyK:"heavy",
   ShiftLeft:"dodge",
   Space:"jump",
   KeyE:"pickup",
   KeyR:"break"
  };

  if(keys[e.code])sendAction(keys[e.code]);

  if(e.code==="KeyL")blockHeld=true;

  const items=["石灰粉","暗器","煙霧彈","寶衣","匕首"];

  if(/^Digit[1-5]$/.test(e.code)){
   sendAction("useItem",items[Number(e.code.slice(-1))-1]);
  }
 });

 document.addEventListener("keyup",e=>{
  if(e.code==="KeyL")blockHeld=false;
 });

 addEventListener("resize",()=>{
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
 });
}

$("start").addEventListener("click",()=>{
 if(joined){
  location.reload();
  return;
 }

 $("start").disabled=true;
 $("start").textContent="正在配對";
 $("wait").textContent="正在連線，等待另一名玩家……";
 socket.emit("joinGame");
});

socket.on("joined",data=>{
 myId=data.id;
 myRole=data.role;
 joined=true;

 document.querySelectorAll(".wei-skill").forEach(btn=>{
  btn.style.display=myRole==="韋小寶"?"":"none";
 });

 document.querySelectorAll(".hai-skill").forEach(btn=>{
  btn.style.display=myRole==="海大富"?"":"none";
 });

 $("overlay").style.display="none";
});

socket.on("state",updateState);

socket.on("connect_error",()=>{
 $("wait").textContent="連線失敗，請確認網路後重新整理。";
});

buildScene();
clock=new THREE.Clock();
setupControls();
animate();
})();
</script>
</body>
</html>`;

app.get("/", (req, res) => {
  res.type("html").send(PAGE);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("3D 武俠格鬥遊戲已啟動，port " + PORT);
});
