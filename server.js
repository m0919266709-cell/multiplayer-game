


const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const rooms = new Map();
const socketRooms = new Map();
const STEP = 50;
const LIMIT = 16.5;

const ITEMS = ["石灰粉", "暗器", "煙霧彈", "寶衣", "匕首"];

const WALLS = [
  { id: "screen1", x: 0, z: -5.5, w: 7, d: .45, h: 2.2, screen: true },
  { id: "screen2", x: 0, z: 5.5, w: 7, d: .45, h: 2.2, screen: true },
  { id: "pillar1", x: -8, z: 0, w: .9, d: .9, h: 3 },
  { id: "pillar2", x: 8, z: 0, w: .9, d: .9, h: 3 },
  { id: "wall1", x: -12, z: -10, w: 7, d: .8, h: 3 },
  { id: "wall2", x: 12, z: -10, w: 7, d: .8, h: 3 },
  { id: "wall3", x: -12, z: 10, w: 7, d: .8, h: 3 },
  { id: "wall4", x: 12, z: 10, w: 7, d: .8, h: 3 }
];

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const now = () => Date.now();
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function createPlayer(id, role, index) {
  return {
    id, role,
    x: index ? 3 : -3, z: 0,
    yaw: index ? -Math.PI / 2 : Math.PI / 2,
    hp: 100, stamina: 100,
    alive: true, score: 0,
    dx: 0, dz: 0, blocking: false,
    dodgeUntil: 0, hitUntil: 0, attackUntil: 0,
    vestUntil: 0, blindUntil: 0, smokeUntil: 0,
    inventory: Object.fromEntries(ITEMS.map(i => [i, 0])),
    cooldowns: {},
    effect: null,
    effectUntil: 0
  };
}

function createRoom(id) {
  const room = {
    id, players: new Map(),
    started: false, winner: null,
    destroyed: new Set(), items: [],
    nextItem: 1, messages: [],
    lastState: 0
  };

  const locations = [
    [-10, -2], [10, 2], [-10, 3], [10, -3],
    [-4, -9], [4, 9], [-13, 0], [13, 0],
    [-5, 0], [5, 0]
  ];

  locations.forEach((p, i) => {
    room.items.push({
      id: room.nextItem++,
      type: ITEMS[i % ITEMS.length],
      x: p[0], z: p[1]
    });
  });

  return room;
}

function announce(room, text) {
  room.messages.push({ text, at: now() });
  room.messages = room.messages.slice(-5);
}

function getRoom(socketId) {
  const id = socketRooms.get(socketId);
  return id ? rooms.get(id) : null;
}

function wallActive(room, wall) {
  return !(wall.screen && room.destroyed.has(wall.id));
}

function circleRect(x, z, r, wall) {
  const px = clamp(x, wall.x - wall.w / 2, wall.x + wall.w / 2);
  const pz = clamp(z, wall.z - wall.d / 2, wall.z + wall.d / 2);
  return Math.hypot(x - px, z - pz) < r;
}

function blocked(room, x, z, r = .42) {
  if (Math.abs(x) > LIMIT || Math.abs(z) > LIMIT) return true;
  return WALLS.some(w => wallActive(room, w) && circleRect(x, z, r, w));
}

function lineBlocked(room, a, b) {
  const steps = Math.ceil(distance(a, b) * 10);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (WALLS.some(w =>
      wallActive(room, w) &&
      x >= w.x - w.w / 2 && x <= w.x + w.w / 2 &&
      z >= w.z - w.d / 2 && z <= w.z + w.d / 2
    )) return true;
  }
  return false;
}

function angleTo(a, b) {
  let d = Math.atan2(b.x - a.x, b.z - a.z) - a.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function pushBack(room, attacker, target, power) {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = target.x + dx / len * power;
  const nz = target.z + dz / len * power;
  if (!blocked(room, nx, target.z)) target.x = nx;
  if (!blocked(room, target.x, nz)) target.z = nz;
}

function setEffect(p, effect, duration = 450) {
  p.effect = effect;
  p.effectUntil = now() + duration;
}

function hit(room, attacker, target, amount, name, options = {}) {
  if (!target.alive || now() < target.dodgeUntil) return false;

  if (target.blocking && angleTo(target, attacker) < 1.9) {
    amount *= .2;
    setEffect(target, "block", 250);
  }

  if (now() < target.vestUntil) amount *= .5;

  target.hp = Math.max(0, target.hp - amount);
  setEffect(target, options.effect || "hit", 350);

  if (!target.blocking) {
    target.hitUntil = now() + (options.stun || 180);
    pushBack(room, attacker, target, options.push || .45);
  }

  if (target.hp <= 0) {
    target.alive = false;
    target.dx = target.dz = 0;
    attacker.score++;
    announce(room, attacker.role + "擊敗了" + target.role + "！");
  } else {
    announce(room, attacker.role + "施展「" + name + "」！");
  }

  return true;
}

function nearestEnemy(room, p, range, requireSight = true) {
  return [...room.players.values()]
    .filter(e => e.id !== p.id && e.alive &&
      distance(p, e) <= range &&
      (!requireSight || !lineBlocked(room, p, e)))
    .sort((a, b) => distance(p, a) - distance(p, b))[0] || null;
}

function ready(p, key, cost, cooldown) {
  if (!p.alive || now() < p.hitUntil) return false;
  if ((p.cooldowns[key] || 0) > now()) return false;
  if (p.stamina < cost) return false;
  p.stamina -= cost;
  p.cooldowns[key] = now() + cooldown;
  return true;
}

function attack(room, p, heavy = false) {
  if (!ready(p, "attack", heavy ? 23 : 9, heavy ? 850 : 400)) return;

  p.attackUntil = now() + 300;
  setEffect(p, heavy ? "heavy" : "attack", 300);

  const target = nearestEnemy(room, p, heavy ? 2.4 : 1.75);
  if (!target || angleTo(p, target) > 1.05) return;

  const damage = p.role === "海大富"
    ? (heavy ? 25 : 15)
    : (heavy ? 18 : 11);

  hit(room, p, target, damage, heavy ? "重擊" : "普通攻擊", {
    push: heavy ? .9 : .4,
    effect: heavy ? "heavyHit" : "hit"
  });
}

function pickup(room, p) {
  if (p.role !== "韋小寶") {
    announce(room, "海大富不使用這些道具。");
    return;
  }

  const item = room.items.find(i => distance(i, p) < 1.5);
  if (!item) {
    announce(room, "附近沒有可拾取的道具。");
    return;
  }

  if (p.inventory[item.type] >= 5) {
    announce(room, item.type + "已達攜帶上限。");
    return;
  }

  p.inventory[item.type]++;
  room.items = room.items.filter(i => i.id !== item.id);
  announce(room, "韋小寶拾取了" + item.type + "。");
}

function useItem(room, p, type) {
  if (p.role !== "韋小寶" || !ITEMS.includes(type)) return;
  if (p.inventory[type] <= 0) {
    announce(room, "沒有" + type + "了！");
    return;
  }

  const key = "item:" + type;
  if ((p.cooldowns[key] || 0) > now()) return;

  p.cooldowns[key] = now() + 450;
  p.inventory[type]--;

  if (type === "石灰粉") {
    const e = nearestEnemy(room, p, 4, false);
    if (e) {
      e.blindUntil = now() + 2600;
      setEffect(e, "blind", 900);
      announce(room, "石灰粉飛揚，對手視線受阻！");
    } else announce(room, "石灰粉沒有命中。");
  }

  if (type === "暗器") {
    const e = nearestEnemy(room, p, 11);
    if (e && angleTo(p, e) < .48) {
      hit(room, p, e, 15, "暗器", { push: .2 });
    } else announce(room, "暗器沒有命中，注意瞄準！");
  }

  if (type === "煙霧彈") {
    p.smokeUntil = now() + 3500;
    setEffect(p, "smoke", 1000);
    for (const e of room.players.values()) {
      if (e.id !== p.id && distance(p, e) < 7) {
        e.blindUntil = now() + 1700;
      }
    }
    announce(room, "煙霧彈炸開，韋小寶趁亂脫身！");
  }

  if (type === "寶衣") {
    p.vestUntil = now() + 6000;
    setEffect(p, "guard", 900);
    announce(room, "寶衣護身，短時間降低所受傷害！");
  }

  if (type === "匕首") {
    const e = nearestEnemy(room, p, 2.3);
    if (e && angleTo(p, e) < 1.2) {
      hit(room, p, e, 26, "匕首突襲", {
        push: .7, effect: "heavyHit"
      });
    } else announce(room, "匕首突襲沒有命中！");
  }
}

function haiSkill(room, p, skill) {
  if (p.role !== "海大富") {
    announce(room, "這是海大富的專屬武功！");
    return;
  }

  if (skill === "bonePalm") {
    if (!ready(p, skill, 22, 1300)) return;
    setEffect(p, "bonePalm", 550);
    const e = nearestEnemy(room, p, 3);
    if (e && angleTo(p, e) < .95) {
      hit(room, p, e, 24, "化骨綿掌", {
        push: .55, stun: 480, effect: "poison"
      });
    } else announce(room, "化骨綿掌擊空！");
  }

  if (skill === "yinPalm") {
    if (!ready(p, skill, 30, 1800)) return;
    setEffect(p, "yinPalm", 600);
    const e = nearestEnemy(room, p, 2.25);
    if (e && angleTo(p, e) < .85) {
      hit(room, p, e, 34, "陰毒掌法", {
        push: .8, stun: 350, effect: "heavyHit"
      });
    } else announce(room, "陰毒掌法沒有命中！");
  }

  if (skill === "grab") {
    if (!ready(p, skill, 18, 1450)) return;
    setEffect(p, "grab", 350);
    const e = nearestEnemy(room, p, 1.55);
    if (e && angleTo(p, e) < .95) {
      hit(room, p, e, 18, "擒拿", {
        push: .15, stun: 750, effect: "grabbed"
      });
    } else announce(room, "擒拿距離不足！");
  }

  if (skill === "innerGuard") {
    if (!ready(p, skill, 25, 7000)) return;
    p.vestUntil = now() + 3500;
    setEffect(p, "innerGuard", 1100);
    announce(room, "海大富運轉內力護體！");
  }
}

function doAction(room, p, data) {
  if (!data || !p.alive || room.winner) return;

  switch (data.type) {
    case "attack": attack(room, p); break;
    case "heavy": attack(room, p, true); break;
    case "block": p.blocking = !!data.value; break;
    case "dodge":
      if (ready(p, "dodge", 20, 700)) {
        p.dodgeUntil = now() + 360;
        setEffect(p, "dodge", 300);
      }
      break;
    case "jump":
      if (ready(p, "jump", 12, 500)) {
        p.dodgeUntil = now() + 160;
        setEffect(p, "jump", 300);
      }
      break;
    case "pickup": pickup(room, p); break;
    case "useItem": useItem(room, p, data.item); break;
    case "bonePalm":
    case "yinPalm":
    case "grab":
    case "innerGuard":
      haiSkill(room, p, data.type);
      break;
    case "break": {
      const w = WALLS.find(o => o.screen &&
        !room.destroyed.has(o.id) && distance(p, o) < 2.3);
      if (w) {
        room.destroyed.add(w.id);
        announce(room, p.role + "擊破屏風！");
      } else announce(room, "靠近屏風才能將它擊破。");
      break;
    }
  }
}

function serialize(p) {
  return {
    id: p.id, role: p.role,
    x: p.x, z: p.z, yaw: p.yaw,
    hp: p.hp, stamina: p.stamina,
    alive: p.alive, score: p.score,
    blocking: p.blocking,
    dodging: now() < p.dodgeUntil,
    attacking: now() < p.attackUntil,
    hit: now() < p.hitUntil,
    blind: now() < p.blindUntil,
    vest: now() < p.vestUntil,
    smoke: now() < p.smokeUntil,
    effect: p.effect,
    effectUntil: p.effectUntil,
    inventory: p.inventory
  };
}

function checkWinner(room) {
  if (!room.started || room.winner || room.players.size !== 2) return;
  const alive = [...room.players.values()].filter(p => p.alive);
  if (alive.length <= 1) {
    room.winner = alive[0] ? alive[0].role : "平手";
    announce(room, "對決結束！勝者：" + room.winner);
  }
}

function sendStates(room) {
  for (const p of room.players.values()) {
    const visiblePlayers = [...room.players.values()].filter(e => {
      if (e.id === p.id) return true;
      if (now() < p.blindUntil) return false;
      if (now() < e.smokeUntil && distance(p, e) > 2) return false;
      return !lineBlocked(room, p, e);
    }).map(serialize);

    io.to(p.id).emit("state", {
      started: room.started,
      winner: room.winner,
      players: visiblePlayers,
      me: serialize(p),
      items: room.items,
      destroyed: [...room.destroyed],
      messages: room.messages.slice(-4)
    });
  }
}

io.on("connection", socket => {
  socket.on("joinGame", () => {
    if (socketRooms.has(socket.id)) return;

    let room = [...rooms.values()].find(r =>
      !r.started && !r.winner && r.players.size < 2
    );

    if (!room) {
      room = createRoom("palace-" + Math.random().toString(36).slice(2, 8));
      rooms.set(room.id, room);
    }

    const index = room.players.size;
    const role = index === 0 ? "韋小寶" : "海大富";
    room.players.set(socket.id, createPlayer(socket.id, role, index));
    socketRooms.set(socket.id, room.id);
    socket.join(room.id);

    socket.emit("joined", { id: socket.id, role, roomId: room.id });
    announce(room, role + "進入紫禁城！");

    if (room.players.size === 2) {
      room.started = true;
      announce(room, "宮門已閉，對決開始！");
    }

    sendStates(room);
  });

  socket.on("input", data => {
    const room = getRoom(socket.id);
    const p = room?.players.get(socket.id);
    if (!room || !p || !data || room.winner || !p.alive) return;

    p.dx = clamp(Number(data.dx) || 0, -1, 1);
    p.dz = clamp(Number(data.dz) || 0, -1, 1);

    const yaw = Number(data.yaw);
    if (Number.isFinite(yaw)) p.yaw = yaw;

    p.blocking = !!data.blocking;
  });

  socket.on("action", data => {
    const room = getRoom(socket.id);
    const p = room?.players.get(socket.id);
    if (!room || !p) return;
    doAction(room, p, data);
    checkWinner(room);
    sendStates(room);
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket.id);
    socketRooms.delete(socket.id);
    if (!room) return;

    room.players.delete(socket.id);

    if (!room.players.size) {
      rooms.delete(room.id);
      return;
    }

    room.started = false;
    room.winner = null;
    announce(room, "對手離開，等待下一位玩家。");
    sendStates(room);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.winner) continue;

    for (const p of room.players.values()) {
      if (!p.alive) continue;

      const dt = STEP / 1000;

      if (now() < p.hitUntil) {
        p.stamina = Math.min(100, p.stamina + 4 * dt);
        continue;
      }

      const len = Math.hypot(p.dx, p.dz);
      if (len > .03) {
        const speed = p.role === "海大富" ? 4.4 : 4.9;
        const boost = now() < p.dodgeUntil ? 1.7 : 1;
        const slow = p.blocking ? .4 : 1;
        const factor = speed * boost * slow * dt / Math.max(1, len);
        const nx = clamp(p.x + p.dx * factor, -LIMIT, LIMIT);
        const nz = clamp(p.z + p.dz * factor, -LIMIT, LIMIT);

        if (!blocked(room, nx, p.z)) p.x = nx;
        if (!blocked(room, p.x, nz)) p.z = nz;

        p.stamina = Math.max(0, p.stamina - 2 * dt);
      } else {
        p.stamina = Math.min(100, p.stamina + 13 * dt);
      }

      if (p.effectUntil < now()) p.effect = null;
    }

    checkWinner(room);
    if (now() - room.lastState > 80) {
      sendStates(room);
      room.lastState = now();
    }
  }
}, STEP);

const PAGE = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>紫禁城・第一人稱武俠</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111720;color:#f8e6c1;font-family:system-ui,"Noto Sans TC",sans-serif;touch-action:none}
#game{position:fixed;inset:0}
canvas{display:block}
#vignette{position:fixed;inset:0;pointer-events:none;z-index:2;background:radial-gradient(ellipse,transparent 45%,#0008)}
#top{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:4;padding:8px 16px;border:1px solid #bda06399;border-radius:25px;background:#101720d9;font-size:12px;letter-spacing:2px;white-space:nowrap}
#hud{position:fixed;z-index:5;left:10px;top:calc(env(safe-area-inset-top) + 10px);width:200px;padding:12px;background:#111820e8;border:1px solid #b99b62;border-radius:12px;pointer-events:none;font-size:12px}
#role{font-size:16px;font-weight:900;color:#f5d59a;margin-bottom:7px}
.meter{display:flex;justify-content:space-between}
.bar{height:8px;background:#392f2b;border-radius:8px;overflow:hidden;margin:4px 0 8px}
.fill{height:100%;width:100%;transition:width .15s}
#hpFill{background:linear-gradient(90deg,#8b1722,#ff8065)}
#stFill{background:linear-gradient(90deg,#97712d,#ffe5a0)}
#inventory{line-height:1.65}
#messages{position:fixed;z-index:5;right:10px;top:60px;text-align:right;max-width:48vw;font-size:12px;line-height:1.8;text-shadow:0 2px 5px black;pointer-events:none}
#cross{position:fixed;z-index:4;left:50%;top:50%;width:18px;height:18px;transform:translate(-50%,-50%);pointer-events:none}
#cross:before,#cross:after{content:"";position:absolute;background:#fff1cf;box-shadow:0 0 5px #000}
#cross:before{width:2px;height:18px;left:8px}
#cross:after{height:2px;width:18px;top:8px}
#stickBase{position:fixed;z-index:8;left:18px;bottom:26px;width:122px;height:122px;border:2px solid #c8a765;border-radius:50%;background:#111821b9;touch-action:none}
#stick{position:absolute;left:35px;top:35px;width:48px;height:48px;border-radius:50%;background:#cdb67cdd;border:2px solid #fff8;pointer-events:none}
#buttons{position:fixed;z-index:8;right:8px;bottom:12px;display:grid;grid-template-columns:repeat(3,54px);gap:6px}
button{font-family:inherit}
.ctrl{width:54px;height:54px;border:1px solid #d2b16a;border-radius:50%;background:#30271feF;color:#fff2d5;font-size:11px;font-weight:900;touch-action:none;user-select:none}
.ctrl:active,.ctrl.active{background:#a04a2e;transform:scale(.95)}
.small{width:47px;height:47px;font-size:10px}
.wei,.hai{display:none}
#hint{position:fixed;left:8px;bottom:160px;z-index:4;max-width:160px;padding:7px;border-radius:8px;background:#111820c9;font-size:10px;line-height:1.7;pointer-events:none}
#hurt{position:fixed;inset:0;z-index:3;pointer-events:none;opacity:0;background:radial-gradient(ellipse,transparent 25%,#c20e1daa)}
#flash{position:fixed;inset:0;z-index:6;pointer-events:none;opacity:0;background:#fff5d0}
#overlay{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;background:linear-gradient(145deg,#101720f5,#25180ff5)}
#panel{width:min(440px,100%);padding:25px 20px;border:1px solid #c6a565;border-radius:18px;background:linear-gradient(145deg,#352c21,#151c25);box-shadow:0 20px 70px #000b}
h1{margin:0 0 8px;color:#f2d18d;font-size:28px;letter-spacing:3px}
.sub{color:#d4bd8c;letter-spacing:3px;font-size:11px;margin-bottom:18px}
#note{font-size:12px;line-height:1.9;color:#d9cebb}
#start{padding:13px 25px;margin-top:14px;border:1px solid #f2d89e;border-radius:10px;background:linear-gradient(#a64b2d,#68261f);color:white;font-size:16px;font-weight:900}
#wait{font-size:12px;line-height:1.6;color:#f2d28d}
@media(min-width:800px){#hud{width:235px;font-size:13px}#buttons{right:22px;bottom:20px;grid-template-columns:repeat(3,62px);gap:8px}.ctrl{width:62px;height:62px;font-size:12px}.small{width:53px;height:53px}#hint{left:170px;bottom:18px;max-width:260px;font-size:12px}}
</style>
</head>
<body>
<div id="game"></div><div id="vignette"></div><div id="hurt"></div><div id="flash"></div><div id="cross"></div>
<div id="top">紫禁城・生死對決</div>
<div id="hud"><div id="role">尚未進入戰場</div>
<div class="meter"><span>氣血</span><span id="hpNum">100</span></div><div class="bar"><div id="hpFill" class="fill"></div></div>
<div class="meter"><span>體力／內力</span><span id="stNum">100</span></div><div class="bar"><div id="stFill" class="fill"></div></div><div id="inventory"></div></div>
<div id="messages"></div>
<div id="hint">左側搖桿移動<br>右側拖動轉頭<br>點擊攻擊與施展武功</div>
<div id="stickBase"><div id="stick"></div></div>
<div id="buttons">
<button class="ctrl" data-a="attack">攻擊</button><button class="ctrl" data-a="heavy">重擊</button><button class="ctrl" data-a="block">格擋</button>
<button class="ctrl" data-a="dodge">閃避</button><button class="ctrl" data-a="jump">輕功</button><button class="ctrl" data-a="pickup">拾取</button>
<button class="ctrl small wei" data-item="石灰粉">石灰</button><button class="ctrl small wei" data-item="暗器">暗器</button><button class="ctrl small wei" data-item="煙霧彈">煙霧</button>
<button class="ctrl small wei" data-item="寶衣">寶衣</button><button class="ctrl small wei" data-item="匕首">匕首</button>
<button class="ctrl small hai" data-a="bonePalm">化骨掌</button><button class="ctrl small hai" data-a="yinPalm">陰毒掌</button><button class="ctrl small hai" data-a="grab">擒拿</button><button class="ctrl small hai" data-a="innerGuard">護體</button>
<button class="ctrl small" data-a="break">破屏</button>
</div>
<div id="overlay"><div id="panel"><h1>紫禁城</h1><div class="sub">FIRST-PERSON WUXIA DUEL</div>
<p id="note">第一人稱武俠對決<br>韋小寶的詭計，對上海大富的陰毒武功。<br>探索宮廷、利用屏風、尋找道具，在近身交手中掌握先機。</p>
<button id="start">進入戰場</button><p id="wait">等待連線……</p></div></div>
<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
<script>
(()=>{
"use strict";
const $=id=>document.getElementById(id);
const socket=io();
let scene,camera,renderer,clock,myId=null,role=null,joined=false,state=null;
let yaw=0,pitch=0,joystick={x:0,y:0,active:false,pointer:null};
let lookPointer=null,lx=0,ly=0,keys={},blockHeld=false;
let meshes=new Map(),items=new Map(),obstacles=new Map(),particles=[];
let hands,armL,armR,weapon,weaponBlade;
let jumpY=0,jumpV=0,attackUntil=0,lastSend=0,lastEffect="",lastHurtAt=0;
const itemNames=["石灰粉","暗器","煙霧彈","寶衣","匕首"];

function material(c,r=.72,m=0){return new THREE.MeshStandardMaterial({color:c,roughness:r,metalness:m})}
function cube(parent,x,y,z,w,h,d,mat){
 const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
 o.position.set(x,y,z);o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;
}
function light(x,y,z,color,intensity,range){
 const l=new THREE.PointLight(color,intensity,range,2);l.position.set(x,y,z);scene.add(l);
}
function buildWorld(){
 scene=new THREE.Scene();scene.background=new THREE.Color(0x111923);scene.fog=new THREE.FogExp2(0x111923,.012);
 camera=new THREE.PerspectiveCamera(78,innerWidth/innerHeight,.06,100);
 renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
 $("game").appendChild(renderer.domElement);
 scene.add(new THREE.HemisphereLight(0xdce8ff,0x3b271b,2.1));
 const sun=new THREE.DirectionalLight(0xffdfb5,2.7);sun.position.set(-12,24,10);sun.castShadow=true;
 sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-23;sun.shadow.camera.right=23;sun.shadow.camera.top=23;sun.shadow.camera.bottom=-23;scene.add(sun);
 const stone=material(0x6c685f),tile1=material(0x898071),tile2=material(0x72695e);
 const red=material(0x742b24),gold=material(0xc5a05d,.35,.22),roof=material(0x29423c),wall=material(0xb19c78),wood=material(0x5e3525);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(38,38),stone);ground.rotation.x=-Math.PI/2;ground.position.y=-.08;ground.receiveShadow=true;scene.add(ground);
 for(let x=-17;x<18;x+=2)for(let z=-17;z<18;z+=2)cube(scene,x,-.025,z,1.96,.045,1.96,((x+z)/2)%2?tile1:tile2);
 cube(scene,0,1.5,-18,38,3,.7,wall);cube(scene,0,1.5,18,38,3,.7,wall);
 cube(scene,-18,1.5,0,.7,3,36,wall);cube(scene,18,1.5,0,.7,3,36,wall);
 for(const z of [-13,13]){
  cube(scene,0,1.4,z,14,2.8,4,red);cube(scene,0,2.9,z,14.5,.15,4.4,gold);
  const r=new THREE.Mesh(new THREE.ConeGeometry(8.5,2.3,4),roof);r.rotation.y=Math.PI/4;r.scale.set(1,.5,.5);r.position.set(0,4,z);r.castShadow=true;scene.add(r);
  for(let x=-6;x<=6;x+=3){cube(scene,x,1.4,z-2.05,.22,2.8,.22,red);cube(scene,x,1.4,z+2.05,.22,2.8,.22,red);}
  cube(scene,0,2.6,z-2.3,8,.12,.12,gold);
 }
 for(const x of [-14,14])for(const z of [-10,-5,0,5,10]){
  const p=new THREE.Mesh(new THREE.CylinderGeometry(.28,.36,3.3,12),red);p.position.set(x,1.65,z);p.castShadow=true;scene.add(p);
  const cap=new THREE.Mesh(new THREE.CylinderGeometry(.43,.43,.15,12),gold);cap.position.set(x,3.3,z);scene.add(cap);
 }
 const wallData=[
 {id:"screen1",x:0,z:-5.5,w:7,d:.45,h:2.2,screen:true},
 {id:"screen2",x:0,z:5.5,w:7,d:.45,h:2.2,screen:true},
 {id:"pillar1",x:-8,z:0,w:.9,d:.9,h:3},
 {id:"pillar2",x:8,z:0,w:.9,d:.9,h:3},
 {id:"wall1",x:-12,z:-10,w:7,d:.8,h:3},{id:"wall2",x:12,z:-10,w:7,d:.8,h:3},
 {id:"wall3",x:-12,z:10,w:7,d:.8,h:3},{id:"wall4",x:12,z:10,w:7,d:.8,h:3}
 ];
 wallData.forEach(o=>{
  const m=cube(scene,o.x,o.h/2,o.z,o.w,o.h,o.d,o.screen?material(0x80452e):red);obstacles.set(o.id,m);
  if(o.screen){
   cube(scene,o.x,o.h+.08,o.z,o.w+.2,.15,o.d+.13,gold);
   for(let x=-o.w/2+.4;x<o.w/2;x+=1.05)cube(scene,o.x+x,1.05,o.z,.045,1.75,.06,gold);
   cube(scene,o.x-o.w/2+.12,1.1,o.z,.09,1.9,.09,gold);cube(scene,o.x+o.w/2-.12,1.1,o.z,.09,1.9,.09,gold);
  }
 });
 for(const x of [-12,-6,0,6,12]){
  const ring=new THREE.Mesh(new THREE.TorusGeometry(.45,.05,8,20),gold);ring.position.set(x,2.2,-17.6);scene.add(ring);
 }
 function lantern(x,z){
  const g=new THREE.Group();cube(g,0,0,0,.45,.58,.45,material(0x57251b));cube(g,0,.32,0,.55,.07,.55,gold);cube(g,0,-.32,0,.55,.07,.55,gold);
  const glow=new THREE.Mesh(new THREE.BoxGeometry(.3,.36,.3),new THREE.MeshBasicMaterial({color:0xffc56d}));g.add(glow);g.position.set(x,2.8,z);scene.add(g);light(x,3,z,0xffa94d,2,9);
 }
 lantern(-5,0);lantern(5,0);lantern(-11,-7);lantern(11,7);
 for(const x of [-14,-7,0,7,14])light(x,2.2,-15,0xffc16b,.65,7);
 hands=new THREE.Group();camera.add(hands);
 armL=new THREE.Group();armR=new THREE.Group();
 const sleeve=material(0x31547d),skin=material(0xd9a77d),cuff=material(0xd3b16c,.4,.1);
 cube(armL,-.32,-.25,-.52,.23,.34,.4,sleeve);cube(armL,-.32,-.39,-.65,.19,.16,.19,skin);cube(armL,-.32,-.31,-.58,.25,.055,.32,cuff);
 cube(armR,.32,-.25,-.52,.23,.34,.4,sleeve);cube(armR,.32,-.39,-.65,.19,.16,.19,skin);cube(armR,.32,-.31,-.58,.25,.055,.32,cuff);
 hands.add(armL,armR);
 weapon=new THREE.Group();weaponBlade=cube(weapon,.39,-.34,-.84,.055,.045,.52,material(0xb9c8d7,.25,.65));weaponBlade.rotation.x=-.15;
 cube(weapon,.39,-.35,-.59,.09,.08,.19,material(0x69402a));hands.add(weapon);weapon.visible=false;
 scene.add(camera);
}
function makeEnemy(role){
 const g=new THREE.Group(),wei=role==="韋小寶",robe=material(wei?0x315e91:0x702c23),skin=material(0xd6a37e),dark=material(0x1b1a1b),gold=material(0xd3b168,.35,.1);
 const body=new THREE.Mesh(new THREE.CapsuleGeometry(.38,.68,4,8),robe);body.position.y=1.18;body.castShadow=true;g.add(body);
 const head=new THREE.Mesh(new THREE.SphereGeometry(.28,14,12),skin);head.position.y=1.94;g.add(head);
 const hat=new THREE.Mesh(new THREE.CylinderGeometry(.3,.33,.15,12),dark);hat.position.y=2.2;g.add(hat);
 const belt=new THREE.Mesh(new THREE.TorusGeometry(.39,.045,6,16),gold);belt.rotation.x=Math.PI/2;belt.position.y=.95;g.add(belt);
 for(const s of [-1,1]){
  const a=new THREE.Mesh(new THREE.CapsuleGeometry(.12,.43,3,7),robe);a.position.set(s*.43,1.35,0);a.rotation.z=s*.3;g.add(a);
  const l=new THREE.Mesh(new THREE.CapsuleGeometry(.14,.38,3,7),dark);l.position.set(s*.2,.38,0);g.add(l);
 }
 const c=document.createElement("canvas");c.width=256;c.height=64;const ctx=c.getContext("2d");
 ctx.fillStyle="#17130eee";ctx.fillRect(0,0,256,64);ctx.fillStyle=wei?"#d5e8ff":"#ffe0c1";ctx.font="bold 30px sans-serif";ctx.textAlign="center";ctx.fillText(role,128,42);
 const label=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),transparent:true}));label.position.y=2.65;label.scale.set(1.7,.43,1);g.add(label);return g;
}
function makeItem(i){
 const colors={"石灰粉":0xe8dfb5,"暗器":0xa9bacb,"煙霧彈":0x777f91,"寶衣":0x45a16c,"匕首":0xd1dce8};
 const g=new THREE.Group();const core=new THREE.Mesh(new THREE.OctahedronGeometry(.25),material(colors[i.type]||0xffffff,.35,.15));core.position.y=.48;g.add(core);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(.36,.035,6,20),new THREE.MeshBasicMaterial({color:colors[i.type]||0xffffff}));ring.rotation.x=Math.PI/2;ring.position.y=.12;g.add(ring);
 g.position.set(i.x,0,i.z);scene.add(g);return g;
}
function particleBurst(color,count=18){
 const origin=camera.position.clone();origin.y-=.1;
 for(let i=0;i<count;i++){
  const m=new THREE.Mesh(new THREE.SphereGeometry(.035+Math.random()*.05,5,5),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.9}));
  m.position.copy(origin);m.position.x+=(Math.random()-.5)*.8;m.position.y+=(Math.random()-.5)*.6;m.position.z-=.6;
  const v=new THREE.Vector3((Math.random()-.5)*3,Math.random()*2,(Math.random()-.5)*3);
  scene.add(m);particles.push({m,v,life:.45+Math.random()*.45});
 }
}
let audioCtx;
function sound(kind){
 try{
  audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();
  const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
  osc.connect(gain);gain.connect(audioCtx.destination);
  const t=audioCtx.currentTime;
  const f=kind==="hit"?105:kind==="heavy"?65:kind==="dodge"?260:kind==="pickup"?600:180;
  osc.frequency.setValueAtTime(f,t);osc.frequency.exponentialRampToValueAtTime(Math.max(30,f*.45),t+.13);
  gain.gain.setValueAtTime(.12,t);gain.gain.exponentialRampToValueAtTime(.001,t+.16);
  osc.start(t);osc.stop(t+.17);
 }catch(e){}
}
function updateHud(p){
 $("role").textContent=p.role+"　戰績 "+p.score;
 $("hpNum").textContent=Math.ceil(p.hp);$("stNum").textContent=Math.ceil(p.stamina);
 $("hpFill").style.width=p.hp+"%";$("stFill").style.width=p.stamina+"%";
 $("hurt").style.opacity=p.hp<35?String(.12+.12*Math.sin(performance.now()*.012)):"0";
 $("inventory").innerHTML=p.role==="韋小寶"?itemNames.map(n=>n+" × "+(p.inventory[n]||0)).join("<br>"):"化骨綿掌：中距離控制<br>陰毒掌法：近距離重擊<br>擒拿：近身打斷<br>內力護體：短暫減傷";
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function updateState(s){
 state=s;const visible=new Set(s.players.map(p=>p.id));
 for(const [id,m] of meshes)if(!visible.has(id)){scene.remove(m);meshes.delete(id);}
 s.players.forEach(p=>{
  if(p.id===myId){
   updateHud(p);
   if(p.effect&&p.effectUntil>performance.now()+Date.now()-performance.now()){
    if(p.effect!==lastEffect){lastEffect=p.effect;
     if(p.effect==="hit"||p.effect==="heavyHit"||p.effect==="poison"||p.effect==="grabbed"){
      $("flash").style.opacity=".4";setTimeout(()=>$("flash").style.opacity="0",75);
      sound(p.effect==="heavyHit"?"heavy":"hit");
     }
     if(p.effect==="heavy"||p.effect==="bonePalm"||p.effect==="yinPalm"||p.effect==="grab")particleBurst(p.effect==="poison"?0x6acb80:0xffd17a,16);
    }
   }else lastEffect="";
   return;
  }
  let m=meshes.get(p.id);if(!m){m=makeEnemy(p.role);scene.add(m);meshes.set(p.id,m);}
  m.position.set(p.x,0,p.z);m.rotation.y=p.yaw;
  m.traverse(o=>{if(o.material&&o.material.emissive)o.material.emissive.setHex(p.hit?0x661111:0x000000);});
 });
 const itemIds=new Set(s.items.map(i=>i.id));
 for(const [id,m] of items)if(!itemIds.has(id)){scene.remove(m);items.delete(id);}
 s.items.forEach(i=>{if(!items.has(i.id))items.set(i.id,makeItem(i));});
 items.forEach((m,id)=>{m.rotation.y+=.025;m.position.y=.05+Math.sin(performance.now()*.003+id)*.07;});
 s.destroyed.forEach(id=>{const m=obstacles.get(id);if(m)m.visible=false;});
 $("messages").innerHTML=s.messages.map(m=>"<div>"+escapeHtml(m.text)+"</div>").join("");
 $("top").textContent=s.winner?"勝者："+s.winner:!s.started?"等待另一位玩家加入":"紫禁城・生死對決";
 if(s.winner){$("overlay").style.display="flex";$("start").textContent="重新開始";$("wait").textContent="本局已結束，重新開始可加入新一局。";}
}
function action(type,item){
 if(joined)socket.emit("action",{type,item});
 if(["attack","heavy","bonePalm","yinPalm","grab"].includes(type)){
  attackUntil=performance.now()+300;
  sound(type==="heavy"||type==="yinPalm"?"heavy":"attack");
 }
}
function sendInput(){
 if(!joined||!state)return;
 let x=joystick.x,y=joystick.y;
 if(!joystick.active){x=(keys.KeyD?1:0)-(keys.KeyA?1:0);y=(keys.KeyS?1:0)-(keys.KeyW?1:0);}
 const len=Math.hypot(x,y);if(len>1){x/=len;y/=len;}
 const f=-y,r=x;
 socket.emit("input",{dx:Math.sin(yaw)*f+Math.cos(yaw)*r,dz:Math.cos(yaw)*f-Math.sin(yaw)*r,yaw,blocking:blockHeld});
}
function updateCamera(){
 if(!state||!state.me)return;
 const p=state.me;
 const bob=joystick.active?Math.sin(performance.now()*.014)*.018:0;
 camera.position.set(p.x,1.62+jumpY+bob,p.z);
 camera.rotation.order="YXZ";camera.rotation.y=yaw;camera.rotation.x=pitch;camera.rotation.z=0;
 hands.position.set(0,bob,0);
 const attacking=performance.now()<attackUntil;
 weapon.visible=attacking;
 armR.position.set(attacking?-.08:0,attacking?-.04:0,attacking?-.06:0);
 if(attacking)hands.rotation.y=Math.sin(performance.now()*.035)*.15;else hands.rotation.y=0;
 if(p.blind)$("vignette").style.background="radial-gradient(ellipse,#c6b58d22 5%,#d6d1c2e8 100%)";
 else $("vignette").style.background="radial-gradient(ellipse,transparent 45%,#0008)";
}
function animate(){
 requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.05);
 if(jumpV!==0||jumpY>0){jumpY+=jumpV*dt;jumpV-=12*dt;if(jumpY<=0){jumpY=0;jumpV=0;}}
 for(let i=particles.length-1;i>=0;i--){
  const p=particles[i];p.life-=dt;p.v.y-=2*dt;p.m.position.addScaledVector(p.v,dt);p.m.material.opacity=Math.max(0,p.life);
  if(p.life<=0){scene.remove(p.m);p.m.geometry.dispose();p.m.material.dispose();particles.splice(i,1);}
 }
 if(performance.now()-lastSend>40){sendInput();lastSend=performance.now();}
 updateCamera();renderer.render(scene,camera);
}
function setup(){
 const base=$("stickBase"),stick=$("stick");
 function move(e){const r=base.getBoundingClientRect();let x=(e.clientX-r.left-r.width/2)/43,y=(e.clientY-r.top-r.height/2)/43;const n=Math.hypot(x,y);if(n>1){x/=n;y/=n;}joystick.x=x;joystick.y=y;stick.style.left=(35+x*34)+"px";stick.style.top=(35+y*34)+"px";}
 function reset(){joystick.active=false;joystick.x=joystick.y=0;joystick.pointer=null;stick.style.left="35px";stick.style.top="35px";}
 base.addEventListener("pointerdown",e=>{e.preventDefault();joystick.active=true;joystick.pointer=e.pointerId;base.setPointerCapture(e.pointerId);move(e);});
 base.addEventListener("pointermove",e=>{if(joystick.active&&e.pointerId===joystick.pointer)move(e);});
 base.addEventListener("pointerup",reset);base.addEventListener("pointercancel",reset);
 document.querySelectorAll("[data-a]").forEach(b=>{
  const type=b.dataset.a;
  if(type==="block"){
   const down=e=>{e.preventDefault();blockHeld=true;b.classList.add("active");socket.emit("action",{type:"block",value:true});};
   const up=()=>{blockHeld=false;b.classList.remove("active");socket.emit("action",{type:"block",value:false});};
   b.addEventListener("pointerdown",down);b.addEventListener("pointerup",up);b.addEventListener("pointercancel",up);b.addEventListener("pointerleave",up);
  }else b.addEventListener("pointerdown",e=>{
   e.preventDefault();
   if(type==="jump"){jumpV=5.5;action("jump");}
   else action(type);
   if(type==="dodge")sound("dodge");
  });
 });
 document.querySelectorAll("[data-item]").forEach(b=>b.addEventListener("pointerdown",e=>{e.preventDefault();action("useItem",b.dataset.item);}));
 renderer.domElement.addEventListener("pointerdown",e=>{
  if(e.pointerType==="mouse"){if(joined&&document.pointerLockElement!==renderer.domElement)renderer.domElement.requestPointerLock?.();return;}
  if(e.clientX>innerWidth*.36){lookPointer=e.pointerId;lx=e.clientX;ly=e.clientY;}
 });
 renderer.domElement.addEventListener("pointermove",e=>{
  if(e.pointerType==="mouse"&&document.pointerLockElement===renderer.domElement){yaw-=e.movementX*.0025;pitch=clamp(pitch-e.movementY*.0022,-1.15,1.15);return;}
  if(lookPointer!==e.pointerId)return;
  yaw-=(e.clientX-lx)*.006;pitch=clamp(pitch-(e.clientY-ly)*.004,-1.15,1.15);lx=e.clientX;ly=e.clientY;
 });
 const stop=e=>{if(lookPointer===e.pointerId)lookPointer=null;};
 renderer.domElement.addEventListener("pointerup",stop);renderer.domElement.addEventListener("pointercancel",stop);
 document.addEventListener("keydown",e=>{
  keys[e.code]=true;if(e.repeat||!joined)return;
  const map={KeyJ:"attack",KeyK:"heavy",ShiftLeft:"dodge",KeyE:"pickup",KeyR:"break"};
  if(map[e.code])action(map[e.code]);
  if(e.code==="Space"){jumpV=5.5;action("jump");}
  if(e.code==="KeyL"){blockHeld=true;socket.emit("action",{type:"block",value:true});}
  if(/^Digit[1-5]$/.test(e.code))action("useItem",itemNames[Number(e.code.slice(-1))-1]);
 });
 document.addEventListener("keyup",e=>{keys[e.code]=false;if(e.code==="KeyL"){blockHeld=false;socket.emit("action",{type:"block",value:false});}});
 addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
}
$("start").addEventListener("click",()=>{
 if(joined){location.reload();return;}
 $("start").disabled=true;$("start").textContent="正在進入";$("wait").textContent="正在連線……";socket.emit("joinGame");
});
socket.on("joined",d=>{
 myId=d.id;role=d.role;joined=true;yaw=role==="韋小寶"?Math.PI/2:-Math.PI/2;
 document.querySelectorAll(".wei").forEach(b=>b.style.display=role==="韋小寶"?"":"none");
 document.querySelectorAll(".hai").forEach(b=>b.style.display=role==="海大富"?"":"none");
 $("overlay").style.display="none";
});
socket.on("state",updateState);
socket.on("connect_error",()=>{$("wait").textContent="連線失敗，請檢查網路或重新整理。";});
buildWorld();clock=new THREE.Clock();setup();animate();
})();
</script>
</body>
</html>`;

app.get("/", (req, res) => res.type("html").send(PAGE));

server.listen(PORT, "0.0.0.0", () => {
  console.log("紫禁城第一人稱武俠遊戲啟動：" + PORT);
});
